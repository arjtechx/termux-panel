const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');

const PORT = 3030;
const PROJECT_DIR = __dirname;

let pendingPublishParams = null;

// Helper para enviar respostas JSON
const sendJSON = (res, statusCode, data) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(data));
};

// Servidor de Recursos Estáticos e Endpoints da API
const server = http.createServer((req, res) => {
    // CORS headers para segurança local
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');

    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    // Router
    const parsedUrl = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = parsedUrl.pathname;

    // 1. Rota Principal: Frontend do Painel
    if (pathname === '/' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getHTMLContent());
        return;
    }

    // 2. GET /api/status: Retorna versão atual e status do Git
    if (pathname === '/api/status' && req.method === 'GET') {
        try {
            const pjsonPath = path.join(PROJECT_DIR, 'package.json');
            if (!fs.existsSync(pjsonPath)) {
                return sendJSON(res, 404, { error: 'package.json não encontrado.' });
            }
            const pjson = JSON.parse(fs.readFileSync(pjsonPath, 'utf8'));
            const currentVersion = pjson.version || '0.0.0';

            // Verifica status do Git
            exec('git status --short', { cwd: PROJECT_DIR }, (gitErr, stdout) => {
                const changes = (stdout || '').trim().split('\n').filter(Boolean);
                sendJSON(res, 200, {
                    success: true,
                    currentVersion,
                    pendingChangesCount: changes.length,
                    changesList: changes
                });
            });
        } catch (err) {
            sendJSON(res, 500, { error: err.message });
        }
        return;
    }

    // 3. POST /api/publish: Salva os parâmetros para a publicação
    if (pathname === '/api/publish' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                pendingPublishParams = JSON.parse(body);
                sendJSON(res, 200, { success: true });
            } catch (err) {
                sendJSON(res, 400, { error: 'Parâmetros JSON inválidos.' });
            }
        });
        return;
    }

    // 4. GET /api/publish: Conecta EventSource/SSE para fazer a publicação e transmitir logs
    if (pathname === '/api/publish' && req.method === 'GET') {
        if (!pendingPublishParams) {
            res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Nenhuma publicação pendente iniciada.');
            return;
        }
        startPublishing(res, pendingPublishParams);
        pendingPublishParams = null; // Reseta após consumir
        return;
    }

    // Rota 404
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
});

// Inicializa o Servidor
server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n======================================================`);
    console.log(`🚀 painel desktop iniciado em http://localhost:${PORT}`);
    console.log(`======================================================\n`);
    
    // Abre automaticamente o Chrome em App Mode
    exec(`start chrome --app="http://localhost:${PORT}"`, (err) => {
        if (err) {
            // Fallback se falhar
            exec(`start http://localhost:${PORT}`);
        }
    });
});

