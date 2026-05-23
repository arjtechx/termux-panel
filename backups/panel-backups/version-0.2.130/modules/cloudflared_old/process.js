const fs = require('fs');
const { spawn } = require('child_process');
const {
    configPath,
    logPath,
    metaPath,
    pidPath,
    readJson,
    writeJson,
    appendLog
} = require('./utils');

function readPid(id) {
    try {
        const file = pidPath(id);
        if (!fs.existsSync(file)) return null;
        const pid = Number.parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
        return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch (_) {
        return null;
    }
}

function removePid(id) {
    try {
        const file = pidPath(id);
        if (fs.existsSync(file)) fs.unlinkSync(file);
    } catch (_) {}
}

function isPidAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (_) {
        return false;
    }
}

function updateMeta(id, patch) {
    const meta = readJson(metaPath(id), {});
    const next = { ...meta, ...patch, updatedAt: new Date().toISOString() };
    writeJson(metaPath(id), next);
    return next;
}

function getStatus(id) {
    const meta = readJson(metaPath(id), null);
    if (!meta) return { status: 'missing', pid: null, online: false };

    const pid = readPid(id);
    const online = isPidAlive(pid);
    if (!online && pid) {
        removePid(id);
    }

    let uptimeSeconds = 0;
    if (online && meta.startedAt) {
        uptimeSeconds = Math.max(0, Math.floor((Date.now() - new Date(meta.startedAt).getTime()) / 1000));
    }

    return {
        status: online ? 'online' : 'offline',
        online,
        pid: online ? pid : null,
        uptimeSeconds,
        startedAt: online ? meta.startedAt : null,
        lastError: meta.lastError || ''
    };
}

function startTunnel(id) {
    const meta = readJson(metaPath(id), null);
    if (!meta) throw new Error('Túnel não encontrado.');

    const current = getStatus(id);
    if (current.online) {
        return { success: true, alreadyRunning: true, ...current };
    }

    const cfg = configPath(id);
    if (!fs.existsSync(cfg)) {
        throw new Error('config.yml não encontrado para este túnel.');
    }

    const logFile = logPath(id);
    fs.closeSync(fs.openSync(logFile, 'a'));
    appendLog(logFile, 'Iniciando cloudflared...');

    const out = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn('cloudflared', ['tunnel', '--config', cfg, 'run', meta.uuid], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
    });

    child.stdout.pipe(out);
    child.stderr.pipe(out);
    child.on('error', (err) => {
        appendLog(logFile, `Falha ao iniciar: ${err.message}`);
        updateMeta(id, { status: 'error', lastError: err.message });
    });
    child.unref();

    fs.writeFileSync(pidPath(id), String(child.pid));
    updateMeta(id, {
        status: 'online',
        pid: child.pid,
        startedAt: new Date().toISOString(),
        lastError: ''
    });

    return { success: true, status: 'online', pid: child.pid };
}

function stopTunnel(id) {
    const pid = readPid(id);
    const logFile = logPath(id);

    if (pid && isPidAlive(pid)) {
        appendLog(logFile, `Parando PID ${pid}...`);
        try {
            process.kill(pid, 'SIGTERM');
        } catch (_) {}

        const deadline = Date.now() + 2500;
        while (Date.now() < deadline && isPidAlive(pid)) {}

        if (isPidAlive(pid)) {
            try {
                process.kill(pid, 'SIGKILL');
                appendLog(logFile, `PID ${pid} finalizado com SIGKILL.`);
            } catch (_) {}
        }
    }

    removePid(id);
    updateMeta(id, { status: 'offline', pid: null, stoppedAt: new Date().toISOString() });
    return { success: true, status: 'offline' };
}

function restartTunnel(id) {
    stopTunnel(id);
    return startTunnel(id);
}

module.exports = {
    readPid,
    removePid,
    isPidAlive,
    getStatus,
    startTunnel,
    stopTunnel,
    restartTunnel,
    updateMeta
};
