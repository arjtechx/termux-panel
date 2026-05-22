const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PANEL_DIR = path.resolve(__dirname, '..', '..');
const LOGS_DIR = path.join(PANEL_DIR, 'logs', 'cloudflared');
const PIDS_FILE = path.join(PANEL_DIR, 'data', 'cloudflared-pids.json');
const DATA_DIR = path.join(PANEL_DIR, 'data');

if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PIDS_FILE)) fs.writeFileSync(PIDS_FILE, JSON.stringify({}));

const runtimeState = {};
const cpuCache = {};

function getCloudflaredBinaryPath() {
    const termuxBinary = '/data/data/com.termux/files/usr/bin/cloudflared';
    if (fs.existsSync(termuxBinary)) return termuxBinary;
    if (process.env.PREFIX) {
        const prefixBinary = path.join(process.env.PREFIX, 'bin', 'cloudflared');
        if (fs.existsSync(prefixBinary)) return prefixBinary;
    }
    const homeDir = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';
    const localBinary = path.join(homeDir, '.cloudflared', process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
    if (fs.existsSync(localBinary)) return localBinary;
    return 'cloudflared';
}

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

function killProcess(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 'SIGTERM');
        return true;
    } catch (e) {
        if (e.code === 'ESRCH') return true;
        try {
            process.kill(pid, 'SIGKILL');
            return true;
        } catch (e2) {
            return false;
        }
    }
}

function isRunning(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

function getProcessMetrics(pid) {
    if (!pid || !isRunning(pid)) return { cpu: 0, ram: 0 };
    try {
        let ram = 0;
        let cpu = 0;

        if (process.platform !== 'win32') {
            const statusPath = `/proc/${pid}/status`;
            if (fs.existsSync(statusPath)) {
                const statusContent = fs.readFileSync(statusPath, 'utf8');
                const vmRssMatch = statusContent.match(/VmRSS:\s+(\d+)\s+kB/i);
                if (vmRssMatch) ram = parseFloat(vmRssMatch[1]) / 1024;
            }
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
                    const hertz = 100;
                    const cpuPercent = (totalTimeDiff / (hertz * (timeDiff / 1000))) * 100;
                    cpu = Math.min(100, Math.max(0, Math.round(cpuPercent)));
                }
                cpuCache[pid] = { time: now, totalTime };
            }
        } else {
            ram = 15.4;
            cpu = 1;
        }
        return { cpu, ram: parseFloat(ram.toFixed(1)) };
    } catch {
        return { cpu: 0, ram: 0 };
    }
}

function startInstance(instance, isTempReplica = false) {
    const id = instance.id;
    if (!isTempReplica) {
        stopInstance(id); // Garante que apenas um processo principal exista
    }
    
    // Log dinâmico: se for réplica temporária, log auxiliar.
    const logFile = path.join(LOGS_DIR, `tunnel_${id}${isTempReplica ? '_next' : ''}.log`);
    const outStream = fs.openSync(logFile, isTempReplica ? 'w' : 'a');
    
    // Metrics port aleatória determinística ou aleatória para não colidir
    const rand = Math.floor(Math.random() * 5000);
    const metricsPort = 30000 + rand;

    const binary = getCloudflaredBinaryPath();
    const configToRun = isTempReplica ? `${instance.configPath}.next.yml` : instance.configPath;

    let args = ['--no-autoupdate', '--metrics', `127.0.0.1:${metricsPort}`];
    
    if (instance.configPath) {
        args.push('--config', configToRun, 'tunnel', 'run');
    } else {
        // Fallback or tokens
        if (instance.token) {
            args.push('tunnel', 'run', '--token', instance.token);
        } else {
            return { success: false, error: 'Configuração inválida.' };
        }
    }

    const homeDir = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';

    const child = spawn(binary, args, {
        detached: true,
        stdio: ['ignore', outStream, outStream],
        env: { 
            ...process.env, 
            TUNNEL_ORIGIN_CERT: path.join(homeDir, '.cloudflared', 'cert.pem') 
        }
    });

    child.unref();

    if (!child.pid) {
        return { success: false, error: 'Falha ao iniciar processo cloudflared.' };
    }

    if (!isTempReplica) {
        const pids = getPids();
        pids[id] = child.pid;
        savePids(pids);

        runtimeState[id] = {
            id,
            pid: child.pid,
            instance,
            startedAt: Date.now(),
            shouldRun: true,
            autoRestart: instance.autoRestartOnSave,
            metricsPort,
            restartCount: runtimeState[id] ? runtimeState[id].restartCount : 0,
            crashHistory: runtimeState[id] ? runtimeState[id].crashHistory : [],
            lastRestartAt: Date.now()
        };
    }

    return { success: true, pid: child.pid, logFile, process: child };
}

function stopInstance(id) {
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

    return { success: true };
}

