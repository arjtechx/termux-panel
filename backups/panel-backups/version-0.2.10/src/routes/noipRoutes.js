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
                const ipRes = await axios.get('https://ifconfig.co/ip');
                const myip = ipRes.data.trim();
                noipStatus.currentIP = myip;
                logNoip(`IP Detectado: ${myip}`);

                const auth = Buffer.from(`${config.username}:${config.password}`).toString('base64');
                const updateUrl = `https://dynupdate.no-ip.com/nic/update?hostname=${config.hostname}&myip=${myip}`;
                
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
            res.json({ config, status: noipStatus });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/', (req, res) => {
        try {
            fs.writeFileSync(NOIP_FILE, JSON.stringify(req.body, null, 2));
            if (req.body.autostart) {
                startNoipUpdater();
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
        res.json({ success: true, status: noipStatus });
    });

    return router;
};
