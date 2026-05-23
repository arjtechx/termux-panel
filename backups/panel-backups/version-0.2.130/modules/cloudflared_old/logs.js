const fs = require('fs');
const { LOGIN_LOG, logPath, appendLog } = require('./utils');

function tailFile(file, lines = 200) {
    if (!fs.existsSync(file)) return '';
    const maxBytes = 256 * 1024;
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer
        .toString('utf8')
        .split(/\r?\n/)
        .slice(-Number.parseInt(lines, 10))
        .join('\n');
}

function getTunnelLogs(id, lines = 200) {
    return tailFile(logPath(id), lines);
}

function getLoginLogs(lines = 200) {
    return tailFile(LOGIN_LOG, lines);
}

function logTunnelEvent(id, message) {
    appendLog(logPath(id), message);
}

module.exports = {
    tailFile,
    getTunnelLogs,
    getLoginLogs,
    logTunnelEvent
};