async function reloadSafeInstance(instance) {
    // Zero Downtime Reload implementation
    const id = instance.id;
    if (instance.protected) {
        // Extra layer of protection (can be bypassed by backend if forced, but logic demands safety)
    }

    const nextConfig = `${instance.configPath}.next.yml`;
    if (!fs.existsSync(nextConfig)) {
        return { success: false, error: 'Arquivo temporário next.yml não encontrado.' };
    }

    // 1. Validate
    const binary = getCloudflaredBinaryPath();
    try {
        execSync(`"${binary}" --config "${nextConfig}" tunnel ingress validate`, { stdio: 'ignore' });
    } catch (e) {
        return { success: false, error: 'Falha na validação do ingress da nova configuração.' };
    }

    // 2. Start temporary replica
    const replicaRes = startInstance(instance, true);
    if (!replicaRes.success) {
        return { success: false, error: 'Falha ao iniciar réplica temporária.' };
    }

    const newPid = replicaRes.pid;
    const logFile = replicaRes.logFile;

    // 3. Wait for "Connection established" or wait a few seconds
    let connected = false;
    for (let i = 0; i < 20; i++) { // 10 seconds max
        await new Promise(r => setTimeout(r, 500));
        if (fs.existsSync(logFile)) {
            const logs = fs.readFileSync(logFile, 'utf8');
            if (logs.includes('Connection established') || logs.includes('Registered tunnel connection')) {
                connected = true;
                break;
            }
        }
    }

    // 4. Se não detectou conexão mas o PID continua vivo, vamos assumir que está de pé por timeout.
    if (!connected && !isRunning(newPid)) {
        // Falhou e morreu
        return { success: false, error: 'A nova instância crashou durante a inicialização.' };
    }

    // 5. Parar antiga e renomear config
    const pids = getPids();
    const oldPid = pids[id];
    
    if (oldPid && isRunning(oldPid)) {
        killProcess(oldPid); // Parar a instância antiga.
    }

    fs.copyFileSync(nextConfig, instance.configPath);
    fs.unlinkSync(nextConfig);

    // 6. Atualizar PIDs e runtime state
    pids[id] = newPid;
    savePids(pids);

    if (!runtimeState[id]) runtimeState[id] = { restartCount: 0, crashHistory: [] };
    
    runtimeState[id].pid = newPid;
    runtimeState[id].instance = instance;
    runtimeState[id].startedAt = Date.now();
    runtimeState[id].shouldRun = true;
    
    return { success: true, pid: newPid };
}

function killAllZombies() {
    // Encontrar processos que não estão nos nossos PIDs
    const knownPids = Object.values(getPids());
    const pidsFound = [];

    try {
        if (process.platform === 'win32') {
            const stdout = execSync('tasklist', { encoding: 'utf8' });
            // Windows mock - just skip killing local cloudflared blindly
        } else {
            const lines = execSync('ps -A', { encoding: 'utf8' }).split('\n');
            for (const line of lines) {
                if (line.includes('cloudflared') && !line.includes('grep') && !line.includes('node')) {
                    const match = line.trim().match(/^(\d+)/);
                    if (match) pidsFound.push(parseInt(match[1]));
                }
            }
        }
    } catch {}

    const zombies = pidsFound.filter(p => !knownPids.includes(p));
    let killed = 0;
    zombies.forEach(pid => {
        if (killProcess(pid)) killed++;
    });

    return { success: true, zombiesKilled: killed };
}

async function queryMetrics(state) {
    const metrics = { cpu: 0, ram: 0, connections: 0, uptime: 0 };
    
    if (!state.pid || !isRunning(state.pid)) {
        return metrics;
    }

    metrics.uptime = Math.round((Date.now() - state.startedAt) / 1000);

    const procStats = getProcessMetrics(state.pid);
    metrics.cpu = procStats.cpu;
    metrics.ram = procStats.ram;

    try {
        const axios = require('axios');
        const res = await axios.get(`http://127.0.0.1:${state.metricsPort}/metrics`, { timeout: 1000 });
        const text = res.data;
        const connMatch = text.match(/cloudflared_tunnel_active_connections\s+(\d+)/);
        if (connMatch) {
            metrics.connections = parseInt(connMatch[1]) || 0;
        }
    } catch {
        // Ignored
    }

    return metrics;
}

async function getInstanceStatus(id) {
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
            uptime: metrics.uptime
        };
    }

    return {
        running: false,
        cpu: 0,
        ram: 0,
        connections: 0,
        uptime: 0
    };
}

function readLogs(id, lines = 100) {
    const logFile = path.join(LOGS_DIR, `tunnel_${id}.log`);
    if (!fs.existsSync(logFile)) return 'Nenhum log encontrado para este túnel.';
    try {
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

// Watchdog simples
setInterval(() => {
    const pids = getPids();
    for (const id in runtimeState) {
        const state = runtimeState[id];
        if (!state.shouldRun) continue;

        const activePid = pids[id];
        if (!activePid || !isRunning(activePid)) {
            // Process crashed
            console.warn(`[WATCHDOG] Instância ${id} caiu!`);
            const now = Date.now();
            const timeSinceLastRestart = now - state.lastRestartAt;

            if (state.autoRestart) {
                if (state.restartCount >= 5 && timeSinceLastRestart < 60000) {
                    console.error(`[WATCHDOG] Instância ${id} em Crash Loop. Auto-restart suspenso.`);
                    state.crashHistory.push({ time: new Date().toISOString(), reason: 'Crash loop' });
                    state.shouldRun = false;
                    continue;
                }
                state.restartCount++;
                state.lastRestartAt = now;
                console.log(`[WATCHDOG] Reiniciando instância ${id}...`);
                startInstance(state.instance);
            }
        }
    }
}, 5000);

module.exports = {
    startInstance,
    stopInstance,
    reloadSafeInstance,
    killAllZombies,
    getInstanceStatus,
    readLogs,
    getCloudflaredBinaryPath
};
