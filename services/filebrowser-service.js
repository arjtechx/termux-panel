const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const axios = require('axios');
const os = require('os');
const net = require('net');

class FileBrowserService {
    constructor() {
        this.binDir = path.join(__dirname, '..', 'bin');
        this.dataDir = path.join(__dirname, '..', 'data', 'filebrowser');
        this.dbPath = path.join(this.dataDir, 'database.db');
        this.binPath = path.join(this.binDir, os.platform() === 'win32' ? 'filebrowser.exe' : 'filebrowser');
        this.port = 8095;
        this.process = null;
        this.defaultRoot = process.env.PREFIX ? '/data/data/com.termux/files/home' : '/';
        this.setupGracefulShutdown();
    }

    setupGracefulShutdown() {
        const killProcess = () => {
            if (this.process) {
                console.log('\n[INFO] Encerrando FileBrowser graciosamente...');
                try {
                    this.process.kill('SIGKILL');
                } catch(e) {}
                this.process = null;
            }
        };

        // Captura encerramentos do Node.js para não deixar zumbis
        process.on('exit', killProcess);
        process.on('SIGINT', () => { killProcess(); process.exit(); });
        process.on('SIGTERM', () => { killProcess(); process.exit(); });
        process.on('SIGHUP', () => { killProcess(); process.exit(); });
    }

    killZombies() {
        console.log('[INFO] Iniciando caçada a processos zumbis do FileBrowser...');
        try {
            if (os.platform() !== 'win32') {
                // Força o encerramento pela porta
                try { execSync('fuser -k -9 8095/tcp 2>/dev/null', { stdio: 'ignore' }); } catch(e) {}
                try { execSync('fuser -k -9 8096/tcp 2>/dev/null', { stdio: 'ignore' }); } catch(e) {}
                // Força o encerramento pelo nome
                try { execSync('pkill -9 -f filebrowser 2>/dev/null', { stdio: 'ignore' }); } catch(e) {}
                try { execSync('killall -9 filebrowser 2>/dev/null', { stdio: 'ignore' }); } catch(e) {}
            } else {
                try { execSync('taskkill /F /IM filebrowser.exe 2>nul', { stdio: 'ignore' }); } catch(e) {}
            }
        } catch (e) {
            // Ignora erros caso não haja processos para matar
        }
        console.log('[OK] Caçada terminada. Portas livres.');
    }

    wipeOldTraces() {
        const markerFile = path.join(this.dataDir, '.v0.0.5_clean_install');
        if (!fs.existsSync(markerFile)) {
            console.log('[WARN] Iniciando rotina de remoção rastreada (Limpeza profunda v0.0.5)...');
            try {
                if (fs.existsSync(this.dataDir)) {
                    const files = fs.readdirSync(this.dataDir);
                    for (const file of files) {
                        if (file.startsWith('database.db')) {
                            const p = path.join(this.dataDir, file);
                            fs.unlinkSync(p);
                            console.log(`[DELETED] ${p}`);
                        }
                    }
                } else {
                    fs.mkdirSync(this.dataDir, { recursive: true });
                }
                // Cria o marcador para nunca mais apagar o banco depois dessa versão
                fs.writeFileSync(markerFile, 'Instalação limpa e rastreada concluída.\n');
                console.log('[OK] Limpeza profunda finalizada com sucesso. Banco de dados obliterado.');
            } catch(e) {
                console.log('[ERR] Erro na limpeza profunda:', e.message);
            }
        }
    }

    async init() {
        console.log('[INFO] Iniciando módulo FileBrowserService...');
        
        if (!fs.existsSync(this.binDir)) fs.mkdirSync(this.binDir, { recursive: true });
        if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

        // Rotina cão de guarda e faxina
        this.killZombies();
        this.wipeOldTraces();

        if (!fs.existsSync(this.binPath)) {
            console.log('[INFO] Binário do FileBrowser não encontrado. Iniciando instalação automática...');
            await this.installBinary();
        }

        this.port = await this.findFreePort(8095);
        return this.startProcess();
    }

    async findFreePort(startPort) {
        let currentPort = startPort;
        while (currentPort < startPort + 10) {
            if (await this.isPortAvailable(currentPort)) {
                return currentPort;
            }
            currentPort++;
        }
        return startPort;
    }

    isPortAvailable(port) {
        return new Promise((resolve) => {
            const server = net.createServer();
            server.once('error', () => resolve(false));
            server.once('listening', () => {
                server.close();
                resolve(true);
            });
            server.listen(port, '127.0.0.1');
        });
    }

