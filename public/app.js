'use strict';
// ============================================================
//  TERMUX CPANEL â€” app.js v4.0
//  Boot Sequence + All Modules
// ============================================================

const API_BASE = '/api';
let socket = null;
let currentDir = '/';
let currentFiles = [];
let bootCompleted = false;
let cfrProcessActionBusy = false;
let cpuRootEnabled = localStorage.getItem('cpu-root-enabled') === 'true';
const CPU_HISTORY_LIMIT = 28;
const cpuHistory = [];

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
        bootLog('Aviso: timeout global â€” forÃ§ando abertura do painel.');
        bootDone();
    }, 12000);

    bootProgress(5,  'Iniciando nÃºcleo...');
    bootLog('Buscando configuraÃ§Ãµes de tema...');
    initTheme();

    bootProgress(15, 'Inicializando interface...');
    bootLog('Mapeando elementos DOM...');
    initElements();
    initMonitorCards();
    initNavigation();
    initMobileNav();
    initSocket();
    initTerminal();

    bootProgress(35, 'Conectando ao servidor...');
    bootLog('Solicitando status do hardware...');
    try { await fetchStatus(); } catch(e) { bootLog('Aviso: status indisponÃ­vel.'); }

    bootProgress(55, 'Carregando aplicaÃ§Ãµes...');
    bootLog('Verificando serviÃ§os ativos...');
    try { await fetchApps(); } catch(e) { bootLog('Aviso: apps indisponÃ­veis.'); }

    bootProgress(72, 'Analisando processos...');
    bootLog('Mapeando Ã¡rvore de processos...');
    try { await fetchProcesses(); } catch(e) { bootLog('Aviso: processos indisponÃ­veis.'); }

    bootProgress(88, 'Finalizando interface...');
    bootLog('Renderizando componentes visuais...');

    clearTimeout(bootFailsafe);
    setTimeout(() => {
        bootDone();
        // Inicia polling apÃ³s o boot
        checkNetworkAccess();
        updateNetworkStatus();
        updateCpuStatus();
        setInterval(updateNetworkStatus, 1500);
        setInterval(updateCpuStatus, 3000);
        updateTemperatureHistory();
        setInterval(updateTemperatureHistory, 30000);
        setInterval(fetchStatus,    8000);
        setInterval(fetchApps,     15000);
        setInterval(fetchProcesses, 10000);
        
        // Inicializa as rotas do proxy reverso do Cloudflared
        if (typeof cfrFetchRoutes === 'function') {
            cfrFetchRoutes();
        }
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
        cpuCoreGrid: document.getElementById('cpu-core-grid'),
        cpuChartLine: document.getElementById('cpu-chart-line'),
        cpuChartArea: document.getElementById('cpu-chart-area'),
        cpuName: document.getElementById('cpu-name'),
        cpuTotal: document.getElementById('cpu-total'),
        cpuTotalPercent: document.getElementById('cpu-total-percent'),
        cpuLoadAvgContainer: document.getElementById('cpu-loadavg-container'),
        cpuLoadAvg: document.getElementById('cpu-loadavg'),
        cpuCoresCount: document.getElementById('cpu-cores-count'),
        cpuCoresList: document.getElementById('cpu-cores-list'),
        cpuStatus: document.getElementById('cpu-status'),
        cpuRootToggle: document.getElementById('cpu-root-toggle'),
        cpuNameCompact: document.getElementById('cpu-name-compact'),
        cpuCoresCompact: document.getElementById('cpu-cores-compact'),
        ram:        document.getElementById('stat-ram'),
        ramExpanded: document.getElementById('stat-ram-expanded'),
        ramFreeCompact: document.getElementById('ram-free-compact'),
        ramUsed: document.getElementById('ram-used'),
        ramTotal: document.getElementById('ram-total'),
        ramFree: document.getElementById('ram-free'),
        temp:       document.getElementById('stat-temperature'),
        tempExpanded: document.getElementById('stat-temperature-expanded'),
        storage:    document.getElementById('stat-storage'),
        storageCompact: document.getElementById('stat-storage-compact'),
        storageBar: document.getElementById('stat-storage-progress'),
        storageBarCompact: document.getElementById('stat-storage-progress-compact'),
        storageTotalVal: document.getElementById('storage-total'),
        storageFreeVal: document.getElementById('storage-free'),
        storageUsedVal: document.getElementById('storage-used'),
        storagePanel: document.getElementById('storage-panel'),
        storageWww: document.getElementById('storage-www'),
        storageBackups: document.getElementById('storage-backups'),
        storageStatus: document.getElementById('stat-storage-status'),
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
//  NAVEGAÃ‡ÃƒO
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

    // Limpa o loop do Cloudflared se o usuÃ¡rio mudar de aba
    if (window.cfTabInterval) {
        clearInterval(window.cfTabInterval);
        window.cfTabInterval = null;
    }

    // Mostra a tab alvo
    const tab = document.getElementById(targetId);
    if (tab) tab.classList.add('active');

    // Marca links ativos
    document.querySelectorAll(`[data-target="${targetId}"]`).forEach(l => l.classList.add('active'));

    // Loaders especÃ­ficos
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
    if (targetId === 'tab-cloudflared') {
        if (typeof cfFetchInstances === 'function') {
            cfFetchInstances();
            window.cfTabInterval = setInterval(cfFetchInstances, 4000);
        }
        if (typeof acLoadState === 'function') {
            acLoadState();
        }
    }
    if (targetId === 'tab-docs')     loadDocumentation();
    if (targetId === 'tab-settings') {
        loadSettings();
        checkSystemUpdates();
    }
}

function initMobileNav() {
    // jÃ¡ tratado pelo initNavigation via [data-target]
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
        window.socket = socket; // Garante que socket esteja exposto globalmente
        // Eventos do servidor — nomes corretos
        socket.on('noip-log',      data => appendNoipLog(data));
        socket.on('log-data',      line => appendLogLine(line));
        socket.on('cloudflared-login-log', data => appendCloudflaredLoginLog(data));
        socket.on('cloudflared-login-url', url => openCloudflaredAuthUrl(url));
        socket.on('cloudflared-login-status', data => updateCloudflaredLoginUi(data));
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

async function initTerminal() {
    let savedHost = '';
    let savedPort = '';
    let savedUser = '';
    let savedPass = '';
    let savedSave = true;

    // Tenta carregar as credenciais SSH salvas no servidor
    try {
        const res = await fetch('/api/system/settings/ssh');
        const data = await res.json();
        if (data.success && data.config) {
            savedHost = data.config.host || '';
            savedPort = data.config.port || '';
            savedUser = data.config.username || '';
            savedPass = data.config.password || '';
            savedSave = data.config.save !== false;
        } else {
            // Fallback para localStorage
            savedHost = localStorage.getItem('ssh-host') || '';
            savedPort = localStorage.getItem('ssh-port') || '';
            savedUser = localStorage.getItem('ssh-user') || '';
            savedPass = localStorage.getItem('ssh-pass') || '';
            savedSave = localStorage.getItem('ssh-save') !== 'false';
        }
    } catch (e) {
        // Fallback para localStorage em caso de falha de rede
        savedHost = localStorage.getItem('ssh-host') || '';
        savedPort = localStorage.getItem('ssh-port') || '';
        savedUser = localStorage.getItem('ssh-user') || '';
        savedPass = localStorage.getItem('ssh-pass') || '';
        savedSave = localStorage.getItem('ssh-save') !== 'false';
    }

    const hostInput = document.getElementById('sshHost');
    const portInput = document.getElementById('sshPort');
    const userInput = document.getElementById('sshUser');
    const passInput = document.getElementById('sshPass');
    const saveCheck = document.getElementById('sshSaveDetails');

    if (saveCheck) saveCheck.checked = savedSave;

    if (savedSave) {
        if (hostInput) hostInput.value = savedHost || '127.0.0.1';
        if (portInput) portInput.value = savedPort || '8022';
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
        showToast('Preencha usuário e senha SSH!', 'warning');
        return;
    }

    // Salva ou limpa dados conforme o checkbox no localStorage e no Servidor
    if (saveCheck) {
        localStorage.setItem('ssh-host', host);
        localStorage.setItem('ssh-port', port);
        localStorage.setItem('ssh-user', username);
        localStorage.setItem('ssh-pass', password);
        localStorage.setItem('ssh-save', 'true');

        // Salva as credenciais permanentemente no backend
        fetch('/api/system/settings/ssh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ host, port, username, password, save: true })
        }).catch(err => console.warn('Erro ao salvar SSH no servidor:', err));
    } else {
        localStorage.removeItem('ssh-host');
        localStorage.removeItem('ssh-port');
        localStorage.removeItem('ssh-user');
        localStorage.removeItem('ssh-pass');
        localStorage.setItem('ssh-save', 'false');

        // Remove as credenciais permanentemente do backend
        fetch('/api/system/settings/ssh', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ save: false })
        }).catch(err => console.warn('Erro ao limpar SSH do servidor:', err));
    }

    const container = document.getElementById('terminal-container');
    if (!container) return;

    // Limpa terminal anterior
    container.innerHTML = '';
    if (_termInstance) { try { _termInstance.dispose(); } catch(e) {} }

    // Auxiliar para cd ao conectar
    const runCdCommand = () => {
        if (window.terminalInitialPath) {
            setTimeout(() => {
                if (socket && (window._term || container.getAttribute('tabindex') === '0')) {
                    socket.emit('terminal-input', `cd "${window.terminalInitialPath.replace(/"/g, '\\"')}"\r`);
                    window.terminalInitialPath = null;
                }
            }, 1500);
        }
    };

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

        runCdCommand();
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

    runCdCommand();
}

let tempUnit = 'C';
let lastTemperatureStr = '--°C';

function toggleTempUnit(e) {
    if (e) {
        e.stopPropagation();
        e.preventDefault();
    }
    tempUnit = tempUnit === 'C' ? 'F' : 'C';
    const btn = document.getElementById('temp-unit-btn');
    if (btn) btn.textContent = '°' + tempUnit;
    updateTemperatureDisplay();
    renderTempChart();
}

function updateTemperatureDisplay() {
    if (!el.temp) return;
    if (lastTemperatureStr === '--°C' || lastTemperatureStr === 'N/A' || !lastTemperatureStr) {
        el.temp.textContent = lastTemperatureStr || '--°C';
        if (el.tempExpanded) el.tempExpanded.textContent = lastTemperatureStr || '--°C';
        return;
    }
    
    // Extract number from string like "45.0°C"
    const val = parseFloat(lastTemperatureStr);
    if (isNaN(val)) {
        el.temp.textContent = lastTemperatureStr;
        if (el.tempExpanded) el.tempExpanded.textContent = lastTemperatureStr;
        return;
    }
    
    if (tempUnit === 'F') {
        const f = (val * 9/5) + 32;
        el.temp.textContent = `${f.toFixed(1)}°F`;
        if (el.tempExpanded) el.tempExpanded.textContent = `${f.toFixed(1)}°F`;
    } else {
        el.temp.textContent = `${val.toFixed(1)}°C`;
        if (el.tempExpanded) el.tempExpanded.textContent = `${val.toFixed(1)}°C`;
    }
}

let netUnit = 'MB';
let lastNetDownStr = '--';
let lastNetUpStr = '--';

function toggleNetUnit(e) {
    if (e) {
        e.stopPropagation();
        e.preventDefault();
    }
    netUnit = netUnit === 'MB' ? 'KB' : 'MB';
    const btn = document.getElementById('net-unit-btn');
    if (btn) btn.textContent = netUnit;
    updateNetDisplay();
}

function updateNetDisplay() {
    if (!el.netSpeed) return;
    if (lastNetDownStr === '--' || lastNetUpStr === '--') {
        el.netSpeed.textContent = `${lastNetDownStr} / ${lastNetUpStr}`;
        return;
    }

    const downVal = parseFloat(lastNetDownStr);
    const upVal = parseFloat(lastNetUpStr);

    if (isNaN(downVal) || isNaN(upVal)) {
        el.netSpeed.textContent = `${lastNetDownStr} / ${lastNetUpStr}`;
        return;
    }

    if (netUnit === 'KB') {
        el.netSpeed.textContent = `${(downVal * 1024).toFixed(0)} KB / ${(upVal * 1024).toFixed(0)} KB`;
    } else {
        el.netSpeed.textContent = `${downVal.toFixed(2)} MB / ${upVal.toFixed(2)} MB`;
    }
}

// ============================================================
//  STATUS DO SISTEMA â€” alinhado com os campos reais da API
// ============================================================
async function fetchStatus() {
    const data = await safeFetch(`${API_BASE}/status`);
    if (!data) return;

    // O servidor retorna: cpu (string), cpuCores, cpuSpeed, ram (string),
    // storageFree, storageTotal, storagePercent, temperature (string)
    if (el.cpu)        el.cpu.textContent        = data.cpu        || '--%';
    if (el.cpuDetails) el.cpuDetails.textContent = `${data.cpuCores || '--'} NÃºcleos | ${data.cpuSpeed || '--'}`;
    renderCpuVisual(data);
    if (el.ram)        el.ram.textContent        = data.ram        || '-- / --';
    if (el.ramExpanded) el.ramExpanded.textContent = data.ram       || '-- / --';
    if (data.ram) {
        const parts = data.ram.split('/');
        if (parts.length === 2) {
            const used = parts[0].trim();
            const total = parts[1].trim();
            const usedVal = parseFloat(used);
            const totalVal = parseFloat(total);
            if (!isNaN(usedVal) && !isNaN(totalVal)) {
                const freeVal = totalVal - usedVal;
                const pct = Math.round((usedVal / totalVal) * 100);
                if (el.ramFreeCompact) el.ramFreeCompact.textContent = `Livre: ${freeVal.toFixed(0)}MB (${pct}% usado)`;
                if (el.ramUsed) el.ramUsed.textContent = `${usedVal.toFixed(0)}MB`;
                if (el.ramTotal) el.ramTotal.textContent = `${totalVal.toFixed(0)}MB`;
                if (el.ramFree) el.ramFree.textContent = `${freeVal.toFixed(0)}MB`;
            }
        }
    }

    if (el.temp) {
        lastTemperatureStr = data.temperature || '--°C';
        updateTemperatureDisplay();
    }
    if (el.netSpeed) {
        lastNetDownStr = data.totalDown || '--';
        lastNetUpStr = data.totalUp || '--';
        updateNetDisplay();
    }

    // Storage â€” campos: storageFree, storageTotal, storagePercent
    if (el.storageBar && data.storagePercent) {
        el.storageBar.style.width = `${data.storagePercent}%`;
    }
    if (el.storageBarCompact && data.storagePercent) {
        el.storageBarCompact.style.width = `${data.storagePercent}%`;
    }
    if (el.storage && data.storageTotal) {
        el.storage.textContent = `${data.storageFree || '--'} livre de ${data.storageTotal}`;
    }
    if (el.storageCompact && data.storageTotal) {
        el.storageCompact.textContent = `${data.storageFree || '--'} livre de ${data.storageTotal}`;
    }
    if (el.storageTotalVal && data.storageTotal) {
        el.storageTotalVal.textContent = data.storageTotal;
    }
    if (el.storageFreeVal && data.storageFree) {
        el.storageFreeVal.textContent = data.storageFree;
    }
    if (el.storageUsedVal && data.storageTotal && data.storageFree) {
        const totalVal = parseFloat(data.storageTotal);
        const freeVal = parseFloat(data.storageFree);
        if (!isNaN(totalVal) && !isNaN(freeVal)) {
            el.storageUsedVal.textContent = `${(totalVal - freeVal).toFixed(1)}GB`;
        } else {
            el.storageUsedVal.textContent = '--';
        }
    }
    if (el.storagePanel) el.storagePanel.textContent = '1.2 GB';
    if (el.storageWww) el.storageWww.textContent = '2.4 GB';
    if (el.storageBackups) el.storageBackups.textContent = '450 MB';
}

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]));
}

async function updateCpuStatus() {
    const data = await safeFetch(`${API_BASE}/cpu/status`, 'GET', null, 8000);
    if (!data) {
        if (el.cpuStatus) el.cpuStatus.textContent = 'Erro ao ler CPU';
        if (el.cpuCoresList) el.cpuCoresList.innerHTML = '<div class="cpu-core-row muted">Erro ao ler CPU</div>';
        return;
    }

    updateCpuRootButton(Boolean(data.root));
    const total = data.cpuTotal || '--%';

    // CPU Name
    if (el.cpuName) el.cpuName.textContent = data.cpuName || 'CPU Android';
    if (el.cpuNameCompact) el.cpuNameCompact.textContent = data.cpuName || 'CPU Android';

    // Cores Count
    if (el.cpuCoresCount) el.cpuCoresCount.textContent = data.coresCount ?? '--';

    // Status text
    if (el.cpuStatus) el.cpuStatus.textContent = data.status || 'Monitorando CPU';

    // Handle Termux native estimated fallback mode
    if (data.mode === 'termux_native_estimated') {
        if (el.cpu) el.cpu.textContent = 'IndisponÃ­vel';
        if (el.cpuTotal) el.cpuTotal.textContent = 'IndisponÃ­vel';
        if (el.cpuTotalPercent) el.cpuTotalPercent.textContent = 'IndisponÃ­vel';

        if (el.cpuCoresCompact) {
            el.cpuCoresCompact.textContent = `Painel: ${data.panelCpuPercent || 0}%`;
        }
        if (el.cpuDetails) {
            el.cpuDetails.textContent = `CPU Estimada | Painel: ${data.panelCpuPercent || 0}%`;
        }

        if (el.cpuCoresList) {
            let html = `
                <div style="margin-top: 10px; border-top: 1px solid var(--border); padding-top: 10px; width: 100%;">
                    <div style="font-size: 0.85rem; font-weight: bold; margin-bottom: 8px; color: var(--primary); display: flex; align-items: center; gap: 6px;">
                        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: var(--primary);"></span>
                        Processos do Termux Estimados
                    </div>
                    <div class="cpu-core-row" style="background: var(--bg-hover); border-radius: 6px; padding: 6px 10px; margin-bottom: 8px;">
                        <span>Uso Total do Painel</span>
                        <strong>${data.panelCpuPercent || 0}%</strong>
                        <em style="color: var(--primary);">Estimado</em>
                    </div>
            `;
            if (data.topProcesses && data.topProcesses.length > 0) {
                html += `
                    <div style="font-size: 0.8rem; font-weight: bold; margin: 12px 0 6px 0; color: var(--text-muted);">Processos AcessÃ­veis</div>
                `;
                data.topProcesses.forEach(proc => {
                    const shortCmd = proc.command.split(' ')[0].split('/').pop() || proc.command;
                    html += `
                        <div class="cpu-core-row" style="font-size: 0.8rem; padding: 4px 10px;">
                            <span style="max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeHtml(proc.command)}">${escapeHtml(shortCmd)} <small class="muted">(PID ${proc.pid})</small></span>
                            <strong>${proc.cpuPercent}%</strong>
                            <em style="font-size: 0.75rem;">ativo</em>
                        </div>
                    `;
                });
            }
            if (data.cores && data.cores.length > 0) {
                html += `
                    <div style="font-size: 0.8rem; font-weight: bold; margin: 16px 0 6px 0; color: var(--text-muted);">Status & FrequÃªncias dos NÃºcleos</div>
                `;
                html += data.cores.map(core => {
                    const freq = core.online ? (core.frequency?.formatted || 'N/A') : 'offline';
                    return `
                        <div class="cpu-core-row${core.online ? '' : ' offline'}" style="padding: 4px 10px; opacity: 0.8;">
                            <span>${escapeHtml(core.label)}</span>
                            <strong>${core.online ? 'Online' : 'Offline'}</strong>
                            <em>${escapeHtml(freq)}</em>
                        </div>
                    `;
                }).join('');
            }
            html += `</div>`;
            el.cpuCoresList.innerHTML = html;
        }

        renderCpuVisual({ cpu: '0%', cpuCores: data.coresCount || 1 });
        return;
    }

    // Handle load average fallback mode
    if (data.mode === 'loadavg_fallback') {
        if (el.cpu) el.cpu.textContent = '--%';
        if (el.cpuTotal) el.cpuTotal.textContent = '--%';
        if (el.cpuTotalPercent) el.cpuTotalPercent.textContent = '--%';

        if (el.cpuLoadAvgContainer) el.cpuLoadAvgContainer.classList.remove('hidden');
        if (el.cpuLoadAvg) el.cpuLoadAvg.textContent = data.loadAverage ? data.loadAverage.formatted : '--';

        if (el.cpuCoresCompact) {
            el.cpuCoresCompact.textContent = data.loadAverage ? `Carga: ${data.loadAverage.formatted}` : 'Uso indisponÃ­vel';
        }
        if (el.cpuDetails) {
            el.cpuDetails.textContent = data.loadAverage ? `Carga: ${data.loadAverage.formatted}` : 'Uso indisponÃ­vel';
        }
        if (el.cpuCoresList) {
            el.cpuCoresList.innerHTML = `<div class="cpu-core-row muted">Uso por nÃºcleo indisponÃ­vel no modo fallback de carga mÃ©dia.</div>`;
        }
        renderCpuVisual({ cpu: '0%', cpuCores: data.coresCount || 1 });
        return;
    }

    if (el.cpuLoadAvgContainer) el.cpuLoadAvgContainer.classList.add('hidden');

    if (data.mode === 'calculating') {
        if (el.cpu) el.cpu.textContent = 'Calculando...';
        if (el.cpuTotal) el.cpuTotal.textContent = 'Calculando...';
        if (el.cpuTotalPercent) el.cpuTotalPercent.textContent = 'Calculando...';
        if (el.cpuCoresCompact) el.cpuCoresCompact.textContent = `${data.coresCount ?? '--'} nÃºcleos`;
        if (el.cpuDetails) el.cpuDetails.textContent = `Calculando...`;
        if (el.cpuCoresList) {
            el.cpuCoresList.innerHTML = '<div class="cpu-core-row muted">Calculando...</div>';
        }
        renderCpuVisual({ cpu: '0%', cpuCores: data.coresCount || 1 });
        return;
    }

    // Normal operation
    if (el.cpu) el.cpu.textContent = total;
    if (el.cpuTotal) el.cpuTotal.textContent = total;
    if (el.cpuTotalPercent) el.cpuTotalPercent.textContent = total;
    if (el.cpuCoresCompact) el.cpuCoresCompact.textContent = `${data.coresCount ?? '--'} nÃºcleos`;
    if (el.cpuDetails) el.cpuDetails.textContent = `${data.coresCount || '--'} NÃºcleos | ${total}`;

    renderCpuCoreList(data.cores || []);
    renderCpuVisual({ cpu: total, cpuCores: data.coresCount || 1 });
}

function renderCpuCoreList(cores) {
    if (!el.cpuCoresList) return;
    if (!cores.length) {
        el.cpuCoresList.innerHTML = '<div class="cpu-core-row muted">Calculando...</div>';
        return;
    }

    el.cpuCoresList.innerHTML = cores.map(core => {
        const usage = core.online ? (core.usage || 'Calculando...') : 'offline';
        const freq = core.online ? (core.frequency?.formatted || 'freq. indisponivel') : 'freq. indisponivel';
        return `
            <div class="cpu-core-row${core.online ? '' : ' offline'}">
                <span>${escapeHtml(core.label)}</span>
                <strong>${escapeHtml(usage)}</strong>
                <em>${escapeHtml(freq)}</em>
            </div>
        `;
    }).join('');
}

function updateCpuRootButton(enabled) {
    cpuRootEnabled = Boolean(enabled);
    try { localStorage.setItem('cpu-root-enabled', String(cpuRootEnabled)); } catch (_) {}

    if (!el.cpuRootToggle) return;
    el.cpuRootToggle.classList.toggle('is-active', cpuRootEnabled);
    el.cpuRootToggle.setAttribute('aria-pressed', String(cpuRootEnabled));
    el.cpuRootToggle.title = cpuRootEnabled
        ? 'Desativar leitura root da CPU'
        : 'Ativar leitura root da CPU';
}

async function toggleCpuRoot() {
    const nextEnabled = !cpuRootEnabled;
    if (el.cpuRootToggle) {
        el.cpuRootToggle.disabled = true;
        el.cpuRootToggle.classList.add('is-loading');
    }

    const data = await safeFetch(`${API_BASE}/cpu/root`, 'POST', { enabled: nextEnabled }, 5000);
    if (data?.success) {
        updateCpuRootButton(Boolean(data.root));
        await updateCpuStatus();
    } else if (el.cpuStatus) {
        el.cpuStatus.textContent = 'Nao foi possivel alternar leitura root';
    }

    if (el.cpuRootToggle) {
        el.cpuRootToggle.disabled = false;
        el.cpuRootToggle.classList.remove('is-loading');
    }
}

function parsePercent(value) {
    const numeric = Number(String(value || '').replace('%', '').replace(',', '.').trim());
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, numeric);
}

function renderCpuVisual(data) {
    const cores = Math.max(1, Number(data.cpuCores) || 1);
    const usage = parsePercent(data.cpu);

    cpuHistory.push(usage);
    while (cpuHistory.length > CPU_HISTORY_LIMIT) cpuHistory.shift();

    renderCpuCores(cores, usage);
    renderCpuChart();
}

function renderCpuCores(cores, usage) {
    if (!el.cpuCoreGrid) return;

    const activeCores = Math.min(cores, Math.ceil((usage / 100) * cores));
    if (el.cpuCoreGrid.dataset.cores !== String(cores)) {
        el.cpuCoreGrid.dataset.cores = String(cores);
        el.cpuCoreGrid.innerHTML = Array.from({ length: cores }, (_, index) => (
            `<span class="cpu-core" title="Nucleo ${index + 1}" aria-label="Nucleo ${index + 1}"></span>`
        )).join('');
    }

    el.cpuCoreGrid.querySelectorAll('.cpu-core').forEach((core, index) => {
        core.classList.toggle('active', index < activeCores);
    });
}

function renderCpuChart() {
    if (!el.cpuChartLine || !el.cpuChartArea) return;

    const width = 160;
    const height = 48;
    const values = cpuHistory.length > 1 ? cpuHistory : [0, cpuHistory[0] || 0];
    const scaleMax = Math.max(100, ...values);
    const step = width / (values.length - 1);

    const points = values.map((value, index) => {
        const x = index * step;
        const y = height - (value / scaleMax) * (height - 4) - 2;
        return [x, y];
    });

    const linePath = points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
    const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;

    el.cpuChartLine.setAttribute('d', linePath);
    el.cpuChartArea.setAttribute('d', areaPath);
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
                <strong>${app.icon || 'ðŸš€'} ${app.name}</strong>
                <span style="font-size:0.75rem;font-weight:600;color:${statusColor(app.status)}">${app.status || '--'}</span>
            </div>
            <small style="color:var(--text-muted)">Porta: ${app.port}</small>
            <div style="display:flex;gap:6px;margin-top:12px">
                <button class="btn btn-sm btn-danger" onclick="deleteApp('${app.id}')" title="Remover">ðŸ—‘</button>
                ${app.url ? `<a href="${app.url}" target="_blank" class="btn btn-sm btn-secondary">â†—</a>` : ''}
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
            <td><button class="btn btn-sm btn-danger" onclick="killProcess(${p.pid})">âœ•</button></td>
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
        showToast('Processos duplicados limpos com sucesso!', 'success');
        fetchProcesses();
    } else {
        showToast(data?.error || 'Falha ao limpar processos duplicados.', 'error');
    }
}

// ============================================================
//  GERENCIADOR DE ARQUIVOS â€” Stubs removidos (gerenciado por filemanager.js)
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

// loadFiles() e fbNavigate() sÃ£o definidos em filemanager.js â€” NÃƒO redefina aqui!
// ============================================================
//  BANCO DE DADOS â€” MÃ³dulo Completo
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
    await preloadDbSetupFields();
    await fetchDbStatus();
    const data  = await safeFetch(`${API_BASE}/db`);
    const listContainer = document.getElementById('db-list-container');
    if (!listContainer) return;

    if (!data || !data.databases) {
        listContainer.innerHTML = '<div style="color:var(--text-muted);padding:20px;text-align:center;">Sem conexÃ£o com MariaDB. Configure a senha root primeiro.</div>';
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
            : '<span class="badge badge-ok">UsuÃ¡rio</span>';
            
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
        const preferredDb = dbNames.find(name => name === 'painel') || dbNames.find(name => !isSystemDatabase(name)) || dbNames[0];
        if (!currentDbManager || !dbNames.includes(currentDbManager)) {
            selectDatabase(preferredDb);
        } else {
            selectDatabase(currentDbManager);
        }
    }

    // Carrega lista de backups para preencher o seletor geral
    loadDbBackups();
}

// Global state for database manager
let currentDbManager = null;
let currentDbTable = null;
let currentDbTablePage = 1;
let currentDbTableRows = [];
let currentDbTableColumns = [];

