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
    if (targetId === 'tab-files')    loadFiles();
    if (targetId === 'tab-database') fetchDatabases();
    if (targetId === 'tab-nginx')    fetchNginxSites();
    if (targetId === 'tab-cron')     fetchCron();
    if (targetId === 'tab-noip')     fetchNoipStatus();
    if (targetId === 'tab-docs')     loadDocumentation();
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
        socket.on('noip-log', msg => appendNoipLog(msg));
        socket.on('log-line', line => appendLogLine(line));
    } catch(e) {
        console.warn('Socket.io não disponível:', e);
    }
}

// ============================================================
//  STATUS DO SISTEMA
// ============================================================
async function fetchStatus() {
    const data = await safeFetch(`${API_BASE}/status`);
    if (!data) return;

    if (el.cpu)     el.cpu.textContent  = `${data.cpu?.usage ?? '--'}%`;
    if (el.cpuDetails) el.cpuDetails.textContent = `${data.cpu?.cores ?? '--'} Núcleos | ${data.cpu?.freq ?? '--'} GHz`;
    if (el.ram)     el.ram.textContent  = `${data.ram?.free ?? '--'} / ${data.ram?.total ?? '--'}`;
    if (el.temp)    el.temp.textContent = `${data.temp ?? '--'}°C`;
    if (el.netSpeed) el.netSpeed.textContent = `${data.net?.down ?? '--'} / ${data.net?.up ?? '--'}`;

    if (data.storage && el.storageBar) {
        const pct = ((data.storage.total - data.storage.free) / data.storage.total * 100).toFixed(0);
        el.storageBar.style.width = `${pct}%`;
        if (el.storage) el.storage.textContent = `${data.storage.free}G livres de ${data.storage.total}G`;
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
        el.appsGrid.innerHTML = '<p style="color:var(--text-muted)">Nenhum app cadastrado. Adicione um!</p>';
        return;
    }
    el.appsGrid.innerHTML = apps.map(app => `
        <div class="card" style="border-left:3px solid var(--primary)">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
                <strong>${app.icon || '🚀'} ${app.name}</strong>
                <span class="badge ${app.status === 'online' ? 'badge-success' : 'badge-muted'}">${app.status || 'offline'}</span>
            </div>
            <small style="color:var(--text-muted)">Porta: ${app.port}</small>
            <div style="display:flex;gap:6px;margin-top:12px">
                <button class="btn btn-sm btn-secondary" onclick="startApp('${app.id}')">▶</button>
                <button class="btn btn-sm btn-danger"    onclick="stopApp('${app.id}')">⏹</button>
                <button class="btn btn-sm btn-secondary" onclick="deleteApp('${app.id}')">🗑</button>
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
            <td>${p.mem}</td>
            <td style="font-family:monospace;font-size:0.8rem">${p.command}</td>
            <td><button class="btn btn-sm btn-danger" onclick="killProcess(${p.pid})">✕</button></td>
        </tr>
    `).join('');
}

async function killProcess(pid) {
    if (!confirm(`Encerrar processo ${pid}?`)) return;
    await safeFetch(`${API_BASE}/processes/${pid}`, 'DELETE');
    fetchProcesses();
}

// ============================================================
//  GERENCIADOR DE ARQUIVOS
// ============================================================
async function loadFiles(dir = currentDir) {
    const data = await safeFetch(`${API_BASE}/files?dir=${encodeURIComponent(dir)}`);
    if (!data) return;
    currentDir  = data.currentDir || dir;
    currentFiles = data.files || [];
    if (el.breadcrumb) el.breadcrumb.textContent = currentDir;
    renderFileList(currentFiles, data.parentDir);
}

function renderFileList(files, parentDir) {
    if (!el.fileList) return;
    el.fileList.innerHTML = '';

    if (parentDir) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td colspan="5"><a href="#" onclick="loadFiles('${parentDir}');return false">📁 ..</a></td>`;
        el.fileList.appendChild(tr);
    }

    files.forEach(file => {
        const name = file.name || '';
        const icon = file.isDirectory ? '📁' : '📄';
        const clickHandler = file.isDirectory
            ? `loadFiles('${currentDir}/${name}')`
            : `viewFile('${name}')`;
        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td><input type="checkbox" data-name="${name}"></td>
            <td><a href="#" onclick="${clickHandler};return false">${icon} ${name}</a></td>
            <td>${file.size || '--'}</td>
            <td>${file.modified || '--'}</td>
            <td style="text-align:right">
                <button class="btn btn-sm btn-danger" onclick="deleteFileItem('${name}')">🗑</button>
            </td>
        `;
        el.fileList.appendChild(tr);
    });
}

function toggleSelectAllFiles() {
    const master = document.getElementById('selectAllFiles');
    document.querySelectorAll('#file-list input[type=checkbox]').forEach(cb => cb.checked = master.checked);
}

async function viewFile(name) {
    const data = await safeFetch(`${API_BASE}/files/content?path=${encodeURIComponent(currentDir + '/' + name)}`);
    if (!data) return;
    document.getElementById('modalFileName').textContent = name;
    document.getElementById('fileContentArea').textContent = data.content;
    document.getElementById('fileViewerModal').classList.remove('hidden');
}

function closeFileViewer() {
    document.getElementById('fileViewerModal').classList.add('hidden');
}

