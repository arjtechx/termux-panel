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
const BASE_DIR = process.env.HOME || __dirname;
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
    if (req.path === '/login' || req.path === '/login.html' || req.path.startsWith('/api/login') || req.path.startsWith('/socket.io/') || req.path.endsWith('.css') || req.path.endsWith('.js')) {
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

// Utils to run commands safely
function runCmd(cmd) {
    return new Promise((resolve) => {
        exec(cmd, (error, stdout, stderr) => {
            if (error) resolve('');
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
        await runCmd('su -c reboot');
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

// --- NGINX Manager Logic ---
const PREFIX = process.env.PREFIX || '/data/data/com.termux/files/usr';
const NGINX_CONF_DIR = `${PREFIX}/etc/nginx/conf.d`;

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
    if (data.used) return res.status(401).json({ ok: false, error: 'TOKEN_ALREADY_USED' });
    if (Date.now() > data.expiresAt) return res.status(401).json({ ok: false, error: 'TOKEN_EXPIRED' });
    
    data.used = true; // Single use
    phpMyAdminTokens.delete(token); // Opcional, ou deleta após o uso

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
    if (data.used) return res.status(401).json({ success: false, error: 'TOKEN_ALREADY_USED' });
    if (Date.now() > data.expiresAt) return res.status(401).json({ success: false, error: 'TOKEN_EXPIRED' });
    
    data.used = true;
    phpMyAdminTokens.delete(token);

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
    if (data.used) return res.status(401).json({ success: false, error: 'TOKEN_ALREADY_USED' });
    if (Date.now() > data.expiresAt) return res.status(401).json({ success: false, error: 'TOKEN_EXPIRED' });
    
    data.used = true;
    phpMyAdminTokens.delete(token);

    res.json({
        success: true,
        user: data.user,
        password: data.password,
        database: data.database,
        host: '127.0.0.1'
    });
});

// --- File Manager Logic ---
app.get('/api/files', async (req, res) => {
    try {
        const queryDir = req.query.dir || BASE_DIR;
        const resolvedDir = path.resolve(queryDir);
        
        if (!fs.existsSync(resolvedDir)) {
            return res.status(404).json({ error: 'Diretório não encontrado' });
        }

        const files = fs.readdirSync(resolvedDir);
        const fileList = files.map(file => {
            const filePath = path.join(resolvedDir, file);
            try {
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    path: filePath,
                    isDirectory: stats.isDirectory(),
                    size: stats.size,
                    mtime: stats.mtime
                };
            } catch (e) {
                return null;
            }
        }).filter(f => f !== null);

        res.json({
            currentDir: resolvedDir,
            parentDir: path.dirname(resolvedDir),
            files: fileList
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/files/read', (req, res) => {
    try {
        const filePath = req.query.file;
        if (!fs.existsSync(filePath)) return res.status(404).send('Arquivo não encontrado');
        
        const content = fs.readFileSync(filePath, 'utf8');
        res.send(content);
    } catch (err) {
        res.status(500).send(err.message);
    }
});

app.delete('/api/files', (req, res) => {
    try {
        const targetPath = req.query.path;
        if (!fs.existsSync(targetPath)) return res.status(404).json({ error: 'Alvo não encontrado' });
        const stats = fs.statSync(targetPath);
        if (stats.isDirectory()) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        } else {
            fs.unlinkSync(targetPath);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/files/upload', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
    const fileName = req.headers['x-file-name'];
    const targetDir = req.headers['x-target-dir'];
    try {
        const targetPath = path.join(targetDir, fileName);
        fs.writeFileSync(targetPath, req.body);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Advanced File Operations ---

// Helper for recursive copy
function copyRecursiveSync(src, dest) {
    const exists = fs.existsSync(src);
    const stats = exists && fs.statSync(src);
    const isDirectory = exists && stats.isDirectory();
    if (isDirectory) {
        if (!fs.existsSync(dest)) fs.mkdirSync(dest);
        fs.readdirSync(src).forEach(childItemName => {
            copyRecursiveSync(path.join(src, childItemName), path.join(dest, childItemName));
        });
    } else {
        fs.copyFileSync(src, dest);
    }
}

app.post('/api/files/mkdir', (req, res) => {
    const { dir, name } = req.body;
    try {
        const newPath = path.join(dir, name);
        if (!fs.existsSync(newPath)) {
            fs.mkdirSync(newPath, { recursive: true });
            res.json({ success: true });
        } else {
            res.status(400).json({ error: 'Diretório já existe' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/files/rename', (req, res) => {
    const { oldPath, newPath } = req.body;
    try {
        fs.renameSync(oldPath, newPath);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/files/copy', (req, res) => {
    const { items, targetDir } = req.body;
    try {
        items.forEach(item => {
            const dest = path.join(targetDir, path.basename(item));
            copyRecursiveSync(item, dest);
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/files/move', (req, res) => {
    const { items, targetDir } = req.body;
    try {
        items.forEach(item => {
            const dest = path.join(targetDir, path.basename(item));
            fs.renameSync(item, dest);
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/files/compress', async (req, res) => {
    const { items, archiveName, currentDir } = req.body;
    try {
        const itemNames = items.map(i => `"${path.basename(i)}"`).join(' ');
        if (archiveName.endsWith('.zip')) {
            await runCmd(`cd "${currentDir}" && zip -r "${archiveName}" ${itemNames}`);
        } else if (archiveName.endsWith('.tar.gz')) {
            await runCmd(`cd "${currentDir}" && tar -czvf "${archiveName}" ${itemNames}`);
        } else {
            return res.status(400).json({ error: 'Formato não suportado' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/files/extract', async (req, res) => {
    const { archivePath, targetDir } = req.body;
    try {
        if (archivePath.endsWith('.zip')) {
            await runCmd(`unzip -o "${archivePath}" -d "${targetDir}"`);
        } else if (archivePath.endsWith('.tar.gz')) {
            await runCmd(`tar -xzvf "${archivePath}" -C "${targetDir}"`);
        } else {
            return res.status(400).json({ error: 'Formato não suportado' });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/files/save', (req, res) => {
    const { path: filePath, content } = req.body;
    try {
        fs.writeFileSync(filePath, content, 'utf8');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

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

    const proc = spawn('bash', [UPDATE_SCRIPT], {
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
                // Se falhar na API do GitHub, reporta sem update mas com erro
                updateMethod = 'github_error';
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

    res.json({
        services: {
            nginx:    { installed: hasNginx,    running: nginxRunning,   port80 },
            mariadb:  { installed: hasMariadb,  running: mariadbRunning, port3306 },
            phpfpm:   { installed: hasPHP,      running: phpfpmRunning },
            phpmyadmin: { installed: hasPMA,    port8080 },
        }
    });
});

server.listen(PORT, '0.0.0.0', () => {
    console.log(`Painel Termux rodando em:`);
    console.log(`- Local: http://localhost:${PORT}`);
    console.log(`- Rede:  http://0.0.0.0:${PORT}`);
});

