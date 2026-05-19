const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const net = require('net');

const HEALTH_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'health-check.sh');

// Cache de existência de binários (evita rodar subprocessos para comandos estáticos)
const binaryCache = new Map();
function checkCmdCached(cmd) {
    if (binaryCache.has(cmd)) return binaryCache.get(cmd);
    return new Promise(resolve => {
        exec(`which ${cmd} 2>/dev/null`, (err, stdout) => {
            const exists = !err && stdout.trim().length > 0;
            binaryCache.set(cmd, exists);
            resolve(exists);
        });
    });
}

// Busca PID nativa via /proc (evita fork do pgrep)
function findPidByName(name) {
    if (process.platform === 'win32') return false; // Fallback para dev local no Windows
    try {
        const files = fs.readdirSync('/proc');
        for (const file of files) {
            if (/^\d+$/.test(file)) {
                try {
                    const comm = fs.readFileSync(`/proc/${file}/comm`, 'utf8').trim();
                    if (comm.toLowerCase().includes(name.toLowerCase())) {
                        return true;
                    }
                } catch (_) {}
            }
        }
    } catch (_) {}
    return false;
}

// Cache de status para evitar cliques sucessivos
let lastStatusData = null;
let lastStatusTime = 0;

// SSE: Executa health-check e envia as linhas em tempo real
router.get('/run', (req, res) => {
    try { fs.chmodSync(HEALTH_SCRIPT, '755'); } catch(e) {}

    // Configura SSE (Server-Sent Events)
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify({ line: data })}\n\n`);

    const proc = spawn('bash', [HEALTH_SCRIPT], {
        env: { ...process.env, TERM: 'xterm' },
    });

    proc.stdout.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => {
            if (line.trim()) send(line);
        });
    });

    proc.stderr.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => {
            if (line.trim()) send('[STDERR] ' + line);
        });
    });

    proc.on('close', code => {
        send(`__DONE__:${code}`);
        res.end();
    });

    req.on('close', () => proc.kill());
});

router.get('/status', async (req, res) => {
    // TTL de 2 segundos para o cache de status
    if (lastStatusData && (Date.now() - lastStatusTime < 2000)) {
        return res.json(lastStatusData);
    }

    const checkPort = (host, port) => new Promise(resolve => {
        const sock = new net.Socket();
        sock.setTimeout(1000); // Reduzido para 1s para ser ainda mais rápido
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.on('error',   () => { sock.destroy(); resolve(false); });
        sock.connect(port, host);
    });

    const checkProcessNative = (name) => {
        // Fallback local se estivermos desenvolvendo em Windows
        if (process.platform === 'win32') {
            return new Promise(resolve => {
                exec(`tasklist`, (err, stdout) => {
                    resolve(!err && stdout.toLowerCase().includes(name.toLowerCase()));
                });
            });
        }
        return Promise.resolve(findPidByName(name));
    };

    const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';

    const [
        nginxRunning, mariadbRunning, phpfpmRunning,
        port8080, port3306,
        hasNginx, hasPHP, hasMariadb, hasPMA,
    ] = await Promise.all([
        checkProcessNative('nginx'),
        checkProcessNative('mariadbd').then(r => r || checkProcessNative('mysqld')),
        checkProcessNative('php-fpm'),
        checkPort('127.0.0.1', 8080),
        checkPort('127.0.0.1', 3306),
        checkCmdCached('nginx'),
        checkCmdCached('php'),
        checkCmdCached('mariadb'),
        (async () => {
            const p1 = prefix + '/share/phpmyadmin';
            const p2 = '/usr/share/phpmyadmin';
            return fs.existsSync(p1) || fs.existsSync(p2);
        })(),
    ]);

    const statusResult = {
        services: {
            nginx:    { installed: hasNginx,    running: nginxRunning,   port8080 },
            mariadb:  { installed: hasMariadb,  running: mariadbRunning, port3306 },
            phpfpm:   { installed: hasPHP,      running: phpfpmRunning },
            phpmyadmin: { installed: hasPMA,    port8080 },
            filebrowser: { installed: true, running: true, port: 8088, webOk: true }
        }
    };

    lastStatusData = statusResult;
    lastStatusTime = Date.now();

    res.json(statusResult);
});

module.exports = router;
