const express = require('express');
const manager = require('./manager');
const processManager = require('./process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, exec } = require('child_process');

const PANEL_DIR = path.resolve(__dirname, '..', '..');
const ROUTES_JSON_FILE = path.join(PANEL_DIR, 'data', 'cloudflared-routes.json');

function readRoutesJson() {
    try {
        if (!fs.existsSync(ROUTES_JSON_FILE)) {
            fs.mkdirSync(path.dirname(ROUTES_JSON_FILE), { recursive: true });
            const defaultRoutes = [
                {
                    id: "pma",
                    name: "phpMyAdmin",
                    enabled: true,
                    hostname: "panel.arjtechbr.site",
                    path: "/phpmyadmin/",
                    targetProtocol: "http",
                    targetHost: "127.0.0.1",
                    targetPort: 8080,
                    order: 1
                },
                {
                    id: "panel-main",
                    name: "Painel Principal",
                    enabled: true,
                    hostname: "panel.arjtechbr.site",
                    path: "/",
                    targetProtocol: "http",
                    targetHost: "127.0.0.1",
                    targetPort: 8088,
                    order: 99
                }
            ];
            fs.writeFileSync(ROUTES_JSON_FILE, JSON.stringify(defaultRoutes, null, 2), 'utf8');
            return defaultRoutes;
        }
        return JSON.parse(fs.readFileSync(ROUTES_JSON_FILE, 'utf8'));
    } catch (e) {
        console.error('Erro ao ler routes json:', e.message);
        return [];
    }
}

function writeRoutesJson(routes) {
    try {
        fs.mkdirSync(path.dirname(ROUTES_JSON_FILE), { recursive: true });
        fs.writeFileSync(ROUTES_JSON_FILE, JSON.stringify(routes, null, 2), 'utf8');
        return true;
    } catch (e) {
        console.error('Erro ao salvar routes json:', e.message);
        return false;
    }
}

function getTunnelMetadata() {
    const homeDir = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';
    const configYmlPath = path.join(homeDir, '.cloudflared', 'config.yml');
    let tunnelId = 'SEU_TUNNEL_ID';
    let credentialsFile = path.join(homeDir, '.cloudflared', 'SEU_TUNNEL_ID.json');

    if (fs.existsSync(configYmlPath)) {
        try {
            const content = fs.readFileSync(configYmlPath, 'utf8');
            const tunnelMatch = content.match(/^tunnel:\s*["']?([a-zA-Z0-9-]+)["']?/m);
            const credsMatch = content.match(/^credentials-file:\s*["']?([^\n"']+)["']?/m);
            if (tunnelMatch) tunnelId = tunnelMatch[1].trim();
            if (credsMatch) credentialsFile = credsMatch[1].trim();
        } catch (e) {
            console.error('Erro ao ler metadados do config.yml:', e.message);
        }
    } else {
        const cfDir = path.join(homeDir, '.cloudflared');
        if (fs.existsSync(cfDir)) {
            try {
                const files = fs.readdirSync(cfDir);
                const jsonFile = files.find(f => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/i.test(f));
                if (jsonFile) {
                    tunnelId = jsonFile.replace('.json', '');
                    credentialsFile = path.join(cfDir, jsonFile);
                }
            } catch (e) {}
        }
    }
    return { tunnelId, credentialsFile };
}

function makeBackup(configYmlPath) {
    if (fs.existsSync(configYmlPath)) {
        try {
            const dateStr = new Date().toISOString()
                .replace(/[-T:]/g, '')
                .slice(0, 14);
            const backupPath = `${configYmlPath}.backup-${dateStr.slice(0, 8)}-${dateStr.slice(8)}`;
            fs.copyFileSync(configYmlPath, backupPath);
            return backupPath;
        } catch (e) {
            console.error('Erro ao criar backup do config.yml:', e.message);
        }
    }
    return null;
}

function generateConfigYmlFromRoutes() {
    const homeDir = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';
    const configYmlPath = path.join(homeDir, '.cloudflared', 'config.yml');

    const meta = getTunnelMetadata();
    const routes = readRoutesJson();

    const activeRoutes = routes.filter(r => r.enabled);

    activeRoutes.sort((a, b) => {
        const aHasPath = a.path && a.path !== '/';
        const bHasPath = b.path && b.path !== '/';
        
        if (aHasPath && !bHasPath) return -1;
        if (!aHasPath && bHasPath) return 1;
        
        return (a.order || 0) - (b.order || 0);
    });

    let yaml = `tunnel: ${meta.tunnelId}\n`;
    yaml += `credentials-file: ${meta.credentialsFile}\n\n`;
    yaml += `ingress:\n`;

    activeRoutes.forEach(r => {
        const proto = r.targetProtocol || 'http';
        const host = r.targetHost || '127.0.0.1';
        const port = r.targetPort || 80;
        const targetUrl = `${proto}://${host}:${port}`;
        
        yaml += `  - hostname: ${r.hostname}\n`;
        if (r.path && r.path !== '/') {
            let cleanPath = r.path;
            if (cleanPath.endsWith('/')) {
                cleanPath = cleanPath.slice(0, -1);
            }
            yaml += `    path: ${cleanPath}.*\n`;
        }
        yaml += `    service: ${targetUrl}\n`;
    });

    yaml += `  - service: http_status:404\n`;

    makeBackup(configYmlPath);

    fs.mkdirSync(path.dirname(configYmlPath), { recursive: true });
    fs.writeFileSync(configYmlPath, yaml, 'utf8');

    return { success: true, path: configYmlPath, content: yaml };
}

async function testUrl(targetUrl) {
    const startTime = Date.now();
    return new Promise((resolve) => {
        const cmd = `curl -I -s -w "%{http_code} %{time_total} %{redirect_url}" --max-time 4 "${targetUrl}"`;
        exec(cmd, (error, stdout, stderr) => {
            const duration = Date.now() - startTime;
            if (error) {
                resolve({
                    success: false,
                    status: 'Offline',
                    code: 0,
                    error: error.message || 'Erro de conexão',
                    time: `${duration}ms`
                });
                return;
            }

            const output = stdout.trim().split('\n');
            const lastLine = output[output.length - 1];
            const parts = lastLine.split(' ');
            const code = parseInt(parts[0]) || 0;
            const timeTotal = parseFloat(parts[1]) || 0;
            const redirectUrl = parts[2] || '';

            if (code === 0) {
                resolve({
                    success: false,
                    status: 'Offline',
                    code,
                    error: 'Sem resposta ou porta fechada',
                    time: `${(timeTotal * 1000).toFixed(0)}ms`
                });
            } else {
                resolve({
                    success: true,
                    status: 'Online',
                    code,
                    redirectUrl,
                    time: `${(timeTotal * 1000).toFixed(0)}ms`
                });
            }
        });
    });
}

module.exports = function createCloudflaredRoutes() {
    const router = Router = express.Router();

    // List Tunnels
    router.get('/tunnels', async (req, res) => {
        try {
            const list = await manager.listTunnels();
            res.json({ success: true, tunnels: list });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Create Tunnel
    router.post('/tunnel/create', (req, res) => {
        try {
            const tunnel = manager.createTunnel(req.body);
            res.json({ success: true, tunnel });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Update Tunnel
    router.post('/tunnel/update', (req, res) => {
        try {
            const tunnel = manager.updateTunnel(req.body.id, req.body);
            res.json({ success: true, tunnel });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Delete Tunnel
    router.post('/tunnel/delete', (req, res) => {
        try {
            const result = manager.deleteTunnel(req.body.id);
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Start Tunnel
    router.post('/tunnel/start', (req, res) => {
        try {
            const result = manager.startTunnel(req.body.id);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Stop Tunnel
    router.post('/tunnel/stop', (req, res) => {
        try {
            const result = manager.stopTunnel(req.body.id);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Restart Tunnel (stop → wait 1.5s → start)
    router.post('/tunnel/restart', async (req, res) => {
        try {
            manager.stopTunnel(req.body.id);
            await new Promise(r => setTimeout(r, 1500));
            const result = manager.startTunnel(req.body.id);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Fetch Logs
    router.get('/tunnel/logs', (req, res) => {
        try {
            const id = req.query.id;
            const lines = parseInt(req.query.lines) || 100;
            if (!id) return res.status(400).json({ error: 'Falta o ID do túnel.' });
            const logs = processManager.readLogs(id, lines);
            res.json({ success: true, logs });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Export Tunnels Configuration
    router.get('/config/export', (req, res) => {
        try {
            const tunnels = manager.getTunnels();
            res.setHeader('Content-disposition', 'attachment; filename=cloudflared_tunnels_backup.json');
            res.setHeader('Content-type', 'application/json');
            res.write(JSON.stringify(tunnels, null, 2));
            res.end();
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Import Tunnels Configuration
    router.post('/config/import', (req, res) => {
        try {
            const result = manager.importConfigurations(req.body.tunnels);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Validate YAML
    router.post('/config/validate-yaml', (req, res) => {
        try {
            const check = manager.validateYamlConfig(req.body.yamlConfig);
            res.json(check);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Generate Default YAML
    router.post('/config/generate-yaml', (req, res) => {
        try {
            const yaml = manager.generateYamlConfig(req.body);
            res.json({ success: true, yamlConfig: yaml });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Auth Status
    router.get('/auth/status', (req, res) => {
        res.json({ success: true, authenticated: manager.isClassicAuthenticated() });
    });

    // Auth Logout
    router.post('/auth/logout', (req, res) => {
        try {
            manager.clearCertificate();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Auth Login
    router.post('/auth/login', async (req, res) => {
        try {
            const result = await manager.getLoginUrl();
            if (result && result.url) {
                res.json({ success: true, url: result.url });
            } else {
                res.status(400).json({ success: false, error: 'Falha: ' + (result?.error || 'Desconhecida.') });
            }
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Zombie Killer
    router.post('/system/kill-zombies', (req, res) => {
        res.json(processManager.killAllZombies());
    });

    // Reset Manager / Clear all configs and certificate
    router.post('/system/reset', async (req, res) => {
        try {
            const result = await manager.resetManager();
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // ==========================================
    // PATH-BASED ROUTING & REVERSE PROXY
    // ==========================================

    router.get('/cloudflared/routes', (req, res) => {
        try {
            const routes = readRoutesJson();
            res.json({ success: true, routes });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/cloudflared/routes', (req, res) => {
        try {
            const routes = readRoutesJson();
            const newPath = req.body.path || '/';
            const newHostname = req.body.hostname || 'panel.arjtechbr.site';

            if (newPath === '/') {
                const dup = routes.find(r => r.hostname === newHostname && r.path === '/');
                if (dup) {
                    return res.status(400).json({ success: false, error: `Já existe uma regra catch-all (/) para o domínio ${newHostname}. Remova ou desative a existente primeiro.` });
                }
            }

            const newRoute = {
                id: Date.now().toString(),
                name: req.body.name || 'Novo Serviço',
                enabled: req.body.enabled !== false,
                hostname: newHostname,
                path: newPath,
                targetProtocol: req.body.targetProtocol || 'http',
                targetHost: req.body.targetHost || '127.0.0.1',
                targetPort: parseInt(req.body.targetPort) || 80,
                order: parseInt(req.body.order) || 99
            };
            routes.push(newRoute);
            writeRoutesJson(routes);
            res.json({ success: true, route: newRoute });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.put('/cloudflared/routes/:id', (req, res) => {
        try {
            const routes = readRoutesJson();
            const idx = routes.findIndex(r => r.id === req.params.id);
            if (idx === -1) return res.status(404).json({ success: false, error: 'Rota não encontrada' });
            
            const newHostname = req.body.hostname !== undefined ? req.body.hostname : routes[idx].hostname;
            const newPath = req.body.path !== undefined ? req.body.path : routes[idx].path;

            if (newPath === '/') {
                const dup = routes.find(r => r.id !== req.params.id && r.hostname === newHostname && r.path === '/');
                if (dup) {
                    return res.status(400).json({ success: false, error: `Já existe uma regra catch-all (/) para o domínio ${newHostname}.` });
                }
            }

            routes[idx] = {
                ...routes[idx],
                name: req.body.name !== undefined ? req.body.name : routes[idx].name,
                enabled: req.body.enabled !== undefined ? !!req.body.enabled : routes[idx].enabled,
                hostname: newHostname,
                path: newPath,
                targetProtocol: req.body.targetProtocol !== undefined ? req.body.targetProtocol : routes[idx].targetProtocol,
                targetHost: req.body.targetHost !== undefined ? req.body.targetHost : routes[idx].targetHost,
                targetPort: req.body.targetPort !== undefined ? parseInt(req.body.targetPort) : routes[idx].targetPort,
                order: req.body.order !== undefined ? parseInt(req.body.order) : routes[idx].order
            };
            writeRoutesJson(routes);
            res.json({ success: true, route: routes[idx] });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.delete('/cloudflared/routes/:id', (req, res) => {
        try {
            let routes = readRoutesJson();
            routes = routes.filter(r => r.id !== req.params.id);
            writeRoutesJson(routes);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/cloudflared/routes/reorder', (req, res) => {
        try {
            const { ids } = req.body;
            if (!Array.isArray(ids)) return res.status(400).json({ success: false, error: 'Falta array de IDs' });
            
            const routes = readRoutesJson();
            const reordered = [];
            
            ids.forEach((id, index) => {
                const route = routes.find(r => r.id === id);
                if (route) {
                    route.order = index + 1;
                    reordered.push(route);
                }
            });
            
            routes.forEach(r => {
                if (!ids.includes(r.id)) {
                    reordered.push(r);
                }
            });
            
            writeRoutesJson(reordered);
            res.json({ success: true, routes: reordered });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/cloudflared/process/status', (req, res) => {
        try {
            const { execSync } = require('child_process');
            let isRunning = false;
            try {
                const pids = execSync('pgrep -f cloudflared', { encoding: 'utf8' }).trim();
                isRunning = pids.length > 0;
            } catch (e) {
                isRunning = false;
            }
            res.json({ success: true, isRunning });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/cloudflared/process/start', (req, res) => {
        try {
            const { tunnelId } = getTunnelMetadata();
            if (!tunnelId || tunnelId === 'SEU_TUNNEL_ID_OU_NOME') {
                return res.status(400).json({ success: false, error: 'Tunnel ID não encontrado. Crie um túnel ou edite o config.yml.' });
            }
            const { spawn } = require('child_process');
            const homeDir = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';
            const logPath = path.join(homeDir, '.cloudflared', 'proxy_reverso.log');
            const out = fs.openSync(logPath, 'a');
            
            const child = spawn('cloudflared', ['tunnel', 'run', tunnelId], {
                detached: true,
                stdio: ['ignore', out, out]
            });
            child.unref();

            res.json({ success: true, message: 'Comando de iniciar túnel enviado.' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/cloudflared/process/stop', (req, res) => {
        try {
            const { execSync } = require('child_process');
            try { execSync('pkill -f cloudflared'); } catch (e) {}
            try { execSync('killall -9 cloudflared'); } catch (e) {}
            res.json({ success: true, message: 'Processo parado.' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/cloudflared/generate-config', (req, res) => {
        try {
            const result = generateConfigYmlFromRoutes();
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/cloudflared/config', (req, res) => {
        try {
            const homeDir = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';
            const configYmlPath = path.join(homeDir, '.cloudflared', 'config.yml');
            
            let configText = '';
            if (fs.existsSync(configYmlPath)) {
                configText = fs.readFileSync(configYmlPath, 'utf8');
            }
            
            let backups = [];
            const cfDir = path.join(homeDir, '.cloudflared');
            if (fs.existsSync(cfDir)) {
                const files = fs.readdirSync(cfDir);
                backups = files.filter(f => f.startsWith('config.yml.backup-'))
                    .map(name => ({
                        name,
                        path: path.join(cfDir, name),
                        date: name.split('backup-')[1]
                    }))
                    .sort((a, b) => b.name.localeCompare(a.name));
            }
            
            res.json({ success: true, config: configText, backups });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/cloudflared/config', (req, res) => {
        try {
            const { configText } = req.body;
            if (!configText) return res.status(400).json({ success: false, error: 'Configuração vazia não permitida.' });
            
            const homeDir = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';
            const configYmlPath = path.join(homeDir, '.cloudflared', 'config.yml');
            
            if (/\t/.test(configText)) {
                return res.status(400).json({ success: false, error: 'O arquivo YAML não pode conter caracteres de tabulação (Tab). Use apenas espaços.' });
            }
            
            const hasIngress = /ingress\s*:/i.test(configText);
            const hasDefault404 = /service:\s*http_status:404/i.test(configText);
            
            if (!hasIngress) {
                return res.status(400).json({ success: false, error: 'A diretiva "ingress:" é obrigatória para definir as rotas locais.' });
            }
            
            makeBackup(configYmlPath);
            
            fs.mkdirSync(path.dirname(configYmlPath), { recursive: true });
            fs.writeFileSync(configYmlPath, configText, 'utf8');
            
            res.json({ 
                success: true, 
                warning: !hasDefault404 ? 'Aviso: Regra de encerramento final "- service: http_status:404" não detectada. Isso pode invalidar o ingress do cloudflared.' : null 
            });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/cloudflared/validate', (req, res) => {
        try {
            const stdout = execSync('cloudflared tunnel ingress validate', { 
                encoding: 'utf8', 
                stdio: ['ignore', 'pipe', 'pipe'] 
            });
            res.json({ success: true, output: stdout });
        } catch (err) {
            res.json({ success: false, error: err.message, output: err.stdout || err.stderr });
        }
    });

    router.post('/cloudflared/restart', async (req, res) => {
        try {
            processManager.killAllZombies();
            await new Promise(r => setTimeout(r, 1500));
            const tunnels = manager.getTunnels();
            tunnels.forEach(t => {
                if (t.autoStart) {
                    try {
                        manager.startTunnel(t.id);
                    } catch (e) {}
                }
            });
            res.json({ success: true, message: 'Processos de túneis reiniciados com sucesso!' });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/cloudflared/logs', (req, res) => {
        try {
            const homeDir = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';
            const logPath = path.join(homeDir, '.cloudflared', 'proxy_reverso.log');
            
            if (fs.existsSync(logPath)) {
                let logs = '';
                if (process.platform !== 'win32') {
                    try {
                        logs = execSync(`tail -n 150 "${logPath}"`).toString();
                    } catch (e) {
                        const content = fs.readFileSync(logPath, 'utf8').split('\n');
                        logs = content.slice(-150).join('\n');
                    }
                } else {
                    const content = fs.readFileSync(logPath, 'utf8').split('\n');
                    logs = content.slice(-150).join('\n');
                }
                return res.json({ success: true, logs });
            }

            const tunnels = manager.getTunnels();
            if (tunnels.length === 0) {
                return res.json({ success: true, logs: 'Nenhum túnel cadastrado e arquivo de log proxy_reverso.log não encontrado.' });
            }
            const logs = processManager.readLogs(tunnels[0].id, 150);
            res.json({ success: true, logs });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/cloudflared/backup', (req, res) => {
        try {
            const homeDir = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';
            const configYmlPath = path.join(homeDir, '.cloudflared', 'config.yml');
            const backupPath = makeBackup(configYmlPath);
            if (backupPath) {
                res.json({ success: true, backup: path.basename(backupPath) });
            } else {
                res.status(400).json({ success: false, error: 'Arquivo config.yml original não existe para backup.' });
            }
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/cloudflared/restore', (req, res) => {
        try {
            const { backupName } = req.body;
            if (!backupName) return res.status(400).json({ success: false, error: 'Nome do backup não fornecido.' });
            
            const homeDir = process.env.HOME || os.homedir() || '/data/data/com.termux/files/home';
            const backupPath = path.join(homeDir, '.cloudflared', backupName);
            const configYmlPath = path.join(homeDir, '.cloudflared', 'config.yml');
            
            if (!fs.existsSync(backupPath)) {
                return res.status(404).json({ success: false, error: 'Arquivo de backup não encontrado.' });
            }
            
            makeBackup(configYmlPath);
            
            fs.copyFileSync(backupPath, configYmlPath);
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/cloudflared/test', async (req, res) => {
        try {
            const { url } = req.body;
            if (!url) return res.status(400).json({ success: false, error: 'URL não fornecida.' });
            
            const result = await testUrl(url);
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
