const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { exec } = require('child_process');

let multerUpload;
try {
    const multer = require('multer');
    multerUpload = multer({ dest: path.join(os.tmpdir(), 'termux-panel-uploads') });
} catch (err) {
    multerUpload = {
        array: () => (req, res) => {
            res.status(503).json({
                success: false,
                error: 'Upload indisponível: dependência multer não instalada. Execute npm install para restaurar uploads.'
            });
        }
    };
}

// ── UTILITÁRIOS ─────────────────────────────────────────────

const HOME = process.env.HOME || '/data/data/com.termux/files/home';
const BINARY_EXTS = new Set([
    'png','jpg','jpeg','gif','webp','bmp','ico','svg',
    'mp4','mkv','avi','mov','mp3','wav','ogg','flac',
    'zip','tar','gz','bz2','xz','rar','7z',
    'pdf','doc','docx','xls','xlsx','ppt','pptx',
    'apk','dex','so','bin','exe','elf','class','pyc',
    'db','sqlite','sqlite3','dump'
]);
const EDITABLE_EXTS = new Set([
    'js','ts','mjs','cjs','jsx','tsx',
    'html','htm','xml','svg',
    'css','scss','sass','less',
    'json','jsonc','json5',
    'php','py','rb','sh','bash','zsh','fish',
    'md','txt','log','conf','ini','env','toml','yaml','yml',
    'sql','htaccess','gitignore','dockerfile','makefile'
]);

function safePath(reqPath) {
    const base = reqPath || HOME;
    const resolved = path.resolve(base);
    return resolved;
}

function isBinary(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    return BINARY_EXTS.has(ext);
}

function isEditable(filename) {
    const ext = (filename.split('.').pop() || '').toLowerCase();
    if (BINARY_EXTS.has(ext)) return false;
    if (EDITABLE_EXTS.has(ext)) return true;
    const noExt = !filename.includes('.');
    return noExt; // arquivos sem extensão provavelmente são texto
}

function execAsync(cmd, opts = {}) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout: 15000, ...opts }, (err, stdout, stderr) => {
            if (err) reject(err);
            else resolve({ stdout: stdout || '', stderr: stderr || '' });
        });
    });
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// ── ROTAS EXISTENTES (mantidas 100% compatíveis) ─────────────

