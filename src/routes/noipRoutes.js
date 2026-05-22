const express = require('express');
const fs = require('fs');
const path = require('path');
const axios = require('axios');

const NOIP_FILE = path.join(__dirname, '..', '..', 'config', 'noip.json');

module.exports = function(io) {
    const router = express.Router();
    
    let noipInterval = null;
    let noipStatus = { status: 'Parado', lastUpdate: 'N/A', currentIP: 'N/A', log: [] };

    function logNoip(msg) {
        noipStatus.log.unshift(`[${new Date().toLocaleTimeString()}] ${msg}`);
        if (noipStatus.log.length > 50) noipStatus.log.pop();
        if (io) {
            io.emit('noip-log', noipStatus);
        }
    }

    async function startNoipUpdater() {
        if (noipInterval) clearInterval(noipInterval);
        if (!fs.existsSync(NOIP_FILE)) return;
        const config = JSON.parse(fs.readFileSync(NOIP_FILE, 'utf8'));
        if (!config.username || !config.password || !config.hostname) {
            noipStatus.status = 'Erro: Credenciais incompletas';
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
                    try {
                        const v4Res = await axios.get('https://ipv4.icanhazip.com', { timeout: 10000 });
                        ipv4 = v4Res.data.trim();
                    } catch (e) {
                        logNoip('Aviso: Falha ao obter IPv4');
                    }
                }
                
                if (ipType === 'ipv6' || ipType === 'both') {
                    try {
                        const v6Res = await axios.get('https://ipv6.icanhazip.com', { timeout: 10000 });
                        ipv6 = v6Res.data.trim();
                    } catch (e) {
                        logNoip('Aviso: Falha ao obter IPv6');
                    }
                }

                if (!ipv4 && !ipv6) {
                    throw new Error('Não foi possível obter nenhum IP (IPv4 ou IPv6).');
                }

                const myips = [ipv4, ipv6].filter(Boolean).join(', ');
                noipStatus.currentIP = myips;
                logNoip(`IP Detectado: ${myips}`);

                const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
                let updateUrl = `https://dynupdate.no-ip.com/nic/update?hostname=${config.hostname}`;
                if (ipv4) updateUrl += `&myip=${ipv4}`;
                if (ipv6) updateUrl += `&myipv6=${ipv6}`;
                
                const res = await axios.get(updateUrl, {
                    headers: { 'Authorization': `Basic ${auth}`, 'User-Agent': 'TermuxcPanel/1.0 gabriel@example.com' }
                });
                
                const resultBody = res.data;
                noipStatus.lastUpdate = new Date().toLocaleTimeString();
                logNoip(`Resposta NO-IP: ${resultBody}`);
            } catch (e) {
                logNoip(`Erro ao atualizar NO-IP: ${e.message}`);
            }
        };

        updateIP();
        noipInterval = setInterval(updateIP, (config.interval || 15) * 60000);
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
            if (config.autostart) {
                startNoipUpdater();
            }
        } catch (e) {}
    }

    router.get('/', (req, res) => {
        try {
            const config = fs.existsSync(NOIP_FILE) ? JSON.parse(fs.readFileSync(NOIP_FILE, 'utf8')) : {};
            res.json({
                status: noipStatus.status,
                currentIp: noipStatus.currentIP,
                lastUpdate: noipStatus.lastUpdate,
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
            fs.writeFileSync(NOIP_FILE, JSON.stringify(req.body, null, 2));
            if (req.body.autostart) {
                startNoipUpdater();
            } else {
                // If autostart was turned off but it's running, maybe we should stop it?
                // For now keep existing logic: start if autostart is checked.
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
