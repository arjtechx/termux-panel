'use strict';
// ============================================================
//  TERMUX CPANEL — app.js v4.0
//  Boot Sequence + All Modules
// ============================================================

const API_BASE = '/api';
let socket = null;
let currentDir = '/';
let currentFiles = [];

// ============================================================
//  BOOT SEQUENCE
// ============================================================
function bootLog(msg) {
    const term = document.getElementById('boot-terminal');
    if (!term) return;
    const line = document.createElement('p');
    line.className = 'boot-line';
    line.textContent = '> ' + msg;
    term.appendChild(line);
    term.scrollTop = term.scrollHeight;
}

function bootProgress(pct, label) {
    const bar  = document.getElementById('boot-progress');
    const text = document.getElementById('boot-status-text');
    if (bar)  bar.style.width  = pct + '%';
    if (text) text.textContent = label;
}

function bootDone() {
    bootProgress(100, 'Pronto!');
    bootLog('Sistema estabilizado. Abrindo dashboard.');
    setTimeout(() => {
        const overlay = document.getElementById('boot-overlay');
        if (overlay) overlay.classList.add('fade-out');
        if (window.lucide) lucide.createIcons();
    }, 600);
}

async function runBootSequence() {
    bootProgress(5,  'Iniciando núcleo...');
    bootLog('Buscando configurações de tema...');
    initTheme();

    bootProgress(15, 'Inicializando interface...');
    bootLog('Mapeando elementos DOM...');
    initElements();
    initNavigation();
    initMobileNav();
    initSocket();

    bootProgress(35, 'Conectando ao servidor...');
    bootLog('Solicitando status do hardware...');
    try { await fetchStatus(); } catch(e) { bootLog('Aviso: status indisponível.'); }

    bootProgress(55, 'Carregando aplicações...');
    bootLog('Verificando serviços ativos...');
    try { await fetchApps(); } catch(e) { bootLog('Aviso: apps indisponíveis.'); }

    bootProgress(72, 'Analisando processos...');
    bootLog('Mapeando árvore de processos...');
    try { await fetchProcesses(); } catch(e) { bootLog('Aviso: processos indisponíveis.'); }

    bootProgress(88, 'Finalizando interface...');
    bootLog('Renderizando componentes visuais...');

    setTimeout(() => {
        bootDone();
        // Inicia polling após o boot
        setInterval(fetchStatus,    5000);
        setInterval(fetchApps,     15000);
        setInterval(fetchProcesses, 10000);
    }, 400);
}

// ============================================================
//  TEMA
// ============================================================
function initTheme() {
    const saved = localStorage.getItem('cpanel-theme') || 'light';
    document.body.setAttribute('data-theme', saved);
}

function toggleTheme() {
    const next = document.body.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    document.body.setAttribute('data-theme', next);
    localStorage.setItem('cpanel-theme', next);
}

// ============================================================
//  DOM REFS
// ============================================================
let el = {};
function initElements() {
    el = {
        cpu:        document.getElementById('stat-cpu'),
        cpuDetails: document.getElementById('stat-cpu-details'),
        ram:        document.getElementById('stat-ram'),
        temp:       document.getElementById('stat-temperature'),
        storage:    document.getElementById('stat-storage'),
        storageBar: document.getElementById('stat-storage-progress'),
        netSpeed:   document.getElementById('stat-net-speed'),
        appsGrid:   document.getElementById('appsGrid'),
        procTable:  document.getElementById('processesTableBody'),
        fileList:   document.getElementById('file-list'),
        breadcrumb: document.getElementById('file-breadcrumb'),
        tabs:       document.querySelectorAll('.tab-pane'),
        navLinks:   document.querySelectorAll('.nav-link, .mobile-nav-item'),
    };
}

// ============================================================
//  NAVEGAÇÃO
// ============================================================
function initNavigation() {
    document.querySelectorAll('[data-target]').forEach(link => {
        link.addEventListener('click', e => {
            e.preventDefault();
            const targetId = link.getAttribute('data-target');
            switchTab(targetId);
            // fecha sidebar no mobile
            const sidebar = document.getElementById('sidebar');
            const backdrop = document.getElementById('sidebar-backdrop');
            if (sidebar)  sidebar.classList.remove('open');
            if (backdrop) backdrop.classList.remove('show');
        });
    });
}

function switchTab(targetId) {
    // Esconde todas as tabs
    document.querySelectorAll('.tab-pane').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('[data-target]').forEach(l => l.classList.remove('active'));

    // Mostra a tab alvo
    const tab = document.getElementById(targetId);
    if (tab) tab.classList.add('active');

    // Marca links ativos
    document.querySelectorAll(`[data-target="${targetId}"]`).forEach(l => l.classList.add('active'));

    // Loaders específicos
    if (targetId === 'tab-dashboard') {
        fetchStatus();
        fetchApps();
        fetchProcesses();
    }
    if (targetId === 'tab-files')    loadFiles();
    if (targetId === 'tab-database') fetchDatabases();
    if (targetId === 'tab-hosting')   fetchHostingServices();
    if (targetId === 'tab-cron')     fetchCron();
    if (targetId === 'tab-noip')     fetchNoipStatus();
    if (targetId === 'tab-docs')     loadDocumentation();
    if (targetId === 'tab-health') {
        checkHealthStatus();
        checkSystemUpdates();
    }
    if (targetId === 'tab-settings') loadSettings();
}

function initMobileNav() {
    // já tratado pelo initNavigation via [data-target]
}

// ============================================================
//  SIDEBAR TOGGLE
// ============================================================
function toggleSidebar() {
    const sidebar  = document.getElementById('sidebar');
    const backdrop = document.getElementById('sidebar-backdrop');
    if (!sidebar) return;
    const isOpen = sidebar.classList.toggle('open');
    if (backdrop) backdrop.classList.toggle('show', isOpen);
}

// ============================================================
//  SOCKET.IO
// ============================================================
function initSocket() {
    try {
        socket = io();
        // Eventos do servidor — nomes corretos
        socket.on('noip-log',      data => appendNoipLog(data));
        socket.on('log-data',      line => appendLogLine(line));
        // Terminal SSH — recebe dados do shell remoto
        socket.on('terminal-data', data => {
            if (window._term) window._term.write(data);
        });
    } catch(e) {
        console.warn('Socket.io não disponível:', e);
    }
}

// ============================================================
//  TERMINAL SSH — usa xterm.js + socket 'terminal-connect'
// ============================================================
let _termInstance = null;

function connectTerminal() {
    // Lê campos do formulário SSH
    const host = document.getElementById('sshHost')?.value || '127.0.0.1';
    const port = parseInt(document.getElementById('sshPort')?.value) || 8022;
    const username = document.getElementById('sshUser')?.value;
    const password = document.getElementById('sshPass')?.value;

    if (!username || !password) {
        alert('Preencha usuário e senha SSH!');
        return;
    }

    const container = document.getElementById('terminal-container');
    if (!container) return;

    // Limpa terminal anterior
    container.innerHTML = '';
    if (_termInstance) { try { _termInstance.dispose(); } catch(e) {} }

    // Verifica se xterm.js está disponível
    if (!window.Terminal) {
        // Fallback: terminal simples sem xterm
        container.style.cssText = 'background:#000;color:#0f0;padding:16px;height:500px;overflow-y:auto;font-family:monospace;font-size:13px;';
        const write = (txt) => {
            container.textContent += txt;
            container.scrollTop = container.scrollHeight;
        };
        write(`Conectando a ${host}:${port}...\n`);
        socket.emit('terminal-connect', { host, port, username, password });
        socket.off('terminal-data');
        socket.on('terminal-data', data => {
            write(data);
            container.scrollTop = container.scrollHeight;
        });

        // Input simples via prompt
        container.setAttribute('tabindex', '0');
        container.addEventListener('keydown', function handler(e) {
            if (e.key === 'Enter') {
                const inputEl = document.getElementById('_termInput');
                if (!inputEl) return;
                const cmd = inputEl.value;
                socket.emit('terminal-input', cmd + '\n');
                inputEl.value = '';
            }
        });

        // Adiciona campo de input
        const inputRow = document.createElement('div');
        inputRow.style.cssText = 'display:flex;gap:8px;margin-top:10px;';
        inputRow.innerHTML = `
            <input id="_termInput" style="flex:1;background:#111;color:#0f0;border:1px solid #333;padding:6px;font-family:monospace;" placeholder="Digite um comando...">
            <button class="btn btn-sm btn-secondary" onclick="const v=document.getElementById('_termInput').value;socket.emit('terminal-input',v+'\\n');document.getElementById('_termInput').value=''">Enviar</button>
        `;
        container.parentNode.appendChild(inputRow);
        return;
    }

    // Terminal com xterm.js
    const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: "'Fira Code', 'Courier New', monospace",
        theme: { background: '#0d1117', foreground: '#c9d1d9', cursor: '#6366f1' },
        rows: 30,
    });

    _termInstance = term;
    window._term  = term;
    term.open(container);

    term.writeln(`\x1b[32mConectando a ${host}:${port}...\x1b[0m`);

    // Envia evento de conexão ao servidor
    socket.emit('terminal-connect', { host, port, username, password });

    // Envia teclas digitadas ao servidor
    term.onData(data => socket.emit('terminal-input', data));
}