async function createNewFolder() {
    const name = prompt('Nome da nova pasta:');
    if (!name) return;
    await safeFetch(`${API_BASE}/files/mkdir`, 'POST', { path: currentDir, name });
    loadFiles();
}

async function deleteFileItem(name) {
    if (!confirm(`Deletar "${name}"?`)) return;
    await safeFetch(`${API_BASE}/files/delete`, 'POST', { path: currentDir + '/' + name });
    loadFiles();
}

async function handleUpload(event) {
    const formData = new FormData();
    Array.from(event.target.files).forEach(f => formData.append('files', f));
    formData.append('dir', currentDir);
    await fetch(`${API_BASE}/files/upload`, { method: 'POST', body: formData });
    loadFiles();
}

async function zipSelected() {
    const names = [...document.querySelectorAll('#file-list input:checked')].map(cb => cb.dataset.name);
    if (!names.length) return alert('Selecione arquivos.');
    await safeFetch(`${API_BASE}/files/zip`, 'POST', { dir: currentDir, files: names });
    loadFiles();
}

// ============================================================
//  BANCO DE DADOS
// ============================================================
async function fetchDatabases() {
    const data = await safeFetch(`${API_BASE}/databases`);
    const el2  = document.getElementById('db-list');
    if (!el2) return;
    if (!data?.length) { el2.innerHTML = '<p style="color:var(--text-muted)">Nenhum banco encontrado.</p>'; return; }
    el2.innerHTML = data.map(db => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
            <span>🗄 ${db.name} <small style="color:var(--text-muted)">(${db.user})</small></span>
            <button class="btn btn-sm btn-danger" onclick="deleteDb('${db.name}')">🗑</button>
        </div>
    `).join('');
}

async function createDatabase(e) {
    e.preventDefault();
    const body = {
        name: document.getElementById('dbNewName').value,
        user: document.getElementById('dbNewUser').value,
        pass: document.getElementById('dbNewPass').value,
    };
    await safeFetch(`${API_BASE}/databases`, 'POST', body);
    fetchDatabases();
}

async function deleteDb(name) {
    if (!confirm(`Deletar banco "${name}"?`)) return;
    await safeFetch(`${API_BASE}/databases/${name}`, 'DELETE');
    fetchDatabases();
}

function showDbSetup() { document.getElementById('dbSetupModal').classList.remove('hidden'); }
async function saveDbSetup() {
    const body = { user: document.getElementById('dbRootUser').value, pass: document.getElementById('dbRootPass').value };
    await safeFetch(`${API_BASE}/databases/setup`, 'POST', body);
    document.getElementById('dbSetupModal').classList.add('hidden');
    fetchDatabases();
}

// ============================================================
//  NGINX
// ============================================================
async function fetchNginxSites() {
    const data = await safeFetch(`${API_BASE}/nginx`);
    const tbody = document.getElementById('nginxTableBody');
    if (!tbody) return;
    tbody.innerHTML = (data || []).map(s => `
        <tr>
            <td>${s.domain}</td><td>${s.port}</td>
            <td><button class="btn btn-sm btn-danger" onclick="deleteNginxSite('${s.domain}')">🗑</button></td>
        </tr>
    `).join('') || '<tr><td colspan="3" style="color:var(--text-muted)">Nenhum site encontrado.</td></tr>';
}

async function createNginxSite(e) {
    e.preventDefault();
    await safeFetch(`${API_BASE}/nginx`, 'POST', {
        domain: document.getElementById('ngDomain').value,
        port:   document.getElementById('ngPort').value,
    });
    fetchNginxSites();
}

async function deleteNginxSite(domain) {
    if (!confirm(`Remover site "${domain}"?`)) return;
    await safeFetch(`${API_BASE}/nginx/${domain}`, 'DELETE');
    fetchNginxSites();
}

// ============================================================
//  CRONJOBS
// ============================================================
async function fetchCron() {
    const data = await safeFetch(`${API_BASE}/cron`);
    const editor = document.getElementById('cronEditor');
    if (editor && data) editor.value = data.crontab || '';
}

async function saveCron() {
    const content = document.getElementById('cronEditor')?.value;
    await safeFetch(`${API_BASE}/cron`, 'POST', { crontab: content });
    alert('Crontab salvo!');
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
//  LOGS
// ============================================================
function startLogWatch() {
    const path = document.getElementById('logFilePath')?.value;
    if (!path) return;
    socket?.emit('start-log-watch', { path });
}

function stopLogWatch() { socket?.emit('stop-log-watch'); }

function appendLogLine(line) {
    const d = document.getElementById('logs-display');
    if (!d) return;
    d.textContent += line + '\n';
    d.scrollTop = d.scrollHeight;
}

// ============================================================
//  BACKUPS
// ============================================================
async function createBackup() {
    const btn = document.getElementById('backup-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando...'; }
    const data = await safeFetch(`${API_BASE}/backup`, 'POST');
    if (btn) { btn.disabled = false; btn.innerHTML = '<i data-lucide="download"></i> Gerar Backup Agora'; lucide.createIcons(); }
    if (data?.file) {
        const result = document.getElementById('backup-result');
        const link   = document.getElementById('backup-download-link');
        if (result) result.classList.remove('hidden');
        if (link)   link.href = `/api/backup/download?file=${data.file}`;
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
async function toggleMariaDB()  { await safeFetch(`${API_BASE}/mariadb`,  'POST'); }

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
//  START
// ============================================================
document.addEventListener('DOMContentLoaded', runBootSequence);