    getPlatformInfo() {
        let arch = os.arch();
        let platform = os.platform();

        if (arch === 'x64') arch = 'amd64';
        if (arch === 'arm64') arch = 'arm64';
        if (arch === 'arm') arch = 'armv7';

        if (platform === 'win32') platform = 'windows';
        if (platform === 'android') platform = 'linux';

        return { platform, arch };
    }

    async installBinary() {
        const { platform, arch } = this.getPlatformInfo();
        const ext = platform === 'windows' ? 'zip' : 'tar.gz';
        
        try {
            console.log(`[INFO] Buscando release para ${platform}-${arch}...`);
            const apiRes = await axios.get('https://api.github.com/repos/filebrowser/filebrowser/releases/latest');
            const release = apiRes.data;
            const assetName = `${platform}-${arch}-filebrowser.${ext}`;
            const asset = release.assets.find(a => a.name === assetName);

            if (!asset) throw new Error(`Asset ${assetName} não encontrado.`);

            const downloadUrl = asset.browser_download_url;
            console.log(`[INFO] Baixando: ${downloadUrl}`);
            
            const tmpFile = path.join(this.binDir, assetName);
            const writer = fs.createWriteStream(tmpFile);
            
            const response = await axios({ url: downloadUrl, method: 'GET', responseType: 'stream' });
            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            console.log('[INFO] Extraindo pacote...');
            if (ext === 'tar.gz') {
                execSync(`tar -xzf "${tmpFile}" -C "${this.binDir}" filebrowser`);
            } else {
                execSync(`powershell -command "Expand-Archive -Force '${tmpFile}' '${this.binDir}'"`);
            }

            fs.unlinkSync(tmpFile);
            if (platform !== 'windows') execSync(`chmod +x "${this.binPath}"`);
            console.log('[OK] FileBrowser instalado com sucesso.');
        } catch (error) {
            console.error('[ERR] Erro na instalação automática:', error.message);
        }
    }

    setupDatabaseOnce() {
        try {
            // Só configura o banco de dados se ele não existir
            if (!fs.existsSync(this.dbPath)) {
                console.log('[INFO] Construindo banco de dados (One-Time Setup)...');
                execSync(`"${this.binPath}" config init -d "${this.dbPath}"`);
                execSync(`"${this.binPath}" config set --auth.method noauth -d "${this.dbPath}"`);
                
                // Aplica o tema dark permanentemente na criação
                console.log('[INFO] Injetando tema padrão no banco...');
                execSync(`"${this.binPath}" config set --branding.theme dark --branding.name "Termux cPanel" --branding.files "" -d "${this.dbPath}"`);

                try {
                    execSync(`"${this.binPath}" users add admin painel_cpanel1234 --perm.admin -d "${this.dbPath}"`);
                } catch(e) {}
                console.log('[OK] Banco de dados inicializado com sucesso.');
            } else {
                console.log('[INFO] Banco de dados existente detectado. Pulando setup.');
            }
        } catch(e) {
            console.log('[WARN] Falha ao construir banco de dados:', e.message);
        }
    }

    startProcess() {
        // Garantir configuração antes do spawn (e nunca roda se o db já existe)
        this.setupDatabaseOnce();

        console.log(`[INFO] Starting FileBrowser (Process Guard Active)...`);
        const args = [
            '-a', '127.0.0.1', 
            '-p', this.port.toString(), 
            '-d', this.dbPath, 
            '-r', this.defaultRoot, 
            '-b', '/__filebrowser',
            '--noauth'
        ];

        this.process = spawn(this.binPath, args);

        this.process.on('error', (err) => {
            console.error('[ERR] Falha no processo do FileBrowser:', err.message);
        });

        this.process.stdout.on('data', (data) => {
            const lines = data.toString().trim().split('\n');
            lines.forEach(line => {
                if(line) console.log(`[FileBrowser] ${line}`);
            });
        });

        this.process.stderr.on('data', (data) => {
            const lines = data.toString().trim().split('\n');
            lines.forEach(line => {
                if(line) console.error(`[FileBrowser ERR] ${line}`);
            });
        });

        this.process.on('close', (code) => {
            if (code !== 0 && code !== null) {
                console.log(`[WARN] FileBrowser encerrou inesperadamente (código ${code}). Reiniciando em 3s...`);
                // Limpa zombies novamente antes de reiniciar para evitar porta presa
                this.killZombies();
                setTimeout(() => this.startProcess(), 3000);
            } else {
                console.log(`[INFO] FileBrowser encerrado normalmente.`);
            }
        });

        console.log(`[OK] FileBrowser running on port ${this.port}`);
        console.log(`[INFO] Embedded FileBrowser ready.`);
        
        return this.port;
    }

    getPort() {
        return this.port;
    }
}

module.exports = new FileBrowserService();