// ============================================================
//  STATUS DO SISTEMA — alinhado com os campos reais da API
// ============================================================
async function fetchStatus() {
    const data = await safeFetch(`${API_BASE}/status`);
    if (!data) return;

    // O servidor retorna: cpu (string), cpuCores, cpuSpeed, ram (string),
    // storageFree, storageTotal, storagePercent, temperature (string)
    if (el.cpu)        el.cpu.textContent        = data.cpu        || '--%';
    if (el.cpuDetails) el.cpuDetails.textContent = `${data.cpuCores || '--'} Núcleos | ${data.cpuSpeed || '--'}`;
    if (el.ram)        el.ram.textContent        = data.ram        || '-- / --';
    if (el.temp)       el.temp.textContent       = data.temperature || '--°C';
    if (el.netSpeed)   el.netSpeed.textContent   = `${data.totalDown || '--'} / ${data.totalUp || '--'}`;

    // Storage — campos: storageFree, storageTotal, storagePercent
    if (el.storageBar && data.storagePercent) {
        el.storageBar.style.width = `${data.storagePercent}%`;
    }
    if (el.storage && data.storageTotal) {
        el.storage.textContent = `${data.storageFree || '--'} livre de ${data.storageTotal}`;
    }
}

// ============================================================
//  APPS
// ============================================================
async function fetchApps() {
    const data = await safeFetch(`${API_BASE}/apps`);
    if (!data || !el.appsGrid) return;
    renderApps(data);
}

function renderApps(apps) {
    if (!el.appsGrid) return;
    if (!apps.length) {
        el.appsGrid.innerHTML = '<p style="color:var(--text-muted);padding:20px 0">Nenhum app cadastrado. Adicione um!</p>';
        return;
    }
    // O servidor retorna: id, name, port, icon, url, status (Online/Offline)
    const statusColor = s => s === 'Online' ? 'var(--success)' : 'var(--text-muted)';
    el.appsGrid.innerHTML = apps.map(app => `
        <div class="card" style="border-left:3px solid var(--primary);">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong>${app.icon || '🚀'} ${app.name}</strong>
                <span style="font-size:0.75rem;font-weight:600;color:${statusColor(app.status)}">${app.status || '--'}</span>
            </div>
            <small style="color:var(--text-muted)">Porta: ${app.port}</small>
            <div style="display:flex;gap:6px;margin-top:12px">
                <button class="btn btn-sm btn-danger" onclick="deleteApp('${app.id}')" title="Remover">🗑</button>
                ${app.url ? `<a href="${app.url}" target="_blank" class="btn btn-sm btn-secondary">↗</a>` : ''}
            </div>
        </div>
    `).join('');
}

function toggleForm() {
    const f = document.getElementById('addAppForm');
    if (f) f.classList.toggle('hidden');
}

async function addApp(e) {
    e.preventDefault();
    const body = {
        name: document.getElementById('appName').value,
        port: document.getElementById('appPort').value,
        icon: document.getElementById('appIcon').value,
        url:  document.getElementById('appUrl').value,
    };
    await safeFetch(`${API_BASE}/apps`, 'POST', body);
    toggleForm();
    fetchApps();
}

async function startApp(id)  { await safeFetch(`${API_BASE}/apps/${id}/start`,  'POST'); fetchApps(); }
async function stopApp(id)   { await safeFetch(`${API_BASE}/apps/${id}/stop`,   'POST'); fetchApps(); }
async function deleteApp(id) { await safeFetch(`${API_BASE}/apps/${id}`,        'DELETE'); fetchApps(); }

// ============================================================
//  PROCESSOS
// ============================================================
async function fetchProcesses() {
    const data = await safeFetch(`${API_BASE}/processes`);
    if (!data || !el.procTable) return;
    el.procTable.innerHTML = data.map(p => `
        <tr>
            <td>${p.pid}</td>
            <td>${p.user}</td>
            <td>${p.cpu}%</td>
            <td>${p.ram}</td>
            <td style="font-family:monospace;font-size:0.8rem">${p.command}</td>
            <td><button class="btn btn-sm btn-danger" onclick="killProcess(${p.pid})">✕</button></td>
        </tr>
    `).join('');
}

async function killProcess(pid) {
    if (!confirm(`Encerrar processo ${pid}?`)) return;
    // Rota correta: POST /api/processes/:pid/kill
    await safeFetch(`${API_BASE}/processes/${pid}/kill`, 'POST');
    fetchProcesses();
}

// ============================================================
//  GERENCIADOR DE ARQUIVOS — corrigido e completo
// ============================================================

