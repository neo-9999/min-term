'use strict';

const net = require('net');

const TOKEN_HEX = (process.env.APP_TOKEN || 'd342d11e-d424-4583-b36e-524ab1f0afa4').replace(/-/g, '').toLowerCase();
const SYNC_PATH = (process.env.SYNC_PATH || '/api/v1/sync').replace(/\/+$/, '');
const TOKEN_BUF = Buffer.from(TOKEN_HEX, 'hex');

const IDLE_MS = 30000;
const MAX_QUEUE = 256;
const channels = new Map();

function decodeFrame(buf) {
  if (buf.length < 22) return null;

  const ver = buf[0];
  if (TOKEN_BUF.length !== 16 || !buf.subarray(1, 17).equals(TOKEN_BUF)) {
    return { err: 1 };
  }

  const extLen = buf[17];
  let pos = 18 + extLen;
  if (buf.length < pos + 4) return null;

  const op = buf[pos++];
  if (op !== 1) return { err: 2 };

  const port = buf.readUInt16BE(pos);
  pos += 2;

  const kind = buf[pos++];
  let host = '';

  if (kind === 1) {
    if (buf.length < pos + 4) return null;
    host = `${buf[pos]}.${buf[pos + 1]}.${buf[pos + 2]}.${buf[pos + 3]}`;
    pos += 4;
  } else if (kind === 2) {
    if (buf.length < pos + 1) return null;
    const len = buf[pos++];
    if (buf.length < pos + len) return null;
    host = buf.subarray(pos, pos + len).toString('utf8');
    pos += len;
  } else if (kind === 3) {
    if (buf.length < pos + 16) return null;
    const segs = [];
    for (let i = 0; i < 16; i += 2) {
      segs.push(buf.readUInt16BE(pos + i).toString(16));
    }
    host = segs.join(':');
    pos += 16;
  } else {
    return { err: 3 };
  }

  return { ver, host, port, body: buf.subarray(pos) };
}

class SyncChannel {
  constructor(id) {
    this.id = id;
    this.res = null;
    this.upstream = null;
    this.headBuf = Buffer.alloc(0);
    this.ready = false;
    this.ver = 0;
    this.ackSent = false;
    this.pending = [];
    this.nextSeq = 0;
    this.queue = new Map();
    this.closed = false;
    this.touch();
  }

  touch() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      if (!this.res || !this.upstream) this.close();
    }, IDLE_MS);
  }

  bindRes(res) {
    if (this.closed || this.res) {
      res.writeHead(400);
      res.end();
      return;
    }
    this.res = res;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.on('close', () => this.close());
    res.on('error', () => this.close());

    if (this.ready) this.flush();
  }

  pushSeq(seq, data) {
    if (this.closed) return;
    this.touch();
    if (seq < this.nextSeq) return;
    if (this.queue.size >= MAX_QUEUE) {
      this.close();
      return;
    }

    this.queue.set(seq, data);
    while (this.queue.has(this.nextSeq)) {
      const chunk = this.queue.get(this.nextSeq);
      this.queue.delete(this.nextSeq);
      this.nextSeq++;
      this.writeIn(chunk);
    }
  }

  writeIn(chunk) {
    if (this.closed || !chunk.length) return;

    if (!this.ready) {
      this.headBuf = this.headBuf.length ? Buffer.concat([this.headBuf, chunk]) : chunk;
      const meta = decodeFrame(this.headBuf);
      if (!meta) return;
      if (meta.err) {
        this.close();
        return;
      }

      this.ready = true;
      this.ver = meta.ver;
      this.headBuf = Buffer.alloc(0);
      this.openUpstream(meta.host, meta.port, meta.body);
    } else if (this.upstream && !this.upstream.destroyed) {
      this.upstream.write(chunk);
    }
  }

  openUpstream(host, port, initData) {
    const sock = net.connect({ host, port });
    this.upstream = sock;
    sock.setNoDelay(true);

    if (initData.length > 0) sock.write(initData);

    sock.on('connect', () => {
      if (this.timer) {
        clearTimeout(this.timer);
        this.timer = null;
      }
      if (this.res) this.flush();
    });

    sock.on('data', (chunk) => {
      if (this.closed) return;
      if (this.res && !this.res.writableEnded) {
        this.sendAck();
        if (!this.res.write(chunk)) {
          sock.pause();
          this.res.once('drain', () => {
            if (!sock.destroyed) sock.resume();
          });
        }
      } else {
        this.pending.push(chunk);
      }
    });

    sock.on('end', () => this.close());
    sock.on('error', () => this.close());
    sock.on('close', () => this.close());
  }

  sendAck() {
    if (!this.ackSent && this.res && !this.res.writableEnded) {
      this.ackSent = true;
      this.res.write(Buffer.from([this.ver, 0x00]));
    }
  }

  flush() {
    if (!this.res || this.res.writableEnded) return;
    this.sendAck();
    while (this.pending.length > 0) {
      this.res.write(this.pending.shift());
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.id) channels.delete(this.id);

    this.queue.clear();
    this.pending.length = 0;

    if (this.upstream && !this.upstream.destroyed) this.upstream.destroy();
    if (this.res && !this.res.writableEnded) this.res.end();
  }
}

function getChannel(id) {
  let ch = channels.get(id);
  if (!ch) {
    ch = new SyncChannel(id);
    channels.set(id, ch);
  }
  return ch;
}

/**
 * HTTP 请求拦截器
 * 返回 true 表示已处理，返回 false 表示交还给主程序继续处理
 */
function handleSyncRequest(req, res) {
  const urlObj = new URL(req.url, 'http://localhost');
  const pathname = urlObj.pathname;

  if (pathname !== SYNC_PATH && !pathname.startsWith(SYNC_PATH + '/')) {
    return false;
  }

  const sub = pathname.slice(SYNC_PATH.length).replace(/^\/+|\/+$/g, '');
  const parts = sub ? sub.split('/') : [];

  if (parts.length === 0 && req.method === 'POST') {
    const ch = new SyncChannel(null);
    ch.bindRes(res);
    req.on('data', (c) => ch.writeIn(c));
    req.on('end', () => {
      if (ch.upstream && !ch.upstream.destroyed) ch.upstream.end();
    });
    req.on('error', () => ch.close());
    return true;
  }

  if (parts.length === 1 && req.method === 'GET') {
    getChannel(parts[0]).bindRes(res);
    return true;
  }

  if (parts.length === 1 && req.method === 'POST') {
    const ch = getChannel(parts[0]);
    req.on('data', (c) => ch.writeIn(c));
    req.on('end', () => {
      if (ch.upstream && !ch.upstream.destroyed) ch.upstream.end();
      res.writeHead(200);
      res.end();
    });
    req.on('error', () => {
      ch.close();
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end();
      }
    });
    return true;
  }

  if (parts.length === 2 && req.method === 'POST') {
    const seq = Number(parts[1]);
    if (!Number.isInteger(seq) || seq < 0) {
      res.writeHead(400);
      res.end();
      return true;
    }

    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      getChannel(parts[0]).pushSeq(seq, Buffer.concat(chunks));
      res.writeHead(200, { 'Cache-Control': 'no-store' });
      res.end();
    });
    req.on('error', () => {
      if (!res.writableEnded) {
        res.writeHead(500);
        res.end();
      }
    });
    return true;
  }

  res.writeHead(405);
  res.end();
  return true;
}

module.exports = { handleSyncRequest };
