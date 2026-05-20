const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const PROC_STAT = '/proc/stat';
const PROC_CPUINFO = '/proc/cpuinfo';
const PROC_LOADAVG = '/proc/loadavg';
const SYS_CPU_DIR = '/sys/devices/system/cpu';

let cpuUseRoot = false;
let lastCpuTimes = null;
let cachedCpuName = null;
let cachedCoreIds = null;

// Silenciamento de logs repetitivos
let lastCpuErrorLog = 0;

function logCpuErrorOnce(message) {
    const now = Date.now();
    if (now - lastCpuErrorLog > 60000) {
        console.warn(message);
        lastCpuErrorLog = now;
    }
}

// Medição da CPU do próprio processo Node.js
let lastNodeCpuUsage = null;
let lastNodeCpuTime = null;

function getNodeCpuUsagePercent() {
    const now = Date.now();
    const currentUsage = process.cpuUsage();

    if (!lastNodeCpuUsage || !lastNodeCpuTime) {
        lastNodeCpuUsage = currentUsage;
        lastNodeCpuTime = now;
        return 0;
    }

    const userDiff = currentUsage.user - lastNodeCpuUsage.user;
    const sysDiff = currentUsage.system - lastNodeCpuUsage.system;
    const timeDiff = (now - lastNodeCpuTime) * 1000; // Milissegundos para microssegundos

    lastNodeCpuUsage = currentUsage;
    lastNodeCpuTime = now;

    if (timeDiff <= 0) return 0;

    const percent = ((userDiff + sysDiff) / timeDiff) * 100;
    return Number(Math.min(100, Math.max(0, percent)).toFixed(2));
}

function readText(filePath) {
    return fs.readFileSync(filePath, 'utf8');
}

function safeReadText(filePath) {
    try {
        return readText(filePath);
    } catch (_) {
        return '';
    }
}

function readTextFileSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const content = fs.readFileSync(filePath, 'utf8');
        if (!content || !content.trim()) return null;
        return content;
    } catch (error) {
        if (error.code === 'EACCES') {
            logCpuErrorOnce(`[CPU] Sem permissão (EACCES) para ler ${filePath}. Usando fallback silencioso.`);
        } else {
            logCpuErrorOnce(`[CPU] Falha lendo ${filePath}: ${error.message}`);
        }
        return null;
    }
}

function execSafe(command, timeout = 3000) {
    try {
        const output = execSync(command, {
            encoding: 'utf8',
            timeout,
            stdio: ['ignore', 'pipe', 'pipe']
        });
        if (!output || !output.trim()) return null;
        return output;
    } catch (error) {
        // Não loga erros normais de comando indisponível se estivermos silenciosos
        logCpuErrorOnce(`[CPU] Comando '${command}' indisponível ou falhou.`);
        return null;
    }
}

function parseProcStat(content) {
    if (!content) return [];
    return content
        .split('\n')
        .map(line => line.trim())
        .filter(line => /^cpu[0-9]*\s+/.test(line))
        .map(line => {
            const parts = line.split(/\s+/);
            const id = parts[0];
            const values = parts.slice(1).map(Number);
            return {
                id,
                user: values[0] || 0,
                nice: values[1] || 0,
                system: values[2] || 0,
                idle: values[3] || 0,
                iowait: values[4] || 0,
                irq: values[5] || 0,
                softirq: values[6] || 0,
                steal: values[7] || 0
            };
        });
}

function readProcStatRaw(useRoot = false) {
    if (!useRoot) {
        const fsContent = readTextFileSafe(PROC_STAT);
        if (fsContent) return { content: fsContent, method: 'fs:/proc/stat' };

        const catContent = execSafe('cat /proc/stat');
        if (catContent) return { content: catContent, method: 'cat:/proc/stat' };
        return null;
    }

    const suContent = execSafe("su -c 'cat /proc/stat'");
    if (suContent) return { content: suContent, method: 'su:/proc/stat' };
    return null;
}

function readProcStatSafe() {
    const raw = readProcStatRaw(cpuUseRoot);
    if (!raw || !raw.content) {
        return {
            success: false,
            cpus: [],
            method: cpuUseRoot ? 'su:/proc/stat' : 'fs:/proc/stat',
            error: 'PROC_STAT_UNAVAILABLE'
        };
    }

    const cpus = parseProcStat(raw.content);
    return {
        success: cpus.length > 0,
        cpus,
        method: raw.method,
        error: cpus.length > 0 ? null : 'PROC_STAT_EMPTY'
    };
}

