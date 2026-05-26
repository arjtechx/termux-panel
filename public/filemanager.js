/* ============================================================
   TERMUX CPANEL — filemanager.js (v0.0.11)
   Módulo Completo e Profissional do Gerenciador de Arquivos
   ============================================================ */

let currentFmPath = '';
let fmRootMode = false;
let fmViewMode = 'list'; // 'list' ou 'grid'
let fmSelectedFiles = []; // Armazena objetos de arquivos selecionados
let fmFilesData = []; // Guarda a lista de arquivos atual
let fmEditorOriginalContent = '';
let fmEditorCurrentPath = '';
let fmClipboard = null; // { action: 'copy'|'move', paths: [] }

// ─── INICIALIZAÇÃO ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    console.log('📂 [FileManager] Inicializando subsistema v0.0.11...');

    // Listener para abrir aba de arquivos
    document.querySelectorAll('[data-target="tab-files"], .mobile-nav-item[data-target="tab-files"]').forEach(link => {
        link.addEventListener('click', () => {
            console.log('📂 [FileManager] Aba de Arquivos selecionada!');
            setTimeout(() => {
                loadFiles();
            }, 100);
        });
    });

    // Se inicializar já na aba
    if (document.getElementById('tab-files')?.classList.contains('active')) {
        loadFiles();
    }

    // Configura drag & drop para a drop zone
    setupDragAndDrop();

    // Context Menu click-away listener
    document.addEventListener('click', (e) => {
        if (!e.target.closest('#fm-ctx-menu')) {
            hideContextMenu();
        }
    });

    // Atalho global de teclado: Ctrl + S no editor
    document.addEventListener('keydown', (e) => {
        if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            const editorModal = document.getElementById('fm-editor-modal');
            if (editorModal && editorModal.classList.contains('open')) {
                e.preventDefault();
                fmSaveEditorContent();
            }
        }
    });
});

// ─── CARREGAR DIRETÓRIO ──────────────────────────────────────
async function loadFiles(targetPath) {
    if (targetPath === undefined) {
        targetPath = currentFmPath || '';
    }
    console.log(`📂 [FileManager] Navegando para: "${targetPath}"`);

    const listEl = document.getElementById('fm-file-list');
    const gridEl = document.getElementById('fm-file-grid');
    const pathEl = document.getElementById('fm-current-path');
    const loadEl = document.getElementById('fm-loading');

    if (loadEl) loadEl.style.display = 'flex';
    fmSelectedFiles = [];
    updateDetailsPanel(null);

    try {
        const url = targetPath ? `/api/files/list?path=${encodeURIComponent(targetPath)}` : '/api/files/list';
        const opts = {};
        if (fmRootMode) opts.headers = { 'X-FM-Root': '1' };

        const res = await fetch(url, opts);
        const data = await res.json();

        if (!data.success) {
            showToast('Erro ao ler pasta: ' + (data.error || 'Desconhecido'), 'error');
            if (loadEl) loadEl.style.display = 'none';
            return;
        }

        currentFmPath = data.path;
        fmFilesData = data.files || [];
        if (pathEl) pathEl.value = currentFmPath;

        // Renderizar views
        renderBreadcrumb();
        renderListView();
        renderGridView();
        applyViewMode();

        // Atualizar estado de botões e badges
        updateToolbarButtons();

    } catch (e) {
        console.error(e);
        showToast('Erro de rede: ' + e.message, 'error');
    } finally {
        if (loadEl) loadEl.style.display = 'none';
    }
}

