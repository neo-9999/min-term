const http = require('http');
const { handleSyncRequest } = require('./syncMiddleware');
const { spawn, execSync } = require('child_process');
const path = require('path');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const pty = require('node-pty');

require('dotenv').config();
const PORT = process.env.PORT || 14484;
const PASSWORD = process.env.PASSWORD ||'mysecret.#';
const cfToken = process.env.CF_TOKEN || '' ;


// 1. 创建 HTTP 服务，托管基于 xterm.js 的网页终端界面
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
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
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

//                    term.onKey(({ key, domEvent }) => {
//                        let ev = domEvent;
//                        let printable = !ev.altKey && !ev.ctrlKey && !ev.metaKey;
//                        if (ev.keyCode === 13) {
//                            ws.send('\\r');
//                        } else if (ev.keyCode === 8) {
//                            ws.send('\\b');
//                        } else if (printable) {
//                            ws.send(key);
//                        }
//                    });
                    term.onData((data) => {
                          ws.send(data);
                    });                    
//                    document.getElementById('terminal').addEventListener('contextmenu', async (e) => {
//                          e.preventDefault(); // 阻止浏览器默认的右键菜单
//                          try {
//                                const text = await navigator.clipboard.readText();
//                                ws.send(text);
//                          } catch (err) {
//                                // 忽略剪贴板读取被拒绝的情况
//                          }
//                    });
                    
                    window.addEventListener('resize', () => fitAddon.fit());
                </script>
            </body>
            </html>
        `);
    } else {
        res.writeHead(404);
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
    let cmdBuffer = '';
    let shell = null;
    
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
        if (input === '\x00') return;  //ignore keep alive msg
        
        if (!authenticated) {
            if (input.includes('\r') || input.includes('\n')) {
                if (passBuffer === PASSWORD) {
                    authenticated = true;
                    ws.send("\r\nAccess Granted. Welcome to the container shell!\r\n\r\n");
                    
                  
                    // 使用系统自带的 /bin/sh（Alpine 默认自带，绝对不需要安装 Python）
                  
                    shell = pty.spawn('/bin/sh', ['-l'], {
                        name: 'xterm-color',
                        cols: 80,
                        rows: 30,
                        cwd: __dirname ,
                        env: process.env
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
});


setInterval(() => {
    const http = require('http');
    http.get('http://cp.cloudflare.com/generate_204', (res) => {
        res.on('data', () => {});
    }).on('error', () => {});
}, 4 * 60 * 1000);
