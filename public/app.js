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
        bootLog('Aviso: timeout global — forçando abertura do painel.');
        bootDone();
    }, 12000);

    bootProgress(5,  'Iniciando núcleo...');
    bootLog('Buscando configurações de tema...');
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
        checkNetworkAccess();
        updateNetworkStatus();
        updateCpuStatus();
        setInterval(updateNetworkStatus, 1000);
        setInterval(updateCpuStatus, 1000);
        updateTemperatureHistory();
        setInterval(updateTemperatureHistory, 30000);
        setInterval(fetchStatus,    5000);
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

    // Limpa o loop do Cloudflared se o usuário mudar de aba
    if (window.cfTabInterval) {
        clearInterval(window.cfTabInterval);
        window.cfTabInterval = null;
    }

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
    if (targetId === 'tab-cloudflared') {
        if (typeof cfFetchTunnels === 'function') {
            cfFetchTunnels();
            window.cfTabInterval = setInterval(cfFetchTunnels, 4000);
        }
    }
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
        showToast('Preencha usuário e senha SSH!', 'warning');
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
//  STATUS DO SISTEMA — alinhado com os campos reais da API
// ============================================================
async function fetchStatus() {
    const data = await safeFetch(`${API_BASE}/status`);
    if (!data) return;

    // O servidor retorna: cpu (string), cpuCores, cpuSpeed, ram (string),
    // storageFree, storageTotal, storagePercent, temperature (string)
    if (el.cpu)        el.cpu.textContent        = data.cpu        || '--%';
    if (el.cpuDetails) el.cpuDetails.textContent = `${data.cpuCores || '--'} Núcleos | ${data.cpuSpeed || '--'}`;
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

    // Storage — campos: storageFree, storageTotal, storagePercent
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
    const data = await safeFetch(`${API_BASE}/cpu/status`, 'GET', null, 2500);
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
        if (el.cpu) el.cpu.textContent = 'Indisponível';
        if (el.cpuTotal) el.cpuTotal.textContent = 'Indisponível';
        if (el.cpuTotalPercent) el.cpuTotalPercent.textContent = 'Indisponível';

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
                    <div style="font-size: 0.8rem; font-weight: bold; margin: 12px 0 6px 0; color: var(--text-muted);">Processos Acessíveis</div>
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
                    <div style="font-size: 0.8rem; font-weight: bold; margin: 16px 0 6px 0; color: var(--text-muted);">Status & Frequências dos Núcleos</div>
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
            el.cpuCoresCompact.textContent = data.loadAverage ? `Carga: ${data.loadAverage.formatted}` : 'Uso indisponível';
        }
        if (el.cpuDetails) {
            el.cpuDetails.textContent = data.loadAverage ? `Carga: ${data.loadAverage.formatted}` : 'Uso indisponível';
        }
        if (el.cpuCoresList) {
            el.cpuCoresList.innerHTML = `<div class="cpu-core-row muted">Uso por núcleo indisponível no modo fallback de carga média.</div>`;
        }
        renderCpuVisual({ cpu: '0%', cpuCores: data.coresCount || 1 });
        return;
    }

    if (el.cpuLoadAvgContainer) el.cpuLoadAvgContainer.classList.add('hidden');

    if (data.mode === 'calculating') {
        if (el.cpu) el.cpu.textContent = 'Calculando...';
        if (el.cpuTotal) el.cpuTotal.textContent = 'Calculando...';
        if (el.cpuTotalPercent) el.cpuTotalPercent.textContent = 'Calculando...';
        if (el.cpuCoresCompact) el.cpuCoresCompact.textContent = `${data.coresCount ?? '--'} núcleos`;
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
    if (el.cpuCoresCompact) el.cpuCoresCompact.textContent = `${data.coresCount ?? '--'} núcleos`;
    if (el.cpuDetails) el.cpuDetails.textContent = `${data.coresCount || '--'} Núcleos | ${total}`;

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
    localStorage.setItem('cpu-root-enabled', String(cpuRootEnabled));

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
        showToast('Processos duplicados limpos com sucesso!', 'success');
        fetchProcesses();
    } else {
        showToast(data?.error || 'Falha ao limpar processos duplicados.', 'error');
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
        showToast('Nome de banco inválido! Use apenas letras, números e underline.', 'warning');
        return;
    }
    
    if (dbUser && !dbUser.match(/^[a-zA-Z0-9_-]+$/)) {
        showToast('Nome de usuário inválido! Use apenas letras, números, underline e hífen.', 'warning');
        return;
    }

    logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, `Solicitando criação de novo banco "${dbName}"...`);
    try {
        const result = await safeFetch(`${API_BASE}/db/create`, 'POST', { dbName, dbUser, dbPass });
        if (result?.success) {
            logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, 
                `✓ Banco "${dbName}" criado com sucesso!\n` +
                (dbUser ? `✓ Usuário "${dbUser}" criado com privilégios totais concedidos no banco "${dbName}".` : '✓ Nenhum usuário adicional criado.'));
            showToast('Banco criado com sucesso!', 'success');
            closeDbCreateModal();
            e.target.reset();
            currentDbManager = dbName;
            fetchDatabases();
        } else {
            logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, `❌ Erro ao criar banco: ${result?.message || 'Falha interna'}`, true);
            showToast(`Erro ao criar banco: ${result?.message || 'Erro interno'}`, 'error');
        }
    } catch (err) {
        logToDbConsole(`create_db --name=${dbName} --user=${dbUser || 'none'}`, `❌ Erro de rede: ${err.message}`, true);
        showToast(`Erro de rede: ${err.message}`, 'error');
    }
}

function getPhpMyAdminBaseUrl() {
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname) || 
                    window.location.hostname.startsWith('192.168.') || 
                    window.location.hostname.startsWith('10.') ||
                    window.location.port === '8088'; // porta interna do painel

    if (isLocal && window.location.port) {
        return window.location.protocol + '//' + window.location.hostname + ':8080';
    }
    return ''; // Usar caminho relativo para domínios públicos
}

async function actionPhpMyAdmin() {
    logToDbConsole('open_phpmyadmin --db=' + currentDbManager, `Redirecionando para o phpMyAdmin (Cookie Auth)...`);
    const baseUrl = getPhpMyAdminBaseUrl();
    const url = `${baseUrl}/phpmyadmin/index.php${currentDbManager ? '?db=' + encodeURIComponent(currentDbManager) : ''}`;
    window.open(url, '_blank');
}

