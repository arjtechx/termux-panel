const { exec } = require('child_process');
const os = require('os');
const net = require('net');
const systemConfig = require('./env');

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

function runCmdTimeout(cmd, timeoutMs = 5000, needsRoot = false) {
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
        exec(cmd, { timeout: timeoutMs, killSignal: 'SIGKILL' }, (error, stdout) => {
            if (error && needsRoot) reject(error);
            else resolve((stdout || '').trim());
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

module.exports = {
    chownToUser,
    runCmd,
    runCmdTimeout,
    checkPortStatus
};
