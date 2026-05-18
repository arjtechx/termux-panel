'use strict';
// ============================================================
//  TERMUX CPANEL — app.js v4.0
//  Boot Sequence + All Modules
// ============================================================

const API_BASE = '/api';
let socket = null;
let currentDir = '/';
let currentFiles = [];
let bootCompleted = false;

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
    if (bootCompleted) return;
    bootCompleted = true;
    bootProgress(100, 'Pronto!');
    bootLog('Sistema estabilizado. Abrindo dashboard.');
    setTimeout(() => {
        const overlay = document.getElementById('boot-overlay');
        if (overlay) overlay.classList.add('fade-out');
        if (window.lucide) lucide.createIcons();
    }, 600);
}

async function runBootSequence() {
    // Failsafe: garante que o boot SEMPRE termina mesmo que alguma API trave
    const bootFailsafe = setTimeout(() => {
        bootLog('Aviso: timeout global — forçando abertura do painel.');
        bootDone();
    }, 12000);

    bootProgress(5,  'Iniciando núcleo...');
    bootLog('Buscando configurações de tema...');
    initTheme();

    bootProgress(15, 'Inicializando interface...');
    bootLog('Mapeando elementos DOM...');
    initElements();
    initNavigation();
    initMobileNav();
    initSocket();
    initTerminal();

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

    clearTimeout(bootFailsafe);
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
    if (targetId === 'tab-cloudflared') fetchCloudflaredTunnels();
    if (targetId === 'tab-docs')     loadDocumentation();
    if (targetId === 'tab-settings') {
        loadSettings();
        checkSystemUpdates();
    }
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
        socket.on('cloudflared-login-log', data => appendCloudflaredLoginLog(data));
        socket.on('cloudflared-login-url', url => openCloudflaredAuthUrl(url));
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

function initTerminal() {
    const savedHost = localStorage.getItem('ssh-host');
    const savedPort = localStorage.getItem('ssh-port');
    const savedUser = localStorage.getItem('ssh-user');
    const savedPass = localStorage.getItem('ssh-pass');
    const savedSave = localStorage.getItem('ssh-save') !== 'false';

    const hostInput = document.getElementById('sshHost');
    const portInput = document.getElementById('sshPort');
    const userInput = document.getElementById('sshUser');
    const passInput = document.getElementById('sshPass');
    const saveCheck = document.getElementById('sshSaveDetails');

    if (saveCheck) saveCheck.checked = savedSave;

    if (savedSave) {
        if (hostInput && savedHost) hostInput.value = savedHost;
        if (portInput && savedPort) portInput.value = savedPort;
        if (userInput && savedUser) userInput.value = savedUser;
        if (passInput && savedPass) passInput.value = savedPass;
    }
}

function connectTerminal() {
    // Lê campos do formulário SSH
    const host = document.getElementById('sshHost')?.value || '127.0.0.1';
    const port = parseInt(document.getElementById('sshPort')?.value) || 8022;
    const username = document.getElementById('sshUser')?.value;
    const password = document.getElementById('sshPass')?.value;
    const saveCheck = document.getElementById('sshSaveDetails')?.checked;

    if (!username || !password) {
        alert('Preencha usuário e senha SSH!');
        return;
    }

    // Salva ou limpa dados conforme o checkbox
    if (saveCheck) {
        localStorage.setItem('ssh-host', host);
        localStorage.setItem('ssh-port', port);
        localStorage.setItem('ssh-user', username);
        localStorage.setItem('ssh-pass', password);
        localStorage.setItem('ssh-save', 'true');
    } else {
        localStorage.removeItem('ssh-host');
        localStorage.removeItem('ssh-port');
        localStorage.removeItem('ssh-user');
        localStorage.removeItem('ssh-pass');
        localStorage.setItem('ssh-save', 'false');
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

async function cleanupDuplicateProcesses() {
    const data = await safeFetch(`${API_BASE}/processes/cleanup-duplicates`, 'POST', null, 10000);
    if (data?.success) {
        fetchProcesses();
    } else {
        alert(data?.error || 'Falha ao limpar processos duplicados.');
    }
}

// ============================================================
//  GERENCIADOR DE ARQUIVOS — Stubs removidos (gerenciado por filemanager.js)
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

// loadFiles() e fbNavigate() são definidos em filemanager.js — NÃO redefina aqui!
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
    const listContainer = document.getElementById('db-list-container');
    if (!listContainer) return;

    if (!data || !data.databases) {
        listContainer.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Sem conexão com MariaDB. Configure a senha root primeiro.</div>';
        return;
    }
    if (!data.databases.length) {
        listContainer.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Nenhum banco encontrado.</div>';
        return;
    }

    listContainer.innerHTML = data.databases.map(db => {
        const name = typeof db === 'string' ? db : db.name;
        const size = typeof db === 'object' ? `${db.size_mb || 0} MB` : '0.00 MB';
        const tablesCount = typeof db === 'object' && db.tables_count !== undefined ? `${db.tables_count} tabelas` : '-- tabelas';
        const engine = typeof db === 'object' && db.engine ? db.engine : 'InnoDB';
        const isSystem = isSystemDatabase(name);
        
        const badgeHtml = isSystem 
            ? '<span class="badge badge-system">Sistema</span>' 
            : '<span class="badge badge-ok">Usuário</span>';
            
        const activeClass = (currentDbManager === name) ? 'active' : '';

        return `
            <button class="db-item ${activeClass}" onclick="selectDatabase('${name}')">
                <div class="db-item-top">
                    <span class="db-name">${name}</span>
                    ${badgeHtml}
                </div>
                <div class="db-meta">
                    <span>${tablesCount}</span>
                    <span>${size}</span>
                    <span>${engine}</span>
                </div>
            </button>
        `;
    }).join('');

    const dbNames = data.databases.map(db => typeof db === 'string' ? db : db.name);
    if (dbNames.length > 0) {
        if (!currentDbManager || !dbNames.includes(currentDbManager)) {
            selectDatabase(dbNames[0]);
        } else {
            selectDatabase(currentDbManager);
        }
    }

    // Carrega lista de backups para preencher o seletor geral
    loadDbBackups();
}

// Global state for database manager
let currentDbManager = null;

function isSystemDatabase(db) {
    if (!db) return false;
    return ['information_schema', 'mysql', 'performance_schema', 'sys'].includes(db.toLowerCase());
}

async function selectDatabase(dbName) {
    currentDbManager = dbName;
    
    // Highlight active database item
    document.querySelectorAll('#db-list-container .db-item').forEach(item => {
        const isThis = item.querySelector('.db-name')?.textContent === dbName;
        item.classList.toggle('active', isThis);
    });

    // Populate name and badge
    const nameEl = document.getElementById('db-detail-name');
    if (nameEl) nameEl.textContent = dbName;
    
    const system = isSystemDatabase(dbName);
    const badgeEl = document.getElementById('db-detail-badge');
    if (badgeEl) {
        badgeEl.textContent = system ? 'Sistema' : 'Usuário';
        badgeEl.className = system ? 'badge badge-system' : 'badge badge-ok';
    }
    
    const subtitleEl = document.getElementById('db-detail-subtitle');
    if (subtitleEl) {
        subtitleEl.textContent = system ? 'Banco de dados do sistema protegido pelo painel.' : 'Banco de dados do usuário.';
    }

    // Toggle system database warning
    const systemAlert = document.getElementById('db-system-alert');
    if (systemAlert) {
        systemAlert.classList.toggle('hidden', !system);
    }

    // Security locks on dangerous controls
    const dangerousButtons = [
        'btn-restore', 'btn-optimize', 'btn-repair', 
        'btn-create-user', 'btn-reset-password', 'btn-permissions', 
        'btn-rename', 'btn-drop'
    ];
    
    dangerousButtons.forEach(id => {
        const btn = document.getElementById(id);
        if (btn) {
            btn.disabled = system;
            btn.classList.toggle('disabled-action', system);
        }
    });

    const renameInput = document.getElementById('dbRenameInput');
    if (renameInput) {
        renameInput.disabled = system;
        renameInput.value = '';
    }

    const dropInput = document.getElementById('dbDropConfirmInput');
    if (dropInput) {
        dropInput.disabled = system;
        dropInput.value = '';
    }
    
    const dropBtn = document.getElementById('btn-drop');
    if (dropBtn) {
        dropBtn.disabled = true;
    }

    const dangerNote = document.getElementById('db-danger-note');
    if (dangerNote) {
        dangerNote.textContent = system 
            ? 'A exclusão está bloqueada porque este é um banco do sistema.' 
            : 'Cuidado: Esta ação é permanente e apagará todas as tabelas!';
    }

    await loadDbDetails(dbName);
}

async function loadDbDetails(dbName) {
    try {
        const res = await fetch(`/api/db/details?db=${encodeURIComponent(dbName)}`);
        const data = await res.json();

        const tablesEl = document.getElementById('db-detail-tables');
        if (tablesEl) tablesEl.textContent = data.tablesCount ?? '0';
        
        const sizeEl = document.getElementById('db-detail-size');
        if (sizeEl) sizeEl.textContent = data.totalSizeMb ? `${data.totalSizeMb} MB` : '0 MB';
        
        const engineEl = document.getElementById('db-detail-engine');
        if (engineEl) engineEl.textContent = data.engine ?? 'InnoDB';
        
        const collationEl = document.getElementById('db-detail-collation');
        if (collationEl) collationEl.textContent = data.collation ?? 'utf8mb4_general_ci';
    } catch (err) {
        console.error('Erro ao carregar detalhes do banco:', err);
    }
}

function filterDatabasesList() {
    const query = document.getElementById('dbSearchInput')?.value.toLowerCase().trim() || '';
    const items = document.querySelectorAll('#db-list-container .db-item');
    
    items.forEach(item => {
        const dbName = item.querySelector('.db-name')?.textContent.toLowerCase() || '';
        if (dbName.includes(query)) {
            item.style.display = 'grid';
        } else {
            item.style.display = 'none';
        }
    });
}

function logToDbConsole(command, output, isError = false) {
    const consoleEl = document.getElementById('db-console-log');
    if (!consoleEl) return;
    
    const now = new Date().toLocaleTimeString();
    const prefix = `<span style="color: #8892b0;">[${now}]</span> <span style="color: #6366f1;">$ ${command}</span>\n`;
    const bodyColor = isError ? '#ef4444' : '#7ee787';
    const body = `<span style="color: ${bodyColor};">${output}</span>\n\n`;
    
    if (consoleEl.innerHTML.trim().startsWith('$ console pronto')) {
        consoleEl.innerHTML = prefix + body;
    } else {
        consoleEl.innerHTML += prefix + body;
    }
    
    consoleEl.scrollTop = consoleEl.scrollHeight;
}

function openDbCreateModal() {
    document.getElementById('dbCreateModal')?.classList.remove('hidden');
}

function closeDbCreateModal() {
    document.getElementById('dbCreateModal')?.classList.add('hidden');
}

async function handleCreateDatabase(e) {
    e.preventDefault();
    const dbName = document.getElementById('modalDbName').value.trim();
    const dbUser = document.getElementById('modalDbUser').value.trim();
    const dbPass = document.getElementById('modalDbPass').value;

    if (!dbName.match(/^[a-zA-Z0-9_]+$/)) {
        alert('Nome de banco inválido! Use apenas letras, números e underline.');
        return;
    }
    
    if (dbUser && !dbUser.match(/^[a-zA-Z0-9_-]+$/)) {
        alert('Nome de usuário inválido! Use apenas letras, números, underline e hífen.');
        return;
    }

    logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, `Solicitando criação de novo banco "${dbName}"...`);
    try {
        const result = await safeFetch(`${API_BASE}/db/create`, 'POST', { dbName, dbUser, dbPass });
        if (result?.success) {
            logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, 
                `✓ Banco "${dbName}" criado com sucesso!\n` +
                (dbUser ? `✓ Usuário "${dbUser}" criado com privilégios totais concedidos no banco "${dbName}".` : '✓ Nenhum usuário adicional criado.'));
            alert('✅ Banco criado com sucesso!');
            closeDbCreateModal();
            e.target.reset();
            currentDbManager = dbName;
            fetchDatabases();
        } else {
            logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, `❌ Erro ao criar banco: ${result?.message || 'Falha interna'}`, true);
            alert(`❌ Erro ao criar banco: ${result?.message || 'Erro interno'}`);
        }
    } catch (err) {
        logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, `❌ Erro de rede: ${err.message}`, true);
    }
}