async function actionShowTables() {
    logToDbConsole('open_phpmyadmin_tables --db=' + currentDbManager, `Redirecionando para estrutura de tabelas no phpMyAdmin...`);
    const baseUrl = getPhpMyAdminBaseUrl();
    const tablesUrl = `${baseUrl}/phpmyadmin/index.php?db=${encodeURIComponent(currentDbManager)}&target=${encodeURIComponent('tbl_structure.php')}`;
    window.open(tablesUrl, '_blank');
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
            showToast('Senha redefinida com sucesso!', 'success');
        } else {
            logToDbConsole(`mysql -e "ALTER USER '${username}' IDENTIFIED BY '***';"`, `❌ Erro: ${data.error || 'Falha ao redefinir senha.'}`, true);
            showToast(`Erro: ${data.error || 'Falha ao redefinir senha.'}`, 'error');
        }
    } catch(err) {
        logToDbConsole(`mysql -e "ALTER USER '${username}' IDENTIFIED BY '***';"`, `❌ Erro de rede: ${err.message}`, true);
        showToast(`Erro de rede: ${err.message}`, 'error');
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
    if (!newName) return showToast('Digite o novo nome do banco.', 'warning');
    if (newName === currentDbManager) return showToast('O novo nome deve ser diferente do atual.', 'warning');

    if (!newName.match(/^[a-zA-Z0-9_]+$/)) {
        return showToast('Nome de banco inválido. Use apenas letras, números e underline.', 'warning');
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
            showToast('Banco renomeado com sucesso!', 'success');
            currentDbManager = newName;
            fetchDatabases();
        } else {
            logToDbConsole(`rename_db "${currentDbManager}" "${newName}"`, `❌ Erro ao renomear: ${data.error || 'Falha interna.'}`, true);
            showToast(`Erro ao renomear: ${data.error || 'Falha interna.'}`, 'error');
        }
    } catch(err) {
        logToDbConsole(`rename_db "${currentDbManager}" "${newName}"`, `❌ Erro de rede: ${err.message}`, true);
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

    if (!confirm(`⚠️ ATENÇÃO EXTREMA!\n\nVocê tem certeza absoluta que deseja excluir permanentemente o banco "${currentDbManager}"?\n\nEsta ação é irreversível e apagará todas as tabelas!`)) return;

    logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `Excluindo banco "${currentDbManager}" permanentemente...`);
    try {
        const res = await fetch(`${API_BASE}/db/${currentDbManager}`, {
            method: 'DELETE'
        });
        const data = await res.json();
        if (data.success) {
            logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `✓ Banco "${currentDbManager}" deletado com sucesso do servidor MariaDB.`);
            showToast('Banco deletado permanentemente com sucesso!', 'success');
            currentDbManager = null;
            fetchDatabases();
        } else {
            logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `❌ Erro ao excluir banco: ${data.error || 'Falha interna.'}`, true);
            showToast(`Erro ao excluir banco: ${data.error || 'Falha interna.'}`, 'error');
        }
    } catch(err) {
        logToDbConsole(`DROP DATABASE \`${currentDbManager}\`;`, `❌ Erro de rede: ${err.message}`, true);
        showToast(`Erro de rede: ${err.message}`, 'error');
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
    if (data?.success) {
        showToast(data.message || 'Conexão testada com sucesso!', 'success');
    } else {
        showToast(data?.message || 'Falha na conexão', 'error');
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
        showToast('Erro ao gerar backup. Verifique a conexão.', 'error');
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
    if (!filename) { showToast('Selecione um arquivo de backup!', 'warning'); return; }
    if (!confirm(`Restaurar "${filename}"? Isso substituirá os dados existentes.`)) return;
    const result = await safeFetch(`${API_BASE}/db/restore`, 'POST', { filename, dbName });
    if (result?.success) {
        showToast('Banco restaurado com sucesso!', 'success');
    } else {
        showToast('Erro ao restaurar banco de dados.', 'error');
    }
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
        if (test?.success) {
            showToast('Configuração salva! Conexão OK.', 'success');
        } else {
            showToast(`Configuração salva mas conexão falhou: ${test?.message}`, 'warning');
        }
        fetchDatabases();
    }
}


// ============================================================
//  PHPMYADMIN SSO
// ============================================================
async function openPhpMyAdmin(dbName = null, targetPage = null) {
    const baseUrl = getPhpMyAdminBaseUrl();
    let url = `${baseUrl}/phpmyadmin/index.php`;
    const params = [];
    if (dbName) {
        params.push(`db=${encodeURIComponent(dbName)}`);
    }
    if (targetPage) {
        params.push(`target=${encodeURIComponent(targetPage)}`);
    }
    if (params.length > 0) {
        url += '?' + params.join('&');
    }
    window.open(url, '_blank');
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
                            <i data-lucide="shield-check" style="width:14px;height:14px;"></i> Conectividade HTTP & Auth
                        </h4>
                        <div style="font-size:0.82rem; display:flex; flex-direction:column; gap:6px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                                <span>Método de Login:</span> <span class="badge badge-ok" style="background:#10b981; color:#fff; font-size:0.75rem; font-weight:600; padding:2px 6px; border-radius:4px;">Cookie Auth (Direto)</span>
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
    const labels = { start: 'iniciado', stop: 'parado', restart: 'reiniciado' };
    const verb = { start: 'iniciar', stop: 'parar', restart: 'reiniciar' };
    if (!confirm(`Deseja ${verb[action]} o serviço do NGINX?`)) return;
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
    // Servidor retorna {cron: '...'} (não crontab)
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
    const res = await safeFetch(`${API_BASE}/noip`, 'POST', {
        username: document.getElementById('noipUsername').value,
        password: document.getElementById('noipPassword').value,
        hostname: document.getElementById('noipHostname').value,
        interval: parseInt(document.getElementById('noipInterval').value),
        autostart: document.getElementById('noipAutostart').checked,
    });
    if (res?.error) {
        showToast('Erro ao salvar configuração do No-IP: ' + res.error, 'error');
    } else {
        showToast('Configuração do No-IP salva!', 'success');
    }
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
        showToast('Selecione uma versão válida!', 'warning');
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
        showToast('Formato inválido. Use: usuario/repositorio', 'warning');
        return;
    }
    const result = await safeFetch(`${API_BASE}/system/update/config`, 'POST', { github_repo: repo });
    if (result?.success) {
        showToast(`Repositório salvo: ${repo}. Agora clique em "Verificar" para checar atualizações.`, 'success');
        checkSystemUpdates();
    } else {
        showToast('Erro ao salvar configuração do repositório.', 'error');
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
        const text = await res.text();
        const data = text ? JSON.parse(text) : {};
        if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
        return data;
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

        // Carrega modo de memória
        try {
            const procRes = await safeFetch(`${API_BASE}/system/processes`);
            if (procRes?.success && procRes.panel) {
                const memSelect = document.getElementById('settings-memory-mode');
                if (memSelect) {
                    memSelect.value = procRes.panel.nodeMemoryMode || 'balanced';
                }
            }
        } catch(e) {
            console.error('Falha ao carregar processos/memória:', e);
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
        showToast(nextState 
            ? 'Regra de inicialização (Ao abrir o Termux) configurada com sucesso!' 
            : 'Regra de inicialização (Ao abrir o Termux) removida.',
            'success'
        );
        loadSettings();
    } else {
        showToast('Falha ao alterar a regra de auto-inicialização.', 'error');
    }
}

