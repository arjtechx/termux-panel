const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { runCmd } = require('../utils/shell');

const BASE_DIR = process.env.HOME || path.join(__dirname, '..', '..');
const BACKUP_DIR = path.join(BASE_DIR, 'backups');
const DB_FILE = path.join(__dirname, '..', '..', 'config', 'db.json');

router.post('/', async (req, res) => {
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

router.get('/download', (req, res) => {
    const { file } = req.query;
    const filePath = path.join(BACKUP_DIR, file);
    if (fs.existsSync(filePath)) {
        res.download(filePath);
    } else {
        res.status(404).send('Backup não encontrado');
    }
});

module.exports = router;
