const express = require('express');
const router = express.Router();
const { checkPortStatus } = require('../utils/shell');
const db = require('../utils/db');

router.get('/', async (req, res) => {
    try {
        const rows = await db.query('SELECT * FROM apps');
        const apps = rows.map(r => {
            const data = r.data || {};
            return { id: r.id, name: r.name, port: r.port, type: r.type, ...data };
        });
        
        const enhancedApps = await Promise.all(apps.map(async (app) => {
            app.status = await checkPortStatus(app.port);
            return app;
        }));
        res.json(enhancedApps);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.post('/', async (req, res) => {
    try {
        const newApp = { id: Date.now().toString(), ...req.body };
        await db.query('INSERT INTO apps (id, name, port, type, `data`) VALUES (?, ?, ?, ?, ?)', 
            [newApp.id, newApp.name || 'App', newApp.port || 0, newApp.type || '', JSON.stringify(newApp)]);
        res.json(newApp);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.put('/:id', async (req, res) => {
    try {
        const id = req.params.id;
        const rows = await db.query('SELECT * FROM apps WHERE id = ?', [id]);
        if (rows.length > 0) {
            const existing = { ...rows[0], ...(rows[0].data || {}) };
            const updated = { ...existing, ...req.body };
            await db.query('UPDATE apps SET name=?, port=?, type=?, `data`=? WHERE id=?', 
                [updated.name || 'App', updated.port || 0, updated.type || '', JSON.stringify(updated), id]);
            res.json(updated);
        } else {
            res.status(404).json({ error: 'App not found' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

router.delete('/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM apps WHERE id = ?', [req.params.id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