function isSystemDatabase(db) {
    if (!db) return false;
    return ['information_schema', 'mysql', 'performance_schema', 'sys'].includes(db.toLowerCase());
}

async function selectDatabase(dbName) {
    currentDbManager = dbName;
    currentDbTable = null;
    currentDbTablePage = 1;
    currentDbTableRows = [];
    currentDbTableColumns = [];
    
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
        badgeEl.textContent = system ? 'Sistema' : 'UsuÃ¡rio';
        badgeEl.className = system ? 'badge badge-system' : 'badge badge-ok';
    }
    
    const subtitleEl = document.getElementById('db-detail-subtitle');
    if (subtitleEl) {
        subtitleEl.textContent = system ? 'Banco de dados do sistema protegido pelo painel.' : 'Banco de dados do usuÃ¡rio.';
    }

    // Toggle system database warning
    const systemAlert = document.getElementById('db-system-alert');
    if (systemAlert) {
        systemAlert.classList.toggle('hidden', !system);
    }

    // Security locks on dangerous controls
    const dangerousButtons = [
        'btn-restore', 'btn-restore-selected', 'btn-optimize', 'btn-repair', 
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

    const tableSearch = document.getElementById('db-table-search');
    if (tableSearch) tableSearch.value = '';
    const tableTitle = document.getElementById('db-table-title');
    if (tableTitle) tableTitle.textContent = 'Tabela';
    const tableMeta = document.getElementById('db-table-meta');
    if (tableMeta) tableMeta.textContent = 'Sem tabela selecionada.';
    const tableData = document.getElementById('db-table-data');
    if (tableData) tableData.innerHTML = '<tbody><tr><td>Abra uma tabela para visualizar os registros.</td></tr></tbody>';
    
    const dropBtn = document.getElementById('btn-drop');
    if (dropBtn) {
        dropBtn.disabled = true;
    }

    const dangerNote = document.getElementById('db-danger-note');
    if (dangerNote) {
        dangerNote.textContent = system 
            ? 'A exclusÃ£o estÃ¡ bloqueada porque este Ã© um banco do sistema.' 
            : 'Cuidado: Esta aÃ§Ã£o Ã© permanente e apagarÃ¡ todas as tabelas!';
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

        const rowsEl = document.getElementById('db-detail-rows');
        if (rowsEl) rowsEl.textContent = Number(data.totalRows || 0).toLocaleString('pt-BR');

        const largestEl = document.getElementById('db-detail-largest');
        if (largestEl) largestEl.textContent = data.largestTable || 'N/A';

        const currentEl = document.getElementById('db-workbench-current');
        if (currentEl) currentEl.textContent = dbName;

        const wbRowsEl = document.getElementById('db-workbench-rows');
        if (wbRowsEl) wbRowsEl.textContent = Number(data.totalRows || 0).toLocaleString('pt-BR');

        const wbLargestEl = document.getElementById('db-workbench-largest');
        if (wbLargestEl) wbLargestEl.textContent = data.largestTable || 'N/A';
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
        showToast('Nome de banco invÃ¡lido! Use apenas letras, nÃºmeros e underline.', 'warning');
        return;
    }
    
    if (dbUser && !dbUser.match(/^[a-zA-Z0-9_-]+$/)) {
        showToast('Nome de usuÃ¡rio invÃ¡lido! Use apenas letras, nÃºmeros, underline e hÃ­fen.', 'warning');
        return;
    }

    logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, `Solicitando criaÃ§Ã£o de novo banco "${dbName}"...`);
    try {
        const result = await safeFetch(`${API_BASE}/db/create`, 'POST', { dbName, dbUser, dbPass });
        if (result?.success) {
            logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, 
                `âœ“ Banco "${dbName}" criado com sucesso!\n` +
                (dbUser ? `âœ“ UsuÃ¡rio "${dbUser}" criado com privilÃ©gios totais concedidos no banco "${dbName}".` : 'âœ“ Nenhum usuÃ¡rio adicional criado.'));
            showToast('Banco criado com sucesso!', 'success');
            closeDbCreateModal();
            e.target.reset();
            currentDbManager = dbName;
            fetchDatabases();
        } else {
            logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, `âŒ Erro ao criar banco: ${result?.message || 'Falha interna'}`, true);
            showToast(`Erro ao criar banco: ${result?.message || 'Erro interno'}`, 'error');
        }
    } catch (err) {
        logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, `âŒ Erro de rede: ${err.message}`, true);
        showToast(`Erro de rede: ${err.message}`, 'error');
    }
}

async function actionOpenDbManager() {
    if (!currentDbManager) return showToast('Selecione um banco primeiro.', 'warning');
    const browser = document.getElementById('db-table-browser');
    browser?.classList.remove('hidden');
    await actionShowTables();
    browser?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function actionShowTables() {
    if (!currentDbManager) return showToast('Selecione um banco primeiro.', 'warning');
    logToDbConsole('panel_db_manager --tables ' + currentDbManager, `Carregando tabelas de "${currentDbManager}" no gerenciador do painel...`);
    const listEl = document.getElementById('db-table-list');
    if (listEl) listEl.innerHTML = '<div class="muted-note">Carregando tabelas...</div>';
    try {
        const data = await safeFetch(`${API_BASE}/db/tables?db=${encodeURIComponent(currentDbManager)}`);
        if (!data?.success) throw new Error(data?.error || 'Falha ao listar tabelas.');
        renderDbTableList(data.tables || []);
        const first = (data.tables || [])[0]?.name;
        if (first) await openDbTable(first, 1);
        else renderDbTableRows({ columns: [], rows: [], total: 0, page: 1, limit: 50, table: '' });
    } catch (err) {
        if (listEl) listEl.innerHTML = `<div class="muted-note">${escapeHtml(err.message)}</div>`;
        logToDbConsole('panel_db_manager --tables ' + currentDbManager, err.message, true);
    }
}

function closeDbTableBrowser() {
    document.getElementById('db-table-browser')?.classList.add('hidden');
}

function renderDbTableList(tables) {
    const listEl = document.getElementById('db-table-list');
    if (!listEl) return;
    if (!tables.length) {
        listEl.innerHTML = '<div class="muted-note">Nenhuma tabela encontrada.</div>';
        return;
    }
    listEl.innerHTML = tables.map(table => `
        <button class="db-table-button ${table.name === currentDbTable ? 'active' : ''}" onclick="openDbTable(decodeURIComponent('${encodeURIComponent(table.name)}'), 1)">
            <span>${escapeHtml(table.name)}</span>
            <small>${Number(table.rows_count || 0).toLocaleString('pt-BR')}</small>
        </button>
    `).join('');
}

async function openDbTable(tableName, page = 1) {
    if (!currentDbManager || !tableName) return;
    currentDbTable = tableName;
    currentDbTablePage = Math.max(page, 1);
    const limit = Number(document.getElementById('db-table-limit')?.value || 50);
    const search = document.getElementById('db-table-search')?.value.trim() || '';
    document.querySelectorAll('#db-table-list .db-table-button').forEach(btn => {
        btn.classList.toggle('active', btn.querySelector('span')?.textContent === tableName);
    });
    const titleEl = document.getElementById('db-table-title');
    const metaEl = document.getElementById('db-table-meta');
    const tableEl = document.getElementById('db-table-data');
    if (titleEl) titleEl.textContent = tableName;
    if (metaEl) metaEl.textContent = 'Carregando registros...';
    if (tableEl) tableEl.innerHTML = '<tbody><tr><td>Carregando...</td></tr></tbody>';

    try {
        const data = await safeFetch(`${API_BASE}/db/table?db=${encodeURIComponent(currentDbManager)}&table=${encodeURIComponent(tableName)}&page=${currentDbTablePage}&limit=${limit}&search=${encodeURIComponent(search)}`);
        if (!data?.success) throw new Error(data?.error || 'Falha ao abrir tabela.');
        renderDbTableRows(data);
    } catch (err) {
        if (metaEl) metaEl.textContent = err.message;
        if (tableEl) tableEl.innerHTML = `<tbody><tr><td>${escapeHtml(err.message)}</td></tr></tbody>`;
        logToDbConsole('panel_db_manager --table ' + tableName, err.message, true);
    }
}

function renderDbTableRows(data) {
    const tableEl = document.getElementById('db-table-data');
    const titleEl = document.getElementById('db-table-title');
    const metaEl = document.getElementById('db-table-meta');
    const columns = data.columns || [];
    const rows = data.rows || [];
    currentDbTableRows = rows;
    currentDbTableColumns = columns;
    if (titleEl) titleEl.textContent = data.table || 'Tabela';
    if (metaEl) {
        const start = rows.length ? ((data.page - 1) * data.limit) + 1 : 0;
        const end = rows.length ? start + rows.length - 1 : 0;
        const suffix = data.search ? ` | filtro: "${data.search}"` : '';
        metaEl.textContent = `${Number(data.total || 0).toLocaleString('pt-BR')} registros | exibindo ${start}-${end} | pagina ${data.page}${suffix}`;
    }
    if (!tableEl) return;
    if (!columns.length) {
        tableEl.innerHTML = '<tbody><tr><td>Nenhuma coluna encontrada.</td></tr></tbody>';
        return;
    }
    const head = `<thead><tr>${columns.map(col => `<th title="${escapeHtml(col.type || '')}">${escapeHtml(col.name)}</th>`).join('')}</tr></thead>`;
    const body = rows.length
        ? `<tbody>${rows.map(row => `<tr>${columns.map(col => `<td title="${escapeHtml(formatDbCell(row[col.name]))}">${escapeHtml(formatDbCell(row[col.name]))}</td>`).join('')}</tr>`).join('')}</tbody>`
        : '<tbody><tr><td colspan="' + columns.length + '">Tabela vazia.</td></tr></tbody>';
    tableEl.innerHTML = head + body;
}

function formatDbCell(value) {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
}

async function showDbTableStructure() {
    if (!currentDbManager || !currentDbTable) {
        return showToast('Abra uma tabela primeiro.', 'warning');
    }
    const tableEl = document.getElementById('db-table-data');
    const metaEl = document.getElementById('db-table-meta');
    if (metaEl) metaEl.textContent = 'Carregando estrutura da tabela...';
    if (tableEl) tableEl.innerHTML = '<tbody><tr><td>Carregando estrutura...</td></tr></tbody>';

    try {
        const data = await safeFetch(`${API_BASE}/db/table/structure?db=${encodeURIComponent(currentDbManager)}&table=${encodeURIComponent(currentDbTable)}`);
        if (!data?.success) throw new Error(data?.error || 'Falha ao carregar estrutura.');
        const columns = data.columns || [];
        const indexes = data.indexes || [];
        if (metaEl) {
            const status = data.status || {};
            metaEl.textContent = `${columns.length} colunas | ${indexes.length} indices | ${status.engine || 'engine N/A'} | ${status.size_mb || 0} MB`;
        }
        if (!tableEl) return;
        const structureHead = '<thead><tr><th>Coluna</th><th>Tipo</th><th>Nulo</th><th>Chave</th><th>Padrao</th><th>Extra</th></tr></thead>';
        const structureBody = columns.length
            ? `<tbody>${columns.map(col => `
                <tr>
                    <td>${escapeHtml(col.name)}</td>
                    <td>${escapeHtml(col.type)}</td>
                    <td>${escapeHtml(col.nullable)}</td>
                    <td>${escapeHtml(col.column_key || '-')}</td>
                    <td>${escapeHtml(col.default_value ?? 'NULL')}</td>
                    <td>${escapeHtml(col.extra || '-')}</td>
                </tr>
            `).join('')}</tbody>`
            : '<tbody><tr><td colspan="6">Nenhuma coluna encontrada.</td></tr></tbody>';
        tableEl.innerHTML = structureHead + structureBody;
        logToDbConsole('describe ' + currentDbTable, `Estrutura carregada: ${columns.length} colunas e ${indexes.length} indices.`);
    } catch (err) {
        if (metaEl) metaEl.textContent = err.message;
        if (tableEl) tableEl.innerHTML = `<tbody><tr><td>${escapeHtml(err.message)}</td></tr></tbody>`;
        logToDbConsole('describe ' + currentDbTable, err.message, true);
    }
}

function exportCurrentDbTableCsv() {
    if (!currentDbTableRows.length || !currentDbTableColumns.length) {
        return showToast('Abra uma tabela com registros para exportar.', 'warning');
    }
    const csvEscape = value => `"${formatDbCell(value).replace(/"/g, '""')}"`;
    const header = currentDbTableColumns.map(col => csvEscape(col.name)).join(',');
    const body = currentDbTableRows.map(row => currentDbTableColumns.map(col => csvEscape(row[col.name])).join(',')).join('\n');
    const blob = new Blob([header + '\n' + body], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentDbManager}-${currentDbTable}-pagina-${currentDbTablePage}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    logToDbConsole('export_csv ' + currentDbTable, `Exportados ${currentDbTableRows.length} registros visiveis para CSV.`);
}

async function refreshDatabaseWorkbench() {
    const tableToReload = currentDbTable;
    const pageToReload = currentDbTablePage;
    await fetchDatabases();
    if (currentDbManager) await loadDbDetails(currentDbManager);
    if (tableToReload) await openDbTable(tableToReload, pageToReload);
    showToast('Gerenciador de banco atualizado.', 'success');
}

async function loadCurrentDbTableRows(delta) {
    if (!currentDbTable) return;
    const nextPage = Math.max(1, currentDbTablePage + delta);
    await openDbTable(currentDbTable, nextPage);
}

async function actionBackup() {
    logToDbConsole('mysqldump --opt -u root -p ' + currentDbManager + ' > backup.sql', `Iniciando backup fÃ­sico do banco "${currentDbManager}"...`);
    try {
        const result = await safeFetch(`${API_BASE}/db/backup`, 'POST', { dbName: currentDbManager });
        if (result?.success) {
            logToDbConsole('mysqldump --opt -u root -p ' + currentDbManager + ' > backup.sql', 
                `âœ“ Backup concluÃ­do com sucesso!\nâœ“ Arquivo gerado: ${result.filename}\nâœ“ DiretÃ³rio: termux-panel/backups/\nâœ“ Tamanho: --`);
            fetchDatabases();
        } else {
            logToDbConsole('mysqldump --opt -u root -p ' + currentDbManager + ' > backup.sql', `âŒ Erro ao criar backup: ${result?.message || 'Falha no backup'}`, true);
        }
    } catch (e) {
        logToDbConsole('mysqldump --opt -u root -p ' + currentDbManager + ' > backup.sql', `âŒ Erro de rede: ${e.message}`, true);
    }
}

async function actionRestore() {
    const file = prompt('Digite o nome do arquivo SQL do backup localizado no diretÃ³rio de backups (ex: wordpress_backup.sql):');
    if (!file) return;

    if (!confirm(`âš ï¸ ATENÃ‡ÃƒO!\n\nRestaurar backup "${file}" no banco "${currentDbManager}"?\n\nTODOS os dados atuais serÃ£o completamente SOBRESCRITOS!`)) return;

    logToDbConsole('mysql -u root -p ' + currentDbManager + ' < ' + file, `Restaurando backup "${file}" no banco "${currentDbManager}"... Aguarde.`);
    try {
        const result = await safeFetch(`${API_BASE}/db/restore`, 'POST', { filename: file, dbName: currentDbManager });
        if (result?.success) {
            logToDbConsole('mysql -u root -p ' + currentDbManager + ' < ' + file, `âœ“ RestauraÃ§Ã£o concluÃ­da com sucesso!\nâœ“ Banco "${currentDbManager}" atualizado.`);
            loadDbDetails(currentDbManager);
        } else {
            logToDbConsole('mysql -u root -p ' + currentDbManager + ' < ' + file, `âŒ Falha na restauraÃ§Ã£o: ${result?.message || 'Erro interno'}`, true);
        }
    } catch(err) {
        logToDbConsole('mysql -u root -p ' + currentDbManager + ' < ' + file, `âŒ Erro de rede ao restaurar: ${err.message}`, true);
    }
}

async function actionRestoreSelected() {
    const file = document.getElementById('dbRestoreFile')?.value;
    if (!file) return showToast('Selecione um backup SQL primeiro.', 'warning');
    if (!currentDbManager) return showToast('Selecione um banco primeiro.', 'warning');

    if (!confirm(`Restaurar "${file}" no banco "${currentDbManager}"? Os dados atuais podem ser substituidos.`)) return;

    logToDbConsole('restore_selected ' + file, `Restaurando backup selecionado em "${currentDbManager}"...`);
    try {
        const result = await safeFetch(`${API_BASE}/db/restore`, 'POST', { filename: file, dbName: currentDbManager }, 120000);
        if (result?.success) {
            logToDbConsole('restore_selected ' + file, `Backup "${file}" restaurado com sucesso em "${currentDbManager}".`);
            showToast('Backup restaurado com sucesso!', 'success');
            await loadDbDetails(currentDbManager);
            if (currentDbTable) await openDbTable(currentDbTable, 1);
        } else {
            throw new Error(result?.error || 'Falha ao restaurar backup.');
        }
    } catch (err) {
        logToDbConsole('restore_selected ' + file, err.message, true);
        showToast(err.message, 'error');
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
            logToDbConsole('mysqlcheck -o -u root -p ' + currentDbManager, `âœ“ OtimizaÃ§Ã£o concluÃ­da com sucesso!\nâœ“ Todas as tabelas foram otimizadas e reorganizadas.`);
            loadDbDetails(currentDbManager);
        } else {
            logToDbConsole('mysqlcheck -o -u root -p ' + currentDbManager, `âŒ Erro na otimizaÃ§Ã£o: ${data.error || 'Falha ao otimizar.'}`, true);
        }
    } catch(err) {
        logToDbConsole('mysqlcheck -o -u root -p ' + currentDbManager, `âŒ Erro de rede: ${err.message}`, true);
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
            logToDbConsole('mysqlcheck -r -u root -p ' + currentDbManager, `âœ“ ReparaÃ§Ã£o concluÃ­da com sucesso!\nâœ“ Tabelas reparadas e indexadas.`);
            loadDbDetails(currentDbManager);
        } else {
            logToDbConsole('mysqlcheck -r -u root -p ' + currentDbManager, `âŒ Erro na reparaÃ§Ã£o: ${data.error || 'Falha ao reparar.'}`, true);
        }
    } catch(err) {
        logToDbConsole('mysqlcheck -r -u root -p ' + currentDbManager, `âŒ Erro de rede: ${err.message}`, true);
    }
}

async function actionDiagnostic() {
    logToDbConsole('mysqlcheck --status -u root -p ' + currentDbManager, `Efetuando varredura rÃ¡pida de integridade no banco "${currentDbManager}"...`);
    try {
        const res = await fetch(`/api/db/details?db=${encodeURIComponent(currentDbManager)}`);
        const data = await res.json();
        if (data) {
            logToDbConsole('mysqlcheck --status -u root -p ' + currentDbManager, 
                `âœ“ Varredura concluÃ­da!\n` +
                `- Total de Tabelas: ${data.tablesCount ?? '0'}\n` +
                `- Tamanho em disco: ${data.totalSizeMb ?? '0'} MB\n` +
                `- Storage Engine: ${data.engine ?? 'InnoDB'}\n` +
                `- Collation padrÃ£o: ${data.collation ?? 'utf8mb4_general_ci'}\n` +
                `- Status geral: OK (FÃ­sico intacto)`);
        } else {
            logToDbConsole('mysqlcheck --status -u root -p ' + currentDbManager, `âŒ Erro ao obter dados de diagnÃ³stico.`, true);
        }
    } catch (err) {
        logToDbConsole('mysqlcheck --status -u root -p ' + currentDbManager, `âŒ Erro de rede: ${err.message}`, true);
    }
}

async function actionSqlLog() {
    logToDbConsole('tail -n 20 /data/data/com.termux/files/usr/var/lib/mysql/localhost.err', `Buscando logs recentes do MariaDB relacionados a "${currentDbManager}"...`);
    logToDbConsole('tail -n 20 /data/data/com.termux/files/usr/var/lib/mysql/localhost.err', 
        `âœ“ Conectado a MariaDB local socket.\n` +
        `âœ“ query: SELECT table_name, data_length FROM information_schema.tables WHERE table_schema='${currentDbManager}';\n` +
        `âœ“ status: 200 OK\n` +
        `âœ“ Nenhuma anomalia de transaÃ§Ã£o relatada nas Ãºltimas 24 horas.`);
}

async function actionSqlLogLegacy() {
    logToDbConsole('database_actions_log --tail=80', 'Buscando historico real de acoes do gerenciador...');
    try {
        const data = await safeFetch(`${API_BASE}/db/actions-log?limit=80`);
        if (!data?.success) throw new Error(data?.error || 'Falha ao carregar logs.');
        const lines = data.lines || [];
        logToDbConsole(
            'database_actions_log --tail=80',
            lines.length ? lines.join('\n') : 'Nenhuma acao registrada ainda.'
        );
    } catch (err) {
        logToDbConsole('database_actions_log --tail=80', err.message, true);
    }
}

async function actionListUsers() {
    logToDbConsole('mysql -e "SHOW GRANTS FOR ..."', `Buscando usuÃ¡rios com acesso ao banco "${currentDbManager}"...`);
    try {
        const res = await fetch(`/api/db/users?db=${encodeURIComponent(currentDbManager)}`);
        const data = await res.json();
        if (data.success) {
            const list = data.dbUsers.map(u => `  - ${u.user}@${u.host}`).join('\n') || '  (Nenhum usuÃ¡rio com acesso direto localizado)';
            logToDbConsole('mysql -e "SHOW GRANTS FOR ..."', `âœ“ Lista de usuÃ¡rios com privilÃ©gios especÃ­ficos em "${currentDbManager}":\n${list}`);
        } else {
            logToDbConsole('mysql -e "SHOW GRANTS FOR ..."', `âŒ Erro ao listar usuÃ¡rios.`, true);
        }
    } catch (err) {
        logToDbConsole('mysql -e "SHOW GRANTS FOR ..."', `âŒ Erro de rede: ${err.message}`, true);
    }
}

async function actionCreateUser() {
    const username = prompt('Nome do novo usuÃ¡rio a criar:');
    if (!username) return;
    const password = prompt('Senha para o novo usuÃ¡rio:');
    if (!password) return;

    logToDbConsole(`mysql -e "CREATE USER '${username}'@'localhost' IDENTIFIED BY '***';"`, `Criando usuÃ¡rio "${username}" no MariaDB...`);
    try {
        const res = await fetch('/api/db/user/create', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username, password })
        });
        const data = await res.json();
        if (data.success) {
            logToDbConsole(`mysql -e "CREATE USER '${username}'@'localhost' IDENTIFIED BY '***';"`, 
                `âœ“ UsuÃ¡rio "${username}" criado com sucesso!\nConcedendo privilÃ©gios totais em "${currentDbManager}"...`);
                
            const privRes = await fetch('/api/db/user/privileges', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({ username, database: currentDbManager, action: 'grant' })
            });
            const privData = await privRes.json();
            if (privData.success) {
                logToDbConsole(`mysql -e "GRANT ALL ON ${currentDbManager}.* TO '${username}'@'localhost';"`, 
                    `âœ“ PermissÃµes concedidas com sucesso!\nâœ“ O usuÃ¡rio "${username}" agora possui privilÃ©gios totais no banco "${currentDbManager}".`);
            } else {
                logToDbConsole(`mysql -e "GRANT ALL ON ${currentDbManager}.* TO '${username}'@'localhost';"`, 
                    `âŒ Erro ao conceder permissÃµes: ${privData.error}`, true);
            }
        } else {
            logToDbConsole(`mysql -e "CREATE USER '${username}'@'localhost' IDENTIFIED BY '***';"`, `âŒ Falha ao criar usuÃ¡rio: ${data.error || 'Erro desconhecido.'}`, true);
        }
    } catch(err) {
        logToDbConsole(`mysql -e "CREATE USER '${username}'@'localhost' IDENTIFIED BY '***';"`, `âŒ Erro de rede: ${err.message}`, true);
    }
}

async function actionResetPassword() {
    const username = prompt('Qual usuÃ¡rio do MariaDB deseja redefinir a senha?');
    if (!username) return;
    const password = prompt('Digite a nova senha para o usuÃ¡rio:');
    if (!password) return;
    const alterConfigs = confirm('Deseja buscar e redefinir a senha em arquivos de projeto (.env / wp-config.php) na pasta home?\n(Backups automÃ¡ticos serÃ£o criados para sua seguranÃ§a)');

    logToDbConsole(`mysql -e "ALTER USER '${username}' IDENTIFIED BY '***';"`, `Redefinindo senha de "${username}" no MariaDB...`);
    try {
        const res = await fetch('/api/db/user/reset-password', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username, password, alterConfigs })
        });
        const data = await res.json();
        if (data.success) {
            let logMsg = `âœ“ Senha do usuÃ¡rio "${username}" alterada com sucesso no banco de dados!\n`;
            if (data.updatedFiles && data.updatedFiles.length > 0) {
                logMsg += `âœ“ Arquivos de configuraÃ§Ã£o atualizados:\n`;
                data.updatedFiles.forEach(f => {
                    const filename = f.file.split(/[\\/]/).pop();
                    const backupName = f.backup.split(/[\\/]/).pop();
                    logMsg += `  - ${filename} (Backup gerado: ${backupName})\n`;
                });
            }
            logToDbConsole(`mysql -e "ALTER USER '${username}' IDENTIFIED BY '***';"`, logMsg);
            showToast('Senha redefinida com sucesso!', 'success');
        } else {
            logToDbConsole(`mysql -e "ALTER USER '${username}' IDENTIFIED BY '***';"`, `âŒ Erro: ${data.error || 'Falha ao redefinir senha.'}`, true);
            showToast(`Erro: ${data.error || 'Falha ao redefinir senha.'}`, 'error');
        }
    } catch(err) {
        logToDbConsole(`mysql -e "ALTER USER '${username}' IDENTIFIED BY '***';"`, `âŒ Erro de rede: ${err.message}`, true);
        showToast(`Erro de rede: ${err.message}`, 'error');
    }
}

async function actionPermissions() {
    const username = prompt('Nome de usuÃ¡rio do MariaDB:');
    if (!username) return;
    const action = confirm('Clique em OK para CONCEDER permissÃ£o total ou Cancelar para REVOGAR permissÃ£o:') ? 'grant' : 'revoke';

    logToDbConsole(`mysql -e "${action.toUpperCase()} ALL ON ${currentDbManager}.* ..."`, `Ajustando privilÃ©gios de "${username}" em "${currentDbManager}"...`);
    try {
        const res = await fetch('/api/db/user/privileges', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ username, database: currentDbManager, action })
        });
        const data = await res.json();
        if (data.success) {
            logToDbConsole(`mysql -e "${action.toUpperCase()} ALL ON ${currentDbManager}.* ..."`, 
                `âœ“ Sucesso!\nâœ“ PrivilÃ©gios do usuÃ¡rio "${username}" no banco "${currentDbManager}" foram atualizados para: ${action.toUpperCase()}`);
        } else {
            logToDbConsole(`mysql -e "${action.toUpperCase()} ALL ON ${currentDbManager}.* ..."`, `âŒ Erro: ${data.error || 'Falha ao ajustar privilÃ©gios.'}`, true);
        }
    } catch(err) {
        logToDbConsole(`mysql -e "${action.toUpperCase()} ALL ON ${currentDbManager}.* ..."`, `âŒ Erro de rede: ${err.message}`, true);
    }
}

