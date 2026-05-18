const express = require('express');
const manager = require('./manager');
const processManager = require('./process');
const logs = require('./logs');
const { startWatchdog, runWatchdogOnce } = require('./monitor');

module.exports = function createCloudflaredRoutes(io) {
    const router = express.Router();
    startWatchdog();

    router.get('/tunnels', (req, res) => {
        try {
            res.json({ success: true, tunnels: manager.listTunnels() });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.get('/tunnel/:id', (req, res) => {
        try {
            const tunnel = manager.getTunnel(req.params.id);
            if (!tunnel) return res.status(404).json({ success: false, error: 'Túnel não encontrado.' });
            res.json({ success: true, tunnel });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/tunnel/create', async (req, res) => {
        try {
            const tunnel = await manager.createTunnel(req.body || {});
            res.json({ success: true, tunnel });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.post('/tunnel/start', (req, res) => {
        try {
            res.json(processManager.startTunnel(req.body.id));
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.post('/tunnel/stop', (req, res) => {
        try {
            res.json(processManager.stopTunnel(req.body.id));
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.post('/tunnel/restart', (req, res) => {
        try {
            res.json(processManager.restartTunnel(req.body.id));
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.delete('/tunnel/delete/:id', (req, res) => {
        try {
            res.json(manager.deleteTunnel(req.params.id));
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

    router.get('/tunnel/logs', (req, res) => {
        try {
            res.type('text/plain').send(logs.getTunnelLogs(req.query.id, req.query.lines || 200));
        } catch (err) {
            res.status(400).type('text/plain').send(err.message);
        }
    });

    router.post('/tunnel/login', (req, res) => {
        try {
            res.json(manager.startLogin(io));
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.get('/tunnel/login/logs', (req, res) => {
        res.type('text/plain').send(logs.getLoginLogs(req.query.lines || 200));
    });

    router.post('/tunnel/watchdog', (req, res) => {
        try {
            runWatchdogOnce();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
