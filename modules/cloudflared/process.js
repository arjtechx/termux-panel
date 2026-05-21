const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const PANEL_DIR = path.resolve(__dirname, '..', '..');
const LOGS_DIR = path.join(PANEL_DIR, 'logs', 'cloudflared');
const PIDS_FILE = path.join(LOGS_DIR, 'pids.json');
const METRICS_FILE = path.join(LOGS_DIR, 'metrics_history.json');

// Ensure directories exist
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(PIDS_FILE)) fs.writeFileSync(PIDS_FILE, JSON.stringify({}));
if (!fs.existsSync(METRICS_FILE)) fs.writeFileSync(METRICS_FILE, JSON.stringify({}));

// In-memory runtime tracking
const runtimeState = {};
const cpuCache = {};

// Start Watchdog Daemon (runs every 5 seconds)
let watchdogInterval = setInterval(runWatchdog, 5000);

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
 * Native Linux/Termux /proc parser for CPU and RAM.
 * Falling back to 0 on Windows or on error.
 */
function getProcessMetrics(pid) {
    if (!pid || !isRunning(pid)) return { cpu: 0, ram: 0 };
    try {
        let ram = 0;
        let cpu = 0;

        if (process.platform !== 'win32') {
            // Read memory (RSS) from /proc/<pid>/status
            const statusPath = `/proc/${pid}/status`;
            if (fs.existsSync(statusPath)) {
                const statusContent = fs.readFileSync(statusPath, 'utf8');
                const vmRssMatch = statusContent.match(/VmRSS:\s+(\d+)\s+kB/i);
                if (vmRssMatch) {
                    ram = parseFloat(vmRssMatch[1]) / 1024; // MB
                }
            }

            // Read CPU time from /proc/<pid>/stat
            const statPath = `/proc/${pid}/stat`;
            if (fs.existsSync(statPath)) {
                const statContent = fs.readFileSync(statPath, 'utf8');
                const parts = statContent.split(' ');
                const utime = parseInt(parts[13]) || 0;
                const stime = parseInt(parts[14]) || 0;
                const totalTime = utime + stime;

                const now = Date.now();
                const prev = cpuCache[pid] || { time: now - 1000, totalTime: 0 };
                const timeDiff = now - prev.time;
                const totalTimeDiff = totalTime - prev.totalTime;

                if (timeDiff > 0 && prev.totalTime > 0) {
                    const hertz = 100; // standard in Linux/Android
                    const cpuPercent = (totalTimeDiff / (hertz * (timeDiff / 1000))) * 100;
                    cpu = Math.min(100, Math.max(0, Math.round(cpuPercent)));
                }
                cpuCache[pid] = { time: now, totalTime };
            }
        } else {
            // Windows mock / basic stats
            ram = 15.4; // Average cloudflared memory footprint
            cpu = 1;
        }

        return { cpu, ram: parseFloat(ram.toFixed(1)) };
    } catch {
        return { cpu: 0, ram: 0 };
    }
}

/**
 * Spawns a tunnel and registers in watchdog
 */
function startTunnelProcess(id, options = {}) {
    stopTunnelProcess(id); // Clean any existing process
    
    const { token, quickUrl, configPath, tunnelName, autoRestart = true } = options;
    const logFile = path.join(LOGS_DIR, `tunnel_${id}.log`);
    const outStream = fs.openSync(logFile, 'a');
    
    const lastFour = parseInt(id.slice(-4), 10);
    const metricsPort = 30000 + (isNaN(lastFour) ? 500 : lastFour % 10000);

    let args = ['tunnel', '--no-autoupdate', '--metrics', `127.0.0.1:${metricsPort}`];
    if (token) {
        args.push('run', '--token', token);
    } else if (quickUrl) {
        args.push('--url', quickUrl);
    } else if (configPath) {
        // Advanced Custom YAML Tunnel
        args.push('--config', configPath, 'run');
    } else {
        return { success: false, error: 'Configurações de início incompletas.' };
    }

    const child = spawn('cloudflared', args, {
        detached: true,
        stdio: ['ignore', outStream, outStream],
        env: { 
            ...process.env, 
            TUNNEL_ORIGIN_CERT: path.join(
                process.env.HOME || require('os').homedir() || '/data/data/com.termux/files/home', 
                '.cloudflared', 'cert.pem'
            ) 
        }
    });

    child.unref();

    if (child.pid) {
        const pids = getPids();
        pids[id] = child.pid;
        savePids(pids);

        // Update runtime tracking
        runtimeState[id] = {
            id,
            pid: child.pid,
            options,
            startedAt: Date.now(),
            shouldRun: true,
            autoRestart,
            metricsPort,
            restartCount: runtimeState[id] ? runtimeState[id].restartCount : 0,
            crashHistory: runtimeState[id] ? runtimeState[id].crashHistory : [],
            lastRestartAt: Date.now()
        };

        return { success: true, pid: child.pid, logFile };
    } else {
        return { success: false, error: 'Falha ao iniciar processo cloudflared.' };
    }
}

/**
 * Stops and unregisters from watchdog
 */
