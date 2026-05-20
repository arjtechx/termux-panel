const express = require('express');
const router = express.Router();
const networkMonitor = require('../utils/network-monitor');
const temperatureLogger = require('../utils/temperature-logger');

router.get('/api/network/status', (req, res) => {
  try {
    const rootMode = networkMonitor.getRootMode();
    const metrics = networkMonitor.updateMetrics(rootMode);
    
    res.json({
      success: true,
      root: rootMode,
      interface: metrics.interface,
      downloadSpeed: metrics.downloadSpeed,
      uploadSpeed: metrics.uploadSpeed,
      totalReceived: metrics.totalReceived,
      totalSent: metrics.totalSent
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: "Erro ao ler rede",
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
