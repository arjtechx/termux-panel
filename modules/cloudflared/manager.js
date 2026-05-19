const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const processManager = require('./process');

const PANEL_DIR = path.resolve(__dirname, '..', '..');
const DB_FILE = path.join(PANEL_DIR, 'config', 'cloudflared_tunnels.json');
const CONFIGS_DIR = path.join(PANEL_DIR, 'config', 'cloudflared');

// Ensure directories and files exist
if (!fs.existsSync(CONFIGS_DIR)) fs.mkdirSync(CONFIGS_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) {
    if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
    fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

function getTunnels() {
    try {
        let tunnels = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        let migrated = false;
        
        // Automatic Schema Migration
        tunnels = tunnels.map(t => {
            let changed = false;
            if (!t.type) { t.type = 'classic'; changed = true; }
            if (t.port && !t.localPort) { t.localPort = String(t.port); changed = true; }
            if (!t.proto) { t.proto = 'http'; changed = true; }
            if (!t.localHost) { t.localHost = 'localhost'; changed = true; }
            if (t.autoStart === undefined) { t.autoStart = false; changed = true; }
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
 * Generates dynamic YAML config template for classic custom tunnels
 */
function generateYamlConfig(tunnel) {
    let yaml = `# Configuração automática gerada pelo Termux Panel\n`;
    yaml += `tunnel: "${tunnel.name}"\n`;
    
    const credPath = path.join(CONFIGS_DIR, `${tunnel.id}.json`);
    yaml += `credentials-file: "${credPath}"\n\n`;
    
    yaml += `ingress:\n`;
    
    if (tunnel.ingress && Array.isArray(tunnel.ingress) && tunnel.ingress.length > 0) {
        tunnel.ingress.forEach(rule => {
            yaml += `  - hostname: "${rule.hostname}"\n`;
            if (rule.path) yaml += `    path: "${rule.path}"\n`;
            yaml += `    service: "${rule.service}"\n`;
        });
    } else {
        const proto = tunnel.proto || 'http';
        const host = tunnel.localHost || 'localhost';
        const port = tunnel.localPort || '80';
        const serviceUrl = `${proto}://${host}:${port}`;
        
        if (tunnel.domain) {
            yaml += `  - hostname: "${tunnel.domain}"\n`;
            yaml += `    service: "${serviceUrl}"\n`;
        }
    }
    
    // Catch-all rules requirements from Cloudflared
    yaml += `  - service: http_status:404\n`;
    return yaml;
}

/**
 * Validates YAML text structures
 */
function validateYamlConfig(yamlText) {
    if (/\t/.test(yamlText)) {
        return { valid: false, error: 'O arquivo YAML não pode conter caracteres de tabulação (Tab). Use apenas espaços.' };
    }
    if (!/tunnel\s*:/i.test(yamlText)) {
        return { valid: false, error: 'A propriedade "tunnel:" contendo o ID ou nome é obrigatória.' };
    }
    if (!/ingress\s*:/i.test(yamlText)) {
        return { valid: false, error: 'A diretiva "ingress:" é obrigatória para definir as rotas locais.' };
    }
    
    const lines = yamlText.split('\n');
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#')) continue;
        if (!line.includes(':') && !line.startsWith('-')) {
            return { valid: false, error: `Erro de indentação/sintaxe na linha ${i + 1}: Falta do delimitador ":"` };
        }
    }
    return { valid: true };
}

/**
 * Creates tunnel config
 */
function createTunnel(data) {
    const { name, type, token, domain, proto, localHost, localPort, autoStart, ingress } = data;
    const tunnels = getTunnels();
    
    if (!name) throw new Error('O nome do túnel é obrigatório.');
    if (tunnels.find(t => t.name === name)) {
        throw new Error('Um túnel com este nome já existe.');
    }

    const id = Date.now().toString();
    const newTunnel = {
        id,
        name,
        type: type || 'classic',
        token: token || '',
        domain: domain || '',
        proto: proto || 'http',
        localHost: localHost || 'localhost',
        localPort: localPort ? String(localPort) : '80',
        autoStart: !!autoStart,
        ingress: ingress || [],
        createdAt: new Date().toISOString(),
        yamlConfig: ''
    };

    // If classic_custom, pre-generate default YAML
    if (newTunnel.type === 'classic_custom') {
        newTunnel.yamlConfig = generateYamlConfig(newTunnel);
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

    const t = tunnels[index];
    if (data.name) t.name = data.name;
    if (data.type) t.type = data.type;
    if (data.token !== undefined) t.token = data.token;
    if (data.domain !== undefined) t.domain = data.domain;
    if (data.proto !== undefined) t.proto = data.proto;
    if (data.localHost !== undefined) t.localHost = data.localHost;
    if (data.localPort !== undefined) t.localPort = String(data.localPort);
    if (data.autoStart !== undefined) t.autoStart = !!data.autoStart;
    if (data.ingress !== undefined) t.ingress = data.ingress;
    
    // Save YAML changes directly if provided and validated
    if (data.yamlConfig !== undefined) {
        if (data.yamlConfig) {
            const check = validateYamlConfig(data.yamlConfig);
            if (!check.valid) throw new Error(check.error);
        }
        t.yamlConfig = data.yamlConfig;
    }

    tunnels[index] = t;
    saveTunnels(tunnels);
    return t;
}

/**
 * Delete tunnel and config files
 */
function deleteTunnel(id) {
    let tunnels = getTunnels();
    const tunnel = tunnels.find(t => t.id === id);
    if (!tunnel) throw new Error('Túnel não encontrado.');

    // Stop process
    processManager.stopTunnelProcess(id);

    // Delete custom YAML files if they exist
    const configPath = path.join(CONFIGS_DIR, `${id}_config.yml`);
    const credPath = path.join(CONFIGS_DIR, `${id}.json`);
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    if (fs.existsSync(credPath)) fs.unlinkSync(credPath);

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
        return processManager.startTunnelProcess(id, { 
            token: tunnel.token,
            autoRestart: tunnel.autoStart
        });
    } else if (tunnel.type === 'classic_custom') {
        const configPath = path.join(CONFIGS_DIR, `${tunnel.id}_config.yml`);
        const finalYaml = tunnel.yamlConfig || generateYamlConfig(tunnel);
        
        fs.writeFileSync(configPath, finalYaml);
        return processManager.startTunnelProcess(id, {
            configPath,
            tunnelName: tunnel.name,
            autoRestart: tunnel.autoStart
        });
    } else {
        // Classic Quick Tunnel: compose URL from proto + host + port
        const proto = tunnel.proto || 'http';
        const host = tunnel.localHost || 'localhost';
        const port = tunnel.localPort ? tunnel.localPort.replace(/\D/g, '') : '80';
        const targetUrl = `${proto}://${host}:${port}`;
            
        return processManager.startTunnelProcess(id, { 
            quickUrl: targetUrl,
            autoRestart: tunnel.autoStart
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
 * List all tunnels with process status
 */
async function listTunnels() {
    const tunnels = getTunnels();
    const result = [];
    for (const t of tunnels) {
        const status = await processManager.getTunnelStatus(t.id);
        result.push({ ...t, ...status });
    }
    return result;
}

function getCertPath() {
    const homeDir = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';
    return path.join(homeDir, '.cloudflared', 'cert.pem');
}

function isClassicAuthenticated() {
    return fs.existsSync(getCertPath());
}

function clearCertificate() {
    const certPath = getCertPath();
    if (fs.existsSync(certPath)) {
        fs.unlinkSync(certPath);
    }
}

async function resetManager() {
    const tunnels = getTunnels();
    for (const t of tunnels) {
        try {
            processManager.stopTunnelProcess(t.id);
        } catch (err) {
            console.error(`Erro ao parar túnel ${t.id}:`, err.message);
        }
        try {
            const configPath = path.join(CONFIGS_DIR, `${t.id}_config.yml`);
            const credPath = path.join(CONFIGS_DIR, `${t.id}.json`);
            if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
            if (fs.existsSync(credPath)) fs.unlinkSync(credPath);
        } catch (err) {
            console.error(`Erro ao remover arquivos do túnel ${t.id}:`, err.message);
        }
    }
    try {
        processManager.killAllZombies();
    } catch (err) {
        console.error('Erro ao limpar processos zumbis:', err.message);
    }
    saveTunnels([]);
    clearCertificate();
    return { success: true };
}

/**
 * Imports configurations and merges
 */
function importConfigurations(tunnelsList) {
    if (!Array.isArray(tunnelsList)) throw new Error('O arquivo de configuração importado precisa ser uma lista válida.');
    
    const existing = getTunnels();
    tunnelsList.forEach(imported => {
        if (!imported.name) return;
        const dupIndex = existing.findIndex(t => t.name === imported.name);
        
        const tunnelObj = {
            id: imported.id || Date.now().toString() + Math.random().toString().slice(-4),
            name: imported.name,
            type: imported.type || 'classic',
            token: imported.token || '',
            domain: imported.domain || '',
            proto: imported.proto || 'http',
            localHost: imported.localHost || 'localhost',
            localPort: String(imported.localPort || '80'),
            autoStart: !!imported.autoStart,
            ingress: imported.ingress || [],
            yamlConfig: imported.yamlConfig || '',
            createdAt: imported.createdAt || new Date().toISOString()
        };

        if (dupIndex !== -1) {
            existing[dupIndex] = tunnelObj;
        } else {
            existing.push(tunnelObj);
        }
    });

    saveTunnels(existing);
    return { success: true, count: tunnelsList.length };
}

/**
 * Automatic Initialization of Autostart tunnels
 */
function initAutoStartTunnels() {
    console.log('[CLOUDFLARED] Inicializando Watchdog e carregando túneis autostart...');
    const tunnels = getTunnels();
    tunnels.forEach(t => {
        if (t.autoStart) {
            try {
                console.log(`[CLOUDFLARED] Inicializando túnel automático: ${t.name}`);
                startTunnel(t.id);
            } catch (err) {
                console.error(`[CLOUDFLARED] Falha ao iniciar túnel de autostart (${t.name}):`, err.message);
            }
        }
    });
}

async function getLoginUrl() {
    try {
        const tmpLog = path.join(CONFIGS_DIR, 'login.log');
        // Ensure folder exists
        fs.mkdirSync(path.dirname(tmpLog), { recursive: true });
        if (fs.existsSync(tmpLog)) fs.unlinkSync(tmpLog);

        const { exec } = require('child_process');
        exec(`cloudflared tunnel login > "${tmpLog}" 2>&1`);

        // Poll logs every 500ms for up to 15 seconds for the login URL
        for (let i = 0; i < 30; i++) {
            await new Promise(r => setTimeout(r, 500));
            if (fs.existsSync(tmpLog)) {
                const logs = fs.readFileSync(tmpLog, 'utf8');
                const match = logs.match(/https:\/\/(?:[a-zA-Z0-9-]+\.)*cloudflare\.com\/[^\s"]+/);
                if (match) return { url: match[0].trim() };
            }
        }
        return { error: 'Timeout ao aguardar URL de autorização (15s). Certifique-se que o cloudflared está instalado e há conexão ativa.' };
    } catch (err) {
        return { error: err.message };
    }
}

// Delay startup slightly to let the Express server warm up
setTimeout(initAutoStartTunnels, 3000);

module.exports = {
    getTunnels,
    createTunnel,
    updateTunnel,
    deleteTunnel,
    startTunnel,
    stopTunnel,
    listTunnels,
    getLoginUrl,
    isClassicAuthenticated,
    clearCertificate,
    resetManager,
    importConfigurations,
    validateYamlConfig,
    generateYamlConfig
};
