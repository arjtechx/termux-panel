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
    defaultCredentialsPath,
    appendLog
} = require('./utils');
const { getStatus, startTunnel, stopTunnel } = require('./process');

ensureModuleDirs();

let lastLoginUrl = '';

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
    const found = String(text || '').match(/https:\/\/[^\s"'<>]+/i);
    if (!found) return '';
    return found[0].replace(/[),.;\]]+$/g, '');
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

    const version = await runCommand('cloudflared', ['--version']);
    if (version.code !== 0) {
        const message = `cloudflared nÃ£o encontrado ou nÃ£o executou corretamente: ${version.stderr || version.stdout || 'verifique a instalacao'}`;
        fs.appendFileSync(LOGIN_LOG, `${message}\n`);
        if (io) io.emit('cloudflared-login-log', `${message}\n`);
        return { success: false, error: message };
    }

    const child = spawn('cloudflared', ['tunnel', 'login'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env }
    });

    let buffer = '';
    let loginUrl = '';
    const onData = (data) => {
        const text = data.toString();
        fs.appendFileSync(LOGIN_LOG, text);
        buffer = `${buffer}${text}`.slice(-8192);
        const found = extractCloudflareUrl(buffer);
        if (found && !loginUrl) {
            loginUrl = found;
            lastLoginUrl = found;
            if (io) io.emit('cloudflared-login-url', loginUrl);
            const opener = process.env.PREFIX ? 'termux-open-url' : 'xdg-open';
            spawn(opener, [loginUrl], { detached: true, stdio: 'ignore' }).on('error', () => {});
        }
        if (io) io.emit('cloudflared-login-log', text);
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => {
        fs.appendFileSync(LOGIN_LOG, `\nERRO: ${err.message}\n`);
        if (io) io.emit('cloudflared-login-log', `ERRO: ${err.message}\n`);
    });
    child.on('close', code => {
        fs.appendFileSync(LOGIN_LOG, `\nProcesso de login finalizado com código ${code}.\n`);
        if (io) io.emit('cloudflared-login-log', `\nProcesso de login finalizado com código ${code}.\n`);
    });

    return { success: true, pid: child.pid };
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
