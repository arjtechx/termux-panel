const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const processManager = require('./process');

const PANEL_DIR = path.resolve(__dirname, '..', '..');
const DB_FILE = path.join(PANEL_DIR, 'data', 'cloudflared-instances.json');
const CONFIGS_DIR = path.join(PANEL_DIR, 'config', 'cloudflared');
const HOME_DIR = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';

if (!fs.existsSync(CONFIGS_DIR)) fs.mkdirSync(CONFIGS_DIR, { recursive: true });
if (!fs.existsSync(path.dirname(DB_FILE))) fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify([]));

function getInstances() {
    try {
        const instances = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        // Garantir instâncias padrão caso vazio (apenas para fallback, se necessário)
        return Array.isArray(instances) ? instances : [];
    } catch {
        return [];
    }
}

function saveInstances(instances) {
    fs.writeFileSync(DB_FILE, JSON.stringify(instances, null, 2));
}

function generateYamlForInstance(instance, tempNext = false) {
    let yaml = `# Configuração automática gerada pelo Termux Panel - Instância: ${instance.name}\n`;
    
    if (instance.tunnelId) {
        yaml += `tunnel: "${instance.tunnelId}"\n`;
    }
    
    if (instance.credentialsFile) {
        yaml += `credentials-file: "${instance.credentialsFile}"\n`;
    }
    
    yaml += `\n`;
    // Opções recomendadas
    yaml += `protocol: quic\n`; // quic is often better
    yaml += `\ningress:\n`;
    
    if (instance.routes && Array.isArray(instance.routes) && instance.routes.length > 0) {
        // Ordenar rotas: caminhos mais específicos primeiro, catch-all por último
        const sortedRoutes = [...instance.routes].sort((a, b) => {
            const aLen = a.path ? a.path.length : 0;
            const bLen = b.path ? b.path.length : 0;
            return bLen - aLen;
        });

        sortedRoutes.forEach(rule => {
            if (rule.hostname) yaml += `  - hostname: "${rule.hostname}"\n`;
            if (rule.path && rule.path !== '/') yaml += `    path: "${rule.path}"\n`;
            yaml += `    service: "${rule.service}"\n`;
        });
    } else {
        // Rota padrão caso o usuário esqueça, mas para evitar erro do cloudflared
        if (instance.hostname) {
            yaml += `  - hostname: "${instance.hostname}"\n`;
            yaml += `    service: "http://127.0.0.1:80"\n`;
        }
    }
    
    // Catch-all obrigatorio
    yaml += `  - service: http_status:404\n`;
    
    const configName = tempNext ? `${instance.id}.next.yml` : `${instance.id}.yml`;
    const configPath = path.join(HOME_DIR, '.cloudflared', configName);
    
    if (!fs.existsSync(path.dirname(configPath))) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
    }
    
    fs.writeFileSync(configPath, yaml, 'utf8');
    return configPath;
}

function createInstance(data) {
    const instances = getInstances();
    
    const id = data.id || `inst-${Date.now()}`;
    const newInstance = {
        id,
        name: data.name || 'Nova Instância',
        type: data.type || 'service', // core | service | group
        protected: !!data.protected,
        autoRestartOnSave: data.autoRestartOnSave !== undefined ? data.autoRestartOnSave : true,
        hostname: data.hostname || '',
        configPath: path.join(HOME_DIR, '.cloudflared', `${id}.yml`),
        credentialsFile: data.credentialsFile || '',
        tunnelId: data.tunnelId || '',
        routes: data.routes || []
    };

    // Auto-create tunnel if requested, but generally user provides JSON/token
    if (data.createCloudflareTunnel && newInstance.name) {
        try {
            const binary = processManager.getCloudflaredBinaryPath();
            const slug = newInstance.name.toLowerCase().replace(/[^a-z0-9-]/g, '-');
            const stdout = execSync(`"${binary}" tunnel create "${slug}"`, { encoding: 'utf8', env: process.env });
            const uuidMatch = stdout.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
            if (uuidMatch) {
                newInstance.tunnelId = uuidMatch[0];
                newInstance.credentialsFile = path.join(HOME_DIR, '.cloudflared', `${newInstance.tunnelId}.json`);
            }
        } catch (e) {
            console.warn("Aviso ao criar tunnel via CLI:", e.message);
        }
    }

    generateYamlForInstance(newInstance);
    instances.push(newInstance);
    saveInstances(instances);
    return newInstance;
}

