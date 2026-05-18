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

// --- Funções Auxiliares para o Dashboard ---
function getCpuUsage() {
    return new Promise(resolve => {
        exec('top -n 1 -b 2>/dev/null | head -n 10', (err, stdout) => {
            if (!err && stdout) {
                const match = stdout.match(/CPU:\s+([\d\.]+)%\s+usr\s+([\d\.]+)%\s+sys/);
                if (match) {
                    const usr = parseFloat(match[1]);
                    const sys = parseFloat(match[2]);
                    return resolve((usr + sys).toFixed(1) + '%');
                }
            }
            // Fallback usando OS module (menos preciso para a carga instantânea)
            const cpus = os.cpus();
            if (!cpus) return resolve('0%');
            let user = 0, nice = 0, sys = 0, idle = 0, irq = 0;
            for (let cpu of cpus) {
                user += cpu.times.user; nice += cpu.times.nice; sys += cpu.times.sys;
                irq += cpu.times.irq; idle += cpu.times.idle;
            }
            const total = user + nice + sys + idle + irq;
            if (total === 0) return resolve('0%');
            const active = user + nice + sys + irq;
            resolve(((active / total) * 100).toFixed(1) + '%');
        });
    });
}

function getTermuxStorage() {
    return new Promise(resolve => {
        exec('df -h /data', (err, stdout) => {
            if (err || !stdout) return resolve({ free: '--', total: '--', pct: 0 });
            const lines = stdout.trim().split('\n');
            if (lines.length > 1) {
                const parts = lines[1].split(/\s+/).filter(Boolean);
                if (parts.length >= 5) {
                    const total = parts[1];
                    const used = parts[2];
                    const free = parts[3];
                    const pctStr = parts[4].replace('%', '');
                    return resolve({ free, total, pct: parseInt(pctStr) || 0 });
                }
            }
            resolve({ free: '--', total: '--', pct: 0 });
        });
    });
}

function getTemperature() {
    return new Promise(resolve => {
        exec('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null', (err, stdout) => {
            if (err || !stdout) return resolve('--°C');
            const temp = parseInt(stdout.trim());
            if (temp > 1000) return resolve((temp / 1000).toFixed(1) + '°C');
            if (temp > 0) return resolve(temp + '°C');
            resolve('--°C');
        });
    });
}

// --- Dashboard Status Endpoint ---
router.get('/api/status', async (req, res) => {
    try {
        const cpus = os.cpus();
        const cpuCores = cpus ? cpus.length : '--';
        const cpuSpeed = cpus && cpus[0] && cpus[0].speed ? (cpus[0].speed / 1000).toFixed(1) + ' GHz' : '-- GHz';
        
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        
        const formatBytes = (bytes) => {
            if (!bytes || bytes === 0) return '0 B';
            const k = 1024, sizes = ['B', 'KB', 'MB', 'GB', 'TB'], i = Math.floor(Math.log(bytes) / Math.log(k));
            return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
        };

        const ramStr = `${formatBytes(usedMem)} / ${formatBytes(totalMem)}`;
        
        const cpuPercent = await getCpuUsage();
        const storage = await getTermuxStorage();
        const temp = await getTemperature();

        res.json({
            cpu: cpuPercent,
            cpuCores: cpuCores,
            cpuSpeed: cpuSpeed,
            ram: ramStr,
            storageFree: storage.free,
            storageTotal: storage.total,
            storagePercent: storage.pct,
            temperature: temp,
            totalDown: '--', 
            totalUp: '--'
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
