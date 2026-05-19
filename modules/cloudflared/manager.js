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
    certPath,
    appendLog
} = require('./utils');
const { getStatus, startTunnel, stopTunnel } = require('./process');
const systemConfig = require('../../src/utils/env');

ensureModuleDirs();

let lastLoginUrl = '';
let loginProcess = null;
let loginWatchTimer = null;
let loginStatus = {
    state: 'idle',
    message: 'Nao autenticado',
    authUrl: '',
    running: false,
    pid: null,
    updatedAt: new Date().toISOString()
};

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

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function runTerminalScript(script, options = {}) {
    const shell = process.platform === 'win32' ? 'powershell' : 'sh';
    const args = process.platform === 'win32'
        ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]
        : ['-lc', script];

    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        const child = spawn(shell, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            resolve({ code: -1, stdout, stderr: `${stderr}\nTimeout ao executar comandos de limpeza`.trim() });
        }, options.timeoutMs || 30000);

        child.stdout.on('data', data => {
            const text = data.toString();
            stdout += text;
            options.onData?.(text);
        });
        child.stderr.on('data', data => {
            const text = data.toString();
            stderr += text;
            options.onData?.(text);
        });
        child.on('error', err => {
            clearTimeout(timer);
            resolve({ code: -1, stdout, stderr: err.message });
        });
        child.on('close', code => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

function parseTunnelCreateOutput(output) {
    const uuid = (output.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0];
    const credentials = (output.match(/(?:[A-Za-z]:)?[^\r\n"'<>]*\.json/i) || [])[0]?.trim();
    return { uuid, credentialsFile: credentials };
}

function extractCloudflareUrl(text) {
    const clean = String(text || '')
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
    const found = clean.match(/https:\/\/dash\.cloudflare\.com[^\s"'<>]+|https?:\/\/[^\s"'<>]+/i);
    if (!found) return '';
    return found[0].replace(/[),.;\]]+$/g, '');
}

function isTermux() {
    return !!(systemConfig.is_termux || (process.env.PREFIX || '').includes('com.termux'));
}

function openLoginUrl(url) {
    if (!url) return;
    let command = 'xdg-open';
    let args = [url];

    if (isTermux()) {
        command = 'termux-open-url';
    } else if (process.platform === 'win32') {
        command = 'powershell';
        args = ['-NoProfile', '-Command', 'Start-Process -FilePath $args[0]', url];
    } else if (process.platform === 'darwin') {
        command = 'open';
    }

    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref?.();
}

function emitLoginText(io, text) {
    fs.appendFileSync(LOGIN_LOG, text);
    if (io) io.emit('cloudflared-login-log', text);
}

function getLoginStatusSnapshot() {
    const cert = certPath();
    const loggedIn = fs.existsSync(cert);
    return {
        success: true,
        ...loginStatus,
        authUrl: loginStatus.authUrl || lastLoginUrl || getLastLoginUrl(),
        loggedIn,
        certPath: cert,
        state: loggedIn ? 'success' : loginStatus.state,
        message: loggedIn ? 'Login realizado com sucesso' : loginStatus.message
    };
}

function emitLoginStatus(io, patch = {}) {
    loginStatus = {
        ...loginStatus,
        ...patch,
        updatedAt: new Date().toISOString()
    };

    const snapshot = getLoginStatusSnapshot();
    if (io) io.emit('cloudflared-login-status', snapshot);
    return snapshot;
}

function stopLoginWatcher() {
    if (loginWatchTimer) {
        clearInterval(loginWatchTimer);
        loginWatchTimer = null;
    }
}

function startLoginWatcher(io) {
    stopLoginWatcher();
    let certWasReported = fs.existsSync(certPath());
    let checks = 0;

    loginWatchTimer = setInterval(() => {
        checks += 1;
        const certExists = fs.existsSync(certPath());
        if (certExists && !certWasReported) {
            certWasReported = true;
            emitLoginText(io, '\ncert.pem detectado. Login Cloudflare realizado com sucesso.\n');
            emitLoginStatus(io, {
                state: 'success',
                message: 'Login realizado com sucesso',
                running: false,
                pid: null
            });
            stopLoginWatcher();
            return;
        }

        if (checks >= 240 && loginStatus.state !== 'success') {
            emitLoginStatus(io, {
                running: false,
                pid: null,
                message: 'Tempo limite aguardando cert.pem'
            });
            stopLoginWatcher();
            return;
        }

        emitLoginStatus(io);
    }, 1500);
}

function handleLoginOutput(io, state, text) {
    emitLoginText(io, text);
    state.buffer = `${state.buffer}${text}`.slice(-16384);
    const found = extractCloudflareUrl(state.buffer);
    if (found && !state.url) {
        state.url = found;
        lastLoginUrl = found;
        if (io) io.emit('cloudflared-login-url', found);
        emitLoginStatus(io, {
            state: 'url_detected',
            message: 'Aguardando autorizacao Cloudflare',
            authUrl: found
        });
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

async function startLogin(io, options = {}) {
    ensureModuleDirs();
    if (options.preserveLog) {
        emitLoginText(io, '\n--- Novo login Cloudflare ---\n');
    } else {
        fs.writeFileSync(LOGIN_LOG, '');
    }
    lastLoginUrl = '';
    stopLoginWatcher();

    if (loginProcess && !loginProcess.killed) {
        try { loginProcess.kill('SIGTERM'); } catch (_) {}
        loginProcess = null;
    }

    if (fs.existsSync(certPath())) {
        const message = 'Login Cloudflare ja esta autenticado: cert.pem encontrado.';
        emitLoginText(io, `${message}\n`);
        return emitLoginStatus(io, {
            state: 'success',
            message,
            authUrl: '',
            running: false,
            pid: null
        });
    }

    emitLoginStatus(io, {
        state: 'starting',
        message: 'Conectando ao Cloudflare...',
        authUrl: '',
        running: true,
        pid: null
    });

    const version = await runCommand('cloudflared', ['--version']);
    if (version.code !== 0) {
        const message = `cloudflared nÃ£o encontrado ou nÃ£o executou corretamente: ${version.stderr || version.stdout || 'verifique a instalacao'}`;
        emitLoginText(io, `${message}\n`);
        emitLoginStatus(io, {
            state: 'error',
            message,
            running: false,
            pid: null
        });
        return { success: false, error: message };
    }

    ensureDir(cloudflaredHome());
    emitLoginText(io, 'Executando cloudflared tunnel login...\nAguardando URL de autorizacao da Cloudflare...\n');

    const child = isTermux()
        ? startLoginWithPty(io)
        : spawn('cloudflared', ['tunnel', 'login'], {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env }
        });
    loginProcess = child;
    emitLoginStatus(io, {
        state: 'waiting_url',
        message: 'Aguardando autenticacao...',
        running: true,
        pid: child.pid
    });
    startLoginWatcher(io);

    const state = { buffer: '', url: '' };
    const onData = (data) => {
        handleLoginOutput(io, state, data.toString());
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', err => {
        emitLoginText(io, `\nERRO: ${err.message}\n`);
        emitLoginStatus(io, {
            state: 'error',
            message: err.message,
            running: false,
            pid: null
        });
        stopLoginWatcher();
    });
    child.on('close', code => {
        if (loginProcess === child) loginProcess = null;
        emitLoginText(io, `\nProcesso de login finalizado com código ${code}.\n`);

        if (fs.existsSync(certPath())) {
            emitLoginText(io, 'cert.pem detectado. Login Cloudflare realizado com sucesso.\n');
            emitLoginStatus(io, {
                state: 'success',
                message: 'Login realizado com sucesso',
                running: false,
                pid: null
            });
            stopLoginWatcher();
            return;
        }

        emitLoginStatus(io, {
            state: code === 0 ? 'waiting_cert' : 'error',
            message: code === 0 ? 'Aguardando criacao do cert.pem...' : 'Login Cloudflare finalizado sem gerar cert.pem',
            running: false,
            pid: null
        });
        if (code !== 0) stopLoginWatcher();
    });

    return {
        success: true,
        ...getLoginStatusSnapshot(),
        pid: child.pid,
        mode: isTermux() ? 'termux-pty' : 'pipe'
    };
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

async function resetManagerViaTerminal(io) {
    ensureModuleDirs();
    stopLoginWatcher();
    if (loginProcess && !loginProcess.killed) {
        try { loginProcess.kill('SIGTERM'); } catch (_) {}
        loginProcess = null;
    }

    const home = cloudflaredHome();
    const resetScript = path.join(__dirname, '..', '..', 'scripts', 'cloudflared-reset.sh');
    const script = process.platform === 'win32'
        ? [
            `$ErrorActionPreference = 'Continue'`,
            `Write-Output "[cloudflared] Limpando processos antigos..."`,
            `Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue`,
            `Write-Output "[cloudflared] Removendo cert.pem..."`,
            `Remove-Item -LiteralPath ${JSON.stringify(certPath())} -Force -ErrorAction SilentlyContinue`,
            `Write-Output "[cloudflared] Removendo credenciais .json antigas..."`,
            `if (Test-Path -LiteralPath ${JSON.stringify(home)}) { Get-ChildItem -LiteralPath ${JSON.stringify(home)} -Filter *.json -File -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue }`,
            `Write-Output "[cloudflared] Removendo tuneis do painel..."`,
            `if (Test-Path -LiteralPath ${JSON.stringify(TUNNELS_DIR)}) { Get-ChildItem -LiteralPath ${JSON.stringify(TUNNELS_DIR)} -Directory -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue }`,
            `Write-Output "[cloudflared] Limpeza concluida."`
        ].join('; ')
        : `sh ${shellQuote(resetScript)} ${shellQuote(home)} ${shellQuote(TUNNELS_DIR)}`;

    fs.writeFileSync(LOGIN_LOG, '');
    const result = await runTerminalScript(script, {
        timeoutMs: 30000,
        onData: text => emitLoginText(io, text)
    });

    loginStatus = {
        state: 'idle',
        message: 'Nao autenticado',
        authUrl: '',
        running: false,
        pid: null,
        updatedAt: new Date().toISOString()
    };
    lastLoginUrl = '';

    return {
        success: result.code === 0,
        code: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        error: result.code === 0 ? undefined : (result.stderr || result.stdout || 'Falha ao executar comandos de limpeza')
    };
}

async function resetAndStartLogin(io) {
    const reset = await resetManagerViaTerminal(io);
    if (!reset.success) {
        return { success: false, reset, error: reset.error || 'Falha ao limpar dados do Cloudflared' };
    }

    const login = await startLogin(io, { preserveLog: true });
    return {
        ...login,
        success: Boolean(login.success),
        reset,
        login
    };
}

module.exports = {
    listTunnels,
    createTunnel,
    updateTunnel,
    getTunnel,
    deleteTunnel,
    startLogin,
    getLastLoginUrl,
    getLoginStatusSnapshot,
    extractCloudflareUrl,
    runCommand,
    buildConfig,
    resetManagerViaTerminal,
    resetAndStartLogin
};
