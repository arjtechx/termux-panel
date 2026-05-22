const fs = require('fs');
const path = require('path');

// --- MANAGER.JS ---
const managerFile = path.join(__dirname, 'modules', 'cloudflared', 'manager.js');
let managerContent = fs.readFileSync(managerFile, 'utf8');

const migrationCode = `
function migrateLegacyRoutes() {
    const oldRoutesFile = path.join(PANEL_DIR, 'data', 'cloudflared-routes.json');
    if (!fs.existsSync(oldRoutesFile)) {
        return { success: false, error: 'Arquivo antigo (cloudflared-routes.json) não encontrado.' };
    }

    let oldRoutes = [];
    try {
        oldRoutes = JSON.parse(fs.readFileSync(oldRoutesFile, 'utf8'));
        if (!Array.isArray(oldRoutes)) oldRoutes = [];
    } catch (e) {
        return { success: false, error: 'Erro ao ler arquivo antigo: ' + e.message };
    }

    if (oldRoutes.length === 0) {
        return { success: false, error: 'Nenhuma rota no arquivo antigo.' };
    }

    const jaMigrado = instances.some(i => i.name === 'Túneis Legados (Migração)');
    if (jaMigrado) {
        return { success: true, message: 'Já migrado anteriormente.' };
    }

    const newRoutes = oldRoutes.map(r => ({
        hostname: r.hostname || '',
        path: r.path || '',
        service: \`\${r.targetProtocol || 'http'}://\${r.targetHost || '127.0.0.1'}:\${r.targetPort || 80}\`
    }));

    const novaInstancia = {
        id: 'inst-' + crypto.randomBytes(4).toString('hex'),
        name: 'Túneis Legados (Migração)',
        type: 'service',
        protected: false,
        autoRestartOnSave: true,
        tunnelId: '',
        credentialsFile: '',
        hostname: oldRoutes[0]?.hostname || '',
        routes: newRoutes,
        yamlConfig: null,
        yamlMode: 'auto'
    };

    instances.push(novaInstancia);
    saveInstances();
    return { success: true, message: 'Rotas antigas resgatadas com sucesso!' };
}
`;

if (!managerContent.includes('migrateLegacyRoutes')) {
    managerContent = managerContent.replace('module.exports = {', migrationCode + '\nmodule.exports = {\n    migrateLegacyRoutes,');
    fs.writeFileSync(managerFile, managerContent, 'utf8');
}

// --- ROUTES.JS ---
const routesFile = path.join(__dirname, 'modules', 'cloudflared', 'routes.js');
let routesContent = fs.readFileSync(routesFile, 'utf8');

const routeMigrationCode = `
    // Migrar rotas legadas
    router.post('/cloudflared/system/migrate-legacy', (req, res) => {
        try {
            const result = manager.migrateLegacyRoutes();
            res.json(result);
        } catch (err) {
            res.status(500).json({ success: false, error: err.message });
        }
    });
`;

if (!routesContent.includes('/cloudflared/system/migrate-legacy')) {
    routesContent = routesContent.replace('return router;', routeMigrationCode + '\n    return router;');
    fs.writeFileSync(routesFile, routesContent, 'utf8');
}

// --- APP.JS ---
const appFile = path.join(__dirname, 'public', 'app.js');
let appContent = fs.readFileSync(appFile, 'utf8');

const appMigrationCode = `
async function cfMigrateLegacy() {
    if (!confirm('Deseja procurar por instâncias/rotas do painel antigo e importá-las para a nova versão?')) return;
    try {
        showToast('Procurando instâncias antigas...', 'info');
        const res = await fetch(\`\${API_BASE}/cloudflared/system/migrate-legacy\`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(data.message || 'Instâncias resgatadas com sucesso!', 'success');
            cfFetchInstances();
        } else {
            showToast('Nenhuma instância antiga para resgatar ou erro: ' + data.error, 'warning');
        }
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}
window.cfMigrateLegacy = cfMigrateLegacy;
`;

if (!appContent.includes('cfMigrateLegacy')) {
    appContent += '\n' + appMigrationCode;
    fs.writeFileSync(appFile, appContent, 'utf8');
}

// --- INDEX.HTML ---
const indexFile = path.join(__dirname, 'public', 'index.html');
let indexContent = fs.readFileSync(indexFile, 'utf8');

const btnHtml = `
                        <button class="btn btn-info btn-sm" onclick="cfMigrateLegacy()" title="Resgatar instalações antigas e converter para o novo modelo">
                            <i data-lucide="download-cloud"></i> Resgatar Instâncias Antigas
                        </button>`;

if (!indexContent.includes('cfMigrateLegacy')) {
    indexContent = indexContent.replace('<button class="btn btn-warning btn-sm" onclick="cfKillZombies()">', btnHtml + '\n                        <button class="btn btn-warning btn-sm" onclick="cfKillZombies()">');
    fs.writeFileSync(indexFile, indexContent, 'utf8');
}

console.log('Script de patch finalizado com sucesso!');
