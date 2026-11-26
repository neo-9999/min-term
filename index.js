const http = require('http');
const { handleSyncRequest, handleWsUpgrade } = require('./syncMiddleware');
const { spawn, execSync } = require('child_process');
const path = require('path');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const pty = require('node-pty');

require('dotenv').config();
const PORT = process.env.PORT || 14484;
const PASSWORD = process.env.PASSWORD || 'mysecret.#';
const cfToken = process.env.CF_TOKEN || '';

const ZERO_CHUNK = Buffer.alloc(64 * 1024); // Buffer.alloc 默认全填充为 0
// 1. 创建 HTTP 服务，托管基于 xterm.js 的网页终端界面
const htmlTemplate = fs.readFileSync(path.join(__dirname, 'www/index.html'), 'utf8');

function renderHtml() {
  const now = new Date();
  // 格式化为 "YYYY-MM-DD HH:mm:ss UTC"
  const formattedTime = now.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  return htmlTemplate
    .replace('{{now.Format "2006-01-02 15:04:05 UTC"}}', formattedTime)
    .replace('{{now.UnixMilli}}', String(now.getTime()));
}

const server = http.createServer((req, res) => {
    // 保留 XHTTP 拦截（不要注释）
    if (handleSyncRequest(req, res)) return;
    const pathname = new URL(req.url, 'http://localhost').pathname;
    
    // 专门给 UptimeRobot 用的防缓存监控接口
    if (pathname === '/ping') {
        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        res.end('active:' + Date.now());
        return;
    }

    if (pathname === '/' || pathname === '/index.html') {
        const filePath = path.join(__dirname, 'www', 'index.html');
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
                res.end('Default page not found');
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': 'no-store, no-cache, must-revalidate'
            });
            res.end(renderHtml());
        });
        return;
    }

    if (pathname === '/100mb.bin') {
        const totalBytes = 100 * 1024 * 1024; // 100MB
        let sentBytes = 0;
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': totalBytes,
            'Content-Disposition': 'attachment; filename="100mb.bin"',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Pragma': 'no-cache'
        });

        if (req.method === 'HEAD') {
            res.end();
            return;
        }

        function writeChunk() {
            let ok = true;
            while (sentBytes < totalBytes && ok) {
                const remaining = totalBytes - sentBytes;
                const chunk = remaining >= ZERO_CHUNK.length
                    ? ZERO_CHUNK
                    : ZERO_CHUNK.subarray(0, remaining);
                sentBytes += chunk.length;
                ok = res.write(chunk);
            }
            if (sentBytes < totalBytes) {
                res.once('drain', writeChunk);
            } else {
                res.end();
            }
        }

        res.on('close', () => {
            sentBytes = totalBytes;
        });

        writeChunk();
        return;
    }

    if (pathname.startsWith('/api/v1/login')) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            status: 'error',
            message: 'Security alert: Error username or password, or access denied from unauthorized IP location.'
        }));
        return;
    }

    if (pathname === '/term' || pathname === '/term/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>Container Terminal</title>
                <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css" />
                <script src="https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js"></script>
                <script src="https://cdn.jsdelivr.net/npm/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>
                <style>
                    body, html { margin: 0; padding: 0; width: 100%; height: 100%; background: #000; overflow: hidden; }
                    #terminal { width: 100vw; height: 100vh; }
                </style>
            </head>
            <body>
                <div id="terminal"></div>
                <script>
                    const term = new Terminal({ cursorBlink: true, fontSize: 14 });
                    const fitAddon = new FitAddon.FitAddon();
                    term.loadAddon(fitAddon);
                    term.open(document.getElementById('terminal'));
                    fitAddon.fit();

                    // 自动适配 HTTPS 对应的 wss:// 协议
                    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
                    const ws = new WebSocket(\`\${protocol}//\${location.host}/term\`);

                    // 同步窗口尺寸到后端
                    function sendResize() {
                        fitAddon.fit();
                        if (ws.readyState === 1 && term.cols > 0 && term.rows > 0) {
                            ws.send('\\x01' + JSON.stringify({ cols: term.cols, rows: term.rows }));
                        }
                    }

                    ws.onopen = () => {
                        sendResize(); // 连接建立后立刻同步一次初始大小
                        setInterval(() => {
                            if (ws.readyState === 1) {
                                ws.send('\\x00');
                            }
                        }, 20000);
                    };

                    ws.onmessage = (event) => {
                        term.write(event.data);
                    };

                    term.onData((data) => {
                        if (ws.readyState === 1) {
                            ws.send(data);
                        }
                    });

                    // 窗口缩放时防抖同步
                    let resizeTimer;
                    window.addEventListener('resize', () => {
                        clearTimeout(resizeTimer);
                        resizeTimer = setTimeout(sendResize, 100);
                    });
                </script>
            </body>
            </html>
        `);
    } else {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    }
});

