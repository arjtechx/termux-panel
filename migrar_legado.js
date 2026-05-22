const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.join(__dirname, 'data');
const oldRoutesFile = path.join(dataDir, 'cloudflared-routes.json');
const instancesFile = path.join(dataDir, 'cloudflared-instances.json');

console.log('--- INICIANDO MIGRAÇÃO DE ROTAS ANTIGAS ---');

// 1. Checa se o arquivo antigo existe
if (!fs.existsSync(oldRoutesFile)) {
    console.log('Nenhuma rota antiga encontrada em data/cloudflared-routes.json. Nada a migrar.');
    process.exit(0);
}

// 2. Lê as rotas antigas
let oldRoutes = [];
try {
    oldRoutes = JSON.parse(fs.readFileSync(oldRoutesFile, 'utf8'));
    if (!Array.isArray(oldRoutes)) oldRoutes = [];
} catch (e) {
    console.error('Erro ao ler rotas antigas:', e.message);
    process.exit(1);
}

if (oldRoutes.length === 0) {
    console.log('Arquivo antigo vazio. Nada a migrar.');
    process.exit(0);
}

console.log(`Encontradas ${oldRoutes.length} rotas antigas. Processando...`);

// 3. Lê instâncias atuais
let instances = [];
if (fs.existsSync(instancesFile)) {
    try {
        instances = JSON.parse(fs.readFileSync(instancesFile, 'utf8'));
    } catch (e) {
        console.error('Erro ao ler instâncias atuais:', e.message);
    }
}

// Verifica se já migrou
const jaMigrado = instances.some(i => i.name === 'Túneis Legados (Migração)');
if (jaMigrado) {
    console.log('As rotas já foram a migração anteriormente ("Túneis Legados (Migração)" já existe).');
    process.exit(0);
}

// 4. Mapear rotas para o novo formato
const newRoutes = oldRoutes.map(r => {
    return {
        hostname: r.hostname || '',
        path: r.path || '',
        service: `${r.targetProtocol || 'http'}://${r.targetHost || '127.0.0.1'}:${r.targetPort || 80}`
    };
});

// 5. Criar a nova instância
const novaInstancia = {
    id: 'inst-' + crypto.randomBytes(4).toString('hex'),
    name: 'Túneis Legados (Migração)',
    type: 'service', // Não vamos colocar como core para evitar bloquear exclusão se quiserem deletar depois
    protected: false,
    autoRestartOnSave: true,
    tunnelId: '',
    credentialsFile: '',
    hostname: oldRoutes[0]?.hostname || '', // fallback
    routes: newRoutes,
    yamlConfig: null,
    yamlMode: 'auto'
};

instances.push(novaInstancia);

// 6. Salva
fs.writeFileSync(instancesFile, JSON.stringify(instances, null, 2), 'utf8');

console.log('✅ SUCESSO: Rotas migradas e salvas em cloudflared-instances.json');
console.log(`-> Você pode agora ir na aba Cloudflared, ver a instância "Túneis Legados (Migração)" e iniciá-la.`);
console.log('--- FIM ---');