function formatSize(bytes) {
    if (!bytes || bytes === 0) return '--';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function formatDate(mtime) {
    if (!mtime) return '--';
    return new Date(mtime).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}

// Monta o caminho absoluto de forma segura
function filePath(name) {
    return currentDir.replace(/\/$/, '') + '/' + name;
}

async function loadFiles(dir) {
    const targetDir = dir || currentDir;
    const data = await safeFetch(`${API_BASE}/files?dir=${encodeURIComponent(targetDir)}`);
    if (!data) return;
    // Servidor retorna: { currentDir, parentDir, files: [{name, path, isDirectory, size, mtime}] }
    currentDir   = data.currentDir || targetDir;
    currentFiles = data.files || [];

    const breadcrumb = document.getElementById('file-breadcrumb');
    if (breadcrumb) breadcrumb.textContent = currentDir;

    renderFileList(currentFiles, data.parentDir);
}

function renderFileList(files, parentDir) {
    const tbody = document.getElementById('file-list');
    if (!tbody) return;
    tbody.innerHTML = '';

    // Linha ".." para voltar
    if (parentDir && parentDir !== currentDir) {
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td></td>
            <td><a href="#" onclick="loadFiles('${parentDir.replace(/'/g, "\\'")}');return false">📁 ..</a></td>
            <td>--</td><td>--</td><td></td>`;
        tbody.appendChild(tr);
    }

    if (!files.length) {
        tbody.innerHTML += '<tr><td colspan="5" style="color:var(--text-muted);padding:16px">Pasta vazia.</td></tr>';
        return;
    }

    // Pastas primeiro, depois arquivos
    const sorted = [...files].sort((a, b) => {
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        return a.name.localeCompare(b.name);
    });

    sorted.forEach(file => {
        const { name, isDirectory, size, mtime, path: fullPath } = file;
        const icon = isDirectory ? '📁' : getFileIcon(name);
        const absPath = fullPath || filePath(name);
        const clickFn = isDirectory
            ? `loadFiles('${absPath.replace(/'/g, "\\'")}');return false`
            : `viewFile('${absPath.replace(/'/g, "\\'")}', '${name.replace(/'/g, "\\'")}');return false`;

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><input type="checkbox" data-path="${absPath}" data-name="${name}"></td>
            <td><a href="#" onclick="${clickFn}">${icon} ${name}</a></td>
            <td>${isDirectory ? '--' : formatSize(size)}</td>
            <td>${formatDate(mtime)}</td>
            <td style="text-align:right; white-space:nowrap;">
                ${!isDirectory ? `<button class="btn btn-sm btn-secondary" onclick="viewFile('${absPath.replace(/'/g, "\\'")}','${name.replace(/'/g, "\\'")}')">👁</button>` : ''}
                <button class="btn btn-sm btn-secondary" onclick="renameItem('${absPath.replace(/'/g, "\\'")}','${name.replace(/'/g, "\\'")}')">✏️</button>
                <button class="btn btn-sm btn-danger" onclick="deleteFileItem('${absPath.replace(/'/g, "\\'")}','${name.replace(/'/g, "\\'")}')">🗑</button>
            </td>`;
        tbody.appendChild(tr);
    });
}

function getFileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const icons = { js:'🟨', ts:'🔷', json:'📋', html:'🌐', css:'🎨', sh:'⚙️', md:'📝',
                    py:'🐍', php:'🐘', sql:'🗄️', zip:'🗜️', gz:'🗜️', tar:'🗜️',
                    jpg:'🖼️', png:'🖼️', gif:'🖼️', mp4:'🎬', pdf:'📕', txt:'📄' };
    return icons[ext] || '📄';
}

function toggleSelectAllFiles() {
    const master = document.getElementById('selectAllFiles');
    document.querySelectorAll('#file-list input[type=checkbox]').forEach(cb => cb.checked = master?.checked);
}

// VIEW — servidor retorna texto puro em GET /api/files/read?file=PATH
async function viewFile(absPath, name) {
    // Usa fetch direto pois a resposta é texto puro, não JSON
    try {
        const resp = await fetch(`${API_BASE}/files/read?file=${encodeURIComponent(absPath)}`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const content = await resp.text();
        const nameEl    = document.getElementById('modalFileName');
        const contentEl = document.getElementById('fileContentArea');
        const modal     = document.getElementById('fileViewerModal');
        if (nameEl)    nameEl.textContent    = name || absPath.split('/').pop();
        if (contentEl) contentEl.textContent = content;
        if (modal)     modal.classList.remove('hidden');
        // Armazena para edição
        window._editingFilePath = absPath;
    } catch(e) {
        alert(`Não foi possível abrir o arquivo: ${e.message}`);
    }
}

function closeFileViewer() {
    document.getElementById('fileViewerModal')?.classList.add('hidden');
    window._editingFilePath = null;
}

async function saveFileContent() {
    if (!window._editingFilePath) return;
    const content = document.getElementById('fileContentArea')?.textContent;
    const result  = await safeFetch(`${API_BASE}/files/save`, 'POST', { path: window._editingFilePath, content });
    if (result?.success) alert('✅ Arquivo salvo!');
}

// CRIAR PASTA — servidor espera {dir, name}
async function createNewFolder() {
    const name = prompt('Nome da nova pasta:');
    if (!name) return;
    const result = await safeFetch(`${API_BASE}/files/mkdir`, 'POST', { dir: currentDir, name });
    if (result?.success) loadFiles();
}

// DELETE — servidor usa DELETE /api/files?path=
async function deleteFileItem(absPath, name) {
    if (!confirm(`Deletar "${name}"? Esta ação é irreversível.`)) return;
    const result = await fetch(`${API_BASE}/files?path=${encodeURIComponent(absPath)}`, { method: 'DELETE' });
    if (result.ok) loadFiles();
    else alert('Erro ao deletar o arquivo.');
}

// RENOMEAR — servidor usa POST /api/files/rename com {oldPath, newPath}
async function renameItem(absPath, oldName) {
    const newName = prompt('Novo nome:', oldName);
    if (!newName || newName === oldName) return;
    const newPath = absPath.replace(/(\/)[^/]+$/, `$1${newName}`);
    const result  = await safeFetch(`${API_BASE}/files/rename`, 'POST', { oldPath: absPath, newPath });
    if (result?.success) loadFiles();
}

// UPLOAD — servidor usa raw body com headers x-file-name e x-target-dir
async function handleUpload(event) {
    const files = Array.from(event.target.files);
    if (!files.length) return;

    for (const file of files) {
        try {
            await fetch(`${API_BASE}/files/upload`, {
                method: 'POST',
                headers: {
                    'x-file-name':   file.name,
                    'x-target-dir':  currentDir,
                    'Content-Type':  file.type || 'application/octet-stream',
                },
                body: file,
            });
        } catch(e) {
            console.error('Upload falhou para', file.name, e);
        }
    }
    event.target.value = '';
    loadFiles();
}

// COMPRIMIR — servidor usa POST /api/files/compress com {items[], archiveName, currentDir}
async function zipSelected() {
    const checkboxes = [...document.querySelectorAll('#file-list input[type=checkbox]:checked')];
    if (!checkboxes.length) { alert('Selecione arquivos para comprimir.'); return; }

    const archiveName = prompt('Nome do arquivo comprimido:', 'arquivo.tar.gz');
    if (!archiveName) return;

    const items = checkboxes.map(cb => cb.dataset.path);
    const result = await safeFetch(`${API_BASE}/files/compress`, 'POST', { items, archiveName, currentDir });
    if (result?.success) { alert('✅ Arquivo comprimido!'); loadFiles(); }
}


// ============================================================
//  BANCO DE DADOS — Módulo Completo
// ============================================================

async function fetchDbStatus() {
    const data = await safeFetch(`${API_BASE}/db/status`);
    const setEl = (id, val) => { const e = document.getElementById(id); if (e) e.textContent = val; };

    if (!data || !data.online) {
        setEl('db-stat-status', 'Offline');
        const card = document.getElementById('db-card-status');
        if (card) card.style.borderColor = 'var(--danger)';
        return;
    }

    setEl('db-stat-status',      'Online');
    setEl('db-stat-uptime',      data.uptime      || '--');
    setEl('db-stat-connections', data.connections || '--');
    setEl('db-stat-count',       data.dbCount     || '--');
    setEl('db-stat-size',        `${data.totalSizeMb || 0} MB`);
    setEl('db-stat-ram',         data.ramPct ? `${data.ramPct}%` : '--');

    const card = document.getElementById('db-card-status');
    if (card) card.style.borderColor = 'var(--success)';
}

async function fetchDatabases() {
    await fetchDbStatus();
    const data  = await safeFetch(`${API_BASE}/db`);
    const tbody = document.getElementById('db-list-body');
    if (!tbody) return;

    if (!data || !data.databases) {
        tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text-muted);padding:16px">Sem conexão com MariaDB. Configure a senha root primeiro.</td></tr>';
        return;
    }
    if (!data.databases.length) {
        tbody.innerHTML = '<tr><td colspan="3" style="color:var(--text-muted);padding:16px">Nenhum banco encontrado.</td></tr>';
        return;
    }

    tbody.innerHTML = data.databases.map(db => {
        const name = typeof db === 'string' ? db : db.name;
        const size = typeof db === 'object' ? `${db.size_mb || 0} MB` : '--';
        const isSystem = ['information_schema','performance_schema','mysql','sys'].includes(name);
        return `
            <tr>
                <td>🗄 <strong>${name}</strong> ${isSystem ? '<span style="font-size:0.7rem;color:var(--text-muted)">(sistema)</span>' : ''}</td>
                <td>${size}</td>
                <td>
                    <button class="btn btn-sm btn-primary" onclick="openPhpMyAdmin('${name}')" title="Acesso Automático">↗ phpMyAdmin</button>
                    <button class="btn btn-sm btn-secondary" onclick="document.getElementById('dbBackupName').value='${name}'; createDbBackup()" style="margin-left:4px">⬇ Backup</button>
                    ${!isSystem ? `<button class="btn btn-sm btn-danger" onclick="deleteDb('${name}')" style="margin-left:4px">🗑 Drop</button>` : ''}
                </td>
            </tr>
        `;
    }).join('');

    // Carrega lista de backups
    loadDbBackups();
}

async function createDatabase(e) {
    e.preventDefault();
    const body = {
        dbName: document.getElementById('dbNewName').value,
        dbUser: document.getElementById('dbNewUser').value,
        dbPass: document.getElementById('dbNewPass').value,
    };
    const result = await safeFetch(`${API_BASE}/db/create`, 'POST', body);
    if (result?.success) {
        alert('✅ Banco criado com sucesso!');
        e.target.reset();
        fetchDatabases();
    }
}

async function createDbUser(e) {
    e.preventDefault();
    const body = {
        username: document.getElementById('dbUserName').value,
        password: document.getElementById('dbUserPass').value,
        database: document.getElementById('dbUserDatabase').value,
    };
    const result = await safeFetch(`${API_BASE}/db/user`, 'POST', body);
    if (result?.success) {
        alert('✅ Usuário criado com sucesso!');
        e.target.reset();
    }
}

async function deleteDb(name) {
    if (!confirm(`⚠️ Deletar banco "${name}"?\n\nEsta ação é IRREVERSÍVEL!`)) return;
    const result = await safeFetch(`${API_BASE}/db/${name}`, 'DELETE');
    if (result?.success) fetchDatabases();
}

async function mariadbAction(action) {
    const msg = document.getElementById('mariadb-msg');
    if (msg) msg.textContent = `Executando ${action}...`;
    await safeFetch(`${API_BASE}/mariadb/toggle`, 'POST');
    setTimeout(async () => {
        await fetchDbStatus();
        if (msg) msg.textContent = `Ação "${action}" concluída.`;
    }, 2000);
}

async function testDbConnection() {
    const data = await safeFetch(`${API_BASE}/db/test`);
    alert(data?.success ? `✅ ${data.message}` : `❌ ${data?.message || 'Falha na conexão'}`);
}

async function createDbBackup() {
    const dbName = document.getElementById('dbBackupName')?.value || '';
    const result = await safeFetch(`${API_BASE}/db/backup`, 'POST', { dbName });
    if (result?.success) {
        const filenameEl = document.getElementById('db-backup-filename');
        const resultEl   = document.getElementById('db-backup-result');
        if (filenameEl) filenameEl.textContent = result.filename;
        if (resultEl)   resultEl.classList.remove('hidden');
        loadDbBackups();
    } else {
        alert('❌ Erro ao gerar backup. Verifique a conexão.');
    }
}

async function loadDbBackups() {
    const data = await safeFetch(`${API_BASE}/db/backups`);
    const sel  = document.getElementById('dbRestoreFile');
    if (!sel || !data?.backups) return;
    sel.innerHTML = '<option value="">Selecione o backup...</option>' +
        data.backups.map(b => `<option value="${b.name}">${b.name} (${b.size}) — ${b.date}</option>`).join('');
}

async function restoreDbBackup() {
    const filename = document.getElementById('dbRestoreFile')?.value;
    const dbName   = document.getElementById('dbRestoreTarget')?.value;
    if (!filename) { alert('Selecione um arquivo de backup!'); return; }
    if (!confirm(`Restaurar "${filename}"? Isso substituirá os dados existentes.`)) return;
    const result = await safeFetch(`${API_BASE}/db/restore`, 'POST', { filename, dbName });
    alert(result?.success ? '✅ Banco restaurado com sucesso!' : '❌ Erro ao restaurar.');
}

function showDbSetup() { document.getElementById('dbSetupModal').classList.remove('hidden'); }

async function saveDbSetup() {
    const body = {
        host:     document.getElementById('dbRootHost')?.value || 'localhost',
        user:     document.getElementById('dbRootUser').value,
        password: document.getElementById('dbRootPass').value,
    };
    const result = await safeFetch(`${API_BASE}/db/setup`, 'POST', body);
    document.getElementById('dbSetupModal').classList.add('hidden');
    if (result?.success) {
        // Testa conexão automaticamente após salvar
        const test = await safeFetch(`${API_BASE}/db/test`);
        alert(test?.success ? '✅ Configuração salva! Conexão OK.' : `⚠️ Configuração salva mas conexão falhou: ${test?.message}`);
        fetchDatabases();
    }
}


// ============================================================
//  PHPMYADMIN SSO
// ============================================================
async function openPhpMyAdmin(dbName = null) {
    const data = await safeFetch(`${API_BASE}/phpmyadmin/create-token`, 'POST', { database: dbName });
    if (data && data.ok && data.url) {
        window.open(data.url, '_blank');
    } else {
        alert("Falha ao gerar o token de acesso SSO.");
    }
}

// ============================================================
//  NGINX / PROXY
// ============================================================
async function fetchNginxSites() {
    const data = await safeFetch(`${API_BASE}/nginx`);
    const tbody = document.getElementById('nginxTableBody');
    if (!tbody) return;
    // Servidor retorna {sites: [{file, domain, port}]}
    const sites = data?.sites || [];
    tbody.innerHTML = sites.length
        ? sites.map(s => `
            <tr>
                <td>${s.domain}</td><td>${s.port}</td>
                <td><button class="btn btn-sm btn-danger" onclick="deleteNginxSite('${s.file}')">🗑</button></td>
            </tr>
        `).join('')
        : '<tr><td colspan="3" style="color:var(--text-muted)">Nenhum site configurado.</td></tr>';
}

function toggleNginxType() {
    const type = document.getElementById('ngType').value;
    if (type === 'proxy') {
        document.getElementById('ngProxyGroup').classList.remove('hidden');
        document.getElementById('ngPathGroup').classList.add('hidden');
    } else {
        document.getElementById('ngProxyGroup').classList.add('hidden');
        document.getElementById('ngPathGroup').classList.remove('hidden');
    }
}

async function createNginxSite(e) {
    e.preventDefault();
    await safeFetch(`${API_BASE}/nginx`, 'POST', {
        domain:     document.getElementById('ngDomain').value,
        listenPort: document.getElementById('ngListenPort').value,
        type:       document.getElementById('ngType').value,
        port:       document.getElementById('ngPort').value,
        path:       document.getElementById('ngPath').value,
    });
    fetchNginxSites();
}

async function deleteNginxSite(file) {
    if (!confirm(`Remover configuração "${file}"?`)) return;
    // Servidor usa DELETE /api/nginx?file=nome.conf
    await fetch(`${API_BASE}/nginx?file=${encodeURIComponent(file)}`, { method: 'DELETE' });
    fetchNginxSites();
}

async function actionNginx(action) {
    const labels = { start: 'iniciar', stop: 'parar', restart: 'reiniciar' };
    if (!confirm(`Deseja ${labels[action]} o serviço do NGINX?`)) return;
    const res = await safeFetch(`${API_BASE}/nginx/action`, 'POST', { action });
    if (res?.success) {
        alert(`NGINX ${labels[action]} com sucesso!`);
        fetchNginxSites();
    } else {
        alert('Erro ao processar o comando.');
    }
}

// ============================================================
//  CRONJOBS
// ============================================================
async function fetchCron() {
    const data = await safeFetch(`${API_BASE}/cron`);
    const editor = document.getElementById('cronEditor');
    // Servidor retorna {cron: '...'} (não crontab)
    if (editor && data) editor.value = data.cron || '';
}

async function saveCron() {
    const content = document.getElementById('cronEditor')?.value;
    // Servidor espera campo {cron: '...'}
    const result = await safeFetch(`${API_BASE}/cron`, 'POST', { cron: content });
    if (result?.success) alert('Crontab salvo com sucesso!');
}

// ============================================================
//  NO-IP
// ============================================================
async function fetchNoipStatus() {
    const data = await safeFetch(`${API_BASE}/noip`);
    if (!data) return;
    const statusEl = document.getElementById('noip-status-text');
    const ipEl     = document.getElementById('noip-current-ip');
    const updateEl = document.getElementById('noip-last-update');
    if (statusEl) statusEl.textContent = data.status || '--';
    if (ipEl)     ipEl.textContent     = data.currentIp || '--';
    if (updateEl) updateEl.textContent = data.lastUpdate || '--';

    const btn = document.getElementById('noip-toggle-btn');
    if (btn) {
        btn.textContent = data.status === 'running' ? '⏹ Parar' : '▶ Iniciar';
        btn.className = `btn btn-sm ${data.status === 'running' ? 'btn-danger' : 'btn-primary'}`;
    }

    if (data.username) document.getElementById('noipUsername').value = data.username || '';
    if (data.hostname) document.getElementById('noipHostname').value = data.hostname || '';
    if (data.interval) document.getElementById('noipInterval').value = data.interval || 15;
}

async function toggleNoip() {
    await safeFetch(`${API_BASE}/noip/toggle`, 'POST');
    fetchNoipStatus();
}

async function saveNoipConfig(e) {
    e.preventDefault();
    await safeFetch(`${API_BASE}/noip`, 'POST', {
        username: document.getElementById('noipUsername').value,
        password: document.getElementById('noipPassword').value,
        hostname: document.getElementById('noipHostname').value,
        interval: parseInt(document.getElementById('noipInterval').value),
        autostart: document.getElementById('noipAutostart').checked,
    });
    alert('Configuração salva!');
    fetchNoipStatus();
}

function appendNoipLog(msg) {
    const container = document.getElementById('noip-log-container');
    if (!container) return;
    container.innerHTML += `<div>${msg}</div>`;
    container.scrollTop = container.scrollHeight;
}

// ============================================================
//  LOGS — eventos corretos do servidor
// ============================================================
function startLogWatch() {
    let filePath = document.getElementById('logFilePath')?.value;
    // Se o usuário clicar com o input em branco, usa o placeholder como padrão
    if (!filePath || filePath.trim() === '') {
        filePath = document.getElementById('logFilePath')?.placeholder;
    }
    if (!filePath) return;
    const d = document.getElementById('logs-display');
    if (d) d.textContent = `Monitorando: ${filePath}\n`;
    // Servidor usa 'log-start' com string (não objeto)
    socket?.emit('log-start', filePath);
}

function stopLogWatch() {
    // Servidor usa 'log-stop'
    socket?.emit('log-stop');
}

function appendLogLine(line) {
    const d = document.getElementById('logs-display');
    if (!d) return;
    d.textContent += line + '\n';
    d.scrollTop = d.scrollHeight;
}

// ============================================================
//  DIAGNÓSTICO / FIX
// ============================================================
async function checkHealthStatus() {
    const data = await safeFetch(`${API_BASE}/health-check/status`);
    if (!data || !data.services) return;
    
    const container = document.getElementById('health-quick-status');
    if (!container) return;

    const s = data.services;
    container.innerHTML = `
        <div class="stat-card" style="border-left: 4px solid ${s.nginx.installed ? 'var(--success)' : 'var(--danger)'}">
            <span class="card-label">NGINX</span>
            <strong>${s.nginx.installed ? (s.nginx.running ? 'Rodando' : 'Parado') : 'Não Instalado'}</strong>
            <small>Porta 80: ${s.nginx.port80 ? 'Aberta' : 'Fechada'}</small>
        </div>
        <div class="stat-card" style="border-left: 4px solid ${s.mariadb.installed ? 'var(--success)' : 'var(--danger)'}">
            <span class="card-label">MariaDB</span>
            <strong>${s.mariadb.installed ? (s.mariadb.running ? 'Rodando' : 'Parado') : 'Não Instalado'}</strong>
            <small>Porta 3306: ${s.mariadb.port3306 ? 'Aberta' : 'Fechada'}</small>
        </div>
        <div class="stat-card" style="border-left: 4px solid ${s.phpfpm.installed ? 'var(--success)' : 'var(--danger)'}">
            <span class="card-label">PHP-FPM</span>
            <strong>${s.phpfpm.installed ? (s.phpfpm.running ? 'Rodando' : 'Parado') : 'Não Instalado'}</strong>
        </div>
        <div class="stat-card" style="border-left: 4px solid ${s.phpmyadmin.installed ? 'var(--success)' : 'var(--danger)'}">
            <span class="card-label">phpMyAdmin</span>
            <strong>${s.phpmyadmin.installed ? 'Instalado' : 'Não Instalado'}</strong>
            <small>Porta 8080: ${s.phpmyadmin.port8080 ? 'Aberta' : 'Fechada'}</small>
        </div>
    `;
}

function runHealthCheck() {
    const term = document.getElementById('health-check-terminal');
    if (!term) return;
    
    term.innerHTML = '<span style="color:var(--primary)">Iniciando diagnóstico e auto-fix...</span>\n\n';
    
    const evtSource = new EventSource(`${API_BASE}/health-check/run`);
    
    evtSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const line = data.line;
            
            if (line.startsWith('__DONE__:')) {
                evtSource.close();
                const code = line.split(':')[1];
                term.innerHTML += `\n<span style="color:${code == 0 ? 'var(--success)' : 'var(--warning)'}">Processo finalizado com código ${code}.</span>\n`;
                checkHealthStatus(); // Atualiza os cards
                return;
            }
            
            // Coloração básica ANSI para HTML
            let htmlLine = line
                .replace(/\033\[0;31m/g, '<span style="color:var(--danger)">')
                .replace(/\033\[0;32m/g, '<span style="color:var(--success)">')
                .replace(/\033\[1;33m/g, '<span style="color:var(--warning)">')
                .replace(/\033\[0;34m/g, '<span style="color:#58a6ff">')
                .replace(/\033\[0;36m/g, '<span style="color:#39c5bb">')
                .replace(/\033\[1m/g, '<strong>')
                .replace(/\033\[0m/g, '</span>');
                
            term.innerHTML += htmlLine + '\n';
            term.scrollTop = term.scrollHeight;
        } catch (e) {
            console.error('Erro ao processar linha do SSE', e);
        }
    };
    
    evtSource.onerror = () => {
        term.innerHTML += '\n<span style="color:var(--danger)">Conexão perdida com o servidor.</span>\n';
        evtSource.close();
    };
}

// ============================================================
//  SISTEMA DE ATUALIZAÇÃO DO PAINEL — GitHub Releases
// ============================================================
async function checkSystemUpdates() {
    const statusText   = document.getElementById('update-status-text');
    const versionCur   = document.getElementById('update-current-version');
    const versionLat   = document.getElementById('update-latest-version');
    const btnRun       = document.getElementById('btn-run-update');
    const repoInput    = document.getElementById('github-repo-input');
    const notesWrapper = document.getElementById('update-release-notes-wrapper');

    if (statusText) statusText.innerHTML = 'Verificando...';

    // Carrega config do repositório GitHub
    const cfg = await safeFetch(`${API_BASE}/system/update/config`);
    if (cfg && repoInput && !repoInput.value) {
        repoInput.value = cfg.github_repo || '';
    }

    const data = await safeFetch(`${API_BASE}/system/update/check`);
    if (!data) {
        if (statusText) statusText.innerHTML = '<span style="color:var(--danger)">Erro ao verificar</span>';
        return;
    }

    if (versionCur) versionCur.textContent = `v${data.currentVersion}`;
    if (versionLat) versionLat.textContent = data.latestVersion !== data.currentVersion ? `v${data.latestVersion}` : '—';

    // Notas de release
    if (notesWrapper && data.releaseNotes) {
        notesWrapper.textContent = data.releaseNotes;
        notesWrapper.classList.remove('hidden');
    }

    if (data.hasUpdate) {
        if (statusText) statusText.innerHTML = '<span style="color:var(--success)">✅ Nova versão disponível!</span>';
        if (btnRun) btnRun.classList.remove('hidden');
    } else {
        const methodLabels = {
            github:       '✅ Atualizado via GitHub Releases',
            github_error: '⚠️ GitHub indisponível — verifique o repositório',
            git:          '✅ Atualizado (Git)',
            manual:       '📦 Instalação manual'
        };
        const label = methodLabels[data.updateMethod] || 'Verificado';
        if (statusText) statusText.innerHTML = `<span style="color:var(--text-muted)">${label}</span>`;
        if (btnRun) {
            // Sempre mostra o botão para permitir forçar re-instalação
            btnRun.classList.remove('hidden');
        }
    }

    // Repo não configurado
    if (!data.githubRepo && data.updateMethod === 'manual') {
        if (statusText) statusText.innerHTML = '<span style="color:var(--warning)">⚠️ Configure o repositório GitHub abaixo para atualizações automáticas</span>';
    } else if (cfg?.github_repo) {
        // Busca lista de versões históricas disponíveis
        fetchAvailableVersions();
    }
}

async function fetchAvailableVersions() {
    const wrapper = document.getElementById('manual-version-selector-wrapper');
    const select = document.getElementById('github-versions-select');
    if (!wrapper || !select) return;

    try {
        const res = await safeFetch(`${API_BASE}/system/update/versions`);
        if (res?.success && res.versions && res.versions.length > 0) {
            window.availableVersions = res.versions;
            select.innerHTML = res.versions.map(rel => {
                const date = new Date(rel.publishedAt).toLocaleDateString();
                const prefix = rel.compatStatus === 'breaking' ? '⚠️ ' : '✅ ';
                return `<option value="${rel.tag}">${prefix}${rel.tag} (${date})</option>`;
            }).join('');
            
            wrapper.classList.remove('hidden');
            onVersionSelected(); // Inicializa o texto de compatibilidade
        } else {
            wrapper.classList.add('hidden');
        }
    } catch (err) {
        console.error('Falha ao obter lista de versões:', err);
    }
}

function onVersionSelected() {
    const select = document.getElementById('github-versions-select');
    const info = document.getElementById('version-compatibility-info');
    if (!select || !info || !window.availableVersions) return;

    const selectedTag = select.value;
    const release = window.availableVersions.find(r => r.tag === selectedTag);
    if (!release) {
        info.innerHTML = '';
        return;
    }

    const isBreaking = release.compatStatus === 'breaking';
    const color = isBreaking ? 'var(--warning)' : 'var(--success)';
    const icon = isBreaking ? 'alert-triangle' : 'check-circle';
    
    info.innerHTML = `
        <span style="color:${color}; display:flex; align-items:center; gap:4px;">
            <i data-lucide="${icon}" style="width:14px; height:14px; display:inline-block;"></i>
            ${release.compatMessage}
        </span>
    `;
    lucide.createIcons();
}

async function runManualSystemUpdate() {
    const select = document.getElementById('github-versions-select');
    const tag = select?.value;
    if (!tag) {
        alert('❌ Selecione uma versão válida!');
        return;
    }

    const isBreaking = window.availableVersions?.find(r => r.tag === tag)?.compatStatus === 'breaking';
    const warnMsg = isBreaking 
        ? `\n\n⚠️ ATENÇÃO: Esta é uma versão antiga (Downgrade). Recursos mais novos serão desativados. Certifique-se de que possui backup!` 
        : ``;

    if (!confirm(`Deseja realmente instalar e aplicar a versão "${tag}" no seu cPanel?${warnMsg}\n\nO painel será reiniciado ao final do processo.`)) {
        return;
    }

    const termWrapper = document.getElementById('update-terminal-wrapper');
    const term        = document.getElementById('update-terminal');
    const btnRun      = document.getElementById('btn-run-update');
    const btnCheck    = document.getElementById('btn-check-update');
    const btnManual   = document.getElementById('btn-run-manual-update');

    if (termWrapper) termWrapper.classList.remove('hidden');
    if (term) term.innerHTML = `<span style="color:var(--primary)">Iniciando instalação manual para a versão ${tag} via GitHub Releases...</span>\n\n`;
    
    if (btnRun)    btnRun.disabled    = true;
    if (btnCheck)  btnCheck.disabled  = true;
    if (btnManual) btnManual.disabled = true;

    // Conecta passando a query string com a tag selecionada!
    const evtSource = new EventSource(`${API_BASE}/system/update/run?tag=${tag}`);

    evtSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const line = data.line;

            if (line.startsWith('__DONE__:')) {
                evtSource.close();
                const code = line.split(':')[1];
                term.innerHTML += `\n<span style="color:${code == 0 ? 'var(--success)' : 'var(--warning)'}">Processo finalizado com código ${code}.</span>\n`;
                if (code == 0) {
                    term.innerHTML += `<span style="color:var(--success)">✅ Versão ${tag} instalada com sucesso! Recarregando em 5s...</span>\n`;
                    setTimeout(() => location.reload(), 5000);
                } else {
                    term.innerHTML += `<span style="color:var(--danger)">❌ Erro na instalação. Verifique a saída acima.</span>\n`;
                }
                
                if (btnRun)    btnRun.disabled    = false;
                if (btnCheck)  btnCheck.disabled  = false;
                if (btnManual) btnManual.disabled = false;
                checkSystemUpdates();
                return;
            }

            let htmlLine = line
                .replace(/\033\[0;31m/g, '<span style="color:var(--danger)">')
                .replace(/\033\[0;32m/g, '<span style="color:var(--success)">')
                .replace(/\033\[1;33m/g, '<span style="color:var(--warning)">')
                .replace(/\033\[0;34m/g, '<span style="color:#58a6ff">')
                .replace(/\033\[0;36m/g, '<span style="color:#39c5bb">')
                .replace(/\033\[1m/g,    '<strong>')
                .replace(/\033\[0m/g,    '</span>');

            term.innerHTML += htmlLine + '\n';
            term.scrollTop = term.scrollHeight;
        } catch(e) {
            console.error('Erro na linha de atualização', e);
        }
    };

    evtSource.onerror = () => {
        term.innerHTML += '\n<span style="color:var(--warning)">Servidor desconectado — reiniciando para concluir instalação...</span>\n';
        evtSource.close();
        setTimeout(() => {
            if (btnRun)    btnRun.disabled    = false;
            if (btnCheck)  btnCheck.disabled  = false;
            if (btnManual) btnManual.disabled = false;
            location.reload();
        }, 5000);
    };
}

async function saveGithubRepo() {
    const input = document.getElementById('github-repo-input');
    let repo  = input?.value?.trim() || '';
    
    // Limpa a URL se o usuário colou completo (https://github.com/user/repo)
    repo = repo.replace(/https?:\/\/github\.com\//i, '').replace(/^\/+|\/+$/g, '');
    
    if (input) input.value = repo; // mostra limpo no input

    if (!repo || !repo.includes('/')) {
        alert('Formato inválido. Use: usuario/repositorio ou a URL completa do GitHub');
        return;
    }
    const result = await safeFetch(`${API_BASE}/system/update/config`, 'POST', { github_repo: repo });
    if (result?.success) {
        alert(`✅ Repositório salvo: ${repo}\n\nAgora clique "Verificar" para checar atualizações.`);
        checkSystemUpdates();
    } else {
        alert('❌ Erro ao salvar configuração.');
    }
}

function runSystemUpdate() {
    if (!confirm('Deseja realmente atualizar o painel?\nO servidor será reiniciado ao final.')) return;

    const termWrapper = document.getElementById('update-terminal-wrapper');
    const term        = document.getElementById('update-terminal');
    const btnRun      = document.getElementById('btn-run-update');
    const btnCheck    = document.getElementById('btn-check-update');

    if (termWrapper) termWrapper.classList.remove('hidden');
    if (term) term.innerHTML = '<span style="color:var(--primary)">Iniciando atualização automática via GitHub Releases...</span>\n\n';
    if (btnRun)  btnRun.disabled  = true;
    if (btnCheck) btnCheck.disabled = true;

    const evtSource = new EventSource(`${API_BASE}/system/update/run`);

    evtSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const line = data.line;

            if (line.startsWith('__DONE__:')) {
                evtSource.close();
                const code = line.split(':')[1];
                term.innerHTML += `\n<span style="color:${code == 0 ? 'var(--success)' : 'var(--warning)'}">Processo finalizado com código ${code}.</span>\n`;
                if (code == 0) {
                    term.innerHTML += `<span style="color:var(--success)">✅ Atualizado com sucesso! Recarregando em 5s...</span>\n`;
                    setTimeout(() => location.reload(), 5000);
                } else {
                    term.innerHTML += `<span style="color:var(--danger)">❌ Erro. Verifique a saída acima.</span>\n`;
                }
                if (btnRun)  btnRun.disabled  = false;
                if (btnCheck) btnCheck.disabled = false;
                checkSystemUpdates();
                return;
            }

            // Coloração ANSI → HTML
            let htmlLine = line
                .replace(/\033\[0;31m/g, '<span style="color:var(--danger)">')
                .replace(/\033\[0;32m/g, '<span style="color:var(--success)">')
                .replace(/\033\[1;33m/g, '<span style="color:var(--warning)">')
                .replace(/\033\[0;34m/g, '<span style="color:#58a6ff">')
                .replace(/\033\[0;36m/g, '<span style="color:#39c5bb">')
                .replace(/\033\[1m/g,    '<strong>')
                .replace(/\033\[0m/g,    '</span>');

            term.innerHTML += htmlLine + '\n';
            term.scrollTop = term.scrollHeight;
        } catch(e) {
            console.error('Erro linha de atualização', e);
        }
    };

    evtSource.onerror = () => {
        term.innerHTML += '\n<span style="color:var(--warning)">Servidor desconectado — reiniciando para concluir atualização...</span>\n';
        evtSource.close();
        setTimeout(() => {
            if (btnRun)  btnRun.disabled  = false;
            if (btnCheck) btnCheck.disabled = false;
            location.reload();
        }, 5000);
    };
}

// Chama na inicialização
document.addEventListener('DOMContentLoaded', () => {
    // Apenas quando a aba for aberta ou na inicialização
    setTimeout(checkHealthStatus, 2000);
});


// ============================================================
//  BACKUPS
// ============================================================
async function createBackup() {
    const btn = document.getElementById('backup-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando...'; }
    const data = await safeFetch(`${API_BASE}/backup`, 'POST');
    if (btn) { btn.disabled = false; btn.innerHTML = '↓ Gerar Backup Agora'; }
    // Servidor retorna {success, filename} (não file)
    if (data?.filename) {
        const result = document.getElementById('backup-result');
        const link   = document.getElementById('backup-download-link');
        if (result) result.classList.remove('hidden');
        if (link)   link.href = `/api/backup/download?file=${data.filename}`;
    }
}

// ============================================================
//  DOCUMENTAÇÃO
// ============================================================
async function loadDocumentation() {
    const data = await safeFetch(`${API_BASE}/readme`);
    const container = document.getElementById('docs-container');
    if (!container || !data) return;
    container.innerHTML = window.marked ? marked.parse(data.content || '') : `<pre>${data.content}</pre>`;
}

// ============================================================
//  CONTROLES DO SERVIDOR
// ============================================================
async function rebootServer() {
    if (!confirm('Reiniciar o servidor Termux?')) return;
    await safeFetch(`${API_BASE}/reboot`, 'POST');
}

async function toggleWakelock() { await safeFetch(`${API_BASE}/wakelock`, 'POST'); }
async function toggleSSHD()     { await safeFetch(`${API_BASE}/sshd`,     'POST'); }
async function toggleMariaDB()  { await safeFetch(`${API_BASE}/mariadb/toggle`, 'POST'); }

// ============================================================
//  HELPER: FETCH SEGURO
// ============================================================
async function safeFetch(url, method = 'GET', body = null) {
    try {
        const opts = { method, headers: { 'Content-Type': 'application/json' } };
        if (body) opts.body = JSON.stringify(body);
        const res  = await fetch(url, opts);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
    } catch(e) {
        console.error(`[safeFetch] ${url}:`, e.message);
        return null;
    }
}

// ============================================================
//  AUTH
// ============================================================
function logout() { window.location.href = '/login.html'; }

// ============================================================
//  CONFIGURAÇÕES DO PAINEL
// ============================================================
async function loadSettings() {
    const res = await safeFetch(`${API_BASE}/system/settings`);
    if (res?.success) {
        // Preenche porta
        const portInput = document.getElementById('settings-port-input');
        if (portInput) portInput.value = res.port;

        // Preenche usuário
        const userInput = document.getElementById('settings-user-input');
        if (userInput) userInput.value = res.adminUser;
        
        // Limpa campo de senha
        const passInput = document.getElementById('settings-pass-input');
        if (passInput) passInput.value = '';

        // Preenche autostart badge e botão (Opção 1)
        const badge = document.getElementById('autostart-status-badge');
        const btn = document.getElementById('btn-toggle-autostart');
        if (badge && btn) {
            if (res.autostart) {
                badge.className = 'badge badge-success';
                badge.textContent = 'Ativo';
                btn.className = 'btn btn-danger btn-block btn-sm';
                btn.innerHTML = 'Desativar';
            } else {
                badge.className = 'badge badge-danger';
                badge.textContent = 'Inativo';
                btn.className = 'btn btn-primary btn-block btn-sm';
                btn.innerHTML = 'Ativar';
            }
        }

        // Preenche autostart boot badge e botão (Opção 2 - Termux:Boot)
        const badgeBoot = document.getElementById('autostart-boot-badge');
        const btnBoot = document.getElementById('btn-toggle-autostart-boot');
        if (badgeBoot && btnBoot) {
            if (res.autostartBoot) {
                badgeBoot.className = 'badge badge-success';
                badgeBoot.textContent = 'Ativo';
                btnBoot.className = 'btn btn-danger btn-block btn-sm';
                btnBoot.innerHTML = 'Desativar';
            } else {
                badgeBoot.className = 'badge badge-danger';
                badgeBoot.textContent = 'Inativo';
                btnBoot.className = 'btn btn-primary btn-block btn-sm';
                btnBoot.innerHTML = 'Ativar';
            }
        }
        if (window.lucide) lucide.createIcons();
    }
}

async function toggleBootAutostart() {
    const badge = document.getElementById('autostart-status-badge');
    const isCurrentActive = badge?.textContent === 'Ativo';
    const nextState = !isCurrentActive;

    const res = await safeFetch(`${API_BASE}/system/settings/autostart/toggle`, 'POST', { active: nextState });
    if (res?.success) {
        alert(nextState 
            ? '✅ Regra de inicialização (Ao abrir o Termux) configurada com sucesso!' 
            : '✅ Regra de inicialização (Ao abrir o Termux) removida.'
        );
        loadSettings();
    } else {
        alert('❌ Falha ao alterar a regra de auto-inicialização.');
    }
}

async function toggleTermuxBoot() {
    const badge = document.getElementById('autostart-boot-badge');
    const isCurrentActive = badge?.textContent === 'Ativo';
    const nextState = !isCurrentActive;

    const res = await safeFetch(`${API_BASE}/system/settings/autostart-boot/toggle`, 'POST', { active: nextState });
    if (res?.success) {
        alert(nextState 
            ? '✅ Regra de inicialização via Termux:Boot configurada!\n\nNota importante: Lembre-se de instalar o aplicativo auxiliar "Termux:Boot" no seu celular para que o script rode de forma invisível em segundo plano ao ligar o celular.' 
            : '✅ Regra de inicialização via Termux:Boot removida com sucesso.'
        );
        loadSettings();
    } else {
        alert('❌ Falha ao alterar a regra do Termux:Boot.');
    }
}

async function savePanelPort() {
    const input = document.getElementById('settings-port-input');
    const newPort = parseInt(input?.value);
    if (!newPort || newPort < 1 || newPort > 65535) {
        alert('❌ Porta inválida! Insira um valor entre 1 e 65535.');
        return;
    }

    if (!confirm(`⚠️ Você tem certeza que deseja mudar a porta do painel para ${newPort}?\n\nO servidor será desligado e reiniciado automaticamente na nova porta. Você precisará acessar o painel usando o novo endereço.`)) {
        return;
    }

    const res = await safeFetch(`${API_BASE}/system/settings/port`, 'POST', { port: newPort });
    if (res?.success) {
        alert(`✅ Porta alterada com sucesso!\n\nO servidor está reiniciando agora. Você será redirecionado para a nova porta em 5 segundos.`);
        setTimeout(() => {
            window.location.href = `http://${window.location.hostname}:${newPort}`;
        }, 5000);
    } else {
        alert(`❌ Erro: ${res?.error || 'Não foi possível alterar a porta.'}`);
    }
}

