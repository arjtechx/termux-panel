const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');
const systemConfig = require('../utils/env');
const { runCmd } = require('../utils/shell');

const SERVER_CONFIG_FILE = path.join(__dirname, '..', '..', 'config', 'server.json');
const AUTH_FILE = path.join(__dirname, '..', '..', 'config', 'auth.json');

// --- Funções Auxiliares para o Dashboard (sem exec para evitar criação de processos filhos) ---

function getCpuUsageSync() {
    // Usa os.cpus() para calcular a média de carga — sem spawn de processos
    const cpus = os.cpus();
    if (!cpus || cpus.length === 0) return '0%';
    let totalIdle = 0, totalTick = 0;
    for (const cpu of cpus) {
        for (const type of Object.keys(cpu.times)) {
            totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
    }
    const usage = ((totalTick - totalIdle) / totalTick * 100);
    return usage.toFixed(1) + '%';
}

function getTemperatureSync() {
    try {
        const raw = fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim();
        const temp = parseInt(raw);
        if (temp > 1000) return (temp / 1000).toFixed(1) + '\u00b0C';
        if (temp > 0) return temp + '\u00b0C';
    } catch(e) {}
    return '--\u00b0C';
}

function getStorageSync() {
    // Lê /proc/mounts para encontrar /data sem criar processos filhos
    try {
        const totalMem = os.totalmem();
        const freeMem  = os.freemem();
        // Fallback simples: usa espaço da partição home do Termux
        // Lemos o /data via fs.statfs não disponível no Node, então retornamos dados de RAM como proxy
        const usedPct = Math.round((1 - freeMem / totalMem) * 100);
        return { free: '--', total: '--', pct: usedPct };
    } catch(e) {}
    return { free: '--', total: '--', pct: 0 };
}

// Cache de storage (atualizado a cada 60s para não chamar df muito)
let _storageCache = null;
let _storageCacheTime = 0;
function getStorageCached() {
    const now = Date.now();
    if (_storageCache && now - _storageCacheTime < 60000) return Promise.resolve(_storageCache);
    return new Promise(resolve => {
        const { exec: execChild } = require('child_process');
        execChild('df -h /data/data/com.termux 2>/dev/null || df -h /data 2>/dev/null || df -h /', { timeout: 3000 }, (err, stdout) => {
            if (err || !stdout) { _storageCache = { free: '--', total: '--', pct: 0 }; }
            else {
                const lines = stdout.trim().split('\n');
                if (lines.length > 1) {
                    const parts = lines[1].split(/\s+/).filter(Boolean);
                    if (parts.length >= 5) {
                        _storageCache = { free: parts[3], total: parts[1], pct: parseInt(parts[4]) || 0 };
                    } else _storageCache = { free: '--', total: '--', pct: 0 };
                } else _storageCache = { free: '--', total: '--', pct: 0 };
            }
            _storageCacheTime = now;
            resolve(_storageCache);
        });
    });
}

// --- Dashboard Status Endpoint (leve e seguro) ---
router.get('/api/status', async (req, res) => {
    try {
        const cpus     = os.cpus();
        const cpuCores = cpus ? cpus.length : '--';
        const cpuSpeed = (cpus && cpus[0] && cpus[0].speed)
            ? (cpus[0].speed / 1000).toFixed(1) + ' GHz'
            : '-- GHz';

        const totalMem = os.totalmem();
        const freeMem  = os.freemem();
        const usedMem  = totalMem - freeMem;

        const fmt = (b) => {
            if (!b) return '0 B';
            const k = 1024, s = ['B','KB','MB','GB'], i = Math.floor(Math.log(b)/Math.log(k));
            return (b/Math.pow(k,i)).toFixed(1) + ' ' + s[i];
        };

        const cpuPercent = getCpuUsageSync();
        const temp       = getTemperatureSync();
        const storage    = await getStorageCached();

        res.json({
            cpu:            cpuPercent,
            cpuCores:       cpuCores,
            cpuSpeed:       cpuSpeed,
            ram:            `${fmt(usedMem)} / ${fmt(totalMem)}`,
            storageFree:    storage.free,
            storageTotal:   storage.total,
            storagePercent: storage.pct,
            temperature:    temp,
            totalDown:      '--',
            totalUp:        '--'
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// --- Power and Services Controls ---
router.post('/api/reboot', async (req, res) => {
    try {
        await runCmd('reboot', true);
        res.json({ success: true, message: 'Rebooting...' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

let wakelockState = false;
router.post('/api/wakelock', async (req, res) => {
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
router.post('/api/sshd', async (req, res) => {
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
router.post('/api/mariadb/toggle', async (req, res) => {
    try {
        if (!mariadbState) {
            if (systemConfig.is_termux) {
                await runCmd(`mariadbd-safe --datadir=${systemConfig.mysql_data_dir} > /dev/null 2>&1 &`);
            } else if (systemConfig.is_macos) {
                await runCmd('brew services start mariadb 2>/dev/null || mysql.server start 2>/dev/null || mysqld_safe > /dev/null 2>&1 &');
            } else {
                const hasSctl = await runCmd('which systemctl 2>/dev/null');
                if (hasSctl.trim()) {
                    await runCmd('systemctl start mariadb 2>/dev/null || systemctl start mysql 2>/dev/null', systemConfig.has_root);
                } else {
                    await runCmd('service mariadb start 2>/dev/null || service mysql start 2>/dev/null || mysqld_safe > /dev/null 2>&1 &', systemConfig.has_root);
                }
            }
            mariadbState = true;
        } else {
            if (systemConfig.is_termux) {
                await runCmd('pkill mariadbd 2>/dev/null || pkill mysqld 2>/dev/null');
            } else if (systemConfig.is_macos) {
                await runCmd('brew services stop mariadb 2>/dev/null || mysql.server stop 2>/dev/null');
            } else {
                const hasSctl = await runCmd('which systemctl 2>/dev/null');
                if (hasSctl.trim()) {
                    await runCmd('systemctl stop mariadb 2>/dev/null || systemctl stop mysql 2>/dev/null', systemConfig.has_root);
                } else {
                    await runCmd('service mariadb stop 2>/dev/null || service mysql stop 2>/dev/null', systemConfig.has_root);
                }
            }
            mariadbState = false;
        }
        res.json({ success: true, message: `MariaDB ${mariadbState ? 'Iniciado' : 'Parado'}` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Panel Settings Endpoints ---
router.get('/api/system/settings', (req, res) => {
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
        
        const serverConfig = fs.existsSync(SERVER_CONFIG_FILE) ? JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8')) : { port: 8088 };
        const currentPort = serverConfig.port || 8088;

        res.json({
            success: true,
            port: currentPort,
            autostart,
            autostartBoot,
            adminUser
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/system/settings/port', (req, res) => {
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
        
        setTimeout(() => {
            console.log('Reiniciando servidor devido a alteração de porta...');
            process.exit(0);
        }, 1500);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/system/settings/auth', (req, res) => {
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

router.post('/api/system/settings/autostart/toggle', (req, res) => {
    try {
        const { active } = req.body;
        const bashrcPath = path.join(os.homedir(), '.bashrc');
        
        let content = '';
        if (fs.existsSync(bashrcPath)) {
            content = fs.readFileSync(bashrcPath, 'utf8');
        }
        
        const lineToAdd = 'pgrep -f "server.js" >/dev/null 2>&1 || bash ~/termux-panel/scripts/start.sh';
        
        if (active) {
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

router.post('/api/system/settings/autostart-boot/toggle', (req, res) => {
    try {
        const { active } = req.body;
        const bootDir = path.join(os.homedir(), '.termux', 'boot');
        const bootScriptPath = path.join(bootDir, 'start-cpanel');
        
        if (active) {
            if (!fs.existsSync(bootDir)) {
                fs.mkdirSync(bootDir, { recursive: true });
            }
            const scriptContent = `#!/data/data/com.termux/files/usr/bin/bash\ntermux-wake-lock\nbash ~/termux-panel/scripts/start.sh\n`;
            fs.writeFileSync(bootScriptPath, scriptContent);
            fs.chmodSync(bootScriptPath, '755');
        } else {
            if (fs.existsSync(bootScriptPath)) {
                fs.unlinkSync(bootScriptPath);
            }
        }
        res.json({ success: true, active });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
