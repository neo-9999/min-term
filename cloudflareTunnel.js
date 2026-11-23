'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const WORK_DIR = process.env.HOME || os.homedir() || '/tmp';
const cloudflaredFile = path.join(WORK_DIR, 'cloudflared');

// Node.js process.arch 到 cloudflared 官方发布文件名的映射
const ARCH_MAP = {
    x64: 'amd64',
    arm64: 'arm64',
    arm: 'arm',
    ia32: '386'
};

let tunnelProc = null;
let isShuttingDown = false;

function getDownloadUrl() {
    const cfArch = ARCH_MAP[process.arch];
    if (!cfArch) {
        throw new Error(`Unsupported CPU architecture: ${process.arch}`);
    }
    return `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cfArch}`;
}

async function initCloudflared() {
    if (fs.existsSync(cloudflaredFile)) {
        return true;
    }
    try {
        if (!fs.existsSync(WORK_DIR)) {
            fs.mkdirSync(WORK_DIR, { recursive: true });
        }
        const downloadUrl = getDownloadUrl();
        //console.log(`[Init] Detected arch: ${process.arch}, downloading cloudflared...`);
        const res = await fetch(downloadUrl);
        if (!res.ok) {
            throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(cloudflaredFile));
        fs.chmodSync(cloudflaredFile, 0o755);
        //console.log('[Init] cloudflared ready.');
        return true;
    } catch (err) {
        console.error('[Init] Failed to setup binaries:', err.message);
        if (fs.existsSync(cloudflaredFile)) {
            try { fs.unlinkSync(cloudflaredFile); } catch (_) {}
        }
        return false;
    }
}

function startDaemon(name, command, args, extraEnv = {}) {
    if (!fs.existsSync(command)) {
        console.error(`[Daemon] Binary not found for ${name}: ${command}`);
        return;
    }
    //console.log(`[Daemon] Starting ${name}...`);
    try {
        tunnelProc = spawn(command, args, {
            cwd: WORK_DIR,
            env: {
                ...process.env,
                HOME: WORK_DIR,
                XDG_DATA_HOME: path.join(WORK_DIR, '.local', 'share'),
                XDG_CONFIG_HOME: path.join(WORK_DIR, '.config'),
                ...extraEnv
            },
            stdio: ['ignore', 'ignore', 'pipe']
        });
    } catch (err) {
        console.error(`[Daemon] Failed to start ${name}: ${err.message}`);
        return;
    }

    tunnelProc.on('error', (err) => {
        console.error(`[Daemon] Process error for ${name}: ${err.message}`);
    });

    if (tunnelProc.stderr) {
        tunnelProc.stderr.on('data', (data) => {
            const msg = data.toString().trim();
            if (msg) console.error(`[${name} Error] ${msg}`);
        });
    }

    tunnelProc.on('close', (code) => {
        //console.log(`[Daemon] ${name} exited with code ${code}.`);
        tunnelProc = null;
        if (!isShuttingDown) {
            setTimeout(() => startDaemon(name, command, args, extraEnv), 5000);
        }
    });
}

async function startCloudflareTunnel(cfToken) {
    if (!cfToken) {
        console.log('[Daemon] CF_TOKEN is empty.');
        return;
    }
    const ok = await initCloudflared();
    if (ok && !isShuttingDown) {
        startDaemon(
            'Cloudflared',
            cloudflaredFile,
            [
                'tunnel', '--no-autoupdate', '--edge-ip-version', '4',
                '--loglevel', 'fatal', '--protocol', 'http2', 'run'
            ],
            { 
                TUNNEL_TOKEN: cfToken,
                QUIC_GO_DISABLE_RECEIVE_BUFFER_WARNING: 'true'
            }
        );
    }
}

function stopCloudflareTunnel() {
    isShuttingDown = true;
    if (tunnelProc && !tunnelProc.killed) {
        tunnelProc.kill('SIGTERM');
    }
}

module.exports = { startCloudflareTunnel, stopCloudflareTunnel };