async function savePanelAuth() {
    const userInput = document.getElementById('settings-user-input');
    const passInput = document.getElementById('settings-pass-input');
    const user = userInput?.value?.trim();
    const pass = passInput?.value;

    if (!user || !pass || user === '' || pass === '') {
        alert('❌ Usuário e senha não podem ficar vazios!');
        return;
    }

    if (!confirm('Deseja salvar as novas credenciais de acesso? Você precisará usá-las no próximo login.')) {
        return;
    }

    const res = await safeFetch(`${API_BASE}/system/settings/auth`, 'POST', { user, pass });
    if (res?.success) {
        alert('✅ Credenciais atualizadas com sucesso!');
        loadSettings();
    } else {
        alert(`❌ Erro: ${res?.error || 'Não foi possível salvar as credenciais.'}`);
    }
}

// ============================================================
//  HOSPEDAGEM (SITES & APPS) FRONTEND CONTROLLER
// ============================================================
window.hostingServices = [];
window.logInterval = null;
window.activeFilterType = 'all';

function openHostingModal() {
    // Reset form fields
    document.getElementById('hsName').value = '';
    document.getElementById('hsDomain').value = window.location.hostname || '192.168.1.103';
    document.getElementById('hsListenPort').value = '8080';
    document.getElementById('hsPath').value = '/data/data/com.termux/files/home/www/meu-projeto';
    document.getElementById('hsTargetPort').value = '';
    document.getElementById('hsStartCmd').value = '';
    document.getElementById('hsType').value = 'php';
    document.getElementById('hsAutoRestart').checked = true;
    document.getElementById('hsCreateIndex').checked = true;

    // Trigger dynamic visible fields logic
    toggleHostingFormFields();

    // Open Modal overlay
    const modal = document.getElementById('hostingModal');
    if (modal) {
        modal.classList.remove('hidden');
        lucide.createIcons();
    }
}