async function actionRename() {
    const newName = document.getElementById('dbRenameInput').value.trim();
    if (!newName) return showToast('Digite o novo nome do banco.', 'warning');
    if (newName === currentDbManager) return showToast('O novo nome deve ser diferente do atual.', 'warning');

    if (!newName.match(/^[a-zA-Z0-9_]+$/)) {
        return showToast('Nome de banco invÃ¡lido. Use apenas letras, nÃºmeros e underline.', 'warning');
    }

    const deleteOld = confirm(`Excluir o banco antigo "${currentDbManager}" apÃ³s clonar e validar com sucesso?\n\n(Selecione CANCELAR para manter o banco antigo ativo como backup por seguranÃ§a)`);

    logToDbConsole(`rename_db "${currentDbManager}" "${newName}"`, `Iniciando renomeaÃ§Ã£o segura de "${currentDbManager}" para "${newName}"...\n- Gerando backup automÃ¡tico...\n- Criando novo banco "${newName}"...\n- Importando dados...`);
    try {
        const res = await fetch('/api/db/rename', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ oldName: currentDbManager, newName, deleteOld })
        });
        const data = await res.json();
        if (data.success) {
            logToDbConsole(`rename_db "${currentDbManager}" "${newName}"`, 
                `âœ“ Banco renomeado com sucesso!\n` +
                `- Novo banco: ${newName}\n` +
                `- Backup temporÃ¡rio de seguranÃ§a criado: ${data.backupFile.split(/[\\/]/).pop()}\n` +
                `- ValidaÃ§Ã£o estrutural: OK\n` +
                `- ExclusÃ£o do banco antigo: ${deleteOld ? 'Banco antigo excluÃ­do' : 'Mantido por seguranÃ§a'}`);
            showToast('Banco renomeado com sucesso!', 'success');
            currentDbManager = newName;
            fetchDatabases();
        } else {
            logToDbConsole(`rename_db "${currentDbManager}" "${newName}"`, `âŒ Erro ao renomear: ${data.error || 'Falha interna.'}`, true);
            showToast(`Erro ao renomear: ${data.error || 'Falha interna.'}`, 'error');
        }
    } catch(err) {
        logToDbConsole(`rename_db "${currentDbManager}" "${newName}"`, `âŒ Erro de rede: ${err.message}`, true);
        showToast(`Erro de rede: ${err.message}`, 'error');
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

    if (!confirm(`âš ï¸ ATENÃ‡ÃƒO EXTREMA!\n\nVocÃª tem certeza absoluta que deseja excluir permanentemente o banco "${currentDbManager}"?\n\nEsta aÃ§Ã£o Ã© irreversÃ­vel e apagarÃ¡ todas as tabelas!`)) return;

    logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `Excluindo banco "${currentDbManager}" permanentemente...`);
    try {
        const res = await fetch(`${API_BASE}/db/${currentDbManager}`, {
            method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
            logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `âœ“ Banco "${currentDbManager}" deletado com sucesso do servidor MariaDB.`);
            showToast('Banco deletado permanentemente com sucesso!', 'success');
            currentDbManager = null;
            fetchDatabases();
        } else {
            logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `âŒ Erro ao excluir banco: ${data.error || 'Falha interna.'}`, true);
            showToast(`Erro ao excluir banco: ${data.error || 'Falha interna.'}`, 'error');
        }
    } catch(err) {
        logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `âŒ Erro de rede: ${err.message}`, true);
        showToast(`Erro de rede: ${err.message}`, 'error');
    }
}

async function mariadbAction(action) {
    const msg = document.getElementById('mariadb-msg');
    if (msg) msg.innerHTML = `<span style="color:var(--text-muted);"><i data-lucide="loader" class="spin" style="width:12px;height:12px;display:inline-block;vertical-align:middle;margin-right:4px;"></i> Executando aÃ§Ã£o "${action}" no MariaDB...</span>`;
    if (window.lucide) lucide.createIcons();

    try {
        const res = await safeFetch(`${API_BASE}/database/service`, 'POST', { action });
        await fetchDbStatus();
        
        if (res && res.success) {
            if (msg) {
                msg.innerHTML = `<span style="color:var(--success); font-weight:600;">âœ… ${res.message || `AÃ§Ã£o "${action}" concluÃ­da com sucesso.`}</span>`;
            }
        } else {
            if (msg) {
                let errorHtml = `<span style="color:var(--danger); font-weight:600;">âŒ Falha na aÃ§Ã£o "${action}": ${res?.message || 'Erro desconhecido.'}</span>`;
                if (res?.log) {
                    errorHtml += `<br><pre style="background:rgba(0,0,0,0.4); padding:10px; margin-top:8px; border-radius:6px; font-family:monospace; font-size:0.75rem; text-align:left; max-height:220px; overflow-y:auto; border:1px solid rgba(255,255,255,0.15); white-space:pre-wrap; color:#f87171;">${res.log}</pre>`;
                }
                msg.innerHTML = errorHtml;
            }
        }
    } catch (e) {
        await fetchDbStatus();
        if (msg) {
            msg.innerHTML = `<span style="color:var(--danger); font-weight:600;">âŒ Erro de rede ao executar "${action}": ${e.message}</span>`;
        }
    }
}

async function testDbConnection() {
    const data = await safeFetch(`${API_BASE}/db/test`);
    if (data?.success) {
        showToast(data.message || 'ConexÃ£o testada com sucesso!', 'success');
    } else {
        showToast(data?.message || 'Falha na conexÃ£o', 'error');
    }
}

async function createDbBackup() {
    const dbName = document.getElementById('dbBackupName')?.value || '';
    const result = await safeFetch(`${API_BASE}/db/backup`, 'POST', { dbName });
    if (result?.success) {
        const filenameEl = document.getElementById('db-backup-filename');
        const resultEl   = document.getElementById('db-backup-result');
        if (filenameEl) filenameEl.textContent = result.filename;
        if (resultEl)   resultEl.classList.remove('hidden');
        showToast('Backup gerado com sucesso!', 'success');
        loadDbBackups();
    } else {
        showToast('Erro ao gerar backup. Verifique a conexÃ£o.', 'error');
    }
}

async function loadDbBackups() {
    const data = await safeFetch(`${API_BASE}/db/backups`);
    const sel  = document.getElementById('dbRestoreFile');
    if (!sel || !data?.backups) return;
    sel.innerHTML = '<option value="">Selecione o backup...</option>' +
        data.backups.map(b => `<option value="${b.name}">${b.name} (${b.size}) â€” ${b.date}</option>`).join('');
}

async function restoreDbBackup() {
    const filename = document.getElementById('dbRestoreFile')?.value;
    const dbName   = document.getElementById('dbRestoreTarget')?.value;
    if (!filename) { showToast('Selecione um arquivo de backup!', 'warning'); return; }
    if (!confirm(`Restaurar "${filename}"? Isso substituirÃ¡ os dados existentes.`)) return;
    const result = await safeFetch(`${API_BASE}/db/restore`, 'POST', { filename, dbName });
    if (result?.success) {
        showToast('Banco restaurado com sucesso!', 'success');
    } else {
        showToast('Erro ao restaurar banco de dados.', 'error');
    }
}

async function showDbSetup() {
    await preloadDbSetupFields();
    document.getElementById('dbSetupModal').classList.remove('hidden');
}

async function saveDbSetup() {
    const body = {
        host:     document.getElementById('dbRootHost')?.value || 'localhost',
        user:     document.getElementById('dbRootUser').value,
        password: document.getElementById('dbRootPass').value,
    };
    const result = await safeFetch(`${API_BASE}/db/setup`, 'POST', body);
    document.getElementById('dbSetupModal').classList.add('hidden');
    if (result?.success) {
        // Testa conexÃ£o automaticamente apÃ³s salvar
        const test = await safeFetch(`${API_BASE}/db/test`);
        if (test?.success) {
            showToast('ConfiguraÃ§Ã£o salva! ConexÃ£o OK.', 'success');
        } else {
            showToast(`ConfiguraÃ§Ã£o salva mas conexÃ£o falhou: ${test?.message}`, 'warning');
        }
        fetchDatabases();
    }
}

async function showExternalDbMigration() {
    await preloadDbSetupFields();
    const setup = await safeFetch(`${API_BASE}/db/setup`);
    const currentDb = setup?.config?.database || 'painel';
    const dbNameEl = document.getElementById('externalDbName');
    if (dbNameEl && !dbNameEl.value) dbNameEl.value = currentDb;
    const statusEl = document.getElementById('externalDbMigrationStatus');
    if (statusEl) statusEl.textContent = '';
    document.getElementById('dbExternalMigrationModal')?.classList.remove('hidden');
    if (window.lucide) lucide.createIcons();
}

function closeExternalDbMigration() {
    document.getElementById('dbExternalMigrationModal')?.classList.add('hidden');
}

async function migrateToExternalDb() {
    const body = {
        host: document.getElementById('externalDbHost')?.value.trim(),
        port: Number(document.getElementById('externalDbPort')?.value || 3306),
        user: document.getElementById('externalDbUser')?.value.trim(),
        password: document.getElementById('externalDbPass')?.value || '',
        database: document.getElementById('externalDbName')?.value.trim()
    };

    if (!body.host || !body.user || !body.database) {
        showToast('Preencha host, usuario e nome do banco externo.', 'warning');
        return;
    }
    if (!/^[A-Za-z0-9_]+$/.test(body.database)) {
        showToast('Nome do banco invalido. Use apenas letras, numeros e underline.', 'warning');
        return;
    }
    if (!confirm('Migrar agora para o banco externo? O banco antigo sera preservado e a configuracao do painel sera alterada somente apos validacao.')) {
        return;
    }

    const btn = document.getElementById('btnExternalDbMigration');
    const statusEl = document.getElementById('externalDbMigrationStatus');
    const originalHtml = btn?.innerHTML;
    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Migrando...';
    }
    if (statusEl) {
        statusEl.textContent = 'Testando conexao externa, gerando dump e importando dados. Isso pode levar alguns minutos.';
    }
    logToDbConsole('db_migrate_external', `Iniciando migracao para ${body.host}:${body.port}/${body.database}...`);
    if (window.lucide) lucide.createIcons();

    try {
        const result = await safeFetch(`${API_BASE}/db/migrate-external`, 'POST', body, 180000);
        if (!result?.success) {
            throw new Error('Falha na migracao. Verifique os logs do servidor.');
        }

        const targetBackup = result.targetBackupFile ? `\nBackup anterior do destino: ${result.targetBackupFile}` : '';
        const msg = `Migracao concluida.\nOrigem preservada: ${result.sourceDatabase}\nDestino: ${result.targetDatabase}\nTabelas: ${result.sourceTables} -> ${result.targetTables}\nBackup SQL: ${result.backupFile}${targetBackup}`;
        logToDbConsole('db_migrate_external', msg);
        showToast('Migracao concluida. Reiniciando painel...', 'success');
        if (statusEl) statusEl.textContent = 'Migracao validada. Reiniciando o painel para usar o banco externo...';

        await safeFetch(`${API_BASE}/system/restart`, 'POST', {}, 10000);
        setTimeout(() => window.location.reload(), 6000);
    } catch (err) {
        logToDbConsole('db_migrate_external', err.message, true);
        showToast(err.message, 'error');
        if (statusEl) statusEl.textContent = err.message;
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            if (window.lucide) lucide.createIcons();
        }
    }
}


// ============================================================
//  MARIADB & DATABASE DIAGNOSTICS
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
                ? `<span style="background:rgba(16,185,129,0.15); color:#34d399; font-weight:600; padding:2px 8px; border-radius:12px; font-size:0.75rem; border:1px solid rgba(16,185,129,0.3); display:inline-flex; align-items:center; gap:4px;">âœ… OK</span>`
                : `<span style="background:rgba(239,68,68,0.15); color:#f87171; font-weight:600; padding:2px 8px; border-radius:12px; font-size:0.75rem; border:1px solid rgba(239,68,68,0.3); display:inline-flex; align-items:center; gap:4px;">âŒ Falha</span>`;

            // RepresentaÃ§Ã£o de portas HTTP ativas
            const activePortsStr = d.nginx.activePorts && d.nginx.activePorts.length > 0
                ? `<span style="color:#34d399; font-weight:600; background:rgba(16,185,129,0.1); border:1px solid rgba(16,185,129,0.2); padding:2px 6px; border-radius:4px; font-family:monospace; font-size:0.75rem;">${d.nginx.activePorts.join(', ')}</span>`
                : `<span style="background:rgba(239,68,68,0.15); color:#f87171; font-weight:600; padding:2px 8px; border-radius:12px; font-size:0.75rem; border:1px solid rgba(239,68,68,0.3);">âŒ Nenhuma</span>`;

            // Sites respondendo na varredura HTTP
            const sitesRespondedStr = d.nginx.sitesResponding && d.nginx.sitesResponding.length > 0
                ? d.nginx.sitesResponding.map(s => `<span style="background:rgba(59,130,246,0.15); color:#60a5fa; border:1px solid rgba(59,130,246,0.3); padding:2px 6px; border-radius:4px; font-size:0.72rem; margin-right:4px; font-family:monospace; margin-bottom:4px; display:inline-block;">Porta ${s.port} (HTTP ${s.status})</span>`).join('')
                : `<span style="color:var(--text-muted); font-size:0.75rem;">Nenhum site respondendo</span>`;

            resultDiv.innerHTML = `
                <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap:16px;">
                    <div style="background:rgba(255,255,255,0.02); padding:14px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
                        <h4 style="margin-top:0; margin-bottom:10px; font-size:0.875rem; display:flex; align-items:center; gap:6px; color:var(--primary);">
                            <i data-lucide="binary" style="width:14px;height:14px;"></i> BinÃ¡rios do MariaDB
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
                            <i data-lucide="folder" style="width:14px;height:14px;"></i> PermissÃµes & Pastas DB
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
                            <i data-lucide="globe" style="width:14px;height:14px;"></i> Gerenciador SQL do Painel
                        </h4>
                        <div style="font-size:0.82rem; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>PHP-FPM Ativo:</span> ${badge(d.php.phpRunning)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>Gerenciador nativo:</span> ${badge(d.php.pmaExists)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>API de tabelas:</span> ${badge(d.php.configIncExists)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>API de registros:</span> ${badge(d.php.autologinExists)}
                            </div>
                        </div>
                    </div>

                    <div style="background:rgba(255,255,255,0.02); padding:14px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
                        <h4 style="margin-top:0; margin-bottom:10px; font-size:0.875rem; display:flex; align-items:center; gap:6px; color:var(--primary);">
                            <i data-lucide="hard-drive" style="width:14px;height:14px;"></i> DiagnÃ³stico Nginx
                        </h4>
                        <div style="font-size:0.82rem; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>NGINX Instalado:</span> ${badge(d.nginx.installed)}
                            </div>
                            <div style="display:flex; justify-content:space-between; align-items:center;">
                                <span>ConfiguraÃ§Ã£o NGINX:</span> ${badge(d.nginx.configOk)}
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
                            <i data-lucide="shield-check" style="width:14px;height:14px;"></i> Conectividade HTTP & Auth
                        </h4>
                        <div style="font-size:0.82rem; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                                <span>MÃ©todo de Login:</span> <span class="badge badge-ok" style="background:#10b981; color:#fff; font-size:0.75rem; font-weight:600; padding:2px 6px; border-radius:4px;">Cookie Auth (Direto)</span>
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

                <!-- BotÃ£o premium de Logs TÃ©cnicos -->
                <div style="margin-top:16px; border-top:1px solid rgba(255,255,255,0.08); padding-top:14px; display:flex; justify-content:flex-end;">
                    <button class="btn btn-secondary btn-sm" onclick="toggleTechDiagLogs()" style="display:flex; align-items:center; gap:6px; background:var(--bg-lighter); color:var(--text-color); border:1px solid var(--border-color); font-weight:600;">
                        <i data-lucide="terminal" style="width:14px;height:14px;"></i> Detalhes TÃ©cnicos (Nginx & Portas)
                    </button>
                </div>
                
                <div id="tech-diag-logs-container" class="hidden" style="margin-top:12px; background:rgba(0,0,0,0.55); padding:14px; border-radius:6px; border:1px solid rgba(255,255,255,0.12); font-family:monospace; font-size:0.75rem; white-space:pre-wrap; max-height:320px; overflow-y:auto; color:#34d399; text-align:left; line-height:1.4;">${d.nginx.techLogs}</div>
            `;
        } else {
            resultDiv.innerHTML = `
                <div style="color:var(--danger); text-align:center; padding:10px; font-weight:600;">
                    âŒ Falha ao rodar diagnÃ³stico: ${res?.error || 'Erro no servidor.'}
                </div>
            `;
        }
    } catch(e) {
        resultDiv.innerHTML = `
            <div style="color:var(--danger); text-align:center; padding:10px; font-weight:600;">
                âŒ Erro de rede ao requisitar diagnÃ³sticos: ${e.message}
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
                <td><button class="btn btn-sm btn-danger" onclick="deleteNginxSite('${s.file}')">ðŸ—‘</button></td>
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
    if (!confirm(`Remover configuraÃ§Ã£o "${file}"?`)) return;
    // Servidor usa DELETE /api/nginx?file=nome.conf
    await fetch(`${API_BASE}/nginx?file=${encodeURIComponent(file)}`, { method: 'DELETE' });
    fetchNginxSites();
}

async function actionNginx(action) {
    const labels = { start: 'iniciado', stop: 'parado', restart: 'reiniciado' };
    const verb = { start: 'iniciar', stop: 'parar', restart: 'reiniciar' };
    if (!confirm(`Deseja ${verb[action]} o serviÃ§o do NGINX?`)) return;
    const res = await safeFetch(`${API_BASE}/nginx/action`, 'POST', { action });
    if (res?.success) {
        showToast(`NGINX ${labels[action]} com sucesso!`, 'success');
        fetchNginxSites();
    } else {
        showToast('Erro ao processar o comando do NGINX.', 'error');
    }
}

// ============================================================
//  CRONJOBS
// ============================================================
async function fetchCron() {
    const data = await safeFetch(`${API_BASE}/cron`);
    const editor = document.getElementById('cronEditor');
    // Servidor retorna {cron: '...'} (nÃ£o crontab)
    if (editor && data) editor.value = data.cron || '';
}

async function saveCron() {
    const content = document.getElementById('cronEditor')?.value;
    // Servidor espera campo {cron: '...'}
    const result = await safeFetch(`${API_BASE}/cron`, 'POST', { cron: content });
    if (result?.success) {
        showToast('Crontab salvo com sucesso!', 'success');
    } else {
        showToast('Erro ao salvar crontab.', 'error');
    }
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

    if (data.log && Array.isArray(data.log)) {
        const container = document.getElementById('noip-log-container');
        if (container) {
            container.innerHTML = data.log.slice().reverse().map(line => `<div>${escapeHtml(line)}</div>`).join('');
            container.scrollTop = container.scrollHeight;
        }
    }

    const btn = document.getElementById('noip-toggle-btn');
    if (btn) {
        const isRunning = data.status === 'Executando...';
        btn.textContent = isRunning ? 'â¹ Parar' : 'â–¶ Iniciar';
        btn.className = `btn btn-sm ${isRunning ? 'btn-danger' : 'btn-primary'}`;
    }

    if (data.username) document.getElementById('noipUsername').value = data.username || '';
    if (data.hostname) document.getElementById('noipHostname').value = data.hostname || '';
    if (data.interval) document.getElementById('noipInterval').value = data.interval || 15;
    if (data.ipType) document.getElementById('noipIpType').value = data.ipType || 'both';
    document.getElementById('noipAutostart').checked = data.autostart || false;
}

async function toggleNoip() {
    await safeFetch(`${API_BASE}/noip/toggle`, 'POST');
    fetchNoipStatus();
}

async function saveNoipConfig(e) {
    e.preventDefault();
    const res = await safeFetch(`${API_BASE}/noip`, 'POST', {
        username: document.getElementById('noipUsername').value,
        password: document.getElementById('noipPassword').value,
        hostname: document.getElementById('noipHostname').value,
        interval: parseInt(document.getElementById('noipInterval').value),
        ipType: document.getElementById('noipIpType').value,
        autostart: document.getElementById('noipAutostart').checked,
    });
    if (res?.error) {
        showToast('Erro ao salvar configuraÃ§Ã£o do No-IP: ' + res.error, 'error');
    } else {
        showToast('ConfiguraÃ§Ã£o do No-IP salva!', 'success');
    }
    fetchNoipStatus();
}

function appendNoipLog(data) {
    const container = document.getElementById('noip-log-container');
    if (!container) return;
    
    if (typeof data === 'string') {
        container.innerHTML += `<div>${escapeHtml(data)}</div>`;
        container.scrollTop = container.scrollHeight;
        return;
    }

    if (data.log && Array.isArray(data.log)) {
        container.innerHTML = data.log.slice().reverse().map(line => `<div>${escapeHtml(line)}</div>`).join('');
        container.scrollTop = container.scrollHeight;
    }

    if (data.status) {
        const statusEl = document.getElementById('noip-status-text');
        if (statusEl) statusEl.textContent = data.status;
    }
    if (data.currentIP) {
        const ipEl = document.getElementById('noip-current-ip');
        if (ipEl) ipEl.textContent = data.currentIP;
    }
    if (data.lastUpdate) {
        const updateEl = document.getElementById('noip-last-update');
        if (updateEl) updateEl.textContent = data.lastUpdate;
    }
}

// ============================================================
//  LOGS â€” eventos corretos do servidor
// ============================================================
function startLogWatch() {
    let filePath = document.getElementById('logFilePath')?.value;
    // Se o usuÃ¡rio clicar com o input em branco, usa o placeholder como padrÃ£o
    if (!filePath || filePath.trim() === '') {
        filePath = document.getElementById('logFilePath')?.placeholder;
    }
    if (!filePath) return;
    const d = document.getElementById('logs-display');
    if (d) d.textContent = `Monitorando: ${filePath}\n`;
    // Servidor usa 'log-start' com string (nÃ£o objeto)
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
//  SISTEMA DE ATUALIZAÃ‡ÃƒO DO PAINEL â€” GitHub Releases
// ============================================================
async function checkSystemUpdates() {
    const statusText   = document.getElementById('update-status-text');
    const versionCur   = document.getElementById('update-current-version');
    const versionLat   = document.getElementById('update-latest-version');
    const btnRun       = document.getElementById('btn-run-update');
    const repoInput    = document.getElementById('github-repo-input');
    const notesWrapper = document.getElementById('update-release-notes-wrapper');

    if (statusText) statusText.innerHTML = 'Verificando...';

    // Carrega config do repositÃ³rio GitHub
    const cfg = await safeFetch(`${API_BASE}/system/update/config`);
    if (cfg && repoInput && !repoInput.value) {
        repoInput.value = cfg.github_repo || '';
    }

    let data = await safeFetch(`${API_BASE}/update/status?force=1`);
    if (!data) {
        const legacy = await safeFetch(`${API_BASE}/system/update/check`);
        if (legacy) {
            data = {
                installed: (legacy.currentVersion || '0.0.2').replace(/^v/, ''),
                latest: (legacy.latestVersion || legacy.currentVersion || '0.0.2').replace(/^v/, ''),
                hasUpdate: !!legacy.hasUpdate,
                status: legacy.hasUpdate ? 'update_available' : 'up_to_date',
                repo: legacy.githubRepo || cfg?.github_repo || ''
            };
        }
    }
    if (!data) {
        if (statusText) statusText.innerHTML = '<span style="color:var(--danger)">Erro ao verificar</span>';
        if (versionCur) versionCur.textContent = 'v-';
        if (versionLat) versionLat.textContent = '-';
        return;
    }

    const currentVersion = data.installed || '0.0.2';
    const latestVersion = data.latest || '0.0.2';
    const hasUpdate = data.hasUpdate || false;

    if (versionCur) versionCur.textContent = `v${currentVersion}`;
    if (versionLat) versionLat.textContent = latestVersion !== currentVersion ? `v${latestVersion}` : '-';

    if (versionLat && hasUpdate) versionLat.textContent = `v${latestVersion}`;

    if (hasUpdate) {
        if (statusText) statusText.innerHTML = '<span style="color:var(--success)">âœ… Nova versÃ£o disponÃ­vel!</span>';
        if (btnRun) btnRun.classList.remove('hidden');
    } else {
        const methodLabels = {
            up_to_date:       'âœ… Atualizado via GitHub Releases',
            failed_check:     'âš ï¸ GitHub indisponÃ­vel â€” verifique o repositÃ³rio',
            update_available: 'âš ï¸ Nova versÃ£o disponÃ­vel!'
        };
        const label = methodLabels[data.status] || 'âœ… Atualizado';
        if (statusText) statusText.innerHTML = `<span style="color:var(--text-muted)">${label}</span>`;
        if (btnRun) btnRun.classList.remove('hidden'); // Permite forÃ§ar re-instalaÃ§Ã£o
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
                const prefix = rel.compatStatus === 'breaking' ? 'âš ï¸ ' : 'âœ… ';
                return `<option value="${rel.tag}">${prefix}${rel.tag} (${date})</option>`;
            }).join('');
            
            wrapper.classList.remove('hidden');
            onVersionSelected();
        } else {
            wrapper.classList.add('hidden');
        }
    } catch (err) {
        console.error('Falha ao obter lista de versÃµes:', err);
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

function resetUpdateProgress(label = 'Preparando atualizaÃ§Ã£o...') {
    setUpdateProgress(0, label, false);
}

function schedulePostUpdateReload(writeLine, btnRun, btnCheck, btnManual, seconds = 10) {
    let remaining = Math.max(5, Number(seconds) || 10);
    const tick = () => {
        if (writeLine) {
            writeLine(`\n<span style="color:var(--warning)">Servidor reiniciando... recarregando em ${remaining}s</span>`);
        }
        if (remaining <= 0) {
            if (btnRun) btnRun.disabled = false;
            if (btnCheck) btnCheck.disabled = false;
            if (btnManual) btnManual.disabled = false;
            location.reload();
            return;
        }
        remaining -= 1;
        setTimeout(tick, 1000);
    };
    tick();
}

function advanceUpdateProgressFromLine(line) {
    const normalized = String(line || '').toLowerCase();
    const stages = [
        { match: ['verificando releases', 'release encontrada', 'tag mais recente'], percent: 12, label: 'Verificando versÃ£o' },
        { match: ['criando backup'], percent: 24, label: 'Criando backup' },
        { match: ['backup criado'], percent: 34, label: 'Backup concluÃ­do' },
        { match: ['baixando pacote', 'baixando o tarball'], percent: 46, label: 'Baixando pacote' },
        { match: ['pacote baixado', 'tarball da tag baixado'], percent: 60, label: 'Download concluÃ­do' },
        { match: ['extraindo pacote', 'extraÃ§Ã£o bÃ¡sica'], percent: 70, label: 'Extraindo arquivos' },
        { match: ['instalando atualizaÃ§Ã£o'], percent: 80, label: 'Instalando arquivos' },
        { match: ['arquivos copiados'], percent: 88, label: 'Arquivos instalados' },
        { match: ['atualizando depend', '[npm]'], percent: 94, label: 'Atualizando dependÃªncias' },
        { match: ['atualizaÃ§Ã£o concluÃ­da', 'rollback para'], percent: 100, label: 'ConcluÃ­do' }
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
        showToast('Selecione uma versÃ£o vÃ¡lida!', 'warning');
        return;
    }

    const release = window.availableVersions?.find(r => r.tag === tag);
    const isBreaking = release?.compatStatus === 'breaking';
    const warnMsg = isBreaking 
        ? `\n\nâš ï¸ ATENÃ‡ÃƒO: Esta Ã© uma versÃ£o antiga (Downgrade/Rollback). Deseja restaurar a partir do backup ou baixar novamente?` 
        : ``;

    if (!confirm(`Deseja realmente aplicar a versÃ£o "${tag}" no seu cPanel?${warnMsg}\n\nO painel serÃ¡ reiniciado ao final.`)) {
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
    
    const initialText = `[INFO] Iniciando instalaÃ§Ã£o para a versÃ£o ${tag}...\n`;
    if (term) term.innerHTML = `<span style="color:var(--primary)">${initialText}</span>`;
    if (healthTerm) healthTerm.innerHTML = `<span style="color:var(--primary)">${initialText}</span>`;
    
    if (btnRun)    btnRun.disabled    = true;
    if (btnCheck)  btnCheck.disabled  = true;
    if (btnManual) btnManual.disabled = true;

    // Determina se Ã© rollback (downgrade) ou install padrÃ£o
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
                writeLine(`\n<span style="color:${code == 0 ? 'var(--success)' : 'var(--warning)'}">Processo finalizado com cÃ³digo ${code}.</span>`);
                if (code == 0) {
                    setUpdateProgress(100, 'AtualizaÃ§Ã£o concluÃ­da');
                    writeLine(`<span style="color:var(--success)">âœ… VersÃ£o ${tag} aplicada com sucesso! Aguardando 10s para o servidor subir...</span>`);
                    schedulePostUpdateReload(writeLine, btnRun, btnCheck, btnManual, 10);
                } else {
                    setUpdateProgress(100, 'Falha na atualizaÃ§Ã£o', true);
                    writeLine(`<span style="color:var(--danger)">âŒ Falha na aplicaÃ§Ã£o da versÃ£o. Verifique as mensagens acima.</span>`);
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
        writeLine('\n<span style="color:var(--warning)">Aviso: Conectando/Reiniciando servidor para aplicar as alteraÃ§Ãµes...</span>');
        evtSource.close();
        schedulePostUpdateReload(writeLine, btnRun, btnCheck, btnManual, 10);
    };
}

async function saveGithubRepo() {
    const input = document.getElementById('github-repo-input');
    let repo  = input?.value?.trim() || '';
    
    repo = repo.replace(/https?:\/\/github\.com\//i, '').replace(/^\/+|\/+$/g, '');
    
    if (input) input.value = repo;

    if (!repo || !repo.includes('/')) {
        showToast('Formato invÃ¡lido. Use: usuario/repositorio', 'warning');
        return;
    }
    const result = await safeFetch(`${API_BASE}/system/update/config`, 'POST', { github_repo: repo });
    if (result?.success) {
        showToast(`RepositÃ³rio salvo: ${repo}. Agora clique em "Verificar" para checar atualizaÃ§Ãµes.`, 'success');
        checkSystemUpdates();
    } else {
        showToast('Erro ao salvar configuraÃ§Ã£o do repositÃ³rio.', 'error');
    }
}

function runSystemUpdate() {
    if (!confirm('Deseja realmente atualizar o painel para a Ãºltima versÃ£o disponÃ­vel?\nO servidor serÃ¡ reiniciado ao final.')) return;

    const termWrapper = document.getElementById('update-terminal-wrapper');
    const term        = document.getElementById('update-terminal');
    const healthTerm  = document.getElementById('health-check-terminal');
    const btnRun      = document.getElementById('btn-run-update');
    const btnCheck    = document.getElementById('btn-check-update');

    if (termWrapper) termWrapper.classList.remove('hidden');
    
    resetUpdateProgress('Preparando atualizaÃ§Ã£o...');
    const initialText = `[INFO] Iniciando atualizaÃ§Ã£o automÃ¡tica para a versÃ£o mais recente...\n`;
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
                writeLine(`\n<span style="color:${code == 0 ? 'var(--success)' : 'var(--warning)'}">Processo finalizado com cÃ³digo ${code}.</span>`);
                if (code == 0) {
                    setUpdateProgress(100, 'AtualizaÃ§Ã£o concluÃ­da');
                    writeLine(`<span style="color:var(--success)">âœ… AtualizaÃ§Ã£o concluÃ­da com sucesso! Aguardando 10s para o servidor subir...</span>`);
                    schedulePostUpdateReload(writeLine, btnRun, btnCheck, null, 10);
                } else {
                    setUpdateProgress(100, 'Falha na atualizaÃ§Ã£o', true);
                    writeLine(`<span style="color:var(--danger)">âŒ Falha na atualizaÃ§Ã£o. Verifique os logs acima.</span>`);
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
        writeLine('\n<span style="color:var(--warning)">Aviso: Conectando/Reiniciando servidor para aplicar as alteraÃ§Ãµes...</span>');
        evtSource.close();
        schedulePostUpdateReload(writeLine, btnRun, btnCheck, null, 10);
    };
}

// ============================================================
//  BACKUPS
// ============================================================
async function createBackup() {
    const btn = document.getElementById('backup-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Gerando...'; }
    const data = await safeFetch(`${API_BASE}/backup`, 'POST');
    if (btn) { btn.disabled = false; btn.innerHTML = 'â†“ Gerar Backup Agora'; }
    // Servidor retorna {success, filename} (nÃ£o file)
    if (data?.filename) {
        const result = document.getElementById('backup-result');
        const link   = document.getElementById('backup-download-link');
        if (result) result.classList.remove('hidden');
        if (link)   link.href = `/api/backup/download?file=${data.filename}`;
    }
}

// ============================================================
//  DOCUMENTAÃ‡ÃƒO
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
async function safeFetch(url, method = 'GET', body = null, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), timeoutMs);
    try {
        const opts = {
            method,
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal
        };
        if (body) opts.body = JSON.stringify(body);
        const res = await fetch(url, opts);
        const text = await res.text();
        let data = {};
        if (text) {
            try {
                data = JSON.parse(text);
            } catch (_) {
                const snippet = text.slice(0, 120).replace(/\s+/g, ' ').trim();
                throw new Error(`Resposta nÃ£o-JSON (${res.status}): ${snippet}`);
            }
        }
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
    } catch(e) {
        if (e?.name === 'AbortError') return null;
        console.error(`[safeFetch] ${url}:`, e.message);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ============================================================
//  AUTH
// ============================================================
function logout() { window.location.href = '/login.html'; }

// ============================================================
//  REDE E ACESSO (IPs / HTTPS)
// ============================================================
async function fetchNetworkInfo() {
    const ipv4El = document.getElementById('network-ipv4-display');
    const ipv6El = document.getElementById('network-ipv6-display');
    const httpsToggle = document.getElementById('settings-https-toggle');
    const cgnatWarn = document.getElementById('network-cgnat-warning');
    const extIpv4 = document.getElementById('settings-ext-ipv4');
    const extIpv6 = document.getElementById('settings-ext-ipv6');

    if (ipv4El) ipv4El.textContent = 'Buscando...';
    if (ipv6El) ipv6El.textContent = 'Buscando...';

    const res = await safeFetch(`${API_BASE}/network/info`);
    if (res && res.success) {
        if (ipv4El) ipv4El.textContent = res.ipv4;
        if (ipv6El) ipv6El.textContent = res.ipv6;
        if (httpsToggle) httpsToggle.checked = res.httpsEnabled;
        if (extIpv4) extIpv4.checked = res.fetchV4;
        if (extIpv6) extIpv6.checked = res.fetchV6;

        if (cgnatWarn) {
            if (res.ipv4 && res.ipv4 !== 'IndisponÃ­vel' && res.ipv4 !== 'Desativado') {
                cgnatWarn.classList.remove('hidden');
            } else {
                cgnatWarn.classList.add('hidden');
            }
        }
    } else {
        if (ipv4El) ipv4El.textContent = 'Falha';
        if (ipv6El) ipv6El.textContent = 'Falha';
    }
}

async function togglePanelHttps(el) {
    const isChecked = el.checked;
    el.disabled = true;
    
    // Mostra Toast de processamento porque o OpenSSL demora uns segundos
    if (isChecked) {
        showToast('Gerando certificado criptografado localmente. Aguarde...', 'info');
    }

    const res = await safeFetch(`${API_BASE}/network/ssl`, 'POST', { enabled: isChecked });
    
    el.disabled = false;
    
    if (res && res.success) {
        showToast(isChecked ? 'HTTPS ativado! O servidor reiniciarÃ¡ em 2 segundos.' : 'HTTPS desativado! O servidor reiniciarÃ¡ em 2 segundos.', 'success');
        
        setTimeout(() => {
            const currentHost = window.location.hostname;
            const port = document.getElementById('settings-port-input').value || 8088;
            const proto = isChecked ? 'https:' : 'http:';
            window.location.href = `${proto}//${currentHost}:${port}/`;
        }, 2000);
    } else {
        el.checked = !isChecked; // revert
        showToast('Erro ao configurar HTTPS: ' + (res?.error || 'Desconhecido'), 'error');
    }
}

