const fs = require('fs');
const path = require('path');

const managerFile = path.join(__dirname, 'modules', 'cloudflared', 'manager.js');
let content = fs.readFileSync(managerFile, 'utf8');

const regex = /const novaInstancia = \{[\s\S]*?yamlMode: 'auto'\s*\};/;

const newCode = `
    let extractedTunnelId = '';
    let extractedCreds = '';
    const defaultConfig = path.join(HOME_DIR, '.cloudflared', 'config.yml');
    
    if (fs.existsSync(defaultConfig)) {
        try {
            const lines = fs.readFileSync(defaultConfig, 'utf8').split('\\n');
            for (const line of lines) {
                if (line.trim().startsWith('tunnel:')) {
                    extractedTunnelId = line.split(':')[1].trim().replace(/['"]/g, '');
                }
                if (line.trim().startsWith('credentials-file:')) {
                    extractedCreds = line.split(':')[1].trim().replace(/['"]/g, '');
                }
            }
        } catch(e) {}
    }

    const novaInstancia = {
        id: 'inst-' + crypto.randomBytes(4).toString('hex'),
        name: 'Túneis Legados (Migração)',
        type: 'service',
        protected: false,
        autoRestartOnSave: true,
        tunnelId: extractedTunnelId,
        credentialsFile: extractedCreds,
        hostname: oldRoutes[0]?.hostname || '',
        routes: newRoutes,
        yamlConfig: null,
        yamlMode: 'auto'
    };
    
    novaInstancia.configPath = path.join(HOME_DIR, '.cloudflared', novaInstancia.id + '.yml');
    generateYamlForInstance(novaInstancia);
`;

content = content.replace(regex, newCode);
fs.writeFileSync(managerFile, content, 'utf8');
console.log('manager.js patched.');