function closeHostingModal() {
    const modal = document.getElementById('hostingModal');
    if (modal) modal.classList.add('hidden');
}

function toggleHostingFormFields() {
    const type = document.getElementById('hsType').value;
    
    const pathGroup = document.getElementById('hsPathGroup');
    const targetPortGroup = document.getElementById('hsTargetPortGroup');
    const startCmdGroup = document.getElementById('hsStartCmdGroup');
    const autoRestartLabel = document.getElementById('hsAutoRestartLabel');
    const createIndexLabel = document.getElementById('hsCreateIndexLabel');

    // Default setups
    pathGroup.classList.remove('hidden');
    targetPortGroup.classList.add('hidden');
    startCmdGroup.classList.add('hidden');
    autoRestartLabel.classList.add('hidden');
    createIndexLabel.classList.add('hidden');

    if (type === 'php') {
        createIndexLabel.classList.remove('hidden');
        document.getElementById('hsPath').placeholder = 'ex: /data/data/com.termux/files/home/www/php-site';
    } else if (type === 'static') {
        createIndexLabel.classList.remove('hidden');
        document.getElementById('hsPath').placeholder = 'ex: /data/data/com.termux/files/home/www/html-site';
    } else if (type === 'node') {
        targetPortGroup.classList.remove('hidden');
        startCmdGroup.classList.remove('hidden');
        autoRestartLabel.classList.remove('hidden');
        createIndexLabel.classList.remove('hidden');
        document.getElementById('hsTargetPort').value = '3000';
        document.getElementById('hsStartCmd').value = 'node server.js';
        document.getElementById('hsPath').placeholder = 'ex: /data/data/com.termux/files/home/www/node-app';
    } else if (type === 'python') {
        targetPortGroup.classList.remove('hidden');
        startCmdGroup.classList.remove('hidden');
        autoRestartLabel.classList.remove('hidden');
        createIndexLabel.classList.remove('hidden');
        document.getElementById('hsTargetPort').value = '5000';
        document.getElementById('hsStartCmd').value = 'python main.py';
        document.getElementById('hsPath').placeholder = 'ex: /data/data/com.termux/files/home/www/python-app';
    } else if (type === 'proxy') {
        pathGroup.classList.add('hidden');
        targetPortGroup.classList.remove('hidden');
        document.getElementById('hsTargetPort').value = '3000';
        document.getElementById('hsPath').value = '';
    }
}

