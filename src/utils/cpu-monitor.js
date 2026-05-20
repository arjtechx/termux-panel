const fs = require('fs');
const path = require('path');
const os = require('os');

const PROC_STAT = '/proc/stat';
const PROC_CPUINFO = '/proc/cpuinfo';
const SYS_CPU_DIR = '/sys/devices/system/cpu';

let lastCpuTimes = null;
let cachedCpuName = null;
let cachedCoreIds = null;

function fallbackCpuStatus(error, extra = {}) {
    return {
        success: false,
        cpuName: readCpuName(),
        cpuTotal: '--%',
        cpuTotalPercent: 0,
        coresCount: getCoreIds().length || 0,
        cores: [],
        status: 'Erro ao ler CPU',
        error: 'CPU_READ_ERROR',
        details: error ? error.message : undefined,
        ...extra
    };
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

function readProcStatSafe() {
    try {
        if (!fs.existsSync(PROC_STAT)) {
            return [];
        }

        const content = readText(PROC_STAT);

        return content
            .split('\n')
            .filter(line => /^cpu[0-9]*\s/.test(line))
            .map(line => {
                const parts = line.trim().split(/\s+/);
                const id = parts[0];
                const values = parts.slice(1).map(value => Number(value));

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
    } catch (error) {
        console.error('[CPU] Erro ao ler /proc/stat:', error.message);
        return [];
    }
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
        const p = path.join(SYS_CPU_DIR, 'online');
        if (fs.existsSync(p)) {
            const raw = safeReadText(p);
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
                        const mhz = Math.round(khz / 1000);
                        const ghz = Number((khz / 1000000).toFixed(2));
                        return { khz, mhz, ghz, formatted: `${ghz.toFixed(2)} GHz` };
                    }
                }
            }
        }
    } catch (_) {}

    // Fallback para Node OS
    const cpus = os.cpus();
    const index = Number.parseInt(coreId.slice(3), 10);
    if (cpus[index] && cpus[index].speed) {
        const mhz = cpus[index].speed;
        const ghz = Number((mhz / 1000).toFixed(2));
        return { khz: mhz * 1000, mhz, ghz, formatted: `${ghz.toFixed(2)} GHz` };
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

    // Fallback Node OS
    const cpus = os.cpus();
    if (cpus && cpus.length > 0 && cpus[0].model) {
        cachedCpuName = cpus[0].model;
        return cachedCpuName;
    }

    const arch = os.arch();
    if (arch === 'arm64' || arch === 'aarch64') {
        cachedCpuName = 'AArch64 Processor';
    } else {
        cachedCpuName = 'CPU Android nao identificado';
    }
    return cachedCpuName;
}

function getCpuStatus() {
    const current = readProcStatSafe();
    const cpuName = readCpuName();
    const coreIds = getCoreIds();

    if (!current || current.length === 0) {
        return {
            success: false,
            cpuName,
            cpuTotal: '--%',
            cpuTotalPercent: 0,
            coresCount: coreIds.length || 0,
            cores: [],
            status: 'Nao foi possivel ler /proc/stat',
            error: 'PROC_STAT_EMPTY'
        };
    }

    const onlineSet = readOnlineSet();

    if (!lastCpuTimes) {
        lastCpuTimes = current;

        return {
            success: true,
            partial: true,
            cpuName,
            cpuTotal: 'Calculando...',
            cpuTotalPercent: 0,
            coresCount: coreIds.length || current.filter(cpu => cpu.id !== 'cpu').length,
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
            status: 'Coletando primeira leitura'
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
        cpuName,
        cpuTotalPercent: Number(cpuTotalPercent.toFixed(1)),
        cpuTotal: `${cpuTotalPercent.toFixed(1)}%`,
        coresCount: coreIds.length || cores.length,
        cores,
        status: 'Monitorando CPU'
    };
}

module.exports = {
    getCpuStatus
};
