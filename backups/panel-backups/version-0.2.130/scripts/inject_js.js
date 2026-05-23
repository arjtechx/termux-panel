const fs = require('fs');

const js_code = `
// ==========================================
// SSL & ACME MANAGEMENT
// ==========================================

async function validateManualSSL() {
    const cert = document.getElementById('ssl-manual-cert').value;
    const key = document.getElementById('ssl-manual-key').value;
    const statusDiv = document.getElementById('ssl-manual-status');

    if (!cert || !key) {
        return showToast('Cole ambos os blocos PEM (Certificado e Chave).', 'warning');
    }

    statusDiv.innerHTML = '<span style="color:var(--text-muted);">Validando...</span>';

    const res = await safeFetch(\`\${API_BASE}/ssl/manual/validate\`, 'POST', { certPem: cert, keyPem: key });
    if (res && res.success) {
        statusDiv.innerHTML = \`<span style="color:var(--success);">✅ Certificado Válido!<br>Emissor: \${res.issuer}<br>Expira em: \${res.daysLeft} dias.</span>\`;
    } else {
        statusDiv.innerHTML = \`<span style="color:var(--danger);">❌ Erro: \${res?.error || 'Inválido'}</span>\`;
    }
}

async function saveManualSSL() {
    const cert = document.getElementById('ssl-manual-cert').value;
    const key = document.getElementById('ssl-manual-key').value;
    
    if (!cert || !key) return showToast('Cole ambos os blocos PEM.', 'warning');
    
    const res = await safeFetch(\`\${API_BASE}/ssl/manual/save\`, 'POST', { certPem: cert, keyPem: key });
    if (res && res.success) {
        showToast(res.message, 'success');
        closeModal('modal-ssl-manual');
        if (confirm('Certificado salvo! Deseja reiniciar o painel agora para aplicar as mudanças?')) {
            safeRestartPanel();
        }
    } else {
        showToast(res?.error || 'Falha ao salvar', 'error');
    }
}

async function createSelfSignedSSL() {
    const domain = document.getElementById('ssl-self-domain').value || 'localhost';
    const days = document.getElementById('ssl-self-days').value || 365;
    
    const res = await safeFetch(\`\${API_BASE}/ssl/selfsigned/create\`, 'POST', { domain, days });
    if (res && res.success) {
        showToast(res.message, 'success');
        closeModal('modal-ssl-selfsigned');
        if (confirm('Certificado Autoassinado gerado! Deseja reiniciar o painel agora para aplicar as mudanças?')) {
            safeRestartPanel();
        }
    } else {
        showToast(res?.error || 'Falha ao gerar', 'error');
    }
}

async function testDuckDNSToken() {
    const domain = document.getElementById('ssl-duckdns-domain').value;
    const token = document.getElementById('ssl-duckdns-token').value;
    const statusDiv = document.getElementById('ssl-duckdns-status');

    if (!domain || !token) return showToast('Preencha domínio e token.', 'warning');
    
    statusDiv.innerHTML = '<span style="color:var(--text-muted);">Testando token e comunicação...</span>';

    const res = await safeFetch(\`\${API_BASE}/ssl/duckdns/test\`, 'POST', { domain, token });
    if (res && res.success) {
        statusDiv.innerHTML = \`<span style="color:var(--success);">✅ \${res.message}</span>\`;
    } else {
        statusDiv.innerHTML = \`<span style="color:var(--danger);">❌ Erro: \${res?.error || 'Falha no teste'}</span>\`;
    }
}

async function issueDuckDNSCert() {
    const domain = document.getElementById('ssl-duckdns-domain').value;
    const token = document.getElementById('ssl-duckdns-token').value;
    const email = document.getElementById('ssl-duckdns-email').value;
    const statusDiv = document.getElementById('ssl-duckdns-status');

    if (!domain || !token || !email) return showToast('Preencha todos os campos.', 'warning');
    
    statusDiv.innerHTML = '<span style="color:var(--info);">⏳ Gerando certificado via Let\\'s Encrypt (Isso pode levar até 1 minuto)...</span>';

    const res = await safeFetch(\`\${API_BASE}/ssl/duckdns/issue\`, 'POST', { domain, token, email });
    if (res && res.success) {
        statusDiv.innerHTML = \`<span style="color:var(--success);">✅ \${res.message}</span>\`;
        if (confirm('Certificado oficial emitido com sucesso! Reiniciar painel para aplicar?')) {
            safeRestartPanel();
        }
    } else {
        statusDiv.innerHTML = \`<span style="color:var(--danger);">❌ Erro: \${res?.error || 'Falha'}</span>\`;
    }
}

// Load DuckDNS config on open
async function loadDuckDNSConfig() {
    const res = await safeFetch(\`\${API_BASE}/ssl/duckdns/config\`, 'GET');
    if (res && res.success && res.config) {
        document.getElementById('ssl-duckdns-domain').value = res.config.domain || '';
        document.getElementById('ssl-duckdns-token').value = res.config.token || '';
        document.getElementById('ssl-duckdns-email').value = res.config.email || '';
    }
}
document.addEventListener('DOMContentLoaded', () => {
    // Monkey patch openModal to load configs
    const oldOpen = window.openModal;
    window.openModal = function(id) {
        if (id === 'modal-ssl-duckdns') loadDuckDNSConfig();
        if (id === 'modal-cloudflare-rule') loadCloudflareTunnelsTable();
        oldOpen(id);
    }
});

// ==========================================
// CLOUDFLARE TUNNEL (UI INTEGRATION)
// ==========================================

async function loadCloudflareTunnelsTable() {
    const tbody = document.getElementById('cloudflare-rules-list');
    if (!tbody) return;
    
    tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Carregando regras...</td></tr>';
    
    // As chamadas para os endpoints do cloudflared já existem no painel, vou listá-las
    const res = await safeFetch(\`\${API_BASE}/cloudflared/instances\`, 'GET');
    if (!res || !res.success) {
        tbody.innerHTML = \`<tr><td colspan="5" class="text-center text-danger">Falha ao carregar regras: \${res?.error || ''}</td></tr>\`;
        return;
    }
    
    if (res.instances.length === 0) {
        tbody.innerHTML = '<tr><td colspan="5" class="text-center text-muted">Nenhuma regra de proxy encontrada.</td></tr>';
        return;
    }
    
    let html = '';
    res.instances.forEach(inst => {
        const isRunning = inst.status && inst.status.running;
        const statusBadge = isRunning 
            ? '<span class="badge badge-success">Ativo</span>'
            : '<span class="badge badge-danger">Parado</span>';
            
        // Resumir a primeira rota apenas para exibicao visual
        let routeInfo = inst.hostname || 'Sem domínio';
        let serviceInfo = 'N/A';
        if (inst.routes && inst.routes.length > 0) {
            routeInfo = inst.routes[0].hostname || routeInfo;
            serviceInfo = inst.routes[0].service || 'N/A';
        }
            
        html += \`
            <tr>
                <td><strong>\${inst.name}</strong></td>
                <td>\${routeInfo}</td>
                <td style="font-family:monospace; font-size:0.8rem;">\${serviceInfo}</td>
                <td>\${statusBadge}</td>
                <td>
                    \${isRunning 
                        ? \`<button class="btn btn-warning btn-sm" onclick="toggleCloudflareTunnel('\${inst.id}', false)"><i data-lucide="pause" style="width:14px"></i></button>\`
                        : \`<button class="btn btn-success btn-sm" onclick="toggleCloudflareTunnel('\${inst.id}', true)"><i data-lucide="play" style="width:14px"></i></button>\`
                    }
                </td>
            </tr>
        \`;
    });
    
    tbody.innerHTML = html;
    if (typeof lucide !== 'undefined') lucide.createIcons();
}

async function toggleCloudflareTunnel(id, start) {
    const endpoint = start ? \`\${API_BASE}/cloudflared/instances/\${id}/start\` : \`\${API_BASE}/cloudflared/instances/\${id}/stop\`;
    const res = await safeFetch(endpoint, 'POST');
    if (res && res.success) {
        showToast(\`Túnel \${start ? 'Iniciado' : 'Parado'} com sucesso.\`, 'success');
        loadCloudflareTunnelsTable();
    } else {
        showToast(res?.error || 'Erro ao alterar estado do túnel', 'error');
    }
}
`;

const filepath = 'public/app.js';
let content = fs.readFileSync(filepath, 'utf8');
content += '\n' + js_code;
fs.writeFileSync(filepath, content, 'utf8');
console.log("Success");