function calculateCpuUsage(current, previous) {
    if (!current || !previous) return 0;

    const idleNow = current.idle + current.iowait;
    const idlePrev = previous.idle + previous.iowait;

    const totalNow =
        current.user +
        current.nice +
        current.system +
        current.idle +
        current.iowait +
        current.irq +
        current.softirq +
        current.steal;

    const totalPrev =
        previous.user +
        previous.nice +
        previous.system +
        previous.idle +
        previous.iowait +
        previous.irq +
        previous.softirq +
        previous.steal;

    const totalDiff = totalNow - totalPrev;
    const idleDiff = idleNow - idlePrev;

    if (!Number.isFinite(totalDiff) || totalDiff <= 0) return 0;

    const usage = ((totalDiff - idleDiff) / totalDiff) * 100;
    return Math.max(0, Math.min(100, usage));
}

function parseOnlineCpuList(value) {
    const ids = new Set();
    String(value || '').trim().split(',').forEach(part => {
        const range = part.trim();
        if (!range) return;
        const [startRaw, endRaw] = range.split('-');
        const start = Number.parseInt(startRaw, 10);
        const end = Number.parseInt(endRaw || startRaw, 10);
        if (!Number.isInteger(start) || !Number.isInteger(end)) return;
        for (let i = start; i <= end; i++) ids.add(`cpu${i}`);
    });
    return ids;
}

function getCoreIds() {
    if (cachedCoreIds) return cachedCoreIds;
    try {
        if (fs.existsSync(SYS_CPU_DIR)) {
            cachedCoreIds = fs.readdirSync(SYS_CPU_DIR)
                .filter(name => /^cpu\d+$/.test(name))
                .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
            if (cachedCoreIds.length > 0) return cachedCoreIds;
        }
    } catch (_) {}

    cachedCoreIds = Array.from({ length: os.cpus().length || 1 }, (_, index) => `cpu${index}`);
    return cachedCoreIds;
}

function isCoreOnline(coreId, onlineSet) {
    if (onlineSet) return onlineSet.has(coreId);
    try {
        const onlinePath = path.join(SYS_CPU_DIR, coreId, 'online');
        if (fs.existsSync(onlinePath)) {
            const raw = safeReadText(onlinePath).trim();
            return raw === '' || raw === '1';
        }
    } catch (_) {}
    return true;
}

function readOnlineSet() {
    try {
        const onlinePath = path.join(SYS_CPU_DIR, 'online');
        if (fs.existsSync(onlinePath)) {
            const raw = safeReadText(onlinePath);
            if (raw) return parseOnlineCpuList(raw);
        }
    } catch (_) {}
    return null;
}

function readFrequency(coreId) {
    try {
        const cpufreqDir = path.join(SYS_CPU_DIR, coreId, 'cpufreq');
        if (fs.existsSync(cpufreqDir)) {
            const candidates = [
                path.join(cpufreqDir, 'scaling_cur_freq'),
                path.join(cpufreqDir, 'cpuinfo_cur_freq')
            ];
            for (const candidate of candidates) {
                if (fs.existsSync(candidate)) {
                    const raw = safeReadText(candidate).trim();
                    const khz = Number.parseInt(raw, 10);
                    if (Number.isInteger(khz) && khz > 0) {
                        const ghz = Number((khz / 1000000).toFixed(2));
                        return { formatted: `${ghz.toFixed(2)} GHz` };
                    }
                }
            }
        }
    } catch (_) {}

    const cpus = os.cpus();
    const index = Number.parseInt(coreId.slice(3), 10);
    if (cpus[index] && cpus[index].speed) {
        const mhz = cpus[index].speed;
        const ghz = Number((mhz / 1000).toFixed(2));
        return { formatted: `${ghz.toFixed(2)} GHz` };
    }

    return { formatted: 'N/A' };
}

