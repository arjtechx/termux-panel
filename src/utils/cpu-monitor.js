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
        console.error(`[CPU] Falha lendo ${filePath}:`, error.message);
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
        console.error(`[CPU] Falha comando ${command}:`, error.message);
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

    return { formatted: 'freq. indisponivel' };
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
        : 'CPU Android nao identificado';
    return cachedCpuName;
}

function getLoadAverageSafe() {
    const raw = readTextFileSafe(PROC_LOADAVG);
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
        return null;
    }
}

function readCpuUsageFromTopSafe() {
    const output = execSafe('top -bn1 | head -20');
    if (!output) return null;

    let match = output.match(/CPU:\s*([\d.]+)%\s*usr\s*([\d.]+)%\s*sys/i);
    if (match) {
        const usr = Number(match[1]) || 0;
        const sys = Number(match[2]) || 0;
        const total = Math.min(100, Math.max(0, usr + sys));
        return {
            success: true,
            method: 'top',
            cpuTotalPercent: Number(total.toFixed(1)),
            cpuTotal: `${total.toFixed(1)}%`
        };
    }

    match = output.match(/([\d.]+)\s*us,\s*([\d.]+)\s*sy.*?([\d.]+)\s*id/i);
    if (match) {
        const idle = Number(match[3]) || 0;
        const total = Math.min(100, Math.max(0, 100 - idle));
        return {
            success: true,
            method: 'top',
            cpuTotalPercent: Number(total.toFixed(1)),
            cpuTotal: `${total.toFixed(1)}%`
        };
    }

    return null;
}

function setCpuRootMode(enabled) {
    cpuUseRoot = Boolean(enabled);
    lastCpuTimes = null;
    return {
        success: true,
        root: cpuUseRoot
    };
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

    const statResult = readProcStatSafe();
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
                    frequency: online ? readFrequency(cpu.id) : { formatted: 'freq. indisponivel' }
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
            status: cpuUseRoot ? 'Monitorando CPU com root' : 'Monitorando CPU'
        };
    }

    const topUsage = readCpuUsageFromTopSafe();
    if (topUsage) {
        lastCpuTimes = null;
        return {
            success: true,
            partial: true,
            root: cpuUseRoot,
            mode: 'top_fallback',
            method: topUsage.method,
            cpuName,
            cpuTotal: topUsage.cpuTotal,
            cpuTotalPercent: topUsage.cpuTotalPercent,
            coresCount,
            cores: [],
            loadAverage,
            status: 'Monitorando CPU via top',
            error: statResult.error || 'PROC_STAT_UNAVAILABLE'
        };
    }

    lastCpuTimes = null;
    return {
        success: true,
        partial: true,
        root: cpuUseRoot,
        mode: 'loadavg_fallback',
        cpuName,
        cpuTotal: '--%',
        cpuTotalPercent: 0,
        coresCount,
        cores: [],
        loadAverage,
        status: cpuUseRoot
            ? 'Root ativo, mas /proc/stat indisponivel. Usando carga media.'
            : 'Modo parcial - usando carga media',
        error: statResult.error || 'PROC_STAT_UNAVAILABLE'
    };
}

module.exports = {
    getCpuStats,
    getCpuStatus: getCpuStats,
    setCpuRootMode,
    getCpuRootMode
};
