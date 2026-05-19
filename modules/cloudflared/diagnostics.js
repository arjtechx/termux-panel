const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const systemConfig = require('../../src/utils/env');
const {
    TUNNELS_DIR,
    LOGIN_LOG,
    ensureModuleDirs,
    cloudflaredHome,
    certPath,
    configPath,
    metaPath,
    readJson
} = require('./utils');
const { getStatus } = require('./process');
const logs = require('./logs');

const TERMUX_PREFIX = process.env.PREFIX || systemConfig.prefix || '/data/data/com.termux/files/usr';
const IS_TERMUX = !!(systemConfig.is_termux || String(TERMUX_PREFIX).includes('com.termux'));

function runCommand(command, args, timeoutMs = 6000) {
    return new Promise((resolve) => {
        let stdout = '';
        let stderr = '';
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (_) {}
            resolve({ code: -1, stdout, stderr: `${stderr}\nTimeout ao executar ${command}`.trim() });
        }, timeoutMs);

        child.stdout.on('data', data => { stdout += data.toString(); });
        child.stderr.on('data', data => { stderr += data.toString(); });
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

function checkWritableDir(dir) {
    try {
        fs.mkdirSync(dir, { recursive: true });
        const probe = path.join(dir, `.write-test-${Date.now()}`);
        fs.writeFileSync(probe, 'ok');
        fs.unlinkSync(probe);
        return true;
    } catch (_) {
        return false;
    }
}

async function commandExists(command) {
    const result = await runCommand('sh', ['-lc', `command -v ${command}`], 2500);
    return result.code === 0;
}

function installHint() {
    if (IS_TERMUX) {
        return 'No Termux, tente: pkg update && pkg install cloudflared termux-api -y';
    }
    return 'Instale o cloudflared e garanta que o comando esteja no PATH do processo Node.';
}

function checkPort(host, port, timeoutMs = 1200) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let done = false;
        const finish = (ok, error = '') => {
            if (done) return;
            done = true;
            socket.destroy();
            resolve({ ok, error });
        };
        socket.setTimeout(timeoutMs);
        socket.once('connect', () => finish(true));
        socket.once('timeout', () => finish(false, 'timeout'));
        socket.once('error', err => finish(false, err.code || err.message));
        socket.connect(port, host);
    });
}

async function diagnoseTunnel(meta) {
    const status = getStatus(meta.id);
    const credentialsOk = !!meta.credentialsFile && fs.existsSync(meta.credentialsFile);
    const configOk = fs.existsSync(configPath(meta.id));
    const local = await checkPort(meta.localHost, meta.localPort);
    const issues = [];

    if (!credentialsOk) issues.push('Arquivo de credenciais do túnel não encontrado.');
    if (!configOk) issues.push('config.yml do túnel não encontrado.');
    if (!local.ok) issues.push(`Servico local indisponivel em ${meta.localHost}:${meta.localPort} (${local.error}).`);
    if (meta.status === 'online' && !status.online) issues.push('Marcado como online, mas o processo não está ativo.');

    return {
        id: meta.id,
        name: meta.name,
        status: status.status,
        pid: status.pid,
        publicUrl: meta.publicUrl,
        localService: meta.localService,
        checks: {
            credentials: credentialsOk,
            config: configOk,
            localService: local.ok
        },
        issues
    };
}

async function runDiagnostics() {
    ensureModuleDirs();

    const version = await runCommand('cloudflared', ['--version']);
    const installed = version.code === 0;
    const homeCloudflaredDir = cloudflaredHome();
    const cert = certPath();
    const certExists = fs.existsSync(cert);
    const moduleWritable = checkWritableDir(TUNNELS_DIR);
    const homeWritable = checkWritableDir(homeCloudflaredDir);
    const loginLog = fs.existsSync(LOGIN_LOG) ? logs.getLoginLogs(80) : '';
    const termuxOpenUrl = IS_TERMUX ? await commandExists('termux-open-url') : false;
    const termuxApi = IS_TERMUX ? await commandExists('termux-api') : false;

    const tunnelMetas = fs.readdirSync(TUNNELS_DIR, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => readJson(metaPath(entry.name), null))
        .filter(Boolean);

    const tunnels = [];
    for (const meta of tunnelMetas) {
        tunnels.push(await diagnoseTunnel(meta));
    }

    const issues = [];
    if (!installed) issues.push(`cloudflared não está instalado ou não está no PATH. ${installHint()}`);
    if (!certExists) issues.push('Login Cloudflare não encontrado: cert.pem ausente. Clique em Login Cloudflare.');
    if (!moduleWritable) issues.push('Pasta de túneis do painel sem permissão de escrita.');
    if (!homeWritable) issues.push('Pasta ~/.cloudflared sem permissão de escrita.');
    if (IS_TERMUX && !termuxOpenUrl) issues.push('termux-open-url não encontrado. Instale/ative o Termux:API para abrir a URL de login automaticamente.');
    tunnels.forEach(tunnel => {
        tunnel.issues.forEach(issue => issues.push(`${tunnel.name}: ${issue}`));
    });

    return {
        success: true,
        ok: issues.length === 0,
        environment: {
            type: IS_TERMUX ? 'termux' : systemConfig.type,
            isTermux: IS_TERMUX,
            prefix: TERMUX_PREFIX,
            home: process.env.HOME || (IS_TERMUX ? '/data/data/com.termux/files/home' : os.homedir()),
            packageManager: IS_TERMUX ? 'pkg' : systemConfig.package_manager
        },
        installed,
        version: installed ? `${version.stdout}${version.stderr}`.trim() : '',
        installHint: installHint(),
        paths: {
            cloudflaredHome: homeCloudflaredDir,
            cert,
            tunnelsDir: TUNNELS_DIR
        },
        checks: {
            installed,
            loggedIn: certExists,
            moduleWritable,
            cloudflaredHomeWritable: homeWritable,
            termuxOpenUrl,
            termuxApi
        },
        issues,
        tunnels,
        loginLog
    };
}

module.exports = {
    runDiagnostics
};
