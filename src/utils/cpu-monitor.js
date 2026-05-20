const fs = require('fs');
const path = require('path');
const os = require('os');

const PROC_STAT = '/proc/stat';
const PROC_CPUINFO = '/proc/cpuinfo';
const SYS_CPU_DIR = '/sys/devices/system/cpu';

let lastCpuSnapshot = null;
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

function parseCpuLine(line) {
    const parts = String(line || '').trim().split(/\s+/);
    const id = parts.shift();
    if (!id || !/^cpu\d*$/.test(id)) return null;

    const values = parts.map(value => Number.parseInt(value, 10) || 0);
    const user = values[0] || 0;
    const nice = values[1] || 0;
    const system = values[2] || 0;
    const idleBase = values[3] || 0;
    const iowait = values[4] || 0;
    const irq = values[5] || 0;
    const softirq = values[6] || 0;
    const steal = values[7] || 0;
    const idle = idleBase + iowait;
    const total = user + nice + system + idleBase + iowait + irq + softirq + steal;

    return { id, idle, total };
}

function readCpuSnapshot() {
    const raw = readText(PROC_STAT);
    const snapshot = {};
    raw.split('\n').forEach(line => {
        const parsed = parseCpuLine(line);
        if (parsed) snapshot[parsed.id] = parsed;
    });
    if (!snapshot.cpu) {
        throw new Error('/proc/stat nao contem linha cpu.');
    }
    return snapshot;
}

function calculateUsage(current, previous) {
    if (!current || !previous) return null;
    const totalDiff = current.total - previous.total;
    const idleDiff = current.idle - previous.idle;
    if (totalDiff <= 0) return null;
    const usage = ((totalDiff - idleDiff) / totalDiff) * 100;
    if (!Number.isFinite(usage)) return null;
    return Math.max(0, Math.min(100, Number(usage.toFixed(1))));
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
        cachedCoreIds = fs.readdirSync(SYS_CPU_DIR)
            .filter(name => /^cpu\d+$/.test(name))
            .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
    } catch (_) {
        cachedCoreIds = Array.from({ length: os.cpus().length || 1 }, (_, index) => `cpu${index}`);
    }

    if (cachedCoreIds.length === 0) cachedCoreIds = ['cpu0'];
    return cachedCoreIds;
}

function isCoreOnline(coreId, onlineSet) {
    if (onlineSet) return onlineSet.has(coreId);
    const onlinePath = path.join(SYS_CPU_DIR, coreId, 'online');
    const raw = safeReadText(onlinePath).trim();
    return raw === '' || raw === '1';
}

function readOnlineSet() {
    const raw = safeReadText(path.join(SYS_CPU_DIR, 'online'));
    return raw ? parseOnlineCpuList(raw) : null;
}

function readFrequency(coreId) {
    const cpufreqDir = path.join(SYS_CPU_DIR, coreId, 'cpufreq');
    const candidates = [
        path.join(cpufreqDir, 'scaling_cur_freq'),
        path.join(cpufreqDir, 'cpuinfo_cur_freq')
    ];

    for (const candidate of candidates) {
        const raw = safeReadText(candidate).trim();
        const khz = Number.parseInt(raw, 10);
        if (Number.isInteger(khz) && khz > 0) {
            const mhz = Math.round(khz / 1000);
            const ghz = Number((khz / 1000000).toFixed(2));
            return {
                khz,
                mhz,
                ghz,
                formatted: `${ghz.toFixed(2)} GHz`
            };
        }
    }

    return { formatted: 'freq. indisponivel' };
}

function readCpuName() {
    if (cachedCpuName) return cachedCpuName;

    try {
        const raw = readText(PROC_CPUINFO);
        const lines = raw.split('\n');
        const keys = [
            'Hardware',
            'model name',
            'Processor',
            'cpu model',
            'chipset',
            'machine'
        ];

        for (const key of keys) {
            const line = lines.find(item => item.toLowerCase().startsWith(key.toLowerCase()));
            const value = line && line.split(':').slice(1).join(':').trim();
            if (value && !/^0x/i.test(value)) {
                cachedCpuName = value;
                return cachedCpuName;
            }
        }
    } catch (_) {}

    const arch = os.arch();
    if (arch === 'arm64' || arch === 'aarch64') {
        cachedCpuName = 'AArch64 Processor';
    } else {
        cachedCpuName = 'CPU Android nao identificado';
    }
    return cachedCpuName;
}

function formatUsage(percent) {
    return percent === null ? 'Calculando...' : `${percent.toFixed(1)}%`;
}

function getCpuStatus() {
    const currentSnapshot = readCpuSnapshot();
    const previousSnapshot = lastCpuSnapshot;
    lastCpuSnapshot = currentSnapshot;

    const coreIds = getCoreIds();
    const onlineSet = readOnlineSet();
    const totalPercent = calculateUsage(currentSnapshot.cpu, previousSnapshot && previousSnapshot.cpu);
    const cores = coreIds.map(coreId => {
        const index = Number.parseInt(coreId.slice(3), 10);
        const online = isCoreOnline(coreId, onlineSet);
        const usagePercent = online ? calculateUsage(currentSnapshot[coreId], previousSnapshot && previousSnapshot[coreId]) : null;
        const frequency = online ? readFrequency(coreId) : { formatted: 'freq. indisponivel' };

        return {
            id: coreId,
            label: `CPU ${index}`,
            usagePercent,
            usage: online ? formatUsage(usagePercent) : 'offline',
            online,
            frequency
        };
    });

    const hasUnavailableFrequency = cores.some(core => core.online && core.frequency.formatted === 'freq. indisponivel');
    let status = previousSnapshot ? 'Monitorando CPU' : 'Calculando...';
    if (previousSnapshot && hasUnavailableFrequency) status = 'Frequencia indisponivel';

    return {
        success: true,
        cpuName: readCpuName(),
        cpuTotalPercent: totalPercent,
        cpuTotal: formatUsage(totalPercent),
        coresCount: coreIds.length,
        cores,
        status
    };
}

module.exports = {
    getCpuStatus
};
