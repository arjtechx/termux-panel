const express = require('express');
const router = express.Router();
const networkMonitor = require('../utils/network-monitor');
const temperatureLogger = require('../utils/temperature-logger');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SERVER_CONFIG_FILE = path.join(__dirname, '..', '..', 'config', 'server.json');
const NETWORK_ACCESS_FILE = path.join(__dirname, '..', '..', 'config', 'network-access.json');

router.get('/api/network/info', async (req, res) => {
    let ipv4 = 'Indisponível';
    let ipv6 = 'Indisponível';
    let httpsEnabled = false;
    let port = 8088;

    if (fs.existsSync(SERVER_CONFIG_FILE)) {
        try {
            const config = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8'));
            if (config.port) port = config.port;
            if (config.https) httpsEnabled = config.https;
        } catch(e) {}
    }

    let fetchV4 = true;
    let fetchV6 = false;

    if (fs.existsSync(NETWORK_ACCESS_FILE)) {
        try {
            const netConfig = JSON.parse(fs.readFileSync(NETWORK_ACCESS_FILE, 'utf8'));
            fetchV4 = netConfig.ipv4 !== false;
            fetchV6 = netConfig.ipv6 === true;
        } catch(e) {}
    }

    if (fetchV4) {
        try {
            const v4Res = await axios.get('https://ipv4.icanhazip.com', { timeout: 4000 });
            if (v4Res.data) ipv4 = v4Res.data.trim();
        } catch(e) {}
    } else {
        ipv4 = 'Desativado';
    }

    if (fetchV6) {
        try {
            const v6Res = await axios.get('https://ipv6.icanhazip.com', { timeout: 4000 });
            if (v6Res.data) ipv6 = v6Res.data.trim();
        } catch(e) {}
    } else {
        ipv6 = 'Desativado';
    }

    res.json({ success: true, ipv4, ipv6, httpsEnabled, port, fetchV4, fetchV6 });
});

router.post('/api/network/ssl', (req, res) => {
    const { enabled } = req.body;
    let config = {};
    if (fs.existsSync(SERVER_CONFIG_FILE)) {
        try { config = JSON.parse(fs.readFileSync(SERVER_CONFIG_FILE, 'utf8')); } catch(e) {}
    }

    if (enabled) {
        const sslKeyPath = path.join(__dirname, '..', '..', 'config', 'ssl.key');
        const sslCrtPath = path.join(__dirname, '..', '..', 'config', 'ssl.crt');
        try {
            // Só gera se não existir
            if (!fs.existsSync(sslKeyPath) || !fs.existsSync(sslCrtPath)) {
                console.log('[SSL] Gerando certificados autoassinados via openssl...');
                execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${sslKeyPath}" -out "${sslCrtPath}" -days 365 -nodes -subj "/CN=localhost"`);
            }
            config.https = true;
        } catch (e) {
            console.error('[SSL] Erro openssl:', e.message);
            return res.json({ success: false, error: 'Falha ao gerar certificado. O OpenSSL está instalado no Termux? Rode: pkg install openssl' });
        }
    } else {
        config.https = false;
    }

    fs.writeFileSync(SERVER_CONFIG_FILE, JSON.stringify(config, null, 2));
    res.json({ success: true, httpsEnabled: config.https });
});

router.get('/api/network/status', (req, res) => {
  try {
    const rootMode = networkMonitor.getRootMode();
    const metrics = networkMonitor.updateMetrics(rootMode);
    res.json(metrics);
  } catch (error) {
    console.error("[NETWORK] Erro ao ler rede:", error);
    res.json({
      success: false,
      root: false,
      interface: "---",
      downloadSpeed: "-- KB/s",
      uploadSpeed: "-- KB/s",
      totalReceived: "--",
      totalSent: "--",
      status: "Erro ao ler rede",
      error: "NETWORK_READ_ERROR",
      details: error.message
    });
  }
});

router.post('/api/network/root', (req, res) => {
  const { enabled } = req.body;
  networkMonitor.setRootMode(enabled);
  res.json({
    success: true,
    root: networkMonitor.getRootMode()
  });
});

router.get('/api/network/test', (req, res) => {
  const normal = networkMonitor.testNetworkAccess(false);

  if (normal.success) {
    return res.json({
      success: true,
      mode: "normal",
      normal,
      root: null,
      message: "Leitura funcionando sem root"
    });
  }

  const root = networkMonitor.testNetworkAccess(true);

  if (root.success) {
    return res.json({
      success: true,
      mode: "root_available",
      normal,
      root,
      message: "Leitura normal falhou, mas root funcionou"
    });
  }

  return res.json({
    success: false,
    mode: "failed",
    normal,
    root,
    message: "Não foi possível ler a rede nem sem root nem com root"
  });
});

router.get('/api/temperature/history', (req, res) => {
  try {
    const history = temperatureLogger.getHistory();
    res.json({
      success: true,
      history
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Erro ao ler historico de temperaturas",
      details: error.message
    });
  }
});

module.exports = router;
