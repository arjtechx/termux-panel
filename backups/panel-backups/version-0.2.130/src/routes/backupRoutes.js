const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { runCmd } = require('../utils/shell');

const BASE_DIR = process.env.HOME || path.join(__dirname, '..', '..');
const BACKUP_DIR = path.join(BASE_DIR, 'backups');
const DB_FILE = path.join(__dirname, '..', '..', 'config', 'db.json');

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function mysqlCliArgs(config) {
    const args = [
        '-h', config.host || '127.0.0.1',
        '-P', String(config.port || 3306),
        '-u', config.user || 'root'
    ];
    if (config.password) {
        args.push(`--password=${config.password}`);
    }
    return args.map(shellQuote).join(' ');
}

function safeBackupPath(file) {
    const base = path.basename(String(file || ''));
    if (!base || !base.endsWith('.tar.gz')) {
        throw new Error('Arquivo de backup invalido.');
    }
    return path.join(BACKUP_DIR, base);
}

router.post('/', async (req, res) => {
    try {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `backup-${timestamp}.tar.gz`;
        const targetFile = path.join(BACKUP_DIR, filename);
        
        // Backup files and database
        const dbConfig = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const dbDumpFile = path.join(BACKUP_DIR, 'db_dump.sql');
        const dbDump = `mysqldump ${mysqlCliArgs(dbConfig)} --all-databases > ${shellQuote(dbDumpFile)}`;

        await runCmd(dbDump);
        // Exclude the backup dir itself to avoid recursion
        await runCmd(`tar -czf ${shellQuote(targetFile)} --exclude='backups' -C ${shellQuote(BASE_DIR)} .`);
        
        res.json({ success: true, filename });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.get('/download', (req, res) => {
    try {
        const filePath = safeBackupPath(req.query.file);
        if (fs.existsSync(filePath)) {
            res.download(filePath);
        } else {
            res.status(404).send('Backup nao encontrado');
        }
    } catch (err) {
        res.status(400).send(err.message);
    }
});

module.exports = router;
