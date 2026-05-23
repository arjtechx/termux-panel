const express = require('express');
const fs = require('fs');
const path = require('path');
const autoConfig = require('../services/autoConfigService');
const { LOG_DIR, FILES, readJson } = require('../services/autoConfigStorage');

const router = express.Router();

router.post('/detect', async (req, res) => {
  try {
    const domain = String(req.body.domain || '').trim();
    if (!domain) throw new Error('Domínio principal é obrigatório.');
    res.json(await autoConfig.detect(domain));
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post('/generate', async (req, res) => {
  try {
    const domain = String(req.body.domain || '').trim();
    if (!domain) throw new Error('Domínio principal é obrigatório.');
    const mode = req.body.mode;
    res.json(await autoConfig.generate({ domain, mode }));
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.post('/validate', async (req, res) => {
  try {
    const current = readJson(FILES.tunnelConfig, {});
    res.json(await autoConfig.validate(current));
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/apply', async (req, res) => {
  try {
    const current = readJson(FILES.tunnelConfig, {});
    const result = await autoConfig.apply(current);
    if (!result.success) return res.status(400).json(result);
    res.json(result);
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/restore', async (req, res) => {
  try {
    res.json(autoConfig.restoreLastBackup());
  } catch (e) {
    res.status(400).json({ success: false, error: e.message });
  }
});

router.get('/state', (req, res) => {
  res.json({
    success: true,
    services: readJson(FILES.services, { services: [] }),
    routes: readJson(FILES.routes, { routes: [] }),
    config: readJson(FILES.tunnelConfig, {})
  });
});

router.get('/logs', (req, res) => {
  const kind = String(req.query.kind || 'services');
  const file = path.join(LOG_DIR, `${kind}.log`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : 'Sem logs ainda.';
  res.json({ success: true, logs: text });
});

module.exports = router;
