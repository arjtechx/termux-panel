const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const net = require('net');
const systemConfig = require('../utils/env');
const { runCmd, chownToUser } = require('../utils/shell');

const PREFIX = systemConfig.prefix;
const NGINX_CONF_DIR = systemConfig.nginx_conf_dir || `${PREFIX}/etc/nginx/conf.d`;
const HOSTING_FILE = path.join(__dirname, '..', '..', 'config', 'hosting.json');
const HOSTING_LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const NGINX_REPAIR_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'nginx-termux-repair.sh');

if (!fs.existsSync(HOSTING_FILE)) {
    fs.writeFileSync(HOSTING_FILE, '[]');
}
if (!fs.existsSync(HOSTING_LOGS_DIR)) {
    fs.mkdirSync(HOSTING_LOGS_DIR, { recursive: true });
}

function isPortListening(port) {
    return new Promise((resolve) => {
        exec('ss -tulpn', (err, stdout) => {
            if (!err && stdout) {
                const regex = new RegExp(':' + port + '(\\b|\\s)');
                if (regex.test(stdout)) {
                    return resolve(true);
                }
            }
            const tester = net.createServer()
                .once('error', (errNet) => {
                    if (errNet.code === 'EADDRINUSE') resolve(true);
                    else resolve(false);
                })
                .once('listening', () => {
                    tester.once('close', () => resolve(false)).close();
                })
                .listen(port, '0.0.0.0');
        });
    });
}

function ensureHostingLogFile(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
        fs.closeSync(fs.openSync(filePath, 'a'));
    }
}

function nginxFastcgiInclude() {
    const params = path.join(PREFIX, 'etc', 'nginx', 'fastcgi_params');
    const conf = path.join(PREFIX, 'etc', 'nginx', 'fastcgi.conf');
    if (fs.existsSync(params)) return params;
    if (fs.existsSync(conf)) return conf;
    return params;
}

async function repairNginxBootstrap() {
    if (systemConfig.is_termux && fs.existsSync(NGINX_REPAIR_SCRIPT)) {
        await runCmd(`sh "${NGINX_REPAIR_SCRIPT}"`);
    }
}

function execStrict(cmd, timeout = 20000) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
            const output = `${stdout || ''}${stderr || ''}`.trim();
            if (error) return reject(new Error(output || error.message));
            resolve(output);
        });
    });
}

