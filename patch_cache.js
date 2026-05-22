const fs = require('fs');

const file = 'server.js';
let content = fs.readFileSync(file, 'utf8');

// Inject cache variables near the top
const cacheVars = `
let _apiStatusCache = null;
let _apiStatusTime = 0;
let _apiProcessesCache = null;
let _apiProcessesTime = 0;
`;

if (!content.includes('_apiStatusCache')) {
    content = content.replace("app.get('/api/status', async (req, res) => {", cacheVars + "\napp.get('/api/status', async (req, res) => {\n    if (Date.now() - _apiStatusTime < 2000 && _apiStatusCache) return res.json(_apiStatusCache);");
    content = content.replace("res.json(status);", "_apiStatusCache = status; _apiStatusTime = Date.now(); res.json(status);");
}

if (!content.includes('_apiProcessesCache')) {
    content = content.replace("app.get('/api/processes', async (req, res) => {", "app.get('/api/processes', async (req, res) => {\n    if (Date.now() - _apiProcessesTime < 2000 && _apiProcessesCache) return res.json(_apiProcessesCache);");
    content = content.replace("res.json({ success: true, processes: procs });", "_apiProcessesCache = { success: true, processes: procs }; _apiProcessesTime = Date.now(); res.json({ success: true, processes: procs });");
}

fs.writeFileSync(file, content, 'utf8');
console.log('server.js modificado para incluir cache!');
