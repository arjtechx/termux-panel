const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const processManager = require('./process');

const PANEL_DIR = path.resolve(__dirname, '..', '..');
const DB_FILE = path.join(PANEL_DIR, 'config', 'cloudflared_tunnels.json');

// Ensure DB exists
if (!fs.existsSync(DB_FILE)) {
    if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

function getTunnels() {
    try {
        return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch {
        return [];
    }
}

function saveTunnels(tunnels) {
    fs.writeFileSync(DB_FILE, JSON.stringify(tunnels, null, 2));
}

/**
 * Creates a new tunnel configuration
 */
function createTunnel(data) {
    const { name, type, token, domain, localPort } = data;
    const tunnels = getTunnels();
    
    if (tunnels.find(t => t.name === name)) {
        throw new Error('Um túnel com este nome já existe.');
    }

    const id = Date.now().toString();
    const newTunnel = { id, name, type, token, domain, localPort, createdAt: new Date().toISOString() };

    // If classic mode, we must interact with CLI
    if (type === 'classic') {
        try {
            // Create tunnel (generates credentials file)
            execSync(`cloudflared tunnel create "${name}"`, { stdio: 'pipe' });
            // Route DNS
            execSync(`cloudflared tunnel route dns "${name}" "${domain}"`, { stdio: 'pipe' });
        } catch (err) {
            throw new Error('Falha ao registrar túnel no Cloudflare: ' + err.message);
        }
    }

    tunnels.push(newTunnel);
    saveTunnels(tunnels);
    return newTunnel;
}

/**
 * Update existing tunnel configuration
 */
function updateTunnel(id, data) {
    const tunnels = getTunnels();
    const index = tunnels.findIndex(t => t.id === id);
    if (index === -1) throw new Error('Túnel não encontrado.');

    // Note: In classic mode, changing the domain or name requires CLI actions.
    // For simplicity, we only allow changing the localPort or Token for now.
    if (data.localPort) tunnels[index].localPort = data.localPort;
    if (data.token && tunnels[index].type === 'token') tunnels[index].token = data.token;
    if (data.domain && tunnels[index].type === 'token') tunnels[index].domain = data.domain;

    saveTunnels(tunnels);
    return tunnels[index];
}

/**
 * Delete a tunnel
 */
function deleteTunnel(id) {
    let tunnels = getTunnels();
    const tunnel = tunnels.find(t => t.id === id);
    if (!tunnel) throw new Error('Túnel não encontrado.');

    // Stop process
    processManager.stopTunnelProcess(id);

    // Delete from Cloudflare if classic
    if (tunnel.type === 'classic') {
        try {
            execSync(`cloudflared tunnel delete -f "${tunnel.name}"`, { stdio: 'pipe' });
        } catch (e) {
            console.error('Falha ao excluir no Cloudflare, removendo localmente...', e.message);
        }
    }

    tunnels = tunnels.filter(t => t.id !== id);
    saveTunnels(tunnels);
    return { success: true };
}

/**
 * Starts a specific tunnel
 */
function startTunnel(id) {
    const tunnel = getTunnels().find(t => t.id === id);
    if (!tunnel) throw new Error('Túnel não encontrado.');

    if (tunnel.type === 'token') {
        return processManager.startTunnelProcess(id, { token: tunnel.token });
    } else {
        // Classic mode requires routing to local port dynamically
        const targetUrl = tunnel.localPort.includes('://') ? tunnel.localPort : `http://localhost:${tunnel.localPort.replace(/[^0-9]/g, '')}`;
        return processManager.startTunnelProcess(id, { 
            commandOpts: ['--url', targetUrl]
        });
    }
}

/**
 * Stops a specific tunnel
 */
function stopTunnel(id) {
    return processManager.stopTunnelProcess(id);
}

/**
 * List all tunnels with their current process status
 */
function listTunnels() {
    const tunnels = getTunnels();
    return tunnels.map(t => {
        const status = processManager.getTunnelStatus(t.id);
        return { ...t, ...status };
    });
}

/**
 * Generates Auth Login Link (Classic Mode)
 */
function getLoginUrl() {
    try {
        // Run cloudflared tunnel login in background and extract URL
        // In Termux, cloudflared login blocks waiting for browser. We capture stdout.
        const tmpLog = path.join(PANEL_DIR, 'logs', 'cloudflared_login.log');
        execSync(`cloudflared tunnel login > "${tmpLog}" 2>&1 &`);
        // Wait 2 seconds for URL to appear
        execSync('sleep 2');
        const logs = fs.readFileSync(tmpLog, 'utf8');
        const match = logs.match(/https:\/\/(?:[a-zA-Z0-9-]+\.)*cloudflare\.com\/a\/[^\s]+/);
        return match ? match[0] : null;
    } catch {
        return null;
    }
}

function isClassicAuthenticated() {
    const certPath = path.join(process.env.HOME || '/data/data/com.termux/files/home', '.cloudflared', 'cert.pem');
    return fs.existsSync(certPath);
}

module.exports = {
    getTunnels,
    createTunnel,
    updateTunnel,
    deleteTunnel,
    startTunnel,
    stopTunnel,
    listTunnels,
    getLoginUrl,
    isClassicAuthenticated
};