function readCpuName() {
    if (cachedCpuName) return cachedCpuName;
    try {
        if (fs.existsSync(PROC_CPUINFO)) {
            const raw = readText(PROC_CPUINFO);
            const lines = raw.split('\n');
            const keys = ['Hardware', 'model name', 'Processor', 'cpu model', 'chipset', 'machine'];
            for (const key of keys) {
                const line = lines.find(item => item.toLowerCase().startsWith(key.toLowerCase()));
                const value = line && line.split(':').slice(1).join(':').trim();
                if (value && !/^0x/i.test(value)) {
                    cachedCpuName = value;
                    return cachedCpuName;
                }
            }
        }
    } catch (_) {}

    const cpus = os.cpus();
    if (cpus && cpus.length > 0 && cpus[0].model) {
        cachedCpuName = cpus[0].model;
        return cachedCpuName;
    }

    cachedCpuName = os.arch() === 'arm64' || os.arch() === 'aarch64'
        ? 'AArch64 Processor'
        : 'CPU Android';
    return cachedCpuName;
}

function getLoadAverageSafe() {
    let raw = readTextFileSafe(PROC_LOADAVG);
    if (!raw && cpuUseRoot) {
        raw = execSafe("su -c 'cat /proc/loadavg'");
    }

    if (raw) {
        const parts = raw.trim().split(/\s+/);
        return {
            source: '/proc/loadavg',
            load1: Number(parts[0]) || 0,
            load5: Number(parts[1]) || 0,
            load15: Number(parts[2]) || 0,
            formatted: `${parts[0]} / ${parts[1]} / ${parts[2]}`
        };
    }

    try {
        const avg = os.loadavg();
        return {
            source: 'os.loadavg',
            load1: avg[0] || 0,
            load5: avg[1] || 0,
            load15: avg[2] || 0,
            formatted: `${avg[0].toFixed(2)} / ${avg[1].toFixed(2)} / ${avg[2].toFixed(2)}`
        };
    } catch (_) {
        return {
            source: 'indisponivel',
            load1: 0,
            load5: 0,
            load15: 0,
            formatted: 'N/A'
        };
    }
}

function readCpuUsageFromTopSafe() {
    const commands = [
        'top -b -n 1 | head -20',
        'toybox top -b -n 1 | head -20',
        'top -bn1 | head -20'
    ];

    let output = null;
    let method = 'top';

    for (const cmd of commands) {
        output = execSafe(cmd);
        if (output) {
            method = cmd.includes('toybox') ? 'toybox top' : 'top';
            break;
        }
    }

    if (!output) return null;

    // Parse Android top format 1: "CPU: 10% usr 5% sys"
    let match = output.match(/CPU:\s*([\d.]+)%\s*usr\s*([\d.]+)%\s*sys/i);
    if (match) {
        const usr = Number(match[1]) || 0;
        const sys = Number(match[2]) || 0;
        const total = Math.min(100, Math.max(0, usr + sys));
        return {
            success: true,
            method,
            cpuTotalPercent: Number(total.toFixed(1)),
            cpuTotal: `${total.toFixed(1)}%`
        };
    }

    // Parse standard toybox top format 2: "10%usr  5%sys"
    match = output.match(/([\d.]+)%usr\s*([\d.]+)%sys/i);
    if (match) {
        const usr = Number(match[1]) || 0;
        const sys = Number(match[2]) || 0;
        const total = Math.min(100, Math.max(0, usr + sys));
        return {
            success: true,
            method,
            cpuTotalPercent: Number(total.toFixed(1)),
            cpuTotal: `${total.toFixed(1)}%`
        };
    }

    // Parse standard top format 3: "5.0 us, 3.0 sy, 92.0 id"
    match = output.match(/([\d.]+)\s*us,\s*([\d.]+)\s*sy.*?([\d.]+)\s*id/i);
    if (match) {
        const idle = Number(match[3]) || 0;
        const total = Math.min(100, Math.max(0, 100 - idle));
        return {
            success: true,
            method,
            cpuTotalPercent: Number(total.toFixed(1)),
            cpuTotal: `${total.toFixed(1)}%`
        };
    }

    // CPU usage line in Linux: "%Cpu(s): 10.0 us,  2.0 sy"
    match = output.match(/%Cpu\(s\):\s*([\d.]+)\s*us,\s*([\d.]+)\s*sy/i);
    if (match) {
        const usr = Number(match[1]) || 0;
        const sys = Number(match[2]) || 0;
        const total = Math.min(100, Math.max(0, usr + sys));
        return {
            success: true,
            method,
            cpuTotalPercent: Number(total.toFixed(1)),
            cpuTotal: `${total.toFixed(1)}%`
        };
    }

    return null;
}