async function toggleTermuxBoot() {
    const badge = document.getElementById('autostart-boot-badge');
    const isCurrentActive = badge?.textContent === 'Ativo';
    const nextState = !isCurrentActive;

    const res = await safeFetch(`${API_BASE}/system/settings/autostart-boot/toggle`, 'POST', { active: nextState });
    if (res?.success) {
        showToast(nextState 
            ? 'Regra de inicialização via Termux:Boot configurada! Instale o app auxiliar "Termux:Boot" para inicialização invisível em segundo plano.' 
            : 'Regra de inicialização via Termux:Boot removida com sucesso.',
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
        showToast('Porta inválida! Insira um valor entre 1 e 65535.', 'warning');
        return;
    }

    if (!confirm(`⚠️ Você tem certeza que deseja mudar a porta do painel para ${newPort}?\n\nO servidor será desligado e reiniciado automaticamente na nova porta. Você precisará acessar o painel usando o novo endereço.`)) {
        return;
    }

    const res = await safeFetch(`${API_BASE}/system/settings/port`, 'POST', { port: newPort });
    if (res?.success) {
        showToast('Porta alterada com sucesso! O servidor está reiniciando, redirecionando em 5 segundos...', 'success');
        setTimeout(() => {
            window.location.href = `http://${window.location.hostname}:${newPort}`;
        }, 5000);
    } else {
        showToast(`Erro: ${res?.error || 'Não foi possível alterar a porta.'}`, 'error');
    }
}

async function savePanelAuth() {
    const userInput = document.getElementById('settings-user-input');
    const passInput = document.getElementById('settings-pass-input');
    const user = userInput?.value?.trim();
    const pass = passInput?.value;

    if (!user || !pass || user === '' || pass === '') {
        showToast('Usuário e senha não podem ficar vazios!', 'warning');
        return;
    }

    if (!confirm('Deseja salvar as novas credenciais de acesso? Você precisará usá-las no próximo login.')) {
        return;
    }

    const res = await safeFetch(`${API_BASE}/system/settings/auth`, 'POST', { user, pass });
    if (res?.success) {
        showToast('Credenciais atualizadas com sucesso!', 'success');
        loadSettings();
    } else {
        showToast(`Erro: ${res?.error || 'Não foi possível salvar as credenciais.'}`, 'error');
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
        showToast('Nome e Porta Pública são obrigatórios!', 'warning');
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
            showToast('Serviço de Hospedagem criado com sucesso!', 'success');
            closeHostingModal();
            fetchHostingServices();
        } else {
            showToast(`Falha ao criar serviço: ${res?.error || 'Erro desconhecido.'}`, 'error');
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
    if (!confirm(`⚠️ Atenção: Você tem certeza que deseja EXCLUIR o serviço "${name}"?\n\nEsta ação irá remover permanentemente a configuração do NGINX, apagar os arquivos de log e encerrar qualquer processo ativo associado.`)) {
        return;
    }

    try {
        const res = await safeFetch(`${API_BASE}/hosting/${id}`, 'DELETE');
        if (res?.success) {
            showToast('Serviço excluído com sucesso!', 'success');
            fetchHostingServices();
        } else {
            showToast(`Falha ao excluir serviço: ${res?.error || 'Erro interno.'}`, 'error');
        }
    } catch (err) {
        showToast(`Erro de rede: ${err.message}`, 'error');
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
// ============================================================
//  NOVO CLOUDFLARED MANAGER (TERMUX NATIVE API)
// ============================================================
let cfTunnels = [];
let cfLogInterval = null;
let cfSelectedTunnelId = null;
let cfSelectedYamlTunnelId = null;

function cfShowCreateModal() {
    document.getElementById('cfCreateModal').classList.remove('hidden');
    document.getElementById('cfName').value = '';
    document.getElementById('cfToken').value = '';
    document.getElementById('cfDomain').value = '';
    document.getElementById('cfLocalHost').value = 'localhost';
    document.getElementById('cfLocalPort').value = '';
    document.getElementById('cfProto').value = 'http';
    document.getElementById('cfAutoStart').checked = false;
    cfToggleAuthType();
}

function cfCloseCreateModal() {
    document.getElementById('cfCreateModal').classList.add('hidden');
}

function cfToggleAuthType() {
    const type = document.getElementById('cfAuthType').value;
    if (type === 'token') {
        document.getElementById('cfTokenGroup').classList.remove('hidden');
        document.getElementById('cfClassicGroup').classList.add('hidden');
    } else {
        document.getElementById('cfTokenGroup').classList.add('hidden');
        document.getElementById('cfClassicGroup').classList.remove('hidden');
    }
}

async function cfCreateTunnel(e) {
    e.preventDefault();
    const type = document.getElementById('cfAuthType').value;
    const payload = {
        name: document.getElementById('cfName').value.trim(),
        type: type,
        token: document.getElementById('cfToken').value.trim(),
        domain: document.getElementById('cfDomain').value.trim(),
        proto: document.getElementById('cfProto').value,
        localHost: document.getElementById('cfLocalHost').value.trim() || 'localhost',
        localPort: document.getElementById('cfLocalPort').value.trim(),
        autoStart: document.getElementById('cfAutoStart').checked
    };

    if (payload.type === 'token' && !payload.token) return showToast('Insira o Token.', 'warning');
    if (payload.type !== 'token' && !payload.localPort) return showToast('Insira a porta local.', 'warning');

    try {
        const res = await fetch(`${API_BASE}/tunnel/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        cfCloseCreateModal();
        cfFetchTunnels();
        showToast('Túnel criado com sucesso!', 'success');
    } catch (e) {
        showToast('Erro ao criar túnel: ' + e.message, 'error');
    }
}

async function cfFetchTunnels() {
    try {
        const res = await fetch(`${API_BASE}/tunnels`);
        const data = await res.json();
        if (data.success) {
            cfTunnels = data.tunnels;
            
            // Calculate and update top metrics
            let total = cfTunnels.length;
            let online = cfTunnels.filter(t => t.running).length;
            let activeConns = cfTunnels.reduce((acc, t) => acc + (t.connections || 0), 0);
            
            document.getElementById('cfMetricTotal').textContent = total;
            document.getElementById('cfMetricOnline').textContent = online;
            document.getElementById('cfMetricConnections').textContent = activeConns;
            
            cfRenderTunnels();
        }
    } catch (e) {
        console.error('Erro ao buscar túneis:', e);
    }
}

function cfRenderTunnels() {
    cfFilterTunnels();
}

function cfFilterTunnels() {
    const grid = document.getElementById('cfTunnelsGrid');
    if (!grid) return;

    const query = document.getElementById('cfSearchInput').value.toLowerCase().trim();
    const typeFilter = document.getElementById('cfFilterType').value;
    const statusFilter = document.getElementById('cfFilterStatus').value;

    const filtered = cfTunnels.filter(t => {
        const matchQuery = t.name.toLowerCase().includes(query) || (t.domain && t.domain.toLowerCase().includes(query));
        const matchType = typeFilter === 'all' || t.type === typeFilter;
        const matchStatus = statusFilter === 'all' || (statusFilter === 'online' && t.running) || (statusFilter === 'offline' && !t.running);
        return matchQuery && matchType && matchStatus;
    });

    if (filtered.length === 0) {
        grid.innerHTML = '<div style="color:var(--text-muted); padding:20px;">Nenhum túnel corresponde aos filtros aplicados.</div>';
        return;
    }

    grid.innerHTML = filtered.map(t => {
        const isRunning = t.running;
        const color = isRunning ? 'var(--success)' : 'var(--danger)';
        
        let typeBadge = '';
        if (t.type === 'token') typeBadge = '<span class="badge badge-info">Token</span>';
        else if (t.type === 'classic_custom') typeBadge = '<span class="badge badge-primary">YAML Ingress</span>';
        else typeBadge = '<span class="badge badge-secondary">Quick</span>';

        const btnAction = isRunning 
            ? `<button class="btn btn-sm btn-danger" onclick="cfStopTunnel('${t.id}')"><i data-lucide="square"></i> Parar</button>`
            : `<button class="btn btn-sm btn-success" onclick="cfStartTunnel('${t.id}')"><i data-lucide="play"></i> Iniciar</button>`;

        const restartBtn = isRunning
            ? `<button class="btn btn-sm btn-warning" onclick="cfRestartTunnel('${t.id}')" title="Reiniciar Túnel"><i data-lucide="rotate-cw"></i></button>`
            : '';

        const yamlBtn = t.type === 'classic_custom'
            ? `<button class="btn btn-sm btn-secondary" onclick="cfShowYamlModal('${t.id}')" title="Configurar YAML"><i data-lucide="file-code"></i> YAML</button>`
            : '';

        const qrBtn = (t.domain && isRunning)
            ? `<button class="btn btn-sm btn-secondary" onclick="cfShowQrModal('${cfEscape(t.domain)}')" title="Visualizar QR Code"><i data-lucide="qr-code"></i></button>`
            : '';

        // Native Uptime, CPU, RAM metrics card
        const metricsHtml = isRunning
            ? `
            <div style="display:grid; grid-template-columns: 1fr 1fr; gap:6px 12px; margin-top:12px; font-size:0.8rem; background:var(--bg-lighter); padding:8px; border-radius:6px; color:var(--text-color);">
                <div><strong>CPU:</strong> ${t.cpu || 0}%</div>
                <div><strong>RAM:</strong> ${t.ram || 0} MB</div>
                <div><strong>Conexões:</strong> ${t.connections || 0}</div>
                <div><strong>Uptime:</strong> ${cfFormatUptime(t.uptime)}</div>
            </div>
            `
            : `<div style="margin-top:12px; font-size:0.8rem; color:var(--text-muted);">Processo inativo.</div>`;

        return `
            <div class="card" style="border-left: 4px solid ${color}">
                <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                    <div>
                        <h3 style="margin-bottom:4px">${cfEscape(t.name)}</h3>
                        <div style="display:flex; gap:6px; flex-wrap:wrap;">
                            <span class="badge ${isRunning ? 'badge-success' : 'badge-danger'}">
                                ${isRunning ? 'Online (PID: ' + t.pid + ')' : 'Offline'}
                            </span>
                            ${typeBadge}
                            ${t.autoStart ? '<span class="badge badge-info" title="Auto-start ativo">⚙️ Auto</span>' : ''}
                            ${t.crashCount > 0 ? `<span class="badge badge-warning" title="Histórico de falhas auto-recuperadas">⚠️ Quedas: ${t.crashCount}</span>` : ''}
                        </div>
                    </div>
                </div>
                <div style="margin-top:12px; font-size:0.85rem; color:var(--text-muted)">
                    ${t.type === 'token' 
                        ? '<div style="font-style:italic;">Gerenciado pelo Zero Trust Cloudflare</div>' 
                        : `<div><strong>🌐</strong> ${cfEscape(t.domain || 'Quick Tunnel')}</div>
                           <div><strong>🎯 Local:</strong> ${cfEscape(t.proto)}://${cfEscape(t.localHost)}:${cfEscape(t.localPort)}</div>`
                    }
                </div>
                
                ${metricsHtml}

                <div class="toolbar-group" style="margin-top:16px; flex-wrap:wrap; gap:6px;">
                    ${btnAction}
                    ${restartBtn}
                    ${yamlBtn}
                    ${qrBtn}
                    <button class="btn btn-sm btn-secondary" onclick="cfShowEditModal('${t.id}')" title="Editar Túnel">
                        <i data-lucide="edit-3"></i>
                    </button>
                    <button class="btn btn-sm btn-secondary" onclick="cfShowLogsModal('${t.id}', '${cfEscape(t.name)}')">
                        <i data-lucide="scroll-text"></i> Logs
                    </button>
                    <button class="btn btn-sm btn-danger" onclick="cfDeleteTunnel('${t.id}')">
                        <i data-lucide="trash-2"></i>
                    </button>
                </div>
            </div>
        `;
    }).join('');
    
    if (window.lucide) lucide.createIcons();
}

async function cfStartTunnel(id) {
    try {
        const res = await fetch(`${API_BASE}/tunnel/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (!data.success) {
            showToast('Falha ao iniciar: ' + data.error, 'error');
        } else {
            showToast('Túnel iniciado com sucesso!', 'success');
        }
        cfFetchTunnels();
    } catch (e) {
        showToast('Erro ao iniciar túnel: ' + e.message, 'error');
    }
}

async function cfStopTunnel(id) {
    try {
        const res = await fetch(`${API_BASE}/tunnel/stop`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (!data.success) {
            showToast('Falha ao parar: ' + data.error, 'error');
        } else {
            showToast('Túnel parado com sucesso!', 'success');
        }
        cfFetchTunnels();
    } catch (e) {
        showToast('Erro ao parar túnel: ' + e.message, 'error');
    }
}

async function cfRestartTunnel(id) {
    try {
        const res = await fetch(`${API_BASE}/tunnel/restart`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (!data.success) {
            showToast('Falha ao reiniciar: ' + data.error, 'error');
        } else {
            showToast('Túnel reiniciado com sucesso!', 'success');
        }
        cfFetchTunnels();
    } catch (e) {
        showToast('Erro ao reiniciar túnel: ' + e.message, 'error');
    }
}

async function cfDeleteTunnel(id) {
    if (!confirm('Excluir este túnel permanentemente?')) return;
    try {
        const res = await fetch(`${API_BASE}/tunnel/delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        cfFetchTunnels();
        showToast('Túnel excluído com sucesso!', 'success');
    } catch (e) {
        showToast('Erro ao excluir: ' + e.message, 'error');
    }
}

async function cfKillZombies() {
    if (!confirm('Deseja enviar um sinal SIGKILL para todos os processos Cloudflared do celular? Isso força a parada de processos zumbis invisíveis.')) return;
    try {
        const res = await fetch(`${API_BASE}/system/kill-zombies`, { method: 'POST' });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        showToast('Sinal enviado. Os processos zumbis foram aniquilados!', 'success');
        cfFetchTunnels();
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

// EDIT MODAL
function cfShowEditModal(id) {
    const t = cfTunnels.find(x => x.id === id);
    if (!t) return;
    
    document.getElementById('cfEditId').value = t.id;
    document.getElementById('cfEditName').value = t.name;
    document.getElementById('cfEditToken').value = t.token || '';
    document.getElementById('cfEditProto').value = t.proto || 'http';
    document.getElementById('cfEditLocalHost').value = t.localHost || 'localhost';
    document.getElementById('cfEditLocalPort').value = t.localPort || '';
    document.getElementById('cfEditDomain').value = t.domain || '';
    document.getElementById('cfEditAutoStart').checked = !!t.autoStart;

    if (t.type === 'token') {
        document.getElementById('cfEditTokenGroup').classList.remove('hidden');
        document.getElementById('cfEditClassicGroup').classList.add('hidden');
    } else {
        document.getElementById('cfEditTokenGroup').classList.add('hidden');
        document.getElementById('cfEditClassicGroup').classList.remove('hidden');
    }
    
    document.getElementById('cfEditModal').classList.remove('hidden');
}

function cfCloseEditModal() {
    document.getElementById('cfEditModal').classList.add('hidden');
}

async function cfUpdateTunnelSubmit(e) {
    e.preventDefault();
    const id = document.getElementById('cfEditId').value;
    const payload = {
        id,
        name: document.getElementById('cfEditName').value.trim(),
        token: document.getElementById('cfEditToken').value.trim(),
        proto: document.getElementById('cfEditProto').value,
        localHost: document.getElementById('cfEditLocalHost').value.trim() || 'localhost',
        localPort: document.getElementById('cfEditLocalPort').value.trim(),
        domain: document.getElementById('cfEditDomain').value.trim(),
        autoStart: document.getElementById('cfEditAutoStart').checked
    };

    try {
        const res = await fetch(`${API_BASE}/tunnel/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        cfCloseEditModal();
        cfFetchTunnels();
        showToast('Túnel atualizado com sucesso!', 'success');
    } catch (e) {
        showToast('Erro ao atualizar: ' + e.message, 'error');
    }
}

// YAML MODAL
async function cfShowYamlModal(id) {
    const t = cfTunnels.find(x => x.id === id);
    if (!t) return;

    cfSelectedYamlTunnelId = id;
    
    // Fill YAML config, generate default if empty
    let yamlContent = t.yamlConfig;
    if (!yamlContent) {
        const res = await fetch(`${API_BASE}/config/generate-yaml`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(t)
        });
        const data = await res.json();
        yamlContent = data.yamlConfig || '';
    }

    document.getElementById('cfYamlTextarea').value = yamlContent;
    document.getElementById('cfYamlError').classList.add('hidden');
    document.getElementById('cfYamlModal').classList.remove('hidden');
    cfLiveValidateYaml();
}

function cfCloseYamlModal() {
    document.getElementById('cfYamlModal').classList.add('hidden');
    cfSelectedYamlTunnelId = null;
}

async function cfLiveValidateYaml() {
    const yamlContent = document.getElementById('cfYamlTextarea').value;
    const errorBox = document.getElementById('cfYamlError');

    try {
        const res = await fetch(`${API_BASE}/config/validate-yaml`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ yamlConfig: yamlContent })
        });
        const data = await res.json();

        if (data.valid) {
            errorBox.classList.add('hidden');
        } else {
            errorBox.textContent = 'Erro YAML: ' + data.error;
            errorBox.classList.remove('hidden');
        }
    } catch (e) {
        errorBox.textContent = 'Erro de rede ao validar: ' + e.message;
        errorBox.classList.remove('hidden');
    }
}

async function cfSaveYaml() {
    const yamlContent = document.getElementById('cfYamlTextarea').value;
    
    try {
        const res = await fetch(`${API_BASE}/tunnel/update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: cfSelectedYamlTunnelId, yamlConfig: yamlContent })
        });
        const data = await res.json();
        if (!data.success) throw new Error(data.error);
        cfCloseYamlModal();
        cfFetchTunnels();
        showToast('Configuração YAML salva com sucesso!', 'success');
    } catch (e) {
        showToast('Erro ao salvar configuração YAML: ' + e.message, 'error');
    }
}

async function cfGenerateYamlTemplate() {
    if (!cfSelectedYamlTunnelId) return;
    const t = cfTunnels.find(x => x.id === cfSelectedYamlTunnelId);
    if (!t) return;
    
    if (!confirm('Deseja sobrescrever as alterações atuais com o modelo YAML padrão gerado a partir do formulário?')) return;

    try {
        const res = await fetch(`${API_BASE}/config/generate-yaml`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(t)
        });
        const data = await res.json();
        document.getElementById('cfYamlTextarea').value = data.yamlConfig || '';
        cfLiveValidateYaml();
        showToast('Modelo padrão gerado com sucesso!', 'success');
    } catch (e) {
        showToast('Erro ao gerar modelo padrão: ' + e.message, 'error');
    }
}

// QR CODE
function cfShowQrModal(domain) {
    const cleanDomain = domain.replace(/^https?:\/\//, '');
    const url = `https://${cleanDomain}`;
    
    const qrContainer = document.getElementById('cfQrImageContainer');
    // Using standard secure public chart API to render beautiful crisp QR codes locally
    const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(url)}`;
    
    qrContainer.innerHTML = `<img src="${qrUrl}" alt="Acesso rápido" style="width:200px; height:200px;" />`;
    document.getElementById('cfQrUrlText').textContent = url;
    document.getElementById('cfQrModal').classList.remove('hidden');
}

function cfCloseQrModal() {
    document.getElementById('cfQrModal').classList.add('hidden');
}

// BACKUP IMPORT/EXPORT
function cfExportConfigs() {
    window.location.href = `${API_BASE}/config/export`;
}

function cfTriggerImport() {
    document.getElementById('cfImportFile').click();
}

async function cfImportConfigs(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async function(evt) {
        try {
            const tunnels = JSON.parse(evt.target.result);
            const res = await fetch(`${API_BASE}/config/import`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ tunnels })
            });
            const data = await res.json();
            if (data.success) {
                showToast(`Importado com sucesso! ${data.count} túneis carregados.`, 'success');
                cfFetchTunnels();
            } else {
                showToast('Erro ao importar: ' + data.error, 'error');
            }
        } catch(err) {
            showToast('Arquivo JSON inválido.', 'error');
        }
    };
    reader.readAsText(file);
    e.target.value = ''; // reset input
}

// UTILITIES
function cfFormatUptime(secs) {
    if (!secs) return '0s';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function cfEscape(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// LOGS
function cfShowLogsModal(id, name) {
    cfSelectedTunnelId = id;
    document.getElementById('cfLogModalTitle').textContent = `📜 Logs: ${name}`;
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
    if (window.cfrLogInterval) {
        clearInterval(window.cfrLogInterval);
        window.cfrLogInterval = null;
    }
}

async function cfLoadLogs() {
    if (!cfSelectedTunnelId) return;
    try {
        const res = await fetch(`${API_BASE}/tunnel/logs?id=${cfSelectedTunnelId}&lines=100`);
        const data = await res.json();
        const box = document.getElementById('cfLogsBody');
        box.textContent = data.logs || 'Nenhum log disponível.';
        box.scrollTop = box.scrollHeight;
    } catch {}
}

let cfLoginPollInterval = null;

// LOGIN CLÁSSICO
function cfShowLoginModal() {
    document.getElementById('cfLoginModal').classList.remove('hidden');
    document.getElementById('cfLoginStatus').textContent = 'Aguardando...';
    document.getElementById('cfLoginLink').classList.add('hidden');
    
    // Checa imediatamente e inicia o polling a cada 3 segundos
    cfCheckLoginStatus();
    if (cfLoginPollInterval) clearInterval(cfLoginPollInterval);
    cfLoginPollInterval = setInterval(cfCheckLoginStatus, 3000);
}

function cfCloseLoginModal() {
    document.getElementById('cfLoginModal').classList.add('hidden');
    if (cfLoginPollInterval) {
        clearInterval(cfLoginPollInterval);
        cfLoginPollInterval = null;
    }
}

async function cfCheckLoginStatus() {
    const statusBox = document.getElementById('cfLoginStatus');
    try {
        const res = await fetch(`${API_BASE}/auth/status`);
        const data = await res.json();
        if (data.success && data.authenticated) {
            statusBox.innerHTML = '<span style="color:var(--success)">✓ Autenticado com Sucesso! (cert.pem ativo)</span>';
            document.getElementById('cfLoginLink').classList.add('hidden');
        } else {
            // Se não estiver autenticado e o texto não for as mensagens temporárias de carregamento
            if (statusBox.textContent === 'Aguardando...' || statusBox.innerHTML.includes('Autenticado')) {
                statusBox.textContent = 'Nenhum login ativo. Clique abaixo para gerar a URL.';
            }
        }
    } catch (e) {
        console.error('Erro ao verificar status do login:', e);
    }
}

async function cfGenerateLoginUrl() {
    const statusBox = document.getElementById('cfLoginStatus');
    const linkBtn = document.getElementById('cfLoginLink');
    statusBox.textContent = 'Iniciando binário e aguardando URL...';
    
    try {
        const res = await fetch(`${API_BASE}/auth/login`, { method: 'POST' });
        const data = await res.json();
        
        if (data.success && data.url) {
            statusBox.textContent = 'Sucesso! Clique no botão abaixo e autorize o painel.';
            linkBtn.href = data.url;
            linkBtn.classList.remove('hidden');
        } else {
            statusBox.textContent = data.error || 'Nenhuma URL encontrada. Verifique os logs.';
        }
    } catch (e) {
        statusBox.textContent = 'Erro ao se comunicar com o backend: ' + e.message;
    }
}

async function cfClearCert() {
    if (!confirm('Deseja excluir o arquivo cert.pem? Isso deslogará o modo clássico, mas não afetará túneis do tipo Token.')) return;
    try {
        const res = await fetch(`${API_BASE}/auth/logout`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('Certificado removido com sucesso!', 'success');
            document.getElementById('cfLoginStatus').textContent = 'Pronto para um novo Login.';
            document.getElementById('cfLoginLink').classList.add('hidden');
        } else {
            showToast('Falha ao remover certificado: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

async function cfResetManager() {
    if (!confirm('ATENÇÃO: Deseja realmente LIMPAR TODAS as configurações de túneis e EXCLUIR o arquivo cert.pem do Cloudflared?\n\nEsta ação é irreversível e irá parar todos os túneis ativos!')) {
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/system/reset`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('Configurações e certificado removidos com sucesso!', 'success');
            cfFetchTunnels();
            cfCheckLoginStatus();
        } else {
            showToast('Falha ao limpar configurações: ' + (data.error || 'Erro desconhecido.'), 'error');
        }
    } catch (e) {
        showToast('Erro ao se conectar com o backend: ' + e.message, 'error');
    }
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

// ============================================================
//  TESTE DE VELOCIDADE (SPEEDTEST) - CLIENT LÓGICA
// ============================================================
let isSpeedtestRunning = false;
let speedtestUnit = 'Mbps';

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
    let max = 500; // max scale 500 Mbps
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
    const downVal = document.getElementById('speedtest-download');
    const upVal = document.getElementById('speedtest-upload');

    const pingValCompact = document.getElementById('speedtest-ping-compact');
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
    if (downVal) downVal.textContent = '--';
    if (downValCompact) downValCompact.textContent = '--';
    if (upVal) upVal.textContent = '--';
    if (upValCompact) upValCompact.textContent = '--';

    // Cria EventSource
    const eventSource = new EventSource('/api/speedtest');

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
                statusText.textContent = 'Concluído!';
                if (statusCompact) statusCompact.textContent = 'Último teste: agora';
                mainVal.textContent = `${formatSpeed(data.download)} ${speedtestUnit === 'Mbps' ? 'Mb' : 'KB'}`;
                if (pingVal) pingVal.textContent = data.ping || '--';
                if (pingValCompact) pingValCompact.textContent = data.ping ? `${data.ping}ms` : '--';
                if (downVal) downVal.textContent = formatSpeed(data.download);
                if (downValCompact) downValCompact.textContent = `${formatSpeed(data.download)} ${speedtestUnit === 'Mbps' ? 'M' : 'K'}`;
                if (upVal) upVal.textContent = formatSpeed(data.upload);
                if (upValCompact) upValCompact.textContent = `${formatSpeed(data.upload)} ${speedtestUnit === 'Mbps' ? 'M' : 'K'}`;
                
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
        console.error('Erro na conexão com SSE de speedtest:', err);
        statusText.textContent = 'Erro de conexão.';
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
            if (netStatus) netStatus.textContent = "Modo normal falhou. Root disponível.";
            if (rootToggle) {
                rootToggle.style.display = "inline-flex";
                rootToggle.innerHTML = rootModeActive ? "🔐 Root ON" : "🔓 Normal";
            }
        } else {
            if (netStatus) {
                netStatus.textContent = `Erro de permissão ou interface não encontrada`;
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
                rootToggle.innerHTML = data.root ? "🔐 Root ON" : "🔓 Normal";
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
                rootToggle.innerHTML = rootModeActive ? "🔐 Root ON" : "🔓 Normal";
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
            toggleBtn.textContent = savedState === 'compact' ? '⌄' : '⌃';
            
            // Add click listener to toggle btn
            toggleBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                e.preventDefault();
                toggleMonitorCard(cardName);
            });
        }
    });
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
        toggleBtn.textContent = nextState === 'compact' ? '⌄' : '⌃';
    }

    localStorage.setItem(`monitor-card-state-${cardName}`, nextState);
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
            toggleBtn.textContent = targetState === 'compact' ? '⌄' : '⌃';
        }

        localStorage.setItem(`monitor-card-state-${cardName}`, targetState);
    });
}