function validatePort(value, label) {
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${label} invalida.`);
    }
    if (systemConfig.is_termux && port < 1024 && !systemConfig.has_root) {
        throw new Error(`${label} menor que 1024 requer root no Termux. Use 8080 ou superior.`);
    }
    return port;
}

function safeServiceName(value) {
    const clean = String(value || 'site').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!clean) throw new Error('Nome do servico invalido.');
    return clean.slice(0, 64);
}

function safeServerName(value) {
    const raw = String(value || '_').trim();
    const names = raw.split(/\s+/).filter(name => /^(\*\.)?[A-Za-z0-9_.-]+$|^_$/.test(name));
    return names.length ? names.join(' ') : '_';
}

function nginxPath(value) {
    return `"${String(value).replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

async function reloadOrStartNginx(requireRoot = false) {
    if (requireRoot) {
        try {
            await runCmd('nginx -s reload', true);
        } catch (_) {
            await runCmd('nginx', true);
        }
        return;
    }

    try {
        await execStrict('nginx -s reload');
    } catch (_) {
        await execStrict('nginx');
    }
}

router.get('/', async (req, res) => {
    try {
        const services = JSON.parse(fs.readFileSync(HOSTING_FILE, 'utf8'));
        const enriched = await Promise.all(services.map(async (svc) => {
            if (svc.type === 'node' || svc.type === 'python') {
                let processAlive = false;
                if (svc.pid) {
                    try {
                        process.kill(svc.pid, 0);
                        processAlive = true;
                    } catch (e) {
                        processAlive = false;
                    }
                }
                
                let portListening = false;
                if (svc.targetPort) {
                    portListening = await isPortListening(svc.targetPort);
                }
                
                if (processAlive && portListening) {
                    svc.status = 'online';
                } else if (svc.status === 'online') {
                    svc.status = 'offline';
                }
            } else {
                const portListening = await isPortListening(svc.listenPort);
                svc.status = portListening ? 'online' : 'offline';
            }
            return svc;
        }));
        fs.writeFileSync(HOSTING_FILE, JSON.stringify(enriched, null, 2));
        res.json({ success: true, services: enriched });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', async (req, res) => {
    const { name, domain, type, listenPort, targetPort, path: sitePath, startCmd, autoRestart, createIndex } = req.body;
    
    const id = Date.now().toString();
    let parsedListenPort;
    let parsedTargetPort;
    
    try {
        const allowedTypes = ['php', 'static', 'node', 'python', 'proxy'];
        if (!allowedTypes.includes(type)) {
            return res.status(400).json({ error: 'Tipo de hospedagem invalido.' });
        }

        parsedListenPort = validatePort(listenPort, 'Porta publica');
        parsedTargetPort = targetPort ? validatePort(targetPort, 'Porta interna') : null;

        if (await isPortListening(parsedListenPort)) {
            return res.status(400).json({ error: `A porta pública ${parsedListenPort} já está em uso por outro serviço.` });
        }
        
        if (parsedTargetPort && (type === 'node' || type === 'python' || type === 'proxy')) {
            if (await isPortListening(parsedTargetPort)) {
                return res.status(400).json({ error: `A porta interna ${parsedTargetPort} já está em uso por outra aplicação.` });
            }
        }
        
        if ((type === 'node' || type === 'python' || type === 'proxy') && !parsedTargetPort) {
            return res.status(400).json({ error: 'Porta interna e obrigatoria para proxy, Node.js e Python.' });
        }

        if ((type === 'node' || type === 'python') && (!startCmd || !startCmd.trim())) {
            return res.status(400).json({ error: 'Comando de inicio e obrigatorio para Node.js/Python.' });
        }

        if (type !== 'proxy' && (!sitePath || !String(sitePath).trim())) {
            return res.status(400).json({ error: 'Pasta do projeto/site e obrigatoria.' });
        }

        const cleanName = safeServiceName(name || domain || type);
        const serverName = safeServerName(domain);
        const nginxConf = `hosting-${cleanName}-${id}.conf`;
        const confPath = path.join(NGINX_CONF_DIR, nginxConf);
        const logFile = `logs/hosting-${cleanName}-${id}.log`;
        const errorLog = `logs/hosting-${cleanName}-${id}-error.log`;
        const publicHost = serverName === '_' ? '127.0.0.1' : serverName.split(/\s+/)[0];
        const publicUrl = `http://${publicHost}:${parsedListenPort}`;
        
        let resolvedPath = sitePath ? path.resolve(sitePath.trim()) : '';
        if (resolvedPath && (type === 'php' || type === 'static' || type === 'node' || type === 'python')) {
            if (!fs.existsSync(resolvedPath)) {
                fs.mkdirSync(resolvedPath, { recursive: true });
            }
            
            if (createIndex) {
                if (type === 'php') {
                    const phpWelcome = `<?php\nheader('Content-Type: text/html; charset=utf-8');\n?>\n<!DOCTYPE html>\n<html>\n<head><title>Bem-vindo ao ${name}</title><style>body{font-family:sans-serif;background:#1e1e2e;color:#cdd6f4;text-align:center;padding:50px;}h1{color:#a6e3a1;}</style></head>\n<body><h1>🚀 Website PHP rodando com sucesso no Termux!</h1><p>Pasta: <code>${resolvedPath}</code></p><p><?php echo "Versão do PHP: " . phpversion(); ?></p></body>\n</html>`;
                    fs.writeFileSync(path.join(resolvedPath, 'index.php'), phpWelcome);
                } else if (type === 'static') {
                    const htmlWelcome = `<!DOCTYPE html>\n<html>\n<head><title>Bem-vindo ao ${name}</title><style>body{font-family:sans-serif;background:#1e1e2e;color:#cdd6f4;text-align:center;padding:50px;}h1{color:#89b4fa;}</style></head>\n<body><h1>🌐 Website Estático rodando com sucesso no NGINX!</h1><p>Pasta: <code>${resolvedPath}</code></p></body>\n</html>`;
                    fs.writeFileSync(path.join(resolvedPath, 'index.html'), htmlWelcome);
                }
            }
        }
        
        let content = '';
        const fullLogPath = path.join(__dirname, '..', '..', 'logs', `hosting-${cleanName}-${id}.log`);
        const fullErrorLogPath = path.join(__dirname, '..', '..', 'logs', `hosting-${cleanName}-${id}-error.log`);
        ensureHostingLogFile(fullLogPath);
        ensureHostingLogFile(fullErrorLogPath);
        
        if (type === 'php' || type === 'static') {
            const fastcgiInclude = nginxFastcgiInclude();
            content = `server {
    listen 0.0.0.0:${parsedListenPort};
    server_name ${serverName};
    root ${nginxPath(resolvedPath)};
    index index.php index.html index.htm;
    access_log ${nginxPath(fullLogPath)};
    error_log ${nginxPath(fullErrorLogPath)};

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include ${fastcgiInclude};
        fastcgi_pass 127.0.0.1:9070;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}`;
        } else {
            const proxyPort = parsedTargetPort;
            content = `server {
    listen 0.0.0.0:${parsedListenPort};
    server_name ${serverName};
    access_log ${nginxPath(fullLogPath)};
    error_log ${nginxPath(fullErrorLogPath)};

    location / {
        proxy_pass http://127.0.0.1:${proxyPort};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}`;
        }
        
        if (!fs.existsSync(NGINX_CONF_DIR)) {
            fs.mkdirSync(NGINX_CONF_DIR, { recursive: true });
        }
        fs.writeFileSync(confPath, content);
        
        const requireRoot = (parsedListenPort < 1024);
        let isNginxOk = true;
        let nginxError = '';
        
        await repairNginxBootstrap();

        let testCmd = requireRoot && systemConfig.is_termux ? `su -c 'nginx -t'` : (requireRoot && !systemConfig.is_termux ? `sudo nginx -t` : `nginx -t`);
        
        await new Promise((resolve) => {
            exec(testCmd, (error, stdout, stderr) => {
                if (error) {
                    isNginxOk = false;
                    nginxError = stderr || stdout || error.message;
                }
                resolve();
            });
        });
        
        if (!isNginxOk) {
            if (fs.existsSync(confPath)) {
                fs.unlinkSync(confPath);
            }
            return res.status(400).json({ error: `Erro na sintaxe do NGINX:\n${nginxError}` });
        }
        
        try {
            await reloadOrStartNginx(requireRoot);
            if (requireRoot) {
                await chownToUser([NGINX_CONF_DIR, HOSTING_LOGS_DIR]);
            }
        } catch (e) {
            console.error("Nginx reload falhou", e);
        }
        
        let pid = null;
        let activeStatus = 'stopped';
        
        if (type === 'node' || type === 'python') {
            const logStream = fs.createWriteStream(fullLogPath, { flags: 'a' });
            const parts = startCmd.trim().split(/\s+/);
            const cmd = parts[0];
            const args = parts.slice(1);
            
            const child = spawn(cmd, args, {
                cwd: resolvedPath,
                env: { ...process.env, PORT: parsedTargetPort.toString() },
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            child.stdout.pipe(logStream);
            child.stderr.pipe(logStream);
            child.unref();
            
            pid = child.pid;
            activeStatus = 'online';
        } else {
            activeStatus = 'online';
        }
        
        const services = JSON.parse(fs.readFileSync(HOSTING_FILE, 'utf8'));
        const newService = {
            id,
            name: name.trim(),
            domain: domain ? domain.trim() : '_',
            type,
            listenPort: parsedListenPort,
            targetPort: parsedTargetPort,
            path: resolvedPath,
            startCmd: startCmd ? startCmd.trim() : '',
            autoRestart: !!autoRestart,
            pid,
            status: activeStatus,
            publicUrl,
            bindHost: '0.0.0.0',
            nginxConf,
            logFile,
            errorLog,
            createdAt: new Date().toISOString()
        };
        
        services.push(newService);
        fs.writeFileSync(HOSTING_FILE, JSON.stringify(services, null, 2));
        
        res.json({ success: true, service: newService });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        const services = JSON.parse(fs.readFileSync(HOSTING_FILE, 'utf8'));
        const svc = services.find(s => s.id === req.params.id);
        
        if (!svc) {
            return res.status(404).json({ error: 'Serviço não encontrado' });
        }
        
        if (svc.pid) {
            try {
                process.kill(svc.pid, 'SIGKILL');
            } catch (e) {}
        }
        
        const confPath = path.join(NGINX_CONF_DIR, svc.nginxConf);
        if (fs.existsSync(confPath)) {
            fs.unlinkSync(confPath);
        }
        
        const requireRoot = (svc.listenPort < 1024);
        try {
            await repairNginxBootstrap();
            await execStrict('nginx -t');
            await reloadOrStartNginx(requireRoot);
            if (requireRoot) {
                await chownToUser([NGINX_CONF_DIR, HOSTING_LOGS_DIR]);
            }
        } catch(e) { console.error("Nginx reload failed", e); }
        
        const fullLogPath = path.join(__dirname, '..', '..', svc.logFile);
        const fullErrorLogPath = path.join(__dirname, '..', '..', svc.errorLog);
        if (fs.existsSync(fullLogPath)) fs.unlinkSync(fullLogPath);
        if (fs.existsSync(fullErrorLogPath)) fs.unlinkSync(fullErrorLogPath);
        
        const filtered = services.filter(s => s.id !== req.params.id);
        fs.writeFileSync(HOSTING_FILE, JSON.stringify(filtered, null, 2));
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/:id/toggle', async (req, res) => {
    const { active } = req.body;
    try {
        const services = JSON.parse(fs.readFileSync(HOSTING_FILE, 'utf8'));
        const index = services.findIndex(s => s.id === req.params.id);
        if (index === -1) {
            return res.status(404).json({ error: 'Serviço não encontrado' });
        }
        
        const svc = services[index];
        
        if (active) {
            if (svc.type !== 'node' && svc.type !== 'python') {
                return res.status(400).json({ error: 'Este tipo de serviço não possui processos associados.' });
            }
            
            if (svc.targetPort && await isPortListening(svc.targetPort)) {
                return res.status(400).json({ error: `A porta interna ${svc.targetPort} já está ocupada.` });
            }
            
            const fullLogPath = path.join(__dirname, '..', '..', svc.logFile);
            const logStream = fs.createWriteStream(fullLogPath, { flags: 'a' });
            const parts = svc.startCmd.trim().split(/\s+/);
            const cmd = parts[0];
            const args = parts.slice(1);
            
            const child = spawn(cmd, args, {
                cwd: svc.path,
                env: { ...process.env, PORT: svc.targetPort.toString() },
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe']
            });
            
            child.stdout.pipe(logStream);
            child.stderr.pipe(logStream);
            child.unref();
            
            services[index].pid = child.pid;
            services[index].status = 'online';
        } else {
            if (svc.pid) {
                try {
                    process.kill(svc.pid, 'SIGKILL');
                } catch (e) {}
            }
            services[index].pid = null;
            services[index].status = 'stopped';
        }
        
        fs.writeFileSync(HOSTING_FILE, JSON.stringify(services, null, 2));
        res.json({ success: true, service: services[index] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id/logs', (req, res) => {
    try {
        const services = JSON.parse(fs.readFileSync(HOSTING_FILE, 'utf8'));
        const svc = services.find(s => s.id === req.params.id);
        if (!svc) {
            return res.status(404).json({ error: 'Serviço não encontrado' });
        }
        
        const fullLogPath = path.join(__dirname, '..', '..', svc.logFile);
        if (!fs.existsSync(fullLogPath)) {
            return res.send('Nenhum log gravado ainda.');
        }
        
        const logContent = fs.readFileSync(fullLogPath, 'utf8');
        const lines = logContent.split('\n');
        const lastLines = lines.slice(-150).join('\n');
        res.send(lastLines);
    } catch (err) {
        res.status(500).send(`Erro ao ler logs: ${err.message}`);
    }
});

setInterval(async () => {
    try {
        if (!fs.existsSync(HOSTING_FILE)) return;
        const services = JSON.parse(fs.readFileSync(HOSTING_FILE, 'utf8'));
        let modified = false;
        
        for (let i = 0; i < services.length; i++) {
            const svc = services[i];
            if ((svc.type === 'node' || svc.type === 'python') && svc.autoRestart && svc.status === 'online') {
                let processAlive = false;
                if (svc.pid) {
                    try {
                        process.kill(svc.pid, 0);
                        processAlive = true;
                    } catch (e) {
                        processAlive = false;
                    }
                }
                
                let portListening = false;
                if (svc.targetPort) {
                    portListening = await isPortListening(svc.targetPort);
                }
                
                if (!processAlive || !portListening) {
                    console.log(`[Daemon] Detectada queda do serviço ${svc.name} (PID: ${svc.pid}, Porta: ${svc.targetPort}). Reiniciando...`);
                    
                    if (svc.pid) {
                        try { process.kill(svc.pid, 'SIGKILL'); } catch(e) {}
                    }
                    
                    try {
                        const fullLogPath = path.join(__dirname, '..', '..', svc.logFile);
                        const logStream = fs.createWriteStream(fullLogPath, { flags: 'a' });
                        const parts = svc.startCmd.trim().split(/\s+/);
                        const cmd = parts[0];
                        const args = parts.slice(1);
                        
                        const child = spawn(cmd, args, {
                            cwd: svc.path,
                            env: { ...process.env, PORT: svc.targetPort.toString() },
                            detached: true,
                            stdio: ['ignore', 'pipe', 'pipe']
                        });
                        
                        child.stdout.pipe(logStream);
                        child.stderr.pipe(logStream);
                        child.unref();
                        
                        services[i].pid = child.pid;
                        modified = true;
                    } catch (err) {
                        console.error(`[Daemon] Falha ao auto-reiniciar ${svc.name}:`, err.message);
                    }
                }
            }
        }
        
        if (modified) {
            fs.writeFileSync(HOSTING_FILE, JSON.stringify(services, null, 2));
        }
    } catch (e) {
        console.error('[Daemon Auto-Restart] Erro:', e.message);
    }
}, 15000);

module.exports = router;
