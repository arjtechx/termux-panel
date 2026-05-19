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
        let tunnels = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        let migrated = false;
        
        // Automatic Schema Migration for old Termux-Panel versions
        tunnels = tunnels.map(t => {
            let changed = false;
            if (!t.type) { t.type = 'classic'; changed = true; }
            if (t.port && !t.localPort) { t.localPort = String(t.port); changed = true; }
            if (changed) migrated = true;
            return t;
        });

        if (migrated) saveTunnels(tunnels);
        return tunnels;
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
async function getLoginUrl() {
    return new Promise((resolve) => {
        try {
            // Utilizamos spawn para monitorar a saída em tempo real
            const { spawn } = require('child_process');
            const child = spawn('cloudflared', ['tunnel', 'login'], { shell: true });
            
            let found = false;
            let fullOutput = '';

            const handleData = (data) => {
                if (found) return;
                const text = data.toString();
                fullOutput += text;
                
                // Nova Regex: Captura o novo padrão dash.cloudflare.com e o padrão antigo
                const match = text.match(/https:\/\/(?:[a-zA-Z0-9-]+\.)*cloudflare\.com\/[^\s"'<>]+/i);
                if (match) {
                    found = true;
                    child.unref(); // Deixa o processo rodando solto para aguardar o navegador
                    resolve({ url: match[0] });
                }
            };

            child.stdout.on('data', handleData);
            child.stderr.on('data', handleData);

            child.on('error', (err) => { 
                if (!found) resolve({ error: 'Falha ao iniciar cloudflared: ' + err.message }); 
            });
            child.on('close', () => { 
                if (!found) resolve({ error: 'Processo encerrou antes da URL. Saída gerada:\n' + fullOutput }); 
            });

            // Timeout de segurança se o link não aparecer em 8s
            setTimeout(() => { 
                if (!found) resolve({ error: 'Timeout de 8s excedido. Saída parcial:\n' + fullOutput }); 
            }, 8000);
        } catch (e) {
            resolve({ error: 'Erro Try-Catch: ' + e.message });
        }
    });
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
