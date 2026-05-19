const express = require('express');
const manager = require('./manager');
const processManager = require('./process');

module.exports = function createCloudflaredRoutes() {
    const router = express.Router();

    // List Tunnels
    router.get('/tunnels', async (req, res) => {
        try {
            const list = await manager.listTunnels();
            res.json({ success: true, tunnels: list });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Create Tunnel
    router.post('/tunnel/create', (req, res) => {
        try {
            const tunnel = manager.createTunnel(req.body);
            res.json({ success: true, tunnel });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Update Tunnel
    router.post('/tunnel/update', (req, res) => {
        try {
            const tunnel = manager.updateTunnel(req.body.id, req.body);
            res.json({ success: true, tunnel });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Delete Tunnel
    router.post('/tunnel/delete', (req, res) => {
        try {
            const result = manager.deleteTunnel(req.body.id);
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Start Tunnel
    router.post('/tunnel/start', (req, res) => {
        try {
            const result = manager.startTunnel(req.body.id);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Stop Tunnel
    router.post('/tunnel/stop', (req, res) => {
        try {
            const result = manager.stopTunnel(req.body.id);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Restart Tunnel (stop → wait 1.5s → start)
    router.post('/tunnel/restart', async (req, res) => {
        try {
            manager.stopTunnel(req.body.id);
            // Wait for process to fully terminate before respawning
            await new Promise(r => setTimeout(r, 1500));
            const result = manager.startTunnel(req.body.id);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Fetch Logs
    router.get('/tunnel/logs', (req, res) => {
        try {
            const id = req.query.id;
            const lines = parseInt(req.query.lines) || 100;
            if (!id) return res.status(400).json({ error: 'Falta o ID do túnel.' });
            const logs = processManager.readLogs(id, lines);
            res.json({ success: true, logs });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Export Tunnels Configuration
    router.get('/config/export', (req, res) => {
        try {
            const tunnels = manager.getTunnels();
            res.setHeader('Content-disposition', 'attachment; filename=cloudflared_tunnels_backup.json');
            res.setHeader('Content-type', 'application/json');
            res.write(JSON.stringify(tunnels, null, 2));
            res.end();
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Import Tunnels Configuration
    router.post('/config/import', (req, res) => {
        try {
            const result = manager.importConfigurations(req.body.tunnels);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Validate YAML
    router.post('/config/validate-yaml', (req, res) => {
        try {
            const check = manager.validateYamlConfig(req.body.yamlConfig);
            res.json(check);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Generate Default YAML
    router.post('/config/generate-yaml', (req, res) => {
        try {
            const yaml = manager.generateYamlConfig(req.body);
            res.json({ success: true, yamlConfig: yaml });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Auth Status
    router.get('/auth/status', (req, res) => {
        res.json({ success: true, authenticated: manager.isClassicAuthenticated() });
    });

    // Auth Logout
    router.post('/auth/logout', (req, res) => {
        try {
            manager.clearCertificate();
            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Auth Login
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

    // Zombie Killer
    router.post('/system/kill-zombies', (req, res) => {
        res.json(processManager.killAllZombies());
    });

    // Reset Manager / Clear all configs and certificate
    router.post('/system/reset', async (req, res) => {
        try {
            const result = await manager.resetManager();
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