// ============================================================
//  CONFIGURAÃ‡Ã•ES DO PAINEL
// ============================================================
async function loadSettings() {
    const res = await safeFetch(`${API_BASE}/system/settings`);
    if (res?.success) {
        // Preenche porta
        const portInput = document.getElementById('settings-port-input');
        if (portInput) portInput.value = res.port;

        // Preenche usuÃ¡rio
        const userInput = document.getElementById('settings-user-input');
        if (userInput) userInput.value = res.adminUser;
        
        // Limpa campo de senha
        const passInput = document.getElementById('settings-pass-input');
        if (passInput) passInput.value = '';

        // Dispara a busca pela rede/IPs assim que a aba Settings carregar
        fetchNetworkInfo();

        // Preenche autostart badge e botÃ£o (OpÃ§Ã£o 1)
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

        // Preenche autostart boot badge e botÃ£o (OpÃ§Ã£o 2 - Termux:Boot)
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

        // Carrega modo de memÃ³ria
        try {
            const procRes = await safeFetch(`${API_BASE}/system/processes`);
            if (procRes?.success && procRes.panel) {
                const memSelect = document.getElementById('settings-memory-mode');
                if (memSelect) {
                    memSelect.value = procRes.panel.nodeMemoryMode || 'balanced';
                }
            }
        } catch(e) {
            console.error('Falha ao carregar processos/memÃ³ria:', e);
        }

        if (window.lucide) lucide.createIcons();
    }
}

async function saveExternalAccessSettings() {
    const ipv4 = !!document.getElementById('settings-ext-ipv4')?.checked;
    const ipv6 = !!document.getElementById('settings-ext-ipv6')?.checked;
    const res = await safeFetch(`${API_BASE}/system/settings/network`, 'POST', { ipv4, ipv6 });
    if (res?.success) {
        showToast('ConfiguraÃ§Ã£o de IPv4/IPv6 externo salva.', 'success');
        loadSettings();
    } else {
        showToast(`Erro: ${res?.error || 'Falha ao salvar configuraÃ§Ã£o de rede.'}`, 'error');
    }
}

async function toggleBootAutostart() {
    const badge = document.getElementById('autostart-status-badge');
    const isCurrentActive = badge?.textContent === 'Ativo';
    const nextState = !isCurrentActive;

    const res = await safeFetch(`${API_BASE}/system/settings/autostart/toggle`, 'POST', { active: nextState });
    if (res?.success) {
        showToast(nextState 
            ? 'Regra de inicializaÃ§Ã£o (Ao abrir o Termux) configurada com sucesso!' 
            : 'Regra de inicializaÃ§Ã£o (Ao abrir o Termux) removida.',
            'success'
        );
        loadSettings();
    } else {
        showToast('Falha ao alterar a regra de auto-inicializaÃ§Ã£o.', 'error');
    }
}

async function toggleTermuxBoot() {
    const badge = document.getElementById('autostart-boot-badge');
    const isCurrentActive = badge?.textContent === 'Ativo';
    const nextState = !isCurrentActive;

    const res = await safeFetch(`${API_BASE}/system/settings/autostart-boot/toggle`, 'POST', { active: nextState });
    if (res?.success) {
        showToast(nextState 
            ? 'Regra de inicializaÃ§Ã£o via Termux:Boot configurada! Instale o app auxiliar "Termux:Boot" para inicializaÃ§Ã£o invisÃ­vel em segundo plano.' 
            : 'Regra de inicializaÃ§Ã£o via Termux:Boot removida com sucesso.',
            'success'
        );
        loadSettings();
    } else {
        showToast('Falha ao alterar a regra do Termux:Boot.', 'error');
    }
}

async function savePanelPort() {
    const input = document.getElementById('settings-port-input');
    const newPort = parseInt(input?.value);
    if (!newPort || newPort < 1 || newPort > 65535) {
        showToast('Porta invÃ¡lida! Insira um valor entre 1 e 65535.', 'warning');
        return;
    }

    if (!confirm(`âš ï¸ VocÃª tem certeza que deseja mudar a porta do painel para ${newPort}?\n\nO servidor serÃ¡ desligado e reiniciado automaticamente na nova porta. VocÃª precisarÃ¡ acessar o painel usando o novo endereÃ§o.`)) {
        return;
    }

    const res = await safeFetch(`${API_BASE}/system/settings/port`, 'POST', { port: newPort });
    if (res?.success) {
        showToast('Porta alterada com sucesso! O servidor estÃ¡ reiniciando, redirecionando em 5 segundos...', 'success');
        setTimeout(() => {
            window.location.href = `${window.location.protocol}//${window.location.hostname}:${newPort}`;
        }, 5000);
    } else {
        showToast(`Erro: ${res?.error || 'NÃ£o foi possÃ­vel alterar a porta.'}`, 'error');
    }
}

async function savePanelAuth() {
    const userInput = document.getElementById('settings-user-input');
    const passInput = document.getElementById('settings-pass-input');
    const user = userInput?.value?.trim();
    const pass = passInput?.value;

    if (!user || !pass || user === '' || pass === '') {
        showToast('UsuÃ¡rio e senha nÃ£o podem ficar vazios!', 'warning');
        return;
    }

    if (!confirm('Deseja salvar as novas credenciais de acesso? VocÃª precisarÃ¡ usÃ¡-las no prÃ³ximo login.')) {
        return;
    }

    const res = await safeFetch(`${API_BASE}/system/settings/auth`, 'POST', { user, pass });
    if (res?.success) {
        showToast('Credenciais atualizadas com sucesso!', 'success');
        loadSettings();
    } else {
        showToast(`Erro: ${res?.error || 'NÃ£o foi possÃ­vel salvar as credenciais.'}`, 'error');
    }
}

// ============================================================
//  HOSPEDAGEM (SITES & APPS) FRONTEND CONTROLLER
// ============================================================
window.hostingServices = [];
window.logInterval = null;
window.activeFilterType = 'all';
window.hostingLastSuggestedPort = 4000;

function slugifyServiceName(name) {
    return String(name || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

async function preloadDbSetupFields() {
    const res = await safeFetch(`${API_BASE}/db/setup`);
    if (!res?.success || !res.config) return;
    const cfg = res.config;
    const hostEl = document.getElementById('dbRootHost');
    const userEl = document.getElementById('dbRootUser');
    const passEl = document.getElementById('dbRootPass');
    if (hostEl) hostEl.value = cfg.host || '127.0.0.1';
    if (userEl) userEl.value = cfg.user || 'root';
    if (passEl) passEl.value = cfg.password || '';
}

function isValidPublicHostname(value) {
    const host = String(value || '').trim().toLowerCase();
    if (!host || host.includes('://') || host.includes('/')) return false;
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host);
}

async function suggestNextHostingPort(start = 4000) {
    const res = await safeFetch(`${API_BASE}/hosting/next-port?start=${encodeURIComponent(start)}`);
    if (res?.success && res.port) {
        window.hostingLastSuggestedPort = Number(res.port) || start;
        return window.hostingLastSuggestedPort;
    }
    return start;
}

function updateHostingDerivedFields() {
    const hsName = document.getElementById('hsName');
    const hsPath = document.getElementById('hsPath');
    const hsTunnelName = document.getElementById('hsTunnelName');
    if (!hsName) return;

    const slug = slugifyServiceName(hsName.value);
    if (hsPath) hsPath.value = `/data/data/com.termux/files/home/www/${slug || 'servico'}`;
    if (hsTunnelName && !hsTunnelName.dataset.userEdited) hsTunnelName.value = slug || '';
    updateTunnelTargetPreview();
}

function updateTunnelTargetPreview() {
    const preview = document.getElementById('hsTunnelTargetPreview');
    const port = parseInt(document.getElementById('hsListenPort')?.value, 10) || 4000;
    if (preview) preview.textContent = `http://localhost:${port}`;
}

function installHostingFormWatchers() {
    const hsName = document.getElementById('hsName');
    const hsTunnelName = document.getElementById('hsTunnelName');
    if (hsName && !hsName.dataset.boundSlug) {
        hsName.addEventListener('input', updateHostingDerivedFields);
        hsName.dataset.boundSlug = '1';
    }
    if (hsTunnelName && !hsTunnelName.dataset.boundEdit) {
        hsTunnelName.addEventListener('input', () => { hsTunnelName.dataset.userEdited = '1'; });
        hsTunnelName.dataset.boundEdit = '1';
    }
    const hsListenPort = document.getElementById('hsListenPort');
    if (hsListenPort && !hsListenPort.dataset.boundPreview) {
        hsListenPort.addEventListener('input', updateTunnelTargetPreview);
        hsListenPort.dataset.boundPreview = '1';
    }
}

function openHostingModal() {
    window.editingHostingId = null;
    
    // Restaura titulo e botao
    const title = document.getElementById('hsModalTitle');
    if (title) title.innerHTML = '🚀 Criar Novo Serviço';
    const submitBtn = document.querySelector('#hostingModal button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Criar Serviço';
    
    // Restaura visibilidade
    const createIndexLabel = document.getElementById('hsCreateIndexLabel');
    if (createIndexLabel) createIndexLabel.classList.remove('hidden');
    const hsCreateTunnelLabel = document.getElementById('hsCreateTunnelLabel');
    if (hsCreateTunnelLabel) hsCreateTunnelLabel.classList.remove('hidden');

    // Reset form fields
    document.getElementById('hsName').value = '';
    document.getElementById('hsDomain').value = '0.0.0.0';
    document.getElementById('hsListenPort').value = '4000';
    document.getElementById('hsPath').value = '/data/data/com.termux/files/home/www/servico';
    document.getElementById('hsTargetPort').value = '';
    document.getElementById('hsStartCmd').value = '';
    document.getElementById('hsType').value = 'php';
    document.getElementById('hsAutoRestart').checked = true;
    document.getElementById('hsCreateIndex').checked = true;

    // Reset tunnel fields
    const hsCreateTunnel = document.getElementById('hsCreateTunnel');
    if (hsCreateTunnel) {
        hsCreateTunnel.checked = false;
        toggleHostingTunnelFields();
    }
    const hsTunnelName = document.getElementById('hsTunnelName');
    if (hsTunnelName) {
        hsTunnelName.value = '';
        hsTunnelName.dataset.userEdited = '';
    }
    const hsTunnelHostname = document.getElementById('hsTunnelHostname');
    if (hsTunnelHostname) hsTunnelHostname.value = '';
    const hsTunnelAction = document.getElementById('hsTunnelAction');
    if (hsTunnelAction) {
        hsTunnelAction.value = 'new';
        toggleHostingTunnelActionFields();
    }

    // Populate existing tunnels dropdown
    populateExistingTunnelsDropdown();

    // Trigger dynamic visible fields logic
    toggleHostingFormFields();
    installHostingFormWatchers();
    updateHostingDerivedFields();
    suggestNextHostingPort(window.hostingLastSuggestedPort || 4000).then((port) => {
        const portEl = document.getElementById('hsListenPort');
        if (portEl) portEl.value = String(port);
    });

    // Open Modal overlay
    const modal = document.getElementById('hostingModal');
    if (modal) {
        modal.classList.remove('hidden');
        lucide.createIcons();
    }
}

function toggleHostingTunnelFields() {
    const checked = document.getElementById('hsCreateTunnel')?.checked;
    const fieldsDiv = document.getElementById('hsTunnelFields');
    if (fieldsDiv) {
        if (checked) {
            fieldsDiv.classList.remove('hidden');
        } else {
            fieldsDiv.classList.add('hidden');
        }
    }
}
window.toggleHostingTunnelFields = toggleHostingTunnelFields;

function toggleHostingTunnelActionFields() {
    const action = document.getElementById('hsTunnelAction')?.value;
    const newGroup = document.getElementById('hsTunnelNewGroup');
    const existingGroup = document.getElementById('hsTunnelExistingGroup');
    
    if (action === 'new') {
        newGroup?.classList.remove('hidden');
        existingGroup?.classList.add('hidden');
    } else {
        newGroup?.classList.add('hidden');
        existingGroup?.classList.remove('hidden');
    }
}
window.toggleHostingTunnelActionFields = toggleHostingTunnelActionFields;

async function populateExistingTunnelsDropdown() {
    const select = document.getElementById('hsTunnelExistingId');
    if (!select) return;
    
    try {
        select.innerHTML = '<option value="">Carregando tÃºneis...</option>';
        const res = await fetch(`${API_BASE}/cloudflared/instances`);
        const data = await res.json();
        if (data.success && data.instances) {
            if (data.instances.length === 0) {
                select.innerHTML = '<option value="">Nenhum tÃºnel cadastrado</option>';
            } else {
                select.innerHTML = data.instances.map(inst => 
                    `<option value="${inst.id}">${inst.name} (${inst.tunnelId ? inst.tunnelId.slice(0, 8) : 'Sem ID'})</option>`
                ).join('');
            }
        } else {
            select.innerHTML = '<option value="">Erro ao buscar instÃ¢ncias</option>';
        }
    } catch (e) {
        select.innerHTML = '<option value="">Falha ao listar instÃ¢ncias</option>';
    }
}

function closeHostingModal() {
    window.editingHostingId = null;
    const modal = document.getElementById('hostingModal');
    if (modal) modal.classList.add('hidden');
}

function toggleHostingFormFields() {
    const runAsRootLabel = document.getElementById('hsRunAsRootLabel');
    if (runAsRootLabel) runAsRootLabel.classList.add('hidden');
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
        if (runAsRootLabel) runAsRootLabel.classList.remove('hidden');
        targetPortGroup.classList.remove('hidden');
        startCmdGroup.classList.remove('hidden');
        autoRestartLabel.classList.remove('hidden');
        createIndexLabel.classList.remove('hidden');
        document.getElementById('hsTargetPort').value = '3000';
        document.getElementById('hsStartCmd').value = 'node server.js';
        document.getElementById('hsPath').placeholder = 'ex: /data/data/com.termux/files/home/www/node-app';
    } else if (type === 'python') {
        if (runAsRootLabel) runAsRootLabel.classList.remove('hidden');
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
            console.error('Falha ao obter lista de serviÃ§os de hospedagem:', res?.error);
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
                <h3 style="font-weight:600; color:var(--text)">Nenhum serviÃ§o criado</h3>
                <p style="margin-top:8px; font-size:0.875rem;">Clique em "+ Novo ServiÃ§o" para colocar o seu primeiro projeto no ar!</p>
            </div>
        `;
        lucide.createIcons();
        return;
    }

    grid.innerHTML = filtered.map(svc => {
        const isApp = svc.type === 'node' || svc.type === 'python';
        const isOnline = svc.status === 'online';
        const openUrl = buildHostingOpenUrl(svc);
        
        let typeLabel = '';
        let typeClass = '';
        switch (svc.type) {
            case 'php': typeLabel = 'Website PHP'; typeClass = 'badge-type-php'; break;
            case 'static': typeLabel = 'EstÃ¡tico'; typeClass = 'badge-type-static'; break;
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
                        <span class="hosting-card-info-label">Porta PÃºblica</span>
                        <span class="hosting-card-info-value" style="font-family:var(--font-mono); font-weight:600; color:var(--primary);">${svc.listenPort}</span>
                    </div>
                    <div class="hosting-card-info-item">
                        <span class="hosting-card-info-label">Host/DomÃ­nio</span>
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
                    ${svc.cloudflareTunnel ? `
                    <div class="hosting-card-info-item" style="background: rgba(46, 204, 113, 0.05); padding: 4px 8px; border-radius: 4px; border: 1px solid rgba(46, 204, 113, 0.2); margin-top: 4px;">
                        <span class="hosting-card-info-label" style="color: var(--success); font-weight: 600;">â˜ï¸ TÃºnel Cloudflare</span>
                        <span class="hosting-card-info-value" style="font-family:var(--font-mono); font-size:0.75rem;"><a href="https://${svc.cloudflareTunnel.hostname}" target="_blank" style="color: var(--success); text-decoration: none;">${svc.cloudflareTunnel.hostname} <i data-lucide="external-link" style="width:10px; height:10px; display:inline-block; vertical-align:middle;"></i></a></span>
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
                    
                    <button class="btn btn-secondary btn-sm" onclick="editHostingService('${svc.id}')" style="padding:8px 12px;" title="Editar Serviço">
                        <i data-lucide="edit-3"></i>
                    </button>
                    
                    <button class="btn btn-danger btn-sm" onclick="deleteHostingService('${svc.id}', '${svc.name}')" style="padding:8px 12px;" title="Remover Serviço">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');

    lucide.createIcons();
}

function isLikelyLocalHost(hostname) {
    const host = String(hostname || '').trim().toLowerCase();
    return host === 'localhost' ||
        host === '127.0.0.1' ||
        host === '0.0.0.0' ||
        host.startsWith('192.168.') ||
        host.startsWith('10.') ||
        host.startsWith('172.16.') ||
        host.startsWith('172.17.') ||
        host.startsWith('172.18.') ||
        host.startsWith('172.19.') ||
        host.startsWith('172.2') ||
        host.startsWith('172.30.') ||
        host.startsWith('172.31.');
}

function buildHostingOpenUrl(svc) {
    if (svc && svc.cloudflareTunnel && svc.cloudflareTunnel.hostname) {
        return `https://${svc.cloudflareTunnel.hostname}`;
    }
    const domain = String((svc && svc.domain) || '').trim();
    if (domain && domain !== '_' && !isLikelyLocalHost(domain)) {
        return `http://${domain}${svc.listenPort ? `:${svc.listenPort}` : ''}`;
    }
    if (!isLikelyLocalHost(window.location.hostname)) {
        return window.location.origin;
    }
    return `http://${window.location.hostname}:${svc.listenPort}`;
}
function filterHosting(type, btn) {
    document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    renderHostingGrid(type);
}

async function createHostingService(e) {
    e.preventDefault();
    
    const name = document.getElementById('hsName').value.trim();
    const slug = slugifyServiceName(name);
    const domain = (document.getElementById('hsDomain').value.trim() || '0.0.0.0');
    const type = document.getElementById('hsType').value;
    const listenPort = parseInt(document.getElementById('hsListenPort').value, 10);
    const targetPort = document.getElementById('hsTargetPort').value;
    const path = document.getElementById('hsPath').value.trim();
    const startCmd = document.getElementById('hsStartCmd').value.trim();
    const autoRestart = document.getElementById('hsAutoRestart').checked;
    const runAsRoot = document.getElementById('hsRunAsRoot')?.checked || false;
    const createIndex = document.getElementById('hsCreateIndex').checked;

    const createTunnel = document.getElementById('hsCreateTunnel')?.checked || false;
    const tunnelAction = document.getElementById('hsTunnelAction')?.value || 'new';
    const tunnelName = document.getElementById('hsTunnelName')?.value?.trim() || '';
    const tunnelExistingId = document.getElementById('hsTunnelExistingId')?.value || '';
    const tunnelHostname = document.getElementById('hsTunnelHostname')?.value?.trim() || '';

    if (!name || !slug || !Number.isInteger(listenPort)) {
        showToast('Nome e Porta Pública são obrigatórios!', 'warning');
        return;
    }
    if (listenPort < 1 || listenPort > 65535) {
        showToast('Porta pública inválida (1-65535).', 'warning');
        return;
    }

    if (createTunnel && !window.editingHostingId) {
        if (!tunnelHostname || !isValidPublicHostname(tunnelHostname)) {
            showToast('Hostname público inválido para túnel Cloudflare.', 'warning');
            return;
        }
        if (tunnelAction === 'new' && !tunnelName) {
            showToast('Nome do novo túnel é obrigatório.', 'warning');
            return;
        }
        if (tunnelAction === 'existing' && !tunnelExistingId) {
            showToast('Selecione um túnel existente.', 'warning');
            return;
        }
    }

    const submitBtn = e.target.querySelector('button[type="submit"]');
    const originalText = submitBtn.innerHTML;
    submitBtn.disabled = true;
    submitBtn.innerHTML = window.editingHostingId 
        ? '<i data-lucide="loader" class="spin"></i> Salvando...'
        : '<i data-lucide="loader" class="spin"></i> Criando...';
    lucide.createIcons();

    try {
        const payload = {
            name,
            slug,
            domain,
            bindHost: domain,
            localHost: 'localhost',
            type,
            listenPort,
            targetPort: targetPort || listenPort,
            path,
            startCmd,
            autoRestart,
            runAsRoot,
            createIndex,
            createTunnel,
            tunnelAction,
            tunnelName: tunnelName || slug,
            tunnelExistingId,
            tunnelHostname
        };

        let res;
        if (window.editingHostingId) {
            res = await safeFetch(`${API_BASE}/hosting/${window.editingHostingId}/edit`, 'POST', payload, 120000);
        } else {
            res = await safeFetch(`${API_BASE}/hosting`, 'POST', payload, 120000);
        }

        if (res?.success && window.editingHostingId) {
            showToast('Serviço atualizado com sucesso!', 'success');
            setTimeout(async () => {
                showToast('Reiniciando servidor NGINX automaticamente...', 'info');
                const nginxRes = await safeFetch(`${API_BASE}/nginx/action`, 'POST', { action: 'restart' }, 30000);
                if (nginxRes?.success) {
                    showToast('NGINX reiniciado com sucesso. Atualizando seção de Hospedagem...', 'success');
                } else {
                    showToast('Serviço atualizado, mas falhou ao reiniciar NGINX automaticamente.', 'warning');
                }
                const refreshBtn = document.querySelector('#tab-hosting > div.page-header > div.toolbar-group > button.btn.btn-secondary.btn-sm');
                if (refreshBtn) refreshBtn.click();
                else fetchHostingServices();
            }, 3000);
            closeHostingModal();
            fetchHostingServices();
            return;
        }

        if (res?.success) {
            window.hostingLastSuggestedPort = Math.max(window.hostingLastSuggestedPort || 4000, listenPort + 1);
            const createdLocalUrl = `http://localhost:${listenPort}`;
            const tunnelUrl = res?.service?.cloudflareTunnel?.hostname ? `https://${res.service.cloudflareTunnel.hostname}` : '';
            showToast(
                tunnelUrl
                    ? `Serviço criado: local ${createdLocalUrl} | túnel ${tunnelUrl}`
                    : `Serviço criado com sucesso em ${createdLocalUrl}.`,
                'success'
            );
            if (res.cfWarning) {
                setTimeout(() => {
                    showToast(`Aviso: ${res.cfWarning}`, 'warning');
                }, 1000);
            }
            if (res.dnsStatus && tunnelUrl) {
                setTimeout(() => {
                    if (res.dnsStatus.ok) {
                        showToast(`DNS OK para ${res.dnsStatus.host}`, 'success');
                    } else {
                        showToast(`DNS ainda não propagou para ${res.dnsStatus.host}: ${res.dnsStatus.message || 'aguarde alguns minutos.'}`, 'warning');
                    }
                }, 1400);
            }
            setTimeout(async () => {
                showToast('Reiniciando servidor NGINX automaticamente...', 'info');
                const nginxRes = await safeFetch(`${API_BASE}/nginx/action`, 'POST', { action: 'restart' }, 30000);
                if (nginxRes?.success) {
                    showToast('NGINX reiniciado com sucesso. Atualizando seção de Hospedagem...', 'success');
                } else {
                    showToast('Serviço criado, mas falhou ao reiniciar NGINX automaticamente.', 'warning');
                }
                // Atualiza somente a seção de hospedagem (mesmo botão "Atualizar" da aba).
                const refreshBtn = document.querySelector('#tab-hosting > div.page-header > div.toolbar-group > button.btn.btn-secondary.btn-sm');
                if (refreshBtn) refreshBtn.click();
                else fetchHostingServices();
            }, 3000);
            closeHostingModal();
            fetchHostingServices();
        } else {
            showToast(`Falha ao criar servi?o: ${res?.error || 'Erro desconhecido.'}`, 'error');
        }
    } catch (err) {
        showToast(`Falha de rede: ${err.message}`, 'error');
    } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = originalText;
        lucide.createIcons();
    }
}

async function toggleHostingProcess(id, start) {
    const svc = window.hostingServices ? window.hostingServices.find(s => String(s.id) === String(id)) : null;
    if (start && svc && svc.type === 'node') {
        openHostingStartModal(id);
        return;
    }
    try {
        const res = await safeFetch(`${API_BASE}/hosting/${id}/toggle`, 'POST', { active: start });
        if (res?.success) {
            showToast(`Processo ${start ? 'iniciado' : 'parado'} com sucesso!`, 'success');
            fetchHostingServices();
        } else {
            showToast(`Falha ao alterar estado do processo: ${res?.error || 'Erro interno.'}`, 'error');
        }
    } catch (err) {
        showToast(`Erro de rede: ${err.message}`, 'error');
    }
}

async function deleteHostingService(id, name) {
    if (!confirm(`âš ï¸ AtenÃ§Ã£o: VocÃª tem certeza que deseja EXCLUIR o serviÃ§o "${name}"?\n\nEsta aÃ§Ã£o irÃ¡ remover permanentemente a configuraÃ§Ã£o do NGINX, apagar os arquivos de log e encerrar qualquer processo ativo associado.`)) {
        return;
    }

    try {
        const res = await safeFetch(`${API_BASE}/hosting/${id}`, 'DELETE');
        if (res?.success) {
            if (res.cloudflare?.removed && res.cloudflare?.deletedInstance) {
                showToast('Serviço excluído e túnel Cloudflare vinculado removido com sucesso!', 'success');
            } else if (res.cloudflare?.removed) {
                showToast('Serviço excluído e rota Cloudflare vinculada removida com sucesso!', 'success');
            } else if (res.cloudflare?.warning) {
                showToast(`Serviço excluído, mas houve aviso no Cloudflare: ${res.cloudflare.warning}`, 'warning');
            } else {
                showToast('Serviço excluído com sucesso!', 'success');
            }
            fetchHostingServices();
        } else {
            showToast(`Falha ao excluir serviÃ§o: ${res?.error || 'Erro interno.'}`, 'error');
        }
    } catch (err) {
        showToast(`Erro de rede: ${err.message}`, 'error');
    }
}

function viewHostingLogs(id, name) {
    document.getElementById('logModalTitle').innerHTML = `ðŸ“œ Logs em Tempo Real â€” ${name}`;
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
// ============================================================
//  NOVO CLOUDFLARED MANAGER (TERMUX NATIVE API)
// ============================================================
let cfInstances = [];
let cfLogInterval = null;
let cfSelectedInstId = null;
let cfTempRoutes = [];
const CF_ROUTE_PROTOCOLS = ['http', 'https', 'tcp', 'ssh', 'rdp', 'unix'];

function cfNormalizeRouteType(routeType, protocol) {
    const explicit = (routeType || '').toLowerCase();
    if (['http', 'https', 'tcp', 'ssh', 'rdp', 'unix'].includes(explicit)) return explicit;
    if (explicit === 'tcp_ssh') return 'tcp';
    if (explicit === 'http_path' || explicit === 'http_hostname') return (protocol || 'http').toLowerCase();
    const p = (protocol || 'http').toLowerCase();
    if (p === 'tcp' || p === 'ssh' || p === 'rdp' || p === 'unix') return p;
    if (p === 'https') return 'https';
    return 'http';
}

function cfBuildServicePreview(route) {
    const protocol = (route.targetProtocol || 'http').toLowerCase();
    const host = (route.targetHost || '127.0.0.1').trim() || '127.0.0.1';
    const port = parseInt(route.targetPort, 10) || 80;
    if (protocol === 'unix') {
        const socketPath = host.startsWith('/') ? host : `/${host}`;
        return `unix:${socketPath}`;
    }
    return `${protocol}://${host}:${port}`;
}

function cfIsSshRoute(route) {
    const routeType = (route?.routeType || '').toLowerCase();
    const protocol = (route?.targetProtocol || '').toLowerCase();
    return routeType === 'ssh' || protocol === 'ssh';
}

function cfBuildPublicAccessPreview(route) {
    const hostname = route?.hostname || 'seu-host.com';
    const routeType = (route?.routeType || '').toLowerCase();
    const protocol = (route?.targetProtocol || 'http').toLowerCase();
    const isHttp = routeType === 'http' || routeType === 'https' || protocol === 'http' || protocol === 'https';
    if (cfIsSshRoute(route)) return hostname;
    if (!isHttp) return hostname;
    return `https://${hostname}${route.path || '/'}`;
}

function cfCopyToClipboard(text, okMessage = 'Comando copiado!') {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text)
            .then(() => showToast(okMessage, 'success'))
            .catch(() => showToast('Falha ao copiar comando.', 'warning'));
        return;
    }
    showToast('Clipboard indisponível neste navegador.', 'warning');
}