// ============================================================
//  NÚCLEO DO PROCESSO DE PUBLICAÇÃO VIA SSE (LOGS EM TEMPO REAL)
// ============================================================
function startPublishing(res, params) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no' // Desabilita buffering em proxies locais
    });

    const sendLog = (message, type = 'info') => {
        res.write(`data: ${JSON.stringify({ text: message, type })}\n\n`);
    };

    try {
        const pjsonPath = path.join(PROJECT_DIR, 'package.json');
        if (!fs.existsSync(pjsonPath)) {
            sendLog('[ERRO] package.json não encontrado!', 'error');
            res.end();
            return;
        }

        const pjson = JSON.parse(fs.readFileSync(pjsonPath, 'utf8'));
        const currentVersion = pjson.version || '0.0.1';

        // 1. Calcula a Nova Versão
        let newVersion = currentVersion;
        if (params.versionType === 'patch') {
            newVersion = currentVersion.replace(/(\d+)$/, m => parseInt(m) + 1);
        } else if (params.versionType === 'minor') {
            newVersion = currentVersion.replace(/(\d+)\.\d+$/, m => (parseInt(m) + 1) + '.0');
        } else if (params.versionType === 'major') {
            const parts = currentVersion.split('.');
            newVersion = (parseInt(parts[0]) + 1) + '.0.0';
        } else if (params.versionType === 'custom') {
            newVersion = (params.customVersion || '').trim().replace(/^v/, '');
        }

        if (!/^\d+\.\d+\.\d+$/.test(newVersion)) {
            sendLog(`[ERRO] Versão '${newVersion}' com formato inválido!`, 'error');
            res.end();
            return;
        }

        sendLog(`🚀 Iniciando processo de release: v${currentVersion} -> v${newVersion}`, 'success');

        // 2. Modifica arquivos locais
        sendLog(`[*] Atualizando package.json para versão v${newVersion}...`, 'info');
        pjson.version = newVersion;
        fs.writeFileSync(pjsonPath, JSON.stringify(pjson, null, 2), 'utf8');

        const indexHtmlPath = path.join(PROJECT_DIR, 'public', 'index.html');
        if (fs.existsSync(indexHtmlPath)) {
            sendLog(`[*] Atualizando cache-buster em index.html...`, 'info');
            let html = fs.readFileSync(indexHtmlPath, 'utf8');
            html = html.replace(/filemanager\.js\?v=[\d\.\-]+/g, `filemanager.js?v=${newVersion}`);
            fs.writeFileSync(indexHtmlPath, html, 'utf8');
        }

        // 3. Executa comandos do PowerShell sequencialmente
        const steps = [];

        // Contingência de tar local
        if (params.localBackup) {
            steps.push({
                desc: 'Gerando pacote local termux-panel-dist.tar.gz...',
                cmd: `tar.exe -czvf termux-panel-dist.tar.gz --exclude=node_modules --exclude=config --exclude=backups --exclude=.git --exclude=*.tar.gz *`
            });
        }

        // Git workflow
        steps.push({
            desc: 'Adicionando arquivos modificados ao Git...',
            cmd: 'git add -A'
        });

        const commitMsg = `release: v${newVersion} - ${params.releaseNotes || 'Update'}`;
        steps.push({
            desc: 'Commitando alterações...',
            cmd: `git commit -m "${commitMsg.replace(/"/g, '\\"')}"`
        });

        steps.push({
            desc: 'Atualizando branch remota (git pull --rebase)...',
            cmd: 'git pull origin master --rebase'
        });

        steps.push({
            desc: 'Enviando alterações para o repositório GitHub...',
            cmd: 'git push origin master'
        });

        // Tagging
        steps.push({
            desc: `Deletando tag v${newVersion} se já existir...`,
            cmd: `git tag -d v${newVersion}; git push origin :refs/tags/v${newVersion}`
        });

        steps.push({
            desc: `Criando tag Git oficial v${newVersion}...`,
            cmd: `git tag -a v${newVersion} -m "${(params.releaseNotes || 'Release').replace(/"/g, '\\"')}"`
        });

        steps.push({
            desc: `Enviando tag v${newVersion} para o GitHub...`,
            cmd: `git push origin v${newVersion}`
        });

        runSequentially(steps, 0, sendLog, () => {
            sendLog(`🎉 Release v${newVersion} publicada com 100% de sucesso!`, 'success');
            sendLog(`[OK] O GitHub Actions está construindo a sua release agora.`, 'success');
            sendLog(`[DICA] Em 1-2 minutos, clique em Atualizar no painel do Termux!`, 'info');
            res.write(`data: ${JSON.stringify({ done: true, version: newVersion })}\n\n`);
            res.end();
        }, () => {
            sendLog(`❌ Processo interrompido por falha em alguma etapa.`, 'error');
            res.end();
        });

    } catch (err) {
        sendLog(`[ERRO GERAL] ${err.message}`, 'error');
        res.end();
    }
}

// Executador de Fila de Processos em PowerShell
function runSequentially(steps, index, sendLog, onDone, onError) {
    if (index >= steps.length) {
        onDone();
        return;
    }

    const step = steps[index];
    sendLog(`\n🔹 [${index + 1}/${steps.length}] ${step.desc}`, 'step');

    // Executa em powershell para compatibilidade total com Windows
    const proc = spawn('powershell', ['-Command', step.cmd], { cwd: PROJECT_DIR });

    proc.stdout.on('data', chunk => {
        const text = chunk.toString().trim();
        if (text) sendLog(text, 'output');
    });

    proc.stderr.on('data', chunk => {
        const text = chunk.toString().trim();
        if (text) sendLog(`[WARN/INFO] ${text}`, 'output'); // Algumas ferramentas mostram avisos inofensivos no stderr
    });

    proc.on('close', code => {
        // Ignora erros de exclusão de tags inexistentes para evitar interrupções bobas
        if (code === 0 || step.cmd.includes('refs/tags')) {
            runSequentially(steps, index + 1, sendLog, onDone, onError);
        } else {
            sendLog(`❌ Etapa falhou com código de saída ${code}`, 'error');
            onError();
        }
    });
}

