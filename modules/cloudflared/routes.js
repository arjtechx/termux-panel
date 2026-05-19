const express = require('express');
const manager = require('./manager');
const processManager = require('./process');
const logs = require('./logs');
const diagnostics = require('./diagnostics');
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

    router.get('/tunnel/:id', (req, res, next) => {
        if (['logs', 'diagnostics'].includes(req.params.id)) return next();
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

    router.post('/tunnel/update', (req, res) => {
        try {
            const tunnel = manager.updateTunnel(req.body.id, req.body || {});
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

    router.post('/tunnel/login', async (req, res) => {
        try {
            const result = await manager.startLogin(io);
            res.status(result.success ? 200 : 400).json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    router.get('/tunnel/login/logs', (req, res) => {
        const text = logs.getLoginLogs(req.query.lines || 200);
        res.type('text/plain')
            .set('X-Cloudflared-Auth-Url', manager.getLastLoginUrl() || '')
            .send(text);
    });

    router.get('/tunnel/login/status', (req, res) => {
        res.json({ success: true, ...manager.getLoginStatusSnapshot() });
    });

    router.get('/tunnel/diagnostics', async (req, res) => {
        try {
            res.json(await diagnostics.runDiagnostics());
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    router.post('/tunnel/watchdog', (req, res) => {
        try {
            runWatchdogOnce();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    const resetCloudflaredManager = (req, res) => {
        try {
            res.json(manager.resetManager());
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    };

    router.post('/tunnel/reset', resetCloudflaredManager);
    router.post('/cloudflared/reset', resetCloudflaredManager);

    return router;
};
