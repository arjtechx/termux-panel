const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const net = require('net');

const NOIP_FILE = path.join(__dirname, '..', '..', 'config', 'noip.json');

module.exports = function(io) {
    const router = express.Router();

    let noipInterval = null;
    let noipStatus = { status: 'Parado', lastUpdate: 'N/A', currentIP: 'N/A', log: [] };
    let lastSent = { ipv4: '', ipv6: '' };

    function logNoip(msg) {
        noipStatus.log.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if (noipStatus.log.length > 80) noipStatus.log.pop();
        if (io) io.emit('noip-log', noipStatus);
    }

    async function getFirstValidIp(urls, versionLabel) {
        for (const url of urls) {
            try {
                const res = await axios.get(url, { timeout: 10000 });
                const value = String(res.data || '').trim();
                if (versionLabel === 'ipv4' && net.isIP(value) === 4) return value;
                if (versionLabel === 'ipv6' && net.isIP(value) === 6) return value;
            } catch (_) {}
        }
        return '';
    }

    async function startNoipUpdater() {
        if (noipInterval) clearInterval(noipInterval);
        if (!fs.existsSync(NOIP_FILE)) return;

        const config = JSON.parse(fs.readFileSync(NOIP_FILE, 'utf8'));
        if (!config.username || !config.password || !config.hostname) {
            noipStatus.status = 'Erro: Credenciais incompletas';
            logNoip('Erro: configure usuário, senha e hostname antes de iniciar.');
            return;
        }

        noipStatus.status = 'Executando...';
        logNoip('Serviço NO-IP iniciado.');

        const updateIP = async () => {
            try {
                let ipv4 = '';
                let ipv6 = '';
                const ipType = config.ipType || 'both';

                if (ipType === 'ipv4' || ipType === 'both') {
                    ipv4 = await getFirstValidIp([
                        'https://ipv4.icanhazip.com',
                        'https://api.ipify.org',
                        'https://ifconfig.me/ip'
                    ], 'ipv4');
                    if (!ipv4) logNoip('Aviso: Falha ao obter IPv4');
                }

                if (ipType === 'ipv6' || ipType === 'both') {
                    ipv6 = await getFirstValidIp([
                        'https://ipv6.icanhazip.com',
                        'https://api64.ipify.org',
                        'https://ifconfig.co/ip'
                    ], 'ipv6');
                    if (!ipv6) logNoip('Aviso: Falha ao obter IPv6');
                }

                if (!ipv4 && !ipv6) {
                    throw new Error('Não foi possível obter nenhum IP (IPv4/IPv6).');
                }

                const myips = [ipv4, ipv6].filter(Boolean).join(', ');
                noipStatus.currentIP = myips;
                logNoip(`IP detectado: ${myips}`);

                if (ipv4 === lastSent.ipv4 && ipv6 === lastSent.ipv6) {
                    logNoip('IP sem alteração desde o último update.');
                    return;
                }

                const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
                let updateUrl = `https://dynupdate.no-ip.com/nic/update?hostname=${encodeURIComponent(config.hostname)}`;
                if (ipv4) updateUrl += `&myip=${encodeURIComponent(ipv4)}`;
                if (ipv6) updateUrl += `&myipv6=${encodeURIComponent(ipv6)}`;

                const res = await axios.get(updateUrl, {
                    timeout: 15000,
                    headers: {
                        Authorization: `Basic ${auth}`,
                        'User-Agent': 'TermuxcPanel/1.0 noip-manager'
                    }
                });

                const resultBody = String(res.data || '').trim();
                noipStatus.lastUpdate = new Date().toLocaleTimeString();
                logNoip(`Resposta NO-IP: ${resultBody}`);

                if (/^(good|nochg)\b/i.test(resultBody)) {
                    lastSent = { ipv4, ipv6 };
                    noipStatus.status = 'Executando...';
                } else if (/^(badauth|nohost|abuse|badagent|!donator|911)\b/i.test(resultBody)) {
                    noipStatus.status = `Erro NO-IP: ${resultBody.split(/\s+/)[0]}`;
                }
            } catch (e) {
                logNoip(`Erro ao atualizar NO-IP: ${e.message}`);
            }
        };

        await updateIP();
        const minutes = Number.isInteger(config.interval) && config.interval > 0 ? config.interval : 15;
        noipInterval = setInterval(updateIP, minutes * 60000);
    }

    function stopNoipUpdater() {
        if (noipInterval) {
            clearInterval(noipInterval);
            noipInterval = null;
        }
        noipStatus.status = 'Parado';
        logNoip('Serviço NO-IP parado.');
    }

    if (fs.existsSync(NOIP_FILE)) {
        try {
            const config = JSON.parse(fs.readFileSync(NOIP_FILE, 'utf8'));
            if (config.autostart) startNoipUpdater();
        } catch (_) {}
    }

    router.get('/', (req, res) => {
        try {
            const config = fs.existsSync(NOIP_FILE) ? JSON.parse(fs.readFileSync(NOIP_FILE, 'utf8')) : {};
            res.json({
                status: noipStatus.status,
                currentIp: noipStatus.currentIP,
                lastUpdate: noipStatus.lastUpdate,
                log: noipStatus.log,
                username: config.username,
                hostname: config.hostname,
                interval: config.interval,
                autostart: config.autostart,
                ipType: config.ipType || 'both'
            });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/', (req, res) => {
        try {
            const prev = fs.existsSync(NOIP_FILE) ? JSON.parse(fs.readFileSync(NOIP_FILE, 'utf8')) : {};
            const body = req.body || {};
            const ipType = ['ipv4', 'ipv6', 'both'].includes(body.ipType) ? body.ipType : 'both';
            const interval = Number.isInteger(body.interval) && body.interval > 0 ? body.interval : 15;
            const next = {
                username: String(body.username || '').trim(),
                password: body.password ? String(body.password) : (prev.password || ''),
                hostname: String(body.hostname || '').trim(),
                interval,
                ipType,
                autostart: !!body.autostart
            };

            fs.writeFileSync(NOIP_FILE, JSON.stringify(next, null, 2));
            if (next.autostart) {
                startNoipUpdater();
            } else {
                stopNoipUpdater();
            }
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/toggle', (req, res) => {
        if (noipInterval) {
            stopNoipUpdater();
        } else {
            startNoipUpdater();
        }
        res.json({ success: true });
    });

    return router;
};