function stopTunnelProcess(id) {
    const pids = getPids();
    const pid = pids[id] || (runtimeState[id] ? runtimeState[id].pid : null);
    
    if (pid) {
        killProcess(pid);
    }
    
    delete pids[id];
    savePids(pids);

    if (runtimeState[id]) {
        runtimeState[id].shouldRun = false;
        runtimeState[id].pid = null;
    }

    // Force shell kill as double-safety in Termux (pkill exit code 1 = no match = OK)
    try {
        const lastFour = parseInt(id.slice(-4), 10);
        const mPort = 30000 + (isNaN(lastFour) ? 500 : lastFour % 10000);
        execSync(`pkill -f "cloudflared.*127.0.0.1:${mPort}" || true`);
    } catch {}

    return { success: true };
}

/**
 * Watchdog daemon logic
 */
function runWatchdog() {
    const pids = getPids();
    
    for (const id in runtimeState) {
        const state = runtimeState[id];
        if (!state.shouldRun) continue;

        const activePid = pids[id];
        if (!activePid || !isRunning(activePid)) {
            // Process crashed!
            console.warn(`[WATCHDOG] Túnel ${id} caiu! Detectando reestabelecimento...`);
            
            // Check back-off safety
            const now = Date.now();
            const timeSinceLastRestart = now - state.lastRestartAt;

            if (state.autoRestart) {
                if (state.restartCount >= 5 && timeSinceLastRestart < 60000) {
                    console.error(`[WATCHDOG] Túnel ${id} entrou em Crash Loop (5 falhas seguidas em <1min). Suspendendo restarts temporariamente.`);
                    state.crashHistory.push({
                        timestamp: new Date().toISOString(),
                        reason: 'Crash Loop Detectado. Auto-restart suspenso.'
                    });
                    state.shouldRun = false; // Disable watchdog for safety
                    continue;
                }

                // Increment restarts
                state.restartCount++;
                state.lastRestartAt = now;
                state.crashHistory.push({
                    timestamp: new Date().toISOString(),
                    reason: `Queda inesperada (Reinício #${state.restartCount})`
                });

                console.log(`[WATCHDOG] Reiniciando túnel ${id}...`);
                startTunnelProcess(id, state.options);
            }
        }
    }
}

/**
 * Query stats (CPU, RAM, Connections, Latency)
 */
async function queryMetrics(state) {
    const metrics = { cpu: 0, ram: 0, connections: 0, uptime: 0 };
    
    if (!state.pid || !isRunning(state.pid)) {
        return metrics;
    }

    metrics.uptime = Math.round((Date.now() - state.startedAt) / 1000); // seconds

    // Get Native CPU/RAM
    const procStats = getProcessMetrics(state.pid);
    metrics.cpu = procStats.cpu;
    metrics.ram = procStats.ram;

    // Get Active Connections from Cloudflared Metrics server
    try {
        const axios = require('axios');
        const res = await axios.get(`http://127.0.0.1:${state.metricsPort}/metrics`, { timeout: 1000 });
        const text = res.data;
        const connMatch = text.match(/cloudflared_tunnel_active_connections\s+(\d+)/);
        if (connMatch) {
            metrics.connections = parseInt(connMatch[1]) || 0;
        }
    } catch {
        // Fallback or offline metrics
    }

    return metrics;
}

/**
 * Gets status with full diagnostics
 */
async function getTunnelStatus(id) {
    const pids = getPids();
    const pid = pids[id];
    const isLooming = pid && isRunning(pid);

    if (isLooming) {
        const state = runtimeState[id] || { startedAt: Date.now(), metricsPort: 30000, pid };
        const metrics = await queryMetrics(state);
        return {
            running: true,
            pid,
            cpu: metrics.cpu,
            ram: metrics.ram,
            connections: metrics.connections,
            uptime: metrics.uptime,
            crashCount: state.restartCount || 0,
            crashHistory: state.crashHistory || []
        };
    }

    const state = runtimeState[id];
    return {
        running: false,
        cpu: 0,
        ram: 0,
        connections: 0,
        uptime: 0,
        crashCount: state ? state.restartCount : 0,
        crashHistory: state ? state.crashHistory : []
    };
}

/**
 * Kill all cloudflared instances
 */
function killAllZombies() {
    try {
        // Use exact executable name matches to avoid killing node/panel
        execSync('pkill -x cloudflared || true');
        execSync('killall cloudflared || true');
    } catch { /* Ignore: pkill not found on some systems (Windows) */ }
    
    // Clear internal state regardless of kill outcome
    try {
        fs.writeFileSync(PIDS_FILE, JSON.stringify({}));
    } catch {}
    
    for (const id in runtimeState) {
        runtimeState[id].shouldRun = false;
        runtimeState[id].pid = null;
    }
    
    return { success: true };
}

/**
 * Read tunnel logs
 */
function readLogs(id, lines = 100) {
    const logFile = path.join(LOGS_DIR, `tunnel_${id}.log`);
    if (!fs.existsSync(logFile)) return 'Nenhum log encontrado para este túnel.';
    try {
        // Multiplatform reading
        if (process.platform !== 'win32') {
            return execSync(`tail -n ${lines} "${logFile}"`).toString();
        } else {
            const content = fs.readFileSync(logFile, 'utf8').split('\n');
            return content.slice(-lines).join('\n');
        }
    } catch {
        return 'Falha ao ler os logs.';
    }
}

module.exports = {
    startTunnelProcess,
    stopTunnelProcess,
    killAllZombies,
    getTunnelStatus,
    readLogs,
    runtimeState
};