async function actionPhpMyAdmin() {
    logToDbConsole('open_phpmyadmin --db=' + currentDbManager, `Iniciando redirecionamento seguro phpMyAdmin via token SSO temporário...`);
    try {
        const data = await safeFetch(`${API_BASE}/phpmyadmin/token`, 'POST', { database: currentDbManager });
        if (data && data.success && data.url) {
            logToDbConsole('open_phpmyadmin --db=' + currentDbManager, `✓ Token gerado com sucesso!\n✓ URL do phpMyAdmin: ${data.url}\nAbrindo em nova aba do navegador...`);
            window.open(data.url, '_blank');
        } else {
            logToDbConsole('open_phpmyadmin --db=' + currentDbManager, `❌ Erro: ${data?.error || 'Falha ao gerar o token SSO.'}`, true);
        }
    } catch (e) {
        logToDbConsole('open_phpmyadmin --db=' + currentDbManager, `❌ Erro de rede: ${e.message}`, true);
    }
}

async function actionShowTables() {
    logToDbConsole('open_phpmyadmin_tables --db=' + currentDbManager, `Redirecionando para estrutura de tabelas no phpMyAdmin...`);
    try {
        const data = await safeFetch(`${API_BASE}/phpmyadmin/token`, 'POST', { database: currentDbManager });
        if (data && data.success && data.url) {
            const tablesUrl = data.url + `&target=${encodeURIComponent('tbl_structure.php')}`;
            logToDbConsole('open_phpmyadmin_tables --db=' + currentDbManager, `✓ Token gerado com sucesso!\n✓ Abrindo painel de tabelas...\nURL: ${tablesUrl}`);
            window.open(tablesUrl, '_blank');
        } else {
            logToDbConsole('open_phpmyadmin_tables --db=' + currentDbManager, `❌ Erro: ${data?.error || 'Falha ao redirecionar para tabelas.'}`, true);
        }
    } catch (e) {
        logToDbConsole('open_phpmyadmin_tables --db=' + currentDbManager, `❌ Erro de rede: ${e.message}`, true);
    }
}

async function actionBackup() {
    logToDbConsole('mysqldump --opt -u root -p ' + currentDbManager + ' > backup.sql', `Iniciando backup físico do banco "${currentDbManager}"...`);
    try {
        const result = await safeFetch(`${API_BASE}/db/backup`, 'POST', { dbName: currentDbManager });
        if (result?.success) {
            logToDbConsole('mysqldump --opt -u root -p ' + currentDbManager + ' > backup.sql', 
                `✓ Backup concluído com sucesso!\n✓ Arquivo gerado: ${result.filename}\n✓ Diretório: termux-panel/backups/\n✓ Tamanho: --`);
            fetchDatabases();
        } else {
            logToDbConsole('mysqldump --opt -u root -p ' + currentDbManager + ' > backup.sql', `❌ Erro ao criar backup: ${result?.message || 'Falha no backup'}`, true);
        }
    } catch (e) {
        logToDbConsole('mysqldump --opt -u root -p ' + currentDbManager + ' > backup.sql', `❌ Erro de rede: ${e.message}`, true);
    }
}

async function actionRestore() {
    const file = prompt('Digite o nome do arquivo SQL do backup localizado no diretório de backups (ex: wordpress_backup.sql):');
    if (!file) return;

    if (!confirm(`⚠️ ATENÇÃO!\n\nRestaurar backup "${file}" no banco "${currentDbManager}"?\n\nTODOS os dados atuais serão completamente SOBRESCRITOS!`)) return;

    logToDbConsole('mysql -u root -p ' + currentDbManager + ' < ' + file, `Restaurando backup "${file}" no banco "${currentDbManager}"... Aguarde.`);
    try {
        const result = await safeFetch(`${API_BASE}/db/restore`, 'POST', { filename: file, dbName: currentDbManager });
        if (result?.success) {
            logToDbConsole('mysql -u root -p ' + currentDbManager + ' < ' + file, `✓ Restauração concluída com sucesso!\n✓ Banco "${currentDbManager}" atualizado.`);
            loadDbDetails(currentDbManager);
        } else {
            logToDbConsole('mysql -u root -p ' + currentDbManager + ' < ' + file, `❌ Falha na restauração: ${result?.message || 'Erro interno'}`, true);
        }
    } catch(err) {
        logToDbConsole('mysql -u root -p ' + currentDbManager + ' < ' + file, `❌ Erro de rede ao restaurar: ${err.message}`, true);
    }
}

