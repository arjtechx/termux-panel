const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MODULE_DIR = __dirname;
const TUNNELS_DIR = path.join(MODULE_DIR, 'tunnels');
const LOGIN_LOG = path.join(MODULE_DIR, 'login.log');

const TYPE_SERVICES = {
    HTTP: 'http',
    HTTPS: 'https',
    TCP: 'tcp',
    SSH: 'ssh',
    RDP: 'rdp',
    FTP: 'ftp',
    SFTP: 'sftp',
    MYSQL: 'mysql',
    POSTGRES: 'postgres',
    CUSTOM: 'tcp'
};

function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}

function ensureModuleDirs() {
    ensureDir(MODULE_DIR);
    ensureDir(TUNNELS_DIR);
    if (!fs.existsSync(LOGIN_LOG)) fs.closeSync(fs.openSync(LOGIN_LOG, 'a'));
}

function slugifyName(value) {
    const clean = String(value || '')
        .trim()
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);

    if (!clean) {
        throw new Error('Nome do túnel inválido.');
    }
    return clean;
}

function validateDomain(value) {
    const domain = String(value || '').trim().toLowerCase();
    const domainPattern = /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
    if (!domainPattern.test(domain)) {
        throw new Error('Domínio inválido.');
    }
    return domain;
}

function validateHost(value) {
    const host = String(value || '127.0.0.1').trim();
    const hostPattern = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?|[a-zA-Z0-9.-]+)$/;
    if (!hostPattern.test(host)) {
        throw new Error('Host local inválido.');
    }
    return host;
}

function validatePort(value) {
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('Porta local inválida.');
    }
    return port;
}

function validateType(value) {
    const type = String(value || 'HTTP').trim().toUpperCase();
    if (!Object.prototype.hasOwnProperty.call(TYPE_SERVICES, type)) {
        throw new Error('Tipo de túnel inválido.');
    }
    return type;
}

function validatePath(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (!raw.startsWith('/')) {
        throw new Error('Path deve começar com /.');
    }
    if (raw.includes('..') || /[\r\n\t]/.test(raw)) {
        throw new Error('Path inválido.');
    }
    return raw.replace(/\/{2,}/g, '/').slice(0, 160);
}

function tunnelDir(id) {
    const safeId = String(id || '').trim();
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(safeId)) {
        throw new Error('ID do túnel inválido.');
    }
    return path.join(TUNNELS_DIR, safeId);
}

function metaPath(id) {
    return path.join(tunnelDir(id), 'meta.json');
}

function configPath(id) {
    return path.join(tunnelDir(id), 'config.yml');
}

function pidPath(id) {
    return path.join(tunnelDir(id), 'tunnel.pid');
}

function logPath(id) {
    return path.join(tunnelDir(id), 'tunnel.log');
}

function readJson(file, fallback = null) {
    try {
        if (!fs.existsSync(file)) return fallback;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
        return fallback;
    }
}

function writeJson(file, data) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function appendLog(file, message) {
    ensureDir(path.dirname(file));
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${message}${os.EOL}`);
}

function escapeYaml(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function makeLocalService(type, host, port) {
    const protocol = TYPE_SERVICES[type] || 'http';
    if (protocol === 'http' || protocol === 'https') {
        return `${protocol}://${host}:${port}`;
    }
    return `tcp://${host}:${port}`;
}

function createFallbackUuid() {
    return crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
}

function cloudflaredHome() {
    const termuxHome = '/data/data/com.termux/files/home';
    if (process.env.HOME) return path.join(process.env.HOME, '.cloudflared');
    if (process.env.PREFIX && process.env.PREFIX.includes('com.termux')) return path.join(termuxHome, '.cloudflared');
    return path.join(os.homedir(), '.cloudflared');
}

function defaultCredentialsPath(uuid) {
    return path.join(cloudflaredHome(), `${uuid}.json`);
}

function certPath() {
    return path.join(cloudflaredHome(), 'cert.pem');
}

module.exports = {
    MODULE_DIR,
    TUNNELS_DIR,
    LOGIN_LOG,
    ensureDir,
    ensureModuleDirs,
    slugifyName,
    validateDomain,
    validateHost,
    validatePort,
    validateType,
    validatePath,
    tunnelDir,
    metaPath,
    configPath,
    pidPath,
    logPath,
    readJson,
    writeJson,
    appendLog,
    escapeYaml,
    makeLocalService,
    createFallbackUuid,
    cloudflaredHome,
    defaultCredentialsPath,
    certPath
};
