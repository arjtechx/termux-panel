let currentFmPath = '';
let fmRootMode = false;

// ─── INICIALIZAÇÃO ───────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    // Dispara ao clicar na aba Arquivos
    document.querySelectorAll('.nav-link, .mobile-nav-item').forEach(link => {
        link.addEventListener('click', () => {
            if (link.getAttribute('data-target') === 'tab-files') {
                setTimeout(() => {
                    if (!currentFmPath) loadFiles();
                }, 100);
            }
        });
    });

    // Se a aba já está ativa na carga
    if (document.getElementById('tab-files')?.classList.contains('active')) {
        loadFiles();
    }
});

// ─── CARREGAR ARQUIVOS ───────────────────────────────────────
async function loadFiles(targetPath) {
    if (targetPath === undefined) {
        targetPath = currentFmPath || '';
    }

    const listEl  = document.getElementById('fm-file-list');
    const pathEl  = document.getElementById('fm-current-path');
    const errorEl = document.getElementById('fm-error');
    const loadEl  = document.getElementById('fm-loading');

    if (errorEl) errorEl.style.display = 'none';
    if (loadEl)  loadEl.style.display  = 'flex';
    if (listEl)  listEl.innerHTML = '';

    try {
        const url  = targetPath ? `/api/files/list?path=${encodeURIComponent(targetPath)}` : '/api/files/list';
        const opts = {};
        if (fmRootMode) opts.headers = { 'X-FM-Root': '1' };

        const res  = await fetch(url, opts);
        const data = await res.json();

        if (!data.success) {
            showFmError('❌ ' + (data.error || 'Erro ao listar diretório'));
            return;
        }

        currentFmPath      = data.path;
        if (pathEl) pathEl.value = currentFmPath;

        let rows = '';
        if (currentFmPath && currentFmPath !== '/') {
            rows += `<tr class="fm-row" ondblclick="fmUpDir()">
                <td style="padding:10px 12px;text-align:center;"><i data-lucide="corner-left-up" style="width:16px;height:16px;color:var(--text-muted)"></i></td>
                <td style="padding:10px 12px;color:var(--text-muted);font-style:italic;" colspan="4">..</td>
            </tr>`;
        }

        if (data.files.length === 0) {
            rows += `<tr><td colspan="5" style="text-align:center;padding:30px;color:var(--text-muted);">📂 Pasta vazia</td></tr>`;
        }

        data.files.forEach(f => {
            const icon     = f.isDir ? 'folder' : getFileIcon(f.name);
            const iconClr  = f.isDir ? 'var(--primary)' : 'var(--text-muted)';
            const size     = f.isDir ? '—' : fmSize(f.size);
            const mtime    = fmDate(f.mtime);
            const fullPath = (currentFmPath.endsWith('/') ? currentFmPath : currentFmPath + '/') + f.name;

            const nav  = f.isDir
                ? `ondblclick="loadFiles('${escapePath(fullPath)}')"`
                : '';
            const name = f.isDir
                ? `<a href="#" onclick="loadFiles('${escapePath(fullPath)}');return false;" style="color:var(--primary);text-decoration:none;font-weight:500;">${escapeHtml(f.name)}</a>`
                : escapeHtml(f.name);

            const dlBtn = !f.isDir
                ? `<a href="/api/files/download?path=${encodeURIComponent(fullPath)}" class="btn-icon-ghost" title="Download" target="_blank"><i data-lucide="download"></i></a>`
                : '';

            rows += `
            <tr class="fm-row" ${nav} style="cursor:pointer;">
                <td style="padding:10px 12px;text-align:center;width:42px;"><i data-lucide="${icon}" style="color:${iconClr};width:17px;height:17px;"></i></td>
                <td style="padding:10px 12px;">${name}</td>
                <td style="padding:10px 12px;color:var(--text-muted);font-size:.83rem;width:110px;">${size}</td>
                <td style="padding:10px 12px;color:var(--text-muted);font-size:.83rem;width:175px;">${mtime}</td>
                <td style="padding:10px 12px;text-align:right;white-space:nowrap;width:130px;">
                    ${dlBtn}
                    <button class="btn-icon-ghost" onclick="fmRenameFile('${escapePath(f.name)}')" title="Renomear"><i data-lucide="edit-2"></i></button>
                    <button class="btn-icon-ghost" onclick="fmDeleteFile('${escapePath(fullPath)}')" style="color:var(--danger);" title="Excluir"><i data-lucide="trash-2"></i></button>
                </td>
            </tr>`;
        });

        listEl.innerHTML = rows;
        if (window.lucide) lucide.createIcons();

    } catch (e) {
        showFmError('❌ Erro de rede: ' + e.message);
    } finally {
        if (loadEl) loadEl.style.display = 'none';
    }
}

function retryLoadFiles() {
    loadFiles(currentFmPath || '');
}

// ─── ATALHOS RÁPIDOS ─────────────────────────────────────────
const FM_SHORTCUTS = [
    { label: '🏠 Home',        path: '' },
    { label: '📦 Termux',      path: '/data/data/com.termux/files' },
    { label: '🔧 usr/bin',     path: '/data/data/com.termux/files/usr/bin' },
    { label: '🌐 nginx/www',   path: '/data/data/com.termux/files/usr/share/nginx/html' },
    { label: '💾 Storage',     path: '/sdcard' },
    { label: '📂 Download',    path: '/sdcard/Download' },
    { label: '🤖 Raiz /data',  path: '/data' },
    { label: '⚙️ / (Raiz)',    path: '/' },
];

