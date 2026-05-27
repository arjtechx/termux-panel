const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const net = require('net');
const dns = require('dns').promises;
const systemConfig = require('../utils/env');
const { runCmd, chownToUser } = require('../utils/shell');

const PREFIX = systemConfig.prefix;
const NGINX_CONF_DIR = systemConfig.nginx_conf_dir || `${PREFIX}/etc/nginx/conf.d`;
const db = require('../utils/db');

async function getServices() {
    const rows = await db.query('SELECT * FROM hosting');
    return rows.map(r => ({ id: r.id, domain: r.domain, port: r.port, rootDir: r.root_dir, phpVersion: r.php_version, ...(r.data || {}) }));
}

async function saveServices(services) {
    const existingRows = await db.query('SELECT id FROM hosting');
    const existingIds = existingRows.map(r => String(r.id));
    const newIds = services.map(s => String(s.id));
    
    const toDelete = existingIds.filter(id => !newIds.includes(id));
    for (const id of toDelete) {
        await db.query('DELETE FROM hosting WHERE id = ?', [id]);
    }
    
    for (const svc of services) {
        const rows = await db.query('SELECT id FROM hosting WHERE id = ?', [svc.id]);
        if (rows.length > 0) {
            await db.query('UPDATE hosting SET domain=?, port=?, root_dir=?, php_version=?, `data`=? WHERE id=?', 
                [svc.domain || svc.name || '', svc.port || svc.listenPort || 0, svc.rootDir || svc.path || '', svc.phpVersion || '', JSON.stringify(svc), svc.id]);
        } else {
            await db.query('INSERT INTO hosting (id, domain, port, root_dir, php_version, `data`) VALUES (?, ?, ?, ?, ?, ?)',
                [svc.id, svc.domain || svc.name || '', svc.port || svc.listenPort || 0, svc.rootDir || svc.path || '', svc.phpVersion || '', JSON.stringify(svc)]);
        }
    }
}
const HOSTING_LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const NGINX_REPAIR_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'nginx-termux-repair.sh');
const HOSTING_BASE_DIR = '/data/data/com.termux/files/home/www';


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