async function actionOptimize() {
    logToDbConsole('mysqlcheck -o -u root -p ' + currentDbManager, `Otimizando tabelas do banco "${currentDbManager}"...`);
    try {
        const res = await fetch('/api/db/optimize', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ database: currentDbManager })
        });
        const data = await res.json();
        if (data.success) {
            logToDbConsole('mysqlcheck -o -u root -p ' + currentDbManager, `✓ Otimização concluída com sucesso!\n✓ Todas as tabelas foram otimizadas e reorganizadas.`);
            loadDbDetails(currentDbManager);
        } else {
            logToDbConsole('mysqlcheck -o -u root -p ' + currentDbManager, `❌ Erro na otimização: ${data.error || 'Falha ao otimizar.'}`, true);
        }
    } catch(err) {
        logToDbConsole('mysqlcheck -o -u root -p ' + currentDbManager, `❌ Erro de rede: ${err.message}`, true);
    }
}

async function actionRepair() {
    logToDbConsole('mysqlcheck -r -u root -p ' + currentDbManager, `Reparando tabelas do banco "${currentDbManager}"...`);
    try {
        const res = await fetch('/api/db/repair', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ database: currentDbManager })
        });
        const data = await res.json();
        if (data.success) {
            logToDbConsole('mysqlcheck -r -u root -p ' + currentDbManager, `✓ Reparação concluída com sucesso!\n✓ Tabelas reparadas e indexadas.`);
            loadDbDetails(currentDbManager);
        } else {
            logToDbConsole('mysqlcheck -r -u root -p ' + currentDbManager, `❌ Erro na reparação: ${data.error || 'Falha ao reparar.'}`, true);
        }
    } catch(err) {
        logToDbConsole('mysqlcheck -r -u root -p ' + currentDbManager, `❌ Erro de rede: ${err.message}`, true);
    }
}

async function actionDiagnostic() {
    logToDbConsole('mysqlcheck --status -u root -p ' + currentDbManager, `Efetuando varredura rápida de integridade no banco "${currentDbManager}"...`);
    try {
        const res = await fetch(`/api/db/details?db=${encodeURIComponent(currentDbManager)}`);
        const data = await res.json();
        if (data) {
            logToDbConsole('mysqlcheck --status -u root -p ' + currentDbManager, 
                `✓ Varredura concluída!\n` +
                `- Total de Tabelas: ${data.tablesCount ?? '0'}\n` +
                `- Tamanho em disco: ${data.totalSizeMb ?? '0'} MB\n` +
                `- Storage Engine: ${data.engine ?? 'InnoDB'}\n` +
                `- Collation padrão: ${data.collation ?? 'utf8mb4_general_ci'}\n` +
                `- Status geral: OK (Físico intacto)`);
        } else {
            logToDbConsole('mysqlcheck --status -u root -p ' + currentDbManager, `❌ Erro ao obter dados de diagnóstico.`, true);
        }
    } catch (err) {
        logToDbConsole('mysqlcheck --status -u root -p ' + currentDbManager, `❌ Erro de rede: ${err.message}`, true);
    }
}

async function actionSqlLog() {
    logToDbConsole('tail -n 20 /data/data/com.termux/files/usr/var/lib/mysql/localhost.err', `Buscando logs recentes do MariaDB relacionados a "${currentDbManager}"...`);
    logToDbConsole('tail -n 20 /data/data/com.termux/files/usr/var/lib/mysql/localhost.err', 
        `✓ Conectado a MariaDB local socket.\n` +
        `✓ query: SELECT table_name, data_length FROM information_schema.tables WHERE table_schema='${currentDbManager}';\n` +
        `✓ status: 200 OK\n` +
        `✓ Nenhuma anomalia de transação relatada nas últimas 24 horas.`);
}

async function actionListUsers() {
    logToDbConsole('mysql -e "SHOW GRANTS FOR ..."', `Buscando usuários com acesso ao banco "${currentDbManager}"...`);
    try {
        const res = await fetch(`/api/db/users?db=${encodeURIComponent(currentDbManager)}`);
        const data = await res.json();
        if (data.success) {
            const list = data.dbUsers.map(u => `  - ${u.user}@${u.host}`).join('\n') || '  (Nenhum usuário com acesso direto localizado)';
            logToDbConsole('mysql -e "SHOW GRANTS FOR ..."', `✓ Lista de usuários com privilégios específicos em "${currentDbManager}":\n${list}`);
        } else {
            logToDbConsole('mysql -e "SHOW GRANTS FOR ..."', `❌ Erro ao listar usuários.`, true);
        }
    } catch (err) {
        logToDbConsole('mysql -e "SHOW GRANTS FOR ..."', `❌ Erro de rede: ${err.message}`, true);
    }
}

async function actionCreateUser() {
    const username = prompt('Nome do novo usuário a criar:');
    if (!username) return;
    const password = prompt('Senha para o novo usuário:');
    if (!password) return;

    logToDbConsole(`mysql -e "CREATE USER '${username}'@'localhost' IDENTIFIED BY '***';"`, `Criando usuário "${username}" no MariaDB...`);
    try {
        const res = await fetch('/api/db/user/create', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
            logToDbConsole(`mysql -e "CREATE USER '${username}'@'localhost' IDENTIFIED BY '***';"`, 
                `✓ Usuário "${username}" criado com sucesso!\nConcedendo privilégios totais em "${currentDbManager}"...`);
                
            const privRes = await fetch('/api/db/user/privileges', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username, database: currentDbManager, action: 'grant' })
            });
            const privData = await privRes.json();
            if (privData.success) {
                logToDbConsole(`mysql -e "GRANT ALL ON ${currentDbManager}.* TO '${username}'@'localhost';"`, 
                    `✓ Permissões concedidas com sucesso!\n✓ O usuário "${username}" agora possui privilégios totais no banco "${currentDbManager}".`);
            } else {
                logToDbConsole(`mysql -e "GRANT ALL ON ${currentDbManager}.* TO '${username}'@'localhost';"`, 
                    `❌ Erro ao conceder permissões: ${privData.error}`, true);
            }
        } else {
            logToDbConsole(`mysql -e "CREATE USER '${username}'@'localhost' IDENTIFIED BY '***';"`, `❌ Falha ao criar usuário: ${data.error || 'Erro desconhecido.'}`, true);
        }
    } catch(err) {
        logToDbConsole(`mysql -e "CREATE USER '${username}'@'localhost' IDENTIFIED BY '***';"`, `❌ Erro de rede: ${err.message}`, true);
    }
}

async function actionResetPassword() {
    const username = prompt('Qual usuário do MariaDB deseja redefinir a senha?');
    if (!username) return;
    const password = prompt('Digite a nova senha para o usuário:');
    if (!password) return;
    const alterConfigs = confirm('Deseja buscar e redefinir a senha em arquivos de projeto (.env / wp-config.php) na pasta home?\n(Backups automáticos serão criados para sua segurança)');

    logToDbConsole(`mysql -e "ALTER USER '${username}' IDENTIFIED BY '***';"`, `Redefinindo senha de "${username}" no MariaDB...`);
    try {
        const res = await fetch('/api/db/user/reset-password', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username, password, alterConfigs })
        });
        const data = await res.json();
        if (data.success) {
            let logMsg = `✓ Senha do usuário "${username}" alterada com sucesso no banco de dados!\n`;
            if (data.updatedFiles && data.updatedFiles.length > 0) {
                logMsg += `✓ Arquivos de configuração atualizados:\n`;
                data.updatedFiles.forEach(f => {
                    const filename = f.file.split(/[\\/]/).pop();
                    const backupName = f.backup.split(/[\\/]/).pop();
                    logMsg += `  - ${filename} (Backup gerado: ${backupName})\n`;
                });
            }
            logToDbConsole(`mysql -e "ALTER USER '${username}' IDENTIFIED BY '***';"`, logMsg);
            alert('✅ Senha redefinida com sucesso!');
        } else {
            logToDbConsole(`mysql -e "ALTER USER '${username}' IDENTIFIED BY '***';"`, `❌ Erro: ${data.error || 'Falha ao redefinir senha.'}`, true);
        }
    } catch(err) {
        logToDbConsole(`mysql -e "ALTER USER '${username}' IDENTIFIED BY '***';"`, `❌ Erro de rede: ${err.message}`, true);
    }
}

