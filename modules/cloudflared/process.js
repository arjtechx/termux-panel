const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PANEL_DIR = path.resolve(__dirname, '..', '..');
const LOGS_DIR = path.join(PANEL_DIR, 'logs', 'cloudflared');
const PIDS_FILE = path.join(LOGS_DIR, 'pids.json');

// Ensure directories exist
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(PIDS_FILE)) fs.writeFileSync(PIDS_FILE, JSON.stringify({}));

function getPids() {
    try {
        return JSON.parse(fs.readFileSync(PIDS_FILE, 'utf8'));
    } catch {
        return {};
    }
}

function savePids(pids) {
    fs.writeFileSync(PIDS_FILE, JSON.stringify(pids, null, 2));
}

/**
 * Kill process gracefully or forcefully.
 */
function killProcess(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 'SIGINT');
        return true;
    } catch (e) {
        if (e.code === 'ESRCH') return true; // Already dead
        try {
            process.kill(pid, 'SIGKILL');
            return true;
        } catch (e2) {
            return false;
        }
    }
}

/**
 * Checks if a PID is actively running
 */
function isRunning(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

/**
 * Kill any lingering process for a specific tunnel ID
 */
function stopTunnelProcess(id) {
    const pids = getPids();
    if (pids[id] && isRunning(pids[id])) {
        killProcess(pids[id]);
    }
    delete pids[id];
    savePids(pids);
    
    // Safety check: force kill via shell if zombie in Termux
    try {
        execSync(`pkill -f "cloudflared tunnel run ${id}"`);
    } catch {}
    
    return { success: true };
}

/**
 * Kills all cloudflared processes on the device (Panic Button)
 */
function killAllZombies() {
    try {
        execSync('pkill -9 cloudflared');
        fs.writeFileSync(PIDS_FILE, JSON.stringify({}));
        return { success: true };
    } catch {
        return { success: false };
    }
}

/**
 * Spawns a tunnel (either by token or by local config/UUID)
 */
function startTunnelProcess(id, options = {}) {
    stopTunnelProcess(id); // Ensure no old process is running
    
    const { token, quickUrl } = options;
    const logFile = path.join(LOGS_DIR, `tunnel_${id}.log`);\
    
    const outStream = fs.openSync(logFile, 'a');
    
    let args = [];
    if (token) {
        // Zero Trust Mode: cloudflared tunnel run --token TOKEN
        args = ['tunnel', '--no-autoupdate', 'run', '--token', token];
    } else if (quickUrl) {
        // Classic Quick Tunnel: cloudflared tunnel --url http://localhost:PORT
        // NOTE: No "run" subcommand here — different syntax
        args = ['tunnel', '--no-autoupdate', '--url', quickUrl];
    } else {
        return { success: false, error: 'Opções de início insuficientes.' };
    }

    const child = spawn('cloudflared', args, {
        detached: true,
        stdio: ['ignore', outStream, outStream],
        env: { 
            ...process.env, 
            TUNNEL_ORIGIN_CERT: path.join(
                process.env.HOME || '/data/data/com.termux/files/home', 
                '.cloudflared', 'cert.pem'
            ) 
        }
    });

    child.unref(); // Allow Node to exit independently of this process

    if (child.pid) {
        const pids = getPids();
        pids[id] = child.pid;
        savePids(pids);
        return { success: true, pid: child.pid, logFile };
    } else {
        return { success: false, error: 'Failed to spawn process' };
    }
}

/**
 * Get active tunnel status
 */
function getTunnelStatus(id) {
    const pids = getPids();
    const pid = pids[id];
    if (pid && isRunning(pid)) {
        return { running: true, pid };
    }
    return { running: false };
}

/**
 * Read tunnel logs
 */
function readLogs(id, lines = 100) {
    const logFile = path.join(LOGS_DIR, `tunnel_${id}.log`);
    if (!fs.existsSync(logFile)) return 'Nenhum log encontrado para este túnel.';
    try {
        const content = execSync(`tail -n ${lines} "${logFile}"`).toString();
        return content || 'Logs vazios.';
    } catch {
        return 'Falha ao ler os logs.';
    }
}

module.exports = {
    startTunnelProcess,
    stopTunnelProcess,
    killAllZombies,
    getTunnelStatus,
    readLogs
};
