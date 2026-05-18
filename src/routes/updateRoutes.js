const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const axios = require('axios');
const systemConfig = require('../utils/env');
const { runCmd } = require('../utils/shell');

const BASE_DIR = path.join(__dirname, '..', '..');
const UPDATE_SCRIPT = path.join(BASE_DIR, 'scripts', 'update.sh');

// SSE: Executa atualização do painel em tempo real
router.get('/api/system/update/run', (req, res) => {
    try { require('fs').chmodSync(UPDATE_SCRIPT, '755'); } catch(e) {}

    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const send = (data) => res.write(`data: ${JSON.stringify({ line: data })}\n\n`);

    const tag = req.query.tag || '';
    const args = [];
    if (tag && tag.trim() !== '') {
        args.push(tag.trim());
    }

    const proc = spawn('bash', [UPDATE_SCRIPT, ...args], {
        env: { ...process.env, TERM: 'xterm' },
    });

    proc.stdout.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => {
            if (line.trim()) send(line);
        });
    });

    proc.stderr.on('data', chunk => {
        chunk.toString().split('\n').forEach(line => {
            if (line.trim()) send('[STDERR] ' + line);
        });
    });

    proc.on('close', code => {
        send(`__DONE__:${code}`);
        res.end();
    });

    req.on('close', () => proc.kill());
});

const UPDATE_CONFIG_FILE = path.join(BASE_DIR, 'config', 'update.json');

function getUpdateConfig() {
    try {
        if (fs.existsSync(UPDATE_CONFIG_FILE)) {
            return JSON.parse(fs.readFileSync(UPDATE_CONFIG_FILE, 'utf8'));
        }
    } catch(e) {}
    return { github_repo: '', update_channel: 'release' };
}

// GET/POST config de update (repositório GitHub)
router.get('/api/system/update/config', (req, res) => {
    res.json(getUpdateConfig());
});

