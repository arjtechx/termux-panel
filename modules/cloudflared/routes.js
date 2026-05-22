const express = require('express');
const manager = require('./manager');
const processManager = require('./process');

module.exports = function createCloudflaredRoutes() {
    const router = express.Router();

    // Listar todas as instâncias (retorna infos + status do processo)
    router.get('/cloudflared/instances', async (req, res) => {
        try {
            const instances = manager.getInstances();
            const result = [];
            for (const inst of instances) {
                const status = await processManager.getInstanceStatus(inst.id);
                result.push({ ...inst, status });
            }
            res.json({ success: true, instances: result });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Criar nova instância
    router.post('/cloudflared/instances', (req, res) => {
        try {
            const inst = manager.createInstance(req.body);
            res.json({ success: true, instance: inst });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Editar instância
    router.put('/cloudflared/instances/:id', (req, res) => {
        try {
            const inst = manager.updateInstance(req.params.id, req.body);
            res.json({ success: true, instance: inst });
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Deletar instância (protegidas são bloqueadas no manager)
    router.delete('/cloudflared/instances/:id', (req, res) => {
        try {
            const result = manager.deleteInstance(req.params.id);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Start
    router.post('/cloudflared/instances/:id/start', (req, res) => {
        try {
            const inst = manager.getInstances().find(i => i.id === req.params.id);
            if (!inst) throw new Error('Instância não encontrada.');
            const result = processManager.startInstance(inst);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Stop
    router.post('/cloudflared/instances/:id/stop', (req, res) => {
        try {
            const inst = manager.getInstances().find(i => i.id === req.params.id);
            if (!inst) throw new Error('Instância não encontrada.');
            if (inst.protected && req.body.force !== true) {
                throw new Error('Bloqueado: Esta instância é protegida. Use o modo force para sobrescrever.');
            }
            const result = processManager.stopInstance(req.params.id);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Restart Hard
    router.post('/cloudflared/instances/:id/restart', async (req, res) => {
        try {
            const inst = manager.getInstances().find(i => i.id === req.params.id);
            if (!inst) throw new Error('Instância não encontrada.');
            if (inst.protected && req.body.force !== true) {
                throw new Error('Bloqueado: Esta instância é protegida. Use o modo force para sobrescrever.');
            }
            processManager.stopInstance(req.params.id);
            await new Promise(r => setTimeout(r, 1000));
            const result = processManager.startInstance(inst);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Reload Safe (Zero Downtime)
    router.post('/cloudflared/instances/:id/reload-safe', async (req, res) => {
        try {
            const inst = manager.getInstances().find(i => i.id === req.params.id);
            if (!inst) throw new Error('Instância não encontrada.');
            if (inst.protected && req.body.force !== true) {
                throw new Error('Bloqueado: Esta instância é protegida e o reload safe pode causar instabilidades.');
            }
            
            manager.generateYamlForInstance(inst, true); // gera .next.yml
            const result = await processManager.reloadSafeInstance(inst);
            res.json(result);
        } catch (err) {
            res.status(400).json({ success: false, error: err.message });
        }
    });

    // Pegar logs
    router.get('/cloudflared/instances/:id/logs', (req, res) => {
        try {
            const lines = parseInt(req.query.lines) || 100;
            const logs = processManager.readLogs(req.params.id, lines);
            res.json({ success: true, logs });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Kill all zombies
    router.post('/cloudflared/system/kill-zombies', (req, res) => {
        res.json(processManager.killAllZombies());
    });

    // Login Cloudflare (gera URL de autenticacao)
    router.post('/cloudflared/system/login', async (req, res) => {
        try {
            const result = await manager.startCloudflareLogin();
            res.status(result.success ? 200 : 400).json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Status do cert.pem (login Cloudflare)
    router.get('/cloudflared/system/login-status', (req, res) => {
        try {
            const status = manager.getLoginStatus();
            res.json({ success: true, ...status });
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    // Remover cert.pem manualmente
    router.post('/cloudflared/system/remove-login-config', (req, res) => {
        try {
            const result = manager.removeLoginConfig();
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    
    // Migrar rotas legadas
    router.post('/cloudflared/system/migrate-legacy', (req, res) => {
        try {
            const result = manager.migrateLegacyRoutes();
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });

    return router;
};
