const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const multer = require('multer');

const multerUpload = multer({ dest: path.join(os.tmpdir(), 'termux-panel-uploads') });

router.get('/list', async (req, res) => {
    try {
        const defaultPath = process.env.HOME || '/data/data/com.termux/files/home';
        const targetPath  = req.query.path || defaultPath;
        const rootMode    = req.headers['x-fm-root'] === '1';

        if (!fs.existsSync(targetPath)) {
            return res.status(404).json({ success: false, error: 'Diretório não encontrado: ' + targetPath });
        }

        let files;

        if (rootMode) {
            try {
                const { stdout } = await new Promise((resolve, reject) => {
                    require('child_process').exec(
                        `su -c "ls -la '${targetPath.replace(/'/g, "'\\''")}'"`,
                        { timeout: 5000 },
                        (err, stdout, stderr) => err ? reject(err) : resolve({ stdout, stderr })
                    );
                });
                const lines = stdout.split('\n').filter(l => l && !l.startsWith('total') && !l.startsWith('d.') === false || l.match(/^[d\-lrwxs]/));
                files = lines.filter(l => l.match(/^[d\-lrwxs]/)).map(line => {
                    const parts = line.split(/\s+/);
                    const isDir = line[0] === 'd';
                    const name = parts.slice(8).join(' ');
                    if (!name || name === '.' || name === '..') return null;
                    return { name, isDir, size: parseInt(parts[4]) || 0, mtime: new Date().toISOString() };
                }).filter(Boolean);
            } catch(suErr) {
                return res.json({ success: false, error: 'Root (su) não disponível: ' + suErr.message });
            }
        } else {
            const dirents = fs.readdirSync(targetPath, { withFileTypes: true });
            files = dirents.map(d => {
                const p = path.join(targetPath, d.name);
                let stat = { size: 0, mtime: new Date() };
                try { stat = fs.statSync(p); } catch(e) { }
                return { name: d.name, isDir: d.isDirectory(), size: stat.size, mtime: stat.mtime };
            });
        }

        files.sort((a, b) => {
            if (a.isDir && !b.isDir) return -1;
            if (!a.isDir && b.isDir) return 1;
            return a.name.localeCompare(b.name);
        });

        res.json({ success: true, path: targetPath, files });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

router.get('/download', (req, res) => {
    const targetPath = req.query.path;
    if (fs.existsSync(targetPath)) {
        res.download(targetPath);
    } else {
        res.status(404).send('Arquivo não encontrado');
    }
});

router.post('/upload', multerUpload.array('files'), (req, res) => {
    try {
        const targetDir = req.body.path;
        if (!fs.existsSync(targetDir)) return res.status(400).json({ error: 'Diretório destino não existe' });
        
        req.files.forEach(file => {
            const destPath = path.join(targetDir, file.originalname);
            fs.renameSync(file.path, destPath);
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/mkdir', (req, res) => {
    try {
        const { targetPath } = req.body;
        if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/delete', (req, res) => {
    try {
        const targetPath = req.query.path;
        if (fs.existsSync(targetPath)) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/rename', (req, res) => {
    try {
        const { oldPath, newPath } = req.body;
        if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
