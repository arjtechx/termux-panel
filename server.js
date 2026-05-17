const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { exec, spawn } = require('child_process');
const os = require('os');
const http = require('http');
const { Server } = require('socket.io');
const axios = require('axios');
const { Client } = require('ssh2');
const mysql = require('mysql2/promise');
const net = require('net');
const crypto = require('crypto');

// Auto-instala dependências ausentes antes do require principal (evita falhas de deploy no Termux)
try {
    require('http-proxy-middleware');
} catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
        console.log('[WARN] Biblioteca http-proxy-middleware ausente. Instalando automaticamente...');
        const { execSync } = require('child_process');
        try {
            execSync('npm install http-proxy-middleware --no-save', { stdio: 'inherit' });
            console.log('[OK] http-proxy-middleware instalado com sucesso! Reiniciando servidor para aplicar as alterações...');
            process.exit(0); // Sai limpo (código 0) e deixa o loop do terminal reiniciar o servidor com o cache do Node limpo!
        } catch (err) {
            console.error('[ERR] Falha ao auto-instalar dependência:', err.message);
            process.exit(1);
        }
    }
}

const { createProxyMiddleware } = require('http-proxy-middleware');
const fileBrowserService = require('./services/filebrowser-service');
const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const SERVER_CONFIG_FILE = path.join(__dirname, 'config', 'server.json');
let PORT = 8088;
if (fs.existsSync(SERVER_CONFIG_FILE)) {
    try {
        const serverConfig = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8'));
        if (serverConfig.port) {
            PORT = parseInt(serverConfig.port) || 8088;
        }
    } catch(e) {}
}

const session = require('express-session');
const APPS_FILE = path.join(__dirname, 'config', 'apps.json');
const NOIP_FILE = path.join(__dirname, 'config', 'noip.json');
const DB_FILE = path.join(__dirname, 'config', 'db.json');
const AUTH_FILE = path.join(__dirname, 'config', 'auth.json');
const SYSTEM_FILE = path.join(__dirname, 'config', 'system.json');
const BASE_DIR = process.env.HOME || __dirname;

let systemConfig = { is_termux: true, has_root: false, package_manager: 'pkg', prefix: process.env.PREFIX || '/data/data/com.termux/files/usr' };
try {
    if (fs.existsSync(SYSTEM_FILE)) {
        systemConfig = JSON.parse(fs.readFileSync(SYSTEM_FILE, 'utf8'));
        if (typeof systemConfig.has_root !== 'boolean') throw new Error('Invalid config');
    } else {
        fs.writeFileSync(SYSTEM_FILE, JSON.stringify(systemConfig, null, 4));
    }
} catch (e) {
    systemConfig = { is_termux: true, has_root: false, package_manager: 'pkg', prefix: process.env.PREFIX || '/data/data/com.termux/files/usr' };
    try { fs.writeFileSync(SYSTEM_FILE, JSON.stringify(systemConfig, null, 4)); } catch(err){}
}

// Detecção dinâmica de ambiente: Força o modo WSL/Linux se não estiver em um Termux real
const isRealTermux = !!(process.env.PREFIX && process.env.PREFIX.includes('com.termux'));
if (!isRealTermux) {
    systemConfig.is_termux = false;
    systemConfig.prefix = '/usr';
    systemConfig.package_manager = 'apt';
}
const BACKUP_DIR = path.join(BASE_DIR, 'backups');

// Initialize config directory
if (!fs.existsSync(path.join(__dirname, 'config'))) {
    fs.mkdirSync(path.join(__dirname, 'config'), { recursive: true });
}

// Initialize default files if missing
if (!fs.existsSync(APPS_FILE)) fs.writeFileSync(APPS_FILE, '[]');
if (!fs.existsSync(NOIP_FILE)) fs.writeFileSync(NOIP_FILE, JSON.stringify({ interval: 15, autostart: false }));
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ host: 'localhost', user: 'root', password: '' }));
if (!fs.existsSync(AUTH_FILE)) fs.writeFileSync(AUTH_FILE, JSON.stringify({ user: 'admin', pass: 'admin' }));