async function fetchHostingServices() {
    try {
        const res = await safeFetch(`${API_BASE}/hosting`);
        if (res?.success) {
            window.hostingServices = res.services || [];
            renderHostingGrid(window.activeFilterType);
        } else {
            console.error('Falha ao obter lista de serviços de hospedagem:', res?.error);
        }
    } catch (err) {
        console.error(err);
    }
}

function renderHostingGrid(filterType = 'all') {
    window.activeFilterType = filterType;
    const grid = document.getElementById('hostingGrid');
    if (!grid) return;

    // Filter services list
    const filtered = window.hostingServices.filter(svc => {
        if (filterType === 'all') return true;
        return svc.type === filterType;
    });

    if (filtered.length === 0) {
        grid.innerHTML = `
            <div class="card" style="grid-column: 1 / -1; text-align:center; padding:50px; color:var(--text-muted);">
                <i data-lucide="folder-open" style="width:48px; height:48px; margin:0 auto 16px; display:block; opacity: 0.6;"></i>
                <h3 style="font-weight:600; color:var(--text)">Nenhum serviço criado</h3>
                <p style="margin-top:8px; font-size:0.875rem;">Clique em "+ Novo Serviço" para colocar o seu primeiro projeto no ar!</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    grid.innerHTML = filtered.map(svc => {
        const isApp = svc.type === 'node' || svc.type === 'python';
        const isOnline = svc.status === 'online';
        const openUrl = svc.domain && svc.domain !== '_' 
            ? `http://${svc.domain}:${svc.listenPort}` 
            : `http://${window.location.hostname}:${svc.listenPort}`;
        
        let typeLabel = '';
        let typeClass = '';
        switch (svc.type) {
            case 'php': typeLabel = 'Website PHP'; typeClass = 'badge-type-php'; break;
            case 'static': typeLabel = 'Estático'; typeClass = 'badge-type-static'; break;
            case 'node': typeLabel = 'Node.js'; typeClass = 'badge-type-node'; break;
            case 'python': typeLabel = 'Python'; typeClass = 'badge-type-python'; break;
            case 'proxy': typeLabel = 'Proxy'; typeClass = 'badge-type-proxy'; break;
        }

        const statusBadge = isOnline 
            ? `<span class="badge badge-success"><i data-lucide="play" style="width:10px; height:10px; display:inline-block; vertical-align:middle; margin-right:4px;"></i>Online</span>`
            : svc.status === 'stopped'
                ? `<span class="badge badge-warning"><i data-lucide="square" style="width:10px; height:10px; display:inline-block; vertical-align:middle; margin-right:4px;"></i>Parado</span>`
                : `<span class="badge badge-danger"><i data-lucide="alert-circle" style="width:10px; height:10px; display:inline-block; vertical-align:middle; margin-right:4px;"></i>Offline</span>`;

        return `
            <div class="hosting-card">
                <div class="hosting-card-header">
                    <div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span class="badge-type ${typeClass}">${typeLabel}</span>
                            <h3 class="hosting-card-title">${svc.name}</h3>
                        </div>
                        <div class="hosting-card-meta">Criado em: ${new Date(svc.createdAt).toLocaleDateString()}</div>
                    </div>
                    ${statusBadge}
                </div>

                <div class="hosting-card-body">
                    <div class="hosting-card-info-item">
                        <span class="hosting-card-info-label">Porta Pública</span>
                        <span class="hosting-card-info-value" style="font-family:var(--font-mono); font-weight:600; color:var(--primary);">${svc.listenPort}</span>
                    </div>
                    <div class="hosting-card-info-item">
                        <span class="hosting-card-info-label">Host/Domínio</span>
                        <span class="hosting-card-info-value" style="font-family:var(--font-mono);">${svc.domain}</span>
                    </div>
                    ${svc.path ? `
                    <div class="hosting-card-info-item">
                        <span class="hosting-card-info-label">Pasta do App</span>
                        <span class="hosting-card-info-value" style="font-size:0.75rem; text-overflow:ellipsis; overflow:hidden;" title="${svc.path}">${svc.path}</span>
                    </div>
                    ` : ''}
                    ${svc.targetPort ? `
                    <div class="hosting-card-info-item">
                        <span class="hosting-card-info-label">Porta Interna</span>
                        <span class="hosting-card-info-value" style="font-family:var(--font-mono);">${svc.targetPort}</span>
                    </div>
                    ` : ''}
                    ${svc.pid ? `
                    <div class="hosting-card-info-item">
                        <span class="hosting-card-info-label">PID Ativo</span>
                        <span class="hosting-card-info-value" style="font-family:var(--font-mono); color:var(--success); font-weight:600;">${svc.pid}</span>
                    </div>
                    ` : ''}
                </div>

                <div class="hosting-card-actions">
                    <a href="${openUrl}" target="_blank" class="btn btn-secondary btn-sm" style="flex:1; justify-content:center; text-decoration:none; padding:8px 0;">
                        <i data-lucide="external-link"></i> Abrir
                    </a>
                    
                    ${isApp ? `
                        <button class="btn btn-sm ${isOnline ? 'btn-warning' : 'btn-success'}" onclick="toggleHostingProcess('${svc.id}', ${!isOnline})" style="padding:8px 12px;" title="${isOnline ? 'Parar processo' : 'Iniciar processo'}">
                            <i data-lucide="${isOnline ? 'square' : 'play'}"></i>
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="viewHostingLogs('${svc.id}', '${svc.name}')" style="padding:8px 12px;" title="Ver Logs">
                            <i data-lucide="terminal"></i>
                        </button>
                    ` : ''}
                    
                    <button class="btn btn-danger btn-sm" onclick="deleteHostingService('${svc.id}', '${svc.name}')" style="padding:8px 12px;" title="Remover Serviço">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    lucide.createIcons();
}

function filterHosting(type, btn) {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    renderHostingGrid(type);
}

async function createHostingService(e) {
    e.preventDefault();
    
    const name = document.getElementById('hsName').value.trim();
    const domain = document.getElementById('hsDomain').value.trim();
    const type = document.getElementById('hsType').value;
    const listenPort = document.getElementById('hsListenPort').value;
    const targetPort = document.getElementById('hsTargetPort').value;
    const path = document.getElementById('hsPath').value.trim();
    const startCmd = document.getElementById('hsStartCmd').value.trim();
    const autoRestart = document.getElementById('hsAutoRestart').checked;
    const createIndex = document.getElementById('hsCreateIndex').checked;

    if (!name || !listenPort) {
        alert('❌ Nome e Porta Pública são obrigatórios!');
        return;
    }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<i data-lucide="loader" class="spin"></i> Criando...';
    lucide.createIcons();

    try {
        const payload = { name, domain, type, listenPort, targetPort, path, startCmd, autoRestart, createIndex };
        const res = await safeFetch(`${API_BASE}/hosting`, 'POST', payload);
        
        if (res?.success) {
            alert('✅ Serviço de Hospedagem criado com sucesso!');
            closeHostingModal();
            fetchHostingServices();
        } else {
            alert(`❌ Falha ao criar serviço:\n\n${res?.error || 'Erro desconhecido.'}`);
        }
    } catch (err) {
        alert(`❌ Falha de rede: ${err.message}`);
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalText;
        lucide.createIcons();
    }
}

async function toggleHostingProcess(id, start) {
    try {
        const res = await safeFetch(`${API_BASE}/hosting/${id}/toggle`, 'POST', { active: start });
        if (res?.success) {
            fetchHostingServices();
        } else {
            alert(`❌ Falha ao alterar estado do processo:\n\n${res?.error || 'Erro interno.'}`);
        }
    } catch (err) {
        alert(`❌ Erro de rede: ${err.message}`);
    }
}

async function deleteHostingService(id, name) {
    if (!confirm(`⚠️ Atenção: Você tem certeza que deseja EXCLUIR o serviço "${name}"?\n\nEsta ação irá remover permanentemente a configuração do NGINX, apagar os arquivos de log e encerrar qualquer processo ativo associado.`)) {
        return;
    }

    try {
        const res = await safeFetch(`${API_BASE}/hosting/${id}`, 'DELETE');
        if (res?.success) {
            alert('✅ Serviço excluído com sucesso!');
            fetchHostingServices();
        } else {
            alert(`❌ Falha ao excluir serviço:\n\n${res?.error || 'Erro interno.'}`);
        }
    } catch (err) {
        alert(`❌ Erro de rede: ${err.message}`);
    }
}

function viewHostingLogs(id, name) {
    document.getElementById('logModalTitle').innerHTML = `📜 Logs em Tempo Real — ${name}`;
    const logsBody = document.getElementById('hostingLogsBody');
    logsBody.textContent = 'Buscando logs...';
    
    const logsModal = document.getElementById('hostingLogsModal');
    logsModal.classList.remove('hidden');
    lucide.createIcons();

    if (window.logInterval) clearInterval(window.logInterval);

    // Initial load
    fetch(`${API_BASE}/hosting/${id}/logs`)
        .then(r => r.text())
        .then(text => {
            logsBody.textContent = text;
            logsBody.scrollTop = logsBody.scrollHeight;
        });

    // Auto refresh logs every 3 seconds
    window.logInterval = setInterval(() => {
        fetch(`${API_BASE}/hosting/${id}/logs`)
            .then(r => r.text())
            .then(text => {
                logsBody.textContent = text;
                logsBody.scrollTop = logsBody.scrollHeight;
            });
    }, 3000);
}

function closeHostingLogsModal() {
    if (window.logInterval) {
        clearInterval(window.logInterval);
        window.logInterval = null;
    }
    const logsModal = document.getElementById('hostingLogsModal');
    if (logsModal) logsModal.classList.add('hidden');
}

// ============================================================
//  START
// ============================================================
document.addEventListener('DOMContentLoaded', runBootSequence);
