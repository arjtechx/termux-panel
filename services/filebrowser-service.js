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
        
        const isTermux = !!process.env.PREFIX;
        this.binPath = isTermux 
            ? path.join(process.env.PREFIX, 'bin', 'filebrowser')
            : path.join(this.binDir, os.platform() === 'win32' ? 'filebrowser.exe' : 'filebrowser');
            
        this.port = 8095;
        this.process = null;
        this.defaultRoot = process.env.PREFIX ? '/data/data/com.termux/files/home' : os.homedir();
    }

    async init() {
        console.log('[INFO] Iniciando módulo FileBrowserService...');
        
        // Criar pastas necessárias
        if (!fs.existsSync(this.binDir)) fs.mkdirSync(this.binDir, { recursive: true });
        if (!fs.existsSync(this.dataDir)) fs.mkdirSync(this.dataDir, { recursive: true });

        // Instalar se não existir
        if (!fs.existsSync(this.binPath)) {
            console.log('[INFO] Binário do FileBrowser não encontrado. Iniciando instalação automática...');
            await this.installBinary();
        }

        // Buscar porta livre a partir da 8095
        this.port = await this.findFreePort(8095);
        
        // Iniciar serviço
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
        let platform = os.platform(); // 'linux', 'win32', 'darwin'

        // Mapear Node.js arch para FileBrowser arch
        if (arch === 'x64') arch = 'amd64';
        if (arch === 'arm64') arch = 'arm64';
        if (arch === 'arm') arch = 'armv7';

        // Mapear platform Node.js para platform FileBrowser
        if (platform === 'win32') platform = 'windows';

        return { platform, arch };
    }

    async installBinary() {
        const isTermux = !!process.env.PREFIX;
        if (isTermux) {
            console.log('[INFO] Ambiente Termux detectado. Instalando filebrowser nativo via pkg...');
            try {
                execSync('pkg install filebrowser -y');
                console.log('[OK] FileBrowser nativo instalado via pkg com sucesso.');
                return;
            } catch(e) {
                console.error('[ERR] Falha ao instalar filebrowser via pkg, tentando download alternativo:', e.message);
            }
        }

        const { platform, arch } = this.getPlatformInfo();
        const ext = platform === 'windows' ? 'zip' : 'tar.gz';
        
        try {
            // Buscando latest release da API
            console.log(`[INFO] Buscando release para ${platform}-${arch}...`);
            const apiRes = await axios.get('https://api.github.com/repos/filebrowser/filebrowser/releases/latest');
            const release = apiRes.data;
            
            // Exemplo de tag filebrowser: linux-arm64-filebrowser.tar.gz
            const assetName = `${platform}-${arch}-filebrowser.${ext}`;
            const asset = release.assets.find(a => a.name === assetName);

            if (!asset) {
                throw new Error(`Asset ${assetName} não encontrado na release mais recente.`);
            }

            const downloadUrl = asset.browser_download_url;
            console.log(`[INFO] Baixando: ${downloadUrl}`);
            
            const tmpFile = path.join(this.binDir, assetName);
            const writer = fs.createWriteStream(tmpFile);
            
            const response = await axios({
                url: downloadUrl,
                method: 'GET',
                responseType: 'stream'
            });

            response.data.pipe(writer);

            await new Promise((resolve, reject) => {
                writer.on('finish', resolve);
                writer.on('error', reject);
            });

            console.log('[INFO] Extraindo pacote...');
            if (ext === 'tar.gz') {
                execSync(`tar -xzf "${tmpFile}" -C "${this.binDir}" filebrowser`);
            } else {
                // Windows simplificado (usar powershell nativo)
                execSync(`powershell -command "Expand-Archive -Force '${tmpFile}' '${this.binDir}'"`);
            }

            fs.unlinkSync(tmpFile); // Limpar arquivo baixado

            if (platform !== 'windows') {
                execSync(`chmod +x "${this.binPath}"`);
            }
            
            console.log('[OK] FileBrowser instalado com sucesso.');
        } catch (error) {
            console.error('[ERR] Erro na instalação automática do FileBrowser:', error.message);
        }
    }

    startProcess() {
        if (this.process) {
            console.log('[INFO] Reiniciando processo antigo do FileBrowser...');
            this.process.kill();
        }

        // Garante inicialização do banco SQLite e aplicação de CSS antes do spawn (evita SQLite Database Locked)
        try {
            if (!fs.existsSync(this.dbPath)) {
                console.log('[INFO] Inicializando banco de dados SQLite do FileBrowser...');
                execSync(`"${this.binPath}" config init -d "${this.dbPath}"`);
            }
            this.applyTheme();
        } catch(e) {
            console.log('[WARN] Falha ao preparar banco de dados do FileBrowser:', e.message);
        }

        console.log(`[INFO] Starting FileBrowser...`);
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
            console.error('[ERR] Falha ao iniciar processo do FileBrowser (spawn error):', err.message);
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
            console.log(`[WARN] FileBrowser encerrou com código ${code}. Tentando reiniciar em 3s...`);
            setTimeout(() => this.startProcess(), 3000);
        });

        console.log(`[OK] FileBrowser running on port ${this.port}`);
        console.log(`[INFO] NGINX reverse proxy enabled (internally proxied)`);
        console.log(`[INFO] Embedded FileBrowser ready`);
        
        return this.port;
    }

    applyTheme() {
        // Envia as variáveis CSS do Termux cPanel para o banco de dados do FileBrowser
        const customCss = `
            :root {
                --primary: #89b4fa;
                --background: #11111b;
                --surface: #1e1e2e;
                --text: #cdd6f4;
            }
            body { font-family: 'Inter', sans-serif !important; background: var(--background) !important; color: var(--text) !important; }
            #app { background: var(--background) !important; }
            .card { background: var(--surface) !important; border: 1px solid rgba(255,255,255,0.05) !important; border-radius: 8px !important; }
            .button { border-radius: 6px !important; }
            header { background: var(--background) !important; border-bottom: 1px solid rgba(255,255,255,0.05) !important; }
            .action { color: var(--primary) !important; }
            /* Esconde a logo superior esquerda para não parecer software de terceiro */
            #app > header > div.logo { display: none !important; }
        `;
        try {
            // Criar o arquivo custom.css na pasta de branding
            const tmpCssPath = path.join(this.dataDir, 'custom.css');
            fs.writeFileSync(tmpCssPath, customCss);
            
            // FileBrowser v2 lê a pasta de branding e busca custom.css nela automaticamente!
            execSync(`"${this.binPath}" config set --branding.theme dark --branding.name "Termux cPanel" --branding.files "${this.dataDir}" -d "${this.dbPath}"`);
            console.log('[OK] FileBrowser theme integrado com sucesso.');
        } catch(e) {
            console.log('[WARN] Falha ao injetar CSS customizado:', e.message);
        }
    }

    getPort() {
        return this.port;
    }
}

module.exports = new FileBrowserService();