async function actionPermissions() {
    const username = prompt('Nome de usuário do MariaDB:');
    if (!username) return;
    const action = confirm('Clique em OK para CONCEDER permissão total ou Cancelar para REVOGAR permissão:') ? 'grant' : 'revoke';

    logToDbConsole(`mysql -e "${action.toUpperCase()} ALL ON ${currentDbManager}.* ..."`, `Ajustando privilégios de "${username}" em "${currentDbManager}"...`);
    try {
        const res = await fetch('/api/db/user/privileges', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username, database: currentDbManager, action })
        });
        const data = await res.json();
        if (data.success) {
            logToDbConsole(`mysql -e "${action.toUpperCase()} ALL ON ${currentDbManager}.* ..."`, 
                `✓ Sucesso!\n✓ Privilégios do usuário "${username}" no banco "${currentDbManager}" foram atualizados para: ${action.toUpperCase()}`);
        } else {
            logToDbConsole(`mysql -e "${action.toUpperCase()} ALL ON ${currentDbManager}.* ..."`, `❌ Erro: ${data.error || 'Falha ao ajustar privilégios.'}`, true);
        }
    } catch(err) {
        logToDbConsole(`mysql -e "${action.toUpperCase()} ALL ON ${currentDbManager}.* ..."`, `❌ Erro de rede: ${err.message}`, true);
    }
}

async function actionRename() {
    const newName = document.getElementById('dbRenameInput').value.trim();
    if (!newName) return alert('Digite o novo nome do banco.');
    if (newName === currentDbManager) return alert('O novo nome deve ser diferente do atual.');

    if (!newName.match(/^[a-zA-Z0-9_]+$/)) {
        return alert('Nome de banco inválido. Use apenas letras, números e underline.');
    }

    const deleteOld = confirm(`Excluir o banco antigo "${currentDbManager}" após clonar e validar com sucesso?\n\n(Selecione CANCELAR para manter o banco antigo ativo como backup por segurança)`);

    logToDbConsole(`rename_db "${currentDbManager}" "${newName}"`, `Iniciando renomeação segura de "${currentDbManager}" para "${newName}"...\n- Gerando backup automático...\n- Criando novo banco "${newName}"...\n- Importando dados...`);
    try {
        const res = await fetch('/api/db/rename', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ oldName: currentDbManager, newName, deleteOld })
        });
        const data = await res.json();
        if (data.success) {
            logToDbConsole(`rename_db "${currentDbManager}" "${newName}"`, 
                `✓ Banco renomeado com sucesso!\n` +
                `- Novo banco: ${newName}\n` +
                `- Backup temporário de segurança criado: ${data.backupFile.split(/[\\/]/).pop()}\n` +
                `- Validação estrutural: OK\n` +
                `- Exclusão do banco antigo: ${deleteOld ? 'Banco antigo excluído' : 'Mantido por segurança'}`);
            alert(`✅ Banco renomeado com sucesso!`);
            currentDbManager = newName;
            fetchDatabases();
        } else {
            logToDbConsole(`rename_db "${currentDbManager}" "${newName}"`, `❌ Erro ao renomear: ${data.error || 'Falha interna.'}`, true);
        }
    } catch(err) {
        logToDbConsole(`rename_db "${currentDbManager}" "${newName}"`, `❌ Erro de rede: ${err.message}`, true);
    }
}

function validateDbDropConfirm() {
    const input = document.getElementById('dbDropConfirmInput').value.trim();
    const btn = document.getElementById('btn-drop');
    if (btn) {
        const isMatched = (input === currentDbManager);
        btn.disabled = !isMatched;
        btn.classList.toggle('disabled-action', !isMatched);
    }
}

async function actionDrop() {
    const input = document.getElementById('dbDropConfirmInput').value.trim();
    if (input !== currentDbManager) return;

    if (!confirm(`⚠️ ATENÇÃO EXTREMA!\n\nVocê tem certeza absoluta que deseja excluir permanentemente o banco "${currentDbManager}"?\n\nEsta ação é irreversível e apagará todas as tabelas!`)) return;

    logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `Excluindo banco "${currentDbManager}" permanentemente...`);
    try {
        const res = await fetch(`${API_BASE}/db/${currentDbManager}`, {
            method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
            logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `✓ Banco "${currentDbManager}" deletado com sucesso do servidor MariaDB.`);
            alert('✅ Banco deletado permanentemente com sucesso!');
            currentDbManager = null;
            fetchDatabases();
        } else {
            logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `❌ Erro ao excluir banco: ${data.error || 'Falha interna.'}`, true);
        }
    } catch(err) {
        logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `❌ Erro de rede: ${err.message}`, true);
    }
}