// 2. 改为 noServer 模式，避免和 VLESS+WS 抢占 upgrade 事件
const wss = new WebSocketServer({ noServer: true });

wss.on('error', (err) => {
    if (err.code !== 'EADDRINUSE') {
        console.error('WSS error:', err);
    }
});

// 统一分发所有 WebSocket 升级请求
server.on('upgrade', (req, socket, head) => {
    // 优先交给 VLESS + WS（/api/v1/ws）
    if (handleWsUpgrade(req, socket, head)) return;

    // 其次交给网页终端（/term）
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/term' || pathname === '/term/') {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit('connection', ws, req);
        });
        return;
    }

    // 其他未匹配路径直接断开
    socket.destroy();
});

wss.on('connection', (ws) => {
    let authenticated = false;
    let passBuffer = '';
    let shell = null;
    let termCols = 80;
    let termRows = 30;

    const heartbeatInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            ws.ping();       // 照顾标准 WebSocket 协议
            ws.send('\x00'); // 照顾霸道的 CDN 缓存
        } else {
            clearInterval(heartbeatInterval);
        }
    }, 20000);

    ws.send("Password:");

    ws.on('message', (message) => {
        const input = message.toString();
        if (input === '\x00') return; // 忽略心跳包

        // 处理前端发来的窗口尺寸调整指令
        if (input.startsWith('\x01{')) {
            try {
                const { cols, rows } = JSON.parse(input.slice(1));
                if (cols > 0 && rows > 0) {
                    termCols = cols;
                    termRows = rows;
                    if (shell) {
                        shell.resize(termCols, termRows);
                    }
                }
            } catch (e) {
                // 忽略格式异常
            }
            return;
        }

        if (!authenticated) {
            if (input.includes('\r') || input.includes('\n')) {
                if (passBuffer === PASSWORD) {
                    authenticated = true;
                    ws.send("\r\nAccess Granted. Welcome to the container shell!\r\n\r\n");

                    // 优先使用 /bin/bash，不存在时自动回退 /bin/sh
                    const shellBin = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';

                    shell = pty.spawn(shellBin, ['-l'], {
                        name: 'xterm-256color',
                        cols: termCols,
                        rows: termRows,
                        cwd: __dirname,
                        env: {
                            ...process.env,
                            TERM: 'xterm-256color'
                        }
                    });

                    // 实时将 shell 输出返回给网页
                    shell.onData((data) => {
                        if (ws.readyState === ws.OPEN) {
                            ws.send(data);
                        }
                    });

                    shell.on('exit', () => {
                        ws.close();
                    });
                } else {
                    ws.send("\r\nAccess denied.\r\nPassword:");
                    passBuffer = '';
                }
            } else if (input === '\b' || input === '\x7f') {
                if (passBuffer.length > 0) {
                    passBuffer = passBuffer.slice(0, -1);
                    ws.send('\b \b');
                }
            } else {
                passBuffer += input;
                ws.send('*');
            }
        } else if (shell) {
            if (input === '\x7f' || input === '\b') {
                shell.write('\x7f');
            } else {
                shell.write(input);
            }
        }
    });

    ws.on('close', () => {
        if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
        }
        if (shell) {
            shell.kill();
        }
    });
});

function shutdown() {
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.log(`Port ${PORT} in use, retrying in 1s...`);
        setTimeout(() => {
            server.close();
            server.listen(PORT, '0.0.0.0');
        }, 1000);
    } else {
        throw err;
    }
});

server.requestTimeout = 0;     // 取消整个请求的总时长限制
server.headersTimeout = 60000; // 仅保留请求头超时（60 秒）

server.listen(PORT, () => {
    console.log(`HTTPS/WS Terminal server running on port ${PORT}`);
});
