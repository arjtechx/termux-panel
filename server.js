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
const SYSTEM_FILE = path.join(__dirname, 'config', 'system.json');
const BASE_DIR = process.env.HOME || __dirname;
const DEFAULT_AUTH = { user: 'admin', pass: 'admin' };

// ============================================================
//  DETECÇÃO DE AMBIENTE UNIVERSAL
//  Suporta: Termux, WSL, Ubuntu/Debian, Fedora/RHEL, Arch, Alpine, macOS
// ============================================================
const systemConfig = require('./src/utils/env');

const BACKUP_DIR = path.join(BASE_DIR, 'backups');

// Initialize config directory
if (!fs.existsSync(path.join(__dirname, 'config'))) {
    fs.mkdirSync(path.join(__dirname, 'config'), { recursive: true });
}

// Initialize default files if missing
if (!fs.existsSync(APPS_FILE)) fs.writeFileSync(APPS_FILE, '[]');
if (!fs.existsSync(NOIP_FILE)) fs.writeFileSync(NOIP_FILE, JSON.stringify({ interval: 15, autostart: false }));
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ host: 'localhost', user: 'root', password: '' }));
if (!fs.existsSync(AUTH_FILE)) fs.writeFileSync(AUTH_FILE, JSON.stringify(DEFAULT_AUTH));

function readAuthConfig() {
    if (!fs.existsSync(AUTH_FILE)) {
        fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
        fs.writeFileSync(AUTH_FILE, JSON.stringify(DEFAULT_AUTH));
    }
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
}

