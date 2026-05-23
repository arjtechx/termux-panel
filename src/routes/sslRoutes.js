const express = require('express');
const router = express.Router();
const SSLManager = require('../managers/sslManager');
const DuckDNSManager = require('../managers/duckdnsManager');

router.post('/api/ssl/manual/validate', (req, res) => {
    try {
        const { certPem, keyPem } = req.body;
        if (!certPem || !keyPem) {
            return res.status(400).json({ error: 'Certificado ou Chave Privada ausentes.' });
        }
        
        const result = SSLManager.validateManualCert(certPem, keyPem);
        if (result.valid) {
            res.json({ success: true, subject: result.subject, issuer: result.issuer, daysLeft: result.daysLeft });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/api/ssl/manual/save', (req, res) => {
    try {
        const { certPem, keyPem } = req.body;
        
        const val = SSLManager.validateManualCert(certPem, keyPem);
        if (!val.valid) {
            return res.status(400).json({ error: val.error });
        }

        const saveRes = SSLManager.saveCert(certPem, keyPem);
        if (saveRes.success) {
            res.json({ success: true, message: 'Certificado manual salvo com sucesso!' });
        } else {
            res.status(500).json({ error: saveRes.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/api/ssl/selfsigned/create', (req, res) => {
    try {
        const { domain, days } = req.body;
        const result = SSLManager.createSelfSigned(domain || 'localhost', days || 365);
        if (result.success) {
            res.json({ success: true, message: 'Certificado autoassinado gerado com sucesso!' });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/api/ssl/duckdns/test', async (req, res) => {
    try {
        const { domain, token } = req.body;
        if (!domain || !token) return res.status(400).json({ error: 'Domínio ou token ausentes.' });
        
        const result = await DuckDNSManager.testToken(domain, token);
        if (result.success) {
            res.json({ success: true, message: 'Token e domínio testados com sucesso no DuckDNS!' });
        } else {
            res.status(400).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/api/ssl/duckdns/issue', async (req, res) => {
    // Definimos timeout longo pois a validação DNS pode levar até 1 minuto
    req.setTimeout(120000);
    
    try {
        const { domain, token, email } = req.body;
        if (!domain || !token || !email) return res.status(400).json({ error: 'Faltam parâmetros.' });
        
        const result = await DuckDNSManager.issueCertificate(domain, token, email);
        if (result.success) {
            res.json({ success: true, message: 'Certificado Let\'s Encrypt emitido e salvo com sucesso!' });
        } else {
            res.status(500).json({ error: result.error });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.get('/api/ssl/duckdns/config', (req, res) => {
    res.json({ success: true, config: DuckDNSManager.getSavedConfig() });
});

module.exports = router;