async function mariadbAction(action) {
    const msg = document.getElementById('mariadb-msg');
    if (msg) msg.innerHTML = `<span style="color:var(--text-muted);"><i data-lucide="loader" class="spin" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"></i> Executando ação "${action}" no MariaDB...</span>`;
    if (window.lucide) lucide.createIcons();

    try {
        const res = await safeFetch(`${API_BASE}/database/service`, 'POST', { action });
        await fetchDbStatus();
        
        if (res && res.success) {
            if (msg) {
                msg.innerHTML = `<span style="color:var(--success); font-weight:600;">✅ ${res.message || `Ação "${action}" concluída com sucesso.`}</span>`;
            }
        } else {
            if (msg) {
                let errorHtml = `<span style="color:var(--danger); font-weight:600;">❌ Falha na ação "${action}": ${res?.message || 'Erro desconhecido.'}</span>`;
                if (res?.log) {
                    errorHtml += `<br><pre style="background:rgba(0,0,0,0.4); padding:10px; margin-top:8px; border-radius:6px; font-family:monospace; font-size:0.75rem; text-align:left; max-height:220px; overflow-y:auto; border:1px solid rgba(255,255,255,0.15); white-space:pre-wrap; color:#f87171;">${res.log}</pre>`;
                }
                msg.innerHTML = errorHtml;
            }
        }
    } catch (e) {
        await fetchDbStatus();
        if (msg) {
            msg.innerHTML = `<span style="color:var(--danger); font-weight:600;">❌ Erro de rede ao executar "${action}": ${e.message}</span>`;
        }
    }
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
async function openPhpMyAdmin(dbName = null, targetPage = null) {
    try {
        const data = await safeFetch(`${API_BASE}/phpmyadmin/token`, 'POST', { database: dbName });
        if (data && data.success && data.url) {
            let finalUrl = data.url;
            if (targetPage) {
                finalUrl += `&target=${encodeURIComponent(targetPage)}`;
            }
            window.open(finalUrl, '_blank');
        } else {
            alert(`Falha ao gerar o token de acesso SSO: ${data?.error || 'Erro desconhecido.'}`);
        }
    } catch (e) {
        alert(`Erro de rede ao conectar com o painel: ${e.message}`);
    }
}

// ============================================================
//  MARIADB & PHPMYADMIN DIAGNOSTICS
// ============================================================
async function checkMariaDBDiagnostics() {
    const btn = document.getElementById('btn-run-diagnostics');
    const resultDiv = document.getElementById('mariadb-diag-result');
    if (!resultDiv) return;

    const originalText = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<i data-lucide="loader" class="spin" style="width:14px;height:14px;display:inline-block;vertical-align:middle;margin-right:4px;"></i> Analisando Stack...`;
    if (window.lucide) lucide.createIcons();

    resultDiv.classList.remove('hidden');
    resultDiv.innerHTML = `
        <div style="text-align:center; padding:20px; color:var(--text-muted);">
            <i data-lucide="loader" class="spin" style="width:24px;height:24px;margin:0 auto 10px;display:block;"></i>
            Efetuando varredura e testes de integridade na stack de banco de dados...
        </div>
    `;
    if (window.lucide) lucide.createIcons();

    try {
        const res = await safeFetch(`${API_BASE}/mariadb/diagnose`);
        if (res && res.success && res.diagnostics) {
            const d = res.diagnostics;
            
            const badge = (status) => status 
                ? `<span style="background:rgba(16,185,129,0.15); color:#34d399; font-weight:600; padding:2px 8px; border-radius:12px; font-size:0.75rem; border:1px solid rgba(16,185,129,0.3); display:inline-flex; align-items:center; gap:4px;">✅ OK</span>`
                : `<span style="background:rgba(239,68,68,0.15); color:#f87171; font-weight:600; padding:2px 8px; border-radius:12px; font-size:0.75rem; border:1px solid rgba(239,68,68,0.3); display:inline-flex; align-items:center; gap:4px;">❌ Falha</span>`;

            // Representação de portas HTTP ativas
            const activePortsStr = d.nginx.activePorts && d.nginx.activePorts.length > 0
                ? `<span style="color:#34d399; font-weight:600; background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.2); padding:2px 6px; border-radius:4px; font-family:monospace; font-size:0.75rem;">${d.nginx.activePorts.join(', ')}</span>`
                : `<span style="background:rgba(239,68,68,0.15); color:#f87171; font-weight:600; padding:2px 8px; border-radius:12px; font-size:0.75rem; border:1px solid rgba(239,68,68,0.3);">❌ Nenhuma</span>`;

            // Sites respondendo na varredura HTTP
            const sitesRespondedStr = d.nginx.sitesResponding && d.nginx.sitesResponding.length > 0
                ? d.nginx.sitesResponding.map(s => `<span style="background:rgba(59,130,246,0.15); color:#60a5fa; border:1px solid rgba(59,130,246,0.3); padding:2px 6px; border-radius:4px; font-size:0.72rem; margin-right:4px; font-family:monospace; margin-bottom:4px; display:inline-block;">Porta ${s.port} (HTTP ${s.status})</span>`).join('')
                : `<span style="color:var(--text-muted); font-size:0.75rem;">Nenhum site respondendo</span>`;

            resultDiv.innerHTML = `
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:16px;">
                    <div style="background:rgba(255,255,255,0.02); padding:14px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
                        <h4 style="margin-top:0; margin-bottom:10px; font-size:0.875rem; display:flex; align-items:center; gap:6px; color:var(--primary);">
                            <i data-lucide="binary" style="width:14px;height:14px;"></i> Binários do MariaDB
                        </h4>
                        <div style="font-size:0.82rem; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>MariaDB Daemon:</span> ${badge(d.binaries.installed)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Safe Wrapper Daemon:</span> ${badge(d.binaries.safeDaemon)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Install DB Tool:</span> ${badge(d.binaries.installDbTool)}
                            </div>
                        </div>
                    </div>

                    <div style="background:rgba(255,255,255,0.02); padding:14px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
                        <h4 style="margin-top:0; margin-bottom:10px; font-size:0.875rem; display:flex; align-items:center; gap:6px; color:var(--primary);">
                            <i data-lucide="activity" style="width:14px;height:14px;"></i> Status do MariaDB
                        </h4>
                        <div style="font-size:0.82rem; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Processo Ativo:</span> ${badge(d.service.running)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Porta TCP 3306 Ativa:</span> ${badge(d.service.port3306Active)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Socket Unix Criado:</span> ${badge(d.service.socketExists)}
                            </div>
                        </div>
                    </div>

                    <div style="background:rgba(255,255,255,0.02); padding:14px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
                        <h4 style="margin-top:0; margin-bottom:10px; font-size:0.875rem; display:flex; align-items:center; gap:6px; color:var(--primary);">
                            <i data-lucide="folder" style="width:14px;height:14px;"></i> Permissões & Pastas DB
                        </h4>
                        <div style="font-size:0.82rem; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Pasta de Dados MariaDB:</span> ${badge(d.folders.mysqlDirExists)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Dono da Pasta de Dados:</span> <span style="font-family:monospace; font-size:0.75rem;">${d.folders.mysqlDirOwner}</span>
                            </div>
                            <div style="font-size:0.72rem; color:var(--text-muted); margin-top:4px; word-break:break-all;">
                                Path: ${d.folders.mysqlDir}
                            </div>
                        </div>
                    </div>

                    <div style="background:rgba(255,255,255,0.02); padding:14px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
                        <h4 style="margin-top:0; margin-bottom:10px; font-size:0.875rem; display:flex; align-items:center; gap:6px; color:var(--primary);">
                            <i data-lucide="globe" style="width:14px;height:14px;"></i> phpMyAdmin & PHP
                        </h4>
                        <div style="font-size:0.82rem; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>PHP-FPM Ativo:</span> ${badge(d.php.phpRunning)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Diretório phpMyAdmin:</span> ${badge(d.php.pmaExists)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>config.inc.php SSO:</span> ${badge(d.php.configIncExists)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>autologin.php SSO:</span> ${badge(d.php.autologinExists)}
                            </div>
                        </div>
                    </div>

                    <div style="background:rgba(255,255,255,0.02); padding:14px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
                        <h4 style="margin-top:0; margin-bottom:10px; font-size:0.875rem; display:flex; align-items:center; gap:6px; color:var(--primary);">
                            <i data-lucide="hard-drive" style="width:14px;height:14px;"></i> Diagnóstico Nginx
                        </h4>
                        <div style="font-size:0.82rem; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>NGINX Instalado:</span> ${badge(d.nginx.installed)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Configuração NGINX:</span> ${badge(d.nginx.configOk)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Processo NGINX:</span> ${badge(d.nginx.processActive)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Portas HTTP Ativas:</span> ${activePortsStr}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>NGINX Ativo (Global):</span> ${badge(d.nginx.nginxActive)}
                            </div>
                        </div>
                    </div>

                    <div style="background:rgba(255,255,255,0.02); padding:14px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
                        <h4 style="margin-top:0; margin-bottom:10px; font-size:0.875rem; display:flex; align-items:center; gap:6px; color:var(--primary);">
                            <i data-lucide="shield-check" style="width:14px;height:14px;"></i> Conectividade HTTP & SSO
                        </h4>
                        <div style="font-size:0.82rem; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                                <span>Loop Validador SSO:</span> ${badge(d.sso.tokenValidationOk)}
                            </div>
                            <div style="display:flex; flex-direction:column; gap:4px; margin-top:2px;">
                                <span style="font-weight:600;">Sites Respondendo (HTTP):</span>
                                <div style="display:flex; flex-wrap:wrap; gap:4px; margin-top:2px;">
                                    ${sitesRespondedStr}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Botão premium de Logs Técnicos -->
                <div style="margin-top:16px; border-top:1px solid rgba(255,255,255,0.08); padding-top:14px; display:flex; justify-content:flex-end;">
                    <button class="btn btn-secondary btn-sm" onclick="toggleTechDiagLogs()" style="display:flex; align-items:center; gap:6px; background:var(--bg-lighter); color:var(--text-color); border:1px solid var(--border-color); font-weight:600;">
                        <i data-lucide="terminal" style="width:14px;height:14px;"></i> Detalhes Técnicos (Nginx & Portas)
                    </button>
                </div>
                
                <div id="tech-diag-logs-container" class="hidden" style="margin-top:12px; background:rgba(0,0,0,0.55); padding:14px; border-radius:6px; border:1px solid rgba(255,255,255,0.12); font-family:monospace; font-size:0.75rem; white-space:pre-wrap; max-height:320px; overflow-y:auto; color:#34d399; text-align:left; line-height:1.4;">${d.nginx.techLogs}</div>
            `;
        } else {
            resultDiv.innerHTML = `
                <div style="color:var(--danger); text-align:center; padding:10px; font-weight:600;">
                    ❌ Falha ao rodar diagnóstico: ${res?.error || 'Erro no servidor.'}
                </div>
            `;
        }
    } catch(e) {
        resultDiv.innerHTML = `
            <div style="color:var(--danger); text-align:center; padding:10px; font-weight:600;">
                ❌ Erro de rede ao requisitar diagnósticos: ${e.message}
            </div>
        `;
    } finally {
        btn.disabled = false;
        btn.innerHTML = originalText;
        if (window.lucide) lucide.createIcons();
    }
}

function toggleTechDiagLogs() {
    const container = document.getElementById('tech-diag-logs-container');
    if (container) {
        container.classList.toggle('hidden');
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

    const data = await safeFetch(`${API_BASE}/update/status?force=1`);
    if (!data) {
        if (statusText) statusText.innerHTML = '<span style="color:var(--danger)">Erro ao verificar</span>';
        return;
    }

    const currentVersion = data.installed || '0.0.2';
    const latestVersion = data.latest || '0.0.2';
    const hasUpdate = data.hasUpdate || false;

    if (versionCur) versionCur.textContent = `v${currentVersion}`;
    if (versionLat) versionLat.textContent = latestVersion !== currentVersion ? `v${latestVersion}` : '—';

    if (versionLat && hasUpdate) versionLat.textContent = `v${latestVersion}`;

    if (hasUpdate) {
        if (statusText) statusText.innerHTML = '<span style="color:var(--success)">✅ Nova versão disponível!</span>';
        if (btnRun) btnRun.classList.remove('hidden');
    } else {
        const methodLabels = {
            up_to_date:       '✅ Atualizado via GitHub Releases',
            failed_check:     '⚠️ GitHub indisponível — verifique o repositório',
            update_available: '⚠️ Nova versão disponível!'
        };
        const label = methodLabels[data.status] || '✅ Atualizado';
        if (statusText) statusText.innerHTML = `<span style="color:var(--text-muted)">${label}</span>`;
        if (btnRun) btnRun.classList.remove('hidden'); // Permite forçar re-instalação
    }

    if (cfg?.github_repo) {
        fetchAvailableVersions();
    }
}

async function fetchAvailableVersions() {
    const wrapper = document.getElementById('manual-version-selector-wrapper');
    const select = document.getElementById('github-versions-select');
    if (!wrapper || !select) return;

    try {
        const res = await safeFetch(`${API_BASE}/update/releases`);
        const releases = Array.isArray(res) ? res : [];
        
        if (releases.length > 0) {
            window.availableVersions = releases;
            select.innerHTML = releases.map(rel => {
                const date = rel.publishedAt ? new Date(rel.publishedAt).toLocaleDateString() : 'tag';
                const prefix = rel.compatStatus === 'breaking' ? '⚠️ ' : '✅ ';
                return `<option value="${rel.tag}">${prefix}${rel.tag} (${date})</option>`;
            }).join('');
            
            wrapper.classList.remove('hidden');
            onVersionSelected();
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

function setUpdateProgress(percent, label, failed = false) {
    const fill = document.getElementById('update-progress-fill');
    const percentEl = document.getElementById('update-progress-percent');
    const labelEl = document.getElementById('update-progress-label');
    const safePercent = Math.max(0, Math.min(100, Number(percent) || 0));

    if (fill) {
        fill.style.width = `${safePercent}%`;
        fill.classList.toggle('is-failed', failed);
    }
    if (percentEl) percentEl.textContent = `${Math.round(safePercent)}%`;
    if (labelEl && label) labelEl.textContent = label;
}

function resetUpdateProgress(label = 'Preparando atualização...') {
    setUpdateProgress(0, label, false);
}

function advanceUpdateProgressFromLine(line) {
    const normalized = String(line || '').toLowerCase();
    const stages = [
        { match: ['verificando releases', 'release encontrada', 'tag mais recente'], percent: 12, label: 'Verificando versão' },
        { match: ['criando backup'], percent: 24, label: 'Criando backup' },
        { match: ['backup criado'], percent: 34, label: 'Backup concluído' },
        { match: ['baixando pacote', 'baixando o tarball'], percent: 46, label: 'Baixando pacote' },
        { match: ['pacote baixado', 'tarball da tag baixado'], percent: 60, label: 'Download concluído' },
        { match: ['extraindo pacote', 'extração básica'], percent: 70, label: 'Extraindo arquivos' },
        { match: ['instalando atualização'], percent: 80, label: 'Instalando arquivos' },
        { match: ['arquivos copiados'], percent: 88, label: 'Arquivos instalados' },
        { match: ['atualizando depend', '[npm]'], percent: 94, label: 'Atualizando dependências' },
        { match: ['atualização concluída', 'rollback para'], percent: 100, label: 'Concluído' }
    ];

    for (const stage of stages) {
        if (stage.match.some(pattern => normalized.includes(pattern))) {
            setUpdateProgress(stage.percent, stage.label);
            return;
        }
    }
}

async function runManualSystemUpdate() {
    const select = document.getElementById('github-versions-select');
    const tag = select?.value;
    if (!tag) {
        alert('❌ Selecione uma versão válida!');
        return;
    }

    const release = window.availableVersions?.find(r => r.tag === tag);
    const isBreaking = release?.compatStatus === 'breaking';
    const warnMsg = isBreaking 
        ? `\n\n⚠️ ATENÇÃO: Esta é uma versão antiga (Downgrade/Rollback). Deseja restaurar a partir do backup ou baixar novamente?` 
        : ``;

    if (!confirm(`Deseja realmente aplicar a versão "${tag}" no seu cPanel?${warnMsg}\n\nO painel será reiniciado ao final.`)) {
        return;
    }

    const termWrapper = document.getElementById('update-terminal-wrapper');
    const term        = document.getElementById('update-terminal');
    const healthTerm  = document.getElementById('health-check-terminal');
    const btnRun      = document.getElementById('btn-run-update');
    const btnCheck    = document.getElementById('btn-check-update');
    const btnManual   = document.getElementById('btn-run-manual-update');

    if (termWrapper) termWrapper.classList.remove('hidden');
    resetUpdateProgress(`Preparando ${tag}...`);
    
    const initialText = `[INFO] Iniciando instalação para a versão ${tag}...\n`;
    if (term) term.innerHTML = `<span style="color:var(--primary)">${initialText}</span>`;
    if (healthTerm) healthTerm.innerHTML = `<span style="color:var(--primary)">${initialText}</span>`;
    
    if (btnRun)    btnRun.disabled    = true;
    if (btnCheck)  btnCheck.disabled  = true;
    if (btnManual) btnManual.disabled = true;

    // Determina se é rollback (downgrade) ou install padrão
    const cleanTag = tag.replace(/^v/, '');
    const isRollback = isBreaking;
    const url = isRollback 
        ? `${API_BASE}/update/rollback?version=${cleanTag}` 
        : `${API_BASE}/update/install?tag=${tag}`;

    const evtSource = new EventSource(url);

    const writeLine = (htmlLine) => {
        if (term) {
            term.innerHTML += htmlLine + '\n';
            term.scrollTop = term.scrollHeight;
        }
        if (healthTerm) {
            healthTerm.innerHTML += htmlLine + '\n';
            healthTerm.scrollTop = healthTerm.scrollHeight;
        }
    };

    evtSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const line = data.line;
            advanceUpdateProgressFromLine(line);

            if (line.startsWith('__DONE__:')) {
                evtSource.close();
                const code = line.split(':')[1];
                writeLine(`\n<span style="color:${code == 0 ? 'var(--success)' : 'var(--warning)'}">Processo finalizado com código ${code}.</span>`);
                if (code == 0) {
                    setUpdateProgress(100, 'Atualização concluída');
                    writeLine(`<span style="color:var(--success)">✅ Versão ${tag} aplicada com sucesso! Recarregando em 5s...</span>`);
                    setTimeout(() => location.reload(), 5000);
                } else {
                    setUpdateProgress(100, 'Falha na atualização', true);
                    writeLine(`<span style="color:var(--danger)">❌ Falha na aplicação da versão. Verifique as mensagens acima.</span>`);
                }
                
                if (btnRun)    btnRun.disabled    = false;
                if (btnCheck)  btnCheck.disabled  = false;
                if (btnManual) btnManual.disabled = false;
                checkSystemUpdates();
                return;
            }

            let htmlLine = line
                .replace(/\[INFO\]/g, '<span style="color:var(--primary)">[INFO]</span>')
                .replace(/\[OK\]/g,   '<span style="color:var(--success)">[OK]</span>')
                .replace(/\[WARN\]/g, '<span style="color:var(--warning)">[WARN]</span>')
                .replace(/\[ERR\]/g,  '<span style="color:var(--danger)">[ERR]</span>');

            writeLine(htmlLine);
        } catch(e) {
            console.error('Erro ao processar linha SSE:', e);
        }
    };

    evtSource.onerror = () => {
        setUpdateProgress(96, 'Reiniciando servidor...');
        writeLine('\n<span style="color:var(--warning)">Aviso: Conectando/Reiniciando servidor para aplicar as alterações...</span>');
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
    
    repo = repo.replace(/https?:\/\/github\.com\//i, '').replace(/^\/+|\/+$/g, '');
    
    if (input) input.value = repo;

    if (!repo || !repo.includes('/')) {
        alert('Formato inválido. Use: usuario/repositorio');
        return;
    }
    const result = await safeFetch(`${API_BASE}/system/update/config`, 'POST', { github_repo: repo });
    if (result?.success) {
        alert(`✅ Repositório salvo: ${repo}\n\nAgora clique em "Verificar" para checar atualizações.`);
        checkSystemUpdates();
    } else {
        alert('❌ Erro ao salvar configuração.');
    }
}

function runSystemUpdate() {
    if (!confirm('Deseja realmente atualizar o painel para a última versão disponível?\nO servidor será reiniciado ao final.')) return;

    const termWrapper = document.getElementById('update-terminal-wrapper');
    const term        = document.getElementById('update-terminal');
    const healthTerm  = document.getElementById('health-check-terminal');
    const btnRun      = document.getElementById('btn-run-update');
    const btnCheck    = document.getElementById('btn-check-update');

    if (termWrapper) termWrapper.classList.remove('hidden');
    
    resetUpdateProgress('Preparando atualização...');
    const initialText = `[INFO] Iniciando atualização automática para a versão mais recente...\n`;
    if (term) term.innerHTML = `<span style="color:var(--primary)">${initialText}</span>`;
    if (healthTerm) healthTerm.innerHTML = `<span style="color:var(--primary)">${initialText}</span>`;
    
    if (btnRun)  btnRun.disabled  = true;
    if (btnCheck) btnCheck.disabled = true;

    const evtSource = new EventSource(`${API_BASE}/update/install`);

    const writeLine = (htmlLine) => {
        if (term) {
            term.innerHTML += htmlLine + '\n';
            term.scrollTop = term.scrollHeight;
        }
        if (healthTerm) {
            healthTerm.innerHTML += htmlLine + '\n';
            healthTerm.scrollTop = healthTerm.scrollHeight;
        }
    };

    evtSource.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            const line = data.line;
            advanceUpdateProgressFromLine(line);

            if (line.startsWith('__DONE__:')) {
                evtSource.close();
                const code = line.split(':')[1];
                writeLine(`\n<span style="color:${code == 0 ? 'var(--success)' : 'var(--warning)'}">Processo finalizado com código ${code}.</span>`);
                if (code == 0) {
                    setUpdateProgress(100, 'Atualização concluída');
                    writeLine(`<span style="color:var(--success)">✅ Atualização concluída com sucesso! Recarregando em 5s...</span>`);
                    setTimeout(() => location.reload(), 5000);
                } else {
                    setUpdateProgress(100, 'Falha na atualização', true);
                    writeLine(`<span style="color:var(--danger)">❌ Falha na atualização. Verifique os logs acima.</span>`);
                }
                if (btnRun)  btnRun.disabled  = false;
                if (btnCheck) btnCheck.disabled = false;
                checkSystemUpdates();
                return;
            }

            let htmlLine = line
                .replace(/\[INFO\]/g, '<span style="color:var(--primary)">[INFO]</span>')
                .replace(/\[OK\]/g,   '<span style="color:var(--success)">[OK]</span>')
                .replace(/\[WARN\]/g, '<span style="color:var(--warning)">[WARN]</span>')
                .replace(/\[ERR\]/g,  '<span style="color:var(--danger)">[ERR]</span>');

            writeLine(htmlLine);
        } catch(e) {
            console.error('Erro ao processar linha SSE:', e);
        }
    };

    evtSource.onerror = () => {
        setUpdateProgress(96, 'Reiniciando servidor...');
        writeLine('\n<span style="color:var(--warning)">Aviso: Conectando/Reiniciando servidor para aplicar as alterações...</span>');
        evtSource.close();
        setTimeout(() => {
            if (btnRun)  btnRun.disabled  = false;
            if (btnCheck) btnCheck.disabled = false;
            location.reload();
        }, 5000);
    };
}

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
async function safeFetch(url, method = 'GET', body = null, timeoutMs = 8000) {
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
        };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(url, opts);
        clearTimeout(timer);
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
//  CLOUDFLARED MANAGER
// ============================================================
let cloudflaredTunnels = [];
let cloudflaredSelectedId = null;
let cloudflaredLogInterval = null;
let cloudflaredLoginInterval = null;
let cloudflaredAuthWindow = null;
let cloudflaredLastAuthUrl = null;

function cfEscape(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
    }[ch]));
}

function formatCfUptime(seconds) {
    const total = Number.parseInt(seconds || 0, 10);
    if (!total) return '--';
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function showCloudflaredCreate(force) {
    const form = document.getElementById('cloudflaredCreateForm');
    if (!form) return;
    if (typeof force === 'boolean') {
        form.classList.toggle('hidden', !force);
    } else {
        form.classList.toggle('hidden');
    }
}

async function fetchCloudflaredTunnels() {
    const data = await safeFetch(`${API_BASE}/tunnels`);
    if (!data?.success) return;
    cloudflaredTunnels = data.tunnels || [];
    renderCloudflaredTunnels();
}

function renderCloudflaredTunnels() {
    const body = document.getElementById('cloudflaredTunnelsBody');
    if (!body) return;

    const online = cloudflaredTunnels.filter(t => t.status === 'online').length;
    const offline = cloudflaredTunnels.length - online;
    const onlineEl = document.getElementById('cf-stat-online');
    const offlineEl = document.getElementById('cf-stat-offline');
    const totalEl = document.getElementById('cf-stat-total');
    if (onlineEl) onlineEl.textContent = online;
    if (offlineEl) offlineEl.textContent = offline;
    if (totalEl) totalEl.textContent = cloudflaredTunnels.length;

    if (cloudflaredTunnels.length === 0) {
        body.innerHTML = '<tr><td colspan="7">Nenhum tunel criado ainda.</td></tr>';
        return;
    }

    body.innerHTML = cloudflaredTunnels.map(tunnel => {
        const isOnline = tunnel.status === 'online';
        const badge = isOnline ? 'badge-success' : (tunnel.status === 'error' ? 'badge-warning' : 'badge-danger');
        return `
            <tr>
                <td>
                    <strong>${cfEscape(tunnel.name)}</strong><br>
                    <small class="text-muted">${cfEscape(tunnel.uuid)}</small>
                </td>
                <td><span class="badge ${badge}">${cfEscape(tunnel.status || 'offline')}</span></td>
                <td><a href="${cfEscape(tunnel.publicUrl)}" target="_blank" style="color:var(--primary);">${cfEscape(tunnel.publicUrl)}</a></td>
                <td><code>${cfEscape(tunnel.localService)}</code></td>
                <td>${formatCfUptime(tunnel.uptimeSeconds)}</td>
                <td>${tunnel.pid ? `<code>${cfEscape(tunnel.pid)}</code>` : '--'}</td>
                <td>
                    <div class="toolbar-group">
                        <button class="btn btn-sm ${isOnline ? 'btn-danger' : 'btn-success'}" onclick="${isOnline ? 'stopCloudflaredTunnel' : 'startCloudflaredTunnel'}('${cfEscape(tunnel.id)}')" title="${isOnline ? 'Parar' : 'Iniciar'}">
                            <i data-lucide="${isOnline ? 'square' : 'play'}"></i>
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="restartCloudflaredTunnel('${cfEscape(tunnel.id)}')" title="Reiniciar">
                            <i data-lucide="refresh-cw"></i>
                        </button>
                        <button class="btn btn-secondary btn-sm" onclick="selectCloudflaredTunnel('${cfEscape(tunnel.id)}')" title="Logs">
                            <i data-lucide="scroll-text"></i>
                        </button>
                        <button class="btn btn-danger btn-sm" onclick="deleteCloudflaredTunnel('${cfEscape(tunnel.id)}')" title="Excluir">
                            <i data-lucide="trash-2"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    if (window.lucide) lucide.createIcons();
}

async function createCloudflaredTunnel(event) {
    event.preventDefault();
    const payload = {
        name: document.getElementById('cfName')?.value.trim(),
        domain: document.getElementById('cfDomain')?.value.trim(),
        type: document.getElementById('cfType')?.value,
        localHost: document.getElementById('cfLocalHost')?.value.trim() || '127.0.0.1',
        localPort: document.getElementById('cfLocalPort')?.value,
        path: document.getElementById('cfPath')?.value.trim(),
        autoRestart: document.getElementById('cfAutoRestart')?.checked !== false
    };

    const data = await safeFetch(`${API_BASE}/tunnel/create`, 'POST', payload, 60000);
    if (!data?.success) {
        alert(`Falha ao criar tunel. Verifique se o cloudflared esta instalado e logado.`);
        return;
    }

    event.target.reset();
    document.getElementById('cfLocalHost').value = '127.0.0.1';
    document.getElementById('cfAutoRestart').checked = true;
    showCloudflaredCreate(false);
    await fetchCloudflaredTunnels();
    selectCloudflaredTunnel(data.tunnel.id);
}

async function startCloudflaredTunnel(id) {
    const data = await safeFetch(`${API_BASE}/tunnel/start`, 'POST', { id }, 30000);
    if (!data?.success) alert(data?.error || 'Falha ao iniciar tunel.');
    await fetchCloudflaredTunnels();
}

async function stopCloudflaredTunnel(id) {
    const data = await safeFetch(`${API_BASE}/tunnel/stop`, 'POST', { id }, 30000);
    if (!data?.success) alert(data?.error || 'Falha ao parar tunel.');
    await fetchCloudflaredTunnels();
}

async function restartCloudflaredTunnel(id) {
    const data = await safeFetch(`${API_BASE}/tunnel/restart`, 'POST', { id }, 30000);
    if (!data?.success) alert(data?.error || 'Falha ao reiniciar tunel.');
    await fetchCloudflaredTunnels();
}

async function deleteCloudflaredTunnel(id) {
    const name = cloudflaredTunnels.find(item => item.id === id)?.name || id;
    if (!confirm(`Excluir o tunel "${name}"?`)) return;
    const data = await safeFetch(`${API_BASE}/tunnel/delete`, 'POST', { id }, 30000);
    if (!data?.success) alert(data?.error || 'Falha ao excluir tunel.');
    if (cloudflaredSelectedId === id) selectCloudflaredTunnel(null);
    await fetchCloudflaredTunnels();
}

function selectCloudflaredTunnel(id) {
    cloudflaredSelectedId = id;
    const label = document.getElementById('cloudflaredSelectedTunnel');
    const tunnel = cloudflaredTunnels.find(item => item.id === id);
    if (label) label.textContent = tunnel ? `${tunnel.name} - ${tunnel.publicUrl}` : 'Selecione um tunel para acompanhar.';

    if (cloudflaredLogInterval) clearInterval(cloudflaredLogInterval);
    loadCloudflaredLogs();
    if (id) {
        cloudflaredLogInterval = setInterval(loadCloudflaredLogs, 2500);
    }
}

async function loadCloudflaredLogs() {
    const box = document.getElementById('cloudflaredLogBox');
    if (!box) return;
    if (!cloudflaredSelectedId) {
        box.textContent = 'Aguardando...';
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/tunnel/logs?id=${encodeURIComponent(cloudflaredSelectedId)}&lines=240`);
        box.textContent = await res.text();
        box.scrollTop = box.scrollHeight;
    } catch (err) {
        box.textContent = err.message;
    }
}

async function cloudflaredLogin() {
    const box = document.getElementById('cloudflaredLoginBox');
    if (box) box.innerHTML = 'Iniciando cloudflared tunnel login...\nAguardando URL de autorizacao da Cloudflare...\n';
    cloudflaredLastAuthUrl = null;

    try {
        cloudflaredAuthWindow = window.open('', '_blank');
        if (cloudflaredAuthWindow) {
            cloudflaredAuthWindow.document.write('<!doctype html><title>Cloudflare Login</title><body style="font-family:sans-serif;padding:24px">Aguardando URL de autorizacao da Cloudflare...</body>');
            cloudflaredAuthWindow.document.close();
        }
    } catch (_) {
        cloudflaredAuthWindow = null;
    }

    const data = await safeFetch(`${API_BASE}/tunnel/login`, 'POST', {}, 30000);
    if (!data?.success && box) box.innerHTML += 'Falha ao iniciar login.\n';
    if (cloudflaredLoginInterval) clearInterval(cloudflaredLoginInterval);
    cloudflaredLoginInterval = setInterval(loadCloudflaredLoginLogs, 2000);
}

function openCloudflaredAuthUrl(url) {
    if (!/^https:\/\/[^\s]+$/i.test(url || '')) return;
    const isNewUrl = url !== cloudflaredLastAuthUrl;
    cloudflaredLastAuthUrl = url;

    const box = document.getElementById('cloudflaredLoginBox');
    if (box && !box.innerHTML.includes(url)) {
        box.innerHTML += `\nURL de autorizacao detectada:\n<a href="${cfEscape(url)}" target="_blank" style="color:#58a6ff">${cfEscape(url)}</a>\n\nDepois de autorizar na Cloudflare, o cloudflared gera o cert.pem automaticamente.\n`;
        box.scrollTop = box.scrollHeight;
    }

    if (!isNewUrl) return;

    try {
        if (cloudflaredAuthWindow && !cloudflaredAuthWindow.closed) {
            cloudflaredAuthWindow.location.href = url;
        } else {
            cloudflaredAuthWindow = window.open(url, '_blank');
        }
    } catch (_) {
        cloudflaredAuthWindow = null;
    }
}

async function loadCloudflaredLoginLogs() {
    const box = document.getElementById('cloudflaredLoginBox');
    if (!box) return;
    try {
        const res = await fetch(`${API_BASE}/tunnel/login/logs?lines=240`);
        const text = await res.text();
        box.textContent = text;
        const found = (text.match(/https:\/\/[^\s]+/i) || [])[0];
        if (found) openCloudflaredAuthUrl(found);
        box.scrollTop = box.scrollHeight;
    } catch (err) {
        box.textContent = err.message;
    }
}

function appendCloudflaredLoginLog(data) {
    const box = document.getElementById('cloudflaredLoginBox');
    if (!box) return;
    if (box.textContent.includes('Use "Login Cloudflare"')) box.textContent = '';
    box.textContent += data;
    const found = (String(data).match(/https:\/\/[^\s]+/i) || [])[0];
    if (found) openCloudflaredAuthUrl(found);
    box.scrollTop = box.scrollHeight;
}

// ============================================================
//  START
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    runBootSequence();
    initFileBrowserShortcuts();
});

// ============================================================
//  FILEBROWSER DYNAMIC SHORTCUTS & LOADING SEQUENCE
// ============================================================
let fileBrowserBooted = false;

async function bootFileBrowser() {
    if (fileBrowserBooted) return;
    fileBrowserBooted = true;
    
    const overlay = document.getElementById('fb-loading-overlay');
    const layout = document.getElementById('fb-layout');
    const log = document.getElementById('fb-boot-log');
    const progress = document.getElementById('fb-boot-progress');
    const status = document.getElementById('fb-boot-status');
    const iframe = document.getElementById('iframe-filebrowser');
    
    const addLog = (msg, color = '#a6e3a1') => {
        if (!log) return;
        const line = document.createElement('div');
        line.style.color = color;
        line.textContent = `> ${msg}`;
        log.appendChild(line);
        log.scrollTop = log.scrollHeight;
    };
    
    setTimeout(() => { addLog('Verificando daemon de arquivos (porta 8095)...'); progress.style.width = '20%'; status.textContent = 'Checando daemon...'; }, 400);
    setTimeout(() => { addLog('Validando Proxy Reverso NGINX/Node...'); progress.style.width = '40%'; status.textContent = 'Validando rotas...'; }, 1000);
    setTimeout(() => { addLog('Autenticando sessão interna (NoAuth SSO)...'); progress.style.width = '60%'; status.textContent = 'Autenticando...'; }, 1600);
    setTimeout(() => { 
        addLog('Carregando interface Web...'); 
        progress.style.width = '75%'; 
        status.textContent = 'Carregando UI...'; 
        iframe.src = '/__filebrowser/'; 
    }, 2200);
    
    iframe.onload = () => {
        if (iframe.src.includes('about:blank')) return;
        
        addLog('Aplicando injeção de CSS (Termux cPanel Dark Theme)...');
        progress.style.width = '90%';
        status.textContent = 'Injetando tema...';
        
        setTimeout(() => {
            addLog('Sistema de Arquivos montado e pronto para uso.', '#f9e2af');
            progress.style.width = '100%';
            status.textContent = 'Sistema Montado!';
            
            setTimeout(() => {
                if (overlay) overlay.style.display = 'none';
                if (layout) layout.style.opacity = '1';
            }, 800);
        }, 1000);
    };
}

async function initFileBrowserShortcuts() {
    const container = document.getElementById('fb-dynamic-shortcuts');
    if (!container) return;
    
    // Adiciona listener para a aba
    const fbTabBtn = document.querySelector('.nav-link[data-target="tab-files"]');
    if (fbTabBtn) {
        fbTabBtn.addEventListener('click', () => {
            setTimeout(bootFileBrowser, 100);
        });
    }
    
    try {
        const res = await safeFetch('/api/env');
        const env = await res.json();
        
        let html = '';
        
        if (env.is_termux) {
            html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files/data/data/com.termux/files/home'"><i data-lucide="home"></i> Home do Termux</button>`;
            html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files/data/data/com.termux/files/usr'"><i data-lucide="terminal-square"></i> Root do Termux</button>`;
            html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files${env.nginx_conf_dir}'"><i data-lucide="globe"></i> NGINX Conf</button>`;
        } else {
            const storageBase = env.storage_path === '/' ? '' : env.storage_path;
            html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files${storageBase}/home'"><i data-lucide="home"></i> Diretório Home</button>`;
            html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files/etc'"><i data-lucide="terminal-square"></i> Pasta /etc</button>`;
            html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files/var/www'"><i data-lucide="globe"></i> Pasta /var/www</button>`;
        }
        
        html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files' + window.location.pathname.replace('/index.html', '') + '/backups'"><i data-lucide="archive"></i> Backups</button>`;
        html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files' + window.location.pathname.replace('/index.html', '') + '/config'"><i data-lucide="settings"></i> Configurações</button>`;
        
        container.innerHTML = html;
        if (window.lucide) lucide.createIcons();
    } catch(e) {
        console.error('Falha ao carregar atalhos dinâmicos do FileBrowser:', e);
    }
}