// ─── RENDERS ─────────────────────────────────────────────────
function renderBreadcrumb() {
    const container = document.getElementById('fm-breadcrumb-container');
    if (!container) return;

    if (!currentFmPath) {
        container.innerHTML = `<span class="fm-slash">Aguardando...</span>`;
        return;
    }

    const parts = currentFmPath.split('/').filter(Boolean);
    let html = `<button class="fm-crumb" onclick="loadFiles('/')">/ raiz</button>`;
    
    let pathAcc = '';
    parts.forEach((p, idx) => {
        pathAcc += '/' + p;
        html += `<span class="fm-slash">/</span>`;
        if (idx === parts.length - 1) {
            html += `<span class="fm-slash" style="color:var(--text);font-weight:600;">${escapeHtml(p)}</span>`;
        } else {
            const currentDest = pathAcc;
            html += `<button class="fm-crumb" onclick="loadFiles('${escapePath(currentDest)}')">${escapeHtml(p)}</button>`;
        }
    });

    // Badges do breadcrumb
    html += `<span class="fm-crumb-spacer"></span>`;
    html += `<span class="fm-badge" style="margin-right:6px;"><i data-lucide="shield-check"></i> Seguro</span>`;
    if (fmRootMode) {
        html += `<span class="fm-badge" style="border-color:var(--danger);color:var(--danger);font-weight:bold;"><i data-lucide="shield-alert"></i> Modo Root (su)</span>`;
    } else {
        html += `<span class="fm-badge"><i data-lucide="user"></i> Usuário</span>`;
    }

    container.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

function renderListView() {
    const tbody = document.getElementById('fm-file-list');
    if (!tbody) return;

    let html = '';

    // Item subir diretório (..)
    if (currentFmPath && currentFmPath !== '/' && currentFmPath !== '') {
        html += `
        <tr class="fm-row" ondblclick="fmUpDir()">
            <td></td>
            <td colspan="4">
                <div class="fm-file-cell" style="color: var(--text-muted); font-style: italic;">
                    <div class="fm-file-icon"><i data-lucide="corner-left-up"></i></div>
                    <span>.. (subir pasta)</span>
                </div>
            </td>
        </tr>`;
    }

    if (fmFilesData.length === 0) {
        html += `<tr><td colspan="5"><div class="fm-empty"><i data-lucide="folder-open"></i><p>Diretório vazio</p></div></td></tr>`;
        tbody.innerHTML = html;
        if (window.lucide) lucide.createIcons();
        return;
    }

    fmFilesData.forEach((f, idx) => {
        const fullPath = getFullPath(f.name);
        const icon = getIconMarkup(f);
        const isSelected = isFileSelected(f.name);
        const isEdit = f.editable;
        const isArc = !f.isDir && ['zip', 'tar', 'gz', 'bz2', 'xz'].includes(getFileExt(f.name));
        
        html += `
        <tr class="fm-row ${isSelected ? 'fm-selected' : ''}" onclick="toggleRowSelect(event, ${idx})" ondblclick="handleRowDblClick(${idx})">
            <td>
                <input type="checkbox" class="fm-check" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleFileSelection(${idx})">
            </td>
            <td>
                <div class="fm-file-cell">
                    <div class="fm-file-icon ${getFileIconClass(f)}">${icon}</div>
                    <div>
                        <div class="fm-file-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
                        <div class="fm-file-sub">${f.isDir ? 'Pasta' : getFileExtLabel(f.name)}</div>
                    </div>
                </div>
            </td>
            <td class="fm-muted">${f.isDir ? '—' : fmSize(f.size)}</td>
            <td class="fm-muted">${f.perms ? f.perms : '—'}</td>
            <td class="fm-muted">${fmDate(f.mtime)}</td>
            <td style="text-align:right;">
                <div class="fm-row-actions">
                    ${isArc ? `<button class="fm-ico" title="Descompactar" onclick="event.stopPropagation(); fmExtractFile('${escapePath(fullPath)}')"><i data-lucide="package-open"></i></button>` : ''}
                    ${!f.isDir ? `<a href="/api/files/download?path=${encodeURIComponent(fullPath)}" class="fm-ico" title="Download" target="_blank" onclick="event.stopPropagation();"><i data-lucide="download"></i></a>` : ''}
                    ${isEdit ? `<button class="fm-ico" title="Editar" onclick="event.stopPropagation(); fmOpenEditor('${escapePath(fullPath)}')"><i data-lucide="edit-3"></i></button>` : ''}
                    <button class="fm-ico" title="Mais opções" onclick="event.stopPropagation(); showContextMenuAtEvent(event, ${idx})"><i data-lucide="more-vertical"></i></button>
                </div>
            </td>
        </tr>`;
    });

    tbody.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

function renderGridView() {
    const grid = document.getElementById('fm-file-grid');
    if (!grid) return;

    let html = '';

    if (fmFilesData.length === 0) {
        grid.innerHTML = `<div class="fm-empty" style="grid-column: 1/-1;"><i data-lucide="folder-open"></i><p>Diretório vazio</p></div>`;
        if (window.lucide) lucide.createIcons();
        return;
    }

    fmFilesData.forEach((f, idx) => {
        const isSelected = isFileSelected(f.name);
        const icon = getIconMarkup(f);

        html += `
        <div class="fm-grid-card ${isSelected ? 'fm-selected' : ''}" onclick="toggleRowSelect(event, idx)" ondblclick="handleRowDblClick(${idx})">
            <input type="checkbox" class="fm-check fm-grid-check" ${isSelected ? 'checked' : ''} onclick="event.stopPropagation(); toggleFileSelection(${idx})">
            <div class="fm-file-icon ${getFileIconClass(f)}" style="margin: 0 auto;">${icon}</div>
            <div class="fm-card-name" style="text-align:center;" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</div>
            <div class="fm-card-sub" style="text-align:center;">${f.isDir ? 'Pasta' : fmSize(f.size)}</div>
        </div>`;
    });

    grid.innerHTML = html;
    if (window.lucide) lucide.createIcons();
}

// ─── DIRETÓRIO BINDINGS ──────────────────────────────────────
function fmUpDir() {
    if (!currentFmPath || currentFmPath === '/') return;
    const parts = currentFmPath.replace(/\/$/, '').split('/');
    parts.pop();
    loadFiles(parts.join('/') || '/');
}

function fmNavigateShortcut(path) {
    loadFiles(path || '');
}

function fmToggleRoot() {
    fmRootMode = !fmRootMode;
    const btn = document.getElementById('fm-root-btn');
    if (btn) {
        btn.classList.toggle('btn-danger', fmRootMode);
        btn.classList.toggle('btn-secondary', !fmRootMode);
        btn.innerHTML = `<i data-lucide="shield${fmRootMode ? '-alert' : ''}"></i> ${fmRootMode ? 'Root ON' : 'Root'}`;
    }
    showToast(fmRootMode ? 'Modo Root ativo' : 'Modo Root inativo', 'info');
    loadFiles();
}

function handleRowDblClick(idx) {
    const file = fmFilesData[idx];
    if (file.isDir) {
        loadFiles(getFullPath(file.name));
    } else if (file.editable) {
        fmOpenEditor(getFullPath(file.name));
    } else {
        // Preview se for imagem
        const ext = getFileExt(file.name);
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg'].includes(ext)) {
            fmShowImagePreview(getFullPath(file.name), file.name);
        } else {
            showToast('Arquivo binário não suportado para visualização rápida.', 'warning');
        }
    }
}

// ─── SELEÇÃO & TOOLBAR ───────────────────────────────────────
function toggleRowSelect(e, idx) {
    // Se clicar no checkbox ou ação, não faz nada
    if (e.target.closest('input[type="checkbox"]') || e.target.closest('button') || e.target.closest('a')) {
        return;
    }
    
    const file = fmFilesData[idx];
    const isSelected = isFileSelected(file.name);

    if (e.ctrlKey || e.metaKey) {
        toggleFileSelection(idx);
    } else {
        // Seleção única
        fmSelectedFiles = [file];
        renderListView();
        renderGridView();
        updateDetailsPanel(file);
    }
}

function toggleFileSelection(idx) {
    const file = fmFilesData[idx];
    const selIdx = fmSelectedFiles.findIndex(f => f.name === file.name);
    if (selIdx > -1) {
        fmSelectedFiles.splice(selIdx, 1);
    } else {
        fmSelectedFiles.push(file);
    }
    renderListView();
    renderGridView();
    
    if (fmSelectedFiles.length === 1) {
        updateDetailsPanel(fmSelectedFiles[0]);
    } else {
        updateDetailsPanel(null);
    }
}

function selectAllFiles(checked) {
    if (checked) {
        fmSelectedFiles = [...fmFilesData];
    } else {
        fmSelectedFiles = [];
    }
    renderListView();
    renderGridView();
    updateDetailsPanel(null);
}

function isFileSelected(name) {
    return fmSelectedFiles.some(f => f.name === name);
}

function updateToolbarButtons() {
    // Configura botões dependendo da seleção múltipla
    const selCount = fmSelectedFiles.length;
}

// ─── DETALHES LATERAL ───────────────────────────────────────
function updateDetailsPanel(file) {
    const panel = document.getElementById('fm-details-panel');
    if (!panel) return;

    if (!file) {
        panel.innerHTML = `
        <div class="fm-detail-placeholder">
            <i data-lucide="mouse-pointer-click"></i>
            <p>Selecione um arquivo para ver detalhes</p>
        </div>`;
        if (window.lucide) lucide.createIcons();
        return;
    }

    const fullPath = getFullPath(file.name);
    const isEdit = file.editable;
    const isImg = !file.isDir && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg'].includes(getFileExt(file.name));
    const isArc = !file.isDir && ['zip', 'tar', 'gz', 'bz2', 'xz'].includes(getFileExt(file.name));

    panel.innerHTML = `
    <div class="fm-detail-icon ${getFileIconClass(file)}">
        ${getIconMarkup(file)}
    </div>
    <div class="fm-detail-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
    <div class="fm-detail-sub">${file.isDir ? 'Pasta' : getFileExtLabel(file.name)}</div>
    
    <div class="fm-detail-line"><span>Caminho:</span><b>${escapeHtml(fullPath)}</b></div>
    <div class="fm-detail-line"><span>Tamanho:</span><b>${file.isDir ? '—' : fmSize(file.size)}</b></div>
    <div class="fm-detail-line"><span>Permissão:</span><b>${file.perms || '—'}</b></div>
    <div class="fm-detail-line"><span>Modificado:</span><b>${fmDate(file.mtime)}</b></div>

    <div class="fm-detail-actions">
        ${isArc ? `<button class="btn btn-primary" onclick="fmExtractFile('${escapePath(fullPath)}')"><i data-lucide="package-open"></i> Descompactar</button>` : ''}
        ${isEdit ? `<button class="btn btn-primary" onclick="fmOpenEditor('${escapePath(fullPath)}')"><i data-lucide="edit"></i> Editar</button>` : ''}
        ${isImg ? `<button class="btn btn-primary" onclick="fmShowImagePreview('${escapePath(fullPath)}', '${escapePath(file.name)}')"><i data-lucide="eye"></i> Preview</button>` : ''}
        ${!file.isDir ? `<a href="/api/files/download?path=${encodeURIComponent(fullPath)}" class="btn btn-secondary" style="text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:6px;" target="_blank"><i data-lucide="download"></i> Baixar</a>` : ''}
        <button class="btn btn-secondary" onclick="fmOpenChmodModal('${escapePath(fullPath)}', '${file.perms}')"><i data-lucide="key"></i> Chmod</button>
        <button class="btn btn-secondary" onclick="fmOpenRenameModal('${escapePath(file.name)}')"><i data-lucide="edit-2"></i> Renomear</button>
        <button class="btn btn-danger" onclick="fmDeleteSingle('${escapePath(fullPath)}')"><i data-lucide="trash-2"></i> Excluir</button>
    </div>`;

    if (window.lucide) lucide.createIcons();
}

// ─── BUSCA (FRONT + ENDPOINT) ────────────────────────────────
let fmSearchTimeout = null;
function handleSearch(query) {
    clearTimeout(fmSearchTimeout);
    if (!query.trim()) {
        loadFiles();
        return;
    }

    fmSearchTimeout = setTimeout(async () => {
        const loadEl = document.getElementById('fm-loading');
        if (loadEl) loadEl.style.display = 'flex';

        try {
            const url = `/api/files/search?path=${encodeURIComponent(currentFmPath)}&q=${encodeURIComponent(query)}`;
            const res = await fetch(url);
            const data = await res.json();

            if (!data.success) {
                showToast('Erro na busca: ' + data.error, 'error');
                return;
            }

            fmFilesData = data.results || [];
            renderListView();
            renderGridView();
            showToast(`Busca concluída: ${fmFilesData.length} resultados`, 'success');

        } catch (e) {
            showToast('Erro de busca: ' + e.message, 'error');
        } finally {
            if (loadEl) loadEl.style.display = 'none';
        }
    }, 400);
}

// ─── VISUALIZAÇÃO TOGGLE ─────────────────────────────────────
function setFmView(mode) {
    fmViewMode = mode;
    applyViewMode();
}

function applyViewMode() {
    const listWrap = document.getElementById('fm-list-wrapper');
    const gridWrap = document.getElementById('fm-grid-wrapper');
    const listBtn = document.getElementById('fm-view-list-btn');
    const gridBtn = document.getElementById('fm-view-grid-btn');

    if (fmViewMode === 'list') {
        if (listWrap) listWrap.style.display = 'block';
        if (gridWrap) gridWrap.style.display = 'none';
        if (listBtn) listBtn.classList.add('active');
        if (gridBtn) gridBtn.classList.remove('active');
    } else {
        if (listWrap) listWrap.style.display = 'none';
        if (gridWrap) gridWrap.style.display = 'grid';
        if (listBtn) listBtn.classList.remove('active');
        if (gridBtn) gridBtn.classList.add('active');
    }
}

// ─── DRAG AND DROP & UPLOAD ──────────────────────────────────
function setupDragAndDrop() {
    const dropZone = document.getElementById('fm-drop-zone');
    if (!dropZone) return;

    ['dragenter', 'dragover'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('dragover');
        }, false);
    });

    ['dragleave', 'drop'].forEach(name => {
        dropZone.addEventListener(name, (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.remove('dragover');
        }, false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files && files.length > 0) {
            handleUploadFiles(files);
        }
    });
}