function updateInstance(id, data) {
    const instances = getInstances();
    const idx = instances.findIndex(i => i.id === id);
    if (idx === -1) throw new Error('Instância não encontrada.');

    const inst = instances[idx];

    // Se for 'core' e protegido, pode bloquear certas edições destrutivas se necessário, mas o painel permite editar
    if (data.name !== undefined) inst.name = data.name;
    if (data.type !== undefined) inst.type = data.type;
    if (data.protected !== undefined) inst.protected = !!data.protected;
    if (data.autoRestartOnSave !== undefined) inst.autoRestartOnSave = !!data.autoRestartOnSave;
    if (data.hostname !== undefined) inst.hostname = data.hostname;
    if (data.credentialsFile !== undefined) inst.credentialsFile = data.credentialsFile;
    if (data.tunnelId !== undefined) inst.tunnelId = data.tunnelId;
    if (data.routes !== undefined) inst.routes = data.routes;

    generateYamlForInstance(inst); // Regenerate yaml
    
    // Roteamento DNS automático para novas rotas
    if (inst.tunnelId) {
        const binary = processManager.getCloudflaredBinaryPath();
        if (inst.routes && Array.isArray(inst.routes)) {
            inst.routes.forEach(route => {
                if (route.hostname) {
                    try {
                        execSync(`"${binary}" tunnel route dns "${inst.tunnelId}" "${route.hostname}"`, { stdio: 'ignore' });
                    } catch (e) {}
                }
            });
        }
    }

    instances[idx] = inst;
    saveInstances(instances);
    return inst;
}

function deleteInstance(id) {
    let instances = getInstances();
    const inst = instances.find(i => i.id === id);
    if (!inst) throw new Error('Instância não encontrada.');
    if (inst.protected) throw new Error('Esta instância está protegida e não pode ser excluída.');

    processManager.stopInstance(id);

    if (fs.existsSync(inst.configPath)) fs.unlinkSync(inst.configPath);
    // Não apagamos o credentialsFile para segurança, o usuário pode ter outros usos

    instances = instances.filter(i => i.id !== id);
    saveInstances(instances);
    return { success: true };
}

function initAutoStart() {
    console.log('[CLOUDFLARED] Iniciando túneis salvos...');
    const instances = getInstances();
    instances.forEach(inst => {
        // Como o design quer que os túneis subam no autoStart
        try {
            processManager.startInstance(inst);
        } catch (e) {
            console.error(`Erro ao iniciar instância ${inst.name}:`, e.message);
        }
    });
}

setTimeout(initAutoStart, 3000);


function migrateLegacyRoutes() {
    const oldRoutesFile = path.join(PANEL_DIR, 'data', 'cloudflared-routes.json');
    if (!fs.existsSync(oldRoutesFile)) {
        return { success: false, error: 'Arquivo antigo (cloudflared-routes.json) não encontrado.' };
    }

    let oldRoutes = [];
    try {
        oldRoutes = JSON.parse(fs.readFileSync(oldRoutesFile, 'utf8'));
        if (!Array.isArray(oldRoutes)) oldRoutes = [];
    } catch (e) {
        return { success: false, error: 'Erro ao ler arquivo antigo: ' + e.message };
    }

    if (oldRoutes.length === 0) {
        return { success: false, error: 'Nenhuma rota no arquivo antigo.' };
    }

    const instances = getInstances();
    const jaMigrado = instances.some(i => i.name === 'Túneis Legados (Migração)');
    if (jaMigrado) {
        return { success: true, message: 'Já migrado anteriormente.' };
    }

    const newRoutes = oldRoutes.map(r => ({
        hostname: r.hostname || '',
        path: r.path || '',
        service: `${r.targetProtocol || 'http'}://${r.targetHost || '127.0.0.1'}:${r.targetPort || 80}`
    }));

    const novaInstancia = {
        id: 'inst-' + crypto.randomBytes(4).toString('hex'),
        name: 'Túneis Legados (Migração)',
        type: 'service',
        protected: false,
        autoRestartOnSave: true,
        tunnelId: '',
        credentialsFile: '',
        hostname: oldRoutes[0]?.hostname || '',
        routes: newRoutes,
        yamlConfig: null,
        yamlMode: 'auto'
    };

    instances.push(novaInstancia);
    saveInstances(instances);
    return { success: true, message: 'Rotas antigas resgatadas com sucesso!' };
}

module.exports = {
    migrateLegacyRoutes,
    getInstances,
    saveInstances,
    createInstance,
    updateInstance,
    deleteInstance,
    generateYamlForInstance
};