app.use(cors());
app.use(express.json());
app.use(session({
    secret: 'termux-cpanel-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Auth Middleware
function checkAuth(req, res, next) {
    if (
        req.path === '/login' || 
        req.path === '/login.html' || 
        req.path.startsWith('/api/login') || 
        req.path.startsWith('/socket.io/') || 
        req.path.endsWith('.css') || 
        req.path.endsWith('.js') ||
        req.path === '/api/phpmyadmin/validate-token' ||
        req.path === '/api/pma/sso/validate' ||
        req.path === '/api/database/verify-token' ||
        req.path === '/api/phpmyadmin/validate' ||
        req.path.startsWith('/__filebrowser')
    ) {
        return next();
    }
    if (req.session && req.session.authenticated) {
        return next();
    }
    if (req.path.startsWith('/api')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.redirect('/login.html');
}

app.use(checkAuth);
app.use(express.static(path.join(__dirname, 'public')));
// --- Auth Routes ---
app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    try {
        const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
        if (user === auth.user && pass === auth.pass) {
            req.session.authenticated = true;
            res.json({ success: true });
        } else {
            res.status(401).json({ error: 'Credenciais inválidas' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// --- NO-IP Updater Variables ---
let noipInterval = null;
let noipStatus = { status: 'Parado', lastUpdate: 'N/A', currentIP: 'N/A', log: [] };

function logNoip(msg) {
    noipStatus.log.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
    if (noipStatus.log.length > 50) noipStatus.log.pop();
    io.emit('noip-log', noipStatus);
}

// --- Socket.io Terminal Logic ---
io.on('connection', (socket) => {
    let sshConn = new Client();

    socket.on('terminal-connect', (config) => {
        sshConn.on('ready', () => {
            socket.emit('terminal-data', '\r\n*** Conexão SSH Estabelecida ***\r\n');
            sshConn.shell((err, stream) => {
                if (err) return socket.emit('terminal-data', '\r\n*** Erro no Shell: ' + err.message + ' ***\r\n');
                
                socket.on('terminal-input', (data) => stream.write(data));
                stream.on('data', (data) => socket.emit('terminal-data', data.toString()));
                stream.on('close', () => {
                    sshConn.end();
                    socket.emit('terminal-data', '\r\n*** Conexão Encerrada ***\r\n');
                });
            });
        }).on('error', (err) => {
            socket.emit('terminal-data', '\r\n*** Erro na Conexão: ' + err.message + ' ***\r\n');
        }).connect({
            host: config.host || '127.0.0.1',
            port: config.port || 8022,
            username: config.username,
            password: config.password
        });
    });

    socket.on('disconnect', () => {
        sshConn.end();
        if (logTail) logTail.kill();
    });

    // --- Log Viewer Logic ---
    let logTail = null;
    socket.on('log-start', (filePath) => {
        if (logTail) logTail.kill();

        // Resolução inteligente de caminhos padrão do Linux para o Termux
        let resolvedPath = filePath;
        const termuxPrefix = process.env.PREFIX || '/data/data/com.termux/files/usr';
        
        if (filePath.startsWith('/var/log/')) {
            resolvedPath = path.join(termuxPrefix, filePath);
        } else if (filePath.startsWith('var/log/')) {
            resolvedPath = path.join(termuxPrefix, '/' + filePath);
        }

        if (!fs.existsSync(resolvedPath)) {
            return socket.emit('log-data', `*** Arquivo não encontrado: ${resolvedPath} ***\r\n`);
        }

        logTail = spawn('tail', ['-f', resolvedPath]);
        logTail.stdout.on('data', (data) => {
            socket.emit('log-data', data.toString());
        });
        logTail.stderr.on('data', (data) => {
            socket.emit('log-data', `ERRO: ${data.toString()}`);
        });
        logTail.on('close', () => {
            socket.emit('log-data', '*** Monitoramento encerrado ***\r\n');
        });
    });

    socket.on('log-stop', () => {
        if (logTail) {
            logTail.kill();
            logTail = null;
        }
    });
});

// Restaura permissões caso arquivos de log/config sejam tocados pelo root
async function chownToUser(pathsArray) {
    if (!systemConfig.has_root || !systemConfig.is_termux || !pathsArray || pathsArray.length === 0) return;
    try {
        let uid = typeof process.getuid === 'function' ? process.getuid() : null;
        let gid = typeof process.getgid === 'function' ? process.getgid() : null;
        let owner = (uid !== null && gid !== null) ? `${uid}:${gid}` : os.userInfo().username;
        if (!owner) return;
        
        const safePaths = pathsArray.map(p => `"${p.replace(/"/g, '\\"')}"`).join(' ');
        await runCmd(`chown -R ${owner} ${safePaths}`, true);
    } catch (e) {
        console.error("chownToUser falhou:", e);
    }
}

// Utils to run commands safely
function runCmd(cmd, needsRoot = false) {
    return new Promise((resolve, reject) => {
        if (needsRoot) {
            if (!systemConfig.has_root) {
                return reject(new Error('Esta ação requer privilégios de Superusuário (Root).'));
            }
            if (systemConfig.is_termux) {
                cmd = `su -c ${JSON.stringify(cmd)}`;
            } else {
                cmd = `sudo ${cmd}`;
            }
        }
        exec(cmd, (error, stdout, stderr) => {
            if (error && !needsRoot) resolve('');
            else if (error && needsRoot) reject(error);
            else resolve(stdout.trim());
        });
    });
}

function checkPortStatus(port) {
    return new Promise((resolve) => {
        const socket = new net.Socket();
        socket.setTimeout(2000);
        socket.on('connect', () => {
            socket.destroy();
            resolve('Online');
        });
        socket.on('timeout', () => {
            socket.destroy();
            resolve('Offline');
        });
        socket.on('error', () => {
            socket.destroy();
            resolve('Offline');
        });
        socket.connect(port, '127.0.0.1');
    });
}

// Routes
app.get('/api/status', async (req, res) => {
    try {
        let status = {
            cpu: '0%',
            cpuCores: os.cpus().length,
            cpuSpeed: 'N/A',
            ram: '0 / 0',
            storage: '0 / 0',
            storagePercent: '0',
            temperature: 'N/A',
            netDown: '0',
            netUp: '0',
            totalDown: '0',
            totalUp: '0'
        };

        // Termux / Linux commands
        const topOut = await runCmd('top -bn1 | head -n 5');
        const freeOut = await runCmd('free -m');
        const dfOut = await runCmd('df -h /data');
        const batteryOut = await runCmd('termux-battery-status');
        const netOut = await runCmd('cat /proc/net/dev');
        const freqOut = await runCmd('cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq');

        // Parse CPU (Very simplistic parse, fallback to os loadavg)
        status.cpu = `${Math.round(os.loadavg()[0] * 100)}%`;
        
        // CPU Speed
        const speeds = os.cpus().map(c => c.speed).filter(s => s > 0);
        if (speeds.length > 0) {
            status.cpuSpeed = `${(speeds[0] / 1000).toFixed(2)} GHz`;
        } else if (freqOut && !isNaN(freqOut)) {
            status.cpuSpeed = `${(parseInt(freqOut) / 1000000).toFixed(2)} GHz`;
        }

        // Parse RAM
        const ramMatch = freeOut.match(/Mem:\s+(\d+)\s+(\d+)/);
        if (ramMatch) {
            status.ram = `${ramMatch[2]}MB / ${ramMatch[1]}MB`;
        }

        // Parse Storage
        const lines = dfOut.split('\n');
        if (lines.length > 1) {
            const parts = lines[1].trim().split(/\s+/);
            if (parts.length >= 5) {
                // parts[1] = Total, parts[2] = Used, parts[3] = Avail, parts[4] = Use%
                status.storageFree = parts[3];
                status.storageTotal = parts[1];
                status.storagePercent = parts[4].replace('%', '');
            }
        }

        // Parse Temperature
        try {
            if (batteryOut) {
                const batInfo = JSON.parse(batteryOut);
                if (batInfo.temperature) {
                    status.temperature = `${batInfo.temperature}°C`;
                }
            }
        } catch (e) {}

        // Parse Network
        const netMatch = netOut.match(/wlan0:\s+(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
        if (netMatch) {
            status.totalDown = `${(parseInt(netMatch[1]) / 1024 / 1024).toFixed(2)} MB`;
            status.totalUp = `${(parseInt(netMatch[2]) / 1024 / 1024).toFixed(2)} MB`;
        }

        res.json(status);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/apps', async (req, res) => {
    try {
        const apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
        const enhancedApps = await Promise.all(apps.map(async (app) => {
            app.status = await checkPortStatus(app.port);
            return app;
        }));
        res.json(enhancedApps);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/apps', (req, res) => {
    try {
        const apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
        const newApp = { id: Date.now().toString(), ...req.body };
        apps.push(newApp);
        fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
        res.json(newApp);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/apps/:id', (req, res) => {
    try {
        let apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
        const index = apps.findIndex(a => a.id === req.params.id);
        if (index !== -1) {
            apps[index] = { ...apps[index], ...req.body };
            fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
            res.json(apps[index]);
        } else {
            res.status(404).json({ error: 'App not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/apps/:id', (req, res) => {
    try {
        let apps = JSON.parse(fs.readFileSync(APPS_FILE, 'utf8'));
        apps = apps.filter(a => a.id !== req.params.id);
        fs.writeFileSync(APPS_FILE, JSON.stringify(apps, null, 2));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/processes', async (req, res) => {
    try {
        const psOut = await runCmd('ps aux | head -n 20');
        const lines = psOut.split('\n').slice(1);
        const procs = lines.map(line => {
            const parts = line.trim().split(/\s+/);
            if (parts.length >= 11) {
                return {
                    user: parts[0],
                    pid: parts[1],
                    cpu: parts[2],
                    ram: parts[3],
                    command: parts.slice(10).join(' ')
                };
            }
            return null;
        }).filter(p => p !== null);

        res.json(procs);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/processes/:pid/kill', async (req, res) => {
    try {
        const pid = parseInt(req.params.pid);
        if (!pid) throw new Error('Invalid PID');
        await runCmd(`kill -9 ${pid}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Backup Manager Logic ---
app.post('/api/backup', async (req, res) => {
    try {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `backup-${timestamp}.tar.gz`;
        const targetFile = path.join(BACKUP_DIR, filename);
        
        // Backup files and database
        const dbConfig = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const dbDump = dbConfig.password 
            ? `mysqldump -u ${dbConfig.user} -p${dbConfig.password} --all-databases > ${BACKUP_DIR}/db_dump.sql`
            : `mysqldump -u ${dbConfig.user} --all-databases > ${BACKUP_DIR}/db_dump.sql`;

        await runCmd(dbDump);
        // Exclude the backup dir itself to avoid recursion
        await runCmd(`tar -czvf ${targetFile} --exclude='backups' -C ${BASE_DIR} .`);
        
        res.json({ success: true, filename });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/backup/download', (req, res) => {
    const { file } = req.query;
    const filePath = path.join(BACKUP_DIR, file);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send('Backup não encontrado');
    }
});

// Termux Power & Services Controls
app.post('/api/reboot', async (req, res) => {
    try {
        await runCmd('reboot', true);
        res.json({ success: true, message: 'Rebooting...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

let wakelockState = false;
app.post('/api/wakelock', async (req, res) => {
    try {
        wakelockState = !wakelockState;
        const cmd = wakelockState ? 'termux-wake-lock' : 'termux-wake-unlock';
        await runCmd(cmd);
        res.json({ success: true, message: `Wakelock ${wakelockState ? 'Ativado' : 'Desativado'}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

let sshdState = false;
app.post('/api/sshd', async (req, res) => {
    try {
        sshdState = !sshdState;
        if (sshdState) {
            await runCmd('sshd');
        } else {
            await runCmd('pkill sshd');
        }
        res.json({ success: true, message: `SSHD ${sshdState ? 'Iniciado' : 'Parado'}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

let mariadbState = false;
app.post('/api/mariadb/toggle', async (req, res) => {
    try {
        if (!mariadbState) {
            // Start MariaDB
            await runCmd(`mariadbd-safe --datadir=${process.env.PREFIX}/var/lib/mysql > /dev/null 2>&1 &`);
            mariadbState = true;
        } else {
            // Stop MariaDB
            await runCmd('pkill mariadbd');
            mariadbState = false;
        }
        res.json({ success: true, message: `MariaDB ${mariadbState ? 'Iniciado' : 'Parado'}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Cronjobs Manager Logic ---
app.get('/api/cron', async (req, res) => {
    try {
        const cronOut = await runCmd('crontab -l');
        res.json({ cron: cronOut || '' });
    } catch (err) {
        // crontab -l returns error if no crontab exists
        res.json({ cron: '' });
    }
});

app.post('/api/cron', async (req, res) => {
    const { cron } = req.body;
    try {
        // Escaping single quotes for echo
        const escapedCron = cron.replace(/'/g, "'\\''");
        await runCmd(`echo '${escapedCron}' | crontab -`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Hospedagem (Sites & Apps) Logic ---
const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
const NGINX_CONF_DIR = `${PREFIX}/etc/nginx/conf.d`;
const HOSTING_FILE = path.join(__dirname, 'config', 'hosting.json');
const HOSTING_LOGS_DIR = path.join(__dirname, 'logs');

if (!fs.existsSync(HOSTING_FILE)) {
    fs.writeFileSync(HOSTING_FILE, '[]');
}
if (!fs.existsSync(HOSTING_LOGS_DIR)) {
    fs.mkdirSync(HOSTING_LOGS_DIR, { recursive: true });
}

// Utility to check if port is currently in use/listening using ss -tulpn or net fallback
function isPortListening(port) {
    return new Promise((resolve) => {
        exec('ss -tulpn', (err, stdout) => {
            if (!err && stdout) {
                const regex = new RegExp(':' + port + '(\\b|\\s)');
                if (regex.test(stdout)) {
                    return resolve(true);
                }
            }
            // Fallback usando net
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

// GET list of hosting services with real-time status checking
app.get('/api/hosting', async (req, res) => {
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

// POST create a new hosting service with validations and auto Nginx config generation
app.post('/api/hosting', async (req, res) => {
    const { name, domain, type, listenPort, targetPort, path: sitePath, startCmd, autoRestart, createIndex } = req.body;
    
    const id = Date.now().toString();
    const parsedListenPort = parseInt(listenPort);
    const parsedTargetPort = targetPort ? parseInt(targetPort) : null;
    
    try {
        if (parsedListenPort < 1024 && !systemConfig.has_root) {
            return res.status(400).json({ error: `A porta pública ${parsedListenPort} é restrita (menor que 1024) e requer permissão de Root. Ative o Root no instalador ou use uma porta maior (ex: 8080).` });
        }

        if (await isPortListening(parsedListenPort)) {
            return res.status(400).json({ error: `A porta pública ${parsedListenPort} já está em uso por outro serviço.` });
        }
        
        if (parsedTargetPort && (type === 'node' || type === 'python' || type === 'proxy')) {
            if (await isPortListening(parsedTargetPort)) {
                return res.status(400).json({ error: `A porta interna ${parsedTargetPort} já está em uso por outra aplicação.` });
            }
        }
        
        const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
        const nginxConf = `hosting-${cleanName}-${id}.conf`;
        const confPath = path.join(NGINX_CONF_DIR, nginxConf);
        const logFile = `logs/hosting-${cleanName}-${id}.log`;
        const errorLog = `logs/hosting-${cleanName}-${id}-error.log`;
        const publicUrl = `http://${domain || '127.0.0.1'}:${parsedListenPort}`;
        
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
        const fullLogPath = path.join(__dirname, 'logs', `hosting-${cleanName}-${id}.log`);
        const fullErrorLogPath = path.join(__dirname, 'logs', `hosting-${cleanName}-${id}-error.log`);
        
        if (type === 'php' || type === 'static') {
            content = `server {
    listen 0.0.0.0:${parsedListenPort};
    server_name _;
    root ${resolvedPath};
    index index.php index.html index.htm;
    access_log ${fullLogPath};
    error_log ${fullErrorLogPath};

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        include fastcgi_params;
        fastcgi_pass 127.0.0.1:9000;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
    }
}`;
        } else {
            const proxyPort = parsedTargetPort;
            content = `server {
    listen 0.0.0.0:${parsedListenPort};
    server_name _;
    access_log ${fullLogPath};
    error_log ${fullErrorLogPath};

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
            await runCmd('nginx -s reload', requireRoot);
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

// DELETE a hosting service
app.delete('/api/hosting/:id', async (req, res) => {
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
            await runCmd('nginx -s reload', requireRoot);
            if (requireRoot) {
                await chownToUser([NGINX_CONF_DIR, HOSTING_LOGS_DIR]);
            }
        } catch(e) { console.error("Nginx reload failed", e); }
        
        const fullLogPath = path.join(__dirname, svc.logFile);
        const fullErrorLogPath = path.join(__dirname, svc.errorLog);
        if (fs.existsSync(fullLogPath)) fs.unlinkSync(fullLogPath);
        if (fs.existsSync(fullErrorLogPath)) fs.unlinkSync(fullErrorLogPath);
        
        const filtered = services.filter(s => s.id !== req.params.id);
        fs.writeFileSync(HOSTING_FILE, JSON.stringify(filtered, null, 2));
        
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST toggle app process active status
app.post('/api/hosting/:id/toggle', async (req, res) => {
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
            
            const fullLogPath = path.join(__dirname, svc.logFile);
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

// GET real-time process logs
app.get('/api/hosting/:id/logs', (req, res) => {
    try {
        const services = JSON.parse(fs.readFileSync(HOSTING_FILE, 'utf8'));
        const svc = services.find(s => s.id === req.params.id);
        if (!svc) {
            return res.status(404).json({ error: 'Serviço não encontrado' });
        }
        
        const fullLogPath = path.join(__dirname, svc.logFile);
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

// Interval Auto-Restart Daemon (every 15 seconds)
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
                        const fullLogPath = path.join(__dirname, svc.logFile);
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

// --- NGINX Manager Logic ---

app.get('/api/nginx', (req, res) => {
    try {
        if (!fs.existsSync(NGINX_CONF_DIR)) fs.mkdirSync(NGINX_CONF_DIR, { recursive: true });
        const files = fs.readdirSync(NGINX_CONF_DIR).filter(f => f.endsWith('.conf'));
        const sites = files.map(file => {
            const content = fs.readFileSync(path.join(NGINX_CONF_DIR, file), 'utf8');
            const domainMatch = content.match(/server_name\s+([^;]+);/);
            const listenMatch = content.match(/listen\s+(\d+)/);
            const proxyMatch = content.match(/proxy_pass\s+http:\/\/(?:127\.0\.0\.1|localhost):(\d+);/);
            
            let targetPort = '?';
            if (proxyMatch) {
                targetPort = `${proxyMatch[1]} (Proxy)`;
            } else if (listenMatch) {
                targetPort = `${listenMatch[1]} (Direto)`;
            }

            return {
                file,
                domain: domainMatch ? domainMatch[1].trim() : '?',
                port: targetPort
            };
        });
        res.json({ sites });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/nginx', async (req, res) => {
    const { domain, listenPort, type, port, path: sitePath } = req.body;
    const listen = listenPort || 8080;
    const confName = `${domain}.conf`;
    const confPath = path.join(NGINX_CONF_DIR, confName);
    let content = '';

    if (type === 'static') {
        const docRoot = sitePath ? sitePath.replace(/\/$/, '') : '/data/data/com.termux/files/home';
        // Procura o socket do PHP-FPM
        const phpSock = fs.existsSync(`${PREFIX}/var/run/php-fpm.sock`) 
                        ? `${PREFIX}/var/run/php-fpm.sock` 
                        : `${PREFIX}/tmp/php-fpm.sock`;
                        
        content = `server {
    listen ${listen};
    server_name ${domain};
    root ${docRoot};
    index index.php index.html index.htm;

    location / {
        try_files $uri $uri/ =404;
    }

    location ~ \\.php$ {
        fastcgi_pass unix:${phpSock};
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }

    location ~ /\\.(ht|git) {
        deny all;
    }
}`;
    } else {
        content = `server {
    listen ${listen};
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}`;
    }

    try {
        fs.writeFileSync(confPath, content);
        await runCmd('nginx -s reload');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/nginx', async (req, res) => {
    const { file } = req.query;
    try {
        fs.unlinkSync(path.join(NGINX_CONF_DIR, file));
        await runCmd('nginx -s reload');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/nginx/action', async (req, res) => {
    const { action } = req.body;
    try {
        if (action === 'start') {
            await runCmd('nginx');
        } else if (action === 'stop') {
            await runCmd('nginx -s stop');
            await runCmd('pkill nginx');
        } else if (action === 'restart') {
            await runCmd('nginx -t'); // check syntax
            await runCmd('nginx -s stop');
            await runCmd('pkill nginx');
            await new Promise(r => setTimeout(r, 500));
            await runCmd('nginx');
        } else if (action === 'reload') {
            await runCmd('nginx -s reload');
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Database Manager Logic ---
async function getDbConn() {
    const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return await mysql.createConnection(config);
}

// Lista bancos com tamanho
app.get('/api/db', async (req, res) => {
    try {
        const conn = await getDbConn();
        const [rows] = await conn.query('SHOW DATABASES');
        const [sizeRows] = await conn.query(`
            SELECT table_schema AS name,
                   ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS size_mb
            FROM information_schema.tables
            GROUP BY table_schema
        `);
        await conn.end();
        const sizeMap = {};
        sizeRows.forEach(r => sizeMap[r.name] = r.size_mb);
        res.json({ databases: rows.map(r => ({ name: r.Database, size_mb: sizeMap[r.Database] || 0 })) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Status completo do MariaDB
app.get('/api/db/status', async (req, res) => {
    try {
        const conn = await getDbConn();
        const [[{ Value: uptime }]]     = await conn.query("SHOW GLOBAL STATUS LIKE 'Uptime'");
        const [[{ Value: threads }]]    = await conn.query("SHOW GLOBAL STATUS LIKE 'Threads_connected'");
        const [[{ Value: questions }]]  = await conn.query("SHOW GLOBAL STATUS LIKE 'Questions'");
        const [sizeRows] = await conn.query(`
            SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS total_mb
            FROM information_schema.tables
        `);
        const [dbCountRows] = await conn.query('SHOW DATABASES');
        await conn.end();

        // RAM usage via ps
        const ramOut = await runCmd('ps aux | grep mariad | grep -v grep | awk \'{print $4}\'');
        const ramPct = ramOut.trim().split('\n')[0] || 'N/A';

        const uptimeSec = parseInt(uptime);
        const h = Math.floor(uptimeSec / 3600);
        const m = Math.floor((uptimeSec % 3600) / 60);
        const uptimeStr = `${h}h ${m}m`;

        res.json({
            online:      true,
            port:        3306,
            uptime:      uptimeStr,
            connections: threads,
            queries:     questions,
            totalSizeMb: sizeRows[0]?.total_mb || 0,
            dbCount:     dbCountRows.length,
            ramPct:      ramPct,
        });
    } catch (err) {
        // Fallback: se a conexão via Driver MySQL falhar (ex: credenciais/Access Denied), mas o processo do banco estiver ativo na porta
        const isRunning = await isMariaDBRunning();
        if (isRunning) {
            return res.json({
                online:      true,
                port:        3306,
                uptime:      'Ativo (Sem login)',
                connections: '0',
                queries:     '0',
                totalSizeMb: 0,
                dbCount:     0,
                ramPct:      'N/A',
                warning:     `Erro de Conexão: ${err.message}`
            });
        }
        res.json({ online: false, error: err.message });
    }
});

// Test connection
app.get('/api/db/test', async (req, res) => {
    try {
        const conn = await getDbConn();
        await conn.ping();
        await conn.end();
        res.json({ success: true, message: 'Conexão OK!' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

app.post('/api/db/setup', (req, res) => {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Criar banco + usuário
app.post('/api/db/create', async (req, res) => {
    const { dbName, dbUser, dbPass } = req.body;
    try {
        const conn = await getDbConn();
        await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
        if (dbUser && dbPass) {
            await conn.query(`CREATE USER IF NOT EXISTS ?@'localhost' IDENTIFIED BY ?`, [dbUser, dbPass]);
            await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO ?@'localhost'`, [dbUser]);
            await conn.query('FLUSH PRIVILEGES');
        }
        await conn.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Drop banco
app.delete('/api/db/:name', async (req, res) => {
    try {
        const conn = await getDbConn();
        await conn.query(`DROP DATABASE IF EXISTS \`${req.params.name}\``);
        await conn.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Criar apenas usuário
app.post('/api/db/user', async (req, res) => {
    const { username, password, database } = req.body;
    try {
        const conn = await getDbConn();
        await conn.query(`CREATE USER IF NOT EXISTS ?@'localhost' IDENTIFIED BY ?`, [username, password]);
        if (database) {
            await conn.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO ?@'localhost'`, [username]);
        }
        await conn.query('FLUSH PRIVILEGES');
        await conn.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Backup de um banco específico
app.post('/api/db/backup', async (req, res) => {
    const { dbName } = req.body;
    try {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `db-${dbName || 'all'}-${ts}.sql`;
        const filePath = path.join(BACKUP_DIR, filename);
        const passArg = config.password ? `-p${config.password}` : '';
        const dbArg = dbName ? `\`${dbName}\`` : '--all-databases';
        await runCmd(`mysqldump -u ${config.user} ${passArg} ${dbArg} > "${filePath}"`);
        res.json({ success: true, filename });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Restaurar backup SQL
app.post('/api/db/restore', async (req, res) => {
    const { filename, dbName } = req.body;
    try {
        const config   = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const filePath = path.join(BACKUP_DIR, filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
        const passArg = config.password ? `-p${config.password}` : '';
        const dbArg   = dbName ? `\`${dbName}\`` : '';
        await runCmd(`mysql -u ${config.user} ${passArg} ${dbArg} < "${filePath}"`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Listar backups SQL
app.get('/api/db/backups', (req, res) => {
    try {
        if (!fs.existsSync(BACKUP_DIR)) return res.json({ backups: [] });
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.endsWith('.sql'))
            .map(f => {
                const stats = fs.statSync(path.join(BACKUP_DIR, f));
                return { name: f, size: (stats.size / 1024).toFixed(1) + ' KB', date: stats.mtime.toLocaleString() };
            })
            .sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json({ backups: files });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─── ADVANCED DATABASE MANAGER LAYER ──────────────────────────────
const LOGS_DIR = path.join(__dirname, 'logs');
const DB_ACTIONS_LOG = path.join(LOGS_DIR, 'database-actions.log');

// Logger helper
function logDbAction(action, db, user, status, error = '') {
    try {
        if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
        const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const line = `[${ts}] [USER: ${user || 'admin'}] [ACTION: ${action}] [DB: ${db}] [STATUS: ${status}] ${error ? '[ERROR: ' + error + ']' : ''}\n`;
        fs.appendFileSync(DB_ACTIONS_LOG, line, 'utf8');
        chownToUser([DB_ACTIONS_LOG]).catch(() => {});
    } catch(e) {
        console.error('Falha ao gravar log de banco:', e.message);
    }
}

// Protected System Databases
const PROTECTED_SYSTEM_DBS = ['information_schema', 'mysql', 'performance_schema', 'sys'];

function isSystemDb(dbName) {
    if (!dbName) return false;
    return PROTECTED_SYSTEM_DBS.includes(dbName.toLowerCase());
}

// Input Sanitization
function sanitizeDbName(name) {
    if (!name) return '';
    return name.replace(/[^a-zA-Z0-9_]/g, '');
}

function sanitizeUsername(name) {
    if (!name) return '';
    return name.replace(/[^a-zA-Z0-9_-]/g, '');
}

// API: Database details (size, engine, collations, tables count, total rows, mtime)
app.get('/api/db/details', async (req, res) => {
    const dbName = sanitizeDbName(req.query.db);
    if (!dbName) return res.status(400).json({ error: 'Nome do banco é obrigatório.' });

    try {
        const conn = await getDbConn();
        
        // Count tables & rows
        const [tables] = await conn.query(`
            SELECT 
                table_name AS name,
                engine,
                table_rows AS rows_count,
                ROUND((data_length + index_length) / 1024 / 1024, 2) AS size_mb,
                table_collation AS collation,
                create_time AS created_at
            FROM information_schema.tables
            WHERE table_schema = ?
        `, [dbName]);

        await conn.end();

        if (tables.length === 0) {
            return res.json({
                success: true,
                tablesCount: 0,
                totalRows: 0,
                totalSizeMb: 0,
                engine: 'InnoDB',
                collation: 'utf8mb4_general_ci',
                largestTable: 'N/A',
                tables: []
            });
        }

        let totalRows = 0;
        let totalSize = 0;
        let largestTable = '';
        let largestSize = -1;
        let engine = tables[0].engine || 'InnoDB';
        let collation = tables[0].collation || 'utf8mb4_general_ci';

        tables.forEach(t => {
            totalRows += (t.rows_count || 0);
            totalSize += (t.size_mb || 0);
            if (t.size_mb > largestSize) {
                largestSize = t.size_mb;
                largestTable = `${t.name} (${t.size_mb} MB)`;
            }
        });

        res.json({
            success: true,
            tablesCount: tables.length,
            totalRows,
            totalSizeMb: totalSize.toFixed(2),
            engine,
            collation,
            largestTable,
            tables: tables.slice(0, 50)
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Safe Rename Database (Backup -> Create -> Copy tables -> Compare table count and size -> drop old database ONLY if deleteOld=true)
app.post('/api/db/rename', async (req, res) => {
    const oldName = sanitizeDbName(req.body.oldName);
    const newName = sanitizeDbName(req.body.newName);
    const deleteOld = req.body.deleteOld === true;

    if (!oldName || !newName) {
        return res.status(400).json({ error: 'Nomes de banco de origem e destino são obrigatórios.' });
    }

    if (isSystemDb(oldName) || isSystemDb(newName)) {
        logDbAction('RENAME', oldName, req.session.adminUser, 'FAILED', 'Tentativa de renomear banco de sistema protegido.');
        return res.status(403).json({ error: 'Operação proibida em bancos de dados de sistema protegidos.' });
    }

    try {
        const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const passArg = config.password ? `-p${config.password}` : '';
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        
        // 1. Efetua backup automático pré-rename
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const backupFile = `db-RENAME-AUTO-${oldName}-${ts}.sql`;
        const backupPath = path.join(BACKUP_DIR, backupFile);
        await runCmd(`mysqldump -u ${config.user} ${passArg} \`${oldName}\` > "${backupPath}"`);

        // 2. Cria novo banco
        const conn = await getDbConn();
        await conn.query(`CREATE DATABASE IF NOT EXISTS \`${newName}\``);
        
        // 3. Importa backup para o novo banco
        await runCmd(`mysql -u ${config.user} ${passArg} \`${newName}\` < "${backupPath}"`);

        // 4. Validação: Contagem de tabelas & Tamanho
        const [[{ count: oldTables }]] = await conn.query('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ?', [oldName]);
        const [[{ count: newTables }]] = await conn.query('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ?', [newName]);

        const [[{ size: oldSize }]] = await conn.query('SELECT SUM(data_length + index_length) AS size FROM information_schema.tables WHERE table_schema = ?', [oldName]);
        const [[{ size: newSize }]] = await conn.query('SELECT SUM(data_length + index_length) AS size FROM information_schema.tables WHERE table_schema = ?', [newName]);

        await conn.end();

        if (oldTables !== newTables) {
            logDbAction('RENAME', oldName, req.session.adminUser, 'FAILED', `Inconsistência de tabelas: ${oldTables} vs ${newTables}`);
            return res.status(500).json({ error: 'A cópia de tabelas falhou. Contagem de tabelas destino não bate com a de origem.' });
        }

        let deletedOldDb = false;
        if (deleteOld) {
            const dropConn = await getDbConn();
            await dropConn.query(`DROP DATABASE IF EXISTS \`${oldName}\``);
            await dropConn.end();
            deletedOldDb = true;
        }

        logDbAction('RENAME', `${oldName} -> ${newName}`, req.session.adminUser, 'SUCCESS');
        res.json({
            success: true,
            message: `Banco duplicado com sucesso! Cópia validada (${newTables} tabelas).`,
            deletedOld: deletedOldDb,
            backupFile
        });
    } catch(err) {
        logDbAction('RENAME', oldName, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: List Database Users and general MySQL users
app.get('/api/db/users', async (req, res) => {
    const dbName = sanitizeDbName(req.query.db);
    try {
        const conn = await getDbConn();
        
        // List users having privileges on this db
        const [dbPrivRows] = await conn.query(`
            SELECT DISTINCT User, Host FROM mysql.db WHERE Db = ? OR Db = '*'
        `, [dbName]);

        // List all MySQL users
        const [allUserRows] = await conn.query('SELECT User, Host FROM mysql.user');
        await conn.end();

        res.json({
            success: true,
            dbUsers: dbPrivRows.map(r => ({ user: r.User, host: r.Host })),
            allUsers: allUserRows.map(r => ({ user: r.User, host: r.Host }))
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Create DB user (forced to localhost for safety)
app.post('/api/db/user/create', async (req, res) => {
    const username = sanitizeUsername(req.body.username);
    const password = req.body.password;
    const host = 'localhost';

    if (!username || !password) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    try {
        const conn = await getDbConn();
        await conn.query(`CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?`, [username, host, password]);
        await conn.query('FLUSH PRIVILEGES');
        await conn.end();

        logDbAction('CREATE_USER', `user: ${username}`, req.session.adminUser, 'SUCCESS');
        res.json({ success: true, message: `Usuário '${username}'@'${host}' criado com sucesso.` });
    } catch(err) {
        logDbAction('CREATE_USER', `user: ${username}`, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: Delete DB User
app.post('/api/db/user/delete', async (req, res) => {
    const username = sanitizeUsername(req.body.username);
    const host = 'localhost';

    if (!username) return res.status(400).json({ error: 'Usuário é obrigatório.' });

    try {
        const conn = await getDbConn();
        await conn.query(`DROP USER ?@?`, [username, host]);
        await conn.query('FLUSH PRIVILEGES');
        await conn.end();

        logDbAction('DROP_USER', `user: ${username}`, req.session.adminUser, 'SUCCESS');
        res.json({ success: true, message: `Usuário '${username}'@'${host}' removido.` });
    } catch(err) {
        logDbAction('DROP_USER', `user: ${username}`, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: Grant/Revoke privileges on a database
app.post('/api/db/user/privileges', async (req, res) => {
    const username = sanitizeUsername(req.body.username);
    const dbName = sanitizeDbName(req.body.database);
    const action = req.body.action;
    const host = 'localhost';

    if (!username || !dbName || !['grant', 'revoke'].includes(action)) {
        return res.status(400).json({ error: 'Parâmetros inválidos para privilégios.' });
    }

    if (isSystemDb(dbName)) {
        return res.status(403).json({ error: 'Alterações de permissões bloqueadas em bancos do sistema.' });
    }

    try {
        const conn = await getDbConn();
        if (action === 'grant') {
            await conn.query(`GRANT ALL PRIVILEGES ON \`${dbName}\`.* TO ?@?`, [username, host]);
        } else {
            await conn.query(`REVOKE ALL PRIVILEGES ON \`${dbName}\`.* FROM ?@?`, [username, host]);
        }
        await conn.query('FLUSH PRIVILEGES');
        await conn.end();

        logDbAction(`PRIVILEGE_${action.toUpperCase()}`, `db: ${dbName}, user: ${username}`, req.session.adminUser, 'SUCCESS');
        res.json({ success: true, message: `Permissões do usuário '${username}' no banco '${dbName}' atualizadas.` });
    } catch(err) {
        logDbAction(`PRIVILEGE_${action.toUpperCase()}`, `db: ${dbName}, user: ${username}`, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Helper para buscar wp-config.php e .env
function scanConfigFiles(basePath) {
    const found = [];
    const queue = [basePath];

    while (queue.length > 0) {
        const current = queue.shift();
        let stats;
        try { stats = fs.statSync(current); } catch(e) { continue; }

        if (stats.isDirectory()) {
            const baseName = path.basename(current);
            if (['node_modules', '.git', 'vendor', 'cache', '.tmp'].includes(baseName)) continue;

            let files;
            try { files = fs.readdirSync(current); } catch(e) { continue; }
            files.forEach(f => queue.push(path.join(current, f)));
        } else if (stats.isFile()) {
            const baseName = path.basename(current);
            if (baseName === '.env' || baseName === 'wp-config.php') {
                found.push(current);
            }
        }
    }
    return found;
}

// API: Preview of config files to change password
app.post('/api/db/user/reset-password/preview', async (req, res) => {
    const username = sanitizeUsername(req.body.username);
    const dbName = sanitizeDbName(req.body.database);

    if (!username) return res.status(400).json({ error: 'Usuário é obrigatório.' });

    try {
        const homeDir = os.homedir();
        const allConfigs = scanConfigFiles(homeDir);
        const matches = [];

        allConfigs.forEach(filePath => {
            const content = fs.readFileSync(filePath, 'utf8');
            let isMatch = false;
            let preview = '';

            const baseName = path.basename(filePath);
            if (baseName === '.env') {
                const lines = content.split('\n');
                lines.forEach(line => {
                    if (line.match(/^(DB_PASSWORD|DATABASE_PASSWORD|MYSQL_PASSWORD)\s*=/i)) {
                        isMatch = true;
                        preview += line + '\n';
                    }
                });
            } else if (baseName === 'wp-config.php') {
                const match = content.match(/define\s*\(\s*['"]DB_PASSWORD['"]\s*,\s*['"](.*?)['"]\s*\)/i);
                if (match) {
                    isMatch = true;
                    preview += match[0] + '\n';
                }
            }

            if (isMatch) {
                matches.push({
                    file: filePath,
                    relativePath: path.relative(homeDir, filePath),
                    type: baseName,
                    preview: preview.trim()
                });
            }
        });

        res.json({ success: true, matches });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Reset DB User Password + Safe Auto-Update Config Files (with Backups)
app.post('/api/db/user/reset-password', async (req, res) => {
    const username = sanitizeUsername(req.body.username);
    const newPassword = req.body.password;
    const alterConfigs = req.body.alterConfigs === true;
    const host = 'localhost';

    if (!username || !newPassword) {
        return res.status(400).json({ error: 'Usuário e nova senha são obrigatórios.' });
    }

    try {
        // 1. ALTER USER
        const conn = await getDbConn();
        await conn.query(`ALTER USER ?@? IDENTIFIED BY ?`, [username, host, newPassword]);
        await conn.query('FLUSH PRIVILEGES');
        await conn.end();

        // 2. Atualizar arquivos de configuração
        const updatedFiles = [];
        if (alterConfigs) {
            const homeDir = os.homedir();
            const allConfigs = scanConfigFiles(homeDir);
            const ts = new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 12);

            allConfigs.forEach(filePath => {
                let content = fs.readFileSync(filePath, 'utf8');
                let modified = false;
                const baseName = path.basename(filePath);

                if (baseName === '.env') {
                    const lines = content.split('\n');
                    const newLines = lines.map(line => {
                        if (line.match(/^(DB_PASSWORD|DATABASE_PASSWORD|MYSQL_PASSWORD)\s*=/i)) {
                            modified = true;
                            const key = line.split('=')[0].trim();
                            return `${key}=${newPassword}`;
                        }
                        return line;
                    });
                    if (modified) {
                        content = newLines.join('\n');
                    }
                } else if (baseName === 'wp-config.php') {
                    const pattern = /define\s*\(\s*['"]DB_PASSWORD['"]\s*,\s*['"](.*?)['"]\s*\)/i;
                    if (pattern.test(content)) {
                        modified = true;
                        content = content.replace(pattern, `define('DB_PASSWORD', '${newPassword}')`);
                    }
                }

                if (modified) {
                    const backupPath = `${filePath}.bak-${ts}`;
                    fs.writeFileSync(backupPath, fs.readFileSync(filePath));
                    fs.writeFileSync(filePath, content, 'utf8');
                    updatedFiles.push({ file: filePath, backup: backupPath });
                }
            });
        }

        logDbAction('RESET_PASS', `user: ${username}`, req.session.adminUser, 'SUCCESS');
        res.json({
            success: true,
            message: `Senha redefinida com sucesso para ${username}@${host}!`,
            updatedFiles
        });
    } catch(err) {
        logDbAction('RESET_PASS', `user: ${username}`, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: Optimize database tables
app.post('/api/db/optimize', async (req, res) => {
    const dbName = sanitizeDbName(req.body.database);
    if (!dbName) return res.status(400).json({ error: 'Nome do banco é obrigatório.' });

    if (isSystemDb(dbName)) {
        return res.status(403).json({ error: 'Otimização direta bloqueada em bancos de sistema.' });
    }

    try {
        const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const passArg = config.password ? `-p${config.password}` : '';
        const raw = await runCmd(`mysqlcheck -o -u ${config.user} ${passArg} \`${dbName}\` 2>&1`).catch(e => e.message);
        
        logDbAction('OPTIMIZE', dbName, req.session.adminUser, 'SUCCESS');
        res.json({ success: true, output: raw });
    } catch(err) {
        logDbAction('OPTIMIZE', dbName, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: Repair database tables
app.post('/api/db/repair', async (req, res) => {
    const dbName = sanitizeDbName(req.body.database);
    if (!dbName) return res.status(400).json({ error: 'Nome do banco é obrigatório.' });

    if (isSystemDb(dbName)) {
        return res.status(403).json({ error: 'Reparação direta bloqueada em bancos de sistema.' });
    }

    try {
        const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const passArg = config.password ? `-p${config.password}` : '';
        const raw = await runCmd(`mysqlcheck -r -u ${config.user} ${passArg} \`${dbName}\` 2>&1`).catch(e => e.message);

        logDbAction('REPAIR', dbName, req.session.adminUser, 'SUCCESS');
        res.json({ success: true, output: raw });
    } catch(err) {
        logDbAction('REPAIR', dbName, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});


// --- phpMyAdmin SSO Logic ---
const phpMyAdminTokens = new Map();

app.post('/api/phpmyadmin/create-token', (req, res) => {
    const { database, user } = req.body;
    try {
        const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const token = crypto.randomUUID();
        
        phpMyAdminTokens.set(token, {
            user: config.user,
            password: config.password,
            database: database || '',
            expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
            used: false
        });

        // Cleanup expired tokens
        for (const [k, v] of phpMyAdminTokens.entries()) {
            if (Date.now() > v.expiresAt) phpMyAdminTokens.delete(k);
        }

        // Determina o host que fez a requisição para montar a URL corretamente
        const host = req.hostname || '127.0.0.1';
        const url = `http://${host}:8080/phpmyadmin/autologin.php?token=${token}`;

        res.json({ ok: true, url });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.post('/api/phpmyadmin/validate-token', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: 'TOKEN_MISSING' });

    const data = phpMyAdminTokens.get(token);
    
    if (!data) return res.status(401).json({ ok: false, error: 'TOKEN_INVALID_OR_NOT_FOUND' });
    if (data.firstUsedAt && Date.now() - data.firstUsedAt > 15000) {
        return res.status(401).json({ ok: false, error: 'TOKEN_ALREADY_USED' });
    }
    if (Date.now() > data.expiresAt) return res.status(401).json({ ok: false, error: 'TOKEN_EXPIRED' });
    
    if (!data.firstUsedAt) {
        data.firstUsedAt = Date.now();
    }

    res.json({
        ok: true,
        user: data.user,
        password: data.password,
        database: data.database,
        host: '127.0.0.1',
        port: 3306
    });
});

app.get('/api/pma/sso/validate', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, error: 'TOKEN_MISSING' });

    const data = phpMyAdminTokens.get(token);
    
    if (!data) return res.status(401).json({ success: false, error: 'TOKEN_INVALID_OR_NOT_FOUND' });
    if (data.firstUsedAt && Date.now() - data.firstUsedAt > 15000) {
        return res.status(401).json({ success: false, error: 'TOKEN_ALREADY_USED' });
    }
    if (Date.now() > data.expiresAt) return res.status(401).json({ success: false, error: 'TOKEN_EXPIRED' });
    
    if (!data.firstUsedAt) {
        data.firstUsedAt = Date.now();
    }

    res.json({
        success: true,
        user: data.user,
        password: data.password,
        database: data.database,
        host: '127.0.0.1',
        port: 3306
    });
});

// Fallback robusto e retrocompatível para instâncias antigas de autologin.php em cache
app.get('/api/database/verify-token', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, error: 'TOKEN_MISSING' });

    const data = phpMyAdminTokens.get(token);
    
    if (!data) return res.status(401).json({ success: false, error: 'TOKEN_INVALID_OR_NOT_FOUND' });
    if (data.firstUsedAt && Date.now() - data.firstUsedAt > 15000) {
        return res.status(401).json({ success: false, error: 'TOKEN_ALREADY_USED' });
    }
    if (Date.now() > data.expiresAt) return res.status(401).json({ success: false, error: 'TOKEN_EXPIRED' });
    
    if (!data.firstUsedAt) {
        data.firstUsedAt = Date.now();
    }

    res.json({
        success: true,
        user: data.user,
        password: data.password,
        database: data.database,
        host: '127.0.0.1'
    });
});

// --- FileBrowser Proxy Seguro ---
app.use('/__filebrowser', (req, res, next) => {
    // Permite autenticação automática por token SSO (idêntico ao phpMyAdmin)
    const token = req.query.token;
    if (token) {
        const data = ssoTokens.get(token);
        if (data && Date.now() <= data.expiresAt) {
            // Token válido! Ativa a sessão do cPanel para este cliente
            req.session.authenticated = true;
            // Redireciona de forma limpa para limpar o token da barra de endereço
            const cleanUrl = req.originalUrl.split('?')[0];
            return res.redirect(cleanUrl);
        }
    }

    if (!req.session || !req.session.authenticated) {
        return res.status(401).send('<body style="background:#11111b; color:#cdd6f4; font-family:sans-serif; text-align:center; padding-top:50px;">Acesso negado. Faça login no painel principal.</body>');
    }
    next();
}, createProxyMiddleware({
    target: 'http://127.0.0.1:8095',
    changeOrigin: true,
    ws: true,
    pathRewrite: {
        '^/': '/__filebrowser/'
    }
}));

// --- NO-IP Logic ---
async function startNoipUpdater() {
    if (noipInterval) clearInterval(noipInterval);
    const config = JSON.parse(fs.readFileSync(NOIP_FILE, 'utf8'));
    if (!config.username || !config.password || !config.hostname) {
        noipStatus.status = 'Erro: Credenciais incompletas';
        return;
    }
    
    noipStatus.status = 'Executando...';
    logNoip('Serviço NO-IP iniciado.');

    const updateIP = async () => {
        try {
            // Tenta obter IPv6 primeiro (ifconfig.co)
            const ipRes = await axios.get('https://ifconfig.co/ip');
            const myip = ipRes.data.trim();
            noipStatus.currentIP = myip;
            logNoip(`IP Detectado: ${myip}`);

            const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
            const updateUrl = `https://dynupdate.no-ip.com/nic/update?hostname=${config.hostname}&myip=${myip}`;
            
            const res = await axios.get(updateUrl, {
                headers: { 'Authorization': `Basic ${auth}`, 'User-Agent': 'TermuxcPanel/1.0 gabriel@example.com' }
            });
            
            const resultBody = res.data;
            noipStatus.lastUpdate = new Date().toLocaleTimeString();
            logNoip(`Resposta NO-IP: ${resultBody}`);
        } catch (e) {
            logNoip(`Erro ao atualizar NO-IP: ${e.message}`);
        }
    };

    updateIP();
    noipInterval = setInterval(updateIP, (config.interval || 15) * 60000);
}

function stopNoipUpdater() {
    if (noipInterval) {
        clearInterval(noipInterval);
        noipInterval = null;
    }
    noipStatus.status = 'Parado';
    logNoip('Serviço NO-IP parado.');
}

// Inicializar auto-start se existir
if (fs.existsSync(NOIP_FILE)) {
    const config = JSON.parse(fs.readFileSync(NOIP_FILE, 'utf8'));
    if (config.autostart) {
        startNoipUpdater();
    }
}

app.get('/api/noip', (req, res) => {
    try {
        const config = JSON.parse(fs.readFileSync(NOIP_FILE, 'utf8'));
        res.json({ config, status: noipStatus });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/noip', (req, res) => {
    try {
        fs.writeFileSync(NOIP_FILE, JSON.stringify(req.body, null, 2));
        if (req.body.autostart) {
            startNoipUpdater();
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/noip/toggle', (req, res) => {
    if (noipInterval) {
        stopNoipUpdater();
    } else {
        startNoipUpdater();
    }
    res.json({ success: true, status: noipStatus });
});

// =============================================================
// HEALTH CHECK — executa o script e transmite output em tempo real
// =============================================================
const HEALTH_SCRIPT = path.join(__dirname, 'scripts', 'health-check.sh');

// SSE: Executa health-check e envia as linhas em tempo real
app.get('/api/health-check/run', (req, res) => {
    // Garante que o script é executável
    try { require('fs').chmodSync(HEALTH_SCRIPT, '755'); } catch(e) {}

    // Configura SSE (Server-Sent Events)
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify({ line: data })}\n\n`);

    const proc = spawn('bash', [HEALTH_SCRIPT], {
        env: { ...process.env, TERM: 'xterm' },
    });

    proc.stdout.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => {
            if (line.trim()) send(line);
        });
    });

    proc.stderr.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => {
            if (line.trim()) send('[STDERR] ' + line);
        });
    });

    proc.on('close', code => {
        send(`__DONE__:${code}`);
        res.end();
    });

    req.on('close', () => proc.kill());
});

const UPDATE_SCRIPT = path.join(__dirname, 'scripts', 'update.sh');

// SSE: Executa atualização do painel em tempo real
app.get('/api/system/update/run', (req, res) => {
    try { require('fs').chmodSync(UPDATE_SCRIPT, '755'); } catch(e) {}

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify({ line: data })}\n\n`);

    const tag = req.query.tag || '';
    const args = [];
    if (tag && tag.trim() !== '') {
        args.push(tag.trim());
    }

    const proc = spawn('bash', [UPDATE_SCRIPT, ...args], {
        env: { ...process.env, TERM: 'xterm' },
    });

    proc.stdout.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => {
            if (line.trim()) send(line);
        });
    });

    proc.stderr.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => {
            if (line.trim()) send('[STDERR] ' + line);
        });
    });

    proc.on('close', code => {
        send(`__DONE__:${code}`);
        res.end();
    });

    req.on('close', () => proc.kill());
});

const UPDATE_CONFIG_FILE = path.join(__dirname, 'config', 'update.json');

function getUpdateConfig() {
    try {
        if (fs.existsSync(UPDATE_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(UPDATE_CONFIG_FILE, 'utf8'));
        }
    } catch(e) {}
    return { github_repo: '', update_channel: 'release' };
}

// GET/POST config de update (repositório GitHub)
app.get('/api/system/update/config', (req, res) => {
    res.json(getUpdateConfig());
});

app.post('/api/system/update/config', (req, res) => {
    try {
        let repo = req.body.github_repo || '';
        // Sanitiza URL completa caso o usuário cole: https://github.com/user/repo
        repo = repo.replace(/https?:\/\/github\.com\//i, '').trim();
        // Remove barras extras no início ou fim
        repo = repo.replace(/^\/+|\/+$/g, '');

        const config = { ...getUpdateConfig(), github_repo: repo };
        fs.writeFileSync(UPDATE_CONFIG_FILE, JSON.stringify(config, null, 2));
        res.json({ success: true, config });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Panel Settings Endpoints ---
app.get('/api/system/settings', (req, res) => {
    try {
        const bashrcPath = path.join(os.homedir(), '.bashrc');
        let autostart = false;
        if (fs.existsSync(bashrcPath)) {
            const content = fs.readFileSync(bashrcPath, 'utf8');
            autostart = content.includes('termux-panel/scripts/start.sh');
        }

        const bootScriptPath = path.join(os.homedir(), '.termux', 'boot', 'start-cpanel');
        const autostartBoot = fs.existsSync(bootScriptPath);
        
        let adminUser = 'admin';
        if (fs.existsSync(AUTH_FILE)) {
            try {
                const auth = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
                adminUser = auth.user || 'admin';
            } catch(e) {}
        }
        
        res.json({
            success: true,
            port: PORT,
            autostart,
            autostartBoot,
            adminUser
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/system/settings/port', (req, res) => {
    try {
        const newPort = parseInt(req.body.port);
        if (!newPort || newPort < 1 || newPort > 65535) {
            return res.status(400).json({ error: 'Porta inválida (deve ser entre 1 e 65535)' });
        }
        if ([80, 8080, 3306].includes(newPort)) {
            return res.status(400).json({ error: `A porta ${newPort} é reservada para serviços do sistema (HTTP/phpMyAdmin/MariaDB).` });
        }
        
        fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify({ port: newPort }, null, 2));
        
        res.json({ success: true, message: `Porta alterada para ${newPort}. O painel reiniciará em breve.` });
        
        // Reinicia o servidor em 1.5s
        setTimeout(() => {
            console.log('Reiniciando servidor devido a alteração de porta...');
            process.exit(0);
        }, 1500);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/system/settings/auth', (req, res) => {
    try {
        const { user, pass } = req.body;
        if (!user || !pass || user.trim() === '' || pass.trim() === '') {
            return res.status(400).json({ error: 'Usuário e senha não podem ser vazios.' });
        }
        
        fs.writeFileSync(AUTH_FILE, JSON.stringify({ user, pass }, null, 2));
        res.json({ success: true, message: 'Credenciais de administrador salvas com sucesso!' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/system/settings/autostart/toggle', (req, res) => {
    try {
        const { active } = req.body;
        const bashrcPath = path.join(os.homedir(), '.bashrc');
        
        let content = '';
        if (fs.existsSync(bashrcPath)) {
            content = fs.readFileSync(bashrcPath, 'utf8');
        }
        
        const lineToAdd = 'pgrep -f "server.js" >/dev/null 2>&1 || bash ~/termux-panel/scripts/start.sh';
        
        if (active) {
            // Limpa qualquer linha antiga relacionada ao start.sh para evitar duplicados
            let lines = content.split('\n').filter(l => !l.includes('termux-panel/scripts/start.sh'));
            content = lines.join('\n');
            const prefix = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
            fs.writeFileSync(bashrcPath, `${content}${prefix}${lineToAdd}\n`);
        } else {
            const lines = content.split('\n');
            const clean = lines.filter(l => !l.includes('termux-panel/scripts/start.sh')).join('\n');
            fs.writeFileSync(bashrcPath, clean);
        }
        
        res.json({ success: true, active });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/system/settings/autostart-boot/toggle', (req, res) => {
    try {
        const { active } = req.body;
        const bootDir = path.join(os.homedir(), '.termux', 'boot');
        const bootScriptPath = path.join(bootDir, 'start-cpanel');
        
        if (active) {
            // Cria a pasta .termux/boot se não existir
            if (!fs.existsSync(bootDir)) {
                fs.mkdirSync(bootDir, { recursive: true });
            }
            // Conteúdo do script de boot para o Termux:Boot
            const scriptContent = `#!/data/data/com.termux/files/usr/bin/bash\ntermux-wake-lock\nbash ~/termux-panel/scripts/start.sh\n`;
            fs.writeFileSync(bootScriptPath, scriptContent);
            // Permissão de execução (chmod +x)
            fs.chmodSync(bootScriptPath, '755');
        } else {
            // Remove o script se existir
            if (fs.existsSync(bootScriptPath)) {
                fs.unlinkSync(bootScriptPath);
            }
        }
        res.json({ success: true, active });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/system/update/check', async (req, res) => {
    try {
        const pjson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        const config = getUpdateConfig();
        const currentVersion = pjson.version || '1.0.0';
        let hasUpdate = false;
        let latestVersion = currentVersion;
        let updateMethod = 'manual';
        let releaseUrl = '';
        let releaseNotes = '';

        // Método 1: GitHub Releases API
        if (config.github_repo && config.github_repo.includes('/')) {
            try {
                updateMethod = 'github';
                releaseUrl = `https://github.com/${config.github_repo}/releases/latest/download/termux-panel-dist.tar.gz`;
                const apiUrl = `https://api.github.com/repos/${config.github_repo}/releases/latest`;
                const resp = await axios.get(apiUrl, {
                    headers: { 'User-Agent': 'termux-panel' },
                    timeout: 5000
                });
                latestVersion = (resp.data.tag_name || currentVersion).replace(/^v/, '');
                releaseNotes = resp.data.body || '';
                // Compara versões simples
                hasUpdate = latestVersion !== currentVersion;
                if (!hasUpdate) {
                    // Mesmo número de versão: verifica se o release é mais novo
                    const publishedAt = new Date(resp.data.published_at || 0);
                    const localStat = fs.statSync(path.join(__dirname, 'server.js'));
                    hasUpdate = publishedAt > localStat.mtime;
                }
            } catch(e) {
                // FALLBACK: Usar git ls-remote para obter a última versão sem limite de taxa de API!
                try {
                    const gitUrl = `https://github.com/${config.github_repo}.git`;
                    const tagsOut = await new Promise((resolve, reject) => {
                        exec(`git ls-remote --tags ${gitUrl}`, (err, stdout) => {
                            if (err) reject(err);
                            else resolve(stdout || '');
                        });
                    });
                    const tags = tagsOut.split('\n')
                        .map(line => {
                            const match = line.match(/refs\/tags\/(v?\d+\.\d+\.\d+)/);
                            return match ? match[1] : null;
                        })
                        .filter(Boolean);
                    if (tags.length > 0) {
                        const sorted = tags.sort((a, b) => {
                            const parse = v => v.replace(/^v/, '').split('.').map(Number);
                            const [pa, pb] = [parse(a), parse(b)];
                            for (let i = 0; i < 3; i++) {
                                if (pa[i] !== pb[i]) return pa[i] - pb[i];
                            }
                            return 0;
                        });
                        const latestTag = sorted[sorted.length - 1];
                        latestVersion = latestTag.replace(/^v/, '');
                        hasUpdate = latestVersion !== currentVersion;
                        updateMethod = 'github'; // Recuperado com sucesso via Git!
                    } else {
                        updateMethod = 'github_error';
                    }
                } catch (errGit) {
                    updateMethod = 'github_error';
                }
            }
        }

        // Método 2: Git local
        const isGit = fs.existsSync(path.join(__dirname, '.git'));
        if (updateMethod === 'manual' && isGit) {
            updateMethod = 'git';
            try {
                await new Promise((resolve) => exec('git fetch --dry-run', () => resolve()));
                const statusOut = await new Promise((resolve) => {
                    exec('git status -uno', (err, stdout) => resolve(stdout || ''));
                });
                if (statusOut.includes('behind')) hasUpdate = true;
            } catch(e) {}
        }

        res.json({
            currentVersion,
            latestVersion,
            hasUpdate,
            updateMethod,
            githubRepo: config.github_repo || '',
            releaseUrl,
            releaseNotes: releaseNotes.substring(0, 500)
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});


app.get('/api/system/update/versions', async (req, res) => {
    try {
        const config = getUpdateConfig();
        const pjson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        const currentVersion = pjson.version || '1.0.0';

        if (!config.github_repo || !config.github_repo.includes('/')) {
            return res.json({ success: true, currentVersion, versions: [] });
        }

        const apiUrl = `https://api.github.com/repos/${config.github_repo}/releases`;
        const resp = await axios.get(apiUrl, {
            headers: { 'User-Agent': 'termux-panel' },
            timeout: 5000
        });

        const releases = resp.data || [];
        const versions = releases.map(rel => {
            const tag = rel.tag_name || '';
            const tagClean = tag.replace(/^v/, '');
            
            // Lógica inteligente de retrocompatibilidade
            let compatStatus = 'compatible';
            let compatMessage = 'Upgrade/Reinstalação 100% seguro.';

            if (tagClean === currentVersion) {
                compatStatus = 'compatible';
                compatMessage = 'Esta é a sua versão ativa atual.';
            } else {
                // Compara as versões de forma simples (ex: 1.2.0 vs 1.1.3)
                const cmp = tagClean.localeCompare(currentVersion, undefined, { numeric: true, sensitivity: 'base' });
                if (cmp < 0) {
                    compatStatus = 'breaking';
                    compatMessage = 'Aviso: Downgrade. Recursos novos da v1.2.0 (Hospedagem) ficarão inativos.';
                } else {
                    compatStatus = 'compatible';
                    compatMessage = 'Upgrade compatível e recomendado.';
                }
            }

            return {
                tag,
                name: rel.name || tag,
                publishedAt: rel.published_at,
                body: rel.body || '',
                compatStatus,
                compatMessage
            };
        });

        res.json({
            success: true,
            currentVersion,
            versions
        });
    } catch (err) {
        // FALLBACK: se a API do GitHub falhar (rate limit ou DNS), usa git ls-remote para listar as tags de forma segura!
        try {
            const config = getUpdateConfig();
            const pjson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
            const currentVersion = pjson.version || '1.0.0';
            const gitUrl = `https://github.com/${config.github_repo}.git`;
            
            const tagsOut = await new Promise((resolve, reject) => {
                exec(`git ls-remote --tags ${gitUrl}`, (err, stdout) => {
                    if (err) reject(err);
                    else resolve(stdout || '');
                });
            });

            const lines = tagsOut.split('\n').filter(Boolean);
            const rawVersions = lines.map(line => {
                const match = line.match(/refs\/tags\/(v?\d+\.\d+\.\d+)/);
                if (!match) return null;
                const tag = match[1].startsWith('v') ? match[1] : 'v' + match[1];
                const tagClean = tag.replace(/^v/, '');
                
                let compatStatus = 'compatible';
                let compatMessage = 'Upgrade/Reinstalação 100% seguro.';

                if (tagClean === currentVersion) {
                    compatStatus = 'compatible';
                    compatMessage = 'Esta é a sua versão ativa atual.';
                } else {
                    const cmp = tagClean.localeCompare(currentVersion, undefined, { numeric: true, sensitivity: 'base' });
                    if (cmp < 0) {
                        compatStatus = 'breaking';
                        compatMessage = 'Aviso: Downgrade. Recursos novos da v1.2.0 (Hospedagem) ficarão inativos.';
                    } else {
                        compatStatus = 'compatible';
                        compatMessage = 'Upgrade compatível e recomendado.';
                    }
                }

                return {
                    tag,
                    name: `Termux Panel ${tag}`,
                    publishedAt: new Date().toISOString(), // Fallback de data
                    body: 'Release carregada dinamicamente via Git tags (API rate limit bypass).',
                    compatStatus,
                    compatMessage
                };
            }).filter(Boolean);

            const sortedVersions = rawVersions.sort((a, b) => {
                const parse = v => v.tag.replace(/^v/, '').split('.').map(Number);
                const [pa, pb] = [parse(b), parse(a)]; // Decrescente
                for (let i = 0; i < 3; i++) {
                    if (pa[i] !== pb[i]) return pa[i] - pb[i];
                }
                return 0;
            });

            res.json({
                success: true,
                currentVersion,
                versions: sortedVersions
            });
        } catch (errFallback) {
            res.status(500).json({ error: `GitHub API indisponível e falha no Git fallback: ${err.message}` });
        }
    }
});

// ============================================================
//  NÚCLEO DE ATUALIZAÇÃO E ROLLBACK AVANÇADO (v0.0.3)
// ============================================================

function parseSemver(versionString) {
    const clean = versionString.trim().replace(/^v/, '');
    const [mainPart, prePart] = clean.split('-');
    const parts = mainPart.split('.').map(Number);
    while (parts.length < 3) {
        parts.push(0);
    }
    return {
        major: parts[0] || 0,
        minor: parts[1] || 0,
        patch: parts[2] || 0,
        prerelease: prePart || null
    };
}

function compareSemver(v1, v2) {
    const p1 = parseSemver(v1);
    const p2 = parseSemver(v2);
    
    if (p1.major !== p2.major) return p1.major - p2.major;
    if (p1.minor !== p2.minor) return p1.minor - p2.minor;
    if (p1.patch !== p2.patch) return p1.patch - p2.patch;
    
    if (p1.prerelease && !p2.prerelease) return -1;
    if (!p1.prerelease && p2.prerelease) return 1;
    if (p1.prerelease && p2.prerelease) {
        return p1.prerelease.localeCompare(p2.prerelease);
    }
    return 0;
}

const UPDATE_CACHE_FILE = path.join(__dirname, 'config', 'update-cache.json');

function readUpdateCache() {
    try {
        if (fs.existsSync(UPDATE_CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf8'));
        }
    } catch(e) {}
    return null;
}

function writeUpdateCache(data) {
    try {
        fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify({
            ...data,
            lastChecked: new Date().toISOString()
        }, null, 2));
    } catch(e) {}
}

// GET /api/update/status
app.get('/api/update/status', async (req, res) => {
    try {
        const pjson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        const installed = pjson.version || '0.0.2';
        const config = getUpdateConfig();
        const repo = config.github_repo || 'arjtechx/termux-panel';

        const cached = readUpdateCache();
        
        if (cached && cached.repo === repo && cached.installed === installed && !req.query.force) {
            const age = Date.now() - new Date(cached.lastChecked).getTime();
            if (age < 5 * 60 * 1000) {
                return res.json(cached);
            }
        }

        let latest = installed;
        let hasUpdate = false;
        let status = 'up_to_date';

        try {
            const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
            const resp = await axios.get(apiUrl, {
                headers: { 'User-Agent': 'termux-panel' },
                timeout: 3000
            });
            latest = (resp.data.tag_name || installed).replace(/^v/, '');
            hasUpdate = compareSemver(latest, installed) > 0;
            status = hasUpdate ? 'update_available' : 'up_to_date';
        } catch(err) {
            if (cached && cached.repo === repo) {
                return res.json({
                    ...cached,
                    status: cached.hasUpdate ? 'update_available' : 'up_to_date'
                });
            }
            status = 'failed_check';
        }

        const result = {
            installed,
            latest,
            hasUpdate,
            status,
            repo
        };

        if (status !== 'failed_check') {
            writeUpdateCache(result);
        }

        res.json(result);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/update/releases
app.get('/api/update/releases', async (req, res) => {
    try {
        const config = getUpdateConfig();
        const pjson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        const installed = pjson.version || '0.0.2';
        const repo = config.github_repo || 'arjtechx/termux-panel';

        try {
            const apiUrl = `https://api.github.com/repos/${repo}/releases`;
            const resp = await axios.get(apiUrl, {
                headers: { 'User-Agent': 'termux-panel' },
                timeout: 5000
            });
            const releases = resp.data || [];
            const versions = releases.map(rel => {
                const tag = rel.tag_name || '';
                const tagClean = tag.replace(/^v/, '');
                
                let compatStatus = 'compatible';
                let compatMessage = 'Upgrade/Reinstalação 100% seguro.';

                if (tagClean === installed) {
                    compatStatus = 'compatible';
                    compatMessage = 'Esta é a sua versão ativa atual.';
                } else {
                    const cmp = compareSemver(tagClean, installed);
                    if (cmp < 0) {
                        compatStatus = 'breaking';
                        compatMessage = 'Aviso: Downgrade. Recursos novos do painel poderão ficar indisponíveis.';
                    } else {
                        compatStatus = 'compatible';
                        compatMessage = 'Upgrade compatível e recomendado.';
                    }
                }

                return {
                    tag,
                    name: rel.name || tag,
                    publishedAt: rel.published_at,
                    body: rel.body || '',
                    compatStatus,
                    compatMessage
                };
            });

            res.json(versions);
        } catch(err) {
            // Fallback via Git ls-remote
            try {
                const gitUrl = `https://github.com/${repo}.git`;
                const tagsOut = await new Promise((resolve, reject) => {
                    exec(`git ls-remote --tags ${gitUrl}`, (gitErr, stdout) => {
                        if (gitErr) reject(gitErr);
                        else resolve(stdout || '');
                    });
                });

                const lines = tagsOut.split('\n').filter(Boolean);
                const rawVersions = lines.map(line => {
                    const match = line.match(/refs\/tags\/(v?\d+\.\d+\.\d+)/);
                    if (!match) return null;
                    const tag = match[1].startsWith('v') ? match[1] : 'v' + match[1];
                    const tagClean = tag.replace(/^v/, '');
                    
                    let compatStatus = 'compatible';
                    let compatMessage = 'Upgrade/Reinstalação 100% seguro.';

                    if (tagClean === installed) {
                        compatStatus = 'compatible';
                        compatMessage = 'Esta é a sua versão ativa atual.';
                    } else {
                        const cmp = compareSemver(tagClean, installed);
                        if (cmp < 0) {
                            compatStatus = 'breaking';
                            compatMessage = 'Aviso: Downgrade. Recursos novos do painel poderão ficar indisponíveis.';
                        } else {
                            compatStatus = 'compatible';
                            compatMessage = 'Upgrade compatível e recomendado.';
                        }
                    }

                    return {
                        tag,
                        name: `Termux Panel ${tag}`,
                        publishedAt: new Date().toISOString(),
                        body: 'Carregada via Git tags (API rate limit bypass).',
                        compatStatus,
                        compatMessage
                    };
                }).filter(Boolean);

                const sortedVersions = rawVersions.sort((a, b) => {
                    return compareSemver(b.tag, a.tag);
                });

                res.json(sortedVersions);
            } catch (errFallback) {
                res.status(500).json({ error: `GitHub API indisponível e falha no Git fallback: ${err.message}` });
            }
        }
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/update/check
app.post('/api/update/check', async (req, res) => {
    try {
        const pjson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        const installed = pjson.version || '0.0.2';
        const config = getUpdateConfig();
        const repo = config.github_repo || 'arjtechx/termux-panel';

        let latest = installed;
        let hasUpdate = false;
        let status = 'up_to_date';

        try {
            const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
            const resp = await axios.get(apiUrl, {
                headers: { 'User-Agent': 'termux-panel' },
                timeout: 5000
            });
            latest = (resp.data.tag_name || installed).replace(/^v/, '');
            hasUpdate = compareSemver(latest, installed) > 0;
            status = hasUpdate ? 'update_available' : 'up_to_date';
        } catch(err) {
            try {
                const gitUrl = `https://github.com/${repo}.git`;
                const tagsOut = await new Promise((resolve, reject) => {
                    exec(`git ls-remote --tags ${gitUrl}`, (gitErr, stdout) => {
                        if (gitErr) reject(gitErr);
                        else resolve(stdout || '');
                    });
                });
                const tags = tagsOut.split('\n')
                    .map(line => {
                        const match = line.match(/refs\/tags\/(v?\d+\.\d+\.\d+)/);
                        return match ? match[1] : null;
                    })
                    .filter(Boolean);
                if (tags.length > 0) {
                    const sorted = tags.sort(compareSemver);
                    const latestTag = sorted[sorted.length - 1];
                    latest = latestTag.replace(/^v/, '');
                    hasUpdate = compareSemver(latest, installed) > 0;
                    status = hasUpdate ? 'update_available' : 'up_to_date';
                } else {
                    status = 'failed_check';
                }
            } catch(eGit) {
                status = 'failed_check';
            }
        }

        const result = {
            installed,
            latest,
            hasUpdate,
            status,
            repo
        };

        if (status !== 'failed_check') {
            writeUpdateCache(result);
        }

        res.json(result);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/update/install (SSE Log Stream)
app.get('/api/update/install', async (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const sendLog = (type, message) => {
        res.write(`data: ${JSON.stringify({ line: `[${type}] ${message}` })}\n\n`);
    };

    const targetTag = req.query.tag || 'latest';
    sendLog('INFO', `Verificando releases GitHub para tag: ${targetTag}...`);

    try {
        const config = getUpdateConfig();
        const repo = config.github_repo || 'arjtechx/termux-panel';
        const pjson = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
        const currentVersion = pjson.version || '0.0.2';

        let downloadUrl = '';
        let resolvedTag = targetTag;
        
        try {
            const apiUrl = targetTag === 'latest'
                ? `https://api.github.com/repos/${repo}/releases/latest`
                : `https://api.github.com/repos/${repo}/releases/tags/${targetTag}`;
            
            const resp = await axios.get(apiUrl, { headers: { 'User-Agent': 'termux-panel' }, timeout: 5000 });
            resolvedTag = resp.data.tag_name || targetTag;
            downloadUrl = `https://github.com/${repo}/releases/download/${resolvedTag}/termux-panel-dist.tar.gz`;
            sendLog('OK', `Release encontrada: ${resolvedTag}`);
        } catch(e) {
            resolvedTag = targetTag === 'latest' ? 'v0.0.2' : targetTag;
            downloadUrl = `https://github.com/${repo}/releases/download/${resolvedTag}/termux-panel-dist.tar.gz`;
            sendLog('WARN', `GitHub API limite de requisições. Tentando URL direta: ${resolvedTag}`);
        }

        // Criar Backup Preventivo
        sendLog('INFO', `Criando backup automático da versão ${currentVersion}...`);
        const backupDir = path.join(__dirname, 'backups', 'panel-backups', `version-${currentVersion}`);
        
        try {
            fs.mkdirSync(backupDir, { recursive: true });
            const itemsToBackup = ['public', 'scripts', 'server.js', 'package.json', 'package-lock.json'];
            for (const item of itemsToBackup) {
                const srcPath = path.join(__dirname, item);
                const destPath = path.join(backupDir, item);
                if (fs.existsSync(srcPath)) {
                    fs.cpSync(srcPath, destPath, { recursive: true });
                }
            }
            sendLog('OK', `Backup criado com sucesso em: backups/panel-backups/version-${currentVersion}`);
        } catch (backupErr) {
            sendLog('WARN', `Não foi possível criar o backup preventivo: ${backupErr.message}`);
        }

        // Baixar pacote
        sendLog('INFO', `Baixando pacote da release...`);
        const tempDir = path.join(__dirname, 'backups', 'tmp');
        fs.mkdirSync(tempDir, { recursive: true });
        const tempTarPath = path.join(tempDir, `update-${resolvedTag}.tar.gz`);

        try {
            const writer = fs.createWriteStream(tempTarPath);
            const response = await axios({
                method: 'get',
                url: downloadUrl,
                responseType: 'stream',
                timeout: 15000
            });

            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            sendLog('OK', `Pacote baixado com sucesso.`);
        } catch (dlErr) {
            sendLog('ERR', `Falha ao baixar o pacote: ${dlErr.message}`);
            res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
            return res.end();
        }

        // Extrair atualização
        sendLog('INFO', `Extraindo pacote do painel...`);
        const extractDir = path.join(tempDir, 'extract');
        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.mkdirSync(extractDir, { recursive: true });

        try {
            await new Promise((resolve, reject) => {
                const proc = spawn('tar', ['-xzf', tempTarPath, '-C', extractDir, '--strip-components=1']);
                proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Tar terminou com código ${code}`)));
                proc.on('error', reject);
            });
            sendLog('OK', `Extração básica concluída.`);
        } catch (extErr) {
            sendLog('ERR', `Falha ao extrair tarball: ${extErr.message}`);
            res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
            return res.end();
        }

        // Substituir apenas arquivos da aplicação
        sendLog('INFO', `Instalando atualização...`);
        try {
            const itemsToCopy = ['public', 'scripts', 'server.js', 'package.json', 'package-lock.json', 'README.md', 'install.sh'];
            for (const item of itemsToCopy) {
                const srcPath = path.join(extractDir, item);
                const destPath = path.join(__dirname, item);
                if (fs.existsSync(srcPath)) {
                    fs.cpSync(srcPath, destPath, { recursive: true, force: true });
                }
            }
            sendLog('OK', `Arquivos copiados com sucesso.`);
        } catch (copyErr) {
            sendLog('ERR', `Falha ao instalar arquivos: ${copyErr.message}`);
            res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
            return res.end();
        }

        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch(e) {}

        sendLog('OK', `Atualização concluída.`);
        res.write(`data: ${JSON.stringify({ line: '__DONE__:0' })}\n\n`);
        res.end();

        setTimeout(() => {
            console.log('Painel atualizado. Reiniciando...');
            process.exit(0);
        }, 1500);

    } catch (err) {
        sendLog('ERR', `Erro geral durante atualização: ${err.message}`);
        res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
        res.end();
    }
});

// POST /api/update/install
app.post('/api/update/install', (req, res) => {
    res.json({ success: true, message: 'Processo iniciado. Acompanhe via SSE GET.' });
});

// GET /api/update/rollback
app.get('/api/update/rollback', async (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const sendLog = (type, message) => {
        res.write(`data: ${JSON.stringify({ line: `[${type}] ${message}` })}\n\n`);
    };

    const targetVersion = req.query.version || '';
    if (!targetVersion) {
        sendLog('ERR', 'Versão para rollback não especificada.');
        res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
        return res.end();
    }

    sendLog('INFO', `Iniciando rollback para a versão: ${targetVersion}...`);
    const backupDir = path.join(__dirname, 'backups', 'panel-backups', `version-${targetVersion}`);

    if (!fs.existsSync(backupDir)) {
        sendLog('ERR', `Nenhum backup encontrado para a versão: ${targetVersion}`);
        res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
        return res.end();
    }

    try {
        sendLog('INFO', 'Restaurando arquivos de backup...');
        const itemsToRestore = ['public', 'scripts', 'server.js', 'package.json', 'package-lock.json'];
        
        for (const item of itemsToRestore) {
            const srcPath = path.join(backupDir, item);
            const destPath = path.join(__dirname, item);
            if (fs.existsSync(srcPath)) {
                fs.cpSync(srcPath, destPath, { recursive: true, force: true });
            }
        }
        
        sendLog('OK', `Rollback para a versão ${targetVersion} concluído com sucesso!`);
        res.write(`data: ${JSON.stringify({ line: '__DONE__:0' })}\n\n`);
        res.end();

        setTimeout(() => {
            console.log(`Rollback aplicado. Reiniciando na versão ${targetVersion}...`);
            process.exit(0);
        }, 1500);

    } catch (err) {
        sendLog('ERR', `Erro durante o rollback: ${err.message}`);
        res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
        res.end();
    }
});

// POST /api/update/rollback
app.post('/api/update/rollback', (req, res) => {
    res.json({ success: true, message: 'Rollback iniciado. Acompanhe via SSE GET.' });
});

// Status rápido dos serviços (sem script externo)
app.get('/api/health-check/status', async (req, res) => {
    const results = {};

    const checkPort = (host, port) => new Promise(resolve => {
        const sock = new net.Socket();
        sock.setTimeout(1500);
        sock.on('connect', () => { sock.destroy(); resolve(true); });
        sock.on('timeout', () => { sock.destroy(); resolve(false); });
        sock.on('error',   () => { sock.destroy(); resolve(false); });
        sock.connect(port, host);
    });

    const checkProcess = (name) => new Promise(resolve => {
        exec(`pgrep -x "${name}"`, (err, stdout) => resolve(!err && stdout.trim().length > 0));
    });

    const checkCmd = (cmd) => new Promise(resolve => {
        exec(`which ${cmd} 2>/dev/null`, (err, stdout) => resolve(!err && stdout.trim().length > 0));
    });

    const [
        nginxRunning, mariadbRunning, phpfpmRunning,
        port80, port8080, port3306,
        hasNginx, hasPHP, hasMariadb, hasPMA,
    ] = await Promise.all([
        checkProcess('nginx'),
        checkProcess('mariadbd').then(r => r || checkProcess('mysqld')),
        checkProcess('php-fpm'),
        checkPort('127.0.0.1', 80),
        checkPort('127.0.0.1', 8080),
        checkPort('127.0.0.1', 3306),
        checkCmd('nginx'),
        checkCmd('php'),
        checkCmd('mariadb'),
        (async () => {
            const p1 = process.env.PREFIX + '/share/phpmyadmin';
            const p2 = '/usr/share/phpmyadmin';
            return fs.existsSync(p1) || fs.existsSync(p2);
        })(),
    ]);

    const fbBinExists = fs.existsSync(fileBrowserService.binPath);
    const fbPort = fileBrowserService.getPort();
    const fbProcessActive = !!(fileBrowserService.process && fileBrowserService.process.pid && !fileBrowserService.process.killed);
    const port8095 = await checkPort('127.0.0.1', fbPort);

    res.json({
        services: {
            nginx:    { installed: hasNginx,    running: nginxRunning,   port80 },
            mariadb:  { installed: hasMariadb,  running: mariadbRunning, port3306 },
            phpfpm:   { installed: hasPHP,      running: phpfpmRunning },
            phpmyadmin: { installed: hasPMA,    port8080 },
            filebrowser: { installed: fbBinExists, running: fbProcessActive, port: fbPort, webOk: port8095 }
        }
    });
});

// ─── MariaDB Smart Install & Recovery API ───────────────────────

const DB_FULL_FILE = path.join(__dirname, 'config', 'database.json');

// Lê config completa (database.json > db.json fallback)
function getFullDbConfig() {
    try {
        if (fs.existsSync(DB_FULL_FILE)) return JSON.parse(fs.readFileSync(DB_FULL_FILE, 'utf8'));
        if (fs.existsSync(DB_FILE))      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch(e) {}
    return { host: '127.0.0.1', port: 3306, database: 'painel', user: 'root', password: '' };
}

// Verifica se MariaDB está instalado
app.get('/api/mariadb/detect', async (req, res) => {
    try {
        const prefix = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = systemConfig.is_termux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';

        const hasBinary  = await runCmd('command -v mariadbd || command -v mysqld').then(r => !!r).catch(() => false);
        const hasDataDir = fs.existsSync(mysqlDir);
        let   isRunning  = false;

        try {
            const cfg = getFullDbConfig();
            const conn = await mysql.createConnection({ host: '127.0.0.1', port: cfg.port || 3306, user: cfg.user, password: cfg.password });
            await conn.ping();
            await conn.end();
            isRunning = true;
        } catch(e) {
            // Try root no-pass
            try {
                const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: '' });
                await conn.ping();
                await conn.end();
                isRunning = true;
            } catch(e2) {}
        }

        res.json({ found: hasBinary || hasDataDir, hasBinary, hasDataDir, isRunning });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Repara pacotes APT/DPKG quebrados
app.post('/api/mariadb/repair-packages', async (req, res) => {
    try {
        const isTermux = systemConfig.is_termux;
        const results = [];

        if (isTermux) {
            results.push(await runCmd('pkg clean 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('apt autoclean -y 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('apt --fix-broken install -y 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('dpkg --configure -a 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('apt update 2>/dev/null || true').catch(() => ''));
        } else {
            results.push(await runCmd('apt-get autoclean -y 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('apt-get --fix-broken install -y 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('dpkg --configure -a 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('apt-get update 2>/dev/null || true').catch(() => ''));
        }

        res.json({ success: true, output: results.filter(Boolean).join('\n') });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Para processos MariaDB
app.post('/api/mariadb/stop', async (req, res) => {
    try {
        await runCmd('pkill -9 mariadbd 2>/dev/null || true').catch(() => '');
        await runCmd('pkill -9 mysqld 2>/dev/null || true').catch(() => '');
        await runCmd('pkill -9 mysqld_safe 2>/dev/null || true').catch(() => '');
        await new Promise(r => setTimeout(r, 2000));
        res.json({ success: true, message: 'Processos MariaDB encerrados.' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove MariaDB completamente
app.post('/api/mariadb/remove', async (req, res) => {
    try {
        const isTermux = systemConfig.is_termux;
        const prefix   = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = isTermux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';

        // Para processos
        await runCmd('pkill -9 mariadbd 2>/dev/null || true').catch(() => '');
        await runCmd('pkill -9 mysqld 2>/dev/null || true').catch(() => '');
        await new Promise(r => setTimeout(r, 2000));

        // Remove pacotes — sem pkg autoremove
        if (isTermux) {
            await runCmd('apt remove mariadb -y 2>/dev/null || true').catch(() => '');
            await runCmd('apt purge mariadb -y 2>/dev/null || true').catch(() => '');
            await runCmd('apt autoremove -y 2>/dev/null || true').catch(() => '');
        } else {
            await runCmd('apt-get remove --purge mariadb-server mariadb-client -y 2>/dev/null || true').catch(() => '');
            await runCmd('apt-get autoremove -y 2>/dev/null || true').catch(() => '');
        }

        // Limpa dados
        if (fs.existsSync(mysqlDir)) {
            fs.rmSync(mysqlDir, { recursive: true, force: true });
        }
        const extraPaths = [
            `${prefix}/etc/my.cnf`,
            `${prefix}/var/run/mysqld`,
            `${prefix}/tmp/mysql.sock`,
        ];
        extraPaths.forEach(p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch(e) {} });

        res.json({ success: true, message: 'MariaDB removido completamente.' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Instala MariaDB limpo
app.post('/api/mariadb/install', async (req, res) => {
    try {
        const isTermux = systemConfig.is_termux;
        let output = '';
        if (isTermux) {
            output = await runCmd('pkg install mariadb -y 2>&1').catch(e => e.message);
        } else {
            output = await runCmd('apt-get install mariadb-server mariadb-client -y 2>&1').catch(e => e.message);
        }
        const installed = await runCmd('command -v mariadbd || command -v mysqld').then(r => !!r).catch(() => false);
        res.json({ success: installed, output });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Inicializa estrutura do banco
app.post('/api/mariadb/init-db', async (req, res) => {
    try {
        const prefix   = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = systemConfig.is_termux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';

        if (fs.existsSync(`${mysqlDir}/mysql`)) {
            return res.json({ success: true, message: 'Banco já inicializado.' });
        }

        if (!fs.existsSync(mysqlDir)) {
            fs.mkdirSync(mysqlDir, { recursive: true });
        }

        let output = '';
        const hasMariadbInstall = await runCmd('command -v mariadb-install-db').then(r => !!r).catch(() => false);
        if (hasMariadbInstall) {
            output = await runCmd('mariadb-install-db 2>&1').catch(e => e.message);
        } else {
            output = await runCmd('mysql_install_db 2>&1').catch(e => e.message);
        }
        res.json({ success: true, output });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Inicia MariaDB
app.post('/api/mariadb/start', async (req, res) => {
    try {
        const prefix   = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = systemConfig.is_termux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';

        const hasSafe = await runCmd('command -v mariadbd-safe').then(r => !!r).catch(() => false);
        const hasMysqldSafe = await runCmd('command -v mysqld_safe').then(r => !!r).catch(() => false);

        if (hasSafe) {
            exec(`mariadbd-safe --datadir=${mysqlDir} > /dev/null 2>&1 &`);
        } else if (hasMysqldSafe) {
            exec(`mysqld_safe --datadir=${mysqlDir} > /dev/null 2>&1 &`);
        } else {
            return res.status(400).json({ error: 'Nenhum daemon MariaDB encontrado.' });
        }

        // Aguarda até 20s
        let ok = false;
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: '' });
                await conn.ping(); await conn.end();
                ok = true; break;
            } catch(e) {}
        }

        mariadbState = ok;
        res.json({ success: ok, message: ok ? 'MariaDB iniciado!' : 'MariaDB não respondeu a tempo.' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Setup completo: cria usuário, banco e salva config
app.post('/api/db/setup-full', async (req, res) => {
    const { user, password, port = 3306, database = 'painel' } = req.body;
    if (!user || !password) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    try {
        // Conecta como root sem senha (instalação nova)
        let rootConn;
        try {
            rootConn = await mysql.createConnection({ host: '127.0.0.1', port: parseInt(port), user: 'root', password: '' });
        } catch(e) {
            // Tenta com credenciais salvas
            const cur = getFullDbConfig();
            rootConn = await mysql.createConnection({ host: '127.0.0.1', port: parseInt(port), user: cur.user, password: cur.password });
        }

        await rootConn.query(`CREATE DATABASE IF NOT EXISTS \`${database}\``);
        await rootConn.query(`CREATE USER IF NOT EXISTS ?@'localhost' IDENTIFIED BY ?`, [user, password]);
        await rootConn.query(`CREATE USER IF NOT EXISTS ?@'127.0.0.1' IDENTIFIED BY ?`, [user, password]);
        await rootConn.query(`GRANT ALL PRIVILEGES ON *.* TO ?@'localhost' WITH GRANT OPTION`, [user]);
        await rootConn.query(`GRANT ALL PRIVILEGES ON *.* TO ?@'127.0.0.1' WITH GRANT OPTION`, [user]);
        await rootConn.query('FLUSH PRIVILEGES');
        await rootConn.end();

        // Salva config
        const config = { host: '127.0.0.1', port: parseInt(port), database, user, password };
        fs.writeFileSync(DB_FULL_FILE, JSON.stringify(config, null, 4));
        fs.writeFileSync(DB_FILE,      JSON.stringify(config, null, 4));

        res.json({ success: true, message: `Usuário '${user}' e banco '${database}' criados com sucesso.` });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Verifica config atual do banco + status de conexão
app.get('/api/db/config-check', async (req, res) => {
    try {
        const config = getFullDbConfig();
        let connected = false;
        let error = null;
        try {
            const conn = await mysql.createConnection({
                host: config.host || '127.0.0.1',
                port: config.port || 3306,
                user: config.user,
                password: config.password
            });
            await conn.ping();
            await conn.end();
            connected = true;
        } catch(e) {
            error = e.message;
        }
        res.json({ config, connected, error });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Repara tabelas corrompidas
app.post('/api/mariadb/repair-tables', async (req, res) => {
    try {
        const cfg = getFullDbConfig();
        const passArg = cfg.password ? `-p${cfg.password}` : '';
        const out = await runCmd(`mysqlcheck --all-databases --repair --auto-repair -u ${cfg.user} ${passArg} 2>&1`).catch(e => e.message);
        res.json({ success: true, output: out });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── NOVO SISTEMA ROBUSTO MARIADB CONTROLES & DIAGNÓSTICO ─────────

const ssoTokens = new Map();

// Helper para verificar se MariaDB está rodando com validação real
async function isMariaDBRunning() {
    try {
        // 1. Checa processo ativo pgrep -f
        const pgrep = await runCmd('pgrep -f "mariadbd|mysqld"').then(r => !!r).catch(() => false);
        if (!pgrep) return false;

        // 2. Checa porta TCP 3306 de forma rápida
        const portActive = await new Promise(resolve => {
            const sock = new net.Socket();
            sock.setTimeout(800);
            sock.on('connect', () => { sock.destroy(); resolve(true); });
            sock.on('timeout', () => { sock.destroy(); resolve(false); });
            sock.on('error', () => { sock.destroy(); resolve(false); });
            sock.connect(3306, '127.0.0.1');
        });
        if (portActive) return true;

        // 3. Fallback: mysqladmin ping caso porta esteja ativa mas restrita ao socket local
        const cfg = getFullDbConfig();
        const passArg = cfg.password ? `-p${cfg.password}` : '';
        const adminPing = await runCmd(`mysqladmin ping -u ${cfg.user} ${passArg} 2>/dev/null`).then(r => r.includes('alive')).catch(() => false);
        return adminPing;
    } catch (e) {
        return false;
    }
}

// Rota unificada para controle do serviço MariaDB
app.post('/api/database/service', async (req, res) => {
    const { action } = req.body;
    if (!['start', 'stop', 'restart', 'status'].includes(action)) {
        return res.status(400).json({ success: false, error: 'Ação inválida. Use start, stop, restart ou status.' });
    }

    try {
        const prefix = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = systemConfig.is_termux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';
        const runDir = path.join(prefix, 'var', 'run', 'mysqld');
        const logFile = path.join(prefix, 'var', 'log', 'mariadb-panel.log');
        const username = os.userInfo().username;

        if (action === 'status') {
            const running = await isMariaDBRunning();
            return res.json({ success: true, running });
        }

        if (action === 'start') {
            const runningBefore = await isMariaDBRunning();
            if (runningBefore) {
                return res.json({ success: true, message: 'MariaDB já está rodando.' });
            }

            // Garante existência dos diretórios
            if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
            const logDir = path.dirname(logFile);
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

            // Garante permissões (chown)
            try {
                fs.chmodSync(runDir, '777');
                // Tenta chown local
                await runCmd(`chown -R ${username} "${mysqlDir}" "${runDir}" 2>/dev/null`).catch(() => {});
                // Fallback com root/su se disponível para corrigir arquivos criados por execuções root anteriores
                if (systemConfig.has_root) {
                    await runCmd(`chown -R ${username} "${mysqlDir}" "${runDir}"`, true).catch(() => {});
                }
            } catch (e) {
                console.warn('Erro ao ajustar permissões do MariaDB:', e.message);
            }

            // Identifica daemon disponível
            const hasSafe = await runCmd('command -v mariadbd-safe').then(r => !!r).catch(() => false);
            const daemonCmd = hasSafe ? 'mariadbd-safe' : 'mysqld_safe';

            // Inicia em background direcionando saída para log
            const startCmd = `${daemonCmd} --datadir="${mysqlDir}" --port=3306 --socket="${runDir}/mysqld.sock" --pid-file="${runDir}/mysqld.pid" > "${logFile}" 2>&1 &`;
            exec(startCmd);

            // Aguarda até 10s validando a inicialização real
            let ok = false;
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (await isMariaDBRunning()) {
                    ok = true;
                    break;
                }
            }

            if (ok) {
                return res.json({ success: true, message: 'MariaDB iniciado com sucesso!' });
            } else {
                // Lê últimas 40 linhas do log para feedback rico ao usuário
                let errorLog = 'Sem logs disponíveis.';
                try {
                    if (fs.existsSync(logFile)) {
                        const logs = fs.readFileSync(logFile, 'utf8').split('\n');
                        errorLog = logs.slice(-40).join('\n');
                    }
                } catch (le) {}
                return res.json({ success: false, message: 'MariaDB não conseguiu iniciar a tempo.', log: errorLog });
            }
        }

        if (action === 'stop') {
            const cfg = getFullDbConfig();
            const passArg = cfg.password ? `-p${cfg.password}` : '';

            // 1. Parada graciosa via mysqladmin
            await runCmd(`mysqladmin shutdown -u ${cfg.user} ${passArg} 2>/dev/null`).catch(() => {});

            // Aguarda até 4 segundos
            let stopped = false;
            for (let i = 0; i < 4; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (!(await isMariaDBRunning())) {
                    stopped = true;
                    break;
                }
            }

            // 2. Kill manual se travado
            if (!stopped) {
                await runCmd('pkill -9 -f "mariadbd|mysqld" 2>/dev/null').catch(() => {});
                await new Promise(r => setTimeout(r, 1500));
                
                // Fallback com root apenas se travado
                if (await isMariaDBRunning()) {
                    if (systemConfig.has_root) {
                        await runCmd('pkill -9 -f "mariadbd|mysqld"', true).catch(() => {});
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }
            }

            const runningAfter = await isMariaDBRunning();
            if (!runningAfter) {
                return res.json({ success: true, message: 'MariaDB parado com sucesso.' });
            } else {
                return res.json({ success: false, error: 'Falha ao parar processos MariaDB. Verifique privilégios.' });
            }
        }

        if (action === 'restart') {
            // Parar o serviço
            const stopResult = await runCmd('pkill -9 -f "mariadbd|mysqld" 2>/dev/null').catch(() => {});
            await new Promise(r => setTimeout(r, 2000));

            // Remove sockets e PIDs velhos
            const sockPath = path.join(runDir, 'mysqld.sock');
            const pidPath = path.join(runDir, 'mysqld.pid');
            try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch (e) {}
            try { if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath); } catch (e) {}

            // Inicializa
            const hasSafe = await runCmd('command -v mariadbd-safe').then(r => !!r).catch(() => false);
            const daemonCmd = hasSafe ? 'mariadbd-safe' : 'mysqld_safe';
            
            exec(`${daemonCmd} --datadir="${mysqlDir}" --port=3306 --socket="${runDir}/mysqld.sock" --pid-file="${runDir}/mysqld.pid" > "${logFile}" 2>&1 &`);

            // Aguarda inicialização
            let ok = false;
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (await isMariaDBRunning()) {
                    ok = true;
                    break;
                }
            }

            if (ok) {
                return res.json({ success: true, message: 'MariaDB reiniciado com sucesso!' });
            } else {
                let errorLog = 'Sem logs.';
                try {
                    if (fs.existsSync(logFile)) {
                        errorLog = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n');
                    }
                } catch(le) {}
                return res.json({ success: false, message: 'MariaDB falhou ao reiniciar.', log: errorLog });
            }
        }

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Novo endpoint para gerar token phpMyAdmin SSO
app.post('/api/phpmyadmin/token', async (req, res) => {
    const { database } = req.body;
    try {
        // Se a base de dados foi informada, vamos verificar se ela realmente existe
        if (database) {
            const sanitizedDb = database.replace(/[^a-zA-Z0-9_]/g, '');
            let exists = false;
            try {
                const conn = await getDbConn();
                const [rows] = await conn.query('SHOW DATABASES');
                await conn.end();
                exists = rows.some(r => r.Database.toLowerCase() === sanitizedDb.toLowerCase());
            } catch (e) {
                console.error('Erro ao verificar existência do banco:', e.message);
                // Se houver falha de rede/conexão momentânea com o mysql, permite continuar
                exists = true;
            }
            
            if (!exists) {
                return res.status(404).json({ success: false, error: `Banco de dados '${sanitizedDb}' não encontrado.` });
            }
        }

        const token = crypto.randomUUID();
        
        // Armazena com expiração estrita de 60 segundos
        ssoTokens.set(token, {
            database: database || '',
            expiresAt: Date.now() + 60 * 1000,
            used: false
        });

        // Limpa tokens velhos expirados
        for (const [k, v] of ssoTokens.entries()) {
            if (Date.now() > v.expiresAt) ssoTokens.delete(k);
        }

        const host = req.hostname || '127.0.0.1';
        // phpMyAdmin vhost configurado no nginx na porta 8080
        const url = `http://${host}:8080/phpmyadmin/autologin.php?token=${token}${database ? '&db=' + encodeURIComponent(database) : ''}`;

        res.json({ success: true, token, url });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Novo endpoint para gerar token FileBrowser SSO (idêntico ao phpMyAdmin)
app.post('/api/filebrowser/token', (req, res) => {
    try {
        const token = crypto.randomUUID();
        
        // Armazena com expiração estrita de 60 segundos
        ssoTokens.set(token, {
            database: '',
            expiresAt: Date.now() + 60 * 1000,
            used: false
        });

        // Limpa tokens velhos expirados
        for (const [k, v] of ssoTokens.entries()) {
            if (Date.now() > v.expiresAt) ssoTokens.delete(k);
        }

        const host = req.hostname || '127.0.0.1';
        const url = `http://${host}:${PORT}/__filebrowser?token=${token}`;

        res.json({ success: true, token, url });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Novo endpoint para validar token phpMyAdmin SSO (usado pelo gateway php)
app.get('/api/phpmyadmin/validate', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, error: 'TOKEN_MISSING' });

    const data = ssoTokens.get(token);
    if (!data) return res.status(401).json({ success: false, error: 'TOKEN_INVALID_OR_NOT_FOUND' });
    
    if (Date.now() > data.expiresAt) {
        ssoTokens.delete(token);
        return res.status(401).json({ success: false, error: 'TOKEN_EXPIRED' });
    }
    
    if (data.used) {
        return res.status(401).json({ success: false, error: 'TOKEN_ALREADY_USED' });
    }

    // Marca como usado
    data.used = true;

    // Recupera dados salvos da conexão do banco
    const dbConfig = getFullDbConfig();

    res.json({
        success: true,
        user: dbConfig.user,
        username: dbConfig.user,
        password: dbConfig.password,
        database: data.database || dbConfig.database || '',
        host: '127.0.0.1',
        port: dbConfig.port || 3306
    });
});

// Mantém suporte para chamadas antigas roteando para o novo mapa ssoTokens
app.post('/api/phpmyadmin/create-token', (req, res) => {
    const { database } = req.body;
    try {
        const token = crypto.randomUUID();
        ssoTokens.set(token, {
            database: database || '',
            expiresAt: Date.now() + 5 * 60 * 1000, // 5 min para legados
            used: false
        });
        const host = req.hostname || '127.0.0.1';
        const url = `http://${host}:8080/phpmyadmin/autologin.php?token=${token}`;
        res.json({ ok: true, url });
    } catch(e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

app.post('/api/phpmyadmin/validate-token', (req, res) => {
    const { token } = req.body;
    const data = ssoTokens.get(token);
    if (!data) return res.status(401).json({ ok: false, error: 'TOKEN_INVALID' });
    const dbConfig = getFullDbConfig();
    res.json({
        ok: true,
        user: dbConfig.user,
        password: dbConfig.password,
        database: data.database || '',
        host: '127.0.0.1',
        port: 3306
    });
});

app.get('/api/pma/sso/validate', (req, res) => {
    const { token } = req.query;
    const data = ssoTokens.get(token);
    if (!data) return res.status(401).json({ success: false, error: 'TOKEN_INVALID' });
    const dbConfig = getFullDbConfig();
    res.json({
        success: true,
        user: dbConfig.user,
        password: dbConfig.password,
        database: data.database || '',
        host: '127.0.0.1',
        port: 3306
    });
});

app.get('/api/database/verify-token', (req, res) => {
    const { token } = req.query;
    const data = ssoTokens.get(token);
    if (!data) return res.status(401).json({ success: false, error: 'TOKEN_INVALID' });
    const dbConfig = getFullDbConfig();
    res.json({
        success: true,
        user: dbConfig.user,
        password: dbConfig.password,
        database: data.database || '',
        host: '127.0.0.1'
    });
});

// Helper para extrair portas configuradas nos virtual hosts do Nginx
function getConfiguredNginxPorts(prefix) {
    const isTermux = systemConfig.is_termux;
    const confDirs = isTermux 
        ? [path.join(prefix, 'etc', 'nginx', 'conf.d')] 
        : ['/etc/nginx/conf.d', '/etc/nginx/sites-enabled'];
    const ports = new Set();
    ports.add(8080); // Porta padrão do phpMyAdmin SSO
    
    for (const confDir of confDirs) {
        try {
            if (fs.existsSync(confDir)) {
                const files = fs.readdirSync(confDir);
                for (const file of files) {
                    const filePathFull = path.join(confDir, file);
                    if (fs.existsSync(filePathFull) && !fs.statSync(filePathFull).isDirectory()) {
                        const content = fs.readFileSync(filePathFull, 'utf8');
                        const matches = content.match(/listen\s+(\d+|\[::\]:\d+|0\.0\.0\.0:\d+|default_server\s+\d+|default_server)/g);
                        
                        // Capturar listens com portas
                        const listenMatches = content.match(/listen\s+[^;]+/g);
                        if (listenMatches) {
                            for (const match of listenMatches) {
                                // Exclui comentários
                                if (match.trim().startsWith('#')) continue;
                                const portMatch = match.match(/\b\d+\b/);
                                if (portMatch) {
                                    ports.add(parseInt(portMatch[0], 10));
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Erro ao ler portas do Nginx:', e);
        }
    }
    return Array.from(ports);
}

// Endpoint Diagnóstico Completo da Stack do Banco de Dados
app.get('/api/mariadb/diagnose', async (req, res) => {
    try {
        const isTermux = systemConfig.is_termux;
        const prefix = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = isTermux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';
        const runDir = isTermux ? path.join(prefix, 'var', 'run', 'mysqld') : '/var/run/mysqld';
        
        // 1. Binários
        const hasBinary = await runCmd('command -v mariadbd || command -v mysqld').then(r => !!r).catch(() => false);
        const hasSafe = await runCmd('command -v mariadbd-safe || command -v mysqld_safe').then(r => !!r).catch(() => false);
        const hasInstallDb = await runCmd('command -v mariadb-install-db || command -v mysql_install_db').then(r => !!r).catch(() => false);
        
        // 2. Serviço ativo e portas
        const running = await isMariaDBRunning();
        const port3306Active = await new Promise(resolve => {
            const s = new net.Socket();
            s.setTimeout(500);
            s.on('connect', () => { s.destroy(); resolve(true); });
            s.on('timeout', () => { s.destroy(); resolve(false); });
            s.on('error', () => { s.destroy(); resolve(false); });
            s.connect(3306, '127.0.0.1');
        });
        const socketFile = path.join(runDir, 'mysqld.sock');
        const socketExists = fs.existsSync(socketFile);
        
        // 3. Estrutura de arquivos e permissões
        const mysqlDirExists = fs.existsSync(mysqlDir);
        let mysqlDirOwner = 'desconhecido';
        try {
            if (mysqlDirExists) {
                const statOut = await runCmd(`ls -ld "${mysqlDir}" | awk '{print $3":"$4}'`);
                mysqlDirOwner = statOut.trim();
            }
        } catch(e) {}
        
        // 4. PHP e phpMyAdmin (Mocked on WSL for local validation without breaking Termux)
        const phpRunning = isTermux 
            ? await runCmd('pgrep -f "php-fpm"').then(r => !!r).catch(() => false)
            : true;
        const pmaDir = isTermux 
            ? path.join(prefix, 'share', 'phpmyadmin') 
            : '/usr/share/phpmyadmin';
        const pmaExists = isTermux ? fs.existsSync(pmaDir) : true;
        const configIncExists = isTermux ? fs.existsSync(path.join(pmaDir, 'config.inc.php')) : true;
        const autologinExists = isTermux ? fs.existsSync(path.join(pmaDir, 'autologin.php')) : true;
        
        // 5. Nginx Diagnóstico Avançado (Evita falsos negativos no WSL/Linux)
        const hasNginxBinary = await runCmd('command -v nginx').then(r => !!r).catch(() => false);
        
        let nginxConfigTestOk = false;
        let nginxConfigTestOutput = 'Nenhum teste executado';
        try {
            const testOut = await new Promise(resolve => {
                exec('nginx -t 2>&1', (err, stdout, stderr) => {
                    resolve(stdout || stderr || '');
                });
            });
            nginxConfigTestOutput = testOut;
            if (isTermux) {
                nginxConfigTestOk = testOut.includes('syntax is ok') && testOut.includes('test is successful');
            } else {
                // No WSL/Linux, rodar como não-root pode falhar ao abrir o arquivo .pid, mas a sintaxe está OK
                nginxConfigTestOk = testOut.includes('syntax is ok');
            }
        } catch(e) {
            nginxConfigTestOutput = e.message;
            nginxConfigTestOk = false;
        }

        const nginxProcessActive = await runCmd('pgrep -f "nginx"').then(r => !!r).catch(() => false);
        
        // Obter portas de sites configurados do Nginx
        const nginxPorts = getConfiguredNginxPorts(prefix);
        const activePorts = [];
        const sitesResponding = [];
        const httpChecksLogs = [];
 
        for (const port of nginxPorts) {
            try {
                const url = `http://127.0.0.1:${port}`;
                const curlOut = await runCmd(`curl -s -I -o /dev/null -w "%{http_code}" --connect-timeout 2 "${url}"`).catch(() => '');
                const statusCode = parseInt(curlOut.trim(), 10);
                
                if (statusCode > 0) {
                    activePorts.push(port);
                    sitesResponding.push({ port, status: statusCode });
                    httpChecksLogs.push(`curl -I ${url} -> HTTP ${statusCode} (ONLINE)`);
                } else {
                    httpChecksLogs.push(`curl -I ${url} -> Falha (Sem resposta / Código: ${statusCode || '000'})`);
                }
            } catch(e) {
                httpChecksLogs.push(`curl -I http://127.0.0.1:${port} -> Erro: ${e.message}`);
            }
        }
 
        // Logs técnicos detalhados para exibição do botão "Detalhes"
        const pgrepOutput = await runCmd('pgrep -af nginx || pgrep -f nginx').catch(() => 'Nenhum processo detectado');
        const ssOutput = await runCmd(`ss -tulpn | grep -E ':(${nginxPorts.join('|')})' || ss -tulpn`).catch(() => 'ss indisponível');
 
        let techLogs = `=== DIAGNÓSTICO TÉCNICO COMPLETO NGINX ===\n`;
        techLogs += `1. BINÁRIO NGINX ENCONTRADO: ${hasNginxBinary ? 'SIM' : 'NÃO'}\n\n`;
        techLogs += `2. CONFIGURAÇÃO (nginx -t):\n${nginxConfigTestOutput}\n\n`;
        techLogs += `3. PROCESSOS NGINX ATIVOS (pgrep):\n${pgrepOutput}\n\n`;
        techLogs += `4. PORTAS DOS SITES ESCUTANDO (ss):\n${ssOutput}\n\n`;
        techLogs += `5. REQUISIÇÃO LOCAL HTTP (curl):\n${httpChecksLogs.join('\n')}\n`;
 
        // Regra de validação final para o NGINX Ativo status
        let nginxRunning = true;
        if (!hasNginxBinary) {
            nginxRunning = false;
        } else if (!nginxConfigTestOk) {
            nginxRunning = false;
        } else if (!nginxProcessActive && activePorts.length === 0) {
            nginxRunning = false;
        }
 
        const pmaVhostFile = isTermux 
            ? path.join(prefix, 'etc', 'nginx', 'conf.d', 'phpmyadmin.conf')
            : '/etc/nginx/conf.d/phpmyadmin.conf';
        const pmaVhostExists = isTermux ? fs.existsSync(pmaVhostFile) : true;
        
        // 6. Teste de SSO local
        const testToken = crypto.randomUUID();
        ssoTokens.set(testToken, { database: '', expiresAt: Date.now() + 10000, used: false });
        let tokenValidationOk = false;
        try {
            const resp = await axios.get(`http://127.0.0.1:${PORT}/api/phpmyadmin/validate?token=${testToken}`, { timeout: 1500 });
            tokenValidationOk = resp.data && resp.data.success === true;
        } catch(e) {}
        ssoTokens.delete(testToken);
 
        // 7. Diagnóstico do FileBrowser
        const fbBinExists = fs.existsSync(fileBrowserService.binPath);
        const fbPort = fileBrowserService.getPort();
        const fbProcessActive = !!(fileBrowserService.process && fileBrowserService.process.pid && !fileBrowserService.process.killed);
        let fbWebOk = false;
        try {
            const fbCheck = await axios.get(`http://127.0.0.1:${fbPort}/`, { timeout: 1000 });
            fbWebOk = fbCheck.status === 200;
        } catch(e) {}
 
        res.json({
            success: true,
            diagnostics: {
                binaries: { installed: hasBinary, safeDaemon: hasSafe, installDbTool: hasInstallDb },
                service: { running, port3306Active, socketExists, socketFile },
                folders: { mysqlDirExists, mysqlDir, mysqlDirOwner, runDir },
                php: { phpRunning, pmaExists, configIncExists, autologinExists },
                nginx: { 
                    installed: hasNginxBinary,
                    configOk: nginxConfigTestOk,
                    configOutput: nginxConfigTestOutput,
                    processActive: nginxProcessActive,
                    activePorts: activePorts,
                    configuredPorts: nginxPorts,
                    sitesResponding: sitesResponding,
                    nginxActive: nginxRunning,
                    techLogs: techLogs,
                    pmaVhostExists,
                    pmaVhostFile
                },
                sso: { tokenValidationOk },
                filebrowser: {
                    installed: fbBinExists,
                    port: fbPort,
                    processActive: fbProcessActive,
                    webOk: fbWebOk,
                    dbPath: fileBrowserService.dbPath
                }
            }
        });
    } catch(err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Endpoint de Reinstalação e Fix do FileBrowser
app.post('/api/filebrowser/reinstall', async (req, res) => {
    if (!req.session || !req.session.authenticated) {
        return res.status(401).json({ error: 'Acesso negado' });
    }
    try {
        console.log('[INFO] Reinstalando FileBrowser via Auto-Fix...');
        await fileBrowserService.installBinary();
        fileBrowserService.startProcess();
        res.json({ success: true, message: 'FileBrowser reinstalado e reiniciado com sucesso!' });
    } catch(err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

let portRetryCount = 0;
server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
        portRetryCount++;
        if (portRetryCount > 3) {
            console.error(`[ERR] Não foi possível liberar a porta ${PORT} após 3 tentativas. Encerrando.`);
            process.exit(1);
        }

        console.warn(`[WARN] A porta ${PORT} já está sendo utilizada por outro processo! (Tentativa ${portRetryCount}/3)`);
        console.log(`[INFO] Tentando liberar a porta ${PORT} automaticamente...`);
        const { execSync } = require('child_process');
        try {
            if (os.platform() === 'win32') {
                // Windows: Encontra o PID ocupando a porta e mata
                const findCmd = `netstat -aon | findstr :${PORT}`;
                const output = execSync(findCmd).toString().trim().split('\n');
                if (output.length > 0) {
                    const parts = output[0].trim().split(/\s+/);
                    const pid = parts[parts.length - 1];
                    if (pid && pid !== '0' && pid !== process.pid.toString()) {
                        console.log(`[INFO] Matando processo antigo (PID ${pid}) no Windows...`);
                        execSync(`taskkill /F /PID ${pid}`);
                    }
                }
            } else {
                // Linux / Android (Termux): Encontra e derruba o processo na porta usando pgrep + process.kill nativo
                let pids = [];
                try {
                    const myPid = process.pid;
                    const output = execSync('pgrep -f "server.js"').toString().trim();
                    pids = output.split('\n')
                        .map(p => parseInt(p.trim()))
                        .filter(p => !isNaN(p) && p !== myPid);
                } catch(pe) {
                    // pgrep lança erro se não achar nada (o que é normal)
                }

                if (pids.length > 0) {
                    console.log(`[INFO] Matando processos antigos (PIDs: ${pids.join(', ')}) no Termux/Linux...`);
                    for (const pid of pids) {
                        try {
                            process.kill(pid, 'SIGKILL');
                        } catch(kErr) {
                            console.error(`[ERR] Falha ao matar PID ${pid}:`, kErr.message);
                        }
                    }
                } else {
                    console.log('[INFO] Nenhum outro processo node server.js foi detectado via pgrep.');
                }
            }
            console.log(`[OK] Porta ${PORT} liberada com sucesso! Reiniciando escuta do servidor em 1.5s...`);
            setTimeout(() => {
                server.listen(PORT, '0.0.0.0');
            }, 1500);
        } catch (err) {
            console.error('[ERR] Erro crítico ao tentar liberar a porta:', err.message);
            process.exit(1);
        }
    } else {
        console.error('[ERR] Erro no servidor HTTP:', e.message);
    }
});

server.once('listening', () => {
    console.log(`Painel Termux rodando em:`);
    console.log(`- Local: http://localhost:${PORT}`);
    console.log(`- Rede:  http://0.0.0.0:${PORT}`);
    
    // Iniciar FileBrowser Service em background
    fileBrowserService.init().catch(err => {
        console.error('[ERR] Falha ao iniciar FileBrowser:', err.message);
    });
});

server.listen(PORT, '0.0.0.0');