function fmTriggerUpload() {
    const input = document.getElementById('fm-upload-input');
    if (input) input.click();
}

function fmUploadFiles(e) {
    const files = e.target.files;
    if (files && files.length > 0) {
        handleUploadFiles(files);
    }
}

async function handleUploadFiles(files) {
    const progressWrap = document.getElementById('fm-upload-progress-wrap');
    const progressBar = document.getElementById('fm-upload-progress');

    if (progressWrap) progressWrap.classList.add('visible');
    if (progressBar) progressBar.style.width = '0%';

    const fd = new FormData();
    fd.append('path', currentFmPath);
    for (let i = 0; i < files.length; i++) {
        fd.append('files', files[i]);
    }

    try {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/files/upload', true);

        // Progresso de upload
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
                const percent = Math.round((event.loaded / event.total) * 100);
                if (progressBar) progressBar.style.width = percent + '%';
            }
        };

        xhr.onload = () => {
            if (xhr.status === 200) {
                showToast('Upload concluído com sucesso!', 'success');
                loadFiles();
            } else {
                showToast('Falha no upload.', 'error');
            }
            setTimeout(() => {
                if (progressWrap) progressWrap.classList.remove('visible');
            }, 1000);
        };

        xhr.onerror = () => {
            showToast('Erro de rede no upload.', 'error');
            if (progressWrap) progressWrap.classList.remove('visible');
        };

        xhr.send(fd);

    } catch (e) {
        showToast('Erro de upload: ' + e.message, 'error');
        if (progressWrap) progressWrap.classList.remove('visible');
    }
}