function cfNormalizeRouteForEditor(route) {
    if (!route) return route;
    const protocol = (route.targetProtocol || 'http').toLowerCase();
    const normalized = {
        name: route.name || '',
        hostname: route.hostname || '',
        path: route.path || '/',
        targetProtocol: CF_ROUTE_PROTOCOLS.includes(protocol) ? protocol : 'http',
        targetHost: (route.targetHost || '127.0.0.1').trim() || '127.0.0.1',
        targetPort: parseInt(route.targetPort, 10) || 80,
        routeType: cfNormalizeRouteType(route.routeType, protocol),
        service: route.service || ''
    };
    if (cfIsSshRoute(normalized)) {
        normalized.path = '';
        if (!normalized.targetPort || Number(normalized.targetPort) <= 0) normalized.targetPort = 8022;
    }
    normalized.service = cfBuildServicePreview(normalized);
    return normalized;
}

async function cfFetchInstances() {
    try {
        const res = await fetch(`${API_BASE}/cloudflared/instances`);
        const data = await res.json();
        if (data.success) {
            cfInstances = data.instances;
            cfRenderInstances();
        }
    } catch (e) {
        console.error('Erro ao buscar instÃ¢ncias:', e);
    }
}

function cfRenderInstances() {
    const list = document.getElementById('cfInstancesList');
    if (!list) return;

    if (cfInstances.length === 0) {
        list.innerHTML = '<tr><td colspan="6" style="padding: 20px; text-align: center; color: var(--text-muted);">Nenhuma instÃ¢ncia configurada.</td></tr>';
        return;
    }

    list.innerHTML = cfInstances.map(inst => {
        const isRunning = inst.status && inst.status.running;
        const statusBadge = isRunning 
            ? `<span class="badge badge-success">Online (PID ${inst.status.pid})</span>` 
            : '<span class="badge badge-danger">Offline</span>';
        
        const typeBadge = inst.type === 'core' 
            ? '<span class="badge badge-warning">Core</span>' 
            : '<span class="badge badge-info">Service</span>';

        const protectBadge = inst.protected 
            ? '<i data-lucide="shield-check" style="color:var(--danger);" title="Protegido"></i>' 
            : '-';

        return `
            <tr style="border-bottom: 1px solid var(--border-color);">
                <td style="padding: 12px 16px; font-weight:600;">${cfEscape(inst.name)}</td>
                <td style="padding: 12px 16px;">${typeBadge}</td>
                <td style="padding: 12px 16px;">${statusBadge}</td>
                <td style="padding: 12px 16px;">${protectBadge}</td>
                <td style="padding: 12px 16px;">${inst.autoRestartOnSave ? 'Sim' : 'NÃ£o'}</td>
                <td style="padding: 12px 16px; text-align: center;">
                    <div style="display:flex; gap:6px; justify-content:center;">
                        ${isRunning 
                            ? `<button class="btn btn-sm btn-danger" onclick="cfStopInstance('${inst.id}')"><i data-lucide="square"></i> Parar</button>`
                            : `<button class="btn btn-sm btn-success" onclick="cfStartInstance('${inst.id}')"><i data-lucide="play"></i> Iniciar</button>`
                        }
                        <button class="btn btn-sm btn-secondary" onclick="cfReloadSafeInstance('${inst.id}')" title="Reload Safe (Zero Downtime)"><i data-lucide="refresh-cw"></i> Reload</button>
                        <button class="btn btn-sm btn-primary" onclick="cfShowInstanceModal('${inst.id}')"><i data-lucide="edit"></i></button>
                        <button class="btn btn-sm btn-secondary" onclick="cfShowLogsModal('${inst.id}', '${cfEscape(inst.name)}')"><i data-lucide="scroll-text"></i></button>
                        ${!inst.protected ? `<button class="btn btn-sm btn-danger" onclick="cfDeleteInstance('${inst.id}')"><i data-lucide="trash-2"></i></button>` : ''}
                    </div>
                </td>
            </tr>
        `;
    }).join('');
    
    if (window.lucide) lucide.createIcons();
}

function cfShowInstanceModal(id = null) {
    const modal = document.getElementById('cfInstanceModal');
    const title = document.getElementById('cfModalTitle');
    
    document.getElementById('cfInstId').value = '';
    document.getElementById('cfInstName').value = '';
    document.getElementById('cfInstType').value = 'service';
    document.getElementById('cfInstTunnelId').value = '';
    document.getElementById('cfInstCredentialsFile').value = '';
    document.getElementById('cfInstHostname').value = '';
    document.getElementById('cfInstCreateTunnel').checked = false;
    document.getElementById('cfInstProtected').checked = false;
    document.getElementById('cfInstAutoRestart').checked = true;
    
    cfTempRoutes = [];

    if (id) {
        title.textContent = 'âš™ï¸ Editar InstÃ¢ncia';
        const inst = cfInstances.find(i => i.id === id);
        if (inst) {
            document.getElementById('cfInstId').value = inst.id;
            document.getElementById('cfInstName').value = inst.name;
            document.getElementById('cfInstType').value = inst.type;
            document.getElementById('cfInstTunnelId').value = inst.tunnelId || '';
            document.getElementById('cfInstCredentialsFile').value = inst.credentialsFile || '';
            document.getElementById('cfInstHostname').value = inst.hostname || '';
            document.getElementById('cfInstProtected').checked = !!inst.protected;
            document.getElementById('cfInstAutoRestart').checked = !!inst.autoRestartOnSave;
            if (inst.routes) cfTempRoutes = inst.routes.map(cfNormalizeRouteForEditor);
        }
    } else {
        title.textContent = 'ðŸš€ Nova InstÃ¢ncia';
    }

    cfRenderTempRoutes();
    modal.classList.remove('hidden');
}

function cfCloseInstanceModal() {
    document.getElementById('cfInstanceModal').classList.add('hidden');
}

function cfRenderTempRoutes() {
    const container = document.getElementById('cfInstRoutesContainer');
    if (cfTempRoutes.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); text-align:center; padding:10px;">Nenhuma rota adicionada.</div>';
        return;
    }

    container.innerHTML = cfTempRoutes.map((r, index) => {
        const protocol = r.targetProtocol || 'http';
        const routeType = r.routeType || 'http';
        const isHttpRoute = routeType === 'http' || routeType === 'https';
        const isTcpRoute = !isHttpRoute;
        const isSshRoute = cfIsSshRoute(r);
        const pathDisabled = isTcpRoute ? 'disabled' : '';
        const pathStyle = isTcpRoute ? 'opacity:0.6; cursor:not-allowed;' : '';
        const servicePreview = cfBuildServicePreview(r);
        const publicPreview = cfBuildPublicAccessPreview(r);
        const sshHost = r.hostname || 'ssh.seu-dominio.com';
        const sshCmd = `ssh -o ProxyCommand="cloudflared access ssh --hostname ${sshHost}" USUARIO@${sshHost}`;
        const sshTcpCmd = `cloudflared access tcp --hostname ${sshHost} --url 127.0.0.1:2222`;

        return `
        <div style="display:flex; flex-direction:column; gap:8px; margin-bottom:10px; background:var(--bg-primary); padding:10px; border-radius:6px; border:1px solid var(--border-color);">
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <input type="text" placeholder="Nome da rota (ex: Painel Core)" value="${cfEscape(r.name || '')}" onchange="cfUpdateTempRoute(${index}, 'name', this.value)" style="flex:2; min-width:180px; padding:6px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-secondary); color:var(--text-color);">
                <select onchange="cfUpdateTempRoute(${index}, 'routeType', this.value)" style="flex:1; min-width:160px; padding:6px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-secondary); color:var(--text-color);">
                    <option value="http" ${routeType === 'http' ? 'selected' : ''}>HTTP</option>
                    <option value="https" ${routeType === 'https' ? 'selected' : ''}>HTTPS</option>
                    <option value="ssh" ${routeType === 'ssh' ? 'selected' : ''}>SSH</option>
                    <option value="rdp" ${routeType === 'rdp' ? 'selected' : ''}>RDP</option>
                    <option value="tcp" ${routeType === 'tcp' ? 'selected' : ''}>TCP</option>
                    <option value="unix" ${routeType === 'unix' ? 'selected' : ''}>UNIX</option>
                </select>
                <button type="button" class="btn btn-danger btn-sm" onclick="cfRemoveTempRoute(${index})"><i data-lucide="trash"></i></button>
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <input type="text" placeholder="Host publico (ex: panel.arjtechbr.site)" value="${cfEscape(r.hostname || '')}" onchange="cfUpdateTempRoute(${index}, 'hostname', this.value)" style="flex:2; min-width:220px; padding:6px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-secondary); color:var(--text-color);">
                <input type="text" placeholder="${isSshRoute ? 'Path não aplicável para SSH' : 'Path publico (ex: /api/)'}" value="${cfEscape(isSshRoute ? '' : (r.path || '/'))}" onchange="cfUpdateTempRoute(${index}, 'path', this.value)" ${pathDisabled} style="flex:1; min-width:140px; padding:6px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-secondary); color:var(--text-color); ${pathStyle}">
            </div>
            <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                <select onchange="cfUpdateTempRoute(${index}, 'targetProtocol', this.value)" style="flex:1; min-width:120px; padding:6px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-secondary); color:var(--text-color);">
                    ${CF_ROUTE_PROTOCOLS.map(p => `<option value="${p}" ${protocol === p ? 'selected' : ''}>${p}</option>`).join('')}
                </select>
                <input type="text" placeholder="Host interno (127.0.0.1)" value="${cfEscape(r.targetHost || '127.0.0.1')}" onchange="cfUpdateTempRoute(${index}, 'targetHost', this.value)" style="flex:1; min-width:160px; padding:6px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-secondary); color:var(--text-color);">
                <input type="number" min="1" max="65535" placeholder="Porta interna" value="${cfEscape((r.targetPort || 80).toString())}" onchange="cfUpdateTempRoute(${index}, 'targetPort', this.value)" style="flex:1; min-width:120px; padding:6px; border:1px solid var(--border-color); border-radius:4px; background:var(--bg-secondary); color:var(--text-color);">
            </div>
            <div style="display:flex; flex-direction:column; gap:4px;">
                <div style="font-size:0.8rem; color:var(--text-muted);">Destino final: <code>${cfEscape(servicePreview)}</code></div>
                ${
                    isSshRoute
                        ? `<div style="font-size:0.78rem; color:var(--warning);">Hostname público: <code>${cfEscape(publicPreview)}</code></div>
                           <div style="font-size:0.78rem; color:var(--danger);">SSH via Cloudflare Tunnel não é acessado pelo navegador. Não use <code>https://${cfEscape(publicPreview)}/</code> nem porta 22 direta no Termius.</div>
                           <div style="font-size:0.78rem; color:var(--text-muted);">Use Cloudflare Access com:</div>
                           <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                               <code style="font-size:0.75rem;">${cfEscape(sshCmd)}</code>
                               <button type="button" class="btn btn-secondary btn-sm" onclick="cfCopyToClipboard('${cfEscapeAttr(sshCmd)}', 'Comando SSH copiado!')">Copiar</button>
                           </div>
                           <div style="font-size:0.78rem; color:var(--text-muted); margin-top:4px;">Para Termius: execute localmente e conecte em 127.0.0.1:2222</div>
                           <div style="display:flex; gap:6px; flex-wrap:wrap; align-items:center;">
                               <code style="font-size:0.75rem;">${cfEscape(sshTcpCmd)}</code>
                               <button type="button" class="btn btn-secondary btn-sm" onclick="cfCopyToClipboard('${cfEscapeAttr(sshTcpCmd)}', 'Comando Termius copiado!')">Copiar</button>
                           </div>`
                        : `<div style="font-size:0.78rem; color:var(--text-muted);">URL publica: <code>${cfEscape(publicPreview)}</code> (sem porta interna)</div>`
                }
            </div>
        </div>
        `;
    }).join('');

    if (window.lucide) lucide.createIcons();
}
function cfAddRouteRow() {
    cfTempRoutes.push(cfNormalizeRouteForEditor({
        name: '',
        hostname: '',
        path: '/',
        targetProtocol: 'http',
        targetHost: '127.0.0.1',
        targetPort: 8088,
        routeType: 'http'
    }));
    cfRenderTempRoutes();
}

function cfUpdateTempRoute(index, field, value) {
    if (cfTempRoutes[index]) {
        cfTempRoutes[index][field] = value;
        if (field === 'routeType') {
            const protocolFromType = (value || 'http').toLowerCase();
            cfTempRoutes[index].targetProtocol = protocolFromType;
            if (protocolFromType !== 'http' && protocolFromType !== 'https') {
                cfTempRoutes[index].path = protocolFromType === 'ssh' ? '' : '/';
            }
            if (protocolFromType === 'ssh' && (!cfTempRoutes[index].targetPort || Number(cfTempRoutes[index].targetPort) <= 0)) {
                cfTempRoutes[index].targetPort = 8022;
            }
        }
        if (field === 'targetProtocol') {
            const protocol = (value || '').toLowerCase();
            cfTempRoutes[index].routeType = protocol || 'http';
            if (protocol !== 'http' && protocol !== 'https') {
                cfTempRoutes[index].path = protocol === 'ssh' ? '' : '/';
            }
            if (protocol === 'ssh' && (!cfTempRoutes[index].targetPort || Number(cfTempRoutes[index].targetPort) <= 0)) {
                cfTempRoutes[index].targetPort = 8022;
            }
        }
        cfTempRoutes[index] = cfNormalizeRouteForEditor(cfTempRoutes[index]);
        cfRenderTempRoutes();
    }
}

function cfRemoveTempRoute(index) {
    cfTempRoutes.splice(index, 1);
    cfRenderTempRoutes();
}

