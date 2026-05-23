const express = require('express');
const router = express.Router();
const { runCmd } = require('../utils/shell');

router.get('/', async (req, res) => {
    try {
        const cronOut = await runCmd('crontab -l');
        res.json({ cron: cronOut || '' });
    } catch (err) {
        res.json({ cron: '' });
    }
});

router.post('/', async (req, res) => {
    const { cron } = req.body;
    try {
        const escapedCron = cron.replace(/'/g, "'\\''");
        await runCmd(`echo '${escapedCron}' | crontab -`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