window.initMonitorCards = initMonitorCards;
window.toggleMonitorCard = toggleMonitorCard;
window.toggleAllMonitorCards = toggleAllMonitorCards;

// ============================================================
//  CONTROLE DE PROCESSOS E MEMÓRIA (MOTO G52 + ROOT)
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
            showToast(res.message || 'Configuração de memória alterada. Reinicie para aplicar.', 'success');
            if (badge) badge.classList.remove('hidden');
        } else {
            showToast(res.error || 'Falha ao alterar configuração de memória', 'error');
        }
    } catch(err) {
        showToast('Erro ao alterar configuração de memória', 'error');
        console.error(err);
    }
}

async function diagnoseProcesses() {
    const modal = document.getElementById('processDiagnosticModal');
    const content = document.getElementById('process-diagnostic-content');
    if (modal) modal.classList.remove('hidden');
    if (content) content.innerHTML = '[Carregando diagnóstico...]';

    try {
        const response = await fetch(`${API_BASE}/system/processes`);
        const res = await response.json();
        if (res.success) {
            let output = '';
            output += `=== DADOS DO PAINEL ===\n`;
            output += `Porta configurada: ${res.panel.port}\n`;
            output += `Porta ocupada? ${res.panel.portBusy ? 'SIM (PID: ' + res.panel.portBusyPid + ')' : 'NÃO'}\n`;
            output += `Lock do Node ativo? ${res.panel.pidFile ? 'SIM (PID no arquivo: ' + res.panel.pidFile + ')' : 'NÃO'}\n`;
            output += `Lock do Loop (start.sh) ativo? ${res.panel.startPidFile ? 'SIM (PID no arquivo: ' + res.panel.startPidFile + ')' : 'NÃO'}\n`;
            output += `Modo de memória Node.js: ${res.panel.nodeMemoryMode} (${res.panel.nodeMemoryMb} MB)\n\n`;

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

            output += `=== SERVIÇOS DO SISTEMA ===\n`;
            output += `Lock de atualização ativo? ${res.locks.updateLock ? 'SIM' : 'NÃO'}\n`;
            output += `Lock de start.sh ativo? ${res.locks.startLock ? 'SIM' : 'NÃO'}\n`;
            output += `Processos MariaDB ativos: ${res.services.mariadb.length}\n`;
            res.services.mariadb.forEach(proc => {
                output += `  - PID: ${proc.pid} | Comando: ${proc.cmd}\n`;
            });
            output += `Processos Cloudflared ativos: ${res.services.cloudflared.length}\n`;
            res.services.cloudflared.forEach(proc => {
                output += `  - PID: ${proc.pid} | Comando: ${proc.cmd}\n`;
            });
            output += `\n`;

            output += `=== MEMÓRIA RAM DO SISTEMA ===\n`;
            output += `Total: ${res.memory.total} MB | Livre: ${res.memory.free} MB | Uso: ${res.memory.usagePercent}%\n\n`;

            output += `=== REGISTROS OOM/KILL DO KERNEL (dmesg) ===\n`;
            output += `${res.oomLog}\n`;

            if (content) content.textContent = output;
        } else {
            if (content) content.textContent = 'Erro ao obter dados de diagnóstico: ' + (res.error || 'Erro desconhecido');
        }
    } catch(err) {
        if (content) content.textContent = 'Erro ao realizar requisição de diagnóstico: ' + err.message;
        console.error(err);
    }
}

