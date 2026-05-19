const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
    TUNNELS_DIR,
    LOGIN_LOG,
    ensureModuleDirs,
    ensureDir,
    slugifyName,
    validateDomain,
    validateHost,
    validatePort,
    validateType,
    validatePath,
    tunnelDir,
    metaPath,
    configPath,
    logPath,
    readJson,
    writeJson,
    escapeYaml,
    makeLocalService,
    createFallbackUuid,
    cloudflaredHome,
    defaultCredentialsPath,
    appendLog
} = require('./utils');
const { getStatus, startTunnel, stopTunnel } = require('./process');
const systemConfig = require('../../src/utils/env');

ensureModuleDirs();

let lastLoginUrl = '';
let loginProcess = null;

function runCommand(command, args, options = {}) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => { stderr += data.toString(); });
        child.on('error', err => resolve({ code: -1, stdout, stderr: err.message }));
        child.on('close', code => resolve({ code, stdout, stderr }));
    });
}

function parseTunnelCreateOutput(output) {
    const uuid = (output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
    const credentials = (output.match(/(?:[A-Za-z]:)?[^\r\n"'<>]*\.json/i) || [])[0]?.trim();
    return { uuid, credentialsFile: credentials };
}

function extractCloudflareUrl(text) {
    const found = String(text || '').match(/https:\/\/dash\.cloudflare\.com[^\s\x1b"'<>]+|https:\/\/[^\s\x1b"'<>]+/i);
    if (!found) return '';
    return found[0].replace(/[),.;\]]+$/g, '');
}

function isTermux() {
    return !!(systemConfig.is_termux || (process.env.PREFIX || '').includes('com.termux'));
}

function openLoginUrl(url) {
    if (!url) return;
    const opener = isTermux() ? 'termux-open-url' : 'xdg-open';
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).on('error', () => {});
}

function emitLoginText(io, text) {
    fs.appendFileSync(LOGIN_LOG, text);
    if (io) io.emit('cloudflared-login-log', text);
}

function handleLoginOutput(io, state, text) {
    emitLoginText(io, text);
    state.buffer = `${state.buffer}${text}`.slice(-16384);
    const found = extractCloudflareUrl(state.buffer);
    if (found && !state.url) {
        state.url = found;
        lastLoginUrl = found;
        if (io) io.emit('cloudflared-login-url', found);
        openLoginUrl(found);
    }
}

function startLoginWithPty(io) {
    const script = String.raw`
import os, pty, select, subprocess, sys, time

master, slave = pty.openpty()
proc = subprocess.Popen(
    ["cloudflared", "tunnel", "login"],
    stdout=slave,
    stderr=slave,
    stdin=slave,
    close_fds=True,
    env=os.environ.copy()
)
os.close(slave)

try:
    while proc.poll() is None:
        ready, _, _ = select.select([master], [], [], 1.0)
        if not ready:
            continue
        data = os.read(master, 1024)
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
    while True:
        ready, _, _ = select.select([master], [], [], 0.1)
        if not ready:
            break
        data = os.read(master, 1024)
        if not data:
            break
        sys.stdout.buffer.write(data)
        sys.stdout.buffer.flush()
finally:
    try:
        os.close(master)
    except OSError:
        pass
    sys.exit(proc.wait())
`;

    return spawn('python', ['-c', script], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
    });
}

function buildConfig(meta) {
    const hostnameLine = meta.path
        ? `  - hostname: "${escapeYaml(meta.domain)}"\n    path: "${escapeYaml(meta.path)}"`
        : `  - hostname: "${escapeYaml(meta.domain)}"`;

    return [
        `tunnel: ${meta.uuid}`,
        `credentials-file: "${escapeYaml(meta.credentialsFile)}"`,
        '',
        'ingress:',
        hostnameLine,
        `    service: ${meta.localService}`,
        '',
        '  - service: http_status:404',
        ''
    ].join('\n');
}

function saveTunnel(meta) {
    ensureDir(tunnelDir(meta.id));
    writeJson(metaPath(meta.id), meta);
    fs.writeFileSync(configPath(meta.id), buildConfig(meta));
    fs.closeSync(fs.openSync(logPath(meta.id), 'a'));
}

function normalizeTunnelInput(input, existing = {}) {
    const name = String(input.name || existing.name || '').trim();
    const slug = existing.slug || slugifyName(name);
    const domain = validateDomain(input.domain || existing.domain);
    const type = validateType(input.type || existing.type);
    const localHost = validateHost(input.localHost || input.host || existing.localHost || '127.0.0.1');
    const localPort = validatePort(input.localPort || input.port || existing.localPort);
    const routePath = validatePath(input.path ?? existing.path);

    return {
        name,
        slug,
        domain,
        type,
        localHost,
        localPort,
        path: routePath,
        localService: makeLocalService(type, localHost, localPort),
        publicUrl: `https://${domain}${routePath || ''}`,
        autoRestart: Object.prototype.hasOwnProperty.call(input, 'autoRestart')
            ? input.autoRestart !== false
            : existing.autoRestart !== false
    };
}

function listTunnels() {
    ensureModuleDirs();
    return fs.readdirSync(TUNNELS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => readJson(path.join(TUNNELS_DIR, entry.name, 'meta.json'), null))
        .filter(Boolean)
        .map(meta => ({ ...meta, ...getStatus(meta.id) }))
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

async function createTunnel(input) {
    const normalized = normalizeTunnelInput(input);
    const { name, slug, domain, type, localHost, localPort, path: routePath } = normalized;
    const id = `${slug}-${Date.now()}`;

    const createResult = await runCommand('cloudflared', ['tunnel', 'create', slug]);
    const output = `${createResult.stdout}\n${createResult.stderr}`;
    const parsed = parseTunnelCreateOutput(output);

    if (createResult.code !== 0 || !parsed.uuid) {
        throw new Error(`cloudflared tunnel create falhou. Faça login antes de criar o túnel.\n${output.trim()}`);
    }

    const meta = {
        id,
        uuid: parsed.uuid || createFallbackUuid(),
        name,
        slug,
        domain,
        type,
        localHost,
        localPort,
        path: routePath,
        localService: normalized.localService,
        credentialsFile: parsed.credentialsFile || defaultCredentialsPath(parsed.uuid),
        publicUrl: normalized.publicUrl,
        autoRestart: normalized.autoRestart,
        status: 'offline',
        pid: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };

    saveTunnel(meta);

    const routeArgs = ['tunnel', 'route', 'dns', meta.uuid, domain];
    const routeResult = await runCommand('cloudflared', routeArgs);
    if (routeResult.code !== 0) {
        appendLog(logPath(id), `Aviso: rota DNS não foi criada automaticamente: ${routeResult.stderr || routeResult.stdout}`);
    }

    appendLog(logPath(id), `Túnel criado para ${meta.publicUrl} -> ${meta.localService}`);
    return meta;
}

function getTunnel(id) {
    const meta = readJson(metaPath(id), null);
    if (!meta) return null;
    return { ...meta, ...getStatus(id) };
}

function updateTunnel(id, input) {
    const current = readJson(metaPath(id), null);
    if (!current) throw new Error('TÃºnel nÃ£o encontrado.');

    const wasOnline = getStatus(id).online;
    if (wasOnline) stopTunnel(id);

    const patch = normalizeTunnelInput(input, current);
    const next = {
        ...current,
        ...patch,
        updatedAt: new Date().toISOString()
    };

    saveTunnel(next);
    appendLog(logPath(id), `ConfiguraÃ§Ã£o atualizada: ${next.publicUrl} -> ${next.localService}`);
    if (wasOnline) startTunnel(id);

    return { ...next, ...getStatus(id), wasOnline };
}

function deleteTunnel(id) {
    const meta = getTunnel(id);
    if (!meta) throw new Error('Túnel não encontrado.');
    stopTunnel(id);
    const dir = tunnelDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    return { success: true };
}

async function startLogin(io) {
    ensureModuleDirs();
    fs.writeFileSync(LOGIN_LOG, '');
    lastLoginUrl = '';

    if (loginProcess && !loginProcess.killed) {
        try { loginProcess.kill('SIGTERM'); } catch (_) {}
        loginProcess = null;
    }

    const version = await runCommand('cloudflared', ['--version']);
    if (version.code !== 0) {
        const message = `cloudflared nÃ£o encontrado ou nÃ£o executou corretamente: ${version.stderr || version.stdout || 'verifique a instalacao'}`;
        emitLoginText(io, `${message}\n`);
        return { success: false, error: message };
    }

    ensureDir(cloudflaredHome());

    const child = isTermux()
        ? startLoginWithPty(io)
        : spawn('cloudflared', ['tunnel', 'login'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env }
        });
    loginProcess = child;

    const state = { buffer: '', url: '' };
    const onData = (data) => {
        handleLoginOutput(io, state, data.toString());
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => {
        emitLoginText(io, `\nERRO: ${err.message}\n`);
    });
    child.on('close', code => {
        if (loginProcess === child) loginProcess = null;
        fs.appendFileSync(LOGIN_LOG, `\nProcesso de login finalizado com código ${code}.\n`);
        if (io) io.emit('cloudflared-login-log', `\nProcesso de login finalizado com código ${code}.\n`);
    });

    return { success: true, pid: child.pid, mode: isTermux() ? 'termux-pty' : 'pipe' };
}

function getLastLoginUrl() {
    if (lastLoginUrl) return lastLoginUrl;
    try {
        const text = fs.readFileSync(LOGIN_LOG, 'utf8');
        return extractCloudflareUrl(text);
    } catch (_) {
        return '';
    }
}

module.exports = {
    listTunnels,
    createTunnel,
    updateTunnel,
    getTunnel,
    deleteTunnel,
    startLogin,
    getLastLoginUrl,
    extractCloudflareUrl,
    runCommand,
    buildConfig
};