function readCpuUsageFromPsSafe() {
    const output = execSafe('ps -A -o pid,ppid,pcpu,pmem,comm 2>/dev/null | head -20') ||
                   execSafe('ps -ef 2>/dev/null | head -20');
    if (!output) return null;

    // Se suportou o comando de leitura, retorna indicativo do ps
    return {
        success: true,
        method: 'ps',
        cpuTotalPercent: 0,
        cpuTotal: 'Limitada (Android)'
    };
}

function setCpuRootMode(enabled) {
    cpuUseRoot = Boolean(enabled);
    lastCpuTimes = null;
    return {
        success: true,
        root: cpuUseRoot
    };
}

let cachedTermuxNativeEstimate = null;
let termuxEstimatorInterval = null;
let isProcStatBlocked = false;

function readPidStat(pid) {
    try {
        const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').trim();
        const endComm = raw.lastIndexOf(')');
        if (endComm === -1) return null;
        const after = raw.slice(endComm + 2).split(/\s+/);
        const utime = Number(after[11] || 0);
        const stime = Number(after[12] || 0);
        return { pid, ticks: utime + stime };
    } catch (_) {
        return null;
    }
}

function getClkTck() {
    try {
        return Number(execSync('getconf CLK_TCK', { encoding: 'utf8' }).trim()) || 100;
    } catch (_) {
        return 100;
    }
}

function listAccessiblePids() {
    try {
        return fs.readdirSync('/proc')
            .filter(x => /^\d+$/.test(x))
            .map(Number);
    } catch (_) {
        return [];
    }
}

function getCmdline(pid) {
    try {
        return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim();
    } catch (_) {
        return '';
    }
}

async function updateTermuxNativeCpuEstimate() {
    const clkTck = getClkTck();
    const cores = os.cpus()?.length || 1;
    const pids = listAccessiblePids();

    const first = new Map();
    for (const pid of pids) {
        const stat = readPidStat(pid);
        if (stat) first.set(pid, stat.ticks);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));

    const results = [];
    const pidsSecond = listAccessiblePids();

    for (const pid of pidsSecond) {
        const stat = readPidStat(pid);
        if (!stat || !first.has(pid)) continue;

        const deltaTicks = stat.ticks - first.get(pid);
        const cpuPercent = (deltaTicks / clkTck) / 1 * 100 / cores;

        if (cpuPercent > 0.01) {
            results.push({
                pid,
                cpuPercent: Number(cpuPercent.toFixed(2)),
                command: getCmdline(pid) || `Processo ${pid}`
            });
        }
    }

    results.sort((a, b) => b.cpuPercent - a.cpuPercent);

    const panelProcesses = results.filter(p =>
        p.command.includes('server.js') ||
        p.command.includes('termux-panel') ||
        p.command.includes('cloudflared') ||
        p.command.includes('nginx') ||
        p.command.includes('mariadbd') ||
        p.command.includes('php-fpm')
    );

    const panelCpu = panelProcesses.reduce((sum, p) => sum + p.cpuPercent, 0);

    const nodeProcesses = results.filter(p => p.command.includes('server.js'));
    const nodeCpuPercent = nodeProcesses.reduce((sum, p) => sum + p.cpuPercent, 0);

    cachedTermuxNativeEstimate = {
        available: true,
        mode: 'termux_native_estimated',
        source: '/proc/[pid]/stat',
        message: 'CPU total bloqueada pelo Android. Exibindo uso estimado dos processos acessíveis ao Termux.',
        cores,
        nodeCpuPercent: Number(nodeCpuPercent.toFixed(2)),
        panelCpuPercent: Number(panelCpu.toFixed(2)),
        topProcesses: results.slice(0, 10),
        panelProcesses
    };
}

function startTermuxNativeCpuEstimator() {
    if (termuxEstimatorInterval) return;
    updateTermuxNativeCpuEstimate().catch(() => {});
    termuxEstimatorInterval = setInterval(() => {
        updateTermuxNativeCpuEstimate().catch(() => {});
    }, 4000);
}

function getCpuRootMode() {
    return cpuUseRoot;
}

