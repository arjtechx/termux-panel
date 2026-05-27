const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { spawn } = require('child_process');
const processManager = require('./process');

const PANEL_DIR = path.resolve(__dirname, '..', '..');
const DB_FILE = path.join(PANEL_DIR, 'data', 'cloudflared-instances.json');
const CONFIGS_DIR = path.join(PANEL_DIR, 'config', 'cloudflared');
const HOME_DIR = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';

if (!fs.existsSync(CONFIGS_DIR)) fs.mkdirSync(CONFIGS_DIR, { recursive: true });



const db = require('../../src/utils/db');

async function getInstances() {
    try {
        const rows = await db.query('SELECT * FROM cloudflared_instances');
        return rows.map(r => {
            const data = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || {});
            return {
                ...data,
                id: r.id,
                name: r.name,
                token: r.token,
                protected: data.protected === true || data.protected === 'true' || data.protected === 1,
                routes: normalizeRoutes(data.routes || [])
            };
        });
    } catch (e) {
        console.error('[CLOUDFLARED] Erro ao buscar instâncias:', e.message);
        return [];
    }
}

async function saveInstances(instances) {
    try {
        const ids = instances.map(i => i.id).filter(Boolean);
        if (ids.length > 0) {
            await db.query('DELETE FROM cloudflared_instances WHERE id NOT IN (' + ids.map(() => '?').join(',') + ')', ids);
        } else {
            await db.query('DELETE FROM cloudflared_instances');
        }
        for (const inst of instances) {
            await db.query(
                'INSERT INTO cloudflared_instances (id, name, token, `data`) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), token = VALUES(token), `data` = VALUES(`data`)',
                [inst.id, inst.name, inst.token || '', JSON.stringify(inst)]
            );
        }
    } catch (e) {
        console.error('[CLOUDFLARED] Erro ao salvar instâncias:', e.message);
    }
} 

function normalizeRouteType(routeType, protocol) {
    const explicit = (routeType || '').toLowerCase();
    if (['http', 'https', 'tcp', 'ssh', 'rdp', 'unix'].includes(explicit)) return explicit;
    if (explicit === 'tcp_ssh') return 'tcp';
    if (explicit === 'http_path' || explicit === 'http_hostname') return (protocol || 'http').toLowerCase();
    const p = (protocol || 'http').toLowerCase();
    if (p === 'tcp' || p === 'ssh' || p === 'rdp' || p === 'unix') return p;
    if (p === 'https') return 'https';
    return 'http';
}

function buildServiceFromRoute(route) {
    const protocol = (route.targetProtocol || 'http').toLowerCase();
    const host = (route.targetHost || '127.0.0.1').trim() || '127.0.0.1';
    const port = parseInt(route.targetPort, 10) || 80;

    if (protocol === 'unix') {
        const socketPath = host.startsWith('/') ? host : `/${host}`;
        return `unix:${socketPath}`;
    }

    return `${protocol}://${host}:${port}`;
}

function parseServiceToRouteParts(service) {
    if (!service || typeof service !== 'string') return null;
    if (service.startsWith('unix:')) {
        return { targetProtocol: 'unix', targetHost: service.replace(/^unix:/, ''), targetPort: 1 };
    }
    const m = service.match(/^([a-z0-9+.-]+):\/\/([^:/]+)(?::(\d+))?/i);
    if (!m) return null;
    return {
        targetProtocol: (m[1] || 'http').toLowerCase(),
        targetHost: m[2] || '127.0.0.1',
        targetPort: parseInt(m[3], 10) || 80
    };
}

function normalizeRoute(route) {
    const legacyFromService = parseServiceToRouteParts(route.service);
    const protocol = (route.targetProtocol || (legacyFromService && legacyFromService.targetProtocol) || 'http').toLowerCase();
    const normalized = {
        name: route.name || '',
        hostname: route.hostname || '',
        path: route.path || '/',
        targetProtocol: protocol,
        targetHost: ((route.targetHost || (legacyFromService && legacyFromService.targetHost) || '127.0.0.1') + '').trim() || '127.0.0.1',
        targetPort: parseInt(route.targetPort, 10) || (legacyFromService && legacyFromService.targetPort) || 80,
        routeType: normalizeRouteType(route.routeType, protocol),
        service: ''
    };
    normalized.service = buildServiceFromRoute(normalized);
    return normalized;
}