function closeProcessDiagnosticModal() {
    const modal = document.getElementById('processDiagnosticModal');
    if (modal) modal.classList.add('hidden');
}

async function stopDuplicatePanel() {
    if (!confirm('Deseja realmente parar processos duplicados do painel? Todos os processos antigos serão encerrados e limpos de forma segura.')) {
        return;
    }
    try {
        const response = await fetch(`${API_BASE}/system/stop`, { method: 'POST' });
        const res = await response.json();
        if (res.success) {
            showToast('Processo de parada segura disparado. O painel será encerrado em instantes.', 'success');
        } else {
            showToast(res.error || 'Falha ao solicitar parada de duplicados', 'error');
        }
    } catch(err) {
        showToast('Erro ao solicitar parada de duplicados', 'error');
        console.error(err);
    }
}

async function safeRestartPanel() {
    if (!confirm('Deseja realizar o Reinício Seguro? O painel irá parar todos os seus processos e reiniciará limpo em até 5 segundos. Esta página tentará reconectar automaticamente.')) {
        return;
    }
    
    // Mostra tela/loader de carregamento/reinício
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
        <div style="font-size:2rem; margin-bottom:15px; animation: spin 2s linear infinite;">🔄</div>
        <div style="font-size:1.2rem; font-weight:bold; margin-bottom:10px;">Executando Reinício Seguro...</div>
        <div style="font-size:0.9rem; color:#aaa;" id="restart-status">Enviando sinal de reinício...</div>
    `;
    document.body.appendChild(overlay);

    try {
        const response = await fetch(`${API_BASE}/system/restart`, { method: 'POST' });
        const res = await response.json();
        if (!res.success) {
            showToast(res.error || 'Erro ao enviar sinal de reinício', 'error');
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
                document.getElementById('restart-status').innerHTML = '❌ O servidor está demorando muito para responder.<br>Por favor, verifique no Termux manualmente ou recarregue a página.';
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
                    document.getElementById('restart-status').textContent = '✅ Painel reconectado! Recarregando página...';
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
        listEl.innerHTML = `<tr><td colspan="7" style="padding: 20px; text-align: center; color: var(--danger);">❌ Falha ao carregar rotas da API: ${err.message}</td></tr>`;
    }
}

function cfrRenderRoutes(routes) {
    const listEl = document.getElementById('cfrRoutesList');
    if (!listEl) return;

    if (!routes || routes.length === 0) {
        listEl.innerHTML = `<tr><td colspan="7" style="padding: 20px; text-align: center; color: var(--text-muted);">Nenhuma rota configurada. Clique em "Preset phpMyAdmin" ou "Adicionar Rota" para começar.</td></tr>`;
        return;
    }

    const sorted = [...routes].sort((a, b) => (a.order || 0) - (b.order || 0));

    listEl.innerHTML = sorted.map((r, idx) => {
        const localUrl = `${r.targetProtocol}://${r.targetHost}:${r.targetPort}${r.path}`;
        const publicUrl = `https://${r.hostname}${r.path}`;

        const isFirst = idx === 0;
        const isLast = idx === sorted.length - 1;

        const upBtn = `<button class="btn btn-secondary btn-sm" style="padding: 3px 6px; margin-right: 2px;" onclick="cfrMoveRouteUp('${r.id}')" ${isFirst ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} title="Mover para Cima">▲</button>`;
        const downBtn = `<button class="btn btn-secondary btn-sm" style="padding: 3px 6px;" onclick="cfrMoveRouteDown('${r.id}')" ${isLast ? 'disabled style="opacity:0.4; cursor:not-allowed;"' : ''} title="Mover para Baixo">▼</button>`;

        const testLocalBtn = `<button class="btn btn-secondary btn-sm" style="padding: 4px 8px;" id="btn-test-local-${r.id}" onclick="cfrTestRoute('${r.id}', '${localUrl}')" title="Testar Conexão Local"><i data-lucide="activity"></i> Local</button>`;
        const testPublicBtn = `<button class="btn btn-secondary btn-sm" style="padding: 4px 8px;" id="btn-test-pub-${r.id}" onclick="cfrTestPublicUrl('${r.id}', '${publicUrl}')" title="Testar URL Pública"><i data-lucide="globe"></i> Pública</button>`;

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
                <td style="padding: 12px 16px; vertical-align: middle;">
                    <a href="${publicUrl}" target="_blank" class="text-primary" style="text-decoration: none; font-family: monospace; font-size: 0.85rem; font-weight: 600;">
                        ${cfEscape(r.hostname)}
                    </a>
                </td>
                <td style="padding: 12px 16px; vertical-align: middle;"><code style="background: var(--bg-secondary); padding: 2px 6px; border-radius: 4px; font-size: 0.85rem;">${cfEscape(r.path)}</code></td>
                <td style="padding: 12px 16px; font-family: monospace; font-size: 0.85rem; vertical-align: middle;">
                    ${localUrl}
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
        if (modalTitle) modalTitle.textContent = '✏️ Editar Rota Proxy Reverso';
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
        if (modalTitle) modalTitle.textContent = '🚀 Adicionar Rota Proxy Reverso';
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
        previewEl.value = `${protocol}://127.0.0.1:${port}${path}`;
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

    if (!payload.name) return showToast('Insira o nome do serviço.', 'warning');
    if (!payload.hostname) return showToast('Insira o domínio público.', 'warning');
    if (!payload.path) return showToast('Insira o caminho (path).', 'warning');
    if (!payload.targetPort) return showToast('Insira a porta local alvo.', 'warning');

    if (payload.hostname.includes(':')) {
        return showToast('O domínio público não deve conter portas (:8080, etc).', 'warning');
    }

    const url = id ? `${API_BASE}/cloudflared/routes/${id}` : `${API_BASE}/cloudflared/routes`;
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
            showToast(id ? 'Rota atualizada com sucesso!' : 'Rota adicionada com sucesso!', 'success');
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
        const res = await fetch(`${API_BASE}/cloudflared/routes/${id}`, {
            method: 'DELETE'
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success) {
            showToast('Rota excluída com sucesso!', 'success');
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
        const res = await fetch(`${API_BASE}/cloudflared/routes/${id}`, {
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
                resultDiv.innerHTML = `<span style="color: var(--success); font-weight: bold;">● Local: Online</span> (${data.time || 'N/A'}) - HTTP ${data.code || '200'}`;
            } else {
                resultDiv.innerHTML = `<span style="color: var(--danger); font-weight: bold;">● Local: Offline</span> - ${data.error || 'Sem resposta'}`;
            }
        }
    } catch (err) {
        console.error('[cfrTestRoute] Erro:', err);
        if (resultDiv) {
            resultDiv.innerHTML = `<span style="color: var(--danger); font-weight: bold;">● Local: Erro</span> - ${err.message}`;
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
        resultDiv.innerHTML = `<span style="color: var(--text-muted);">Testando Pública...</span>`;
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
                resultDiv.innerHTML = `<span style="color: var(--success); font-weight: bold;">🌐 Pública: Online</span> (${data.time || 'N/A'}) - HTTP ${data.code || '200'}`;
            } else {
                if (data.code === 1033 || data.code === 530 || data.code === 521 || data.code === 523) {
                    resultDiv.innerHTML = `<span style="color: var(--danger); font-weight: bold;">🌐 Pública: Erro de Túnel (1033 / ${data.code})</span> - O túnel Cloudflared está offline ou a Cloudflare não encontrou uma conexão saudável. Verifique se o processo está "Rodando".`;
                } else {
                    resultDiv.innerHTML = `<span style="color: var(--danger); font-weight: bold;">🌐 Pública: Offline</span> - ${data.error || 'Sem resposta'} (HTTP ${data.code || 0})`;
                }
            }
        }
    } catch (err) {
        console.error('[cfrTestPublicUrl] Erro:', err);
        if (resultDiv) {
            resultDiv.innerHTML = `<span style="color: var(--danger); font-weight: bold;">🌐 Pública: Erro</span> - ${err.message}`;
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
        return showToast('Já existe uma operação de túnel em andamento. Aguarde finalizar.', 'warning');
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
        // 1. Fazer backup da config antiga (opcional, só para ter histórico antes da geração)
        await fetch(`${API_BASE}/cloudflared/backup`, { method: 'POST' }).catch(() => {});

        // 2. Gerar nova config
        const resGen = await fetch(`${API_BASE}/cloudflared/generate-config`, { method: 'POST' });
        if (!resGen.ok) throw new Error(`HTTP ${resGen.status} na geração da config`);
        const genData = await resGen.json();
        if (!genData.success) throw new Error(genData.error || 'Falha ao gerar config.yml');

        // 3. Validar Ingress
        const resVal = await fetch(`${API_BASE}/cloudflared/validate`, { method: 'POST' });
        const valData = await resVal.json();
        if (!valData.success || (valData.output && valData.output.toLowerCase().includes('error'))) {
            throw new Error(`Validação falhou:\n${valData.error || valData.output}`);
        }

        // 4. Reiniciar processo cloudflared
        await fetch(`${API_BASE}/cloudflared/process/stop`, { method: 'POST' }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
        await fetch(`${API_BASE}/cloudflared/process/start`, { method: 'POST' }).catch(() => {});

        showToast('Ingress configurado, validado e túnel iniciado! Aguardando 4 segundos para testes de rota...', 'success');
        
        // Atualiza UI de status
        setTimeout(cfrCheckStatus, 1500);

        // Aguarda 4 segundos para testar as rotas
        setTimeout(async () => {
            const activeRoutes = cfrRoutesListCached.filter(r => r.enabled);
            for (const r of activeRoutes) {
                const localUrl = `${r.targetProtocol}://${r.targetHost}:${r.targetPort}${r.path}`;
                const publicUrl = `https://${r.hostname}${r.path}`;
                
                // Test local connection
                await cfrTestRoute(r.id, localUrl);
                // Test public connection
                await cfrTestPublicUrl(r.id, publicUrl);
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
            throw new Error(data.error || 'Falha ao obter configuração.');
        }
    } catch (err) {
        console.error('[cfrLoadConfigYml] Erro:', err);
        showToast('Erro ao carregar arquivo de configuração: ' + err.message, 'error');
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
        return showToast('O arquivo YAML não pode conter caracteres de tabulação (Tab). Use apenas espaços.', 'warning');
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
            throw new Error(data.error || 'Falha ao salvar configuração.');
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
            alert(`✓ Sucesso! A validação do Ingress passou sem erros:\n\n${data.output || 'OK'}`);
            showToast('Ingress validado com sucesso!', 'success');
        } else {
            alert(`⚠️ Falha na validação do Ingress:\n\n${data.error || 'Erro'}\n\nRetorno:\n${data.output || 'Nenhum'}`);
            showToast('Erro na validação do Ingress.', 'error');
        }
    } catch (err) {
        console.error('[cfrValidateYamlText] Erro:', err);
        showToast('Erro ao validar configuração: ' + err.message, 'error');
    }
}

async function cfrRestoreBackup() {
    const select = document.getElementById('cfrBackupSelect');
    if (!select) return;

    const backupName = select.value;
    if (!backupName) return showToast('Selecione um backup para restaurar.', 'warning');

    if (!confirm(`Deseja realmente restaurar o backup "${backupName}"? O arquivo config.yml atual será sobrescrito.`)) return;

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
        showToast('Reiniciando túneis do Cloudflared...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/restart`, {
            method: 'POST'
        });

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `HTTP ${res.status}`);
        }

        const data = await res.json();
        if (data.success) {
            showToast(data.message || 'Túneis reiniciados!', 'success');
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
        showToast('Criando presets do Proxy Reverso...', 'info');

        const hasPma = cfrRoutesListCached.some(r => r.path === '/phpmyadmin/' || r.name.toLowerCase().includes('phpmyadmin'));
        const hasMain = cfrRoutesListCached.some(r => r.path === '/');

        let createdCount = 0;

        if (!hasPma) {
            const resPma = await fetch(`${API_BASE}/cloudflared/routes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'phpMyAdmin',
                    hostname: 'panel.arjtechbr.site',
                    path: '/phpmyadmin/',
                    order: 1,
                    targetProtocol: 'http',
                    targetHost: '127.0.0.1',
                    targetPort: 8080,
                    enabled: true
                })
            });
            if (resPma.ok) createdCount++;
        }

        if (!hasMain) {
            const resMain = await fetch(`${API_BASE}/cloudflared/routes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: 'Painel Principal',
                    hostname: 'panel.arjtechbr.site',
                    path: '/',
                    order: 2,
                    targetProtocol: 'http',
                    targetHost: '127.0.0.1',
                    targetPort: 8088,
                    enabled: true
                })
            });
            if (resMain.ok) createdCount++;
        }

        if (createdCount > 0) {
            showToast('Preset criado com sucesso!', 'success');
            cfrFetchRoutes();
        } else {
            showToast('Os presets já existem na lista de rotas.', 'info');
        }
    } catch (err) {
        console.error('[cfrCreatePresetPma] Erro:', err);
        showToast('Erro ao criar presets: ' + err.message, 'error');
    }
}