function getCpuStats() {
    const cpuName = readCpuName();
    const coreIds = getCoreIds();
    const coresCount = coreIds.length || 0;
    const loadAverage = getLoadAverageSafe();
    const onlineSet = readOnlineSet();
    const nodeCpuUsagePercent = getNodeCpuUsagePercent();

    // Roda medição principal da CPU
    const statResult = readProcStatSafe();

    if (!statResult.success && !cpuUseRoot) {
        isProcStatBlocked = true;
        startTermuxNativeCpuEstimator();

        if (cachedTermuxNativeEstimate) {
            const cores = Array.from({ length: coresCount }, (_, index) => {
                const coreId = `cpu${index}`;
                const online = isCoreOnline(coreId, onlineSet);
                return {
                    id: coreId,
                    label: coreId.toUpperCase().replace('CPU', 'CPU '),
                    usagePercent: 0,
                    usage: online ? 'N/A' : 'offline',
                    online,
                    frequency: online ? readFrequency(coreId) : { formatted: 'N/A' }
                };
            });

            return {
                success: true,
                root: false,
                mode: 'termux_native_estimated',
                method: 'termux_native_estimated',
                cpuName,
                cpuTotal: 'Indisponível',
                cpuTotalPercent: 0,
                coresCount,
                cores,
                loadAverage,
                nodeCpuUsagePercent: cachedTermuxNativeEstimate.nodeCpuPercent,
                panelCpuPercent: cachedTermuxNativeEstimate.panelCpuPercent,
                topProcesses: cachedTermuxNativeEstimate.topProcesses,
                panelProcesses: cachedTermuxNativeEstimate.panelProcesses,
                status: 'CPU total bloqueada pelo Android. Exibindo uso estimado dos processos do Termux.',
                message: 'CPU total bloqueada pelo Android. Exibindo uso estimado dos processos acessíveis ao Termux.'
            };
        } else {
            const cores = Array.from({ length: coresCount }, (_, index) => {
                const coreId = `cpu${index}`;
                const online = isCoreOnline(coreId, onlineSet);
                return {
                    id: coreId,
                    label: coreId.toUpperCase().replace('CPU', 'CPU '),
                    usagePercent: 0,
                    usage: 'Calculando...',
                    online,
                    frequency: online ? readFrequency(coreId) : { formatted: 'N/A' }
                };
            });
            return {
                success: true,
                root: false,
                mode: 'calculating',
                method: 'termux_native_estimated',
                cpuName,
                cpuTotal: 'Calculando...',
                cpuTotalPercent: 0,
                coresCount,
                cores,
                loadAverage,
                nodeCpuUsagePercent,
                status: 'Iniciando estimador de processos acessíveis ao Termux...'
            };
        }
    }

    if (statResult.success && statResult.cpus.length > 0) {
        const current = statResult.cpus;

        if (!lastCpuTimes) {
            lastCpuTimes = current;
            return {
                success: true,
                partial: true,
                root: cpuUseRoot,
                mode: 'calculating',
                method: statResult.method,
                cpuName,
                cpuTotal: 'Calculando...',
                cpuTotalPercent: 0,
                coresCount,
                cores: current
                    .filter(cpu => cpu.id !== 'cpu')
                    .map(cpu => ({
                        id: cpu.id,
                        label: cpu.id.toUpperCase().replace('CPU', 'CPU '),
                        usagePercent: 0,
                        usage: 'Calculando...',
                        online: isCoreOnline(cpu.id, onlineSet),
                        frequency: readFrequency(cpu.id)
                    })),
                loadAverage,
                nodeCpuUsagePercent,
                status: cpuUseRoot ? 'Coletando primeira leitura com root' : 'Coletando primeira leitura'
            };
        }

        const previousMap = Object.fromEntries(lastCpuTimes.map(cpu => [cpu.id, cpu]));
        const totalCpu = current.find(cpu => cpu.id === 'cpu');
        const previousTotalCpu = previousMap.cpu;
        const cpuTotalPercent = calculateCpuUsage(totalCpu, previousTotalCpu);

        const cores = current
            .filter(cpu => cpu.id !== 'cpu')
            .map(cpu => {
                const previous = previousMap[cpu.id];
                const online = isCoreOnline(cpu.id, onlineSet);
                const usagePercent = online ? calculateCpuUsage(cpu, previous) : 0;
                return {
                    id: cpu.id,
                    label: cpu.id.toUpperCase().replace('CPU', 'CPU '),
                    usagePercent: Number(usagePercent.toFixed(1)),
                    usage: online ? `${usagePercent.toFixed(1)}%` : 'offline',
                    online,
                    frequency: online ? readFrequency(cpu.id) : { formatted: 'N/A' }
                };
            });

        lastCpuTimes = current;
        return {
            success: true,
            root: cpuUseRoot,
            mode: cpuUseRoot ? 'root' : 'normal',
            method: statResult.method,
            cpuName,
            cpuTotalPercent: Number(cpuTotalPercent.toFixed(1)),
            cpuTotal: `${cpuTotalPercent.toFixed(1)}%`,
            coresCount,
            cores,
            loadAverage,
            nodeCpuUsagePercent,
            status: cpuUseRoot ? 'Monitorando CPU com root' : 'Monitorando CPU'
        };
    }

    // FALLBACK LAYER 1: top
    const topUsage = readCpuUsageFromTopSafe();
    if (topUsage) {
        lastCpuTimes = null;

        // Popula cores com frequências e status mesmo no modo fallback
        const cores = coreIds.map(coreId => {
            const online = isCoreOnline(coreId, onlineSet);
            return {
                id: coreId,
                label: coreId.toUpperCase().replace('CPU', 'CPU '),
                usagePercent: 0,
                usage: online ? 'N/A' : 'offline',
                online,
                frequency: online ? readFrequency(coreId) : { formatted: 'N/A' }
            };
        });

        return {
            success: true,
            partial: true,
            root: cpuUseRoot,
            mode: 'top_fallback',
            method: topUsage.method,
            cpuName,
            cpuTotal: topUsage.cpuTotal === 'Android' ? 'Limitada (Android)' : topUsage.cpuTotal,
            cpuTotalPercent: topUsage.cpuTotalPercent,
            coresCount,
            cores,
            loadAverage,
            nodeCpuUsagePercent,
            status: 'CPU estimada via top (leitura proc/stat bloqueada pelo Android)',
            error: statResult.error || 'PROC_STAT_UNAVAILABLE'
        };
    }

    // FALLBACK LAYER 2: ps
    const psUsage = readCpuUsageFromPsSafe();
    if (psUsage) {
        lastCpuTimes = null;

        const cores = coreIds.map(coreId => {
            const online = isCoreOnline(coreId, onlineSet);
            return {
                id: coreId,
                label: coreId.toUpperCase().replace('CPU', 'CPU '),
                usagePercent: 0,
                usage: online ? 'N/A' : 'offline',
                online,
                frequency: online ? readFrequency(coreId) : { formatted: 'N/A' }
            };
        });

        return {
            success: true,
            partial: true,
            root: cpuUseRoot,
            mode: 'ps_fallback',
            method: psUsage.method,
            cpuName,
            cpuTotal: 'Limitada (Android)',
            cpuTotalPercent: 0,
            coresCount,
            cores,
            loadAverage,
            nodeCpuUsagePercent,
            status: 'Processos estimados via ps (leitura proc/stat bloqueada pelo Android)',
            error: statResult.error || 'PROC_STAT_UNAVAILABLE'
        };
    }

    // FALLBACK LAYER 3: process.cpuUsage() + frequências locais
    lastCpuTimes = null;
    const cores = coreIds.map(coreId => {
        const online = isCoreOnline(coreId, onlineSet);
        return {
            id: coreId,
            label: coreId.toUpperCase().replace('CPU', 'CPU '),
            usagePercent: 0,
            usage: online ? 'N/A' : 'offline',
            online,
            frequency: online ? readFrequency(coreId) : { formatted: 'N/A' }
        };
    });

    return {
        success: true,
        partial: true,
        root: cpuUseRoot,
        mode: 'limited',
        method: 'process.cpuUsage',
        cpuName,
        cpuTotal: 'Limitada (Android)',
        cpuTotalPercent: 0,
        coresCount,
        cores,
        loadAverage: { source: 'indisponivel', load1: 0, load5: 0, load15: 0, formatted: 'N/A' },
        nodeCpuUsagePercent,
        status: 'CPU total indisponível: leitura bloqueada pelo Android.',
        error: statResult.error || 'PROC_STAT_UNAVAILABLE'
    };
}

module.exports = {
    getCpuStats,
    getCpuStatus: getCpuStats,
    setCpuRootMode,
    getCpuRootMode
};