// ─── EDITOR INTEGRADO ────────────────────────────────────────
async function fmOpenEditor(filepath) {
    const modal = document.getElementById('fm-editor-modal');
    const titleEl = document.getElementById('fm-editor-title');
    const textarea = document.getElementById('fm-editor-textarea');
    const langBadge = document.getElementById('fm-editor-lang-badge');

    if (!modal || !textarea) return;

    try {
        const res = await fetch(`/api/files/read?path=${encodeURIComponent(filepath)}`);
        const data = await res.json();

        if (!data.success) {
            showToast(data.error || 'Erro ao carregar arquivo para o editor', 'error');
            return;
        }

        fmEditorOriginalContent = data.content || '';
        fmEditorCurrentPath = filepath;
        
        textarea.value = fmEditorOriginalContent;
        if (titleEl) titleEl.innerText = data.name;
        if (langBadge) langBadge.innerText = (data.ext || 'txt').toUpperCase();

        modal.classList.add('open');
        updateEditorUnsavedBadge(false);

        // Focar no editor
        textarea.focus();

        // Evitar que mude acidentalmente
        textarea.oninput = () => {
            const isDirty = textarea.value !== fmEditorOriginalContent;
            updateEditorUnsavedBadge(isDirty);
        };

    } catch (e) {
        showToast('Erro ao ler arquivo: ' + e.message, 'error');
    }
}