function fmNavigateShortcut(path) {
    loadFiles(path || '');
}

// ─── ROOT MODE ───────────────────────────────────────────────
function fmToggleRoot() {
    fmRootMode = !fmRootMode;
    const btn = document.getElementById('fm-root-btn');
    if (btn) {
        btn.style.background  = fmRootMode ? 'var(--danger)' : '';
        btn.style.color       = fmRootMode ? '#fff' : '';
        btn.title             = fmRootMode ? 'Modo Root ATIVO — Clique para desativar' : 'Ativar Modo Root (su)';
        btn.innerHTML         = `<i data-lucide="shield${fmRootMode ? '-alert' : ''}"></i> ${fmRootMode ? 'Root ON' : 'Root'}`;
    }
    if (window.lucide) lucide.createIcons();
    loadFiles();
}

// ─── SUBIR PASTA ────────────────────────────────────────────
function fmUpDir() {
    if (!currentFmPath || currentFmPath === '/') return;
    const parts = currentFmPath.replace(/\/$/, '').split('/');
    parts.pop();
    loadFiles(parts.join('/') || '/');
}

// ─── NOVA PASTA ──────────────────────────────────────────────
async function fmCreateFolder() {
    const name = prompt('Nome da nova pasta:');
    if (!name) return;
    const base = currentFmPath.endsWith('/') ? currentFmPath : currentFmPath + '/';
    try {
        const r = await fetch('/api/files/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetPath: base + name })
        });
        const d = await r.json();
        if (d.success) loadFiles();
        else alert('Erro: ' + d.error);
    } catch(e) { alert('Erro: ' + e.message); }
}

// ─── UPLOAD ──────────────────────────────────────────────────
async function fmUploadFiles(event) {
    const files = event.target.files;
    if (!files?.length) return;

    const loadEl = document.getElementById('fm-loading');
    if (loadEl) { loadEl.innerHTML = '<span>⬆️ Enviando arquivos...</span>'; loadEl.style.display = 'flex'; }

    const fd = new FormData();
    fd.append('path', currentFmPath);
    for (const f of files) fd.append('files', f);

    try {
        const r = await fetch('/api/files/upload', { method: 'POST', body: fd });
        const d = await r.json();
        if (!d.success) alert('Erro upload: ' + d.error);
    } catch(e) { alert('Erro: ' + e.message); }
    finally {
        if (loadEl) { loadEl.innerHTML = '<span>Carregando...</span>'; loadEl.style.display = 'none'; }
        event.target.value = '';
        loadFiles();
    }
}

// ─── EXCLUIR ─────────────────────────────────────────────────
async function fmDeleteFile(fullPath) {
    const name = fullPath.split('/').pop();
    if (!confirm(`Excluir "${name}"?`)) return;
    try {
        const r = await fetch(`/api/files/delete?path=${encodeURIComponent(fullPath)}`, { method: 'DELETE' });
        const d = await r.json();
        if (d.success) loadFiles();
        else alert('Erro: ' + d.error);
    } catch(e) { alert('Erro: ' + e.message); }
}

// ─── RENOMEAR ────────────────────────────────────────────────
async function fmRenameFile(oldName) {
    const newName = prompt(`Renomear "${oldName}" para:`, oldName);
    if (!newName || newName === oldName) return;
    const base = currentFmPath.endsWith('/') ? currentFmPath : currentFmPath + '/';
    try {
        const r = await fetch('/api/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPath: base + oldName, newPath: base + newName })
        });
        const d = await r.json();
        if (d.success) loadFiles();
        else alert('Erro: ' + d.error);
    } catch(e) { alert('Erro: ' + e.message); }
}

// ─── HELPERS ─────────────────────────────────────────────────
function showFmError(msg) {
    const el = document.getElementById('fm-error');
    const li = document.getElementById('fm-file-list');
    if (el) { el.textContent = msg; el.style.display = 'block'; }
    if (li) li.innerHTML = '';
    const ld = document.getElementById('fm-loading');
    if (ld) ld.style.display = 'none';
}

function escapePath(p) { return p.replace(/'/g, "\\'"); }
function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

function fmSize(b) {
    if (!b) return '0 B';
    const u = ['B','KB','MB','GB'];
    const i = Math.floor(Math.log(b) / Math.log(1024));
    return (b / Math.pow(1024, i)).toFixed(1) + ' ' + (u[i]||'GB');
}

function fmDate(iso) {
    return iso ? new Date(iso).toLocaleString('pt-BR') : '—';
}

function getFileIcon(name) {
    const ext = (name.split('.').pop() || '').toLowerCase();
    const map = {
        'js':'file-code','ts':'file-code','py':'file-code','php':'file-code',
        'html':'file-code','css':'file-code','sh':'terminal','bash':'terminal',
        'json':'file-json','xml':'file-code','md':'file-text','txt':'file-text',
        'jpg':'image','jpeg':'image','png':'image','gif':'image','webp':'image',
        'mp4':'video','mkv':'video','avi':'video','mp3':'music','wav':'music',
        'zip':'archive','tar':'archive','gz':'archive','rar':'archive',
        'pdf':'file-text','db':'database','sql':'database'
    };
    return map[ext] || 'file';
}
