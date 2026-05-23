const fs = require('fs');

const js_code = `
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

    const res = await safeFetch(\`\${API_BASE}/cloudflared/instances\`, 'POST', newInst);
    if (res && res.success) {
        showToast('Regra de Cloudflare criada com sucesso!', 'success');
        closeModal('modal-cloudflare-rule');
        loadCloudflareTunnelsTable();
        // start instance immediately
        await safeFetch(\`\${API_BASE}/cloudflared/instances/\${res.instance.id}/start\`, 'POST');
        loadCloudflareTunnelsTable();
    } else {
        showToast(res?.error || 'Erro ao criar regra', 'error');
    }
}
`;

const filepath = 'public/app.js';
let content = fs.readFileSync(filepath, 'utf8');
content += '\n' + js_code;
fs.writeFileSync(filepath, content, 'utf8');
console.log("Success");