function updateEditorUnsavedBadge(isDirty) {
    const badge = document.getElementById('fm-editor-unsaved');
    if (badge) {
        badge.style.display = isDirty ? 'inline' : 'none';
    }
}

async function fmSaveEditorContent() {
    const textarea = document.getElementById('fm-editor-textarea');
    if (!textarea || !fmEditorCurrentPath) return;

    try {
        const res = await fetch('/api/files/save', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: fmEditorCurrentPath,
                content: textarea.value
            })
        });
        const data = await res.json();

        if (data.success) {
            fmEditorOriginalContent = textarea.value;
            updateEditorUnsavedBadge(false);
            showToast('Arquivo salvo com sucesso!', 'success');
            loadFiles();
        } else {
            showToast('Erro ao salvar: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Erro de rede: ' + e.message, 'error');
    }
}

function fmCloseEditor() {
    const textarea = document.getElementById('fm-editor-textarea');
    const isDirty = textarea && textarea.value !== fmEditorOriginalContent;

    if (isDirty) {
        if (!confirm('Existem alterações não salvas. Deseja realmente fechar?')) {
            return;
        }
    }

    const modal = document.getElementById('fm-editor-modal');
    if (modal) modal.classList.remove('open');
}

function fmFormatJson() {
    const textarea = document.getElementById('fm-editor-textarea');
    if (!textarea) return;
    try {
        const obj = JSON.parse(textarea.value);
        textarea.value = JSON.stringify(obj, null, 2);
        updateEditorUnsavedBadge(textarea.value !== fmEditorOriginalContent);
        showToast('JSON formatado!', 'success');
    } catch(e) {
        showToast('JSON inválido para formatação.', 'error');
    }
}

// ─── MODAIS OPERACIONAIS ─────────────────────────────────────
function openFmModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.add('open');
}

function closeFmModal(id) {
    const m = document.getElementById(id);
    if (m) m.classList.remove('open');
}

// Criar pasta
function fmOpenMkdirModal() {
    const input = document.getElementById('fm-mkdir-name');
    if (input) input.value = '';
    openFmModal('fm-mkdir-modal');
    setTimeout(() => input?.focus(), 150);
}

async function fmSubmitMkdir() {
    const input = document.getElementById('fm-mkdir-name');
    if (!input || !input.value.trim()) return;

    try {
        const target = getFullPath(input.value.trim());
        const res = await fetch('/api/files/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetPath: target })
        });
        const data = await res.json();
        if (data.success) {
            closeFmModal('fm-mkdir-modal');
            showToast('Diretório criado com sucesso!', 'success');
            loadFiles();
        } else {
            showToast('Erro: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Erro de rede: ' + e.message, 'error');
    }
}

// Criar arquivo
function fmOpenCreateFileModal() {
    const input = document.getElementById('fm-createfile-name');
    if (input) input.value = '';
    openFmModal('fm-createfile-modal');
    setTimeout(() => input?.focus(), 150);
}