function isNginxAlreadyUsingPort(port) {
    return new Promise((resolve) => {
        exec('ss -tulpn 2>/dev/null || netstat -tulpn 2>/dev/null', (err, stdout) => {
            if (err || !stdout) return resolve(false);
            const portPattern = new RegExp(`:${port}(\\b|\\s)`);
            resolve(stdout.split('\n').some(line => portPattern.test(line) && /nginx/i.test(line)));
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

function execStrict(cmd, options = 20000) {
    const execOptions = typeof options === 'object'
        ? { killSignal: 'SIGKILL', ...options }
        : { timeout: options, killSignal: 'SIGKILL' };
    return new Promise((resolve, reject) => {
        exec(cmd, execOptions, (error, stdout, stderr) => {
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
    const clean = String(value || 'site')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!clean) throw new Error('Nome do servico invalido.');
    return clean.slice(0, 64);
}

function isValidHostname(value) {
    const host = String(value || '').trim().toLowerCase();
    if (!host || host.includes('://') || host.includes('/')) return false;
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host);
}

function ensureSafeProjectPath(sitePath, fallbackSlug) {
    const raw = String(sitePath || '').trim();
    const base = path.resolve(HOSTING_BASE_DIR);
    const resolved = raw ? path.resolve(raw) : path.resolve(base, fallbackSlug);
    if (!resolved.startsWith(base)) {
        throw new Error(`Caminho fora da base permitida: ${HOSTING_BASE_DIR}`);
    }
    if (/\.\./.test(raw) || /[;&|`$]/.test(raw)) {
        throw new Error('Caminho do projeto contem caracteres nao permitidos.');
    }
    return resolved;
}

async function findNextAvailablePort(startPort = 4000) {
    let port = Number.parseInt(startPort, 10);
    if (!Number.isInteger(port) || port < 1) port = 4000;
    while (port <= 65535) {
        const busy = await isPortListening(port);
        const nginxOwns = busy ? await isNginxAlreadyUsingPort(port) : false;
        if (!busy || nginxOwns) return port;
        port++;
    }
    throw new Error('Nao foi possivel encontrar porta livre.');
}

function safeServerName(value) {
    const raw = String(value || '_').trim();
    const names = raw.split(/\s+/).filter(name => /^(\*\.)?[A-Za-z0-9_.-]+$|^_$/.test(name));
    return names.length ? names.join(' ') : '_';
}

function nginxPath(value) {
    return `"${String(value).replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

async function resolveDnsStatus(hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    if (!host) return { ok: false, host, message: 'Hostname vazio.' };
    try {
        const [a4, a6] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host)]);
        const ipv4 = a4.status === 'fulfilled' ? (a4.value || []) : [];
        const ipv6 = a6.status === 'fulfilled' ? (a6.value || []) : [];
        const records = [...ipv4, ...ipv6];
        if (records.length > 0) {
            return { ok: true, host, records };
        }
        return { ok: false, host, message: 'Sem registros A/AAAA ainda.' };
    } catch (e) {
        return { ok: false, host, message: e.message };
    }
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
async function killProcessHoldingPort(port) {
    if (!port) return;
    try {
        let pid = null;
        
        // Método 1: ss (comum no Termux/Linux)
        try {
            let ssOut = await runCmd(`ss -ltnp 2>/dev/null | grep ":${port} " | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -n1`);
            ssOut = ssOut.trim();
            if (ssOut) pid = parseInt(ssOut, 10);
        } catch (_) {}

        // Método 2: lsof (Linux/macOS)
        if (!pid) {
            try {
                let lsofOut = await runCmd(`lsof -t -i:${port} 2>/dev/null | head -n1`);
                lsofOut = lsofOut.trim();
                if (lsofOut) pid = parseInt(lsofOut, 10);
            } catch (_) {}
        }

        // Método 3: fuser (Linux)
        if (!pid) {
            try {
                let fuserOut = await runCmd(`fuser ${port}/tcp 2>/dev/null | awk '{print $1}' | head -n1`);
                fuserOut = fuserOut.trim();
                if (fuserOut) pid = parseInt(fuserOut, 10);
            } catch (_) {}
        }

        if (pid && pid !== process.pid) {
            console.log(`[Hosting] Matando processo fantasma na porta ${port} (PID: ${pid})`);
            try {
                process.kill(pid, 'SIGKILL');
                await new Promise(r => setTimeout(r, 800)); // espera liberar a porta
            } catch (err) {
                if (systemConfig.has_root) {
                    await runCmd(`kill -9 ${pid}`, true);
                } else {
                    await runCmd(`kill -9 ${pid}`);
                }
            }
        }
    } catch (e) {
        console.error(`[Hosting] Falha ao matar processo fantasma na porta ${port}:`, e.message);
    }
}

async function handleNodeErrorAndRestart(svcId, stderrStr) {
    try {
        const services = (await getServices());
        const index = services.findIndex(s => s.id === svcId);
        if (index === -1) return;
        const svc = services[index];
        
        if (svc.isInstallingModule) return;

        const match = stderrStr.match(/Error: Cannot find module ['"]([^'"]+)['"]/);
        if (match) {
            const missingModule = match[1];
            if (!missingModule.startsWith('.') && !missingModule.startsWith('/') && !path.isAbsolute(missingModule)) {
                services[index].isInstallingModule = true;
                await saveServices(services);

                const fullLogPath = path.join(__dirname, '..', '..', svc.logFile);
                const logStream = fs.createWriteStream(fullLogPath, { flags: 'a' });
                logStream.write(`\n[cPanel Auto-Setup] Detectado módulo ausente: '${missingModule}'\n`);
                logStream.write(`[cPanel Auto-Setup] Executando 'npm install ${missingModule}'...\n`);
                
                exec(`npm install ${missingModule}`, { cwd: svc.path }, async (err, stdout, stderr) => {
                    const freshServices = (await getServices());
                    const freshIdx = freshServices.findIndex(s => s.id === svcId);
                    if (freshIdx !== -1) {
                        freshServices[freshIdx].isInstallingModule = false;
                        await saveServices(freshServices);
                    }

                    if (err) {
                        logStream.write(`[cPanel Auto-Setup] Erro ao instalar '${missingModule}': ${err.message}\n\n`);
                        return;
                    }

                    logStream.write(`[cPanel Auto-Setup] Módulo '${missingModule}' instalado com sucesso! Reiniciando aplicação...\n\n`);
                    
                    try {
                        await restartNodeService(svcId);
                    } catch (e) {
                        console.error('[cPanel Auto-Setup] Erro ao reiniciar serviço após instalação:', e.message);
                    }
                });
            }
        }
    } catch (e) {
        console.error('[cPanel Auto-Setup] Erro no processamento de erro do Node:', e.message);
    }
}

function spawnProcess(cmd, args, cwd, targetPort, runAsRoot) {
    if (runAsRoot) {
        const fullCmd = [cmd, ...args].join(' ');
        return spawn('su', ['-c', `cd "${cwd}" && PORT=${targetPort} ${fullCmd}`], {
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    } else {
        return spawn(cmd, args, {
            cwd: cwd,
            env: { ...process.env, PORT: targetPort.toString() },
            detached: true,
            stdio: ['ignore', 'pipe', 'pipe']
        });
    }
}

async function startNodeProcess(svc, index, services, customCmd) {
    const fullLogPath = path.join(__dirname, '..', '..', svc.logFile);
    const logStream = fs.createWriteStream(fullLogPath, { flags: 'a' });
    
    // 1. Mata processo fantasma ocupando a porta targetPort
    await killProcessHoldingPort(svc.targetPort);

    // 2. Auto-instalação de dependências inicial se node_modules não existir
    const packageJsonPath = path.join(svc.path, 'package.json');
    const nodeModulesPath = path.join(svc.path, 'node_modules');
    if (fs.existsSync(packageJsonPath) && !fs.existsSync(nodeModulesPath)) {
        console.log(`[Hosting] node_modules não encontrado em ${svc.path}. Iniciando npm install...`);
        logStream.write(`\n[cPanel Auto-Setup] node_modules não encontrado. Executando 'npm install'...\n`);
        try {
            await execStrict('npm install', { cwd: svc.path, timeout: 180000 });
            logStream.write(`[cPanel Auto-Setup] 'npm install' concluído com sucesso!\n\n`);
        } catch (npmErr) {
            logStream.write(`[cPanel Auto-Setup] Erro ao executar 'npm install': ${npmErr.message}\n\n`);
        }
    }

    // 3. Ajuste de porta no arquivo .env (se existir) para bater com a targetPort configurada
    const envPath = path.join(svc.path, '.env');
    if (fs.existsSync(envPath)) {
        try {
            let envContent = fs.readFileSync(envPath, 'utf8');
            if (envContent.includes('PORT=')) {
                envContent = envContent.replace(/PORT=\d+/g, `PORT=${svc.targetPort}`);
            } else {
                envContent += `\nPORT=${svc.targetPort}\n`;
            }
            fs.writeFileSync(envPath, envContent, 'utf8');
            logStream.write(`[cPanel Auto-Setup] Porta ajustada no arquivo .env para PORT=${svc.targetPort}\n`);
        } catch (e) {
            console.error(`[Hosting] Falha ao ajustar porta no .env:`, e.message);
        }
    }

    // 3.5. Garante permissão de execução na pasta node_modules/.bin (evita Permission denied no Termux)
    const binPath = path.join(svc.path, 'node_modules', '.bin');
    if (fs.existsSync(binPath)) {
        try {
            await execStrict(`chmod -R +x "${binPath}"`);
        } catch (e) {
            console.error(`[Hosting] Falha ao dar chmod +x no .bin:`, e.message);
        }
    }

    // 4. Inicia o processo
    const cmdToRun = customCmd || svc.startCmd;
    if (customCmd) {
        logStream.write(`\n[cPanel] Iniciando processo Node.js com comando customizado: ${cmdToRun}\n`);
    }
    const parts = cmdToRun.trim().split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    
    if (svc.runAsRoot) {
        logStream.write(`[cPanel] Executando processo Node.js como ROOT (su -c)\n`);
    }
    const child = spawnProcess(cmd, args, svc.path, svc.targetPort, svc.runAsRoot);
    
    // Captura stderr para monitorar erros de módulo ausente
    let stderrAccumulator = '';
    child.stderr.on('data', (data) => {
        const str = data.toString();
        stderrAccumulator += str;
        if (stderrAccumulator.length > 5000) {
            stderrAccumulator = stderrAccumulator.slice(-5000);
        }
        
        if (str.includes('MODULE_NOT_FOUND') || str.includes('Cannot find module')) {
            setTimeout(() => {
                handleNodeErrorAndRestart(svc.id, stderrAccumulator);
            }, 1000);
        }
    });

    child.stdout.pipe(logStream);
    child.stderr.pipe(logStream);
    child.unref();
    
    services[index].pid = child.pid;
    services[index].status = 'online';
    services[index].updatedAt = new Date().toISOString();
}

async function restartNodeService(svcId) {
    const services = (await getServices());
    const index = services.findIndex(s => s.id === svcId);
    if (index === -1) return;
    const svc = services[index];

    if (svc.pid) {
        try {
            process.kill(svc.pid, 'SIGKILL');
        } catch (e) {}
    }

    await startNodeProcess(svc, index, services);
    await saveServices(services);
}


router.get('/', async (req, res) => {
    try {
        const services = (await getServices());
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
        await saveServices(enriched);
        res.json({ success: true, services: enriched });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/next-port', async (req, res) => {
    try {
        const start = Number.parseInt(req.query.start, 10) || 4000;
        const port = await findNextAvailablePort(start);
        res.json({ success: true, port });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.post('/', async (req, res) => {
    const { name, slug, domain, bindHost, localHost, type, listenPort, targetPort, path: sitePath, startCmd, autoRestart, createIndex, createTunnel, tunnelAction, tunnelName, tunnelExistingId, tunnelHostname } = req.body;
    
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

        if (await isPortListening(parsedListenPort) && !await isNginxAlreadyUsingPort(parsedListenPort)) {
            return res.status(400).json({ error: `A porta pública ${parsedListenPort} já está em uso por outro serviço.` });
        }
        
        if (parsedTargetPort && (type === 'node' || type === 'python')) {
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

        const cleanName = safeServiceName(slug || name || domain || type);
        const displayName = String(name || cleanName).trim();
        const bindAddress = String(bindHost || domain || '0.0.0.0').trim() || '0.0.0.0';
        const localAddress = 'localhost';
        const serverName = safeServerName(bindAddress === '0.0.0.0' ? '_' : bindAddress);
        const nginxConf = `hosting-${cleanName}-${id}.conf`;
        const confPath = path.join(NGINX_CONF_DIR, nginxConf);
        const logFile = `logs/hosting-${cleanName}-${id}.log`;
        const errorLog = `logs/hosting-${cleanName}-${id}-error.log`;
        const publicHost = '127.0.0.1';
        const publicUrl = `http://${publicHost}:${parsedListenPort}`;
        
        let resolvedPath = ensureSafeProjectPath(sitePath, cleanName);
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
            if (type === 'node') {
                // Mata processo fantasma ocupando a porta targetPort
                await killProcessHoldingPort(parsedTargetPort);

                // Auto-instalação de dependências inicial se node_modules não existir
                const packageJsonPath = path.join(resolvedPath, 'package.json');
                const nodeModulesPath = path.join(resolvedPath, 'node_modules');
                if (fs.existsSync(packageJsonPath) && !fs.existsSync(nodeModulesPath)) {
                    console.log(`[Hosting] node_modules não encontrado em ${resolvedPath}. Iniciando npm install...`);
                    const logStream = fs.createWriteStream(fullLogPath, { flags: 'a' });
                    logStream.write(`\n[cPanel Auto-Setup] node_modules não encontrado. Executando 'npm install'...\n`);
                    try {
                        await execStrict('npm install', { cwd: resolvedPath, timeout: 180000 });
                        logStream.write(`[cPanel Auto-Setup] 'npm install' concluído com sucesso!\n\n`);
                    } catch (npmErr) {
                        logStream.write(`[cPanel Auto-Setup] Erro ao executar 'npm install': ${npmErr.message}\n\n`);
                    }
                }

                // Ajuste de porta no arquivo .env (se existir) para bater com a targetPort configurada
                const envPath = path.join(resolvedPath, '.env');
                if (fs.existsSync(envPath)) {
                    try {
                        let envContent = fs.readFileSync(envPath, 'utf8');
                        if (envContent.includes('PORT=')) {
                            envContent = envContent.replace(/PORT=\d+/g, `PORT=${parsedTargetPort}`);
                        } else {
                            envContent += `\nPORT=${parsedTargetPort}\n`;
                        }
                        fs.writeFileSync(envPath, envContent, 'utf8');
                        const logStream = fs.createWriteStream(fullLogPath, { flags: 'a' });
                        logStream.write(`[cPanel Auto-Setup] Porta ajustada no arquivo .env para PORT=${parsedTargetPort}\n`);
                    } catch (e) {
                        console.error(`[Hosting] Falha ao ajustar porta no .env:`, e.message);
                    }
                }

                const logStream = fs.createWriteStream(fullLogPath, { flags: 'a' });
                const parts = startCmd.trim().split(/\s+/);
                const cmd = parts[0];
                const args = parts.slice(1);
                
                const runAsRoot = !!req.body.runAsRoot;
                if (runAsRoot) {
                    logStream.write(`[cPanel] Executando processo Node.js como ROOT (su -c)\n`);
                }
                const child = spawnProcess(cmd, args, resolvedPath, parsedTargetPort, runAsRoot);

                // Monitora erros para auto-instalação
                let stderrAccumulator = '';
                child.stderr.on('data', (data) => {
                    const str = data.toString();
                    stderrAccumulator += str;
                    if (stderrAccumulator.length > 5000) {
                        stderrAccumulator = stderrAccumulator.slice(-5000);
                    }
                    if (str.includes('MODULE_NOT_FOUND') || str.includes('Cannot find module')) {
                        setTimeout(() => {
                            handleNodeErrorAndRestart(id, stderrAccumulator);
                        }, 1000);
                    }
                });
                
                child.stdout.pipe(logStream);
                child.stderr.pipe(logStream);
                child.unref();
                
                pid = child.pid;
                activeStatus = 'online';
            } else {
                // Python
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
            }
        } else {
            activeStatus = 'online';
        }
        
        let cfWarning = null;
        let cfTunnelInstanceId = null;
        if (createTunnel && tunnelHostname) {
            try {
                const cfManager = require('../../modules/cloudflared/manager');
                const cfProcess = require('../../modules/cloudflared/process');
                const publicHostname = String(tunnelHostname || '').trim().toLowerCase();
                if (!isValidHostname(publicHostname)) {
                    throw new Error('Hostname público inválido.');
                }
                
                if (tunnelAction === 'new') {
                    // Create new Cloudflare instance
                    const instName = safeServiceName(tunnelName ? tunnelName.trim() : cleanName);
                    const newInst = await cfManager.createInstance({
                        name: instName,
                        type: 'service',
                        protected: false,
                        autoRestartOnSave: true,
                        createCloudflareTunnel: true, // CLI creates tunnel
                        routes: [
                            {
                                name: displayName,
                                hostname: publicHostname,
                                path: '/',
                                targetProtocol: 'http',
                                targetHost: localAddress,
                                targetPort: parsedListenPort,
                                routeType: 'http'
                            }
                        ]
                    });
                    cfTunnelInstanceId = newInst.id;
                    if (!newInst.tunnelId) {
                        // Evita deixar instância quebrada (sem tunnelId) que falha ao iniciar/reiniciar.
                        try {
                            if (newInst.id) await cfManager.deleteInstance(newInst.id);
                        } catch (_) {}
                        cfTunnelInstanceId = null;
                        cfWarning = 'Serviço criado, mas o túnel não recebeu tunnelId. Verifique login Cloudflare e permissões DNS da zona.';
                    } else if (newInst.dnsWarnings && newInst.dnsWarnings.length) {
                        cfWarning = `Serviço criado, mas houve falha ao criar DNS: ${newInst.dnsWarnings.join(' | ')}`;
                    }
                    
                    // Start the newly created instance
                    try {
                        const startResult = cfProcess.startInstance(newInst);
                        if (!startResult || !startResult.success) {
                            throw new Error((startResult && startResult.error) || 'Falha ao iniciar processo cloudflared.');
                        }
                    } catch (startErr) {
                        console.error(`[Hosting - Tunnel] Falha ao iniciar novo túnel:`, startErr.message);
                        cfWarning = `Serviço criado, mas falhou ao iniciar o processo do túnel: ${startErr.message}`;
                    }
                } else if (tunnelAction === 'existing' && tunnelExistingId) {
                    // Fetch existing instance
                    const instances = (await cfManager.getInstances());
                    const existingInst = instances.find(i => i.id === tunnelExistingId);
                    
                    if (existingInst) {
                        const updatedRoutes = [...(existingInst.routes || [])];
                        // Avoid duplicates
                        const routeExists = updatedRoutes.some(r => r.hostname === publicHostname);
                        if (!routeExists) {
                            updatedRoutes.push({
                                name: displayName,
                                hostname: publicHostname,
                                path: '/',
                                targetProtocol: 'http',
                                targetHost: localAddress,
                                targetPort: parsedListenPort,
                                routeType: 'http'
                            });
                            
                            // Save updated instance which recreates configuration yaml
                            const updatedInst = await cfManager.updateInstance(existingInst.id, {
                                routes: updatedRoutes
                            });
                            cfTunnelInstanceId = updatedInst.id;
                            
                            // Check if instance is running, and if so, perform Zero Downtime reload
                            const status = await cfProcess.getInstanceStatus(existingInst.id);
                            if (status.running) {
                                try {
                                    // Generate the temporary next.yml for validation & safe reload
                                    cfManager.generateYamlForInstance(updatedInst, true);
                                    const reloadResult = await cfProcess.reloadSafeInstance(updatedInst);
                                    if (!reloadResult.success) {
                                        throw new Error(reloadResult.error || 'Reload falhou');
                                    }
                                } catch (reloadErr) {
                                    console.error(`[Hosting - Tunnel] Falha ao atualizar túnel com Zero Downtime. Tentando restart simples...`, reloadErr.message);
                                    // Fallback to stop and start
                                    try {
                                        cfProcess.stopInstance(updatedInst.id);
                                        cfProcess.startInstance(updatedInst);
                                    } catch (restartErr) {
                                        cfWarning = `Serviço criado, mas falhou ao reiniciar o túnel existente para aplicar a nova rota: ${restartErr.message}`;
                                    }
                                }
                            }
                        }
                    } else {
                        cfWarning = 'Túnel existente selecionado não foi encontrado.';
                    }
                }
            } catch (cfErr) {
                console.error(`[Hosting - Cloudflared Integration Error]:`, cfErr.message);
                cfWarning = `Não foi possível criar/vincular o túnel: ${cfErr.message}`;
            }
        }

        const services = (await getServices());
        const newService = {
            id,
            name: displayName,
            slug: cleanName,
            domain: bindAddress ? bindAddress.trim() : '0.0.0.0',
            type,
            listenPort: parsedListenPort,
            targetPort: parsedTargetPort,
            path: resolvedPath,
            startCmd: startCmd ? startCmd.trim() : '',
            autoRestart: !!autoRestart,
            runAsRoot: !!req.body.runAsRoot,
            pid,
            status: activeStatus,
            publicUrl,
            bindHost: bindAddress,
            localHost: localAddress,
            nginxConf,
            logFile,
            errorLog,
            cloudflareTunnel: createTunnel && tunnelHostname ? {
                action: tunnelAction,
                hostname: String(tunnelHostname).trim().toLowerCase(),
                instanceId: tunnelAction === 'existing' ? tunnelExistingId : (cfTunnelInstanceId || ''),
                tunnelName: tunnelAction === 'new' ? safeServiceName(tunnelName || cleanName) : ''
            } : null,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        
        services.push(newService);
        await saveServices(services);
        
        // Responde imediatamente para evitar timeout em acesso via domínio tunelado.
        // Pós-ações rodam assíncronas em background.
        const postActions = { scheduled: true, nginxRestarted: false, tunnelRestarted: false };
        const dnsStatus = (newService.cloudflareTunnel && newService.cloudflareTunnel.hostname)
            ? await resolveDnsStatus(newService.cloudflareTunnel.hostname)
            : null;
        res.json({ success: true, service: newService, cfWarning, postActions, dnsStatus });

        setTimeout(async () => {
            try {
                await reloadOrStartNginx(requireRoot);
            } catch (e) {
                console.error('[Hosting post-action] Falha ao reiniciar NGINX:', e.message);
            }

            if (newService.cloudflareTunnel && newService.cloudflareTunnel.instanceId) {
                try {
                    const cfManager = require('../../modules/cloudflared/manager');
                    const cfProcess = require('../../modules/cloudflared/process');
                    const inst = (await cfManager.getInstances()).find(i => i.id === newService.cloudflareTunnel.instanceId);
                    if (inst && inst.tunnelId) {
                        cfProcess.stopInstance(newService.cloudflareTunnel.instanceId);
                        await new Promise(r => setTimeout(r, 1000));
                        const restartResult = cfProcess.startInstance(inst);
                        if (!restartResult || !restartResult.success) {
                            throw new Error((restartResult && restartResult.error) || 'Falha ao reiniciar túnel.');
                        }
                    } else {
                        console.warn('[Hosting post-action] Instância sem tunnelId, pulando restart automático do túnel.');
                    }
                } catch (e) {
                    console.error('[Hosting post-action] Falha ao reiniciar túnel do serviço:', e.message);
                }
            }
        }, 3000);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.post('/:id/edit', async (req, res) => {
    const { id } = req.params;
    const { name, domain, listenPort, targetPort, startCmd, path: sitePath, autoRestart } = req.body;

    try {
        const services = (await getServices());
        const index = services.findIndex(s => s.id === id);
        if (index === -1) {
            return res.status(404).json({ error: 'Serviço não encontrado' });
        }

        const svc = services[index];
        const oldListenPort = svc.listenPort;
        const oldTargetPort = svc.targetPort;
        const oldPath = svc.path;
        const oldStartCmd = svc.startCmd;
        const oldDomain = svc.domain;

        const parsedListenPort = validatePort(listenPort, 'Porta publica');
        const parsedTargetPort = targetPort ? validatePort(targetPort, 'Porta interna') : null;

        // Verifica portas se mudaram
        if (parsedListenPort !== oldListenPort) {
            if (await isPortListening(parsedListenPort) && !await isNginxAlreadyUsingPort(parsedListenPort)) {
                return res.status(400).json({ error: `A porta pública ${parsedListenPort} já está em uso por outro serviço.` });
            }
        }
        if (parsedTargetPort && parsedTargetPort !== oldTargetPort && (svc.type === 'node' || svc.type === 'python')) {
            if (await isPortListening(parsedTargetPort)) {
                return res.status(400).json({ error: `A porta interna ${parsedTargetPort} já está em uso por outra aplicação.` });
            }
        }

        const cleanName = svc.slug;
        const displayName = String(name || svc.name).trim();
        const bindAddress = String(domain || svc.domain || '0.0.0.0').trim();
        const serverName = safeServerName(bindAddress === '0.0.0.0' ? '_' : bindAddress);
        const confPath = path.join(NGINX_CONF_DIR, svc.nginxConf);

        let resolvedPath = svc.path;
        if (sitePath && sitePath.trim() !== oldPath) {
            resolvedPath = ensureSafeProjectPath(sitePath, cleanName);
            if (!fs.existsSync(resolvedPath)) {
                fs.mkdirSync(resolvedPath, { recursive: true });
            }
        }

        // 1. Atualiza configuração do NGINX
        if (bindAddress !== oldDomain || parsedListenPort !== oldListenPort || parsedTargetPort !== oldTargetPort || resolvedPath !== oldPath) {
            let contentStr = '';
            const fullLogPath = path.join(__dirname, '..', '..', svc.logFile);
            const fullErrorLogPath = path.join(__dirname, '..', '..', svc.errorLog);

            if (svc.type === 'php' || svc.type === 'static') {
                const fastcgiInclude = nginxFastcgiInclude();
                contentStr = `server {
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
                contentStr = `server {
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

            fs.writeFileSync(confPath, contentStr);

            // Valida NGINX
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
        }

        // Atualiza campos do banco
        svc.name = displayName;
        svc.domain = bindAddress;
        svc.listenPort = parsedListenPort;
        svc.targetPort = parsedTargetPort;
        svc.path = resolvedPath;
        svc.startCmd = startCmd ? startCmd.trim() : '';
        svc.autoRestart = !!autoRestart;
        svc.runAsRoot = !!req.body.runAsRoot;
        svc.updatedAt = new Date().toISOString();

        // 2. Se mudou parâmetros do app ou está online, reinicia processo
        if (svc.type === 'node' || svc.type === 'python') {
            const processParamsChanged = (startCmd && startCmd.trim() !== oldStartCmd) || (parsedTargetPort !== oldTargetPort) || (resolvedPath !== oldPath);
            if (processParamsChanged || svc.status === 'online') {
                if (svc.pid) {
                    try {
                        process.kill(svc.pid, 'SIGKILL');
                    } catch (e) {}
                }
                
                if (svc.status === 'online' || processParamsChanged) {
                    if (svc.type === 'node') {
                        await startNodeProcess(svc, index, services);
                    } else {
                        // python
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
                        svc.pid = child.pid;
                        svc.status = 'online';
                    }
                }
            }
        }

        // 3. Atualiza Cloudflare se houver
        if (svc.cloudflareTunnel && svc.cloudflareTunnel.hostname) {
            try {
                const { upsertCloudflareRouteFromHosting } = require('../../modules/cloudflared/hostingIntegration');
                upsertCloudflareRouteFromHosting({
                    serviceName: displayName,
                    publicHost: svc.cloudflareTunnel.hostname,
                    internalProtocol: 'http',
                    internalHost: '127.0.0.1',
                    internalPort: parsedListenPort,
                    routePath: '/',
                    tunnelName: svc.cloudflareTunnel.tunnelName || svc.slug
                });
            } catch (cfErr) {
                console.error('[Hosting edit] Falha ao atualizar rota do túnel Cloudflare:', cfErr.message);
            }
        }

        services[index] = svc;
        await saveServices(services);

        res.json({ success: true, service: svc });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


router.delete('/:id', async (req, res) => {
    try {
        const services = (await getServices());
        const svc = services.find(s => s.id === req.params.id);
        let cloudflare = { removed: false };

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
        } catch (e) {
            console.error('Nginx reload failed', e);
        }

        const fullLogPath = path.join(__dirname, '..', '..', svc.logFile);
        const fullErrorLogPath = path.join(__dirname, '..', '..', svc.errorLog);
        if (fs.existsSync(fullLogPath)) fs.unlinkSync(fullLogPath);
        if (fs.existsSync(fullErrorLogPath)) fs.unlinkSync(fullErrorLogPath);

        const filtered = services.filter(s => s.id !== req.params.id);
        await saveServices(filtered);

        try {
            if (svc.cloudflareTunnel && svc.cloudflareTunnel.hostname) {
                const { removeCloudflareRouteFromHosting } = require('../../modules/cloudflared/hostingIntegration');
                cloudflare = removeCloudflareRouteFromHosting({
                    serviceName: svc.name,
                    publicHost: svc.cloudflareTunnel.hostname,
                    routePath: '/',
                    tunnelName: svc.cloudflareTunnel.tunnelName || ''
                }) || { removed: false };
            }
        } catch (cfErr) {
            cloudflare = { removed: false, warning: cfErr.message };
        }

        res.json({ success: true, cloudflare });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id/scripts', async (req, res) => {
    try {
        const services = (await getServices());
        const svc = services.find(s => s.id === req.params.id);
        if (!svc) {
            return res.status(404).json({ error: 'Serviço não encontrado' });
        }
        
        const packageJsonPath = path.join(svc.path, 'package.json');
        if (fs.existsSync(packageJsonPath)) {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            return res.json({ success: true, scripts: pkg.scripts || {} });
        }
        res.json({ success: true, scripts: {} });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/dns-check', async (req, res) => {
    try {
        const host = String(req.query.host || '').trim();
        if (!host) return res.status(400).json({ success: false, error: 'Informe o parâmetro host.' });
        const status = await resolveDnsStatus(host);
        return res.json({ success: true, status });
    } catch (e) {
        return res.status(500).json({ success: false, error: e.message });
    }
});

router.post('/:id/toggle', async (req, res) => {
    const { active, customCmd } = req.body;
    try {
        const services = (await getServices());
        const index = services.findIndex(s => s.id === req.params.id);
        if (index === -1) {
            return res.status(404).json({ error: 'Serviço não encontrado' });
        }
        
        const svc = services[index];
        
        if (active) {
            if (svc.type !== 'node' && svc.type !== 'python') {
                return res.status(400).json({ error: 'Este tipo de serviço não possui processos associados.' });
            }
            
            if (svc.type === 'node') {
                await startNodeProcess(svc, index, services, customCmd);
            } else {
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
            }
        } else {
            if (svc.pid) {
                try {
                    process.kill(svc.pid, 'SIGKILL');
                } catch (e) {}
            }
            services[index].pid = null;
            services[index].status = 'stopped';
        }
        
        await saveServices(services);
        res.json({ success: true, service: services[index] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/:id/logs', async (req, res) => {
    try {
        const services = (await getServices());
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
        
        const services = (await getServices());
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
                        if (svc.type === 'node') {
                            await startNodeProcess(svc, i, services);
                        } else {
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
                        }
                        modified = true;
                    } catch (err) {
                        console.error(`[Daemon] Falha ao auto-reiniciar ${svc.name}:`, err.message);
                    }
                }
            }
        }
        
        if (modified) {
            await saveServices(services);
        }
    } catch (e) {
        console.error('[Daemon Auto-Restart] Erro:', e.message);
    }
}, 15000);

module.exports = router;
