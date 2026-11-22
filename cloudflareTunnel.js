const fs = require('fs');
const cloudflaredFile = path.join(WORK_DIR, 'cloudflared');
const downloadUrl = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64'

function initCloudflared() {
   if (fs.existsSync(cloudflaredFile)) {
     return true;
   }
   try {
        const res = await fetch(downloadUrl);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(cloudflaredFile));
        if (fs.existsSync(cloudflaredFile)) {
          fs.chmodSync(cloudflaredFile, 0o755);
          return true;
        }
        else return false;
   } catch (err) {
        console.error('[Init] Failed to setup binaries:', err.message);
        return false;
   }   
}

function startDaemon(name, command, args, extraEnv = {}) {
    if (!fs.existsSync(command)) {
        console.error(`[Daemon] Binary not found for ${name}: ${command}`);
        return;
    }
    console.log(`[Daemon] Starting ${name}...`);
    let proc;
    try {
        proc = spawn(command, args, {
            cwd: WORK_DIR,
            // 确保 Caddy/Xray 等进程的数据和缓存目录都落在可写的 WORK_DIR
            env: {
                ...process.env,
                HOME: WORK_DIR,
                XDG_DATA_HOME: path.join(WORK_DIR, '.local', 'share'),
                XDG_CONFIG_HOME: path.join(WORK_DIR, '.config'),
                ...extraEnv
            },
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } catch (err) {
        console.error(`[Daemon] Failed to start ${name}: ${err.message}`);
        return;
    }

    proc.on('error', (err) => {
        console.error(`[Daemon] Process error for ${name}: ${err.message}`);
    });

    if (proc.stderr) {
        proc.stderr.on('data', (data) => {
            console.error(`[${name} Error] ${data.toString().trim()}`);
        });
    }

    proc.on('close', (code) => {
        console.log(`[Daemon] ${name} exited with code ${code}.`);
    });
}

function startCloudflareTunnel( cfToken )
{
  if (cfToken) 
      if ( initCloudflared() ){
        startDaemon(
            'Cloudflared',
            cloudflareFiled,
            [
                'tunnel', '--no-autoupdate', '--edge-ip-version', '4',
                '--loglevel', 'error', '--protocol', 'http2', 'run'
            ],
            { TUNNEL_TOKEN: cfToken }
        );
      }
    } else {
        console.log('[Daemon] CF_TOKEN is empty, skipping Cloudflared.');
  }
}

module.exports = { startCloudflareTunnel };
