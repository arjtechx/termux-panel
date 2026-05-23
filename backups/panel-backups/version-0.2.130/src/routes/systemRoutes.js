const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, exec } = require('child_process');
const systemConfig = require('../utils/env');
const { runCmd } = require('../utils/shell');

const SERVER_CONFIG_FILE = path.join(__dirname, '..', '..', 'config', 'server.json');
const AUTH_FILE = path.join(__dirname, '..', '..', 'config', 'auth.json');
const NETWORK_ACCESS_FILE = path.join(__dirname, '..', '..', 'config', 'network-access.json');

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
        const networkAccess = fs.existsSync(NETWORK_ACCESS_FILE)
            ? JSON.parse(fs.readFileSync(NETWORK_ACCESS_FILE, 'utf8'))
            : { ipv4: true, ipv6: false };

        res.json({
            success: true,
            port: currentPort,
            autostart,
            autostartBoot,
            adminUser,
            networkAccess: {
                ipv4: networkAccess.ipv4 !== false,
                ipv6: networkAccess.ipv6 === true
            }
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/system/settings/network', (req, res) => {
    try {
        const next = {
            ipv4: req.body && req.body.ipv4 !== false,
            ipv6: !!(req.body && req.body.ipv6 === true)
        };
        fs.writeFileSync(NETWORK_ACCESS_FILE, JSON.stringify(next, null, 2));
        res.json({ success: true, networkAccess: next, message: 'Configuração de acesso externo salva.' });
    } catch (err) {
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

const BASE_DIR = path.join(__dirname, '..', '..');
const MEMORY_CONFIG_FILE = path.join(BASE_DIR, 'config', 'memory.json');

function isPidAlive(pid) {
    if (!pid) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return e.code === 'EPERM';
    }
}

function getMemoryConfig() {
    try {
        if (fs.existsSync(MEMORY_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(MEMORY_CONFIG_FILE, 'utf8'));
        }
    } catch(e) {}
    return { mode: 'balanced' };
}

function setMemoryConfig(config) {
    try {
        const dir = path.dirname(MEMORY_CONFIG_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(MEMORY_CONFIG_FILE, JSON.stringify(config, null, 2));
        return true;
    } catch(e) {
        return false;
    }
}

router.get('/api/system/processes', async (req, res) => {
    try {
        const LOCK_DIR = path.join(os.homedir(), '.termux-panel-lock');
        const PID_FILE = path.join(LOCK_DIR, 'panel.pid');
        const START_PID_FILE = path.join(LOCK_DIR, 'start.pid');
        const UPDATE_LOCK = path.join(LOCK_DIR, 'update.lock');

        const panelPid = fs.existsSync(PID_FILE) ? parseInt(fs.readFileSync(PID_FILE, 'utf8').trim()) : null;
        const startPid = fs.existsSync(START_PID_FILE) ? parseInt(fs.readFileSync(START_PID_FILE, 'utf8').trim()) : null;
        const updatePid = fs.existsSync(UPDATE_LOCK) ? parseInt(fs.readFileSync(UPDATE_LOCK, 'utf8').trim()) : null;

        const isPanelLockActive = isPidAlive(panelPid);
        const isStartLockActive = isPidAlive(startPid);
        const isUpdateLockActive = isPidAlive(updatePid);

        // Carrega config de memória
        const memConfig = getMemoryConfig();
        const nodeMemoryMode = memConfig.mode || 'balanced';
        let nodeMemoryMb = 256;
        if (nodeMemoryMode === 'safe') nodeMemoryMb = 128;
        else if (nodeMemoryMode === 'performance') nodeMemoryMb = 512;

        // Porta
        let currentPort = 8088;
        if (fs.existsSync(SERVER_CONFIG_FILE)) {
            try {
                const srvCfg = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8'));
                currentPort = srvCfg.port || 8088;
            } catch(e) {}
        }

        // Verifica qual PID ocupa a porta
        let portBusyPid = null;
        try {
            let ssOut = await runCmd(`ss -ltnp 2>/dev/null | grep ":${currentPort} " | sed -n 's/.*pid=\\([0-9]*\\).*/\\1/p' | head -n1`);
            ssOut = ssOut.trim();
            if (ssOut) portBusyPid = parseInt(ssOut);
            
            if (!portBusyPid) {
                let lsofOut = await runCmd(`lsof -t -i:${currentPort} -sTCP:LISTEN 2>/dev/null | head -n1`);
                lsofOut = lsofOut.trim();
                if (lsofOut) portBusyPid = parseInt(lsofOut);
            }
            if (!portBusyPid) {
                let fuserOut = await runCmd(`fuser ${currentPort}/tcp 2>/dev/null | awk '{print $1}' | head -n1`);
                fuserOut = fuserOut.trim();
                if (fuserOut) portBusyPid = parseInt(fuserOut);
            }
        } catch(e) {}

        const portBusy = portBusyPid !== null;

        // Processos ativos via ps
        const startScripts = [];
        const nodeServers = [];
        const mariadbProcs = [];
        const cloudflaredProcs = [];

        try {
            const psOutput = await runCmd('ps -ef');
            const lines = psOutput.split('\n');
            for (let i = 1; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                const parts = line.split(/\s+/);
                if (parts.length >= 8) {
                    const pid = parseInt(parts[1]);
                    const ppid = parseInt(parts[2]);
                    const cmd = parts.slice(7).join(' ');

                    if (cmd.includes('scripts/start.sh') || cmd.includes('bash scripts/start.sh')) {
                        startScripts.push({ pid, ppid, cmd });
                    } else if (cmd.includes('node') && (cmd.includes('server.js') || cmd.includes('desktop-server.js'))) {
                        // Verifica se pertence ao termux-panel para evitar falsos positivos
                        let isThisPanel = false;
                        try {
                            if (fs.existsSync(`/proc/${pid}/cwd`)) {
                                const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
                                if (cwd === BASE_DIR) isThisPanel = true;
                            }
                        } catch(e) {}
                        if (isThisPanel || cmd.includes(BASE_DIR) || cmd.includes('termux-panel')) {
                            nodeServers.push({ pid, ppid, cmd });
                        }
                    } else if (cmd.includes('mariadbd') || cmd.includes('mysqld')) {
                        mariadbProcs.push({ pid, ppid, cmd });
                    } else if (cmd.includes('cloudflared')) {
                        cloudflaredProcs.push({ pid, ppid, cmd });
                    }
                }
            }
        } catch(e) {}

        // Memória do sistema
        const totalMem = os.totalmem();
        const freeMem = os.freemem();
        const usedMem = totalMem - freeMem;
        const usagePercent = totalMem > 0 ? Math.round((usedMem / totalMem) * 100) : 0;
        const memory = {
            total: Math.round(totalMem / (1024 * 1024)), // MB
            free: Math.round(freeMem / (1024 * 1024)), // MB
            usagePercent
        };

        // Logs OOM do dmesg
        let oomLog = '';
        if (systemConfig.has_root) {
            try {
                oomLog = await runCmd('dmesg | grep -i -E "killed|oom|node" | tail -n 30', true);
                if (!oomLog) oomLog = 'Nenhum registro de OOM encontrado no dmesg.';
            } catch(e) {
                oomLog = '[WARN] Não foi possível ler dmesg. Root indisponível ou negado.';
            }
        } else {
            oomLog = '[WARN] Não foi possível ler dmesg. Root indisponível ou negado.';
        }

        res.json({
            success: true,
            panel: {
                startScripts,
                nodeServers,
                port: currentPort,
                portBusy,
                portBusyPid,
                pidFile: panelPid,
                startPidFile: startPid,
                nodeMemoryMb,
                nodeMemoryMode
            },
            locks: {
                startLock: isStartLockActive,
                updateLock: isUpdateLockActive
            },
            services: {
                mariadb: mariadbProcs,
                cloudflared: cloudflaredProcs
            },
            memory,
            oomLog
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/system/settings/memory', (req, res) => {
    try {
        const { mode } = req.body;
        if (!['safe', 'balanced', 'performance'].includes(mode)) {
            return res.status(400).json({ error: 'Modo de memória inválido. Deve ser: safe, balanced ou performance.' });
        }
        setMemoryConfig({ mode });
        res.json({ success: true, message: 'Configuração de memória salva com sucesso. Um Reinício Seguro é necessário para aplicar.' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/api/system/stop', (req, res) => {
    try {
        res.json({ success: true, message: 'Painel parando...' });
        
        const stopScript = path.join(BASE_DIR, 'scripts', 'stop.sh');
        const proc = spawn('bash', [stopScript], {
            cwd: BASE_DIR,
            detached: true,
            stdio: 'ignore'
        });
        proc.unref();
    } catch(err) {
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

router.post('/api/system/restart', (req, res) => {
    try {
        res.json({ success: true, message: 'Painel reiniciando de forma segura...' });
        
        const stopScript = path.join(BASE_DIR, 'scripts', 'stop.sh');
        const startScript = path.join(BASE_DIR, 'scripts', 'start.sh');
        
        const proc = spawn('bash', ['-c', `bash "${stopScript}" && sleep 2 && bash "${startScript}"`], {
            cwd: BASE_DIR,
            detached: true,
            stdio: 'ignore'
        });
        proc.unref();
    } catch(err) {
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        }
    }
});

module.exports = router;
