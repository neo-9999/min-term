const http = require('http');
const { handleSyncRequest } = require('./syncMiddleware');
const { startCloudflareTunnel, stopCloudflareTunnel } = require('./cloudflareTunnel.js');
const { spawn, execSync } = require('child_process');
const path = require('path');
const { WebSocketServer } = require('ws');
const fs = require('fs');

let pty = null;
try {
  pty = require('node-pty');
} catch (err) {
  console.log('node-pty unavailable in this environment, /term disabled.');
}

require('dotenv').config( { quiet: true } );
const PORT = process.env.PORT || 14484;
const PASSWORD = process.env.PASSWORD ||'mysecret.#';
const cfToken = process.env.CF_TOKEN || '' ;

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
    if (handleSyncRequest(req, res)) return;
    const pathname = new URL(req.url, 'http://localhost').pathname;
// 新增：专门给 UptimeRobot 用的防缓存监控接口
    if (pathname === '/ping') {
        res.writeHead(200, {
            'Content-Type': 'text/plain',
            'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
            'Pragma': 'no-cache',
            'Expires': '0'
        });
        // 返回带有当前时间戳的动态内容，确保每次响应都不一样
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
    if (pathname === '/100mb.bin' ) {
        const totalBytes = 100 * 1024 * 1024; // 100MB
        let sentBytes = 0;
        res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Length': totalBytes,
            'Content-Disposition': 'attachment; filename="100mb.bin"', // 浏览器访问时直接触发下载
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
                // 等待网络缓冲区排空再继续写（反压机制，防 OOM）
                res.once('drain', writeChunk);
            } else {
                res.end();
            }
        }
        // 客户端中途取消下载时立即停止
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
                    body, html { margin: 0; padding: 0; height: 100%; background: #000; overflow: hidden; }
                    #terminal { width: 100%; height: 100%; }
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

                    function sendResize() {
                        fitAddon.fit();
                        if (ws.readyState === 1 && term.cols > 0 && term.rows > 0) {
                            ws.send('\\x01' + JSON.stringify({ cols: term.cols, rows: term.rows }));
                        }
                    }                    
                    
                    ws.onopen = () => {
                        setInterval(() => {
                            if (ws.readyState === 1) { // 1 代表 WebSocket.OPEN
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
                    
                    window.addEventListener('resize', () => fitAddon.fit());
                </script>
            </body>
            </html>
        `);
    } else {
        res.writeHead(404 , { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not Found');
    }
});

// 2. 挂载 WebSocket 服务
const wss = new WebSocketServer({ server, path: '/term' });

wss.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') {
    console.error('WSS error:', err);
  }
});

wss.on('connection', (ws) => {
    let authenticated = false;
    let passBuffer = '';
    let shell = null;
    
    let termCols = 80;
    let termRows = 30;

    // 仅在无 pty（普通管道模式）下使用的状态
    let cmdBuffer = '';
    let currentCwd = __dirname;
    const cmdHistory = [];
    let historyIndex = 0;

  
    function replaceLine(newCmd) {
      if (cmdBuffer.length > 0) {
          ws.send('\b \b'.repeat(cmdBuffer.length));
      }
      cmdBuffer = newCmd;
      if (newCmd) ws.send(newCmd);
    }    
  
    const heartbeatInterval = setInterval(() => {
        if (ws.readyState === ws.OPEN) {
            ws.ping();       // 照顾标准 WebSocket 协议
            ws.send('\x00'); // 照顾霸道的 CDN 缓存
        } else {
            clearInterval(heartbeatInterval);
        }
    }, 20000);
    
    ws.send("Password:");

    // 无 pty 模式下的简易 Tab 补全
    function handleTabComplete() {
        const lastSpace = cmdBuffer.lastIndexOf(' ');
        const token = lastSpace === -1 ? cmdBuffer : cmdBuffer.slice(lastSpace + 1);
        const lastSlash = token.lastIndexOf('/');
        const dirPart = lastSlash === -1 ? '' : token.slice(0, lastSlash + 1);
        const basePart = lastSlash === -1 ? token : token.slice(lastSlash + 1);

        const searchDir = path.resolve(currentCwd, dirPart || '.');
        let entries = [];
        try {
            entries = fs.readdirSync(searchDir).filter((name) => name.startsWith(basePart));
        } catch {
            return;
        }
        if (entries.length === 0) return;

        if (entries.length === 1) {
            let match = entries[0];
            try {
                if (fs.statSync(path.join(searchDir, match)).isDirectory()) match += '/';
            } catch {}
            const append = match.slice(basePart.length);
            cmdBuffer += append;
            ws.send(append);
        } else {
            // 多个匹配：先补全最长公共前缀
            let prefix = entries[0];
            for (const item of entries.slice(1)) {
                while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1);
            }
            const append = prefix.slice(basePart.length);
            if (append) {
                cmdBuffer += append;
                ws.send(append);
            } else {
                // 没有更多公共前缀时，列出所有候选项并重绘当前输入
                ws.send('\r\n' + entries.join('  ') + '\r\n$ ' + cmdBuffer);
            }
        }
    }

  
    ws.on('message', (message) => {
        const input = message.toString();
        if (input === '\x00') return;  //ignore keep alive msg
        // 处理前端发来的窗口尺寸调整指令
        if (input.startsWith('\x01{')) {
            try {
                const { cols, rows } = JSON.parse(input.slice(1));
                if (cols > 0 && rows > 0) {
                    termCols = cols;
                    termRows = rows;
                    if (pty && shell) {
                        shell.resize(termCols, termRows);
                    }
                }
            } catch (e) {}
            return;
        }
        
        if (!authenticated) {
            if (input.includes('\r') || input.includes('\n')) {
                if (passBuffer === PASSWORD) {
                    authenticated = true;
                    ws.send("\r\nAccess Granted. Welcome to the container shell!\r\n\r\n");
                    
                    const shellBin = fs.existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
                    // 使用系统自带的 /bin/sh（Alpine 默认自带，绝对不需要安装 Python）
                    if (pty) {  //node.pty
                        shell = pty.spawn( shellBin , ['-l'], {
                            name: 'xterm-256color',
                            cols: termCols,
                            rows: termRows,
                            cwd: __dirname,
                            env: { ...process.env, TERM: 'xterm-256color' }
                        });

                    
                    // 实时将 shell 输出返回给网页
                        shell.onData((data) => {
                          ws.send(data);
                        });
                    
                        ws.on('message', (msg) => {
                            if ( shell ) {
                              let input = msg.toString();
                              if (input === '\x7f' || input === '\b') shell.write('\x7f');
                              else if ( !(input === '\x00') ) shell.write(msg);
                            }
                         });

                        shell.onData((data) => {
                            if (ws.readyState === ws.OPEN) ws.send(data);
                        });                   
                  
                        shell.on('exit', () => {
                            ws.close();
                        });
                     } else {
                        // 回退到普通 child_process.spawn
                        try {
                            shell = spawn(shellBin, ['-i'], {
                              cwd: __dirname,
                              env: process.env,
                              stdio: ['pipe', 'pipe', 'pipe'],
                              detached: true
                            });

                            const sendOut = (data) => {
                                if (ws.readyState === ws.OPEN) {
                                    ws.send(data.toString().replace(/\r?\n/g, '\r\n'));
                                }
                            };

                            shell.stdout.on('data', sendOut);
                            shell.stderr.on('data', sendOut);
                            shell.on('error', (err) => {
                                if (ws.readyState === ws.OPEN) {
                                    ws.send(`\r\n[Spawn failed: ${err.message}]\r\n`);
                                    ws.close();
                                }
                            });
                            shell.on('exit', () => ws.close());
                        } catch (err) {
                            ws.send(`\r\n[Terminal unavailable: ${err.message}]\r\n`);
                            ws.close();
                        }
                    }
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
            }else if (shell) {
            if (pty) {
                shell.write(input === '\b' ? '\x7f' : input);
            } else if (shell.stdin && !shell.stdin.destroyed) {
                // ===== 无 PTY 模式：Node.js 端行缓冲 =====
                if (input === '\r') {
                    ws.send('\r\n');
                    const trimmed = cmdBuffer.trim();

                    // 内置处理 clear 清屏
                    if (trimmed === 'clear') {
                        ws.send('\x1b[2J\x1b[H');
                        cmdBuffer = '';
                        shell.stdin.write('\n');
                        return;
                    }
                    if (trimmed && cmdHistory[cmdHistory.length - 1] !== trimmed) {
                        cmdHistory.push(trimmed);
                        if (cmdHistory.length > 50) cmdHistory.shift(); // 最多保留 50 条
                    }
                    historyIndex = cmdHistory.length;

                    // 简单追踪 cd 目录变化，确保 Tab 补全路径准确
                    if (trimmed === 'cd') {
                        currentCwd = process.env.HOME || __dirname;
                    } else if (trimmed.startsWith('cd ')) {
                        const target = trimmed.slice(3).trim().replace(/^['"]|['"]$/g, '');
                        const nextDir = path.resolve(currentCwd, target);
                        try {
                            if (fs.statSync(nextDir).isDirectory()) currentCwd = nextDir;
                        } catch {}
                    }

                    shell.stdin.write(cmdBuffer + '\n');
                    cmdBuffer = '';
                } else if (input === '\x7f' || input === '\b') {
                    // 回删：同步删缓冲并擦除屏幕
                    if (cmdBuffer.length > 0) {
                        cmdBuffer = cmdBuffer.slice(0, -1);
                        ws.send('\b \b');
                    }
                } else if (input === '\t') {
                    // Tab 自动补全
                    handleTabComplete();
                } else if (input === '\x03') {
                    // Ctrl+C 取消当前输入
                    cmdBuffer = '';
                    ws.send('^C\r\n');
                    try {
                      // 负号表示发给整个进程组（正在运行的前台子命令都会收到）
                        process.kill(-shell.pid, 'SIGINT');
                    } catch {
                    // 降级：如果平台不支持进程组，尝试直接发给 shell
                        try { shell.kill('SIGINT'); } catch {}
                    }
                 }else if (input === '\x1b[A') {
                    // 向上键：上一条历史命令
                    if (historyIndex > 0) {
                      historyIndex--;
                      replaceLine(cmdHistory[historyIndex]);
                    }
                 } else if (input === '\x1b[B') {
                    // 向下键：下一条历史命令（到底清空）
                     if (historyIndex < cmdHistory.length - 1) {
                          historyIndex++;
                          replaceLine(cmdHistory[historyIndex]);
                      } else if (historyIndex === cmdHistory.length - 1) {
                          historyIndex = cmdHistory.length;
                          replaceLine('');
                      }
                  } 
                  else if (!input.startsWith('\x1b')) {
                    // 普通字符（忽略方向键等 ANSI 转义序列，避免屏幕乱码）
                    cmdBuffer += input;
                    ws.send(input);
                  }
            }
        } 
    });

    ws.on('close', () => {
        if (heartbeatInterval ){
            clearInterval(heartbeatInterval);
        }
        if (shell) {
            shell.kill();
        }
    });
});

function shutdown() {
  stopCloudflareTunnel();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

// 2. 如果遇到 EADDRINUSE（旧进程还没释放完），等 1 秒重试
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

server.requestTimeout = 0;   // 取消整个请求的总时长限制，
server.headersTimeout = 60000; // 仅保留请求头超时（60 秒）

server.listen(PORT, () => {
    console.log(`HTTPS/WS Terminal server running on port ${PORT}`);
    startCloudflareTunnel ( cfToken );
});


setInterval(() => {
    const http = require('http');
    http.get('http://cp.cloudflare.com/generate_204', (res) => {
        res.on('data', () => {});
    }).on('error', () => {});
}, 4 * 60 * 1000);