// ============================================================
//  CONTEÚDO RENDERIZADO NO FRONTEND (DESIGN PREMIUM E INCRÍVEL)
// ============================================================
function getHTMLContent() {
    return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Termux Panel Desktop Manager</title>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&family=Fira+Code:wght@400;600&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-color: #0f0c1b;
            --surface-color: rgba(30, 25, 55, 0.45);
            --border-color: rgba(255, 255, 255, 0.08);
            --primary: #8a2be2;
            --primary-glow: rgba(138, 43, 226, 0.4);
            --accent: #00ffcc;
            --accent-glow: rgba(0, 255, 204, 0.3);
            --text-color: #f1ecff;
            --text-muted: #a69ebd;
            --error: #ff4a5a;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
        }

        body {
            font-family: 'Outfit', sans-serif;
            background: radial-gradient(circle at 50% 0%, #1d163a 0%, var-bg-color) 100%, var(--bg-color);
            background-color: var(--bg-color);
            color: var(--text-color);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 24px;
            overflow-x: hidden;
        }

        /* Glassmorphism Card Container */
        .app-container {
            width: 100%;
            max-width: 900px;
            background: var(--surface-color);
            border: 1px solid var(--border-color);
            border-radius: 24px;
            box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.1);
            backdrop-filter: blur(20px);
            padding: 40px;
            display: flex;
            flex-direction: column;
            gap: 32px;
            animation: fadeIn 0.6s cubic-bezier(0.16, 1, 0.3, 1) both;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid rgba(255, 255, 255, 0.05);
            padding-bottom: 24px;
        }

        .logo-wrapper {
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .logo-title {
            font-size: 28px;
            font-weight: 800;
            letter-spacing: -0.5px;
            background: linear-gradient(135deg, #fff 30%, #a272ff 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .logo-subtitle {
            font-size: 13px;
            color: var(--text-muted);
            font-weight: 400;
            text-transform: uppercase;
            letter-spacing: 1.5px;
        }

        .version-badge {
            background: rgba(138, 43, 226, 0.15);
            border: 1px solid var(--primary);
            box-shadow: 0 0 15px var(--primary-glow);
            padding: 8px 16px;
            border-radius: 50px;
            font-weight: 600;
            color: #d1b3ff;
            font-size: 15px;
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .version-badge::before {
            content: '';
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background-color: var(--accent);
            box-shadow: 0 0 8px var(--accent);
            display: inline-block;
        }

        /* Config Grid */
        .config-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 32px;
        }

        @media (max-width: 768px) {
            .config-grid {
                grid-template-columns: 1fr;
            }
        }

        .form-section {
            display: flex;
            flex-direction: column;
            gap: 20px;
        }

        .section-title {
            font-size: 16px;
            font-weight: 600;
            color: var(--text-muted);
            text-transform: uppercase;
            letter-spacing: 1px;
            margin-bottom: 8px;
        }

        /* Grid de Opções de Versão */
        .version-options {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 12px;
        }

        .card-opt {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 14px;
            padding: 16px;
            cursor: pointer;
            transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
            display: flex;
            flex-direction: column;
            gap: 4px;
        }

        .card-opt:hover {
            background: rgba(255, 255, 255, 0.05);
            border-color: rgba(255, 255, 255, 0.15);
            transform: translateY(-2px);
        }

        .card-opt.selected {
            background: rgba(138, 43, 226, 0.08);
            border-color: var(--primary);
            box-shadow: 0 8px 20px rgba(138, 43, 226, 0.15);
        }

        .card-opt-title {
            font-size: 14px;
            font-weight: 600;
            color: var(--text-muted);
        }

        .card-opt.selected .card-opt-title {
            color: #d1b3ff;
        }

        .card-opt-version {
            font-size: 18px;
            font-weight: 800;
            color: #fff;
        }

        .custom-input-wrapper {
            grid-column: span 2;
            display: none;
            flex-direction: column;
            gap: 8px;
            animation: slideDown 0.3s ease;
        }

        @keyframes slideDown {
            from { opacity: 0; transform: translateY(-10px); }
            to { opacity: 1; transform: translateY(0); }
        }

        label {
            font-size: 13px;
            color: var(--text-muted);
            font-weight: 600;
        }

        input[type="text"], textarea {
            width: 100%;
            background: rgba(0, 0, 0, 0.25);
            border: 1px solid rgba(255, 255, 255, 0.08);
            border-radius: 12px;
            color: #fff;
            padding: 12px 16px;
            font-family: inherit;
            font-size: 15px;
            transition: all 0.3s;
        }

        input[type="text"]:focus, textarea:focus {
            outline: none;
            border-color: var(--primary);
            box-shadow: 0 0 10px rgba(138, 43, 226, 0.2);
        }

        textarea {
            resize: none;
            height: 110px;
        }

        /* Checkbox Contingencia */
        .contingency-wrapper {
            display: flex;
            align-items: center;
            gap: 12px;
            background: rgba(0, 0, 0, 0.15);
            border: 1px solid var(--border-color);
            padding: 16px;
            border-radius: 14px;
            cursor: pointer;
            user-select: none;
            transition: 0.3s;
        }

        .contingency-wrapper:hover {
            border-color: rgba(255, 255, 255, 0.15);
            background: rgba(255, 255, 255, 0.02);
        }

        .checkbox-custom {
            width: 20px;
            height: 20px;
            border: 2px solid rgba(255, 255, 255, 0.3);
            border-radius: 6px;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: 0.2s;
        }

        .contingency-wrapper.checked .checkbox-custom {
            border-color: var(--accent);
            background-color: var(--accent);
            box-shadow: 0 0 10px var(--accent-glow);
        }

        .checkbox-custom::after {
            content: '✓';
            color: #000;
            font-size: 13px;
            font-weight: bold;
            display: none;
        }

        .contingency-wrapper.checked .checkbox-custom::after {
            display: block;
        }

        .contingency-text-wrapper {
            display: flex;
            flex-direction: column;
            gap: 2px;
        }

        .contingency-title {
            font-size: 14px;
            font-weight: 600;
        }

        .contingency-desc {
            font-size: 12px;
            color: var(--text-muted);
        }

        /* Terminal Logs Visuals */
        .terminal-section {
            display: flex;
            flex-direction: column;
            gap: 12px;
        }

        .terminal-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
        }

        .terminal-badge {
            background-color: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.08);
            font-size: 12px;
            padding: 4px 12px;
            border-radius: 50px;
            color: var(--text-muted);
            text-transform: uppercase;
            font-weight: 600;
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .terminal-badge::before {
            content: '';
            width: 6px;
            height: 6px;
            border-radius: 50%;
            background-color: var(--text-muted);
            display: inline-block;
        }

        .terminal-badge.running::before {
            background-color: var(--accent);
            box-shadow: 0 0 6px var(--accent);
            animation: pulse 1.2s infinite;
        }

        @keyframes pulse {
            0% { transform: scale(1); opacity: 1; }
            50% { transform: scale(1.3); opacity: 0.4; }
            100% { transform: scale(1); opacity: 1; }
        }

        .terminal-body {
            background: #06040d;
            border: 1px solid rgba(255, 255, 255, 0.05);
            border-radius: 16px;
            height: 250px;
            padding: 20px;
            overflow-y: auto;
            font-family: 'Fira Code', monospace;
            font-size: 13.5px;
            line-height: 1.6;
            color: #d8cfff;
            display: flex;
            flex-direction: column;
            gap: 6px;
            box-shadow: inset 0 10px 30px rgba(0,0,0,0.8);
        }

        /* Log Line Types Styling */
        .log-line.info { color: #bcaeff; }
        .log-line.success { color: var(--accent); font-weight: 600; text-shadow: 0 0 8px rgba(0,255,204,0.15); }
        .log-line.error { color: var(--error); font-weight: 600; }
        .log-line.step { color: #d1b3ff; font-weight: 600; margin-top: 8px; border-bottom: 1px dashed rgba(255,255,255,0.05); padding-bottom: 4px; }
        .log-line.output { color: #8c83a8; padding-left: 12px; }

        /* Glowing Publish Button */
        .btn-publish {
            background: linear-gradient(135deg, var(--primary) 0%, #bd93f9 100%);
            border: none;
            color: #fff;
            padding: 16px 32px;
            border-radius: 14px;
            font-size: 16px;
            font-weight: 800;
            cursor: pointer;
            box-shadow: 0 10px 20px rgba(138, 43, 226, 0.25), 0 0 30px rgba(138, 43, 226, 0.15);
            transition: all 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            display: flex;
            justify-content: center;
            align-items: center;
            gap: 10px;
        }

        .btn-publish:hover {
            transform: translateY(-2px);
            box-shadow: 0 12px 25px rgba(138, 43, 226, 0.4), 0 0 40px rgba(138, 43, 226, 0.25);
        }

        .btn-publish:active {
            transform: translateY(1px);
        }

        .btn-publish:disabled {
            background: rgba(255, 255, 255, 0.05) !important;
            color: var(--text-muted) !important;
            cursor: not-allowed;
            box-shadow: none !important;
            transform: none !important;
        }

        /* Scrollbar styling */
        ::-webkit-scrollbar {
            width: 8px;
            height: 8px;
        }
        ::-webkit-scrollbar-track {
            background: transparent;
        }
        ::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 10px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.2);
        }
    </style>
</head>
<body>

<div class="app-container">
    <header>
        <div class="logo-wrapper">
            <span class="logo-title">Termux Panel</span>
            <span class="logo-subtitle">Desktop Manager</span>
        </div>
        <div class="version-badge">
            Ativa: <span id="current-version">Carregando...</span>
        </div>
    </header>

    <div class="config-grid">
        <!-- Lado Esquerdo: Versão e Contingência -->
        <div class="form-section">
            <h3 class="section-title">1. Configurar Nova Versão</h3>
            
            <div class="version-options">
                <div class="card-opt selected" onclick="selectVersionType('patch', this)">
                    <span class="card-opt-title">Patch Release</span>
                    <span class="card-opt-version" id="val-patch">v0.0.0</span>
                </div>
                <div class="card-opt" onclick="selectVersionType('minor', this)">
                    <span class="card-opt-title">Minor Release</span>
                    <span class="card-opt-version" id="val-minor">v0.0.0</span>
                </div>
                <div class="card-opt" onclick="selectVersionType('major', this)">
                    <span class="card-opt-title">Major Release</span>
                    <span class="card-opt-version" id="val-major">v0.0.0</span>
                </div>
                <div class="card-opt" onclick="selectVersionType('custom', this)">
                    <span class="card-opt-title">Customizada</span>
                    <span class="card-opt-version">Manual</span>
                </div>

                <div class="custom-input-wrapper" id="custom-version-wrapper">
                    <label for="custom-version-input">Digite a versão personalizada (ex: 0.3.5)</label>
                    <input type="text" id="custom-version-input" placeholder="X.Y.Z">
                </div>
            </div>

            <div class="contingency-wrapper checked" onclick="toggleContingency(this)">
                <div class="checkbox-custom"></div>
                <div class="contingency-text-wrapper">
                    <span class="contingency-title">Gerar pacote offline (.tar.gz)</span>
                    <span class="contingency-desc">Cria uma build física preventiva no seu computador local.</span>
                </div>
            </div>
        </div>

        <!-- Lado Direito: Notas de Lançamento e Ação -->
        <div class="form-section" style="justify-content: space-between;">
            <div>
                <h3 class="section-title">2. Notas de Release</h3>
                <textarea id="release-notes" placeholder="Descreva de forma curta o que mudou nesta versão... (ex: adicionado botão descompactar no gerenciador de arquivos e correções OOM)"></textarea>
            </div>

            <button class="btn-publish" id="publish-btn" onclick="publishRelease()">
                🚀 Publicar Nova Release
            </button>
        </div>
    </div>

    <!-- Seção de Logs do Terminal -->
    <div class="terminal-section">
        <div class="terminal-header">
            <h3 class="section-title">Monitor de Log do Console</h3>
            <div class="terminal-badge" id="terminal-status">Inativo</div>
        </div>
        <div class="terminal-body" id="terminal-body">
            <span class="log-line info">Aguardando início de deploy...</span>
        </div>
    </div>
</div>

<script>
    let activeVersion = '0.0.0';
    let selectedType = 'patch';
    let contingencyEnabled = true;

    // Carrega dados iniciais do servidor
    async function loadStatus() {
        try {
            const resp = await fetch('/api/status');
            const data = await resp.json();
            
            if (data.success) {
                activeVersion = data.currentVersion;
                document.getElementById('current-version').innerText = 'v' + activeVersion;
                
                // Calcula versões virtuais no grid
                const parts = activeVersion.split('.').map(Number);
                
                const patchVer = parts[0] + '.' + parts[1] + '.' + (parts[2] + 1);
                const minorVer = parts[0] + '.' + (parts[1] + 1) + '.0';
                const majorVer = (parts[0] + 1) + '.0.0';
                
                document.getElementById('val-patch').innerText = 'v' + patchVer;
                document.getElementById('val-minor').innerText = 'v' + minorVer;
                document.getElementById('val-major').innerText = 'v' + majorVer;
            }
        } catch (e) {
            console.error('Falha ao conectar à API local.', e);
        }
    }

    function selectVersionType(type, element) {
        selectedType = type;
        
        // Remove classes selected de todos os cards
        document.querySelectorAll('.card-opt').forEach(card => card.classList.remove('selected'));
        element.classList.add('selected');

        const customWrap = document.getElementById('custom-version-wrapper');
        if (type === 'custom') {
            customWrap.style.display = 'flex';
        } else {
            customWrap.style.display = 'none';
        }
    }

    function toggleContingency(element) {
        contingencyEnabled = !contingencyEnabled;
        if (contingencyEnabled) {
            element.classList.add('checked');
        } else {
            element.classList.remove('checked');
        }
    }

    function appendLog(text, type = 'info') {
        const terminal = document.getElementById('terminal-body');
        const span = document.createElement('span');
        span.className = 'log-line ' + type;
        span.innerText = text;
        terminal.appendChild(span);
        terminal.scrollTop = terminal.scrollHeight;
    }

    // Inicia processo de Deploy via SSE
    function publishRelease() {
        const btn = document.getElementById('publish-btn');
        const notes = document.getElementById('release-notes').value;
        const customVer = document.getElementById('custom-version-input').value;
        const statusBadge = document.getElementById('terminal-status');
        const terminal = document.getElementById('terminal-body');

        // Confirmação rápida
        if (!confirm('Deseja iniciar o bumping e deploy da nova versão? O processo é automatizado.')) {
            return;
        }

        // Limpa terminal
        terminal.innerHTML = '';
        btn.disabled = true;
        statusBadge.className = 'terminal-badge running';
        statusBadge.innerText = 'Processando';

        const payload = {
            versionType: selectedType,
            customVersion: customVer,
            releaseNotes: notes,
            localBackup: contingencyEnabled
        };

        // Dispara requisição POST
        fetch('/api/publish', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(response => {
            // Abre conexão SSE na mesma rota ou conecta via EventSource
            const source = new EventSource('/api/publish');
            
            source.onmessage = function(event) {
                const data = JSON.parse(event.data);
                
                if (data.done) {
                    source.close();
                    btn.disabled = false;
                    statusBadge.className = 'terminal-badge';
                    statusBadge.innerText = 'Concluído';
                    loadStatus(); // Atualiza versão ativa
                    return;
                }
                
                if (data.text) {
                    appendLog(data.text, data.type);
                }
            };

            source.onerror = function() {
                source.close();
                btn.disabled = false;
                statusBadge.className = 'terminal-badge';
                statusBadge.innerText = 'Erro';
                appendLog('❌ Conexão SSE encerrada devido a erro ou término precoce.', 'error');
            };
        }).catch(err => {
            btn.disabled = false;
            statusBadge.className = 'terminal-badge';
            statusBadge.innerText = 'Falha';
            appendLog('❌ Falha na conexão de inicialização da API.', 'error');
        });
    }

    // Inicialização
    loadStatus();
</script>
</body>
</html>`;
}