async function fmSubmitCreateFile() {
    const input = document.getElementById('fm-createfile-name');
    if (!input || !input.value.trim()) return;

    try {
        const target = getFullPath(input.value.trim());
        const res = await fetch('/api/files/create-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: target })
        });
        const data = await res.json();
        if (data.success) {
            closeFmModal('fm-createfile-modal');
            showToast('Arquivo criado com sucesso!', 'success');
            loadFiles();
            // Abrir direto no editor
            setTimeout(() => {
                fmOpenEditor(target);
            }, 300);
        } else {
            showToast('Erro: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Erro de rede: ' + e.message, 'error');
    }
}

// Chmod
let chmodTarget = '';
function fmOpenChmodModal(filepath, currentPerms) {
    chmodTarget = filepath;
    const input = document.getElementById('fm-chmod-mode');
    if (input) input.value = currentPerms || '644';
    openFmModal('fm-chmod-modal');
    setTimeout(() => input?.focus(), 150);
}

async function fmSubmitChmod() {
    const input = document.getElementById('fm-chmod-mode');
    if (!input || !chmodTarget) return;

    try {
        const res = await fetch('/api/files/chmod', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: chmodTarget, mode: input.value })
        });
        const data = await res.json();
        if (data.success) {
            closeFmModal('fm-chmod-modal');
            showToast('Permissões alteradas com sucesso!', 'success');
            loadFiles();
        } else {
            showToast('Erro: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

// Renomear
let renameTargetOld = '';
function fmOpenRenameModal(oldName) {
    renameTargetOld = oldName;
    const input = document.getElementById('fm-rename-name');
    if (input) input.value = oldName;
    openFmModal('fm-rename-modal');
    setTimeout(() => input?.focus(), 150);
}

async function fmSubmitRename() {
    const input = document.getElementById('fm-rename-name');
    if (!input || !renameTargetOld) return;

    const newName = input.value.trim();
    if (!newName || newName === renameTargetOld) {
        closeFmModal('fm-rename-modal');
        return;
    }

    try {
        const oldP = getFullPath(renameTargetOld);
        const newP = getFullPath(newName);
        const res = await fetch('/api/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPath: oldP, newPath: newP })
        });
        const data = await res.json();
        if (data.success) {
            closeFmModal('fm-rename-modal');
            showToast('Item renomeado com sucesso!', 'success');
            loadFiles();
        } else {
            showToast('Erro: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

// ─── DELETES ─────────────────────────────────────────────────
async function fmDeleteSingle(filepath) {
    const name = filepath.split('/').pop();
    if (!confirm(`Deseja realmente excluir "${name}"? Esta ação é irreversível.`)) return;

    try {
        const res = await fetch(`/api/files/delete?path=${encodeURIComponent(filepath)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            showToast('Item excluído!', 'success');
            loadFiles();
        } else {
            showToast('Erro ao excluir: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

async function fmDeleteSelected() {
    if (fmSelectedFiles.length === 0) return;
    if (!confirm(`Deseja realmente excluir os ${fmSelectedFiles.length} itens selecionados?`)) return;

    const loadEl = document.getElementById('fm-loading');
    if (loadEl) loadEl.style.display = 'flex';

    try {
        for (const file of fmSelectedFiles) {
            const p = getFullPath(file.name);
            await fetch(`/api/files/delete?path=${encodeURIComponent(p)}`, { method: 'DELETE' });
        }
        showToast('Itens selecionados excluídos com sucesso!', 'success');
        loadFiles();
    } catch (e) {
        showToast('Erro ao excluir alguns itens: ' + e.message, 'error');
    } finally {
        if (loadEl) loadEl.style.display = 'none';
    }
}

// ─── COPYS & MOVES ───────────────────────────────────────────
function fmCopySelected() {
    if (fmSelectedFiles.length === 0) return;
    fmClipboard = {
        action: 'copy',
        paths: fmSelectedFiles.map(f => getFullPath(f.name))
    };
    showToast(`${fmSelectedFiles.length} itens copiados para a área de transferência! Vá para a pasta de destino e cole.`, 'success');
}

function fmMoveSelected() {
    if (fmSelectedFiles.length === 0) return;
    fmClipboard = {
        action: 'move',
        paths: fmSelectedFiles.map(f => getFullPath(f.name))
    };
    showToast(`${fmSelectedFiles.length} itens recortados! Vá para a pasta de destino e cole.`, 'success');
}

async function fmPasteClipboard() {
    if (!fmClipboard || !fmClipboard.paths.length) {
        showToast('Nada na área de transferência para colar.', 'warning');
        return;
    }

    const loadEl = document.getElementById('fm-loading');
    if (loadEl) loadEl.style.display = 'flex';

    try {
        const action = fmClipboard.action;
        const endpoint = action === 'copy' ? '/api/files/copy' : '/api/files/move';

        for (const src of fmClipboard.paths) {
            const name = src.split('/').pop();
            const dest = getFullPath(name);

            if (src === dest) {
                showToast(`Origem e destino iguais para "${name}". Pulando.`, 'warning');
                continue;
            }

            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ src, dest })
            });
            const data = await res.json();
            if (!data.success) {
                showToast(`Erro ao processar "${name}": ` + data.error, 'error');
            }
        }

        showToast('Operação realizada com sucesso!', 'success');
        if (action === 'move') {
            fmClipboard = null; // limpa após mover
        }
        loadFiles();

    } catch (e) {
        showToast('Erro de rede: ' + e.message, 'error');
    } finally {
        if (loadEl) loadEl.style.display = 'none';
    }
}

// ─── COMPRESS & EXTRACT ──────────────────────────────────────
function fmOpenCompressModal() {
    if (fmSelectedFiles.length === 0) {
        showToast('Nenhum item selecionado para compactar.', 'warning');
        return;
    }
    const input = document.getElementById('fm-compress-name');
    if (input) {
        const first = fmSelectedFiles[0].name.split('.')[0];
        input.value = first + (fmSelectedFiles.length > 1 ? '-combo' : '');
    }
    openFmModal('fm-compress-modal');
}

async function fmSubmitCompress() {
    const input = document.getElementById('fm-compress-name');
    if (!input || !input.value.trim() || fmSelectedFiles.length === 0) return;

    try {
        const res = await fetch('/api/files/compress', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                paths: fmSelectedFiles.map(f => getFullPath(f.name)),
                destDir: currentFmPath,
                name: input.value.trim()
            })
        });
        const data = await res.json();
        if (data.success) {
            closeFmModal('fm-compress-modal');
            showToast('Arquivos compactados em: ' + data.dest.split('/').pop(), 'success');
            loadFiles();
        } else {
            showToast('Erro: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Erro: ' + e.message, 'error');
    }
}

async function fmExtractFile(filepath) {
    if (!confirm('Deseja extrair este arquivo aqui?')) return;
    const loadEl = document.getElementById('fm-loading');
    if (loadEl) loadEl.style.display = 'flex';

    try {
        const res = await fetch('/api/files/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                path: filepath,
                destDir: currentFmPath
            })
        });
        const data = await res.json();
        if (data.success) {
            showToast('Arquivo extraído com sucesso!', 'success');
            loadFiles();
        } else {
            showToast('Erro na extração: ' + data.error, 'error');
        }
    } catch (e) {
        showToast('Erro de rede: ' + e.message, 'error');
    } finally {
        if (loadEl) loadEl.style.display = 'none';
    }
}

// ─── CONVERSÃO DE TERMINAL RÁPIDA ────────────────────────────
function fmTerminalHere() {
    // Muda a aba e seta o comando no terminal
    const tabTerminal = document.querySelector('[data-target="tab-terminal"], .mobile-nav-item[data-target="tab-terminal"]');
    
    if (tabTerminal) {
        let username = document.getElementById('sshUser')?.value || '';
        let password = document.getElementById('sshPass')?.value || '';

        // Se não tiver usuário ou senha preenchidos nem no localStorage, solicita
        if (!username) {
            username = prompt('Digite o usuário SSH (ex: android):');
            if (!username) return;
            const uInput = document.getElementById('sshUser');
            if (uInput) uInput.value = username;
            
            const saveCheck = document.getElementById('sshSaveDetails')?.checked;
            if (saveCheck) localStorage.setItem('ssh-user', username);
        }

        if (!password) {
            password = prompt('Digite a senha SSH:');
            if (!password) return;
            const pInput = document.getElementById('sshPass');
            if (pInput) pInput.value = password;
            
            const saveCheck = document.getElementById('sshSaveDetails')?.checked;
            if (saveCheck) localStorage.setItem('ssh-pass', password);
        }

        showToast('Abertura do terminal requisitada na pasta: ' + currentFmPath, 'info');
        tabTerminal.click();
        
        // Se já estiver conectado, executa cd imediatamente
        if (window._term && window.socket) {
            setTimeout(() => {
                window.socket.emit('terminal-input', `cd "${currentFmPath.replace(/"/g, '\\"')}"\r`);
            }, 600);
        } else {
            // Caso contrário, agenda o cd para pós-conexão e conecta
            window.terminalInitialPath = currentFmPath;
            if (typeof connectTerminal === 'function') {
                connectTerminal();
            }
        }
    }
}

// ─── PREVIEW DE IMAGENS ──────────────────────────────────────
function fmShowImagePreview(filepath, filename) {
    const modal = document.getElementById('fm-preview-modal');
    const title = document.getElementById('fm-preview-title');
    const body = document.getElementById('fm-preview-body');

    if (!modal || !body) return;

    if (title) title.innerText = filename;
    body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:center;height:100%;background:#09090b;border-radius:8px;padding:12px;overflow:auto;">
        <img src="/api/files/download?path=${encodeURIComponent(filepath)}" style="max-width:100%;max-height:420px;object-fit:contain;box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
    </div>`;

    openFmModal('fm-preview-modal');
}

// ─── MENU DE CONTEXTO (CLIQUE DIREITO) ─────────────────────────
let ctxMenuTargetIdx = -1;
function showContextMenuAtEvent(e, idx) {
    e.preventDefault();
    e.stopPropagation();

    ctxMenuTargetIdx = idx;
    const file = fmFilesData[idx];
    const isEdit = file.editable;
    const isArc = !file.isDir && ['zip', 'tar', 'gz', 'bz2', 'xz'].includes(getFileExt(file.name));

    // Configurar botões dinâmicos do menu
    document.getElementById('fm-ctx-open').style.display = file.isDir ? 'flex' : 'none';
    document.getElementById('fm-ctx-edit').style.display = isEdit ? 'flex' : 'none';
    document.getElementById('fm-ctx-download').style.display = !file.isDir ? 'flex' : 'none';
    document.getElementById('fm-ctx-extract').style.display = isArc ? 'flex' : 'none';

    // Abrir menu
    const menu = document.getElementById('fm-ctx-menu');
    if (menu) {
        menu.classList.add('open');
        menu.style.left = (e.clientX || 150) + 'px';
        menu.style.top = (e.clientY || 150) + 'px';
    }
}

function hideContextMenu() {
    const menu = document.getElementById('fm-ctx-menu');
    if (menu) menu.classList.remove('open');
}

// Cliques do menu de contexto
function fmCtxTrigger(action) {
    hideContextMenu();
    if (ctxMenuTargetIdx === -1) return;

    const file = fmFilesData[ctxMenuTargetIdx];
    const fullPath = getFullPath(file.name);

    switch(action) {
        case 'open':
            if (file.isDir) loadFiles(fullPath);
            break;
        case 'edit':
            if (file.editable) fmOpenEditor(fullPath);
            break;
        case 'download':
            if (!file.isDir) {
                const a = document.createElement('a');
                a.href = `/api/files/download?path=${encodeURIComponent(fullPath)}`;
                a.target = '_blank';
                a.click();
            }
            break;
        case 'rename':
            fmOpenRenameModal(file.name);
            break;
        case 'copy':
            fmClipboard = { action: 'copy', paths: [fullPath] };
            showToast('Item copiado para colagem!', 'success');
            break;
        case 'move':
            fmClipboard = { action: 'move', paths: [fullPath] };
            showToast('Item recortado!', 'success');
            break;
        case 'chmod':
            fmOpenChmodModal(fullPath, file.perms);
            break;
        case 'extract':
            fmExtractFile(fullPath);
            break;
        case 'delete':
            fmDeleteSingle(fullPath);
            break;
    }
}

// ─── TOAST NOTIFICAÇÃO ───────────────────────────────────────
function showToast(msg, type = 'info') {
    const container = document.getElementById('fm-toast-container');
    if (!container) return;

    const toast = document.createElement('div');
    toast.className = `fm-toast ${type}`;

    let icon = 'info';
    if (type === 'success') icon = 'check-circle';
    if (type === 'error') icon = 'alert-triangle';
    if (type === 'warning') icon = 'alert-circle';

    toast.innerHTML = `
        <i data-lucide="${icon}"></i>
        <div>${escapeHtml(msg)}</div>
    `;

    container.appendChild(toast);
    if (window.lucide) lucide.createIcons();

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'opacity .3s, transform .3s';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ─── AJUDANTES E AUXILIARES ──────────────────────────────────
function getFullPath(name) {
    return (currentFmPath.endsWith('/') ? currentFmPath : currentFmPath + '/') + name;
}

function escapePath(p) {
    return p.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeHtml(s) {
    if (!s) return '';
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmSize(b) {
    if (!b) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(1) + ' ' + (u[i] || 'GB');
}

function fmDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('pt-BR');
}

function getFileExt(name) {
    return (name.split('.').pop() || '').toLowerCase();
}

function getFileExtLabel(name) {
    const ext = getFileExt(name);
    return ext ? ext.toUpperCase() : 'Arquivo';
}

function getFileIconClass(f) {
    if (f.isDir) return 'fm-dir';
    const ext = getFileExt(f.name);
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg'].includes(ext)) return 'fm-img';
    if (f.editable) return 'fm-code';
    if (['zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z'].includes(ext)) return 'fm-arc';
    return '';
}

function getIconMarkup(f) {
    if (f.isDir) return '<i data-lucide="folder"></i>';
    const ext = getFileExt(f.name);
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'svg'].includes(ext)) return '<i data-lucide="image"></i>';
    if (ext === 'json') return '<i data-lucide="braces"></i>';
    if (ext === 'sh' || ext === 'bash') return '<i data-lucide="terminal"></i>';
    if (['zip', 'tar', 'gz', 'bz2', 'xz', 'rar', '7z'].includes(ext)) return '<i data-lucide="archive"></i>';
    if (f.editable) return '<i data-lucide="file-code"></i>';
    return '<i data-lucide="file"></i>';
}
