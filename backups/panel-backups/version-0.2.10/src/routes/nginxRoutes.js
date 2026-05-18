const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const systemConfig = require('../utils/env');
const { runCmd } = require('../utils/shell');

const PREFIX = systemConfig.prefix;
const NGINX_CONF_DIR = systemConfig.nginx_conf_dir || `${PREFIX}/etc/nginx/conf.d`;

router.get('/', (req, res) => {
    try {
        if (!fs.existsSync(NGINX_CONF_DIR)) fs.mkdirSync(NGINX_CONF_DIR, { recursive: true });
        const files = fs.readdirSync(NGINX_CONF_DIR).filter(f => f.endsWith('.conf'));
        const sites = files.map(file => {
            const content = fs.readFileSync(path.join(NGINX_CONF_DIR, file), 'utf8');
            const domainMatch = content.match(/server_name\s+([^;]+);/);
            const listenMatch = content.match(/listen\s+(\d+)/);
            const proxyMatch = content.match(/proxy_pass\s+http:\/\/(?:127\.0\.0\.1|localhost):(\d+);/);
            
            let targetPort = '?';
            if (proxyMatch) {
                targetPort = `${proxyMatch[1]} (Proxy)`;
            } else if (listenMatch) {
                targetPort = `${listenMatch[1]} (Direto)`;
            }

            return {
                file,
                domain: domainMatch ? domainMatch[1].trim() : '?',
                port: targetPort
            };
        });
        res.json({ sites });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', async (req, res) => {
    const { domain, listenPort, type, port, path: sitePath } = req.body;
    const listen = listenPort || 8080;
    const confName = `${domain}.conf`;
    const confPath = path.join(NGINX_CONF_DIR, confName);
    let content = '';

    if (type === 'static') {
        const docRoot = sitePath ? sitePath.replace(/\/$/, '') : '/data/data/com.termux/files/home';
        const phpSock = fs.existsSync(`${PREFIX}/var/run/php-fpm.sock`) 
                        ? `${PREFIX}/var/run/php-fpm.sock` 
                        : `${PREFIX}/tmp/php-fpm.sock`;
                        
        content = `server {
    listen ${listen};
    server_name ${domain};
    root ${docRoot};
    index index.php index.html index.htm;

    location / {
        try_files $uri $uri/ =404;
    }

    location ~ \\.php$ {
        fastcgi_pass unix:${phpSock};
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME $document_root$fastcgi_script_name;
        include fastcgi_params;
    }

    location ~ /\\.(ht|git) {
        deny all;
    }
}`;
    } else {
        content = `server {
    listen ${listen};
    server_name ${domain};

    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}`;
    }

    try {
        fs.writeFileSync(confPath, content);
        await runCmd('nginx -s reload');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/', async (req, res) => {
    const { file } = req.query;
    try {
        fs.unlinkSync(path.join(NGINX_CONF_DIR, file));
        await runCmd('nginx -s reload');
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/action', async (req, res) => {
    const { action } = req.body;
    try {
        if (action === 'start') {
            await runCmd('nginx');
        } else if (action === 'stop') {
            await runCmd('nginx -s stop');
            await runCmd('pkill nginx');
        } else if (action === 'restart') {
            await runCmd('nginx -t'); // check syntax
            await runCmd('nginx -s stop');
            await runCmd('pkill nginx');
            await new Promise(r => setTimeout(r, 500));
            await runCmd('nginx');
        } else if (action === 'reload') {
            await runCmd('nginx -s reload');
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