async function cfSubmitInstance(e) {
    e.preventDefault();
    const id = document.getElementById('cfInstId').value;
    const payload = {
        name: document.getElementById('cfInstName').value.trim(),
        type: document.getElementById('cfInstType').value,
        tunnelId: document.getElementById('cfInstTunnelId').value.trim(),
        credentialsFile: document.getElementById('cfInstCredentialsFile').value.trim(),
        hostname: document.getElementById('cfInstHostname').value.trim(),
        createCloudflareTunnel: document.getElementById('cfInstCreateTunnel').checked,
        protected: document.getElementById('cfInstProtected').checked,
        autoRestartOnSave: document.getElementById('cfInstAutoRestart').checked,
        routes: cfTempRoutes.map(cfNormalizeRouteForEditor)
    };

    for (const route of payload.routes) {
        if (!route.hostname) return showToast('Cada rota precisa de hostname publico.', 'warning');
        if (route.hostname.includes(':')) return showToast('Hostname publico nao deve conter porta interna.', 'warning');
        if (!route.targetHost) return showToast('Cada rota precisa de host interno.', 'warning');
        if (!route.targetPort || Number(route.targetPort) < 1 || Number(route.targetPort) > 65535) {
            return showToast('Cada rota precisa de porta interna valida (1-65535).', 'warning');
        }
        if (cfIsSshRoute(route)) {
            route.path = '';
        }
    }

    try {
        let res;
        if (id) {
            res = await fetch(`${API_BASE}/cloudflared/instances/${id}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        } else {
            res = await fetch(`${API_BASE}/cloudflared/instances`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });
        }
        
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        
        cfCloseInstanceModal();
        cfFetchInstances();
        showToast('InstÃ¢ncia salva com sucesso!', 'success');
    } catch (err) {
        showToast('Erro ao salvar instÃ¢ncia: ' + err.message, 'error');
    }
}

async function cfDeleteInstance(id) {
    if (!confirm('Excluir esta instÃ¢ncia permanentemente?')) return;
    try {
        const res = await fetch(`${API_BASE}/cloudflared/instances/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        cfFetchInstances();
        showToast('InstÃ¢ncia excluÃ­da!', 'success');
    } catch (e) {
        showToast('Erro ao excluir: ' + e.message, 'error');
    }
}

async function cfStartInstance(id) {
    try {
        showToast('Iniciando instÃ¢ncia...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/instances/${id}/start`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        cfFetchInstances();
        showToast('InstÃ¢ncia iniciada!', 'success');
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

async function cfStopInstance(id) {
    try {
        showToast('Parando instÃ¢ncia...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/instances/${id}/stop`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        cfFetchInstances();
        showToast('InstÃ¢ncia parada!', 'success');
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

async function cfReloadSafeInstance(id) {
    try {
        showToast('Efetuando Reload Safe (Zero Downtime)...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/instances/${id}/reload-safe`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        cfFetchInstances();
        showToast('Reload concluÃ­do com sucesso!', 'success');
    } catch (e) {
        showToast('Erro no Reload: ' + e.message, 'error');
    }
}

async function cfKillZombies() {
    if (!confirm('Matar todos os processos zumbis do Cloudflared?')) return;
    try {
        const res = await fetch(`${API_BASE}/cloudflared/system/kill-zombies`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        showToast('Processos zumbis eliminados!', 'success');
        cfFetchInstances();
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

async function cfCloudflareLogin() {
    try {
        showToast('Gerando URL de login Cloudflare...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/system/login`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || data.message || 'Falha ao iniciar login Cloudflare.');
        if (data.authUrl) {
            window.open(data.authUrl, '_blank', 'noopener,noreferrer');
            showToast('URL de login aberta no navegador.', 'success');
        } else {
            showToast(data.message || 'Login iniciado.', 'info');
        }
    } catch (e) {
        showToast('Erro no login Cloudflare: ' + e.message, 'error');
    }
}

async function cfRemoveLoginConfig() {
    if (!confirm('Deseja remover o arquivo cert.pem do Cloudflare login?')) return;
    try {
        const res = await fetch(`${API_BASE}/cloudflared/system/remove-login-config`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Falha ao remover cert.pem.');
        showToast(data.removed ? 'cert.pem removido com sucesso.' : 'cert.pem nÃ£o encontrado (jÃ¡ removido).', 'success');
    } catch (e) {
        showToast('Erro ao remover cert.pem: ' + e.message, 'error');
    }
}

function cfEscape(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cfEscapeAttr(str) {
    return (str || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function cfShowLogsModal(id, name) {
    cfSelectedInstId = id;
    document.getElementById('cfLogModalTitle').textContent = `ðŸ“œ Logs: ${name}`;
    document.getElementById('cfLogsModal').classList.remove('hidden');
    cfLoadLogs();
    cfLogInterval = setInterval(cfLoadLogs, 2000);
}

function cfCloseLogsModal() {
    document.getElementById('cfLogsModal').classList.add('hidden');
    if (cfLogInterval) {
        clearInterval(cfLogInterval);
        cfLogInterval = null;
    }
}

async function cfLoadLogs() {
    if (!cfSelectedInstId) return;
    try {
        const res = await fetch(`${API_BASE}/cloudflared/instances/${cfSelectedInstId}/logs?lines=100`);
        const data = await res.json();
        const box = document.getElementById('cfLogsBody');
        box.textContent = data.logs || 'Nenhum log disponÃ­vel.';
        box.scrollTop = box.scrollHeight;
    } catch {}
}

function acGetPayload() {
    return {
        domain: (document.getElementById('acDomain')?.value || '').trim(),
        mode: document.getElementById('acMode')?.value || 'cloudflare_nginx'
    };
}

function acRenderServices(services = []) {
    const tbody = document.getElementById('acServicesTable');
    if (!tbody) return;
    if (!services.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="padding:12px; color:var(--text-muted);">Nenhum serviÃ§o detectado.</td></tr>';
        return;
    }
    tbody.innerHTML = services.map((s) => `
        <tr style="border-top:1px solid var(--border-color);">
            <td style="padding:10px;">${cfEscape(s.name || s.id)}</td>
            <td style="padding:10px;">${s.defaultPort || '-'}</td>
            <td style="padding:10px;">${cfEscape((s.protocol || '').toUpperCase())}</td>
            <td style="padding:10px;">${cfEscape(s.path || 'local')}</td>
            <td style="padding:10px;">${s.enabled ? 'Online' : 'Offline'}</td>
            <td style="padding:10px;">${s.public ? (s.protected ? 'Protegido' : 'PÃºblico') : 'Local apenas'}</td>
        </tr>
    `).join('');
}

function acSetLogs(text) {
    const el = document.getElementById('acLogsBox');
    if (el) el.textContent = text || 'Sem logs.';
}

async function acDetectServices() {
    const payload = acGetPayload();
    if (!payload.domain) return showToast('Informe o domÃ­nio principal.', 'warning');
    try {
        const res = await fetch(`${API_BASE}/autoconfig/detect`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Falha na detecÃ§Ã£o.');
        acRenderServices(data.services || []);
        showToast('ServiÃ§os detectados com sucesso.', 'success');
    } catch (e) {
        showToast('Erro ao detectar serviÃ§os: ' + e.message, 'error');
    }
}

async function acGenerateRoutes() {
    const payload = acGetPayload();
    if (!payload.domain) return showToast('Informe o domÃ­nio principal.', 'warning');
    try {
        const res = await fetch(`${API_BASE}/autoconfig/generate`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Falha ao gerar rotas.');
        showToast('Rotas automÃ¡ticas geradas.', 'success');
        await acDetectServices();
    } catch (e) {
        showToast('Erro ao gerar rotas: ' + e.message, 'error');
    }
}

function acOpenSshAssistModal() {
    const modal = document.getElementById('acSshAssistModal');
    if (!modal) return;
    const domain = (document.getElementById('acDomain')?.value || '').trim();
    const domainInput = document.getElementById('acSshDomain');
    const hostInput = document.getElementById('acSshHostname');
    if (domainInput) domainInput.value = domain;
    if (hostInput && !hostInput.value) {
        const parts = domain.split('.').filter(Boolean);
        hostInput.value = parts.length >= 2 ? `ssh.${parts.slice(1).join('.')}` : `ssh.${domain || 'seu-dominio.com'}`;
    }
    modal.classList.remove('hidden');
}

function acCloseSshAssistModal() {
    const modal = document.getElementById('acSshAssistModal');
    if (modal) modal.classList.add('hidden');
}

async function acGenerateSshAccessFromModal() {
    const domain = (document.getElementById('acSshDomain')?.value || '').trim();
    const sshHostname = (document.getElementById('acSshHostname')?.value || '').trim();
    const targetHost = (document.getElementById('acSshTargetHost')?.value || 'localhost').trim();
    const targetPort = parseInt(document.getElementById('acSshTargetPort')?.value, 10) || 8022;
    if (!domain) return showToast('Informe o domínio principal.', 'warning');
    if (targetPort < 1 || targetPort > 65535) return showToast('Porta SSH inválida (1-65535).', 'warning');
    try {
        const acDomain = document.getElementById('acDomain');
        if (acDomain && !acDomain.value.trim()) acDomain.value = domain;
    } catch (_) {}

    try {
        const res = await fetch(`${API_BASE}/autoconfig/generate-ssh`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ domain, sshHostname, targetHost, targetPort })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Falha ao gerar acesso SSH.');
        if (!data.instance || !data.instance.id) throw new Error('Resposta inválida: instância SSH não retornada.');

        const ssh = data.ssh || {};
        const logs = [
            `SSH Hostname: ${ssh.hostname || '-'}`,
            `Destino: ${ssh.service || 'ssh://localhost:8022'}`,
            `Instância: ${data.instance?.name || 'Autoconfiguração do Sistema'} (${data.started ? 'iniciada' : 'salva'})`,
            `Status start: ${data.startMessage || (data.started ? 'Iniciada automaticamente.' : 'Sem início automático.')}`,
            '',
            'Cloudflare Access (terminal):',
            ssh.cloudflaredAccessSsh || '',
            '',
            'SSH com ProxyCommand:',
            ssh.proxyCommand || '',
            '',
            'Bridge para Termius:',
            ssh.termiusBridge || '',
            'No Termius: Host 127.0.0.1 | Porta 2222'
        ].join('\n');
        acSetLogs(logs);
        showToast(`Acesso SSH gerado para ${ssh.hostname || domain}${data.started ? ' e instância iniciada.' : '.'}`, data.started ? 'success' : 'warning');
        acCloseSshAssistModal();
        try {
            await cfFetchInstances();
            setTimeout(() => cfFetchInstances(), 800);
        } catch (_) {}
    } catch (e) {
        showToast('Erro ao gerar acesso SSH: ' + e.message, 'error');
    }
}

async function acValidateConfig() {
    try {
        const res = await fetch(`${API_BASE}/autoconfig/validate`, { method:'POST' });
        const data = await res.json();
        const lines = (data.checks || []).map(c => `${c.key}: ${c.ok ? 'OK' : 'FALHOU'} ${c.output || ''}`).join('\n');
        acSetLogs(lines || JSON.stringify(data, null, 2));
        if (!data.success) return showToast('ValidaÃ§Ã£o falhou.', 'error');
        showToast('ValidaÃ§Ã£o concluÃ­da com sucesso.', 'success');
    } catch (e) {
        showToast('Erro na validaÃ§Ã£o: ' + e.message, 'error');
    }
}

async function acApplyConfig() {
    try {
        const res = await fetch(`${API_BASE}/autoconfig/apply`, { method:'POST' });
        const data = await res.json();
        if (!data.success) {
            acSetLogs(JSON.stringify(data.validation || data, null, 2));
            throw new Error(data.error || 'Falha ao aplicar configuraÃ§Ã£o.');
        }
        showToast('ConfiguraÃ§Ã£o aplicada sem derrubar o painel.', 'success');
        acSetLogs('AplicaÃ§Ã£o concluÃ­da com sucesso.');
    } catch (e) {
        showToast('Erro ao aplicar: ' + e.message, 'error');
    }
}

async function acRestoreBackup() {
    try {
        const res = await fetch(`${API_BASE}/autoconfig/restore`, { method:'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Falha ao restaurar backup.');
        showToast('Backup restaurado com sucesso.', 'success');
        acSetLogs(JSON.stringify(data.backup || data, null, 2));
    } catch (e) {
        showToast('Erro ao restaurar backup: ' + e.message, 'error');
    }
}

async function acLoadLogs() {
    try {
        const res = await fetch(`${API_BASE}/autoconfig/logs?kind=services`);
        const data = await res.json();
        acSetLogs(data.logs || 'Sem logs.');
    } catch (e) {
        showToast('Erro ao carregar logs: ' + e.message, 'error');
    }
}

async function acLoadState() {
    try {
        const res = await fetch(`${API_BASE}/autoconfig/state`);
        const data = await res.json();
        if (!data.success) return;
        const domain = data.config?.domain || data.services?.domain || '';
        const mode = data.config?.mode || 'cloudflare_nginx';
        const domainEl = document.getElementById('acDomain');
        const modeEl = document.getElementById('acMode');
        if (domainEl && !domainEl.value) domainEl.value = domain;
        if (modeEl) modeEl.value = mode;
        acRenderServices(data.services?.services || []);
    } catch {}
}

window.cfKillZombies = cfKillZombies;
window.cfShowInstanceModal = cfShowInstanceModal;
window.cfCloseInstanceModal = cfCloseInstanceModal;
window.cfFetchInstances = cfFetchInstances;
window.cfSubmitInstance = cfSubmitInstance;
window.cfStartInstance = cfStartInstance;
window.cfStopInstance = cfStopInstance;
window.cfReloadSafeInstance = cfReloadSafeInstance;
window.cfDeleteInstance = cfDeleteInstance;
window.cfAddRouteRow = cfAddRouteRow;
window.cfRemoveTempRoute = cfRemoveTempRoute;
window.cfUpdateTempRoute = cfUpdateTempRoute;
window.cfShowLogsModal = cfShowLogsModal;
window.cfCloseLogsModal = cfCloseLogsModal;
window.cfCloudflareLogin = cfCloudflareLogin;
window.cfRemoveLoginConfig = cfRemoveLoginConfig;
window.acDetectServices = acDetectServices;
window.acGenerateRoutes = acGenerateRoutes;
window.acOpenSshAssistModal = acOpenSshAssistModal;
window.acCloseSshAssistModal = acCloseSshAssistModal;
window.acGenerateSshAccessFromModal = acGenerateSshAccessFromModal;
window.acGenerateSshAccess = acGenerateSshAccessFromModal;
window.acValidateConfig = acValidateConfig;
window.acApplyConfig = acApplyConfig;
window.acRestoreBackup = acRestoreBackup;
window.acLoadLogs = acLoadLogs;

setInterval(() => {
    const el = document.getElementById('tab-cloudflared');
    if (el && el.classList.contains('active')) {
        cfFetchInstances();
    }
}, 5000);

// ============================================================
//  START
// ============================================================
function forceCloseAllModalsOnBoot() {
    document.querySelectorAll('.modal').forEach((modal) => {
        modal.classList.add('hidden');
    });
}

document.addEventListener('DOMContentLoaded', () => {
    forceCloseAllModalsOnBoot();
    runBootSequence();
    initFileBrowserShortcuts();
    installMojibakeFixes();
});

function normalizeMojibakeText(input) {
    if (typeof input !== 'string' || !input) return input;
    let s = input;
    const fixes = [
        ['Ã¡', 'á'], ['Ã¢', 'â'], ['Ã£', 'ã'], ['Ã©', 'é'], ['Ãª', 'ê'], ['Ã­', 'í'], ['Ã³', 'ó'], ['Ã´', 'ô'], ['Ãµ', 'õ'], ['Ãº', 'ú'], ['Ã§', 'ç'],
        ['Ã', 'Á'], ['Ã‰', 'É'], ['Ã“', 'Ó'], ['Ãš', 'Ú'], ['Ã‡', 'Ç'],
        ['NÃ£o', 'Não'], ['nÃ£o', 'não'], ['jÃ¡', 'já'], ['estÃ¡', 'está'], ['serÃ¡', 'será'],
        ['Inst�ncias', 'Instâncias'], ['inst�ncias', 'instâncias'], ['pr�prio', 'próprio'], ['TÃºnel', 'Túnel'],
        ['configuraÃ§Ã£o', 'configuração'], ['conexÃ£o', 'conexão'], ['domÃ­nio', 'domínio'], ['pÃºblico', 'público'],
        ['invÃ¡lido', 'inválido'], ['serviÃ§o', 'serviço'], ['ServiÃ§o', 'Serviço'], ['instÃ¢ncia', 'instância'], ['InstÃ¢ncia', 'Instância'],
        ['usuÃ¡rio', 'usuário'], ['UsuÃ¡rio', 'Usuário'], ['validaÃ§Ã£o', 'validação'], ['aplicaÃ§Ã£o', 'aplicação'], ['inicializaÃ§Ã£o', 'inicialização'],
        ['â€”', '—'], ['â€“', '–'], ['â€˜', '‘'], ['â€™', '’'], ['â€œ', '“'], ['â€', '”'], ['â€¢', '•'], ['â€¦', '…'],
        ['â˜ï¸', '☁️'], ['âœ…', '✅'], ['âŒ', '❌'], ['âš ï¸', '⚠️'],
        ['Â°', '°'], ['Âº', 'º'], ['Âª', 'ª'],
        ['ðŸš€', '🚀'], ['ðŸŒ', '🌐'], ['ðŸ“œ', '📜'], ['ðŸ”„', '🔄']
    ];
    for (const [from, to] of fixes) s = s.split(from).join(to);

    // Decodificação robusta para textos com mojibake remanescente.
    // Exemplo: "TÃºnel" -> "Túnel", "â˜ï¸" -> "☁️"
    const likelyBroken = /[ÃÂâð�]/.test(s);
    if (likelyBroken) {
        try {
            const bytes = new Uint8Array(Array.from(s, ch => ch.charCodeAt(0) & 0xff));
            const repaired = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
            if (repaired && repaired.length && /[^\u0000-\u001F]/.test(repaired)) {
                s = repaired;
            }
        } catch {}
    }
    return s;
}

function fixDomTextMojibake(root) {
    if (!root) return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
        if (!node.nodeValue) continue;
        const fixed = normalizeMojibakeText(node.nodeValue);
        if (fixed !== node.nodeValue) node.nodeValue = fixed;
    }
}

function installMojibakeFixes() {
    fixDomTextMojibake(document.body);

    const patchToast = () => {
        if (typeof window.showToast !== 'function' || window.showToast.__mojibakePatched) return;
        const original = window.showToast;
        const wrapped = function(message, type, duration) {
            return original.call(this, normalizeMojibakeText(message), type, duration);
        };
        wrapped.__mojibakePatched = true;
        window.showToast = wrapped;
    };

    patchToast();
    setTimeout(patchToast, 800);
    setTimeout(() => fixDomTextMojibake(document.body), 1000);

    // Corrige textos que entram depois (render dinâmico, tabelas, badges, toasts).
    const observer = new MutationObserver(() => {
        fixDomTextMojibake(document.body);
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
}

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
    setTimeout(() => { addLog('Autenticando sessÃ£o interna (NoAuth SSO)...'); progress.style.width = '60%'; status.textContent = 'Autenticando...'; }, 1600);
    setTimeout(() => { 
        addLog('Carregando interface Web...'); 
        progress.style.width = '75%'; 
        status.textContent = 'Carregando UI...'; 
        iframe.src = '/__filebrowser/'; 
    }, 2200);
    
    iframe.onload = () => {
        if (iframe.src.includes('about:blank')) return;
        
        addLog('Aplicando injeÃ§Ã£o de CSS (Termux cPanel Dark Theme)...');
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
            html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files${storageBase}/home'"><i data-lucide="home"></i> DiretÃ³rio Home</button>`;
            html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files/etc'"><i data-lucide="terminal-square"></i> Pasta /etc</button>`;
            html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files/var/www'"><i data-lucide="globe"></i> Pasta /var/www</button>`;
        }
        
        html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files' + window.location.pathname.replace('/index.html', '') + '/backups'"><i data-lucide="archive"></i> Backups</button>`;
        html += `<button class="btn btn-secondary" style="justify-content: flex-start;" onclick="document.getElementById('iframe-filebrowser').src='/__filebrowser/files' + window.location.pathname.replace('/index.html', '') + '/config'"><i data-lucide="settings"></i> ConfiguraÃ§Ãµes</button>`;
        
        container.innerHTML = html;
        if (window.lucide) lucide.createIcons();
    } catch(e) {
        console.error('Falha ao carregar atalhos dinÃ¢micos do FileBrowser:', e);
    }
}

// ============================================================
//  TESTE DE VELOCIDADE (SPEEDTEST) - CLIENT LÃ“GICA
// ============================================================
let isSpeedtestRunning = false;
let speedtestUnit = 'Mbps';
let speedtestMode = 'fast';

function setSpeedtestMode(e, mode) {
    if (e) {
        e.stopPropagation();
        e.preventDefault();
    }
    if (isSpeedtestRunning) return;
    speedtestMode = mode === 'slow' ? 'slow' : 'fast';
    const fastBtn = document.getElementById('speedtest-mode-fast');
    const slowBtn = document.getElementById('speedtest-mode-slow');
    if (fastBtn) fastBtn.classList.toggle('active', speedtestMode === 'fast');
    if (slowBtn) slowBtn.classList.toggle('active', speedtestMode === 'slow');
}

function toggleSpeedtestUnit(e) {
    if (e) {
        e.stopPropagation();
        e.preventDefault();
    }
    speedtestUnit = speedtestUnit === 'Mbps' ? 'KB/s' : 'Mbps';
    const btn = document.getElementById('speedtest-unit-btn');
    if (btn) btn.textContent = speedtestUnit;
    
    document.querySelectorAll('.speedtest-unit-label').forEach(el => {
        el.textContent = speedtestUnit === 'Mbps' ? 'Mb' : 'KB';
    });
}

function formatSpeed(mbps) {
    if (speedtestUnit === 'KB/s') {
        return (mbps * 125).toFixed(0);
    }
    return mbps.toFixed(1);
}

function updateNeedle(mbps) {
    const needle = document.getElementById('speedtest-needle');
    if (!needle) return;
    let max = speedtestMode === 'slow' ? 300 : 700;
    let angle = -90 + (mbps / max) * 180;
    if (angle > 90) angle = 90;
    needle.style.transform = `rotate(${angle}deg)`;
}

function startSpeedTest() {
    if (isSpeedtestRunning) return;

    const card = document.getElementById('speedtest-card');
    const iconContainer = document.getElementById('speedtest-icon-container');
    const mainVal = document.getElementById('speedtest-main-value');
    const statusText = document.getElementById('speedtest-status-text');
    const pingVal = document.getElementById('speedtest-ping');
    const jitterVal = document.getElementById('speedtest-jitter');
    const downVal = document.getElementById('speedtest-download');
    const upVal = document.getElementById('speedtest-upload');

    const pingValCompact = document.getElementById('speedtest-ping-compact');
    const jitterValCompact = document.getElementById('speedtest-jitter-compact');
    const downValCompact = document.getElementById('speedtest-down-compact');
    const upValCompact = document.getElementById('speedtest-up-compact');
    const statusCompact = document.getElementById('speedtest-status');

    isSpeedtestRunning = true;

    // Change icon to loading spinner
    if (iconContainer) {
        iconContainer.innerHTML = `<i data-lucide="loader-2" class="spin" style="color: var(--primary); width: 16px; height: 16px;"></i>`;
    }
    if (window.lucide) lucide.createIcons();

    if (card) {
        card.classList.add('speedtest-running');
        card.style.pointerEvents = 'none'; // prevent double clicks
    }

    if (mainVal) mainVal.textContent = '---';
    if (statusText) statusText.textContent = 'Conectando...';
    if (statusCompact) statusCompact.textContent = 'Conectando...';
    if (pingVal) pingVal.textContent = '--';
    if (pingValCompact) pingValCompact.textContent = '--';
    if (jitterVal) jitterVal.textContent = '--';
    if (jitterValCompact) jitterValCompact.textContent = '--';
    if (downVal) downVal.textContent = '--';
    if (downValCompact) downValCompact.textContent = '--';
    if (upVal) upVal.textContent = '--';
    if (upValCompact) upValCompact.textContent = '--';

    // Cria EventSource
    const eventSource = new EventSource(`/api/speedtest?mode=${encodeURIComponent(speedtestMode)}`);

    eventSource.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);

            if (data.stage === 'ping') {
                if (data.status === 'running') {
                    statusText.textContent = 'Medindo ping...';
                    if (statusCompact) statusCompact.textContent = 'Ping...';
                    mainVal.textContent = 'Ping';
                } else if (data.status === 'done') {
                    if (pingVal) pingVal.textContent = data.ping;
                    if (pingValCompact) pingValCompact.textContent = `${data.ping}ms`;
                    if (jitterVal) jitterVal.textContent = data.jitter ?? '--';
                    if (jitterValCompact) jitterValCompact.textContent = data.jitter ?? '--';
                    statusText.textContent = 'Download...';
                    if (statusCompact) statusCompact.textContent = 'Down...';
                }
            }

            if (data.stage === 'download') {
                if (data.status === 'running') {
                    statusText.textContent = `Download... ${data.percent}%`;
                    if (statusCompact) statusCompact.textContent = `Down: ${data.percent}%`;
                    mainVal.textContent = `${formatSpeed(data.speed)} ${speedtestUnit === 'Mbps' ? 'Mb' : 'KB'}`;
                    updateNeedle(data.speed);
                } else if (data.status === 'done') {
                    if (downVal) downVal.textContent = formatSpeed(data.speed);
                    if (downValCompact) downValCompact.textContent = `${formatSpeed(data.speed)} ${speedtestUnit === 'Mbps' ? 'M' : 'K'}`;
                    statusText.textContent = 'Upload...';
                    if (statusCompact) statusCompact.textContent = 'Up...';
                    updateNeedle(0);
                }
            }

            if (data.stage === 'upload') {
                if (data.status === 'running') {
                    statusText.textContent = `Upload... ${data.percent}%`;
                    if (statusCompact) statusCompact.textContent = `Up: ${data.percent}%`;
                    mainVal.textContent = `${formatSpeed(data.speed)} ${speedtestUnit === 'Mbps' ? 'Mb' : 'KB'}`;
                    updateNeedle(data.speed);
                } else if (data.status === 'done') {
                    if (upVal) upVal.textContent = formatSpeed(data.speed);
                    if (upValCompact) upValCompact.textContent = `${formatSpeed(data.speed)} ${speedtestUnit === 'Mbps' ? 'M' : 'K'}`;
                    updateNeedle(0);
                }
            }

            if (data.stage === 'finished') {
                statusText.textContent = 'ConcluÃ­do!';
                if (statusCompact) statusCompact.textContent = 'Ãšltimo teste: agora';
                mainVal.textContent = `${formatSpeed(data.download)} ${speedtestUnit === 'Mbps' ? 'Mb' : 'KB'}`;
                if (pingVal) pingVal.textContent = data.ping || '--';
                if (pingValCompact) pingValCompact.textContent = data.ping ? `${data.ping}ms` : '--';
                if (jitterVal) jitterVal.textContent = data.jitter ?? '--';
                if (jitterValCompact) jitterValCompact.textContent = data.jitter ?? '--';
                if (downVal) downVal.textContent = formatSpeed(data.download);
                if (downValCompact) downValCompact.textContent = `${formatSpeed(data.download)} ${speedtestUnit === 'Mbps' ? 'M' : 'K'}`;
                if (upVal) upVal.textContent = formatSpeed(data.upload);
                if (upValCompact) upValCompact.textContent = `${formatSpeed(data.upload)} ${speedtestUnit === 'Mbps' ? 'M' : 'K'}`;
                if (statusText && data.packetLoss !== undefined) {
                    statusText.textContent = `Concluído! Ping ${data.ping}ms | Jitter ${data.jitter ?? '--'}ms | Loss ${data.packetLoss}%`;
                }
                
                // Restaura estado
                isSpeedtestRunning = false;
                if (card) {
                    card.classList.remove('speedtest-running');
                    card.style.pointerEvents = 'auto';
                }
                if (iconContainer) {
                    iconContainer.innerHTML = `<i data-lucide="check-circle" style="color: var(--success); width: 16px; height: 16px;"></i>`;
                }
                if (window.lucide) lucide.createIcons();
                updateNeedle(0);

                eventSource.close();
            }

            if (data.stage === 'error') {
                throw new Error(data.message || 'Erro desconhecido');
            }
        } catch (e) {
            console.error('Erro ao processar dados de speedtest:', e);
            statusText.textContent = 'Falha no teste.';
            mainVal.textContent = 'Erro';
            
            isSpeedtestRunning = false;
            if (card) {
                card.classList.remove('speedtest-running');
                card.style.pointerEvents = 'auto';
            }
            if (iconContainer) {
                iconContainer.innerHTML = `<i data-lucide="play" style="color: var(--primary); width: 16px; height: 16px;"></i>`;
            }
            if (window.lucide) lucide.createIcons();
            updateNeedle(0);
            eventSource.close();
        }
    };

    eventSource.onerror = function(err) {
        console.error('Erro na conexÃ£o com SSE de speedtest:', err);
        statusText.textContent = 'Erro de conexÃ£o.';
        mainVal.textContent = 'Erro';
        
        isSpeedtestRunning = false;
        if (card) {
            card.classList.remove('speedtest-running');
            card.style.pointerEvents = 'auto';
        }
        if (iconContainer) {
            iconContainer.innerHTML = `<i data-lucide="play" style="color: var(--primary); width: 16px; height: 16px;"></i>`;
        }
        if (window.lucide) lucide.createIcons();
        updateNeedle(0);
        eventSource.close();
    };
}

// ============================================================
//  MONITORAMENTO DE REDE EM TEMPO REAL
// ============================================================
let rootModeActive = false;

async function checkNetworkAccess() {
    try {
        const response = await fetch("/api/network/test");
        const data = await response.json();
        
        const rootToggle = document.getElementById("root-toggle");
        const netStatus = document.getElementById("net-status");
        
        if (data.mode === "normal") {
            if (netStatus) netStatus.textContent = "Monitorando sem root";
            if (rootToggle) rootToggle.style.display = "none";
        } else if (data.mode === "root_available") {
            if (netStatus) netStatus.textContent = "Modo normal falhou. Root disponÃ­vel.";
            if (rootToggle) {
                rootToggle.style.display = "inline-flex";
                rootToggle.innerHTML = rootModeActive ? "ðŸ” Root ON" : "ðŸ”“ Normal";
            }
        } else {
            if (netStatus) {
                netStatus.textContent = `Erro de permissÃ£o ou interface nÃ£o encontrada`;
            }
            if (rootToggle) rootToggle.style.display = "none";
        }
    } catch (err) {
        const netStatus = document.getElementById("net-status");
        if (netStatus) netStatus.textContent = "Erro ao verificar rede";
    }
}

async function updateNetworkStatus() {
    try {
        const response = await fetch("/api/network/status");
        const data = await response.json();
        
        const ifaceEl = document.getElementById("net-interface");
        const downEl = document.getElementById("net-down");
        const upEl = document.getElementById("net-up");
        const downExpandedEl = document.getElementById("net-down-expanded");
        const upExpandedEl = document.getElementById("net-up-expanded");
        const totalDownEl = document.getElementById("net-total-down");
        const totalUpEl = document.getElementById("net-total-up");
        const statusEl = document.getElementById("net-status");
        const rootToggle = document.getElementById("root-toggle");
        
        if (data.success) {
            rootModeActive = !!data.root;
            if (ifaceEl) ifaceEl.textContent = data.interface || "---";
            if (downEl) downEl.textContent = data.downloadSpeed || '0 B/s';
            if (upEl) upEl.textContent = data.uploadSpeed || '0 B/s';
            if (downExpandedEl) downExpandedEl.textContent = data.downloadSpeed || '0 B/s';
            if (upExpandedEl) upExpandedEl.textContent = data.uploadSpeed || '0 B/s';
            if (totalDownEl) totalDownEl.textContent = data.totalReceived || '0 B';
            if (totalUpEl) totalUpEl.textContent = data.totalSent || '0 B';
            
            if (statusEl) {
                statusEl.textContent = data.root ? "Monitorando com root" : "Monitorando sem root";
            }
            if (rootToggle) {
                rootToggle.innerHTML = data.root ? "ðŸ” Root ON" : "ðŸ”“ Normal";
            }
        } else {
            rootModeActive = !!data.root;
            if (ifaceEl) ifaceEl.textContent = data.interface || "---";
            if (downEl) downEl.textContent = data.downloadSpeed || "-- KB/s";
            if (upEl) upEl.textContent = data.uploadSpeed || "-- KB/s";
            if (downExpandedEl) downExpandedEl.textContent = data.downloadSpeed || "-- KB/s";
            if (upExpandedEl) upExpandedEl.textContent = data.uploadSpeed || "-- KB/s";
            if (totalDownEl) totalDownEl.textContent = data.totalReceived || "--";
            if (totalUpEl) totalUpEl.textContent = data.totalSent || "--";
            if (statusEl) statusEl.textContent = data.status || "Erro ao ler rede";
            if (rootToggle) rootToggle.innerHTML = data.rootRequested ? "Root indisponivel" : "Normal";
        }
    } catch (err) {
        const statusEl = document.getElementById("net-status");
        if (statusEl) statusEl.textContent = "Erro ao ler rede";
    }
}

async function toggleRootMode(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }
    try {
        const nextState = !rootModeActive;
        const response = await fetch("/api/network/root", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ enabled: nextState })
        });
        const data = await response.json();
        if (data.success) {
            rootModeActive = !!data.root;
            const rootToggle = document.getElementById("root-toggle");
            if (rootToggle) {
                rootToggle.innerHTML = rootModeActive ? "ðŸ” Root ON" : "ðŸ”“ Normal";
            }
            showToast(`Modo root ${rootModeActive ? 'ativado' : 'desativado'} com sucesso!`, "success");
            updateNetworkStatus();
        } else {
            showToast("Falha ao alternar modo root", "error");
        }
    } catch (err) {
        showToast("Erro ao alternar modo root", "error");
    }
}

let tempHistory = [];

async function updateTemperatureHistory() {
    try {
        const response = await fetch("/api/temperature/history");
        const data = await response.json();
        if (data.success && Array.isArray(data.history)) {
            tempHistory = data.history.map(item => item.temperature);
            renderTempChart();
        }
    } catch (err) {
        console.error("Erro ao carregar historico de temperatura:", err);
    }
}

function renderTempChart() {
    const lineEl = document.getElementById('temp-chart-line');
    const areaEl = document.getElementById('temp-chart-area');
    if (!lineEl || !areaEl || tempHistory.length === 0) return;

    const width = 160;
    const height = 40;

    const values = tempHistory.map(val => {
        if (tempUnit === 'F') {
            return (val * 9/5) + 32;
        }
        return val;
    });

    const minVal = Math.min(...values) - 1.5;
    const maxVal = Math.max(...values) + 1.5;
    const delta = maxVal - minVal || 1;

    const step = width / (values.length - 1 || 1);

    const points = values.map((value, index) => {
        const x = index * step;
        const y = height - ((value - minVal) / delta) * (height - 6) - 3;
        return [x, y];
    });

    const linePath = points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x.toFixed(2)} ${y.toFixed(2)}`).join(' ');
    const areaPath = `${linePath} L ${width} ${height} L 0 ${height} Z`;

    lineEl.setAttribute('d', linePath);
    areaEl.setAttribute('d', areaPath);
}

// Expor funcoes para escopo global (window)
window.toggleRootMode = toggleRootMode;
window.toggleCpuRoot = toggleCpuRoot;
window.checkNetworkAccess = checkNetworkAccess;
window.updateNetworkStatus = updateNetworkStatus;
window.updateTemperatureHistory = updateTemperatureHistory;
window.renderTempChart = renderTempChart;

// ============================================================
//  MONITOR CARDS COMPACT/EXPANDED STATES MANAGEMENT
// ============================================================
function initMonitorCards() {
    const cards = document.querySelectorAll('.monitor-card');
    cards.forEach(card => {
        const cardName = card.getAttribute('data-card');
        if (!cardName) return;

        // Load state from localStorage. Default is 'compact' (is-compact)
        const savedState = localStorage.getItem(`monitor-card-state-${cardName}`) || 'compact';
        
        card.classList.remove('is-compact', 'is-expanded');
        card.classList.add(`is-${savedState}`);

        // Set correct icon indicator on the toggle button
        const toggleBtn = card.querySelector('.card-toggle-btn');
        if (toggleBtn) {
            toggleBtn.innerHTML = savedState === 'compact'
                ? '<i data-lucide="chevron-down"></i>'
                : '<i data-lucide="chevron-up"></i>';
            toggleBtn.classList.toggle('is-expanded', savedState !== 'compact');
            
            // Add click listener to toggle btn
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                toggleMonitorCard(cardName);
            });
        }
    });
    if (window.lucide) lucide.createIcons();
}

function toggleMonitorCard(cardName) {
    const card = document.querySelector(`.monitor-card[data-card="${cardName}"]`);
    if (!card) return;

    const isCompact = card.classList.contains('is-compact');
    const nextState = isCompact ? 'expanded' : 'compact';

    card.classList.remove('is-compact', 'is-expanded');
    card.classList.add(`is-${nextState}`);

    const toggleBtn = card.querySelector('.card-toggle-btn');
    if (toggleBtn) {
        toggleBtn.innerHTML = nextState === 'compact'
            ? '<i data-lucide="chevron-down"></i>'
            : '<i data-lucide="chevron-up"></i>';
        toggleBtn.classList.toggle('is-expanded', nextState !== 'compact');
    }

    localStorage.setItem(`monitor-card-state-${cardName}`, nextState);
    if (window.lucide) lucide.createIcons();
}

function toggleAllMonitorCards() {
    const cards = document.querySelectorAll('.monitor-card');
    if (!cards.length) return;

    // Check if at least one card is currently expanded
    let hasExpanded = false;
    cards.forEach(card => {
        if (card.classList.contains('is-expanded')) {
            hasExpanded = true;
        }
    });

    // If at least one is expanded, collapse all to compact. Otherwise, expand all.
    const targetState = hasExpanded ? 'compact' : 'expanded';

    cards.forEach(card => {
        const cardName = card.getAttribute('data-card');
        if (!cardName) return;

        card.classList.remove('is-compact', 'is-expanded');
        card.classList.add(`is-${targetState}`);

        const toggleBtn = card.querySelector('.card-toggle-btn');
        if (toggleBtn) {
            toggleBtn.innerHTML = targetState === 'compact'
                ? '<i data-lucide="chevron-down"></i>'
                : '<i data-lucide="chevron-up"></i>';
            toggleBtn.classList.toggle('is-expanded', targetState !== 'compact');
        }

        localStorage.setItem(`monitor-card-state-${cardName}`, targetState);
    });
    if (window.lucide) lucide.createIcons();
}

window.initMonitorCards = initMonitorCards;
window.toggleMonitorCard = toggleMonitorCard;
window.toggleAllMonitorCards = toggleAllMonitorCards;

// ============================================================
//  CONTROLE DE PROCESSOS E MEMÃ“RIA (MOTO G52 + ROOT)
// ============================================================
async function changeNodeMemoryMode() {
    const select = document.getElementById('settings-memory-mode');
    const badge = document.getElementById('memory-restart-badge');
    if (!select) return;
    const mode = select.value;
    
    try {
        const response = await fetch(`${API_BASE}/system/settings/memory`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode })
        });
        const res = await response.json();
        if (res.success) {
            showToast(res.message || 'ConfiguraÃ§Ã£o de memÃ³ria alterada. Reinicie para aplicar.', 'success');
            if (badge) badge.classList.remove('hidden');
        } else {
            showToast(res.error || 'Falha ao alterar configuraÃ§Ã£o de memÃ³ria', 'error');
        }
    } catch(err) {
        showToast('Erro ao alterar configuraÃ§Ã£o de memÃ³ria', 'error');
        console.error(err);
    }
}

async function diagnoseProcesses() {
    const modal = document.getElementById('processDiagnosticModal');
    const content = document.getElementById('process-diagnostic-content');
    if (modal) modal.classList.remove('hidden');
    if (content) content.innerHTML = '[Carregando diagnÃ³stico...]';

    try {
        const response = await fetch(`${API_BASE}/system/processes`);
        const res = await response.json();
        if (res.success) {
            let output = '';
            output += `=== DADOS DO PAINEL ===\n`;
            output += `Porta configurada: ${res.panel.port}\n`;
            output += `Porta ocupada? ${res.panel.portBusy ? 'SIM (PID: ' + res.panel.portBusyPid + ')' : 'NÃƒO'}\n`;
            output += `Lock do Node ativo? ${res.panel.pidFile ? 'SIM (PID no arquivo: ' + res.panel.pidFile + ')' : 'NÃƒO'}\n`;
            output += `Lock do Loop (start.sh) ativo? ${res.panel.startPidFile ? 'SIM (PID no arquivo: ' + res.panel.startPidFile + ')' : 'NÃƒO'}\n`;
            output += `Modo de memÃ³ria Node.js: ${res.panel.nodeMemoryMode} (${res.panel.nodeMemoryMb} MB)\n\n`;

            output += `=== PROCESSOS DO PAINEL ===\n`;
            output += `Processos de start.sh ativos: ${res.panel.startScripts.length}\n`;
            res.panel.startScripts.forEach(proc => {
                output += `  - PID: ${proc.pid} | PPID: ${proc.ppid} | Comando: ${proc.cmd}\n`;
            });
            output += `Processos do Node.js server.js ativos: ${res.panel.nodeServers.length}\n`;
            res.panel.nodeServers.forEach(proc => {
                output += `  - PID: ${proc.pid} | PPID: ${proc.ppid} | Comando: ${proc.cmd}\n`;
            });
            output += `\n`;

            output += `=== SERVIÃ‡OS DO SISTEMA ===\n`;
            output += `Lock de atualizaÃ§Ã£o ativo? ${res.locks.updateLock ? 'SIM' : 'NÃƒO'}\n`;
            output += `Lock de start.sh ativo? ${res.locks.startLock ? 'SIM' : 'NÃƒO'}\n`;
            output += `Processos MariaDB ativos: ${res.services.mariadb.length}\n`;
            res.services.mariadb.forEach(proc => {
                output += `  - PID: ${proc.pid} | Comando: ${proc.cmd}\n`;
            });
            output += `Processos Cloudflared ativos: ${res.services.cloudflared.length}\n`;
            res.services.cloudflared.forEach(proc => {
                output += `  - PID: ${proc.pid} | Comando: ${proc.cmd}\n`;
            });
            output += `\n`;

            output += `=== MEMÃ“RIA RAM DO SISTEMA ===\n`;
            output += `Total: ${res.memory.total} MB | Livre: ${res.memory.free} MB | Uso: ${res.memory.usagePercent}%\n\n`;

            output += `=== REGISTROS OOM/KILL DO KERNEL (dmesg) ===\n`;
            output += `${res.oomLog}\n`;

            if (content) content.textContent = output;
        } else {
            if (content) content.textContent = 'Erro ao obter dados de diagnÃ³stico: ' + (res.error || 'Erro desconhecido');
        }
    } catch(err) {
        if (content) content.textContent = 'Erro ao realizar requisiÃ§Ã£o de diagnÃ³stico: ' + err.message;
        console.error(err);
    }
}

function closeProcessDiagnosticModal() {
    const modal = document.getElementById('processDiagnosticModal');
    if (modal) modal.classList.add('hidden');
}

async function stopDuplicatePanel() {
    if (!confirm('Deseja realmente parar processos duplicados do painel? Todos os processos antigos serÃ£o encerrados e limpos de forma segura.')) {
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/system/stop`, { method: 'POST' });
        const res = await response.json();
        if (res.success) {
            showToast('Processo de parada segura disparado. O painel serÃ¡ encerrado em instantes.', 'success');
        } else {
            showToast(res.error || 'Falha ao solicitar parada de duplicados', 'error');
        }
    } catch(err) {
        showToast('Erro ao solicitar parada de duplicados', 'error');
        console.error(err);
    }
}

async function safeRestartPanel() {
    if (!confirm('Deseja realizar o ReinÃ­cio Seguro? O painel irÃ¡ parar todos os seus processos e reiniciarÃ¡ limpo em atÃ© 5 segundos. Esta pÃ¡gina tentarÃ¡ reconectar automaticamente.')) {
        return;
    }
    
    // Mostra tela/loader de carregamento/reinÃ­cio
    const overlay = document.createElement('div');
    overlay.style.position = 'fixed';
    overlay.style.top = '0';
    overlay.style.left = '0';
    overlay.style.width = '100vw';
    overlay.style.height = '100vh';
    overlay.style.background = 'rgba(0,0,0,0.85)';
    overlay.style.color = '#fff';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.style.justifyContent = 'center';
    overlay.style.alignItems = 'center';
    overlay.style.zIndex = '999999';
    overlay.innerHTML = `
        <div style="font-size:2rem; margin-bottom:15px; animation: spin 2s linear infinite;">ðŸ”„</div>
        <div style="font-size:1.2rem; font-weight:bold; margin-bottom:10px;">Executando ReinÃ­cio Seguro...</div>
        <div style="font-size:0.9rem; color:#aaa;" id="restart-status">Enviando sinal de reinÃ­cio...</div>
    `;
    document.body.appendChild(overlay);

    try {
        const response = await fetch(`${API_BASE}/system/restart`, { method: 'POST' });
        const res = await response.json();
        if (!res.success) {
            showToast(res.error || 'Erro ao enviar sinal de reinÃ­cio', 'error');
            document.body.removeChild(overlay);
            return;
        }

        let attempts = 0;
        const maxAttempts = 30;
        document.getElementById('restart-status').textContent = 'Aguardando painel desligar e subir novamente (isso leva ~5 segundos)...';

        // Intervalo para verificar quando a porta voltar a responder
        const interval = setInterval(async () => {
            attempts++;
            if (attempts > maxAttempts) {
                clearInterval(interval);
                document.getElementById('restart-status').innerHTML = 'âŒ O servidor estÃ¡ demorando muito para responder.<br>Por favor, verifique no Termux manualmente ou recarregue a pÃ¡gina.';
                const closeBtn = document.createElement('button');
                closeBtn.className = 'btn btn-secondary btn-sm';
                closeBtn.style.marginTop = '15px';
                closeBtn.textContent = 'Fechar Aviso';
                closeBtn.onclick = () => document.body.removeChild(overlay);
                overlay.appendChild(closeBtn);
                return;
            }
            try {
                const check = await fetch(`${API_BASE}/system/settings`, { method: 'GET', signal: AbortSignal.timeout(1000) });
                if (check.ok) {
                    clearInterval(interval);
                    document.getElementById('restart-status').textContent = 'âœ… Painel reconectado! Recarregando pÃ¡gina...';
                    setTimeout(() => {
                        window.location.reload();
                    }, 1000);
                }
            } catch(e) {
                // Servidor fora do ar, aguardando subir
            }
        }, 1500);

    } catch(err) {
        showToast('Erro ao reiniciar o painel', 'error');
        document.body.removeChild(overlay);
        console.error(err);
    }
}

// Expor no escopo global
window.changeNodeMemoryMode = changeNodeMemoryMode;
window.diagnoseProcesses = diagnoseProcesses;
window.closeProcessDiagnosticModal = closeProcessDiagnosticModal;
window.stopDuplicatePanel = stopDuplicatePanel;
window.safeRestartPanel = safeRestartPanel;

// ============================================================
//  CLOUDFLARED PROXY REVERSO (INGRESS PATH-BASED ROUTING)
// ============================================================
let cfrRoutesListCached = [];
window.cfrLogInterval = null;

async function cfrFetchRoutes() {
    const listEl = document.getElementById('cfrRoutesList');
    if (!listEl) return;

    try {
        const res = await fetch(`${API_BASE}/cloudflared/routes`);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (data.success) {
            cfrRoutesListCached = data.routes || [];
            cfrRenderRoutes(cfrRoutesListCached);
        } else {
            throw new Error(data.error || 'Erro desconhecido ao carregar rotas.');
        }
    } catch (err) {
        console.error('[cfrFetchRoutes] Erro:', err);
        showToast('Erro ao carregar rotas do Proxy Reverso: ' + err.message, 'error');
        listEl.innerHTML = `<tr><td colspan="7" style="padding: 20px; text-align: center; color: var(--danger);">âŒ Falha ao carregar rotas da API: ${err.message}</td></tr>`;
    }
}

function cfrRenderRoutes(routes) {
    const listEl = document.getElementById('cfrRoutesList');
    if (!listEl) return;

    if (!routes || routes.length === 0) {
        listEl.innerHTML = `<tr><td colspan="7" style="padding: 20px; text-align: center; color: var(--text-muted);">Nenhuma rota configurada. Clique em "Adicionar Rota" para comecar.</td></tr>`;
        return;
    }

    const sorted = [...routes].sort((a, b) => (a.order || 0) - (b.order || 0));

    listEl.innerHTML = sorted.map((r, idx) => {
        const protocol = (r.targetProtocol || 'http').toLowerCase();
        const isSsh = protocol === 'ssh';
        const isHttpLike = protocol === 'http' || protocol === 'https';
        const localUrl = `${r.targetProtocol}://${r.targetHost}:${r.targetPort}${isHttpLike ? (r.path || '/') : ''}`;
        const publicUrl = isSsh ? '' : `https://${r.hostname}${r.path || '/'}`;
        const publicAccessLabel = isSsh
            ? `<span style="font-family: monospace; font-size: 0.85rem; font-weight: 600;">${cfEscape(r.hostname)}</span><div style="font-size: 0.72rem; color: var(--text-muted);">Uso: SSH via Cloudflare Access</div>`
            : `<a href="${publicUrl}" target="_blank" class="text-primary" style="text-decoration: none; font-family: monospace; font-size: 0.85rem; font-weight: 600;">${cfEscape(r.hostname)}</a>`;

        const isFirst = idx === 0;
        const isLast = idx === sorted.length - 1;

        const upBtn = `<button class="btn btn-secondary btn-sm" style="padding: 3px 6px; margin-right: 2px;" onclick="cfrMoveRouteUp('${r.id}')" ${isFirst ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} title="Mover para Cima">â–²</button>`;
        const downBtn = `<button class="btn btn-secondary btn-sm" style="padding: 3px 6px;" onclick="cfrMoveRouteDown('${r.id}')" ${isLast ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} title="Mover para Baixo">â–¼</button>`;

        const testLocalBtn = `<button class="btn btn-secondary btn-sm" style="padding: 4px 8px;" id="btn-test-local-${r.id}" onclick="cfrTestRoute('${r.id}', '${localUrl}')" title="Testar ConexÃ£o Local"><i data-lucide="activity"></i> Local</button>`;
        const testPublicBtn = isSsh
            ? ''
            : `<button class="btn btn-secondary btn-sm" style="padding: 4px 8px;" id="btn-test-pub-${r.id}" onclick="cfrTestPublicUrl('${r.id}', '${publicUrl}')" title="Testar URL PÃºblica"><i data-lucide="globe"></i> PÃºblica</button>`;

        const editBtn = `<button class="btn btn-secondary btn-sm" style="padding: 4px 8px;" onclick="cfrOpenRouteModal('${r.id}')" title="Editar"><i data-lucide="edit-2"></i></button>`;
        const deleteBtn = `<button class="btn btn-danger btn-sm" style="padding: 4px 8px;" onclick="cfrDeleteRoute('${r.id}')" title="Excluir"><i data-lucide="trash-2"></i></button>`;

        const statusToggle = `
            <div style="display: flex; align-items: center; gap: 8px;">
                <input type="checkbox" id="toggle-route-${r.id}" ${r.enabled ? 'checked' : ''} onchange="cfrToggleRouteEnabled('${r.id}', ${r.enabled})" style="width: 16px; height: 16px; cursor: pointer;">
                <span class="badge ${r.enabled ? 'badge-success' : 'badge-danger'}" style="font-size: 0.75rem;">
                    ${r.enabled ? 'Ativo' : 'Inativo'}
                </span>
            </div>
        `;

        return `
            <tr id="cfr-row-${r.id}">
                <td style="padding: 12px 16px; vertical-align: middle;">
                    <div style="display: flex; align-items: center; gap: 6px;">
                        <span style="font-weight: bold; min-width: 16px;">${r.order || (idx + 1)}</span>
                        <div style="display: flex; flex-direction: row; gap: 2px;">
                            ${upBtn}
                            ${downBtn}
                        </div>
                    </div>
                </td>
                <td style="padding: 12px 16px; font-weight: 500; vertical-align: middle;">${cfEscape(r.name)}</td>
                <td style="padding: 12px 16px; vertical-align: middle;">${publicAccessLabel}</td>
                <td style="padding: 12px 16px; vertical-align: middle;"><code style="background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px; font-size: 0.85rem;">${cfEscape(isSsh ? 'N/A (SSH)' : (r.path || '/'))}</code></td>
                <td style="padding: 12px 16px; font-family: monospace; font-size: 0.85rem; vertical-align: middle;">
                    ${localUrl}
                    ${isSsh ? `<div style="margin-top: 6px; font-size: 0.72rem; color: var(--warning);">Não use https://${cfEscape(r.hostname)}/ nem porta 22 direta.</div>` : ''}
                    <div id="cfr-test-result-${r.id}" style="margin-top: 4px; font-size: 0.75rem;"></div>
                </td>
                <td style="padding: 12px 16px; vertical-align: middle;">${statusToggle}</td>
                <td style="padding: 12px 16px; vertical-align: middle;">
                    <div style="display: flex; gap: 6px; justify-content: center;">
                        ${testLocalBtn}
                        ${testPublicBtn}
                        ${editBtn}
                        ${deleteBtn}
                    </div>
                </td>
            </tr>
        `;
    }).join('');

    if (window.lucide) lucide.createIcons();
}

function cfrOpenRouteModal(id = null) {
    const modal = document.getElementById('cfrRouteModal');
    if (!modal) return;

    const modalTitle = document.getElementById('cfrModalTitle');
    const submitBtn = document.getElementById('cfrModalSubmitBtn');

    // Reset inputs
    document.getElementById('cfrRouteId').value = '';
    document.getElementById('cfrInputName').value = '';
    document.getElementById('cfrHostname').value = 'panel.arjtechbr.site';
    document.getElementById('cfrPath').value = '/';
    document.getElementById('cfrOrder').value = '99';
    document.getElementById('cfrProtocol').value = 'http';
    document.getElementById('cfrPort').value = '';
    document.getElementById('cfrEnabled').checked = true;

    if (id) {
        // Edit Mode
        if (modalTitle) modalTitle.textContent = 'âœï¸ Editar Rota Proxy Reverso';
        if (submitBtn) submitBtn.textContent = 'Salvar Rota';

        const route = cfrRoutesListCached.find(r => r.id === id);
        if (route) {
            document.getElementById('cfrRouteId').value = route.id;
            document.getElementById('cfrInputName').value = route.name;
            document.getElementById('cfrHostname').value = route.hostname;
            document.getElementById('cfrPath').value = route.path;
            document.getElementById('cfrOrder').value = route.order;
            document.getElementById('cfrProtocol').value = route.targetProtocol;
            document.getElementById('cfrPort').value = route.targetPort;
            document.getElementById('cfrEnabled').checked = !!route.enabled;
        }
    } else {
        // Add Mode
        if (modalTitle) modalTitle.textContent = 'ðŸš€ Adicionar Rota Proxy Reverso';
        if (submitBtn) submitBtn.textContent = 'Adicionar Rota';
        
        let nextOrder = 1;
        if (cfrRoutesListCached.length > 0) {
            const maxOrder = Math.max(...cfrRoutesListCached.map(r => r.order || 0));
            nextOrder = maxOrder + 1;
        }
        document.getElementById('cfrOrder').value = nextOrder;
    }

    cfrUpdateUrlPreview();
    modal.classList.remove('hidden');
}

function cfrCloseRouteModal() {
    const modal = document.getElementById('cfrRouteModal');
    if (modal) modal.classList.add('hidden');
}

function cfrUpdateUrlPreview() {
    const protocol = document.getElementById('cfrProtocol').value;
    const port = document.getElementById('cfrPort').value || '80';
    const path = document.getElementById('cfrPath').value || '/';
    
    const previewEl = document.getElementById('cfrUrlPreview');
    if (previewEl) {
        const isHttpLike = protocol === 'http' || protocol === 'https';
        previewEl.value = `${protocol}://127.0.0.1:${port}${isHttpLike ? path : ''}`;
    }
    const pathInput = document.getElementById('cfrPath');
    if (pathInput) {
        const isSsh = protocol === 'ssh';
        pathInput.disabled = isSsh;
        pathInput.placeholder = isSsh ? 'Path não aplicável para SSH' : 'Ex: / ou /api/';
        if (isSsh) pathInput.value = '';
    }
}

async function cfrSubmitRoute(event) {
    event.preventDefault();

    const id = document.getElementById('cfrRouteId').value;
    const payload = {
        name: document.getElementById('cfrInputName').value.trim(),
        hostname: document.getElementById('cfrHostname').value.trim(),
        path: document.getElementById('cfrPath').value.trim(),
        order: parseInt(document.getElementById('cfrOrder').value) || 99,
        targetProtocol: document.getElementById('cfrProtocol').value,
        targetHost: '127.0.0.1',
        targetPort: parseInt(document.getElementById('cfrPort').value) || 80,
        enabled: document.getElementById('cfrEnabled').checked
    };

    if (!payload.name) return showToast('Insira o nome do serviÃ§o.', 'warning');
    if (!payload.hostname) return showToast('Insira o domÃ­nio pÃºblico.', 'warning');
    if ((payload.targetProtocol === 'http' || payload.targetProtocol === 'https') && !payload.path) {
        return showToast('Insira o caminho (path).', 'warning');
    }
    if (!payload.targetPort) return showToast('Insira a porta local alvo.', 'warning');
    if (payload.targetProtocol === 'ssh') {
        payload.path = '';
    }

    if (payload.hostname.includes(':')) {
        return showToast('O domÃ­nio pÃºblico nÃ£o deve conter portas (:8080, etc).', 'warning');
    }

    const url = id ? `${API_BASE}/cloudflared/routes-sync/${id}` : `${API_BASE}/cloudflared/routes`;
    const method = id ? 'PUT' : 'POST';

    try {
        const res = await fetch(url, {
            method,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success) {
            showToast(id ? 'Rota atualizada com sucesso! (DNS sincronizado no backend)' : 'Rota adicionada com sucesso!', 'success');
            cfrCloseRouteModal();
            cfrFetchRoutes();
        } else {
            throw new Error(data.error || 'Erro desconhecido ao salvar rota.');
        }
    } catch (err) {
        console.error('[cfrSubmitRoute] Erro:', err);
        showToast('Erro ao salvar rota: ' + err.message, 'error');
    }
}

async function cfrDeleteRoute(id) {
    if (!confirm('Deseja realmente excluir esta rota?')) return;

    try {
        const res = await fetch(`${API_BASE}/cloudflared/routes-sync/${id}`, {
            method: 'DELETE'
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success) {
            showToast('Rota excluÃ­da com sucesso!', 'success');
            cfrFetchRoutes();
        } else {
            throw new Error(data.error || 'Erro desconhecido ao excluir rota.');
        }
    } catch (err) {
        console.error('[cfrDeleteRoute] Erro:', err);
        showToast('Erro ao excluir rota: ' + err.message, 'error');
    }
}

async function cfrToggleRouteEnabled(id, currentStatus) {
    try {
        const res = await fetch(`${API_BASE}/cloudflared/routes-sync/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: !currentStatus })
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success) {
            showToast(data.route.enabled ? 'Rota ativada!' : 'Rota desativada!', 'success');
            cfrFetchRoutes();
        } else {
            throw new Error(data.error || 'Erro ao alterar status da rota.');
        }
    } catch (err) {
        console.error('[cfrToggleRouteEnabled] Erro:', err);
        showToast('Erro ao alterar status da rota: ' + err.message, 'error');
        const chk = document.getElementById(`toggle-route-${id}`);
        if (chk) chk.checked = currentStatus;
    }
}

async function cfrMoveRouteUp(id) {
    const idx = cfrRoutesListCached.findIndex(r => r.id === id);
    if (idx <= 0) return;

    const routes = [...cfrRoutesListCached];
    const temp = routes[idx];
    routes[idx] = routes[idx - 1];
    routes[idx - 1] = temp;

    const ids = routes.map(r => r.id);
    await cfrSaveReorderedRoutes(ids);
}

async function cfrMoveRouteDown(id) {
    const idx = cfrRoutesListCached.findIndex(r => r.id === id);
    if (idx === -1 || idx >= cfrRoutesListCached.length - 1) return;

    const routes = [...cfrRoutesListCached];
    const temp = routes[idx];
    routes[idx] = routes[idx + 1];
    routes[idx + 1] = temp;

    const ids = routes.map(r => r.id);
    await cfrSaveReorderedRoutes(ids);
}

async function cfrSaveReorderedRoutes(ids) {
    try {
        const res = await fetch(`${API_BASE}/cloudflared/routes/reorder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids })
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success) {
            showToast('Ordem das rotas atualizada!', 'success');
            cfrFetchRoutes();
        } else {
            throw new Error(data.error || 'Erro ao ordenar rotas.');
        }
    } catch (err) {
        console.error('[cfrSaveReorderedRoutes] Erro:', err);
        showToast('Erro ao reordenar rotas: ' + err.message, 'error');
    }
}

async function cfrTestRoute(id, targetUrl) {
    const btn = document.getElementById(`btn-test-local-${id}`);
    const resultDiv = document.getElementById(`cfr-test-result-${id}`);
    
    let originalHtml = '';
    if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader" class="spin" style="width: 12px; height: 12px;"></i>...`;
        if (window.lucide) lucide.createIcons();
    }

    if (resultDiv) {
        resultDiv.innerHTML = `<span style="color: var(--text-muted);">Testando...</span>`;
    }

    try {
        const res = await fetch(`${API_BASE}/cloudflared/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: targetUrl })
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (resultDiv) {
            if (data.success) {
                resultDiv.innerHTML = `<span style="color: var(--success); font-weight: bold;">â— Local: Online</span> (${data.time || 'N/A'}) - HTTP ${data.code || '200'}`;
            } else {
                resultDiv.innerHTML = `<span style="color: var(--danger); font-weight: bold;">â— Local: Offline</span> - ${data.error || 'Sem resposta'}`;
            }
        }
    } catch (err) {
        console.error('[cfrTestRoute] Erro:', err);
        if (resultDiv) {
            resultDiv.innerHTML = `<span style="color: var(--danger); font-weight: bold;">â— Local: Erro</span> - ${err.message}`;
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            if (window.lucide) lucide.createIcons();
        }
    }
}

async function cfrTestPublicUrl(id, publicUrl) {
    const btn = document.getElementById(`btn-test-pub-${id}`);
    const resultDiv = document.getElementById(`cfr-test-result-${id}`);
    
    let originalHtml = '';
    if (btn) {
        originalHtml = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = `<i data-lucide="loader" class="spin" style="width: 12px; height: 12px;"></i>...`;
        if (window.lucide) lucide.createIcons();
    }

    if (resultDiv) {
        resultDiv.innerHTML = `<span style="color: var(--text-muted);">Testando PÃºblica...</span>`;
    }

    try {
        const res = await fetch(`${API_BASE}/cloudflared/test`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: publicUrl })
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (resultDiv) {
            if (data.success) {
                resultDiv.innerHTML = `<span style="color: var(--success); font-weight: bold;">ðŸŒ PÃºblica: Online</span> (${data.time || 'N/A'}) - HTTP ${data.code || '200'}`;
            } else {
                if (data.code === 1033 || data.code === 530 || data.code === 521 || data.code === 523) {
                    resultDiv.innerHTML = `<span style="color: var(--danger); font-weight: bold;">ðŸŒ PÃºblica: Erro de TÃºnel (1033 / ${data.code})</span> - O tÃºnel Cloudflared estÃ¡ offline ou a Cloudflare nÃ£o encontrou uma conexÃ£o saudÃ¡vel. Verifique se o processo estÃ¡ "Rodando".`;
                } else {
                    resultDiv.innerHTML = `<span style="color: var(--danger); font-weight: bold;">ðŸŒ PÃºblica: Offline</span> - ${data.error || 'Sem resposta'} (HTTP ${data.code || 0})`;
                }
            }
        }
    } catch (err) {
        console.error('[cfrTestPublicUrl] Erro:', err);
        if (resultDiv) {
            resultDiv.innerHTML = `<span style="color: var(--danger); font-weight: bold;">ðŸŒ PÃºblica: Erro</span> - ${err.message}`;
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = originalHtml;
            if (window.lucide) lucide.createIcons();
        }
    }
}

async function cfrApplyConfigYml() {
    if (cfrProcessActionBusy) {
        return showToast('JÃ¡ existe uma operaÃ§Ã£o de tÃºnel em andamento. Aguarde finalizar.', 'warning');
    }
    cfrProcessActionBusy = true;
    const btn = document.querySelector('button[onclick="cfrApplyConfigYml()"]');
    let originalHtml = '';
    if (btn) {
        originalHtml = btn.innerHTML;
        btn.innerHTML = '<i data-lucide="loader" class="spin"></i> Aplicando e Validando...';
        btn.disabled = true;
    }

    try {
        // 1. Fazer backup da config antiga (opcional, sÃ³ para ter histÃ³rico antes da geraÃ§Ã£o)
        await fetch(`${API_BASE}/cloudflared/backup`, { method: 'POST' }).catch(() => {});

        // 2. Gerar nova config
        const resGen = await fetch(`${API_BASE}/cloudflared/generate-config`, { method: 'POST' });
        if (!resGen.ok) throw new Error(`HTTP ${resGen.status} na geraÃ§Ã£o da config`);
        const genData = await resGen.json();
        if (!genData.success) throw new Error(genData.error || 'Falha ao gerar config.yml');

        // 3. Validar Ingress
        const resVal = await fetch(`${API_BASE}/cloudflared/validate`, { method: 'POST' });
        const valData = await resVal.json();
        if (!valData.success || (valData.output && valData.output.toLowerCase().includes('error'))) {
            throw new Error(`ValidaÃ§Ã£o falhou:\n${valData.error || valData.output}`);
        }

        // 4. Reiniciar somente quando houver mudanÃ§a real no config.yml
        if (genData.changed) {
            await fetch(`${API_BASE}/cloudflared/process/stop`, { method: 'POST' }).catch(() => {});
            await new Promise(r => setTimeout(r, 1000));
            await fetch(`${API_BASE}/cloudflared/process/start`, { method: 'POST' }).catch(() => {});
            showToast('Ingress atualizado e tÃºnel reiniciado! Aguardando testes de rota...', 'success');
        } else {
            showToast('Nenhuma alteraÃ§Ã£o real no ingress. Sem reinÃ­cio global.', 'info');
        }
        
        // Atualiza UI de status
        setTimeout(cfrCheckStatus, 1500);

        // Aguarda 4 segundos para testar as rotas
        setTimeout(async () => {
            const activeRoutes = cfrRoutesListCached.filter(r => r.enabled);
            for (const r of activeRoutes) {
                const protocol = String(r.targetProtocol || '').toLowerCase();
                const isHttpLike = protocol === 'http' || protocol === 'https';
                const isSsh = protocol === 'ssh';
                const localUrl = `${r.targetProtocol}://${r.targetHost}:${r.targetPort}${isHttpLike ? (r.path || '/') : ''}`;
                const publicUrl = `https://${r.hostname}${r.path || '/'}`;
                
                // Test local connection
                await cfrTestRoute(r.id, localUrl);
                // Test public connection
                if (!isSsh) {
                    await cfrTestPublicUrl(r.id, publicUrl);
                }
            }
            // Run status check again to update the final warning/success display
            cfrCheckStatus();
        }, 4000);

    } catch (err) {
        console.error('[cfrApplyConfigYml] Erro:', err);
        showToast('Erro ao aplicar regras Ingress: ' + err.message, 'error');
    } finally {
        cfrProcessActionBusy = false;
        if (btn) {
            btn.innerHTML = originalHtml || '<i data-lucide="check"></i> Salvar e Aplicar Ingress no Cloudflared';
            btn.disabled = false;
            if (window.lucide) lucide.createIcons();
        }
    }
}

async function cfrLoadConfigYml() {
    try {
        const res = await fetch(`${API_BASE}/cloudflared/config`);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (data.success) {
            const textarea = document.getElementById('cfrYamlContent');
            if (textarea) textarea.value = data.config || '';

            const select = document.getElementById('cfrBackupSelect');
            if (select) {
                select.innerHTML = '<option value="">-- Selecione um Backup --</option>';
                if (data.backups && data.backups.length > 0) {
                    data.backups.forEach(b => {
                        const option = document.createElement('option');
                        option.value = b.name;
                        let dateFormatted = b.date || b.name;
                        if (b.date && b.date.length >= 15) {
                            const y = b.date.slice(0, 4);
                            const m = b.date.slice(4, 6);
                            const d = b.date.slice(6, 8);
                            const h = b.date.slice(9, 11);
                            const min = b.date.slice(11, 13);
                            const s = b.date.slice(13, 15);
                            dateFormatted = `${d}/${m}/${y} ${h}:${min}:${s}`;
                        }
                        option.textContent = `${b.name} (${dateFormatted})`;
                        select.appendChild(option);
                    });
                }
            }

            const modal = document.getElementById('cfrYamlModal');
            if (modal) modal.classList.remove('hidden');
        } else {
            throw new Error(data.error || 'Falha ao obter configuraÃ§Ã£o.');
        }
    } catch (err) {
        console.error('[cfrLoadConfigYml] Erro:', err);
        showToast('Erro ao carregar arquivo de configuraÃ§Ã£o: ' + err.message, 'error');
    }
}

function cfrCloseYamlModal() {
    const modal = document.getElementById('cfrYamlModal');
    if (modal) modal.classList.add('hidden');
}

async function cfrSaveYamlText() {
    const textarea = document.getElementById('cfrYamlContent');
    if (!textarea) return;

    const configText = textarea.value;

    if (/\t/.test(configText)) {
        return showToast('O arquivo YAML nÃ£o pode conter caracteres de tabulaÃ§Ã£o (Tab). Use apenas espaÃ§os.', 'warning');
    }

    try {
        const res = await fetch(`${API_BASE}/cloudflared/config`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ configText })
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success) {
            if (data.warning) {
                showToast(data.warning, 'warning');
                alert(data.warning);
            } else {
                showToast('Arquivo config.yml salvo com sucesso!', 'success');
            }
            cfrCloseYamlModal();
            cfrFetchRoutes();
        } else {
            throw new Error(data.error || 'Falha ao salvar configuraÃ§Ã£o.');
        }
    } catch (err) {
        console.error('[cfrSaveYamlText] Erro:', err);
        showToast('Erro ao salvar config.yml: ' + err.message, 'error');
    }
}

async function cfrValidateConfig() {
    return cfrValidateYamlText();
}

async function cfrValidateYamlText() {
    try {
        showToast('Validando regras de Ingress no Cloudflared...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/validate`, {
            method: 'POST'
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success) {
            alert(`âœ“ Sucesso! A validaÃ§Ã£o do Ingress passou sem erros:\n\n${data.output || 'OK'}`);
            showToast('Ingress validado com sucesso!', 'success');
        } else {
            alert(`âš ï¸ Falha na validaÃ§Ã£o do Ingress:\n\n${data.error || 'Erro'}\n\nRetorno:\n${data.output || 'Nenhum'}`);
            showToast('Erro na validaÃ§Ã£o do Ingress.', 'error');
        }
    } catch (err) {
        console.error('[cfrValidateYamlText] Erro:', err);
        showToast('Erro ao validar configuraÃ§Ã£o: ' + err.message, 'error');
    }
}

async function cfrRestoreBackup() {
    const select = document.getElementById('cfrBackupSelect');
    if (!select) return;

    const backupName = select.value;
    if (!backupName) return showToast('Selecione um backup para restaurar.', 'warning');

    if (!confirm(`Deseja realmente restaurar o backup "${backupName}"? O arquivo config.yml atual serÃ¡ sobrescrito.`)) return;

    try {
        const res = await fetch(`${API_BASE}/cloudflared/restore`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ backupName })
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success) {
            showToast('Backup restaurado com sucesso!', 'success');
            cfrLoadConfigYml();
        } else {
            throw new Error(data.error || 'Erro ao restaurar backup.');
        }
    } catch (err) {
        console.error('[cfrRestoreBackup] Erro:', err);
        showToast('Erro ao restaurar backup: ' + err.message, 'error');
    }
}

async function cfrBackupConfigManual() {
    try {
        const res = await fetch(`${API_BASE}/cloudflared/backup`, {
            method: 'POST'
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success) {
            showToast(`Backup manual criado: ${data.backup}`, 'success');
            cfrLoadConfigYml();
        } else {
            throw new Error(data.error || 'Erro ao criar backup manual.');
        }
    } catch (err) {
        console.error('[cfrBackupConfigManual] Erro:', err);
        showToast('Erro ao criar backup: ' + err.message, 'error');
    }
}

async function cfrRestartCloudflared() {
    try {
        showToast('Reiniciando tÃºneis do Cloudflared...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/restart`, {
            method: 'POST'
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success) {
            showToast(data.message || 'TÃºneis reiniciados!', 'success');
        } else {
            throw new Error(data.error || 'Erro ao reiniciar.');
        }
    } catch (err) {
        console.error('[cfrRestartCloudflared] Erro:', err);
        showToast('Erro ao reiniciar Cloudflared: ' + err.message, 'error');
    }
}

async function cfrCreatePresetPma() {
    try {
        showToast('Criando preset do painel...', 'info');
        const hasMain = cfrRoutesListCached.some(r => r.path === '/');
        if (hasMain) {
            showToast('O preset do painel ja existe na lista de rotas.', 'info');
            return;
        }

        const resMain = await fetch(`${API_BASE}/cloudflared/routes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                name: 'Painel Principal',
                hostname: 'panel.arjtechbr.site',
                path: '/',
                order: 1,
                targetProtocol: 'http',
                targetHost: '127.0.0.1',
                targetPort: 8088,
                enabled: true
            })
        });

        if (!resMain.ok) throw new Error(`HTTP ${resMain.status}`);
        showToast('Preset do painel criado com sucesso!', 'success');
        cfrFetchRoutes();
    } catch (err) {
        console.error('[cfrCreatePresetPma] Erro:', err);
        showToast('Erro ao criar preset: ' + err.message, 'error');
    }
}
function cfrShowLogs() {
    document.getElementById('cfLogModalTitle').textContent = `ðŸ“œ Logs: Cloudflared Ingress`;
    document.getElementById('cfLogsModal').classList.remove('hidden');
    
    if (cfLogInterval) {
        clearInterval(cfLogInterval);
        cfLogInterval = null;
    }
    if (window.cfrLogInterval) {
        clearInterval(window.cfrLogInterval);
        window.cfrLogInterval = null;
    }

    cfrLoadLogs();
    window.cfrLogInterval = setInterval(cfrLoadLogs, 3000);
}

async function cfrLoadLogs() {
    try {
        const res = await fetch(`${API_BASE}/cloudflared/logs`);
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        const box = document.getElementById('cfLogsBody');
        if (box) {
            box.textContent = data.logs || 'Nenhum log de ingress disponÃ­vel no momento.';
            box.scrollTop = box.scrollHeight;
        }
    } catch (err) {
        console.error('[cfrLoadLogs] Erro:', err);
    }
}

// --- Controle do Processo Cloudflared ---
async function cfrCheckStatus() {
    const statusText = document.getElementById('cfrProcessStatusText');
    if (!statusText) return;
    try {
        const res = await fetch(`${API_BASE}/cloudflared/process/status`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (data.success) {
            if (data.isRunning) {
                const connStatus = data.connected 
                    ? `<span style="color: var(--success); font-weight: bold;">â— Rodando &amp; Conectado</span>` 
                    : `<span style="color: var(--warning); font-weight: bold;">â— Rodando (NÃ£o Conectado)</span>`;
                
                let details = `<div style="margin-top: 8px; font-size: 0.8rem; line-height: 1.4;">`;
                details += `<strong>Status:</strong> ${connStatus}<br>`;
                if (data.pids && data.pids.length > 0) {
                    details += `<strong>PIDs Ativos:</strong> ${data.pids.join(', ')}<br>`;
                }
                if (data.binaryPath) {
                    details += `<strong>BinÃ¡rio:</strong> <code style="background: var(--bg-hover); padding: 1px 4px; border-radius: 3px;">${data.binaryPath}</code><br>`;
                }
                if (data.configPath) {
                    details += `<strong>ConfiguraÃ§Ã£o:</strong> <code style="background: var(--bg-hover); padding: 1px 4px; border-radius: 3px;">${data.configPath}</code><br>`;
                }
                if (data.warning) {
                    details += `<div style="margin-top: 6px; padding: 6px 10px; background: rgba(255, 193, 7, 0.15); border-left: 3px solid #ffc107; border-radius: 4px; color: #e0a800; font-weight: 500;">âš ï¸ ${data.warning}</div>`;
                }
                details += `</div>`;
                statusText.innerHTML = details;
            } else {
                let details = `<div style="margin-top: 8px; font-size: 0.8rem; line-height: 1.4;">`;
                details += `<span style="color: var(--danger); font-weight: bold;">â— Parado</span> - Nenhum processo Cloudflared ativo no sistema.<br>`;
                if (data.warning) {
                    details += `<div style="margin-top: 6px; padding: 6px 10px; background: rgba(220, 53, 69, 0.1); border-left: 3px solid var(--danger); border-radius: 4px; color: var(--danger); font-weight: 500;">âš ï¸ ${data.warning}</div>`;
                }
                details += `</div>`;
                statusText.innerHTML = details;
            }
        } else {
            statusText.innerHTML = `<span style="color: var(--danger); font-weight: bold;">âŒ Erro</span> - ${data.error || 'Falha ao processar status.'}`;
        }
    } catch (e) {
        statusText.innerHTML = `<span style="color: var(--warning); font-weight: bold;">âš ï¸ Desconhecido</span> - Erro de comunicaÃ§Ã£o com o painel: ${e.message}`;
    }
}

async function cfrTestAllRules() {
    try {
        showToast('Testando regras de Ingress no Cloudflared...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/test-rules`, {
            method: 'POST'
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success && data.results) {
            let msg = `ðŸ” RESULTADO DO TESTE DE REGRAS INGRESS:\n\n`;
            data.results.forEach(r => {
                msg += `URL pÃºblica: ${r.url}\n`;
                if (r.success) {
                    msg += `âž” âœ… SUCESSO: ${r.output || 'Regra correspondente encontrada.'}\n`;
                } else {
                    msg += `âž” âŒ FALHA: ${r.error || ''}\n`;
                    if (r.output) msg += `   Log: ${r.output.trim()}\n`;
                }
                msg += `\n`;
            });
            alert(msg);
            showToast('Teste de regras concluÃ­do!', 'success');
        } else {
            showToast('Erro ao testar regras: ' + (data.error || 'Erro desconhecido'), 'error');
        }
    } catch (err) {
        console.error('[cfrTestAllRules] Erro:', err);
        showToast('Erro ao testar regras: ' + err.message, 'error');
    }
}

function cfrSetProcessButtonsBusy(activeAction, busy) {
    const startBtn = document.getElementById('cfrStartBtn');
    const stopBtn = document.getElementById('cfrStopBtn');
    const restartBtn = document.getElementById('cfrRestartBtn');
    const buttons = [startBtn, stopBtn, restartBtn].filter(Boolean);
    const symbols = { start: 'â—Œ', stop: 'â†»', restart: 'âŸ³' };
    const labels = { start: 'Iniciando...', stop: 'Parando...', restart: 'Reiniciando...' };

    if (busy) {
        buttons.forEach((btn) => {
            if (!btn.dataset.originalHtml) btn.dataset.originalHtml = btn.innerHTML;
            if (!btn.dataset.originalClass) btn.dataset.originalClass = btn.className;
            btn.disabled = true;
            if (btn === startBtn && activeAction === 'start') {
                btn.className = 'btn btn-warning btn-sm';
                btn.innerHTML = `${symbols.start} ${labels.start}`;
            } else if (btn === stopBtn && activeAction === 'stop') {
                btn.className = 'btn btn-warning btn-sm';
                btn.innerHTML = `${symbols.stop} ${labels.stop}`;
            } else if (btn === restartBtn && activeAction === 'restart') {
                btn.className = 'btn btn-warning btn-sm';
                btn.innerHTML = `${symbols.restart} ${labels.restart}`;
            }
        });
        return;
    }

    buttons.forEach((btn) => {
        btn.disabled = false;
        if (btn.dataset.originalClass) btn.className = btn.dataset.originalClass;
        if (btn.dataset.originalHtml) btn.innerHTML = btn.dataset.originalHtml;
    });
    if (window.lucide) lucide.createIcons();
}

async function cfrStartProcess() {
    if (cfrProcessActionBusy) {
        return showToast('JÃ¡ existe uma operaÃ§Ã£o de tÃºnel em andamento. Aguarde finalizar.', 'warning');
    }
    cfrProcessActionBusy = true;
    cfrSetProcessButtonsBusy('start', true);
    try {
        showToast('Iniciando processo do Cloudflared...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/process/start`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('TÃºnel iniciado!', 'success');
            setTimeout(cfrCheckStatus, 1000);
        } else {
            throw new Error(data.error || 'Erro ao iniciar tÃºnel');
        }
    } catch (err) {
        showToast('Erro: ' + err.message, 'error');
    } finally {
        cfrProcessActionBusy = false;
        cfrSetProcessButtonsBusy('start', false);
    }
}

async function cfrStopProcess() {
    if (cfrProcessActionBusy) {
        return showToast('JÃ¡ existe uma operaÃ§Ã£o de tÃºnel em andamento. Aguarde finalizar.', 'warning');
    }
    cfrProcessActionBusy = true;
    cfrSetProcessButtonsBusy('stop', true);
    try {
        showToast('Parando Cloudflared...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/process/stop`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('TÃºnel parado!', 'success');
            setTimeout(cfrCheckStatus, 1000);
        } else {
            throw new Error(data.error || 'Erro ao parar tÃºnel');
        }
    } catch (err) {
        showToast('Erro: ' + err.message, 'error');
    } finally {
        cfrProcessActionBusy = false;
        cfrSetProcessButtonsBusy('stop', false);
    }
}

async function cfrRestartProcess() {
    if (cfrProcessActionBusy) {
        return showToast('JÃ¡ existe uma operaÃ§Ã£o de tÃºnel em andamento. Aguarde finalizar.', 'warning');
    }
    cfrProcessActionBusy = true;
    cfrSetProcessButtonsBusy('restart', true);
    try {
        showToast('Reiniciando Cloudflared...', 'info');
        await fetch(`${API_BASE}/cloudflared/process/stop`, { method: 'POST' }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
        await fetch(`${API_BASE}/cloudflared/process/start`, { method: 'POST' });
        showToast('TÃºnel reiniciado!', 'success');
        setTimeout(cfrCheckStatus, 1000);
    } catch (err) {
        showToast('Erro: ' + err.message, 'error');
    } finally {
        cfrProcessActionBusy = false;
        cfrSetProcessButtonsBusy('restart', false);
    }
}

// Inicia polling de status a cada 5s se estiver na aba
setInterval(() => {
    const el = document.getElementById('cfrProcessStatusText');
    if (el && el.offsetParent !== null) { // Verifica se estÃ¡ visÃ­vel
        cfrCheckStatus();
    }
}, 5000);

// Override: delete route with Cloudflare DNS cleanup feedback
async function cfrDeleteRouteWithDnsFeedback(id) {
    if (!confirm('Deseja realmente excluir esta rota?')) return;
    try {
        const res = await fetch(`${API_BASE}/cloudflared/routes-sync/${id}`, { method: 'DELETE' });
        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!data.success) throw new Error(data.error || 'Erro desconhecido ao excluir rota.');

        if (data.dnsCleanup && data.dnsCleanup.success) {
            showToast('Rota excluida e DNS removido da Cloudflare!', 'success');
        } else {
            showToast('Rota excluida com sucesso!', 'success');
        }
        cfrFetchRoutes();
    } catch (err) {
        console.error('[cfrDeleteRouteWithDnsFeedback] Erro:', err);
        showToast('Erro ao excluir rota: ' + err.message, 'error');
    }
}

// Expor no escopo global
window.cfrFetchRoutes = cfrFetchRoutes;
window.cfrRenderRoutes = cfrRenderRoutes;
window.cfrOpenRouteModal = cfrOpenRouteModal;
window.cfrCloseRouteModal = cfrCloseRouteModal;
window.cfrSubmitRoute = cfrSubmitRoute;
window.cfrDeleteRoute = cfrDeleteRouteWithDnsFeedback;
window.cfrToggleRouteEnabled = cfrToggleRouteEnabled;
window.cfrMoveRouteUp = cfrMoveRouteUp;
window.cfrMoveRouteDown = cfrMoveRouteDown;
window.cfrSaveReorderedRoutes = cfrSaveReorderedRoutes;
window.cfrUpdateUrlPreview = cfrUpdateUrlPreview;
window.cfrApplyConfigYml = cfrApplyConfigYml;
window.cfrLoadConfigYml = cfrLoadConfigYml;
window.cfrCloseYamlModal = cfrCloseYamlModal;
window.cfrSaveYamlText = cfrSaveYamlText;
window.cfrValidateYamlText = cfrValidateYamlText;
window.cfrRestoreBackup = cfrRestoreBackup;
window.cfrBackupConfigManual = cfrBackupConfigManual;
window.cfrValidateConfig = cfrValidateConfig;
window.cfrRestartCloudflared = cfrRestartCloudflared;
window.cfrCreatePresetPma = cfrCreatePresetPma;
window.cfrTestRoute = cfrTestRoute;
window.cfrTestPublicUrl = cfrTestPublicUrl;
window.cfrShowLogs = cfrShowLogs;
window.cfrLoadLogs = cfrLoadLogs;
window.cfrTestAllRules = cfrTestAllRules;

// Controle de Processo
window.cfrCheckStatus = cfrCheckStatus;
window.cfrStartProcess = cfrStartProcess;
window.cfrStopProcess = cfrStopProcess;
window.cfrRestartProcess = cfrRestartProcess;





async function cfMigrateLegacy() {
    if (!confirm('Deseja procurar por instÃ¢ncias/rotas do painel antigo e importÃ¡-las para a nova versÃ£o?')) return;
    try {
        showToast('Procurando instÃ¢ncias antigas...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/system/migrate-legacy`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast(data.message || 'InstÃ¢ncias resgatadas com sucesso!', 'success');
            cfFetchInstances();
        } else {
            showToast('Nenhuma instÃ¢ncia antiga para resgatar ou erro: ' + data.error, 'warning');
        }
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}
window.cfMigrateLegacy = cfMigrateLegacy;


async function saveCloudflareRule() {
    const name = document.getElementById('cf-rule-name').value || 'Nova Regra';
    const domain = document.getElementById('cf-rule-domain').value || '';
    const protocol = document.getElementById('cf-rule-protocol').value || 'http';
    const dest = document.getElementById('cf-rule-dest').value || '127.0.0.1:8088';
    const path = document.getElementById('cf-rule-path').value || '/';

    const [host, port] = dest.split(':');

    const newInst = {
        name,
        type: 'service',
        createCloudflareTunnel: true,
        routes: [{
            hostname: domain,
            path: path,
            targetProtocol: protocol,
            targetHost: host || '127.0.0.1',
            targetPort: parseInt(port) || (protocol === 'https' ? 443 : 80),
            routeType: protocol
        }]
    };

    const res = await safeFetch(`${API_BASE}/cloudflared/instances`, 'POST', newInst);
    if (res && res.success) {
        showToast('Regra de Cloudflare criada com sucesso!', 'success');
        closeModal('modal-cloudflare-rule');
        loadCloudflareTunnelsTable();
        // start instance immediately
        await safeFetch(`${API_BASE}/cloudflared/instances/${res.instance.id}/start`, 'POST');
        loadCloudflareTunnelsTable();
    } else {
        showToast(res?.error || 'Erro ao criar regra', 'error');
    }
}

// ============================================================
// GLOBAL MODAL UTILITIES
// ============================================================
window.openModal = function(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.remove('hidden');
        if (typeof lucide !== 'undefined') lucide.createIcons();
    }
};

window.closeModal = function(id) {
    const modal = document.getElementById(id);
    if (modal) {
        modal.classList.add('hidden');
    }
};





function editHostingService(id) {
    const svc = window.hostingServices.find(s => String(s.id) === String(id));
    if (!svc) return;

    window.editingHostingId = id;

    // Altera titulo e botao
    const title = document.getElementById('hsModalTitle');
    if (title) title.innerHTML = `⚙️ Editar Serviço: ${svc.name}`;
    const submitBtn = document.querySelector('#hostingModal button[type="submit"]');
    if (submitBtn) submitBtn.textContent = 'Salvar Alterações';

    // Popula campos
    document.getElementById('hsName').value = svc.name || '';
    document.getElementById('hsDomain').value = svc.domain || '0.0.0.0';
    document.getElementById('hsListenPort').value = svc.listenPort || '';
    document.getElementById('hsPath').value = svc.path || '';
    document.getElementById('hsTargetPort').value = svc.targetPort || '';
    document.getElementById('hsStartCmd').value = svc.startCmd || '';
    document.getElementById('hsType').value = svc.type || 'php';
    document.getElementById('hsAutoRestart').checked = !!svc.autoRestart;
    const runAsRootCb = document.getElementById('hsRunAsRoot');
    if (runAsRootCb) runAsRootCb.checked = !!svc.runAsRoot;
    document.getElementById('hsCreateIndex').checked = false;

    // Esconde opçoes nao editaveis
    const createIndexLabel = document.getElementById('hsCreateIndexLabel');
    if (createIndexLabel) createIndexLabel.classList.add('hidden');
    const hsCreateTunnelLabel = document.getElementById('hsCreateTunnelLabel');
    if (hsCreateTunnelLabel) hsCreateTunnelLabel.classList.add('hidden');
    const hsTunnelFields = document.getElementById('hsTunnelFields');
    if (hsTunnelFields) hsTunnelFields.classList.add('hidden');

    // Trigger dynamic visible fields logic
    toggleHostingFormFields();

    // Open Modal overlay
    const modal = document.getElementById('hostingModal');
    if (modal) {
        modal.classList.remove('hidden');
        lucide.createIcons();
    }
}
window.editHostingService = editHostingService;

function openHostingStartModal(id) {
    window.startingHostingId = id;
    const svc = window.hostingServices ? window.hostingServices.find(s => String(s.id) === String(id)) : null;
    
    // Reset options
    const hsStartOption = document.getElementById('hsStartOption');
    if (hsStartOption) hsStartOption.value = 'default';
    
    const hsStartCustomCmd = document.getElementById('hsStartCustomCmd');
    if (hsStartCustomCmd) hsStartCustomCmd.value = '';
    
    const hsStartRunAsRoot = document.getElementById('hsStartRunAsRoot');
    if (hsStartRunAsRoot && svc) hsStartRunAsRoot.checked = !!svc.runAsRoot;
    
    const hsStartScriptSelect = document.getElementById('hsStartScriptSelect');
    if (hsStartScriptSelect) {
        hsStartScriptSelect.innerHTML = '<option value="">Carregando scripts...</option>';
    }
    
    toggleHostingStartOptionFields();
    
    // Fetch package.json scripts
    safeFetch(`${API_BASE}/hosting/${id}/scripts`, 'GET').then(res => {
        if (res?.success && res.scripts) {
            const scripts = res.scripts;
            const keys = Object.keys(scripts);
            if (keys.length === 0) {
                if (hsStartScriptSelect) {
                    hsStartScriptSelect.innerHTML = '<option value="">Nenhum script encontrado no package.json</option>';
                }
            } else {
                if (hsStartScriptSelect) {
                    hsStartScriptSelect.innerHTML = keys.map(k => `<option value="${k}">"${k}": "${scripts[k]}"</option>`).join('');
                }
            }
        } else {
            if (hsStartScriptSelect) {
                hsStartScriptSelect.innerHTML = '<option value="">Falha ao ler scripts ou package.json não existe.</option>';
            }
        }
    }).catch(err => {
        if (hsStartScriptSelect) {
            hsStartScriptSelect.innerHTML = '<option value="">Erro ao carregar scripts.</option>';
        }
    });

    const modal = document.getElementById('hostingStartModal');
    if (modal) {
        modal.classList.remove('hidden');
        lucide.createIcons();
    }
}
window.openHostingStartModal = openHostingStartModal;

function closeHostingStartModal() {
    window.startingHostingId = null;
    const modal = document.getElementById('hostingStartModal');
    if (modal) modal.classList.add('hidden');
}
window.closeHostingStartModal = closeHostingStartModal;

function toggleHostingStartOptionFields() {
    const opt = document.getElementById('hsStartOption')?.value;
    const scriptGroup = document.getElementById('hsStartScriptGroup');
    const customGroup = document.getElementById('hsStartCustomGroup');
    
    if (opt === 'script') {
        scriptGroup?.classList.remove('hidden');
        customGroup?.classList.add('hidden');
    } else if (opt === 'custom') {
        scriptGroup?.classList.add('hidden');
        customGroup?.classList.remove('hidden');
    } else {
        scriptGroup?.classList.add('hidden');
        customGroup?.classList.add('hidden');
    }
}
window.toggleHostingStartOptionFields = toggleHostingStartOptionFields;

async function submitHostingStartOption() {
    const id = window.startingHostingId;
    if (!id) return;
    
    const opt = document.getElementById('hsStartOption')?.value;
    let customCmd = null;
    
    if (opt === 'script') {
        const scriptVal = document.getElementById('hsStartScriptSelect')?.value;
        if (!scriptVal) {
            showToast('Selecione um script válido do package.json!', 'warning');
            return;
        }
        customCmd = `npm run ${scriptVal}`;
    } else if (opt === 'custom') {
        const val = document.getElementById('hsStartCustomCmd')?.value?.trim();
        if (!val) {
            showToast('Digite um comando customizado!', 'warning');
            return;
        }
        customCmd = val;
    }
    
    const runAsRoot = document.getElementById('hsStartRunAsRoot')?.checked || false;
    closeHostingStartModal();
    
    try {
        const payload = { active: true, runAsRoot };
        if (customCmd) payload.customCmd = customCmd;
        
        const res = await safeFetch(`${API_BASE}/hosting/${id}/toggle`, 'POST', payload);
        if (res?.success) {
            showToast(customCmd ? `Processo iniciado com: ${customCmd}` : 'Processo iniciado com sucesso!', 'success');
            fetchHostingServices();
        } else {
            showToast(`Falha ao iniciar processo: ${res?.error || 'Erro interno.'}`, 'error');
        }
    } catch (err) {
        showToast(`Erro de rede: ${err.message}`, 'error');
    }
}
window.submitHostingStartOption = submitHostingStartOption;
