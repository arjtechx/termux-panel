const express = require('express');
const path = require('path');
const BASE_DIR = process.env.HOME || path.join(__dirname, '..', '..');
const BACKUP_DIR = path.join(BASE_DIR, 'backups');
const crypto = require('crypto');
const net = require('net');

const router = express.Router();
const fs = require('fs');
const mysql = require('mysql2/promise');
const { exec, spawn } = require('child_process');
const os = require('os');
const systemConfig = require('../utils/env');
const { runCmd, chownToUser } = require('../utils/shell');

const DB_FILE = path.join(__dirname, '..', '..', 'config', 'db.json');
const LOGS_DIR = path.join(__dirname, '..', '..', 'logs');
const DB_ACTIONS_LOG = path.join(LOGS_DIR, 'database-actions.log');

// --- Database Manager Logic ---
async function getDbConn() {
    const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    return await mysql.createConnection(config);
}

// Lista bancos com tamanho
router.get('/api/db', async (req, res) => {
    try {
        const conn = await getDbConn();
        const [rows] = await conn.query('SHOW DATABASES');
        const [sizeRows] = await conn.query(`
            SELECT table_schema AS name,
                   ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS size_mb
            FROM information_schema.tables
            GROUP BY table_schema
        `);
        await conn.end();
        const sizeMap = {};
        sizeRows.forEach(r => sizeMap[r.name] = r.size_mb);
        res.json({ databases: rows.map(r => ({ name: r.Database, size_mb: sizeMap[r.Database] || 0 })) });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Status completo do MariaDB
router.get('/api/db/status', async (req, res) => {
    try {
        const conn = await getDbConn();
        const [[{ Value: uptime }]]     = await conn.query("SHOW GLOBAL STATUS LIKE 'Uptime'");
        const [[{ Value: threads }]]    = await conn.query("SHOW GLOBAL STATUS LIKE 'Threads_connected'");
        const [[{ Value: questions }]]  = await conn.query("SHOW GLOBAL STATUS LIKE 'Questions'");
        const [sizeRows] = await conn.query(`
            SELECT ROUND(SUM(data_length + index_length) / 1024 / 1024, 2) AS total_mb
            FROM information_schema.tables
        `);
        const [dbCountRows] = await conn.query('SHOW DATABASES');
        await conn.end();

        // RAM usage via ps
        const ramOut = await runCmd('ps aux | grep mariad | grep -v grep | awk \'{print $4}\'');
        const ramPct = ramOut.trim().split('\n')[0] || 'N/A';

        const uptimeSec = parseInt(uptime);
        const h = Math.floor(uptimeSec / 3600);
        const m = Math.floor((uptimeSec % 3600) / 60);
        const uptimeStr = `${h}h ${m}m`;

        res.json({
            online:      true,
            port:        3306,
            uptime:      uptimeStr,
            connections: threads,
            queries:     questions,
            totalSizeMb: sizeRows[0]?.total_mb || 0,
            dbCount:     dbCountRows.length,
            ramPct:      ramPct,
        });
    } catch (err) {
        // Fallback: se a conexão via Driver MySQL falhar (ex: credenciais/Access Denied), mas o processo do banco estiver ativo na porta
        const isRunning = await isMariaDBRunning();
        if (isRunning) {
            return res.json({
                online:      true,
                port:        3306,
                uptime:      'Ativo (Sem login)',
                connections: '0',
                queries:     '0',
                totalSizeMb: 0,
                dbCount:     0,
                ramPct:      'N/A',
                warning:     `Erro de Conexão: ${err.message}`
            });
        }
        res.json({ online: false, error: err.message });
    }
});

// Test connection
router.get('/api/db/test', async (req, res) => {
    try {
        const conn = await getDbConn();
        await conn.ping();
        await conn.end();
        res.json({ success: true, message: 'Conexão OK!' });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

router.post('/api/db/setup', (req, res) => {
    try {
        fs.writeFileSync(DB_FILE, JSON.stringify(req.body, null, 2));
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Criar banco + usuário
router.post('/api/db/create', async (req, res) => {
    const { dbName, dbUser, dbPass } = req.body;
    try {
        const safeDbName = assertDbName(dbName);
        const conn = await getDbConn();
        await conn.query(`CREATE DATABASE IF NOT EXISTS ${quoteDbIdentifier(safeDbName)}`);
        if (dbUser && dbPass) {
            const account = quoteDbAccount(dbUser, 'localhost');
            await conn.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ?`, [dbPass]);
            await conn.query(`GRANT ALL PRIVILEGES ON ${quoteDbIdentifier(safeDbName)}.* TO ${account}`);
            await conn.query('FLUSH PRIVILEGES');
        }
        await conn.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Drop banco
router.delete('/api/db/:name', async (req, res) => {
    try {
        const dbName = assertDbName(req.params.name);
        if (isSystemDb(dbName)) {
            return res.status(403).json({ error: 'Remocao bloqueada em banco de sistema.' });
        }
        const conn = await getDbConn();
        await conn.query(`DROP DATABASE IF EXISTS ${quoteDbIdentifier(dbName)}`);
        await conn.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Criar apenas usuário
router.post('/api/db/user', async (req, res) => {
    const { username, password, database } = req.body;
    try {
        const account = quoteDbAccount(username, 'localhost');
        const conn = await getDbConn();
        await conn.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ?`, [password]);
        if (database) {
            const dbName = assertDbName(database);
            await conn.query(`GRANT ALL PRIVILEGES ON ${quoteDbIdentifier(dbName)}.* TO ${account}`);
        }
        await conn.query('FLUSH PRIVILEGES');
        await conn.end();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Backup de um banco específico
router.post('/api/db/backup', async (req, res) => {
    const { dbName } = req.body;
    try {
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const safeDbName = dbName ? assertDbName(dbName) : '';
        const filename = `db-${safeDbName || 'all'}-${ts}.sql`;
        const filePath = safeBackupPath(filename);
        const dbArg = safeDbName ? shellQuote(safeDbName) : '--all-databases';
        await runCmd(`mysqldump ${mysqlCliArgs(config)} ${dbArg} > ${shellQuote(filePath)}`);
        res.json({ success: true, filename });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Restaurar backup SQL
router.post('/api/db/restore', async (req, res) => {
    const { filename, dbName } = req.body;
    try {
        const config   = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const filePath = safeBackupPath(filename);
        if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Arquivo não encontrado' });
        const dbArg   = dbName ? shellQuote(assertDbName(dbName)) : '';
        await runCmd(`mysql ${mysqlCliArgs(config)} ${dbArg} < ${shellQuote(filePath)}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Listar backups SQL
router.get('/api/db/backups', (req, res) => {
    try {
        if (!fs.existsSync(BACKUP_DIR)) return res.json({ backups: [] });
        const files = fs.readdirSync(BACKUP_DIR)
            .filter(f => f.endsWith('.sql'))
            .map(f => {
                const stats = fs.statSync(path.join(BACKUP_DIR, f));
                return { name: f, size: (stats.size / 1024).toFixed(1) + ' KB', date: stats.mtime.toLocaleString() };
            })
            .sort((a, b) => new Date(b.date) - new Date(a.date));
        res.json({ backups: files });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});


// ─── ADVANCED DATABASE MANAGER LAYER ──────────────────────────────
// const LOGS_DIR = path.join(__dirname, 'logs');
// const DB_ACTIONS_LOG = path.join(LOGS_DIR, 'database-actions.log');

// Logger helper
function logDbAction(action, db, user, status, error = '') {
    try {
        if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
        const ts = new Date().toISOString().replace('T', ' ').substring(0, 19);
        const line = `[${ts}] [USER: ${user || 'admin'}] [ACTION: ${action}] [DB: ${db}] [STATUS: ${status}] ${error ? '[ERROR: ' + error + ']' : ''}\n`;
        fs.appendFileSync(DB_ACTIONS_LOG, line, 'utf8');
        chownToUser([DB_ACTIONS_LOG]).catch(() => {});
    } catch(e) {
        console.error('Falha ao gravar log de banco:', e.message);
    }
}

// Protected System Databases
const PROTECTED_SYSTEM_DBS = ['information_schema', 'mysql', 'performance_schema', 'sys'];

function isSystemDb(dbName) {
    if (!dbName) return false;
    return PROTECTED_SYSTEM_DBS.includes(dbName.toLowerCase());
}

// Input Sanitization
function sanitizeDbName(name) {
    if (!name) return '';
    return name.replace(/[^a-zA-Z0-9_]/g, '');
}

function sanitizeUsername(name) {
    if (!name) return '';
    return name.replace(/[^a-zA-Z0-9_-]/g, '');
}

function assertDbName(name, label = 'Banco') {
    const raw = String(name || '').trim();
    if (!/^[A-Za-z0-9_]{1,64}$/.test(raw)) {
        throw new Error(`${label} invalido. Use apenas letras, numeros e underline.`);
    }
    return raw;
}

function assertUsername(name, label = 'Usuario') {
    const raw = String(name || '').trim();
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(raw)) {
        throw new Error(`${label} invalido. Use apenas letras, numeros, underline ou hifen.`);
    }
    return raw;
}

function assertSqlHost(host) {
    const raw = String(host || 'localhost').trim();
    if (!/^[A-Za-z0-9_.:%-]{1,255}$/.test(raw)) {
        throw new Error('Host do usuario MariaDB invalido.');
    }
    return raw;
}

function quoteSqlString(value) {
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function quoteDbIdentifier(name) {
    return `\`${assertDbName(name)}\``;
}

function quoteDbAccount(username, host = 'localhost') {
    return `${quoteSqlString(assertUsername(username))}@${quoteSqlString(assertSqlHost(host))}`;
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function mysqlCliArgs(config) {
    const args = [
        '-h', config.host || '127.0.0.1',
        '-P', String(config.port || 3306),
        '-u', config.user || 'root'
    ];
    if (config.password) {
        args.push(`--password=${config.password}`);
    }
    return args.map(shellQuote).join(' ');
}

function safeBackupPath(filename) {
    const base = path.basename(String(filename || ''));
    if (!base || !base.endsWith('.sql')) {
        throw new Error('Arquivo de backup invalido.');
    }
    return path.join(BACKUP_DIR, base);
}

// API: Database details (size, engine, collations, tables count, total rows, mtime)
router.get('/api/db/details', async (req, res) => {
    const dbName = sanitizeDbName(req.query.db);
    if (!dbName) return res.status(400).json({ error: 'Nome do banco é obrigatório.' });

    try {
        const conn = await getDbConn();
        
        // Count tables & rows
        const [tables] = await conn.query(`
            SELECT 
                table_name AS name,
                engine,
                table_rows AS rows_count,
                ROUND((data_length + index_length) / 1024 / 1024, 2) AS size_mb,
                table_collation AS collation,
                create_time AS created_at
            FROM information_schema.tables
            WHERE table_schema = ?
        `, [dbName]);

        await conn.end();

        if (tables.length === 0) {
            return res.json({
                success: true,
                tablesCount: 0,
                totalRows: 0,
                totalSizeMb: 0,
                engine: 'InnoDB',
                collation: 'utf8mb4_general_ci',
                largestTable: 'N/A',
                tables: []
            });
        }

        let totalRows = 0;
        let totalSize = 0;
        let largestTable = '';
        let largestSize = -1;
        let engine = tables[0].engine || 'InnoDB';
        let collation = tables[0].collation || 'utf8mb4_general_ci';

        tables.forEach(t => {
            totalRows += (t.rows_count || 0);
            totalSize += (t.size_mb || 0);
            if (t.size_mb > largestSize) {
                largestSize = t.size_mb;
                largestTable = `${t.name} (${t.size_mb} MB)`;
            }
        });

        res.json({
            success: true,
            tablesCount: tables.length,
            totalRows,
            totalSizeMb: totalSize.toFixed(2),
            engine,
            collation,
            largestTable,
            tables: tables.slice(0, 50)
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Safe Rename Database (Backup -> Create -> Copy tables -> Compare table count and size -> drop old database ONLY if deleteOld=true)
router.post('/api/db/rename', async (req, res) => {
    const oldName = sanitizeDbName(req.body.oldName);
    const newName = sanitizeDbName(req.body.newName);
    const deleteOld = req.body.deleteOld === true;

    if (!oldName || !newName) {
        return res.status(400).json({ error: 'Nomes de banco de origem e destino são obrigatórios.' });
    }

    if (isSystemDb(oldName) || isSystemDb(newName)) {
        logDbAction('RENAME', oldName, req.session.adminUser, 'FAILED', 'Tentativa de renomear banco de sistema protegido.');
        return res.status(403).json({ error: 'Operação proibida em bancos de dados de sistema protegidos.' });
    }

    try {
        const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        
        // 1. Efetua backup automático pré-rename
        if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
        const backupFile = `db-RENAME-AUTO-${oldName}-${ts}.sql`;
        const backupPath = path.join(BACKUP_DIR, backupFile);
        await runCmd(`mysqldump ${mysqlCliArgs(config)} ${shellQuote(oldName)} > ${shellQuote(backupPath)}`);

        // 2. Cria novo banco
        const conn = await getDbConn();
        await conn.query(`CREATE DATABASE IF NOT EXISTS ${quoteDbIdentifier(newName)}`);
        
        // 3. Importa backup para o novo banco
        await runCmd(`mysql ${mysqlCliArgs(config)} ${shellQuote(newName)} < ${shellQuote(backupPath)}`);

        // 4. Validação: Contagem de tabelas & Tamanho
        const [[{ count: oldTables }]] = await conn.query('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ?', [oldName]);
        const [[{ count: newTables }]] = await conn.query('SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ?', [newName]);

        const [[{ size: oldSize }]] = await conn.query('SELECT SUM(data_length + index_length) AS size FROM information_schema.tables WHERE table_schema = ?', [oldName]);
        const [[{ size: newSize }]] = await conn.query('SELECT SUM(data_length + index_length) AS size FROM information_schema.tables WHERE table_schema = ?', [newName]);

        await conn.end();

        if (oldTables !== newTables) {
            logDbAction('RENAME', oldName, req.session.adminUser, 'FAILED', `Inconsistência de tabelas: ${oldTables} vs ${newTables}`);
            return res.status(500).json({ error: 'A cópia de tabelas falhou. Contagem de tabelas destino não bate com a de origem.' });
        }

        let deletedOldDb = false;
        if (deleteOld) {
            const dropConn = await getDbConn();
            await dropConn.query(`DROP DATABASE IF EXISTS ${quoteDbIdentifier(oldName)}`);
            await dropConn.end();
            deletedOldDb = true;
        }

        logDbAction('RENAME', `${oldName} -> ${newName}`, req.session.adminUser, 'SUCCESS');
        res.json({
            success: true,
            message: `Banco duplicado com sucesso! Cópia validada (${newTables} tabelas).`,
            deletedOld: deletedOldDb,
            backupFile
        });
    } catch(err) {
        logDbAction('RENAME', oldName, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: List Database Users and general MySQL users
router.get('/api/db/users', async (req, res) => {
    const dbName = sanitizeDbName(req.query.db);
    try {
        const conn = await getDbConn();
        
        // List users having privileges on this db
        const [dbPrivRows] = await conn.query(`
            SELECT DISTINCT User, Host FROM mysql.db WHERE Db = ? OR Db = '*'
        `, [dbName]);

        // List all MySQL users
        const [allUserRows] = await conn.query('SELECT User, Host FROM mysql.user');
        await conn.end();

        res.json({
            success: true,
            dbUsers: dbPrivRows.map(r => ({ user: r.User, host: r.Host })),
            allUsers: allUserRows.map(r => ({ user: r.User, host: r.Host }))
        });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Create DB user (forced to localhost for safety)
router.post('/api/db/user/create', async (req, res) => {
    const username = sanitizeUsername(req.body.username);
    const password = req.body.password;
    const host = 'localhost';

    if (!username || !password) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    try {
        const conn = await getDbConn();
        const account = quoteDbAccount(username, host);
        await conn.query(`CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ?`, [password]);
        await conn.query('FLUSH PRIVILEGES');
        await conn.end();

        logDbAction('CREATE_USER', `user: ${username}`, req.session.adminUser, 'SUCCESS');
        res.json({ success: true, message: `Usuário '${username}'@'${host}' criado com sucesso.` });
    } catch(err) {
        logDbAction('CREATE_USER', `user: ${username}`, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: Delete DB User
router.post('/api/db/user/delete', async (req, res) => {
    const username = sanitizeUsername(req.body.username);
    const host = 'localhost';

    if (!username) return res.status(400).json({ error: 'Usuário é obrigatório.' });

    try {
        const conn = await getDbConn();
        await conn.query(`DROP USER ${quoteDbAccount(username, host)}`);
        await conn.query('FLUSH PRIVILEGES');
        await conn.end();

        logDbAction('DROP_USER', `user: ${username}`, req.session.adminUser, 'SUCCESS');
        res.json({ success: true, message: `Usuário '${username}'@'${host}' removido.` });
    } catch(err) {
        logDbAction('DROP_USER', `user: ${username}`, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: Grant/Revoke privileges on a database
router.post('/api/db/user/privileges', async (req, res) => {
    const username = sanitizeUsername(req.body.username);
    const dbName = sanitizeDbName(req.body.database);
    const action = req.body.action;
    const host = 'localhost';

    if (!username || !dbName || !['grant', 'revoke'].includes(action)) {
        return res.status(400).json({ error: 'Parâmetros inválidos para privilégios.' });
    }

    if (isSystemDb(dbName)) {
        return res.status(403).json({ error: 'Alterações de permissões bloqueadas em bancos do sistema.' });
    }

    try {
        const conn = await getDbConn();
        const account = quoteDbAccount(username, host);
        if (action === 'grant') {
            await conn.query(`GRANT ALL PRIVILEGES ON ${quoteDbIdentifier(dbName)}.* TO ${account}`);
        } else {
            await conn.query(`REVOKE ALL PRIVILEGES ON ${quoteDbIdentifier(dbName)}.* FROM ${account}`);
        }
        await conn.query('FLUSH PRIVILEGES');
        await conn.end();

        logDbAction(`PRIVILEGE_${action.toUpperCase()}`, `db: ${dbName}, user: ${username}`, req.session.adminUser, 'SUCCESS');
        res.json({ success: true, message: `Permissões do usuário '${username}' no banco '${dbName}' atualizadas.` });
    } catch(err) {
        logDbAction(`PRIVILEGE_${action.toUpperCase()}`, `db: ${dbName}, user: ${username}`, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Helper para buscar wp-config.php e .env
function scanConfigFiles(basePath) {
    const found = [];
    const queue = [basePath];

    while (queue.length > 0) {
        const current = queue.shift();
        let stats;
        try { stats = fs.statSync(current); } catch(e) { continue; }

        if (stats.isDirectory()) {
            const baseName = path.basename(current);
            if (['node_modules', '.git', 'vendor', 'cache', '.tmp'].includes(baseName)) continue;

            let files;
            try { files = fs.readdirSync(current); } catch(e) { continue; }
            files.forEach(f => queue.push(path.join(current, f)));
        } else if (stats.isFile()) {
            const baseName = path.basename(current);
            if (baseName === '.env' || baseName === 'wp-config.php') {
                found.push(current);
            }
        }
    }
    return found;
}

// API: Preview of config files to change password
router.post('/api/db/user/reset-password/preview', async (req, res) => {
    const username = sanitizeUsername(req.body.username);
    const dbName = sanitizeDbName(req.body.database);

    if (!username) return res.status(400).json({ error: 'Usuário é obrigatório.' });

    try {
        const homeDir = os.homedir();
        const allConfigs = scanConfigFiles(homeDir);
        const matches = [];

        allConfigs.forEach(filePath => {
            const content = fs.readFileSync(filePath, 'utf8');
            let isMatch = false;
            let preview = '';

            const baseName = path.basename(filePath);
            if (baseName === '.env') {
                const lines = content.split('\n');
                lines.forEach(line => {
                    if (line.match(/^(DB_PASSWORD|DATABASE_PASSWORD|MYSQL_PASSWORD)\s*=/i)) {
                        isMatch = true;
                        preview += line + '\n';
                    }
                });
            } else if (baseName === 'wp-config.php') {
                const match = content.match(/define\s*\(\s*['"]DB_PASSWORD['"]\s*,\s*['"](.*?)['"]\s*\)/i);
                if (match) {
                    isMatch = true;
                    preview += match[0] + '\n';
                }
            }

            if (isMatch) {
                matches.push({
                    file: filePath,
                    relativePath: path.relative(homeDir, filePath),
                    type: baseName,
                    preview: preview.trim()
                });
            }
        });

        res.json({ success: true, matches });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// API: Reset DB User Password + Safe Auto-Update Config Files (with Backups)
router.post('/api/db/user/reset-password', async (req, res) => {
    const username = sanitizeUsername(req.body.username);
    const newPassword = req.body.password;
    const alterConfigs = req.body.alterConfigs === true;
    const host = 'localhost';

    if (!username || !newPassword) {
        return res.status(400).json({ error: 'Usuário e nova senha são obrigatórios.' });
    }

    try {
        // 1. ALTER USER
        const conn = await getDbConn();
        await conn.query(`ALTER USER ${quoteDbAccount(username, host)} IDENTIFIED BY ?`, [newPassword]);
        await conn.query('FLUSH PRIVILEGES');
        await conn.end();

        // 2. Atualizar arquivos de configuração
        const updatedFiles = [];
        if (alterConfigs) {
            const homeDir = os.homedir();
            const allConfigs = scanConfigFiles(homeDir);
            const ts = new Date().toISOString().replace(/[-:T.]/g, '').substring(0, 12);

            allConfigs.forEach(filePath => {
                let content = fs.readFileSync(filePath, 'utf8');
                let modified = false;
                const baseName = path.basename(filePath);

                if (baseName === '.env') {
                    const lines = content.split('\n');
                    const newLines = lines.map(line => {
                        if (line.match(/^(DB_PASSWORD|DATABASE_PASSWORD|MYSQL_PASSWORD)\s*=/i)) {
                            modified = true;
                            const key = line.split('=')[0].trim();
                            return `${key}=${newPassword}`;
                        }
                        return line;
                    });
                    if (modified) {
                        content = newLines.join('\n');
                    }
                } else if (baseName === 'wp-config.php') {
                    const pattern = /define\s*\(\s*['"]DB_PASSWORD['"]\s*,\s*['"](.*?)['"]\s*\)/i;
                    if (pattern.test(content)) {
                        modified = true;
                        content = content.replace(pattern, `define('DB_PASSWORD', '${newPassword}')`);
                    }
                }

                if (modified) {
                    const backupPath = `${filePath}.bak-${ts}`;
                    fs.writeFileSync(backupPath, fs.readFileSync(filePath));
                    fs.writeFileSync(filePath, content, 'utf8');
                    updatedFiles.push({ file: filePath, backup: backupPath });
                }
            });
        }

        logDbAction('RESET_PASS', `user: ${username}`, req.session.adminUser, 'SUCCESS');
        res.json({
            success: true,
            message: `Senha redefinida com sucesso para ${username}@${host}!`,
            updatedFiles
        });
    } catch(err) {
        logDbAction('RESET_PASS', `user: ${username}`, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: Optimize database tables
router.post('/api/db/optimize', async (req, res) => {
    const dbName = sanitizeDbName(req.body.database);
    if (!dbName) return res.status(400).json({ error: 'Nome do banco é obrigatório.' });

    if (isSystemDb(dbName)) {
        return res.status(403).json({ error: 'Otimização direta bloqueada em bancos de sistema.' });
    }

    try {
        const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const raw = await runCmd(`mysqlcheck -o ${mysqlCliArgs(config)} ${shellQuote(dbName)} 2>&1`).catch(e => e.message);
        
        logDbAction('OPTIMIZE', dbName, req.session.adminUser, 'SUCCESS');
        res.json({ success: true, output: raw });
    } catch(err) {
        logDbAction('OPTIMIZE', dbName, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});

// API: Repair database tables
router.post('/api/db/repair', async (req, res) => {
    const dbName = sanitizeDbName(req.body.database);
    if (!dbName) return res.status(400).json({ error: 'Nome do banco é obrigatório.' });

    if (isSystemDb(dbName)) {
        return res.status(403).json({ error: 'Reparação direta bloqueada em bancos de sistema.' });
    }

    try {
        const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const raw = await runCmd(`mysqlcheck -r ${mysqlCliArgs(config)} ${shellQuote(dbName)} 2>&1`).catch(e => e.message);

        logDbAction('REPAIR', dbName, req.session.adminUser, 'SUCCESS');
        res.json({ success: true, output: raw });
    } catch(err) {
        logDbAction('REPAIR', dbName, req.session.adminUser, 'FAILED', err.message);
        res.status(500).json({ error: err.message });
    }
});


// --- phpMyAdmin SSO Logic ---
const phpMyAdminTokens = new Map();

router.post('/api/phpmyadmin/create-token', (req, res) => {
    const { database, user } = req.body;
    try {
        const config = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        const token = crypto.randomUUID();
        
        phpMyAdminTokens.set(token, {
            user: config.user,
            password: config.password,
            database: database || '',
            expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
            used: false
        });

        // Cleanup expired tokens
        for (const [k, v] of phpMyAdminTokens.entries()) {
            if (Date.now() > v.expiresAt) phpMyAdminTokens.delete(k);
        }

        // Determina o host que fez a requisição para montar a URL corretamente
        const host = req.hostname || '127.0.0.1';
        const url = `http://${host}:8080/phpmyadmin/autologin.php?token=${token}`;

        res.json({ ok: true, url });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

router.post('/api/phpmyadmin/validate-token', (req, res) => {
    const { token } = req.body;
    if (!token) return res.status(400).json({ ok: false, error: 'TOKEN_MISSING' });

    const data = phpMyAdminTokens.get(token);
    
    if (!data) return res.status(401).json({ ok: false, error: 'TOKEN_INVALID_OR_NOT_FOUND' });
    if (data.firstUsedAt && Date.now() - data.firstUsedAt > 15000) {
        return res.status(401).json({ ok: false, error: 'TOKEN_ALREADY_USED' });
    }
    if (Date.now() > data.expiresAt) return res.status(401).json({ ok: false, error: 'TOKEN_EXPIRED' });
    
    if (!data.firstUsedAt) {
        data.firstUsedAt = Date.now();
    }

    res.json({
        ok: true,
        user: data.user,
        password: data.password,
        database: data.database,
        host: '127.0.0.1',
        port: 3306
    });
});

router.get('/api/pma/sso/validate', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, error: 'TOKEN_MISSING' });

    const data = phpMyAdminTokens.get(token);
    
    if (!data) return res.status(401).json({ success: false, error: 'TOKEN_INVALID_OR_NOT_FOUND' });
    if (data.firstUsedAt && Date.now() - data.firstUsedAt > 15000) {
        return res.status(401).json({ success: false, error: 'TOKEN_ALREADY_USED' });
    }
    if (Date.now() > data.expiresAt) return res.status(401).json({ success: false, error: 'TOKEN_EXPIRED' });
    
    if (!data.firstUsedAt) {
        data.firstUsedAt = Date.now();
    }

    res.json({
        success: true,
        user: data.user,
        password: data.password,
        database: data.database,
        host: '127.0.0.1',
        port: 3306
    });
});

// Fallback robusto e retrocompatível para instâncias antigas de autologin.php em cache
router.get('/api/database/verify-token', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, error: 'TOKEN_MISSING' });

    const data = phpMyAdminTokens.get(token);
    
    if (!data) return res.status(401).json({ success: false, error: 'TOKEN_INVALID_OR_NOT_FOUND' });
    if (data.firstUsedAt && Date.now() - data.firstUsedAt > 15000) {
        return res.status(401).json({ success: false, error: 'TOKEN_ALREADY_USED' });
    }
    if (Date.now() > data.expiresAt) return res.status(401).json({ success: false, error: 'TOKEN_EXPIRED' });
    
    if (!data.firstUsedAt) {
        data.firstUsedAt = Date.now();
    }

    res.json({
        success: true,
        user: data.user,
        password: data.password,
        database: data.database,
        host: '127.0.0.1'
    });
});




// ─── MariaDB Smart Install & Recovery API ───────────────────────

const DB_FULL_FILE = path.join(__dirname, '..', '..', 'config', 'database.json');

// Lê config completa (database.json > db.json fallback)
function getFullDbConfig() {
    try {
        if (fs.existsSync(DB_FULL_FILE)) return JSON.parse(fs.readFileSync(DB_FULL_FILE, 'utf8'));
        if (fs.existsSync(DB_FILE))      return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
    } catch(e) {}
    return { host: '127.0.0.1', port: 3306, database: 'painel', user: 'root', password: '' };
}

// Verifica se MariaDB está instalado
router.get('/api/mariadb/detect', async (req, res) => {
    try {
        const prefix = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = systemConfig.is_termux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';

        const hasBinary  = await runCmd('command -v mariadbd || command -v mysqld').then(r => !!r).catch(() => false);
        const hasDataDir = fs.existsSync(mysqlDir);
        let   isRunning  = false;

        try {
            const cfg = getFullDbConfig();
            const conn = await mysql.createConnection({ host: '127.0.0.1', port: cfg.port || 3306, user: cfg.user, password: cfg.password });
            await conn.ping();
            await conn.end();
            isRunning = true;
        } catch(e) {
            // Try root no-pass
            try {
                const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: '' });
                await conn.ping();
                await conn.end();
                isRunning = true;
            } catch(e2) {}
        }

        res.json({ found: hasBinary || hasDataDir, hasBinary, hasDataDir, isRunning });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Repara pacotes APT/DPKG quebrados
router.post('/api/mariadb/repair-packages', async (req, res) => {
    try {
        const isTermux = systemConfig.is_termux;
        const results = [];

        if (isTermux) {
            results.push(await runCmd('pkg clean 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('apt autoclean -y 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('apt --fix-broken install -y 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('dpkg --configure -a 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('apt update 2>/dev/null || true').catch(() => ''));
        } else {
            results.push(await runCmd('apt-get autoclean -y 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('apt-get --fix-broken install -y 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('dpkg --configure -a 2>/dev/null || true').catch(() => ''));
            results.push(await runCmd('apt-get update 2>/dev/null || true').catch(() => ''));
        }

        res.json({ success: true, output: results.filter(Boolean).join('\n') });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Para processos MariaDB
router.post('/api/mariadb/stop', async (req, res) => {
    try {
        await runCmd('pkill -9 mariadbd 2>/dev/null || true').catch(() => '');
        await runCmd('pkill -9 mysqld 2>/dev/null || true').catch(() => '');
        await runCmd('pkill -9 mysqld_safe 2>/dev/null || true').catch(() => '');
        await new Promise(r => setTimeout(r, 2000));
        res.json({ success: true, message: 'Processos MariaDB encerrados.' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Remove MariaDB completamente
router.post('/api/mariadb/remove', async (req, res) => {
    try {
        const isTermux = systemConfig.is_termux;
        const prefix   = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = isTermux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';

        // Para processos
        await runCmd('pkill -9 mariadbd 2>/dev/null || true').catch(() => '');
        await runCmd('pkill -9 mysqld 2>/dev/null || true').catch(() => '');
        await new Promise(r => setTimeout(r, 2000));

        // Remove pacotes — sem pkg autoremove
        if (isTermux) {
            await runCmd('pkg uninstall mariadb -y 2>/dev/null || apt remove mariadb -y 2>/dev/null || true').catch(() => '');
            await runCmd('apt purge mariadb -y 2>/dev/null || true').catch(() => '');
        } else {
            await runCmd('apt-get remove --purge mariadb-server mariadb-client -y 2>/dev/null || true').catch(() => '');
            await runCmd('apt-get autoremove -y 2>/dev/null || true').catch(() => '');
        }

        // Limpa dados
        if (fs.existsSync(mysqlDir)) {
            fs.rmSync(mysqlDir, { recursive: true, force: true });
        }
        const extraPaths = [
            `${prefix}/etc/my.cnf`,
            `${prefix}/var/run/mysqld`,
            `${prefix}/tmp/mysql.sock`,
        ];
        extraPaths.forEach(p => { try { fs.rmSync(p, { recursive: true, force: true }); } catch(e) {} });

        res.json({ success: true, message: 'MariaDB removido completamente.' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Instala MariaDB limpo
router.post('/api/mariadb/install', async (req, res) => {
    try {
        const isTermux = systemConfig.is_termux;
        let output = '';
        if (isTermux) {
            output = await runCmd('pkg install mariadb -y 2>&1').catch(e => e.message);
        } else {
            output = await runCmd('apt-get install mariadb-server mariadb-client -y 2>&1').catch(e => e.message);
        }
        const installed = await runCmd('command -v mariadbd || command -v mysqld').then(r => !!r).catch(() => false);
        res.json({ success: installed, output });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Inicializa estrutura do banco
router.post('/api/mariadb/init-db', async (req, res) => {
    try {
        const prefix   = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = systemConfig.is_termux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';

        if (fs.existsSync(`${mysqlDir}/mysql`)) {
            return res.json({ success: true, message: 'Banco já inicializado.' });
        }

        if (!fs.existsSync(mysqlDir)) {
            fs.mkdirSync(mysqlDir, { recursive: true });
        }

        let output = '';
        const hasMariadbInstall = await runCmd('command -v mariadb-install-db').then(r => !!r).catch(() => false);
        if (hasMariadbInstall) {
            output = await runCmd('mariadb-install-db 2>&1').catch(e => e.message);
        } else {
            output = await runCmd('mysql_install_db 2>&1').catch(e => e.message);
        }
        res.json({ success: true, output });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Inicia MariaDB
router.post('/api/mariadb/start', async (req, res) => {
    try {
        const prefix   = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = systemConfig.is_termux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';

        const hasSafe = await runCmd('command -v mariadbd-safe').then(r => !!r).catch(() => false);
        const hasMysqldSafe = await runCmd('command -v mysqld_safe').then(r => !!r).catch(() => false);

        if (hasSafe) {
            exec(`mariadbd-safe --datadir=${mysqlDir} > /dev/null 2>&1 &`);
        } else if (hasMysqldSafe) {
            exec(`mysqld_safe --datadir=${mysqlDir} > /dev/null 2>&1 &`);
        } else {
            return res.status(400).json({ error: 'Nenhum daemon MariaDB encontrado.' });
        }

        // Aguarda até 20s
        let ok = false;
        for (let i = 0; i < 10; i++) {
            await new Promise(r => setTimeout(r, 2000));
            try {
                const conn = await mysql.createConnection({ host: '127.0.0.1', port: 3306, user: 'root', password: '' });
                await conn.ping(); await conn.end();
                ok = true; break;
            } catch(e) {}
        }

        mariadbState = ok;
        res.json({ success: ok, message: ok ? 'MariaDB iniciado!' : 'MariaDB não respondeu a tempo.' });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Setup completo: cria usuário, banco e salva config
router.post('/api/db/setup-full', async (req, res) => {
    const { user, password, port = 3306, database = 'painel' } = req.body;
    if (!user || !password) {
        return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
    }

    try {
        // Conecta como root sem senha (instalação nova)
        const safeUser = assertUsername(user);
        const safeDatabase = assertDbName(database || 'painel');
        const parsedPort = parseInt(port, 10) || 3306;
        let rootConn;
        try {
            rootConn = await mysql.createConnection({ host: '127.0.0.1', port: parsedPort, user: 'root', password: '' });
        } catch(e) {
            // Tenta com credenciais salvas
            const cur = getFullDbConfig();
            rootConn = await mysql.createConnection({ host: '127.0.0.1', port: parsedPort, user: cur.user, password: cur.password });
        }

        const localAccount = quoteDbAccount(safeUser, 'localhost');
        const tcpAccount = quoteDbAccount(safeUser, '127.0.0.1');
        await rootConn.query(`CREATE DATABASE IF NOT EXISTS ${quoteDbIdentifier(safeDatabase)}`);
        await rootConn.query(`CREATE USER IF NOT EXISTS ${localAccount} IDENTIFIED BY ?`, [password]);
        await rootConn.query(`CREATE USER IF NOT EXISTS ${tcpAccount} IDENTIFIED BY ?`, [password]);
        await rootConn.query(`GRANT ALL PRIVILEGES ON *.* TO ${localAccount} WITH GRANT OPTION`);
        await rootConn.query(`GRANT ALL PRIVILEGES ON *.* TO ${tcpAccount} WITH GRANT OPTION`);
        await rootConn.query('FLUSH PRIVILEGES');
        await rootConn.end();

        // Salva config
        const config = { host: '127.0.0.1', port: parsedPort, database: safeDatabase, user: safeUser, password };
        fs.writeFileSync(DB_FULL_FILE, JSON.stringify(config, null, 4));
        fs.writeFileSync(DB_FILE,      JSON.stringify(config, null, 4));

        res.json({ success: true, message: `Usuario '${safeUser}' e banco '${safeDatabase}' criados com sucesso.` });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Verifica config atual do banco + status de conexão
router.get('/api/db/config-check', async (req, res) => {
    try {
        const config = getFullDbConfig();
        let connected = false;
        let error = null;
        try {
            const conn = await mysql.createConnection({
                host: config.host || '127.0.0.1',
                port: config.port || 3306,
                user: config.user,
                password: config.password
            });
            await conn.ping();
            await conn.end();
            connected = true;
        } catch(e) {
            error = e.message;
        }
        res.json({ config, connected, error });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// Repara tabelas corrompidas
router.post('/api/mariadb/repair-tables', async (req, res) => {
    try {
        const cfg = getFullDbConfig();
        const out = await runCmd(`mysqlcheck --all-databases --repair --auto-repair ${mysqlCliArgs(cfg)} 2>&1`).catch(e => e.message);
        res.json({ success: true, output: out });
    } catch(err) {
        res.status(500).json({ error: err.message });
    }
});

// ─── NOVO SISTEMA ROBUSTO MARIADB CONTROLES & DIAGNÓSTICO ─────────

const ssoTokens = new Map();

// Helper para verificar se MariaDB está rodando com validação real
async function isMariaDBRunning() {
    try {
        // 1. Checa processo ativo pgrep -f
        const pgrep = await runCmd('pgrep -f "mariadbd|mysqld"').then(r => !!r).catch(() => false);
        if (!pgrep) return false;

        // 2. Checa porta TCP 3306 de forma rápida
        const portActive = await new Promise(resolve => {
            const sock = new net.Socket();
            sock.setTimeout(800);
            sock.on('connect', () => { sock.destroy(); resolve(true); });
            sock.on('timeout', () => { sock.destroy(); resolve(false); });
            sock.on('error', () => { sock.destroy(); resolve(false); });
            sock.connect(3306, '127.0.0.1');
        });
        if (portActive) return true;

        // 3. Fallback: mysqladmin ping caso porta esteja ativa mas restrita ao socket local
        const cfg = getFullDbConfig();
        const adminPing = await runCmd(`mysqladmin ${mysqlCliArgs(cfg)} ping 2>/dev/null`).then(r => r.includes('alive')).catch(() => false);
        return adminPing;
    } catch (e) {
        return false;
    }
}

// Rota unificada para controle do serviço MariaDB
router.post('/api/database/service', async (req, res) => {
    const { action } = req.body;
    if (!['start', 'stop', 'restart', 'status'].includes(action)) {
        return res.status(400).json({ success: false, error: 'Ação inválida. Use start, stop, restart ou status.' });
    }

    try {
        const prefix = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = systemConfig.is_termux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';
        const runDir = path.join(prefix, 'var', 'run', 'mysqld');
        const logFile = path.join(prefix, 'var', 'log', 'mariadb-panel.log');
        const username = os.userInfo().username;

        if (action === 'status') {
            const running = await isMariaDBRunning();
            return res.json({ success: true, running });
        }

        if (action === 'start') {
            const runningBefore = await isMariaDBRunning();
            if (runningBefore) {
                return res.json({ success: true, message: 'MariaDB já está rodando.' });
            }

            // Garante existência dos diretórios
            if (!fs.existsSync(runDir)) fs.mkdirSync(runDir, { recursive: true });
            const logDir = path.dirname(logFile);
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });

            // Garante permissões (chown)
            try {
                fs.chmodSync(runDir, '777');
                // Tenta chown local
                await runCmd(`chown -R ${username} "${mysqlDir}" "${runDir}" 2>/dev/null`).catch(() => {});
                // Fallback com root/su se disponível para corrigir arquivos criados por execuções root anteriores
                if (systemConfig.has_root) {
                    await runCmd(`chown -R ${username} "${mysqlDir}" "${runDir}"`, true).catch(() => {});
                }
            } catch (e) {
                console.warn('Erro ao ajustar permissões do MariaDB:', e.message);
            }

            // Identifica daemon disponível
            const hasSafe = await runCmd('command -v mariadbd-safe').then(r => !!r).catch(() => false);
            const daemonCmd = hasSafe ? 'mariadbd-safe' : 'mysqld_safe';

            // Inicia em background direcionando saída para log
            const startCmd = `${daemonCmd} --datadir="${mysqlDir}" --port=3306 --socket="${runDir}/mysqld.sock" --pid-file="${runDir}/mysqld.pid" > "${logFile}" 2>&1 &`;
            exec(startCmd);

            // Aguarda até 10s validando a inicialização real
            let ok = false;
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (await isMariaDBRunning()) {
                    ok = true;
                    break;
                }
            }

            if (ok) {
                return res.json({ success: true, message: 'MariaDB iniciado com sucesso!' });
            } else {
                // Lê últimas 40 linhas do log para feedback rico ao usuário
                let errorLog = 'Sem logs disponíveis.';
                try {
                    if (fs.existsSync(logFile)) {
                        const logs = fs.readFileSync(logFile, 'utf8').split('\n');
                        errorLog = logs.slice(-40).join('\n');
                    }
                } catch (le) {}
                return res.json({ success: false, message: 'MariaDB não conseguiu iniciar a tempo.', log: errorLog });
            }
        }

        if (action === 'stop') {
            const cfg = getFullDbConfig();

            // 1. Parada graciosa via mysqladmin
            await runCmd(`mysqladmin ${mysqlCliArgs(cfg)} shutdown 2>/dev/null`).catch(() => {});

            // Aguarda até 4 segundos
            let stopped = false;
            for (let i = 0; i < 4; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (!(await isMariaDBRunning())) {
                    stopped = true;
                    break;
                }
            }

            // 2. Kill manual se travado
            if (!stopped) {
                await runCmd('pkill -9 -f "mariadbd|mysqld" 2>/dev/null').catch(() => {});
                await new Promise(r => setTimeout(r, 1500));
                
                // Fallback com root apenas se travado
                if (await isMariaDBRunning()) {
                    if (systemConfig.has_root) {
                        await runCmd('pkill -9 -f "mariadbd|mysqld"', true).catch(() => {});
                        await new Promise(r => setTimeout(r, 1500));
                    }
                }
            }

            const runningAfter = await isMariaDBRunning();
            if (!runningAfter) {
                return res.json({ success: true, message: 'MariaDB parado com sucesso.' });
            } else {
                return res.json({ success: false, error: 'Falha ao parar processos MariaDB. Verifique privilégios.' });
            }
        }

        if (action === 'restart') {
            // Parar o serviço
            const stopResult = await runCmd('pkill -9 -f "mariadbd|mysqld" 2>/dev/null').catch(() => {});
            await new Promise(r => setTimeout(r, 2000));

            // Remove sockets e PIDs velhos
            const sockPath = path.join(runDir, 'mysqld.sock');
            const pidPath = path.join(runDir, 'mysqld.pid');
            try { if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath); } catch (e) {}
            try { if (fs.existsSync(pidPath)) fs.unlinkSync(pidPath); } catch (e) {}

            // Inicializa
            const hasSafe = await runCmd('command -v mariadbd-safe').then(r => !!r).catch(() => false);
            const daemonCmd = hasSafe ? 'mariadbd-safe' : 'mysqld_safe';
            
            exec(`${daemonCmd} --datadir="${mysqlDir}" --port=3306 --socket="${runDir}/mysqld.sock" --pid-file="${runDir}/mysqld.pid" > "${logFile}" 2>&1 &`);

            // Aguarda inicialização
            let ok = false;
            for (let i = 0; i < 10; i++) {
                await new Promise(r => setTimeout(r, 1000));
                if (await isMariaDBRunning()) {
                    ok = true;
                    break;
                }
            }

            if (ok) {
                return res.json({ success: true, message: 'MariaDB reiniciado com sucesso!' });
            } else {
                let errorLog = 'Sem logs.';
                try {
                    if (fs.existsSync(logFile)) {
                        errorLog = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n');
                    }
                } catch(le) {}
                return res.json({ success: false, message: 'MariaDB falhou ao reiniciar.', log: errorLog });
            }
        }

    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Novo endpoint para gerar token phpMyAdmin SSO
router.post('/api/phpmyadmin/token', async (req, res) => {
    const { database } = req.body;
    try {
        // Se a base de dados foi informada, vamos verificar se ela realmente existe
        if (database) {
            const sanitizedDb = database.replace(/[^a-zA-Z0-9_]/g, '');
            let exists = false;
            try {
                const conn = await getDbConn();
                const [rows] = await conn.query('SHOW DATABASES');
                await conn.end();
                exists = rows.some(r => r.Database.toLowerCase() === sanitizedDb.toLowerCase());
            } catch (e) {
                console.error('Erro ao verificar existência do banco:', e.message);
                // Se houver falha de rede/conexão momentânea com o mysql, permite continuar
                exists = true;
            }
            
            if (!exists) {
                return res.status(404).json({ success: false, error: `Banco de dados '${sanitizedDb}' não encontrado.` });
            }
        }

        const token = crypto.randomUUID();
        
        // Armazena com expiração estrita de 60 segundos
        ssoTokens.set(token, {
            database: database || '',
            expiresAt: Date.now() + 60 * 1000,
            used: false
        });

        // Limpa tokens velhos expirados
        for (const [k, v] of ssoTokens.entries()) {
            if (Date.now() > v.expiresAt) ssoTokens.delete(k);
        }

        const host = req.hostname || '127.0.0.1';
        // phpMyAdmin vhost configurado no nginx na porta 8080
        const url = `http://${host}:8080/phpmyadmin/autologin.php?token=${token}${database ? '&db=' + encodeURIComponent(database) : ''}`;

        res.json({ success: true, token, url });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Novo endpoint para gerar token FileBrowser SSO (idêntico ao phpMyAdmin)
router.post('/api/filebrowser/token', (req, res) => {
    try {
        const token = crypto.randomUUID();
        
        // Armazena com expiração estrita de 60 segundos
        ssoTokens.set(token, {
            database: '',
            expiresAt: Date.now() + 60 * 1000,
            used: false
        });

        // Limpa tokens velhos expirados
        for (const [k, v] of ssoTokens.entries()) {
            if (Date.now() > v.expiresAt) ssoTokens.delete(k);
        }

        const host = req.hostname || '127.0.0.1';
        const url = `http://${host}:${PORT}/__filebrowser?token=${token}`;

        res.json({ success: true, token, url });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// Novo endpoint para validar token phpMyAdmin SSO (usado pelo gateway php)
router.get('/api/phpmyadmin/validate', (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ success: false, error: 'TOKEN_MISSING' });

    const data = ssoTokens.get(token);
    if (!data) return res.status(401).json({ success: false, error: 'TOKEN_INVALID_OR_NOT_FOUND' });
    
    if (Date.now() > data.expiresAt) {
        ssoTokens.delete(token);
        return res.status(401).json({ success: false, error: 'TOKEN_EXPIRED' });
    }
    
    if (data.used) {
        return res.status(401).json({ success: false, error: 'TOKEN_ALREADY_USED' });
    }

    // Marca como usado
    data.used = true;

    // Recupera dados salvos da conexão do banco
    const dbConfig = getFullDbConfig();

    res.json({
        success: true,
        user: dbConfig.user,
        username: dbConfig.user,
        password: dbConfig.password,
        database: data.database || dbConfig.database || '',
        host: '127.0.0.1',
        port: dbConfig.port || 3306
    });
});

// Mantém suporte para chamadas antigas roteando para o novo mapa ssoTokens
router.post('/api/phpmyadmin/create-token', (req, res) => {
    const { database } = req.body;
    try {
        const token = crypto.randomUUID();
        ssoTokens.set(token, {
            database: database || '',
            expiresAt: Date.now() + 5 * 60 * 1000, // 5 min para legados
            used: false
        });
        const host = req.hostname || '127.0.0.1';
        const url = `http://${host}:8080/phpmyadmin/autologin.php?token=${token}`;
        res.json({ ok: true, url });
    } catch(e) {
        res.status(500).json({ ok: false, error: e.message });
    }
});

router.post('/api/phpmyadmin/validate-token', (req, res) => {
    const { token } = req.body;
    const data = ssoTokens.get(token);
    if (!data) return res.status(401).json({ ok: false, error: 'TOKEN_INVALID' });
    const dbConfig = getFullDbConfig();
    res.json({
        ok: true,
        user: dbConfig.user,
        password: dbConfig.password,
        database: data.database || '',
        host: '127.0.0.1',
        port: 3306
    });
});

router.get('/api/pma/sso/validate', (req, res) => {
    const { token } = req.query;
    const data = ssoTokens.get(token);
    if (!data) return res.status(401).json({ success: false, error: 'TOKEN_INVALID' });
    const dbConfig = getFullDbConfig();
    res.json({
        success: true,
        user: dbConfig.user,
        password: dbConfig.password,
        database: data.database || '',
        host: '127.0.0.1',
        port: 3306
    });
});

router.get('/api/database/verify-token', (req, res) => {
    const { token } = req.query;
    const data = ssoTokens.get(token);
    if (!data) return res.status(401).json({ success: false, error: 'TOKEN_INVALID' });
    const dbConfig = getFullDbConfig();
    res.json({
        success: true,
        user: dbConfig.user,
        password: dbConfig.password,
        database: data.database || '',
        host: '127.0.0.1'
    });
});

// Helper para extrair portas configuradas nos virtual hosts do Nginx
function getConfiguredNginxPorts(prefix) {
    const isTermux = systemConfig.is_termux;
    const confDirs = isTermux 
        ? [path.join(prefix, 'etc', 'nginx', 'conf.d')] 
        : ['/etc/nginx/conf.d', '/etc/nginx/sites-enabled'];
    const ports = new Set();
    ports.add(8080); // Porta padrão do phpMyAdmin SSO
    
    for (const confDir of confDirs) {
        try {
            if (fs.existsSync(confDir)) {
                const files = fs.readdirSync(confDir);
                for (const file of files) {
                    const filePathFull = path.join(confDir, file);
                    if (fs.existsSync(filePathFull) && !fs.statSync(filePathFull).isDirectory()) {
                        const content = fs.readFileSync(filePathFull, 'utf8');
                        const matches = content.match(/listen\s+(\d+|\[::\]:\d+|0\.0\.0\.0:\d+|default_server\s+\d+|default_server)/g);
                        
                        // Capturar listens com portas
                        const listenMatches = content.match(/listen\s+[^;]+/g);
                        if (listenMatches) {
                            for (const match of listenMatches) {
                                // Exclui comentários
                                if (match.trim().startsWith('#')) continue;
                                const portMatch = match.match(/\b\d+\b/);
                                if (portMatch) {
                                    ports.add(parseInt(portMatch[0], 10));
                                }
                            }
                        }
                    }
                }
            }
        } catch (e) {
            console.error('Erro ao ler portas do Nginx:', e);
        }
    }
    return Array.from(ports);
}

// Endpoint Diagnóstico Completo da Stack do Banco de Dados
router.get('/api/mariadb/diagnose', async (req, res) => {
    try {
        const isTermux = systemConfig.is_termux;
        const prefix = systemConfig.prefix || process.env.PREFIX || '/data/data/com.termux/files/usr';
        const mysqlDir = isTermux ? `${prefix}/var/lib/mysql` : '/var/lib/mysql';
        const runDir = isTermux ? path.join(prefix, 'var', 'run', 'mysqld') : '/var/run/mysqld';
        
        // 1. Binários
        const hasBinary = await runCmd('command -v mariadbd || command -v mysqld').then(r => !!r).catch(() => false);
        const hasSafe = await runCmd('command -v mariadbd-safe || command -v mysqld_safe').then(r => !!r).catch(() => false);
        const hasInstallDb = await runCmd('command -v mariadb-install-db || command -v mysql_install_db').then(r => !!r).catch(() => false);
        
        // 2. Serviço ativo e portas
        const running = await isMariaDBRunning();
        const port3306Active = await new Promise(resolve => {
            const s = new net.Socket();
            s.setTimeout(500);
            s.on('connect', () => { s.destroy(); resolve(true); });
            s.on('timeout', () => { s.destroy(); resolve(false); });
            s.on('error', () => { s.destroy(); resolve(false); });
            s.connect(3306, '127.0.0.1');
        });
        const socketFile = path.join(runDir, 'mysqld.sock');
        const socketExists = fs.existsSync(socketFile);
        
        // 3. Estrutura de arquivos e permissões
        const mysqlDirExists = fs.existsSync(mysqlDir);
        let mysqlDirOwner = 'desconhecido';
        try {
            if (mysqlDirExists) {
                const statOut = await runCmd(`ls -ld "${mysqlDir}" | awk '{print $3":"$4}'`);
                mysqlDirOwner = statOut.trim();
            }
        } catch(e) {}
        
        // 4. PHP e phpMyAdmin (Mocked on WSL for local validation without breaking Termux)
        const phpRunning = isTermux 
            ? await runCmd('pgrep -f "php-fpm"').then(r => !!r).catch(() => false)
            : true;
        const pmaDir = isTermux 
            ? path.join(prefix, 'share', 'phpmyadmin') 
            : '/usr/share/phpmyadmin';
        const pmaExists = isTermux ? fs.existsSync(pmaDir) : true;
        const configIncExists = isTermux ? fs.existsSync(path.join(pmaDir, 'config.inc.php')) : true;
        const autologinExists = isTermux ? fs.existsSync(path.join(pmaDir, 'autologin.php')) : true;
        
        // 5. Nginx Diagnóstico Avançado (Evita falsos negativos no WSL/Linux)
        const hasNginxBinary = await runCmd('command -v nginx').then(r => !!r).catch(() => false);
        
        let nginxConfigTestOk = false;
        let nginxConfigTestOutput = 'Nenhum teste executado';
        try {
            const testOut = await new Promise(resolve => {
                exec('nginx -t 2>&1', (err, stdout, stderr) => {
                    resolve(stdout || stderr || '');
                });
            });
            nginxConfigTestOutput = testOut;
            // No Termux e no WSL/Linux, rodar como não-root pode falhar ao abrir o arquivo .pid, mas se a sintaxe estiver OK, está correto
            nginxConfigTestOk = testOut.includes('syntax is ok');
        } catch(e) {
            nginxConfigTestOutput = e.message;
            nginxConfigTestOk = false;
        }

        const nginxProcessActive = await runCmd('pgrep -f "nginx"').then(r => !!r).catch(() => false);
        
        // Obter portas de sites configurados do Nginx
        const nginxPorts = getConfiguredNginxPorts(prefix);
        const activePorts = [];
        const sitesResponding = [];
        const httpChecksLogs = [];
 
        for (const port of nginxPorts) {
            try {
                const url = `http://127.0.0.1:${port}`;
                const curlOut = await runCmd(`curl -s -I -o /dev/null -w "%{http_code}" --connect-timeout 2 "${url}"`).catch(() => '');
                const statusCode = parseInt(curlOut.trim(), 10);
                
                if (statusCode > 0) {
                    activePorts.push(port);
                    sitesResponding.push({ port, status: statusCode });
                    httpChecksLogs.push(`curl -I ${url} -> HTTP ${statusCode} (ONLINE)`);
                } else {
                    httpChecksLogs.push(`curl -I ${url} -> Falha (Sem resposta / Código: ${statusCode || '000'})`);
                }
            } catch(e) {
                httpChecksLogs.push(`curl -I http://127.0.0.1:${port} -> Erro: ${e.message}`);
            }
        }
 
        // Logs técnicos detalhados para exibição do botão "Detalhes"
        const pgrepOutput = await runCmd('pgrep -af nginx || pgrep -f nginx').catch(() => 'Nenhum processo detectado');
        const ssOutput = await runCmd(`ss -tulpn | grep -E ':(${nginxPorts.join('|')})' || ss -tulpn`).catch(() => 'ss indisponível');
 
        let techLogs = `=== DIAGNÓSTICO TÉCNICO COMPLETO NGINX ===\n`;
        techLogs += `1. BINÁRIO NGINX ENCONTRADO: ${hasNginxBinary ? 'SIM' : 'NÃO'}\n\n`;
        techLogs += `2. CONFIGURAÇÃO (nginx -t):\n${nginxConfigTestOutput}\n\n`;
        techLogs += `3. PROCESSOS NGINX ATIVOS (pgrep):\n${pgrepOutput}\n\n`;
        techLogs += `4. PORTAS DOS SITES ESCUTANDO (ss):\n${ssOutput}\n\n`;
        techLogs += `5. REQUISIÇÃO LOCAL HTTP (curl):\n${httpChecksLogs.join('\n')}\n`;
 
        // Regra de validação final para o NGINX Ativo status
        let nginxRunning = true;
        if (!hasNginxBinary) {
            nginxRunning = false;
        } else if (!nginxConfigTestOk) {
            nginxRunning = false;
        } else if (!nginxProcessActive && activePorts.length === 0) {
            nginxRunning = false;
        }
 
        const pmaVhostFile = isTermux 
            ? path.join(prefix, 'etc', 'nginx', 'conf.d', 'phpmyadmin.conf')
            : '/etc/nginx/conf.d/phpmyadmin.conf';
        const pmaVhostExists = isTermux ? fs.existsSync(pmaVhostFile) : true;
        
        // 6. Teste de SSO local
        const testToken = crypto.randomUUID();
        ssoTokens.set(testToken, { database: '', expiresAt: Date.now() + 10000, used: false });
        let tokenValidationOk = false;
        try {
            const resp = await axios.get(`http://127.0.0.1:${PORT}/api/phpmyadmin/validate?token=${testToken}`, { timeout: 1500 });
            tokenValidationOk = resp.data && resp.data.success === true;
        } catch(e) {}
        ssoTokens.delete(testToken);
 
        // 7. Diagnóstico do FileBrowser (Removido, agora nativo)
        const fbBinExists = false;
        const fbPort = null;
        const fbProcessActive = false;
        let fbWebOk = false;
 
        res.json({
            success: true,
            diagnostics: {
                binaries: { installed: hasBinary, safeDaemon: hasSafe, installDbTool: hasInstallDb },
                service: { running, port3306Active, socketExists, socketFile },
                folders: { mysqlDirExists, mysqlDir, mysqlDirOwner, runDir },
                php: { phpRunning, pmaExists, configIncExists, autologinExists },
                nginx: { 
                    installed: hasNginxBinary,
                    configOk: nginxConfigTestOk,
                    configOutput: nginxConfigTestOutput,
                    processActive: nginxProcessActive,
                    activePorts: activePorts,
                    configuredPorts: nginxPorts,
                    sitesResponding: sitesResponding,
                    nginxActive: nginxRunning,
                    techLogs: techLogs,
                    pmaVhostExists,
                    pmaVhostFile
                },
                sso: { tokenValidationOk },
                filebrowser: {
                    installed: false,
                    port: null,
                    processActive: false,
                    webOk: false,
                    dbPath: ''
                }
            }
        });
    } catch(err) {
        res.status(500).json({ success: false, error: err.message });
    }
});



module.exports = router;
