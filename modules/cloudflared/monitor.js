const fs = require('fs');
const { listTunnels } = require('./manager');
const { getStatus, restartTunnel, updateMeta } = require('./process');
const { logPath, appendLog } = require('./utils');

let watchdogTimer = null;

function hasRecentFailure(id) {
    const file = logPath(id);
    if (!fs.existsSync(file)) return false;
    const tail = fs.readFileSync(file, 'utf8').slice(-12000).toLowerCase();
    return tail.includes('502') ||
        tail.includes('connection refused') ||
        tail.includes('failed to connect') ||
        tail.includes('unable to reach') ||
        tail.includes('disconnected');
}

function runWatchdogOnce() {
    const tunnels = listTunnels();
    for (const tunnel of tunnels) {
        const status = getStatus(tunnel.id);
        const lastWatchdogRestart = tunnel.lastWatchdogRestart
            ? new Date(tunnel.lastWatchdogRestart).getTime()
            : 0;
        const canRestart = Date.now() - lastWatchdogRestart > 120000;

        if (!status.online && tunnel.status === 'online') {
            updateMeta(tunnel.id, {
                status: 'offline',
                pid: null,
                lastError: 'Processo não está mais ativo.'
            });

            if (tunnel.autoRestart !== false && canRestart) {
                appendLog(logPath(tunnel.id), 'Watchdog detectou túnel morto. Reiniciando...');
                try {
                    updateMeta(tunnel.id, { lastWatchdogRestart: new Date().toISOString() });
                    restartTunnel(tunnel.id);
                } catch (err) {
                    appendLog(logPath(tunnel.id), `Watchdog não conseguiu reiniciar: ${err.message}`);
                    updateMeta(tunnel.id, { status: 'error', lastError: err.message });
                }
            }
        }

        if (status.online && tunnel.autoRestart !== false && canRestart && hasRecentFailure(tunnel.id)) {
            appendLog(logPath(tunnel.id), 'Watchdog detectou falha recente no log. Reiniciando túnel...');
            try {
                updateMeta(tunnel.id, { lastWatchdogRestart: new Date().toISOString() });
                restartTunnel(tunnel.id);
            } catch (err) {
                appendLog(logPath(tunnel.id), `Restart por falha de log falhou: ${err.message}`);
                updateMeta(tunnel.id, { status: 'error', lastError: err.message });
            }
        }
    }
}

function startWatchdog(intervalMs = 15000) {
    if (watchdogTimer) return watchdogTimer;
    watchdogTimer = setInterval(runWatchdogOnce, intervalMs);
    watchdogTimer.unref();
    return watchdogTimer;
}

function stopWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = null;
}

module.exports = {
    runWatchdogOnce,
    startWatchdog,
    stopWatchdog
};