// GET /api/files/list?path=<dir>   [Header X-FM-Root: 1 → usa su]
router.get('/list', async (req, res) => {
    try {
        const targetPath = safePath(req.query.path);
        const rootMode   = req.headers['x-fm-root'] === '1';

        if (!fs.existsSync(targetPath)) {
            return res.status(404).json({ success: false, error: 'Diretório não encontrado: ' + targetPath });
        }

        let files;

        if (rootMode) {
            try {
                const escaped = targetPath.replace(/'/g, "'\\''");
                const { stdout } = await execAsync(`su -c "ls -la '${escaped}'"`, { timeout: 5000 });
                const lines = stdout.split('\n').filter(l => l.match(/^[d\-lrwxs]/));
                files = lines.map(line => {
                    const parts = line.split(/\s+/);
                    const isDir = line[0] === 'd';
                    const name  = parts.slice(8).join(' ');
                    if (!name || name === '.' || name === '..') return null;
                    const perms = parts[0] || '';
                    return { name, isDir, size: parseInt(parts[4]) || 0, mtime: new Date().toISOString(), perms };
                }).filter(Boolean);
            } catch(suErr) {
                return res.json({ success: false, error: 'Root (su) não disponível: ' + suErr.message });
            }
        } else {
            const dirents = fs.readdirSync(targetPath, { withFileTypes: true });
            files = dirents.map(d => {
                const p = path.join(targetPath, d.name);
                let stat = { size: 0, mtime: new Date(), mode: 0 };
                try { stat = fs.statSync(p); } catch(e) {}
                const perms = (stat.mode & 0o777).toString(8).padStart(3, '0');
                return {
                    name: d.name,
                    isDir: d.isDirectory(),
                    size: stat.size,
                    mtime: stat.mtime,
                    perms,
                    editable: !d.isDirectory() && isEditable(d.name),
                    binary: !d.isDirectory() && isBinary(d.name)
                };
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

// GET /api/files/download?path=<file>
router.get('/download', (req, res) => {
    const targetPath = safePath(req.query.path);
    if (fs.existsSync(targetPath) && fs.statSync(targetPath).isFile()) {
        res.download(targetPath);
    } else {
        res.status(404).send('Arquivo não encontrado');
    }
});

// POST /api/files/upload  (multipart: files[], path)
router.post('/upload', multerUpload.array('files'), (req, res) => {
    try {
        const targetDir = safePath(req.body.path);
        if (!fs.existsSync(targetDir)) return res.status(400).json({ error: 'Diretório destino não existe' });

        req.files.forEach(file => {
            const safeName = path.basename(file.originalname || file.filename || '');
            if (!safeName || safeName === '.' || safeName === '..') {
                throw new Error('Nome de upload invalido.');
            }
            const destPath = path.join(targetDir, safeName);
            fs.renameSync(file.path, destPath);
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/files/mkdir  body: { targetPath }
router.post('/mkdir', (req, res) => {
    try {
        const targetPath = safePath(req.body.targetPath);
        if (!fs.existsSync(targetPath)) fs.mkdirSync(targetPath, { recursive: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// DELETE /api/files/delete?path=<file>
router.delete('/delete', (req, res) => {
    try {
        const targetPath = safePath(req.query.path);
        if (fs.existsSync(targetPath)) {
            fs.rmSync(targetPath, { recursive: true, force: true });
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/files/rename  body: { oldPath, newPath }
router.post('/rename', (req, res) => {
    try {
        const oldPath = safePath(req.body.oldPath);
        const newPath = safePath(req.body.newPath);
        if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── NOVAS ROTAS ─────────────────────────────────────────────

// GET /api/files/health
router.get('/health', (req, res) => {
    res.json({ success: true, status: 'ok', home: HOME, version: '0.0.11' });
});

// GET /api/files/info?path=<file>
router.get('/info', (req, res) => {
    try {
        const targetPath = safePath(req.query.path);
        if (!fs.existsSync(targetPath)) return res.status(404).json({ success: false, error: 'Não encontrado' });
        const stat = fs.statSync(targetPath);
        const perms = (stat.mode & 0o777).toString(8).padStart(3, '0');
        const name  = path.basename(targetPath);
        res.json({
            success: true,
            path: targetPath,
            name,
            isDir: stat.isDirectory(),
            size: stat.size,
            mtime: stat.mtime,
            perms,
            editable: !stat.isDirectory() && isEditable(name),
            binary: !stat.isDirectory() && isBinary(name),
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/files/read?path=<file>
router.get('/read', (req, res) => {
    try {
        const targetPath = safePath(req.query.path);
        if (!fs.existsSync(targetPath)) return res.status(404).json({ success: false, error: 'Não encontrado' });
        const name = path.basename(targetPath);
        if (isBinary(name)) return res.status(400).json({ success: false, error: 'Arquivo binário — edição não suportada.' });
        const stat = fs.statSync(targetPath);
        if (stat.size > 300 * 1024) return res.status(400).json({ success: false, error: 'Arquivo muito grande para edição (>300KB).' });
        const content = fs.readFileSync(targetPath, 'utf8');
        const ext = (name.split('.').pop() || '').toLowerCase();
        res.json({ success: true, path: targetPath, name, content, ext });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/files/save  body: { path, content }
router.post('/save', (req, res) => {
    try {
        const targetPath = safePath(req.body.path);
        const name = path.basename(targetPath);
        if (isBinary(name)) return res.status(400).json({ success: false, error: 'Arquivo binário — edição não suportada.' });
        fs.writeFileSync(targetPath, req.body.content || '', 'utf8');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/files/create-file  body: { path }
router.post('/create-file', (req, res) => {
    try {
        const targetPath = safePath(req.body.path);
        if (fs.existsSync(targetPath)) return res.status(400).json({ success: false, error: 'Arquivo já existe.' });
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.writeFileSync(targetPath, '', 'utf8');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/files/copy  body: { src, dest }
router.post('/copy', (req, res) => {
    try {
        const src  = safePath(req.body.src);
        const dest = safePath(req.body.dest);
        if (!fs.existsSync(src)) return res.status(404).json({ success: false, error: 'Origem não encontrada.' });
        fs.cpSync(src, dest, { recursive: true });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/files/move  body: { src, dest }
router.post('/move', (req, res) => {
    try {
        const src  = safePath(req.body.src);
        const dest = safePath(req.body.dest);
        if (!fs.existsSync(src)) return res.status(404).json({ success: false, error: 'Origem não encontrada.' });
        fs.renameSync(src, dest);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/files/chmod  body: { path, mode }  (ex: mode = "755")
router.post('/chmod', async (req, res) => {
    try {
        const targetPath = safePath(req.body.path);
        const mode = String(req.body.mode || '').replace(/[^0-7]/g, '').slice(0, 4);
        if (!mode) return res.status(400).json({ success: false, error: 'Modo inválido.' });
        if (!fs.existsSync(targetPath)) return res.status(404).json({ success: false, error: 'Não encontrado.' });
        await execAsync(`chmod ${mode} ${shellQuote(targetPath)}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/files/compress  body: { paths: [], destDir, name }
router.post('/compress', async (req, res) => {
    try {
        const { paths, destDir, name } = req.body;
        if (!paths?.length) return res.status(400).json({ success: false, error: 'Nenhum arquivo selecionado.' });
        const archiveName = path.basename(String(name || 'archive')).replace(/[^A-Za-z0-9._-]/g, '_') || 'archive';
        const dest = path.join(safePath(destDir), `${archiveName}.tar.gz`);
        const srcList = paths.map(p => shellQuote(safePath(p))).join(' ');
        await execAsync(`tar -czf ${shellQuote(dest)} ${srcList}`);
        res.json({ success: true, dest });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /api/files/extract  body: { path, destDir }
router.post('/extract', async (req, res) => {
    try {
        const src  = safePath(req.body.path);
        const dest = safePath(req.body.destDir || path.dirname(src));
        if (!fs.existsSync(src)) return res.status(404).json({ success: false, error: 'Arquivo não encontrado.' });
        const name = path.basename(src).toLowerCase();
        let cmd;
        if (name.endsWith('.tar.gz') || name.endsWith('.tgz')) {
            cmd = `tar -xzf ${shellQuote(src)} -C ${shellQuote(dest)}`;
        } else if (name.endsWith('.tar.bz2') || name.endsWith('.tbz2')) {
            cmd = `tar -xjf ${shellQuote(src)} -C ${shellQuote(dest)}`;
        } else if (name.endsWith('.tar')) {
            cmd = `tar -xf ${shellQuote(src)} -C ${shellQuote(dest)}`;
        } else if (name.endsWith('.zip')) {
            cmd = `unzip -o ${shellQuote(src)} -d ${shellQuote(dest)}`;
        } else {
            return res.status(400).json({ success: false, error: 'Formato não suportado. Use .tar.gz, .tar.bz2, .tar ou .zip' });
        }
        fs.mkdirSync(dest, { recursive: true });
        await execAsync(cmd);
        res.json({ success: true, dest });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// GET /api/files/search?path=<dir>&q=<query>
router.get('/search', (req, res) => {
    try {
        const dir   = safePath(req.query.path);
        const query = (req.query.q || '').toLowerCase().trim();
        if (!query) return res.json({ success: true, results: [] });
        if (!fs.existsSync(dir)) return res.status(404).json({ success: false, error: 'Diretório não encontrado.' });

        const results = [];
        function scan(dirPath, depth = 0) {
            if (depth > 4 || results.length >= 100) return;
            try {
                const items = fs.readdirSync(dirPath, { withFileTypes: true });
                for (const item of items) {
                    if (item.name.startsWith('.') && depth > 0) continue;
                    if (item.name.toLowerCase().includes(query)) {
                        const p = path.join(dirPath, item.name);
                        let stat = { size: 0, mtime: new Date() };
                        try { stat = fs.statSync(p); } catch(e) {}
                        results.push({ name: item.name, path: p, isDir: item.isDirectory(), size: stat.size, mtime: stat.mtime });
                    }
                    if (item.isDirectory() && depth < 4) scan(path.join(dirPath, item.name), depth + 1);
                }
            } catch(e) {}
        }
        scan(dir);
        res.json({ success: true, results, query });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

module.exports = router;