function normalizeRoutes(routes) {
    if (!Array.isArray(routes)) return [];
    return routes.map(r => normalizeRoute(r || {}));
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
            const aHttp = a.routeType === 'http' || a.routeType === 'https';
            const bHttp = b.routeType === 'http' || b.routeType === 'https';
            if (aHttp !== bHttp) {
                return aHttp ? -1 : 1;
            }
            const aLen = a.path ? a.path.length : 0;
            const bLen = b.path ? b.path.length : 0;
            return bLen - aLen;
        });

        sortedRoutes.forEach(rule => {
            const route = normalizeRoute(rule);
            if (route.hostname) yaml += `  - hostname: "${route.hostname}"\n`;
            if ((route.routeType === 'http' || route.routeType === 'https') && route.path && route.path !== '/') {
                yaml += `    path: "${route.path}"\n`;
            }
            yaml += `    service: "${route.service}"\n`;
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
    
    const configName = tempNext ? `${instance.id}.yml.next.yml` : `${instance.id}.yml`;
    const configPath = path.join(HOME_DIR, '.cloudflared', configName);
    
    if (!fs.existsSync(path.dirname(configPath))) {
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
    }
    
    fs.writeFileSync(configPath, yaml, 'utf8');
    return configPath;
}

async function createInstance(data) {
    const instances = (await getInstances());
    
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
        routes: normalizeRoutes(data.routes || [])
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
    await saveInstances(instances);
    return newInstance;
}

async function updateInstance(id, data) {
    const instances = (await getInstances());
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
    if (data.routes !== undefined) inst.routes = normalizeRoutes(data.routes);

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
    await saveInstances(instances);
    return inst;
}

async function deleteInstance(id) {
    let instances = (await getInstances());
    const inst = instances.find(i => i.id === id);
    if (!inst) throw new Error('Instância não encontrada.');
    if (inst.protected) throw new Error('Esta instância está protegida e não pode ser excluída.');

    processManager.stopInstance(id);

    if (fs.existsSync(inst.configPath)) fs.unlinkSync(inst.configPath);
    // Não apagamos o credentialsFile para segurança, o usuário pode ter outros usos

    instances = instances.filter(i => i.id !== id);
    await saveInstances(instances);
    return { success: true };
}

async function initAutoStart() {
    console.log('[CLOUDFLARED] Iniciando túneis salvos...');
    const instances = (await getInstances());
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

function getCloudflaredHomeDir() {
    return path.join(HOME_DIR, '.cloudflared');
}

function getCertPemPath() {
    return path.join(getCloudflaredHomeDir(), 'cert.pem');
}

function getLoginStatus() {
    const certPath = getCertPemPath();
    return {
        certPath,
        loggedIn: fs.existsSync(certPath)
    };
}

function removeLoginConfig() {
    const certPath = getCertPemPath();
    const existed = fs.existsSync(certPath);
    if (existed) fs.unlinkSync(certPath);
    return {
        success: true,
        removed: existed,
        certPath
    };
}

function extractCloudflareAuthUrl(text) {
    if (!text) return '';
    const match = text.match(/https:\/\/[^\s"]+/i);
    return match ? match[0] : '';
}

function startCloudflareLogin() {
    return new Promise((resolve) => {
        const binary = processManager.getCloudflaredBinaryPath();
        const child = spawn(binary, ['tunnel', 'login'], { env: process.env });
        let out = '';
        let settled = false;

        const finish = (payload) => {
            if (settled) return;
            settled = true;
            resolve(payload);
        };

        const onChunk = (buf) => {
            out += String(buf || '');
            const authUrl = extractCloudflareAuthUrl(out);
            if (authUrl) {
                try { child.kill('SIGTERM'); } catch (_) {}
                finish({
                    success: true,
                    authUrl,
                    message: 'URL de autenticacao gerada. Complete o login no navegador.'
                });
            }
        };

        child.stdout.on('data', onChunk);
        child.stderr.on('data', onChunk);
        child.on('error', (err) => finish({ success: false, error: err.message }));
        child.on('close', () => {
            const authUrl = extractCloudflareAuthUrl(out);
            if (authUrl) {
                return finish({
                    success: true,
                    authUrl,
                    message: 'URL de autenticacao gerada. Complete o login no navegador.'
                });
            }
            const status = getLoginStatus();
            finish({
                success: status.loggedIn,
                authUrl: '',
                message: status.loggedIn
                    ? 'cert.pem detectado. Login Cloudflare parece concluido.'
                    : 'Nao foi possivel capturar a URL de login. Verifique se cloudflared esta instalado.',
                output: out.slice(-2000)
            });
        });

        setTimeout(() => {
            if (settled) return;
            try { child.kill('SIGTERM'); } catch (_) {}
        }, 12000);
    });
}


async function migrateLegacyRoutes() {
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

    const instances = (await getInstances());
    const jaMigrado = instances.some(i => i.name === 'Túneis Legados (Migração)');
    if (jaMigrado) {
        return { success: true, message: 'Já migrado anteriormente.' };
    }

    const newRoutes = normalizeRoutes(oldRoutes.map(r => ({
        hostname: r.hostname || '',
        path: r.path || '',
        targetProtocol: r.targetProtocol || 'http',
        targetHost: r.targetHost || '127.0.0.1',
        targetPort: r.targetPort || 80,
        routeType: 'http'
    })));

    
    let extractedTunnelId = '';
    let extractedCreds = '';
    const defaultConfig = path.join(HOME_DIR, '.cloudflared', 'config.yml');
    
    if (fs.existsSync(defaultConfig)) {
        try {
            const lines = fs.readFileSync(defaultConfig, 'utf8').split('\n');
            for (const line of lines) {
                if (line.trim().startsWith('tunnel:')) {
                    extractedTunnelId = line.split(':')[1].trim().replace(/['"]/g, '');
                }
                if (line.trim().startsWith('credentials-file:')) {
                    extractedCreds = line.split(':')[1].trim().replace(/['"]/g, '');
                }
            }
        } catch(e) {}
    }

    const novaInstancia = {
        id: 'inst-' + crypto.randomBytes(4).toString('hex'),
        name: 'Túneis Legados (Migração)',
        type: 'service',
        protected: false,
        autoRestartOnSave: true,
        tunnelId: extractedTunnelId,
        credentialsFile: extractedCreds,
        hostname: oldRoutes[0]?.hostname || '',
        routes: newRoutes,
        yamlConfig: null,
        yamlMode: 'auto'
    };
    
    novaInstancia.configPath = path.join(HOME_DIR, '.cloudflared', novaInstancia.id + '.yml');
    generateYamlForInstance(novaInstancia);


    instances.push(novaInstancia);
    await saveInstances(instances);
    return { success: true, message: 'Rotas antigas resgatadas com sucesso!' };
}

module.exports = {
    migrateLegacyRoutes,
    getInstances,
    saveInstances,
    createInstance,
    updateInstance,
    deleteInstance,
    generateYamlForInstance,
    getLoginStatus,
    removeLoginConfig,
    startCloudflareLogin
};
