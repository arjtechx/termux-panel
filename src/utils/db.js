const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');

const DB_CONFIG_FILE = path.join(__dirname, '..', '..', 'config', 'database.json');
let pool = null;

async function getConnection() {
    if (pool) return pool;
    
    let config = {
        host: '127.0.0.1',
        port: 3306,
        user: 'root',
        password: '',
        database: 'painel'
    };

    if (fs.existsSync(DB_CONFIG_FILE)) {
        try {
            config = { ...config, ...JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8')) };
        } catch (e) {
            console.error('[DB] Erro ao ler database.json', e.message);
        }
    }

    try {
        pool = mysql.createPool({
            host: config.host,
            port: config.port,
            user: config.user,
            password: config.password,
            database: config.database,
            waitForConnections: true,
            connectionLimit: 10,
            queueLimit: 0
        });
        // Test connection
        await pool.query('SELECT 1');
        console.log('[DB] Conectado ao MariaDB com sucesso.');
    } catch (err) {
        console.error('[DB] Erro ao conectar ao banco de dados:', err.message);
        // Não falha imediatamente, pois pode ser uma tentativa de reconexão ou ambiente sem DB
    }
    return pool;
}

async function query(sql, params) {
    const p = await getConnection();
    if (!p) throw new Error('Database connection not established.');
    const [rows, fields] = await p.execute(sql, params);
    return rows;
}

async function initDb() {
    try {
        const p = await getConnection();
        if (!p) return;

        // 1. Criar Tabelas se não existirem
        await p.query(`
            CREATE TABLE IF NOT EXISTS users (
                id INT AUTO_INCREMENT PRIMARY KEY,
                username VARCHAR(255) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS settings (
                \`key\` VARCHAR(255) PRIMARY KEY,
                \`value\` TEXT
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS apps (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                port INT NOT NULL,
                type VARCHAR(50)
                -- O JSON original pode ter outros campos arbitrários. 
                -- Podemos armazenar as props extras em um JSON ou adicionar colunas se conhecermos a estrutura.
                -- Por precaução, adicionamos uma coluna data do tipo JSON para flexibilidade
                , \`data\` JSON
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS hosting (
                id VARCHAR(255) PRIMARY KEY,
                domain VARCHAR(255) NOT NULL,
                port INT NOT NULL,
                root_dir VARCHAR(255),
                php_version VARCHAR(50),
                \`data\` JSON
            )
        `);

        await p.query(`
            CREATE TABLE IF NOT EXISTS cloudflared_instances (
                id VARCHAR(255) PRIMARY KEY,
                name VARCHAR(255),
                token VARCHAR(1000),
                \`data\` JSON
            )
        `);

        // 2. Verificar se está vazio para possivelmente migrar dados
        const [users] = await p.query('SELECT COUNT(*) as c FROM users');
        const [apps] = await p.query('SELECT COUNT(*) as c FROM apps');
        const [hosting] = await p.query('SELECT COUNT(*) as c FROM hosting');
        
        const isDbEmpty = users[0].c === 0 && apps[0].c === 0 && hosting[0].c === 0;

        if (isDbEmpty) {
            console.log('[DB] Banco vazio. Verificando possibilidade de migração de dados...');
            await migrateJsonData(p);
            await migrateExtraJsonData(p);
        }

    } catch (err) {
        console.error('[DB] Erro ao inicializar tabelas:', err.message);
    }
}

async function migrateJsonData(p) {
    const configDir = path.join(__dirname, '..', '..', 'config');
    const dataDir = path.join(__dirname, '..', '..', 'data');
    const dbDir = path.join(__dirname, '..', '..', 'modules', 'cloudflared');

    // MIGRAR USERS
    const authFile = path.join(configDir, 'auth.json');
    if (fs.existsSync(authFile)) {
        try {
            const auth = JSON.parse(fs.readFileSync(authFile, 'utf8'));
            if (auth.user && auth.pass) {
                await p.query('INSERT IGNORE INTO users (username, password) VALUES (?, ?)', [auth.user, auth.pass]);
                console.log('[DB] Migrado: users');
            }
        } catch (e) { console.error('Erro ao migrar auth.json', e.message); }
    } else {
        // Usuário padrão
        await p.query('INSERT IGNORE INTO users (username, password) VALUES (?, ?)', ['admin', 'admin']);
    }

    // MIGRAR APPS
    const appsFile = path.join(configDir, 'apps.json');
    if (fs.existsSync(appsFile)) {
        try {
            const apps = JSON.parse(fs.readFileSync(appsFile, 'utf8'));
            for (const app of apps) {
                if (!app.id) app.id = Date.now().toString() + Math.floor(Math.random()*1000);
                await p.query('INSERT IGNORE INTO apps (id, name, port, type, `data`) VALUES (?, ?, ?, ?, ?)', 
                    [app.id, app.name || 'App', app.port || 0, app.type || '', JSON.stringify(app)]);
            }
            console.log('[DB] Migrado: apps.json');
        } catch (e) { console.error('Erro ao migrar apps.json', e.message); }
    }

    // MIGRAR HOSTING
    const hostingFile = path.join(configDir, 'hosting.json');
    if (fs.existsSync(hostingFile)) {
        try {
            const services = JSON.parse(fs.readFileSync(hostingFile, 'utf8'));
            for (const srv of services) {
                if (!srv.id) srv.id = Date.now().toString() + Math.floor(Math.random()*1000);
                await p.query('INSERT IGNORE INTO hosting (id, domain, port, root_dir, php_version, `data`) VALUES (?, ?, ?, ?, ?, ?)', 
                    [srv.id, srv.domain || srv.name || 'Site', srv.port || srv.listenPort || 0, srv.rootDir || srv.path || '', srv.phpVersion || '', JSON.stringify(srv)]);
            }
            console.log('[DB] Migrado: hosting.json');
        } catch (e) { console.error('Erro ao migrar hosting.json', e.message); }
    }

    // MIGRAR NOIP para settings
    const noipFile = path.join(configDir, 'noip.json');
    if (fs.existsSync(noipFile)) {
        try {
            const content = fs.readFileSync(noipFile, 'utf8');
            await p.query('INSERT IGNORE INTO settings (`key`, `value`) VALUES (?, ?)', ['noip_config', content]);
            console.log('[DB] Migrado: noip.json');
        } catch (e) { console.error('Erro ao migrar noip.json', e.message); }
    }

    // MIGRAR CLOUDFLARED
    const cfFile = path.join(dbDir, 'db.json');
    if (fs.existsSync(cfFile)) {
        try {
            const instances = JSON.parse(fs.readFileSync(cfFile, 'utf8'));
            for (const inst of instances) {
                if (!inst.id) inst.id = Date.now().toString() + Math.floor(Math.random()*1000);
                await p.query('INSERT IGNORE INTO cloudflared_instances (id, name, token, `data`) VALUES (?, ?, ?, ?)', 
                    [inst.id, inst.name || inst.domain || 'Tunnel', inst.token || '', JSON.stringify(inst)]);
            }
            console.log('[DB] Migrado: cloudflared db.json');
        } catch (e) { console.error('Erro ao migrar cloudflared db.json', e.message); }
    }
    
    console.log('[DB] Migração inicial concluída. Você pode manter os .json antigos como backup.');
}

async function migrateExtraJsonData(p) {
    const panelDir = path.join(__dirname, '..', '..');
    const configDir = path.join(panelDir, 'config');
    const dataDir = path.join(panelDir, 'data');

    const upsertSetting = async (key, value) => {
        await p.query(
            'INSERT INTO settings (`key`, `value`) VALUES (?, ?) ON DUPLICATE KEY UPDATE `value` = VALUES(`value`)',
            [key, value]
        );
    };

    const readJson = (file, fallback) => {
        try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
    };

    const cloudflaredInstancesFile = path.join(dataDir, 'cloudflared-instances.json');
    if (fs.existsSync(cloudflaredInstancesFile)) {
        try {
            const instances = readJson(cloudflaredInstancesFile, []);
            for (const inst of instances) {
                if (!inst.id) inst.id = Date.now().toString() + Math.floor(Math.random() * 1000);
                await p.query(
                    'INSERT INTO cloudflared_instances (id, name, token, `data`) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE name = VALUES(name), token = VALUES(token), `data` = VALUES(`data`)',
                    [inst.id, inst.name || inst.domain || inst.hostname || 'Tunnel', inst.token || '', JSON.stringify(inst)]
                );
            }
            console.log('[DB] Migrado: data/cloudflared-instances.json');
        } catch (e) { console.error('Erro ao migrar data/cloudflared-instances.json', e.message); }
    }

    const snapshotFiles = [
        path.join(configDir, 'apps.json'),
        path.join(configDir, 'auth.json'),
        path.join(configDir, 'hosting.json'),
        path.join(configDir, 'noip.json'),
        path.join(configDir, 'system.json'),
        path.join(configDir, 'ssh.json'),
        path.join(configDir, 'memory.json'),
        path.join(configDir, 'network-access.json'),
        path.join(configDir, 'ui-state.json'),
        path.join(dataDir, 'cloudflared-instances.json'),
        path.join(dataDir, 'cloudflared-routes.json'),
        path.join(dataDir, 'services.json'),
        path.join(dataDir, 'routes.json'),
        path.join(dataDir, 'tunnel-config.json')
    ];

    for (const file of snapshotFiles) {
        if (!fs.existsSync(file)) continue;
        const rel = path.relative(panelDir, file).replace(/\\/g, '/');
        try {
            await upsertSetting(`file_snapshot:${rel}`, fs.readFileSync(file, 'utf8'));
        } catch (e) {
            console.error(`Erro ao salvar snapshot ${rel}`, e.message);
        }
    }
}

module.exports = {
    getConnection,
    query,
    initDb
};