router.post('/api/system/update/config', (req, res) => {
    try {
        let repo = req.body.github_repo || '';
        // Sanitiza URL completa caso o usuário cole: https://github.com/user/repo
        repo = repo.replace(/https?:\/\/github\.com\//i, '').trim();
        // Remove barras extras no início ou fim
        repo = repo.replace(/^\/+|\/+$/g, '');

        const config = { ...getUpdateConfig(), github_repo: repo };
        fs.writeFileSync(UPDATE_CONFIG_FILE, JSON.stringify(config, null, 2));
        res.json({ success: true, config });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// --- Panel Settings Endpoints ---
router.get('/api/system/update/check', async (req, res) => {
    try {
        const pjson = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8'));
        const config = getUpdateConfig();
        const currentVersion = pjson.version || '1.0.0';
        let hasUpdate = false;
        let latestVersion = currentVersion;
        let updateMethod = 'manual';
        let releaseUrl = '';
        let releaseNotes = '';

        // Método 1: GitHub Releases API
        if (config.github_repo && config.github_repo.includes('/')) {
            try {
                updateMethod = 'github';
                releaseUrl = `https://github.com/${config.github_repo}/releases/latest/download/termux-panel-dist.tar.gz`;
                const apiUrl = `https://api.github.com/repos/${config.github_repo}/releases/latest`;
                const resp = await axios.get(apiUrl, {
                    headers: { 'User-Agent': 'termux-panel' },
                    timeout: 5000
                });
                latestVersion = (resp.data.tag_name || currentVersion).replace(/^v/, '');
                releaseNotes = resp.data.body || '';
                // Compara versões simples
                hasUpdate = latestVersion !== currentVersion;
                if (!hasUpdate) {
                    // Mesmo número de versão: verifica se o release é mais novo
                    const publishedAt = new Date(resp.data.published_at || 0);
                    const localStat = fs.statSync(path.join(BASE_DIR, 'server.js'));
                    hasUpdate = publishedAt > localStat.mtime;
                }
            } catch(e) {
                // FALLBACK: Usar git ls-remote para obter a última versão sem limite de taxa de API!
                try {
                    const gitUrl = `https://github.com/${config.github_repo}.git`;
                    const tagsOut = await new Promise((resolve, reject) => {
                        exec(`git ls-remote --tags ${gitUrl}`, (err, stdout) => {
                            if (err) reject(err);
                            else resolve(stdout || '');
                        });
                    });
                    const tags = tagsOut.split('\n')
                        .map(line => {
                            const match = line.match(/refs\/tags\/(v?\d+\.\d+\.\d+)/);
                            return match ? match[1] : null;
                        })
                        .filter(Boolean);
                    if (tags.length > 0) {
                        const sorted = tags.sort((a, b) => {
                            const parse = v => v.replace(/^v/, '').split('.').map(Number);
                            const [pa, pb] = [parse(a), parse(b)];
                            for (let i = 0; i < 3; i++) {
                                if (pa[i] !== pb[i]) return pa[i] - pb[i];
                            }
                            return 0;
                        });
                        const latestTag = sorted[sorted.length - 1];
                        latestVersion = latestTag.replace(/^v/, '');
                        hasUpdate = latestVersion !== currentVersion;
                        updateMethod = 'github'; // Recuperado com sucesso via Git!
                    } else {
                        updateMethod = 'github_error';
                    }
                } catch (errGit) {
                    updateMethod = 'github_error';
                }
            }
        }

        // Método 2: Git local
        const isGit = fs.existsSync(path.join(BASE_DIR, '.git'));
        if (updateMethod === 'manual' && isGit) {
            updateMethod = 'git';
            try {
                await new Promise((resolve) => exec('git fetch --dry-run', () => resolve()));
                const statusOut = await new Promise((resolve) => {
                    exec('git status -uno', (err, stdout) => resolve(stdout || ''));
                });
                if (statusOut.includes('behind')) hasUpdate = true;
            } catch(e) {}
        }

        res.json({
            currentVersion,
            latestVersion,
            hasUpdate,
            updateMethod,
            githubRepo: config.github_repo || '',
            releaseUrl,
            releaseNotes: releaseNotes.substring(0, 500)
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});


router.get('/api/system/update/versions', async (req, res) => {
    try {
        const config = getUpdateConfig();
        const pjson = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8'));
        const currentVersion = pjson.version || '1.0.0';

        if (!config.github_repo || !config.github_repo.includes('/')) {
            return res.json({ success: true, currentVersion, versions: [] });
        }

        const apiUrl = `https://api.github.com/repos/${config.github_repo}/releases`;
        const resp = await axios.get(apiUrl, {
            headers: { 'User-Agent': 'termux-panel' },
            timeout: 5000
        });

        const releases = resp.data || [];
        const versions = releases.map(rel => {
            const tag = rel.tag_name || '';
            const tagClean = tag.replace(/^v/, '');
            
            // Lógica inteligente de retrocompatibilidade
            let compatStatus = 'compatible';
            let compatMessage = 'Upgrade/Reinstalação 100% seguro.';

            if (tagClean === currentVersion) {
                compatStatus = 'compatible';
                compatMessage = 'Esta é a sua versão ativa atual.';
            } else {
                // Compara as versões de forma simples (ex: 1.2.0 vs 1.1.3)
                const cmp = tagClean.localeCompare(currentVersion, undefined, { numeric: true, sensitivity: 'base' });
                if (cmp < 0) {
                    compatStatus = 'breaking';
                    compatMessage = 'Aviso: Downgrade. Recursos novos da v1.2.0 (Hospedagem) ficarão inativos.';
                } else {
                    compatStatus = 'compatible';
                    compatMessage = 'Upgrade compatível e recomendado.';
                }
            }

            return {
                tag,
                name: rel.name || tag,
                publishedAt: rel.published_at,
                body: rel.body || '',
                compatStatus,
                compatMessage
            };
        });

        res.json({
            success: true,
            currentVersion,
            versions
        });
    } catch (err) {
        // FALLBACK: se a API do GitHub falhar (rate limit ou DNS), usa git ls-remote para listar as tags de forma segura!
        try {
            const config = getUpdateConfig();
            const pjson = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8'));
            const currentVersion = pjson.version || '1.0.0';
            const gitUrl = `https://github.com/${config.github_repo}.git`;
            
            const tagsOut = await new Promise((resolve, reject) => {
                exec(`git ls-remote --tags ${gitUrl}`, (err, stdout) => {
                    if (err) reject(err);
                    else resolve(stdout || '');
                });
            });

            const lines = tagsOut.split('\n').filter(Boolean);
            const rawVersions = lines.map(line => {
                const match = line.match(/refs\/tags\/(v?\d+\.\d+\.\d+)/);
                if (!match) return null;
                const tag = match[1].startsWith('v') ? match[1] : 'v' + match[1];
                const tagClean = tag.replace(/^v/, '');
                
                let compatStatus = 'compatible';
                let compatMessage = 'Upgrade/Reinstalação 100% seguro.';

                if (tagClean === currentVersion) {
                    compatStatus = 'compatible';
                    compatMessage = 'Esta é a sua versão ativa atual.';
                } else {
                    const cmp = tagClean.localeCompare(currentVersion, undefined, { numeric: true, sensitivity: 'base' });
                    if (cmp < 0) {
                        compatStatus = 'breaking';
                        compatMessage = 'Aviso: Downgrade. Recursos novos da v1.2.0 (Hospedagem) ficarão inativos.';
                    } else {
                        compatStatus = 'compatible';
                        compatMessage = 'Upgrade compatível e recomendado.';
                    }
                }

                return {
                    tag,
                    name: `Termux Panel ${tag}`,
                    publishedAt: new Date().toISOString(), // Fallback de data
                    body: 'Release carregada dinamicamente via Git tags (API rate limit bypass).',
                    compatStatus,
                    compatMessage
                };
            }).filter(Boolean);

            const sortedVersions = rawVersions.sort((a, b) => {
                const parse = v => v.tag.replace(/^v/, '').split('.').map(Number);
                const [pa, pb] = [parse(b), parse(a)]; // Decrescente
                for (let i = 0; i < 3; i++) {
                    if (pa[i] !== pb[i]) return pa[i] - pb[i];
                }
                return 0;
            });

            res.json({
                success: true,
                currentVersion,
                versions: sortedVersions
            });
        } catch (errFallback) {
            res.status(500).json({ error: `GitHub API indisponível e falha no Git fallback: ${err.message}` });
        }
    }
});

// ============================================================
//  NÚCLEO DE ATUALIZAÇÃO E ROLLBACK AVANÇADO (v0.0.3)
// ============================================================

function parseSemver(versionString) {
    const clean = versionString.trim().replace(/^v/, '');
    const [mainPart, prePart] = clean.split('-');
    const parts = mainPart.split('.').map(Number);
    while (parts.length < 3) {
        parts.push(0);
    }
    return {
        major: parts[0] || 0,
        minor: parts[1] || 0,
        patch: parts[2] || 0,
        prerelease: prePart || null
    };
}

function compareSemver(v1, v2) {
    const p1 = parseSemver(v1);
    const p2 = parseSemver(v2);
    
    if (p1.major !== p2.major) return p1.major - p2.major;
    if (p1.minor !== p2.minor) return p1.minor - p2.minor;
    if (p1.patch !== p2.patch) return p1.patch - p2.patch;
    
    if (p1.prerelease && !p2.prerelease) return -1;
    if (!p1.prerelease && p2.prerelease) return 1;
    if (p1.prerelease && p2.prerelease) {
        return p1.prerelease.localeCompare(p2.prerelease);
    }
    return 0;
}

const PANEL_UPDATE_ITEMS = ['public', 'scripts', 'server.js', 'package.json', 'package-lock.json', 'README.md', 'install.sh', 'src', 'services'];
const UPDATE_CACHE_FILE = path.join(BASE_DIR, 'config', 'update-cache.json');
const UPDATE_INSTALLED_FILE = path.join(BASE_DIR, 'config', 'update-installed.json');

function getLocalBuildDate() {
    let latestMtime = 0;
    for (const item of PANEL_UPDATE_ITEMS) {
        const itemPath = path.join(BASE_DIR, item);
        if (!fs.existsSync(itemPath)) continue;
        try {
            const stat = fs.statSync(itemPath);
            latestMtime = Math.max(latestMtime, stat.mtimeMs);
        } catch(e) {}
    }
    return latestMtime ? new Date(latestMtime) : null;
}

function readInstalledUpdateMeta() {
    try {
        if (fs.existsSync(UPDATE_INSTALLED_FILE)) {
            return JSON.parse(fs.readFileSync(UPDATE_INSTALLED_FILE, 'utf8'));
        }
    } catch(e) {}
    return null;
}

function writeInstalledUpdateMeta(data) {
    try {
        fs.writeFileSync(UPDATE_INSTALLED_FILE, JSON.stringify({
            ...data,
            installedAt: new Date().toISOString()
        }, null, 2));
    } catch(e) {}
}

function getInstalledReferenceDate(repo, tag) {
    const meta = readInstalledUpdateMeta();
    if (meta && meta.repo === repo && (!tag || meta.tag === tag)) {
        const metaDate = meta.releasePublishedAt || meta.installedAt;
        if (metaDate) {
            const parsed = new Date(metaDate);
            if (!Number.isNaN(parsed.getTime())) return parsed;
        }
    }
    return getLocalBuildDate();
}

function releaseIsNewerThanLocal(releaseDate, repo, tag) {
    if (!releaseDate) return false;
    const publishedAt = new Date(releaseDate);
    const installedReferenceDate = getInstalledReferenceDate(repo, tag);
    if (!installedReferenceDate || Number.isNaN(publishedAt.getTime())) return false;
    return publishedAt.getTime() > installedReferenceDate.getTime() + 60 * 1000;
}

function readUpdateCache() {
    try {
        if (fs.existsSync(UPDATE_CACHE_FILE)) {
            return JSON.parse(fs.readFileSync(UPDATE_CACHE_FILE, 'utf8'));
        }
    } catch(e) {}
    return null;
}

function writeUpdateCache(data) {
    try {
        fs.writeFileSync(UPDATE_CACHE_FILE, JSON.stringify({
            ...data,
            lastChecked: new Date().toISOString()
        }, null, 2));
    } catch(e) {}
}

// GET /api/update/status
router.get('/api/update/status', async (req, res) => {
    try {
        const pjson = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8'));
        const installed = pjson.version || '0.0.2';
        const config = getUpdateConfig();
        const repo = config.github_repo || 'arjtechx/termux-panel';

        const cached = readUpdateCache();
        
        if (cached && cached.repo === repo && cached.installed === installed && !req.query.force) {
            const age = Date.now() - new Date(cached.lastChecked).getTime();
            if (age < 5 * 60 * 1000) {
                return res.json(cached);
            }
        }

        let latest = installed;
        let hasUpdate = false;
        let status = 'up_to_date';
        let publishedAt = null;
        let updateReason = 'version';

        try {
            const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
            const resp = await axios.get(apiUrl, {
                headers: { 'User-Agent': 'termux-panel' },
                timeout: 3000
            });
            latest = (resp.data.tag_name || installed).replace(/^v/, '');
            const latestTag = resp.data.tag_name || `v${latest}`;
            publishedAt = resp.data.published_at || resp.data.created_at || null;
            hasUpdate = compareSemver(latest, installed) > 0;
            if (!hasUpdate && compareSemver(latest, installed) === 0 && releaseIsNewerThanLocal(publishedAt, repo, latestTag)) {
                hasUpdate = true;
                updateReason = 'release_rebuilt';
            }
            status = hasUpdate ? 'update_available' : 'up_to_date';
        } catch(err) {
            if (cached && cached.repo === repo) {
                return res.json({
                    ...cached,
                    status: cached.hasUpdate ? 'update_available' : 'up_to_date'
                });
            }
            status = 'failed_check';
        }

        const result = {
            installed,
            latest,
            hasUpdate,
            status,
            repo,
            publishedAt,
            localBuildDate: getInstalledReferenceDate(repo, `v${latest}`)?.toISOString() || null,
            updateReason
        };

        if (status !== 'failed_check') {
            writeUpdateCache(result);
        }

        res.json(result);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/update/releases
router.get('/api/update/releases', async (req, res) => {
    try {
        const config = getUpdateConfig();
        const pjson = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8'));
        const installed = pjson.version || '0.0.2';
        const repo = config.github_repo || 'arjtechx/termux-panel';

        try {
            const apiUrl = `https://api.github.com/repos/${repo}/releases`;
            const resp = await axios.get(apiUrl, {
                headers: { 'User-Agent': 'termux-panel' },
                timeout: 5000
            });
            const releases = resp.data || [];
            const versions = releases.map(rel => {
                const tag = rel.tag_name || '';
                const tagClean = tag.replace(/^v/, '');
                
                let compatStatus = 'compatible';
                let compatMessage = 'Upgrade/Reinstalação 100% seguro.';

                if (tagClean === installed) {
                    compatStatus = 'compatible';
                    compatMessage = 'Esta é a sua versão ativa atual.';
                } else {
                    const cmp = compareSemver(tagClean, installed);
                    if (cmp < 0) {
                        compatStatus = 'breaking';
                        compatMessage = 'Aviso: Downgrade. Recursos novos do painel poderão ficar indisponíveis.';
                    } else {
                        compatStatus = 'compatible';
                        compatMessage = 'Upgrade compatível e recomendado.';
                    }
                }

                return {
                    tag,
                    name: rel.name || tag,
                    publishedAt: rel.published_at,
                    body: rel.body || '',
                    compatStatus,
                    compatMessage
                };
            });

            res.json(versions);
        } catch(err) {
            // Fallback via Git ls-remote
            try {
                const gitUrl = `https://github.com/${repo}.git`;
                const tagsOut = await new Promise((resolve, reject) => {
                    exec(`git ls-remote --tags ${gitUrl}`, (gitErr, stdout) => {
                        if (gitErr) reject(gitErr);
                        else resolve(stdout || '');
                    });
                });

                const lines = tagsOut.split('\n').filter(Boolean);
                const rawVersions = lines.map(line => {
                    const match = line.match(/refs\/tags\/(v?\d+\.\d+\.\d+)/);
                    if (!match) return null;
                    const tag = match[1].startsWith('v') ? match[1] : 'v' + match[1];
                    const tagClean = tag.replace(/^v/, '');
                    
                    let compatStatus = 'compatible';
                    let compatMessage = 'Upgrade/Reinstalação 100% seguro.';

                    if (tagClean === installed) {
                        compatStatus = 'compatible';
                        compatMessage = 'Esta é a sua versão ativa atual.';
                    } else {
                        const cmp = compareSemver(tagClean, installed);
                        if (cmp < 0) {
                            compatStatus = 'breaking';
                            compatMessage = 'Aviso: Downgrade. Recursos novos do painel poderão ficar indisponíveis.';
                        } else {
                            compatStatus = 'compatible';
                            compatMessage = 'Upgrade compatível e recomendado.';
                        }
                    }

                    return {
                        tag,
                        name: `Termux Panel ${tag}`,
                        publishedAt: new Date().toISOString(),
                        body: 'Carregada via Git tags (API rate limit bypass).',
                        compatStatus,
                        compatMessage
                    };
                }).filter(Boolean);

                const sortedVersions = rawVersions.sort((a, b) => {
                    return compareSemver(b.tag, a.tag);
                });

                res.json(sortedVersions);
            } catch (errFallback) {
                res.status(500).json({ error: `GitHub API indisponível e falha no Git fallback: ${err.message}` });
            }
        }
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// POST /api/update/check
router.post('/api/update/check', async (req, res) => {
    try {
        const pjson = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8'));
        const installed = pjson.version || '0.0.2';
        const config = getUpdateConfig();
        const repo = config.github_repo || 'arjtechx/termux-panel';

        let latest = installed;
        let hasUpdate = false;
        let status = 'up_to_date';
        let publishedAt = null;
        let updateReason = 'version';

        try {
            const apiUrl = `https://api.github.com/repos/${repo}/releases/latest`;
            const resp = await axios.get(apiUrl, {
                headers: { 'User-Agent': 'termux-panel' },
                timeout: 5000
            });
            latest = (resp.data.tag_name || installed).replace(/^v/, '');
            const latestTag = resp.data.tag_name || `v${latest}`;
            publishedAt = resp.data.published_at || resp.data.created_at || null;
            hasUpdate = compareSemver(latest, installed) > 0;
            if (!hasUpdate && compareSemver(latest, installed) === 0 && releaseIsNewerThanLocal(publishedAt, repo, latestTag)) {
                hasUpdate = true;
                updateReason = 'release_rebuilt';
            }
            status = hasUpdate ? 'update_available' : 'up_to_date';
        } catch(err) {
            try {
                const gitUrl = `https://github.com/${repo}.git`;
                const tagsOut = await new Promise((resolve, reject) => {
                    exec(`git ls-remote --tags ${gitUrl}`, (gitErr, stdout) => {
                        if (gitErr) reject(gitErr);
                        else resolve(stdout || '');
                    });
                });
                const tags = tagsOut.split('\n')
                    .map(line => {
                        const match = line.match(/refs\/tags\/(v?\d+\.\d+\.\d+)/);
                        return match ? match[1] : null;
                    })
                    .filter(Boolean);
                if (tags.length > 0) {
                    const sorted = tags.sort(compareSemver);
                    const latestTag = sorted[sorted.length - 1];
                    latest = latestTag.replace(/^v/, '');
                    hasUpdate = compareSemver(latest, installed) > 0;
                    status = hasUpdate ? 'update_available' : 'up_to_date';
                } else {
                    status = 'failed_check';
                }
            } catch(eGit) {
                status = 'failed_check';
            }
        }

        const result = {
            installed,
            latest,
            hasUpdate,
            status,
            repo,
            publishedAt,
            localBuildDate: getInstalledReferenceDate(repo, `v${latest}`)?.toISOString() || null,
            updateReason
        };

        if (status !== 'failed_check') {
            writeUpdateCache(result);
        }

        res.json(result);
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// GET /api/update/install (SSE Log Stream)
router.get('/api/update/install', async (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const sendLog = (type, message) => {
        res.write(`data: ${JSON.stringify({ line: `[${type}] ${message}` })}\n\n`);
    };

    const targetTag = req.query.tag || 'latest';
    sendLog('INFO', `Verificando releases GitHub para tag: ${targetTag}...`);

    try {
        const config = getUpdateConfig();
        const repo = config.github_repo || 'arjtechx/termux-panel';
        const pjson = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8'));
        const currentVersion = pjson.version || '0.0.2';

        let downloadUrl = '';
        let resolvedTag = targetTag;
        let releasePublishedAt = null;
        
        try {
            const apiUrl = targetTag === 'latest'
                ? `https://api.github.com/repos/${repo}/releases/latest`
                : `https://api.github.com/repos/${repo}/releases/tags/${targetTag}`;
            
            const resp = await axios.get(apiUrl, { headers: { 'User-Agent': 'termux-panel' }, timeout: 5000 });
            resolvedTag = resp.data.tag_name || targetTag;
            releasePublishedAt = resp.data.published_at || resp.data.created_at || null;
            downloadUrl = `https://github.com/${repo}/releases/download/${resolvedTag}/termux-panel-dist.tar.gz`;
            sendLog('OK', `Release encontrada: ${resolvedTag}`);
        } catch(e) {
            resolvedTag = targetTag;
            downloadUrl = targetTag === 'latest'
                ? `https://github.com/${repo}/releases/latest/download/termux-panel-dist.tar.gz`
                : `https://github.com/${repo}/releases/download/${resolvedTag}/termux-panel-dist.tar.gz`;
            sendLog('WARN', `GitHub API limite de requisições. Tentando URL direta: ${resolvedTag}`);
        }

        // Criar Backup Preventivo
        sendLog('INFO', `Criando backup automático da versão ${currentVersion}...`);
        const backupDir = path.join(BASE_DIR, 'backups', 'panel-backups', `version-${currentVersion}`);
        
        try {
            fs.mkdirSync(backupDir, { recursive: true });
            for (const item of PANEL_UPDATE_ITEMS) {
                const srcPath = path.join(BASE_DIR, item);
                const destPath = path.join(backupDir, item);
                if (fs.existsSync(srcPath)) {
                    fs.cpSync(srcPath, destPath, { recursive: true });
                }
            }
            sendLog('OK', `Backup criado com sucesso em: backups/panel-backups/version-${currentVersion}`);
        } catch (backupErr) {
            sendLog('WARN', `Não foi possível criar o backup preventivo: ${backupErr.message}`);
        }

        // Baixar pacote
        sendLog('INFO', `Baixando pacote da release...`);
        const tempDir = path.join(BASE_DIR, 'backups', 'tmp');
        fs.mkdirSync(tempDir, { recursive: true });
        const tempTarPath = path.join(tempDir, `update-${resolvedTag}.tar.gz`);

        try {
            const writer = fs.createWriteStream(tempTarPath);
            const response = await axios({
                method: 'get',
                url: downloadUrl,
                responseType: 'stream',
                timeout: 15000
            });

            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });
            sendLog('OK', `Pacote baixado com sucesso.`);
        } catch (dlErr) {
            sendLog('ERR', `Falha ao baixar o pacote: ${dlErr.message}`);
            res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
            return res.end();
        }

        // Extrair atualização
        sendLog('INFO', `Extraindo pacote do painel...`);
        const extractDir = path.join(tempDir, 'extract');
        fs.rmSync(extractDir, { recursive: true, force: true });
        fs.mkdirSync(extractDir, { recursive: true });

        try {
            await new Promise((resolve, reject) => {
                const proc = spawn('tar', ['-xzf', tempTarPath, '-C', extractDir, '--strip-components=1']);
                proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Tar terminou com código ${code}`)));
                proc.on('error', reject);
            });
            sendLog('OK', `Extração básica concluída.`);
        } catch (extErr) {
            sendLog('ERR', `Falha ao extrair tarball: ${extErr.message}`);
            res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
            return res.end();
        }

        // Substituir apenas arquivos da aplicação
        sendLog('INFO', `Instalando atualização...`);
        try {
            for (const item of PANEL_UPDATE_ITEMS) {
                const srcPath = path.join(extractDir, item);
                const destPath = path.join(BASE_DIR, item);
                if (fs.existsSync(srcPath)) {
                    fs.cpSync(srcPath, destPath, { recursive: true, force: true });
                }
            }
            sendLog('OK', `Arquivos copiados com sucesso.`);
        } catch (copyErr) {
            sendLog('ERR', `Falha ao instalar arquivos: ${copyErr.message}`);
            res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
            return res.end();
        }

        sendLog('INFO', `Atualizando dependências Node.js...`);
        try {
            await new Promise((resolve, reject) => {
                const proc = spawn('npm', ['install', '--no-audit', '--no-fund'], {
                    cwd: BASE_DIR,
                    env: process.env
                });
                proc.stdout.on('data', chunk => {
                    chunk.toString().split('\n').forEach(line => {
                        if (line.trim()) sendLog('NPM', line.trim());
                    });
                });
                proc.stderr.on('data', chunk => {
                    chunk.toString().split('\n').forEach(line => {
                        if (line.trim()) sendLog('NPM', line.trim());
                    });
                });
                proc.on('close', code => code === 0 ? resolve() : reject(new Error(`npm install terminou com código ${code}`)));
                proc.on('error', reject);
            });
            sendLog('OK', `Dependências atualizadas.`);
        } catch (npmErr) {
            sendLog('WARN', `Não foi possível atualizar dependências automaticamente: ${npmErr.message}`);
        }

        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch(e) {}

        try {
            const installedPjson = JSON.parse(fs.readFileSync(path.join(BASE_DIR, 'package.json'), 'utf8'));
            writeInstalledUpdateMeta({
                repo,
                tag: resolvedTag,
                version: installedPjson.version || currentVersion,
                releasePublishedAt
            });
        } catch(e) {}

        sendLog('OK', `Atualização concluída.`);
        res.write(`data: ${JSON.stringify({ line: '__DONE__:0' })}\n\n`);
        res.end();

        setTimeout(() => {
            console.log('Painel atualizado. Reiniciando...');
            try {
                // Assegura que a pasta logs existe
                const logsDir = path.join(BASE_DIR, 'logs');
                if (!fs.existsSync(logsDir)) {
                    fs.mkdirSync(logsDir, { recursive: true });
                }
                const logFile = path.join(logsDir, 'panel-restart.log');
                const out = fs.openSync(logFile, 'a');

                const startScript = path.join(BASE_DIR, 'scripts', 'start.sh');
                
                console.log('Iniciando processo desvinculado de start.sh...');
                const child = spawn('bash', [startScript], {
                    detached: true,
                    stdio: ['ignore', out, out]
                });
                child.unref();
            } catch(e) {
                console.log('Falha ao iniciar start.sh, tentando server.js...', e.message);
                try {
                    const logsDir = path.join(BASE_DIR, 'logs');
                    const logFile = path.join(logsDir, 'panel-restart.log');
                    const out = fs.openSync(logFile, 'a');
                    const serverJs = path.join(BASE_DIR, 'server.js');
                    
                    const child = spawn('node', [serverJs], {
                        detached: true,
                        stdio: ['ignore', out, out]
                    });
                    child.unref();
                } catch(errSpawn) {
                    console.log('Falha ao iniciar server.js em background:', errSpawn.message);
                }
            }
            process.exit(0);
        }, 1500);

    } catch (err) {
        sendLog('ERR', `Erro geral durante atualização: ${err.message}`);
        res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
        res.end();
    }
});

// POST /api/update/install
router.post('/api/update/install', (req, res) => {
    res.json({ success: true, message: 'Processo iniciado. Acompanhe via SSE GET.' });
});

// GET /api/update/rollback
router.get('/api/update/rollback', async (req, res) => {
    res.setHeader('Content-Type',  'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection',    'keep-alive');
    res.flushHeaders();

    const sendLog = (type, message) => {
        res.write(`data: ${JSON.stringify({ line: `[${type}] ${message}` })}\n\n`);
    };

    const targetVersion = req.query.version || '';
    if (!targetVersion) {
        sendLog('ERR', 'Versão para rollback não especificada.');
        res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
        return res.end();
    }

    sendLog('INFO', `Iniciando rollback para a versão: ${targetVersion}...`);
    const backupDir = path.join(BASE_DIR, 'backups', 'panel-backups', `version-${targetVersion}`);

    if (!fs.existsSync(backupDir)) {
        sendLog('ERR', `Nenhum backup encontrado para a versão: ${targetVersion}`);
        res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
        return res.end();
    }

    try {
        sendLog('INFO', 'Restaurando arquivos de backup...');
        for (const item of PANEL_UPDATE_ITEMS) {
            const srcPath = path.join(backupDir, item);
            const destPath = path.join(BASE_DIR, item);
            if (fs.existsSync(srcPath)) {
                fs.cpSync(srcPath, destPath, { recursive: true, force: true });
            }
        }
        
        sendLog('OK', `Rollback para a versão ${targetVersion} concluído com sucesso!`);
        res.write(`data: ${JSON.stringify({ line: '__DONE__:0' })}\n\n`);
        res.end();

        setTimeout(() => {
            console.log(`Rollback aplicado. Reiniciando na versão ${targetVersion}...`);
            process.exit(0);
        }, 1500);

    } catch (err) {
        sendLog('ERR', `Erro durante o rollback: ${err.message}`);
        res.write(`data: ${JSON.stringify({ line: '__DONE__:1' })}\n\n`);
        res.end();
    }
});

// POST /api/update/rollback
router.post('/api/update/rollback', (req, res) => {
    res.json({ success: true, message: 'Rollback iniciado. Acompanhe via SSE GET.' });
});

// Status rápido dos serviços (sem script externo)
module.exports = router;