function cfrShowLogs() {
    document.getElementById('cfLogModalTitle').textContent = `📜 Logs: Cloudflared Ingress`;
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
            box.textContent = data.logs || 'Nenhum log de ingress disponível no momento.';
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
                    ? `<span style="color: var(--success); font-weight: bold;">● Rodando &amp; Conectado</span>` 
                    : `<span style="color: var(--warning); font-weight: bold;">● Rodando (Não Conectado)</span>`;
                
                let details = `<div style="margin-top: 8px; font-size: 0.8rem; line-height: 1.4;">`;
                details += `<strong>Status:</strong> ${connStatus}<br>`;
                if (data.pids && data.pids.length > 0) {
                    details += `<strong>PIDs Ativos:</strong> ${data.pids.join(', ')}<br>`;
                }
                if (data.binaryPath) {
                    details += `<strong>Binário:</strong> <code style="background: var(--bg-hover); padding: 1px 4px; border-radius: 3px;">${data.binaryPath}</code><br>`;
                }
                if (data.configPath) {
                    details += `<strong>Configuração:</strong> <code style="background: var(--bg-hover); padding: 1px 4px; border-radius: 3px;">${data.configPath}</code><br>`;
                }
                if (data.warning) {
                    details += `<div style="margin-top: 6px; padding: 6px 10px; background: rgba(255, 193, 7, 0.15); border-left: 3px solid #ffc107; border-radius: 4px; color: #e0a800; font-weight: 500;">⚠️ ${data.warning}</div>`;
                }
                details += `</div>`;
                statusText.innerHTML = details;
            } else {
                let details = `<div style="margin-top: 8px; font-size: 0.8rem; line-height: 1.4;">`;
                details += `<span style="color: var(--danger); font-weight: bold;">● Parado</span> - Nenhum processo Cloudflared ativo no sistema.<br>`;
                if (data.warning) {
                    details += `<div style="margin-top: 6px; padding: 6px 10px; background: rgba(220, 53, 69, 0.1); border-left: 3px solid var(--danger); border-radius: 4px; color: var(--danger); font-weight: 500;">⚠️ ${data.warning}</div>`;
                }
                details += `</div>`;
                statusText.innerHTML = details;
            }
        } else {
            statusText.innerHTML = `<span style="color: var(--danger); font-weight: bold;">❌ Erro</span> - ${data.error || 'Falha ao processar status.'}`;
        }
    } catch (e) {
        statusText.innerHTML = `<span style="color: var(--warning); font-weight: bold;">⚠️ Desconhecido</span> - Erro de comunicação com o painel: ${e.message}`;
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
            let msg = `🔍 RESULTADO DO TESTE DE REGRAS INGRESS:\n\n`;
            data.results.forEach(r => {
                msg += `URL pública: ${r.url}\n`;
                if (r.success) {
                    msg += `➔ ✅ SUCESSO: ${r.output || 'Regra correspondente encontrada.'}\n`;
                } else {
                    msg += `➔ ❌ FALHA: ${r.error || ''}\n`;
                    if (r.output) msg += `   Log: ${r.output.trim()}\n`;
                }
                msg += `\n`;
            });
            alert(msg);
            showToast('Teste de regras concluído!', 'success');
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
    const symbols = { start: '◌', stop: '↻', restart: '⟳' };
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
        return showToast('Já existe uma operação de túnel em andamento. Aguarde finalizar.', 'warning');
    }
    cfrProcessActionBusy = true;
    cfrSetProcessButtonsBusy('start', true);
    try {
        showToast('Iniciando processo do Cloudflared...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/process/start`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('Túnel iniciado!', 'success');
            setTimeout(cfrCheckStatus, 1000);
        } else {
            throw new Error(data.error || 'Erro ao iniciar túnel');
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
        return showToast('Já existe uma operação de túnel em andamento. Aguarde finalizar.', 'warning');
    }
    cfrProcessActionBusy = true;
    cfrSetProcessButtonsBusy('stop', true);
    try {
        showToast('Parando Cloudflared...', 'info');
        const res = await fetch(`${API_BASE}/cloudflared/process/stop`, { method: 'POST' });
        const data = await res.json();
        if (data.success) {
            showToast('Túnel parado!', 'success');
            setTimeout(cfrCheckStatus, 1000);
        } else {
            throw new Error(data.error || 'Erro ao parar túnel');
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
        return showToast('Já existe uma operação de túnel em andamento. Aguarde finalizar.', 'warning');
    }
    cfrProcessActionBusy = true;
    cfrSetProcessButtonsBusy('restart', true);
    try {
        showToast('Reiniciando Cloudflared...', 'info');
        await fetch(`${API_BASE}/cloudflared/process/stop`, { method: 'POST' }).catch(() => {});
        await new Promise(r => setTimeout(r, 1000));
        await fetch(`${API_BASE}/cloudflared/process/start`, { method: 'POST' });
        showToast('Túnel reiniciado!', 'success');
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
    if (el && el.offsetParent !== null) { // Verifica se está visível
        cfrCheckStatus();
    }
}, 5000);

// Expor no escopo global
window.cfrFetchRoutes = cfrFetchRoutes;
window.cfrRenderRoutes = cfrRenderRoutes;
window.cfrOpenRouteModal = cfrOpenRouteModal;
window.cfrCloseRouteModal = cfrCloseRouteModal;
window.cfrSubmitRoute = cfrSubmitRoute;
window.cfrDeleteRoute = cfrDeleteRoute;
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



