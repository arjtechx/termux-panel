const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const systemConfig = require('../utils/env');

const PREFIX = systemConfig.prefix;
const NGINX_CONF_DIR = systemConfig.nginx_conf_dir || `${PREFIX}/etc/nginx/conf.d`;
const NGINX_REPAIR_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'nginx-termux-repair.sh');

function execStrict(cmd, timeout = 20000) {
    return new Promise((resolve, reject) => {
        exec(cmd, { timeout, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
            const output = `${stdout || ''}${stderr || ''}`.trim();
            if (error) {
                const err = new Error(output || error.message);
                err.output = output;
                err.code = error.code;
                reject(err);
                return;
            }
            resolve(output);
        });
    });
}

function safeConfName(domain) {
    const clean = String(domain || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_.-]/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!clean || clean.includes('..')) {
        throw new Error('Nome de dominio/configuracao invalido.');
    }
    return `${clean}.conf`;
}

function safeServerName(value) {
    const raw = String(value || 'localhost').trim();
    const names = raw.split(/\s+/).filter(name => /^(\*\.)?[A-Za-z0-9_.-]+$|^_$/.test(name));
    return names.length ? names.join(' ') : 'localhost';
}

function nginxPath(value) {
    return `"${String(value).replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
}

function validatePort(value, label) {
    const port = Number.parseInt(value, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`${label} invalida.`);
    }
    if (systemConfig.is_termux && port < 1024 && !systemConfig.has_root) {
        throw new Error(`${label} menor que 1024 requer root no Termux. Use 8080 ou superior.`);
    }
    return port;
}

function ensureFastcgiParams() {
    const params = path.join(PREFIX, 'etc', 'nginx', 'fastcgi_params');
    const conf = path.join(PREFIX, 'etc', 'nginx', 'fastcgi.conf');
    if (fs.existsSync(params)) return params;
    if (fs.existsSync(conf)) return conf;

    fs.mkdirSync(path.dirname(params), { recursive: true });
    fs.writeFileSync(params, [
        'fastcgi_param  QUERY_STRING       $query_string;',
        'fastcgi_param  REQUEST_METHOD     $request_method;',
        'fastcgi_param  CONTENT_TYPE       $content_type;',
        'fastcgi_param  CONTENT_LENGTH     $content_length;',
        'fastcgi_param  SCRIPT_NAME        $fastcgi_script_name;',
        'fastcgi_param  REQUEST_URI        $request_uri;',
        'fastcgi_param  DOCUMENT_URI       $document_uri;',
        'fastcgi_param  DOCUMENT_ROOT      $document_root;',
        'fastcgi_param  SERVER_PROTOCOL    $server_protocol;',
        'fastcgi_param  REQUEST_SCHEME     $scheme;',
        'fastcgi_param  GATEWAY_INTERFACE  CGI/1.1;',
        'fastcgi_param  SERVER_SOFTWARE    nginx/$nginx_version;',
        'fastcgi_param  REMOTE_ADDR        $remote_addr;',
        'fastcgi_param  REMOTE_PORT        $remote_port;',
        'fastcgi_param  SERVER_ADDR        $server_addr;',
        'fastcgi_param  SERVER_PORT        $server_port;',
        'fastcgi_param  SERVER_NAME        $server_name;',
        'fastcgi_param  REDIRECT_STATUS    200;',
        ''
    ].join('\n'));
    return params;
}

async function repairNginxBootstrap() {
    if (systemConfig.is_termux && fs.existsSync(NGINX_REPAIR_SCRIPT)) {
        await execStrict(`sh "${NGINX_REPAIR_SCRIPT}"`, 60000);
    }
}

async function reloadOrStartNginx() {
    try {
        await execStrict('nginx -s reload');
    } catch (_) {
        await execStrict('nginx');
    }
}

router.get('/', (req, res) => {
    try {
        if (!fs.existsSync(NGINX_CONF_DIR)) fs.mkdirSync(NGINX_CONF_DIR, { recursive: true });
        const files = fs.readdirSync(NGINX_CONF_DIR).filter(f => f.endsWith('.conf'));
        const sites = files.map(file => {
            const content = fs.readFileSync(path.join(NGINX_CONF_DIR, file), 'utf8');
            const domainMatch = content.match(/server_name\s+([^;]+);/);
            const listenMatch = content.match(/listen\s+(?:0\.0\.0\.0:)?(\d+)/);
            const proxyMatch = content.match(/proxy_pass\s+http:\/\/(?:127\.0\.0\.1|localhost):(\d+);/);

            return {
                file,
                domain: domainMatch ? domainMatch[1].trim() : '?',
                port: proxyMatch
                    ? `${proxyMatch[1]} (Proxy)`
                    : (listenMatch ? `${listenMatch[1]} (Direto)` : '?')
            };
        });
        res.json({ sites });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const { domain, listenPort, type, port, path: sitePath } = req.body;
        const listen = validatePort(listenPort || 8080, 'Porta de escuta');
        const confName = safeConfName(domain);
        const confPath = path.join(NGINX_CONF_DIR, confName);
        const serverName = safeServerName(domain);

        let content = '';
        if (type === 'static') {
            const docRoot = path.resolve(sitePath ? String(sitePath).replace(/\/$/, '') : '/data/data/com.termux/files/home');
            const fastcgiInclude = ensureFastcgiParams();
            content = `server {
    listen ${listen};
    server_name ${serverName};
    root ${nginxPath(docRoot)};
    index index.php index.html index.htm;

    location / {
        try_files $uri $uri/ =404;
    }

    location ~ \\.php$ {
        fastcgi_pass 127.0.0.1:9070;
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include ${fastcgiInclude};
    }

    location ~ /\\.(ht|git) {
        deny all;
    }
}`;
        } else if (type === 'proxy') {
            const targetPort = validatePort(port, 'Porta de destino');
            content = `server {
    listen ${listen};
    server_name ${serverName};

    location / {
        proxy_pass http://127.0.0.1:${targetPort};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}`;
        } else {
            throw new Error('Tipo NGINX invalido. Use static ou proxy.');
        }

        if (!fs.existsSync(NGINX_CONF_DIR)) fs.mkdirSync(NGINX_CONF_DIR, { recursive: true });
        fs.writeFileSync(confPath, content);

        try {
            await repairNginxBootstrap();
            await execStrict('nginx -t');
            await reloadOrStartNginx();
            res.json({ success: true });
        } catch (err) {
            fs.rmSync(confPath, { force: true });
            throw err;
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/', async (req, res) => {
    try {
        const file = path.basename(String(req.query.file || ''));
        if (!file.endsWith('.conf')) throw new Error('Arquivo de configuracao invalido.');
        fs.rmSync(path.join(NGINX_CONF_DIR, file), { force: true });
        await repairNginxBootstrap();
        await execStrict('nginx -t');
        await reloadOrStartNginx();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/action', async (req, res) => {
    const { action } = req.body;
    try {
        if (action === 'stop') {
            await execStrict('nginx -s stop').catch(() => {});
            await execStrict('pkill nginx').catch(() => {});
            res.json({ success: true });
            return;
        }

        await repairNginxBootstrap();
        await execStrict('nginx -t');

        if (action === 'start') {
            await execStrict('nginx');
        } else if (action === 'restart') {
            await execStrict('nginx -s stop').catch(() => {});
            await execStrict('pkill nginx').catch(() => {});
            await new Promise(r => setTimeout(r, 500));
            await execStrict('nginx');
        } else if (action === 'reload') {
            await reloadOrStartNginx();
        } else {
            throw new Error('Acao NGINX invalida.');
        }

        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