app.use(cors());
app.use(express.json());
app.use(session({
    secret: 'termux-cpanel-secret',
    resave: false,
    saveUninitialized: true,
    cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

// Auth Middleware
const { checkAuth } = require('./src/utils/auth');

app.use(checkAuth);
app.use(express.static(path.join(__dirname, 'public')));
// --- Auth Routes ---
app.post('/api/login', (req, res) => {
    const { user, pass } = req.body;
    try {
        const auth = readAuthConfig();
        if (user === auth.user && pass === auth.pass) {
            req.session.authenticated = true;
            setTimeout(() => {
                cleanupDuplicatePanelProcesses().catch(() => {});
                cleanupDuplicateTermuxApiProcesses(true).catch(() => {});
            }, 250);
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


// --- Modular Router Mounts ---
const appsRoutes = require('./src/routes/appsRoutes');
app.use('/api/apps', appsRoutes);

const backupRoutes = require('./src/routes/backupRoutes');
app.use('/api/backup', backupRoutes);

const healthRoutes = require('./src/routes/healthRoutes');
app.use('/api/health', healthRoutes);

const cronRoutes = require('./src/routes/cronRoutes');
app.use('/api/cron', cronRoutes);

const databaseRoutes = require('./src/routes/databaseRoutes');
app.use('/', databaseRoutes);

const fileRoutes = require('./src/routes/fileRoutes');
app.use('/api/files', fileRoutes);

const hostingRoutes = require('./src/routes/hostingRoutes');
app.use('/api/hosting', hostingRoutes);

const nginxRoutes = require('./src/routes/nginxRoutes');
app.use('/api/nginx', nginxRoutes);

const noipRoutes = require('./src/routes/noipRoutes')(io);
app.use('/api/noip', noipRoutes);

try {
    const cloudflaredRoutes = require('./modules/cloudflared/routes')();
    app.use('/api', cloudflaredRoutes);
} catch (e) {
    console.error('\n[ERR] ==========================================');
    console.error('[ERR] Falha ao carregar o módulo Cloudflare Tunnel!');
    console.error('[ERR] Erro:', e.message);
    console.error('[ERR] Certifique-se de que a pasta ./modules/cloudflared existe.');
    console.error('[ERR] ==========================================\n');
}

const systemRoutes = require('./src/routes/systemRoutes');
app.use('/', systemRoutes);

const updateRoutes = require('./src/routes/updateRoutes');
app.use('/', updateRoutes);

const speedtestRoutes = require('./src/routes/speedtestRoutes');
app.use('/api', speedtestRoutes);
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

const { chownToUser, runCmd, runCmdTimeout, checkPortStatus } = require('./src/utils/shell');

let batteryProbeInFlight = null;
let lastBatteryTemperature = null;
let lastBatteryProbeAt = 0;
let lastTermuxProcessCleanupAt = 0;

async function cleanupDuplicateTermuxApiProcesses(force = false) {
    if (!systemConfig.is_termux) return { killed: [] };
    const now = Date.now();
    if (!force && now - lastTermuxProcessCleanupAt < 15000) return { skipped: true, killed: [] };
    lastTermuxProcessCleanupAt = now;

    const script = `
patterns='termux-battery-status|termux-api BatteryStatus'
pids=$(pgrep -f "$patterns" 2>/dev/null | sort -n)
keep=$(printf '%s\\n' "$pids" | tail -n 1)
killed=''
for pid in $pids; do
  [ -z "$pid" ] && continue
  [ "$pid" = "$$" ] && continue
  [ "$pid" = "$keep" ] && continue
  kill -9 "$pid" 2>/dev/null && killed="$killed $pid"
done
printf '%s' "$killed"
`;

    const out = await runCmdTimeout(script, 3000).catch(() => '');
    return { killed: out.trim().split(/\s+/).filter(Boolean) };
}

async function cleanupDuplicatePanelProcesses() {
    if (!systemConfig.is_termux && !systemConfig.is_linux && !systemConfig.is_wsl) return { killed: [] };
    const keepPid = process.pid;
    const panelDir = __dirname.replace(/'/g, "'\\''");
    const script = `
panel_dir='${panelDir}'
pids=$(pgrep -f 'node .*server\\.js|node server\\.js|node.*termux-panel/server\\.js' 2>/dev/null | sort -n)
killed=''
for pid in $pids; do
  [ -z "$pid" ] && continue
  [ "$pid" = "${keepPid}" ] && continue
  cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null || true)
  cmd=$(tr '\\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)
  if [ "$cwd" != "$panel_dir" ] && ! printf '%s' "$cmd" | grep -F "$panel_dir/server.js" >/dev/null 2>&1; then
    continue
  fi
  kill "$pid" 2>/dev/null || true
  sleep 1
  kill -9 "$pid" 2>/dev/null && killed="$killed $pid"
done
printf '%s' "$killed"
`;
    const out = await runCmdTimeout(script, 5000).catch(() => '');
    return { killed: out.trim().split(/\s+/).filter(Boolean) };
}

async function readTermuxBatteryTemperature() {
    if (!systemConfig.is_termux) return null;

    const cacheFresh = Date.now() - lastBatteryProbeAt < 12000;
    if (cacheFresh && lastBatteryTemperature) return lastBatteryTemperature;

    if (batteryProbeInFlight) {
        return lastBatteryTemperature;
    }

    batteryProbeInFlight = (async () => {
        await cleanupDuplicateTermuxApiProcesses();
        try {
            const raw = await runCmdTimeout('termux-battery-status', 3500);
            const bat = JSON.parse(raw || '{}');
            if (bat.temperature) {
                lastBatteryTemperature = `${bat.temperature}°C`;
                lastBatteryProbeAt = Date.now();
            }
        } catch (_) {
            await cleanupDuplicateTermuxApiProcesses(true);
        } finally {
            batteryProbeInFlight = null;
        }
        return lastBatteryTemperature;
    })();

    return batteryProbeInFlight;
}

app.get('/api/env', (req, res) => {
    res.json(systemConfig);
});

// Routes
app.get('/api/status', async (req, res) => {
    try {
        const status = {
            cpu: '0%', cpuCores: os.cpus().length, cpuSpeed: 'N/A',
            ram: '-- / --', storageFree: 'N/A', storageTotal: 'N/A',
            storagePercent: '0', temperature: 'N/A', totalDown: '0', totalUp: '0'
        };

        // CPU — loadavg funciona em todos os sistemas Unix-like
        status.cpu = `${Math.round(os.loadavg()[0] * 100)}%`;

        // CPU Speed
        const speeds = os.cpus().map(c => c.speed).filter(s => s > 0);
        if (speeds.length > 0) {
            status.cpuSpeed = `${(speeds[0] / 1000).toFixed(2)} GHz`;
        } else if (systemConfig.is_termux || systemConfig.is_linux || systemConfig.is_wsl) {
            const freqOut = await runCmd('cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq');
            if (freqOut && !isNaN(freqOut)) status.cpuSpeed = `${(parseInt(freqOut) / 1000000).toFixed(2)} GHz`;
        }

        // RAM
        if (systemConfig.is_macos) {
            try {
                const totalMem = parseInt(await runCmd('sysctl -n hw.memsize') || '0');
                const vmStat  = await runCmd('vm_stat');
                const pages   = parseInt((vmStat.match(/Pages free:\s+(\d+)/) || [])[1] || 0);
                const totalMB = Math.round(totalMem / 1024 / 1024);
                const freeMB  = Math.round(pages * 4096 / 1024 / 1024);
                status.ram = `${totalMB - freeMB}MB / ${totalMB}MB`;
            } catch(_) {}
        } else {
            // Linux / WSL / Termux
            const freeOut = await runCmd('free -m');
            const m = freeOut.match(/Mem:\s+(\d+)\s+(\d+)/);
            if (m) status.ram = `${m[2]}MB / ${m[1]}MB`;
        }

        // Storage — adapta o path por ambiente
        const storagePath = systemConfig.storage_path || '/';
        const dfOut = await runCmd(`df -h "${storagePath}"`);
        const dfLines = dfOut.split('\n');
        if (dfLines.length > 1) {
            const parts = dfLines[1].trim().split(/\s+/);
            if (parts.length >= 5) {
                status.storageFree    = parts[3];
                status.storageTotal   = parts[1];
                status.storagePercent = parts[4].replace('%', '');
            }
        }

        // Temperatura
        if (systemConfig.is_termux) {
            try {
                const temp = await readTermuxBatteryTemperature();
                if (temp) status.temperature = temp;
            } catch(_) {}
        } else if (systemConfig.is_linux || systemConfig.is_wsl) {
            try {
                const t = await runCmd('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo ""');
                if (t && !isNaN(parseInt(t))) status.temperature = `${(parseInt(t) / 1000).toFixed(1)}°C`;
            } catch(_) {}
        } else if (systemConfig.is_macos) {
            try {
                const t = await runCmd('osx-cpu-temp 2>/dev/null || istats cpu temp --value-only 2>/dev/null || echo ""');
                if (t && !isNaN(parseFloat(t))) status.temperature = `${parseFloat(t).toFixed(1)}°C`;
            } catch(_) {}
        }

        // Rede — /proc/net/dev em Linux/WSL/Termux, netstat no macOS
        if (systemConfig.is_linux || systemConfig.is_wsl || systemConfig.is_termux) {
            let totalDown = 0;
            let totalUp = 0;
            
            try {
                const netOut = await runCmd('cat /proc/net/dev 2>/dev/null || echo ""');
                // Tenta vários nomes de interface em ordem de prioridade
                for (const iface of ['wlan0', 'eth0', 'ens3', 'ens33', 'enp0s3', 'wlp2s0', 'usb0']) {
                    const m = netOut.match(new RegExp(`\\s*${iface}[^:]*:\\s*(\\d+)(?:\\s+\\d+){7}\\s+(\\d+)`));
                    if (m) {
                        totalDown = parseInt(m[1]) || 0;
                        totalUp = parseInt(m[2]) || 0;
                        break;
                    }
                }
            } catch(_) {}

            // Termux: use only ip -s link when root not available, avoid ifconfig which may require root
            if (systemConfig.is_termux && totalDown === 0 && totalUp === 0) {
                try {
                    // Prefer ip command; it works without root on most Termux setups
                    const ipOut = await runCmd('ip -s link show wlan0 2> /dev/null || ip -s link 2> /dev/null || echo ""');
                    // Parse RX bytes after the "RX:" header
                    let rxMatches = ipOut.match(/RX:[^\n]*\n\s*(\d+)/i);
                    // Parse TX bytes after the "TX:" header
                    let txMatches = ipOut.match(/TX:[^\n]*\n\s*(\d+)/i);
                    if (rxMatches && txMatches) {
                        totalDown = parseInt(rxMatches[1]) || 0;
                        totalUp = parseInt(txMatches[1]) || 0;
                    } else if (systemConfig.has_root) {
                        // If ip parsing fails and we have root, fallback to ifconfig as last resort
                        const ifconfigOut = await runCmd('ifconfig wlan0 2> /dev/null || ifconfig 2> /dev/null || echo ""');
                        let matchRx = ifconfigOut.match(/RX[^b]*bytes[:\s]+(\d+)/i);
                        let matchTx = ifconfigOut.match(/TX[^b]*bytes[:\s]+(\d+)/i);
                        if (matchRx && matchTx) {
                            totalDown = parseInt(matchRx[1]) || 0;
                            totalUp = parseInt(matchTx[1]) || 0;
                        }
                    }
                } catch(_) {}
            }

            status.totalDown = `${(totalDown / 1024 / 1024).toFixed(2)} MB`;
            status.totalUp   = `${(totalUp / 1024 / 1024).toFixed(2)} MB`;
        } else if (systemConfig.is_macos) {
            const netOut = await runCmd("netstat -ib | grep -E '^en[0-9]' | head -1");
            if (netOut) {
                const p = netOut.trim().split(/\s+/);
                if (p.length >= 10) {
                    status.totalDown = `${(parseInt(p[6] || 0) / 1024 / 1024).toFixed(2)} MB`;
                    status.totalUp   = `${(parseInt(p[9] || 0) / 1024 / 1024).toFixed(2)} MB`;
                }
            }
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

app.post('/api/processes/cleanup-duplicates', async (req, res) => {
    try {
        const termuxApi = await cleanupDuplicateTermuxApiProcesses(true);
        const panel = await cleanupDuplicatePanelProcesses();
        res.json({ success: true, termuxApi, panel });
    } catch (err) {
        res.status(500).json({ error: err.message });
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
                // Linux / Android (Termux): derruba apenas o processo que ocupa a porta do painel.
                let pids = [];
                try {
                    const myPid = process.pid;
                    const output = execSync(`lsof -t -i:${PORT} 2>/dev/null || true`).toString().trim();
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
});

server.listen(PORT, '0.0.0.0');
