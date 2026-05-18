const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const net = require('net');

const HEALTH_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'health-check.sh');

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
    const checkPort = (host, port) => new Promise(resolve => {
        const sock = new net.Socket();
        sock.setTimeout(1000);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.on('error',   () => { sock.destroy(); resolve(false); });
        sock.connect(port, host);
    });

    const checkProcess = (name) => new Promise(resolve => {
        exec(`pgrep -f "${name}" || pidof "${name}"`, (err, stdout) => resolve(!err && stdout.trim().length > 0));
    });

    const checkCmd = (cmd) => new Promise(resolve => {
        exec(`which ${cmd} 2>/dev/null`, (err, stdout) => resolve(!err && stdout.trim().length > 0));
    });

    const prefix = process.env.PREFIX || '/data/data/com.termux/files/usr';

    // Para o Nginx, verifica portas comuns para evitar falsos negativos no Termux
    const checkNginxPorts = async () => {
        const ports = [80, 8080, 8082, 8085, 8888];
        for (const p of ports) {
            if (await checkPort('127.0.0.1', p)) return true;
        }
        return false;
    };

    const [
        nginxRunning, mariadbRunning, phpfpmRunning,
        port80, port8080, port3306,
        hasNginx, hasPHP, hasMariadb, hasPMA,
    ] = await Promise.all([
        checkProcess('nginx'),
        checkProcess('mariadbd').then(r => r || checkProcess('mysqld') || checkProcess('mariadb') || checkProcess('mysql')),
        checkProcess('php-fpm'),
        checkNginxPorts(),
        checkPort('127.0.0.1', 8080),
        checkPort('127.0.0.1', 3306),
        checkCmd('nginx'),
        checkCmd('php'),
        checkCmd('mariadb'),
        (async () => {
            const p1 = prefix + '/share/phpmyadmin';
            const p2 = '/usr/share/phpmyadmin';
            return fs.existsSync(p1) || fs.existsSync(p2);
        })(),
    ]);

    res.json({
        services: {
            nginx:    { installed: hasNginx,    running: nginxRunning,   port80 },
            mariadb:  { installed: hasMariadb,  running: mariadbRunning, port3306 },
            phpfpm:   { installed: hasPHP,      running: phpfpmRunning },
            phpmyadmin: { installed: hasPMA,    port8080 },
            filebrowser: { installed: true, running: true, port: 8088, webOk: true } // Mock para o novo gerenciador nativo
        }
    });
});

module.exports = router;
