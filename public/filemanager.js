let currentFmPath = '/';

async function loadFiles(targetPath = currentFmPath) {
    const listEl = document.getElementById('fm-file-list');
    const loadingEl = document.getElementById('fm-loading');
    const pathInput = document.getElementById('fm-current-path');
    
    try {
        loadingEl.style.display = 'flex';
        const res = await fetch(`/api/files/list?path=${encodeURIComponent(targetPath)}`);
        const data = await res.json();
        
        if (!data.success) {
            alert('Erro: ' + (data.error || 'Não foi possível carregar o diretório'));
            loadingEl.style.display = 'none';
            return;
        }

        currentFmPath = data.path;
        pathInput.value = currentFmPath;
        
        listEl.innerHTML = '';
        
        if (data.files.length === 0) {
            listEl.innerHTML = '<tr><td colspan="5" style="text-align: center; padding: 20px; color: var(--text-muted);">Pasta vazia</td></tr>';
        } else {
            data.files.forEach(file => {
                const icon = file.isDir ? 'folder' : 'file';
                const iconColor = file.isDir ? 'var(--primary)' : 'var(--text-color)';
                const sizeStr = file.isDir ? '--' : fmFormatSize(file.size);
                const dateStr = fmFormatDate(file.mtime);
                
                const tr = document.createElement('tr');
                tr.style.borderBottom = '1px solid var(--border-color)';
                
                // Clicar no nome ou ícone navega se for diretório
                const nameCellHtml = file.isDir 
                    ? `<a href="#" onclick="loadFiles('${currentFmPath}/${file.name}'.replace(/\\/\\//g, '/')); return false;" style="color: var(--primary); text-decoration: none; font-weight: 500;">${file.name}</a>`
                    : `<span>${file.name}</span>`;
                
                // Ações
                const downloadAction = !file.isDir 
                    ? `<a href="/api/files/download?path=${encodeURIComponent(currentFmPath + '/' + file.name)}" class="btn-icon-ghost" title="Download" target="_blank"><i data-lucide="download"></i></a>`
                    : '';

                tr.innerHTML = `
                    <td style="padding: 12px; text-align: center;"><i data-lucide="${icon}" style="color: ${iconColor}; width: 18px; height: 18px;"></i></td>
                    <td style="padding: 12px;">${nameCellHtml}</td>
                    <td style="padding: 12px; color: var(--text-muted); font-size: 0.85rem;">${sizeStr}</td>
                    <td style="padding: 12px; color: var(--text-muted); font-size: 0.85rem;">${dateStr}</td>
                    <td style="padding: 12px; text-align: right;">
                        ${downloadAction}
                        <button class="btn-icon-ghost" onclick="fmRenameFile('${file.name}')" title="Renomear"><i data-lucide="edit-2"></i></button>
                        <button class="btn-icon-ghost" onclick="fmDeleteFile('${file.name}')" style="color: var(--danger);" title="Excluir"><i data-lucide="trash-2"></i></button>
                    </td>
                `;
                listEl.appendChild(tr);
            });
            lucide.createIcons();
        }
    } catch (e) {
        alert('Erro ao carregar arquivos: ' + e.message);
    } finally {
        loadingEl.style.display = 'none';
    }
}

function fmUpDir() {
    if (currentFmPath === '/') return;
    const parts = currentFmPath.split('/').filter(p => p);
    parts.pop();
    const newPath = '/' + parts.join('/');
    loadFiles(newPath);
}

async function fmCreateFolder() {
    const folderName = prompt('Nome da nova pasta:');
    if (!folderName) return;
    
    const targetPath = (currentFmPath.endsWith('/') ? currentFmPath : currentFmPath + '/') + folderName;
    
    try {
        const res = await fetch('/api/files/mkdir', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetPath })
        });
        const data = await res.json();
        if (data.success) {
            loadFiles();
        } else {
            alert('Erro: ' + data.error);
        }
    } catch (e) {
        alert('Erro ao criar pasta: ' + e.message);
    }
}

async function fmUploadFiles(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    
    const formData = new FormData();
    formData.append('path', currentFmPath);
    for (let i = 0; i < files.length; i++) {
        formData.append('files', files[i]);
    }
    
    const loadingEl = document.getElementById('fm-loading');
    loadingEl.style.display = 'flex';
    loadingEl.innerHTML = '<span>Fazendo upload...</span>';
    
    try {
        const res = await fetch('/api/files/upload', {
            method: 'POST',
            body: formData
        });
        const data = await res.json();
        if (data.success) {
            loadFiles();
        } else {
            alert('Erro: ' + data.error);
        }
    } catch (e) {
        alert('Erro no upload: ' + e.message);
    } finally {
        loadingEl.innerHTML = '<span>Carregando...</span>';
        loadingEl.style.display = 'none';
        event.target.value = ''; // Reset input
    }
}

async function fmDeleteFile(fileName) {
    if (!confirm(`Tem certeza que deseja excluir '${fileName}'?`)) return;
    
    const targetPath = (currentFmPath.endsWith('/') ? currentFmPath : currentFmPath + '/') + fileName;
    
    try {
        const res = await fetch(`/api/files/delete?path=${encodeURIComponent(targetPath)}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.success) {
            loadFiles();
        } else {
            alert('Erro: ' + data.error);
        }
    } catch (e) {
        alert('Erro ao excluir: ' + e.message);
    }
}

async function fmRenameFile(oldName) {
    const newName = prompt(`Renomear '${oldName}' para:`, oldName);
    if (!newName || newName === oldName) return;
    
    const basePath = currentFmPath.endsWith('/') ? currentFmPath : currentFmPath + '/';
    const oldPath = basePath + oldName;
    const newPath = basePath + newName;
    
    try {
        const res = await fetch('/api/files/rename', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ oldPath, newPath })
        });
        const data = await res.json();
        if (data.success) {
            loadFiles();
        } else {
            alert('Erro: ' + data.error);
        }
    } catch (e) {
        alert('Erro ao renomear: ' + e.message);
    }
}

function fmFormatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function fmFormatDate(isoString) {
    const date = new Date(isoString);
    return date.toLocaleString();
}

// Inicializa o file manager se a tab estiver aberta (ou espera o usuário clicar)
document.addEventListener('DOMContentLoaded', () => {
    // Escuta cliques nos botões de navegação para carregar a pasta ao entrar na aba
    document.querySelectorAll('.nav-link, .mobile-nav-item').forEach(link => {
        link.addEventListener('click', (e) => {
            const target = e.currentTarget.getAttribute('data-target');
            if (target === 'tab-files') {
                if (document.getElementById('fm-file-list').innerHTML.includes('Carregando')) {
                    loadFiles();
                }
            }
        });
    });
});
