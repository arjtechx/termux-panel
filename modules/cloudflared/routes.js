const express = require('express');
const manager = require('./manager');
const processManager = require('./process');

module.exports = function createCloudflaredRoutes() {
    const router = express.Router();

    // Tunnel CRUD
    router.get('/tunnels', (req, res) => {
        try {
            res.json({ success: true, tunnels: manager.listTunnels() });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/tunnel/create', (req, res) => {
        try {
            const tunnel = manager.createTunnel(req.body);
            res.json({ success: true, tunnel });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.post('/tunnel/update', (req, res) => {
        try {
            const tunnel = manager.updateTunnel(req.body.id, req.body);
            res.json({ success: true, tunnel });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.post('/tunnel/delete', (req, res) => {
        try {
            res.json(manager.deleteTunnel(req.body.id));
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Process Controls
    router.post('/tunnel/start', (req, res) => {
        try {
            res.json(manager.startTunnel(req.body.id));
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.post('/tunnel/stop', (req, res) => {
        try {
            res.json(manager.stopTunnel(req.body.id));
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.post('/tunnel/restart', (req, res) => {
        try {
            manager.stopTunnel(req.body.id);
            res.json(manager.startTunnel(req.body.id));
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.get('/tunnel/logs', (req, res) => {
        try {
            res.type('text/plain').send(processManager.readLogs(req.query.id, req.query.lines || 200));
        } catch (err) {
            res.status(400).type('text/plain').send(err.message);
        }
    });

    // Classic Login & Auth Status
    router.get('/auth/status', (req, res) => {
        res.json({ success: true, authenticated: manager.isClassicAuthenticated() });
    });

    router.post('/auth/logout', (req, res) => {
        try {
            manager.clearCertificate();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/auth/login', async (req, res) => {
        try {
            const result = await manager.getLoginUrl();
            if (result && result.url) {
                res.json({ success: true, url: result.url });
            } else {
                res.status(400).json({ success: false, error: 'Falha: ' + (result?.error || 'Desconhecida.') });
            }
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Panic Button
    router.post('/system/kill-zombies', (req, res) => {
        res.json(processManager.killAllZombies());
    });

    return router;
};
