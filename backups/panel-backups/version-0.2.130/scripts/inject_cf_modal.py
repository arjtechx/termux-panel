import re

html_file = 'public/index.html'

with open(html_file, 'r', encoding='utf-8') as f:
    content = f.read()

new_modals = """
    <!-- MODAL: CLOUDFLARE RULE -->
    <div id="modal-cloudflare-rule" class="modal">
        <div class="modal-content" style="max-width:600px;">
            <div class="modal-header">
                <h3><i data-lucide="plus"></i> Nova Regra / Túnel Cloudflare</h3>
                <button class="close-btn" onclick="closeModal('modal-cloudflare-rule')"><i data-lucide="x"></i></button>
            </div>
            <div class="modal-body">
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:12px;">Crie uma regra de proxy reverso. O Cloudflared vai rotear o tráfego externo para o serviço local.</p>
                
                <div class="form-row" style="margin-bottom:12px;">
                    <label class="form-label">Nome da Regra</label>
                    <input type="text" id="cf-rule-name" placeholder="ex: Meu App Web" style="width:100%;">
                </div>

                <div class="form-row" style="margin-bottom:12px;">
                    <label class="form-label">Domínio Externo (Opcional)</label>
                    <input type="text" id="cf-rule-domain" placeholder="ex: app.meudominio.com" style="width:100%;">
                </div>

                <div style="display:grid; grid-template-columns: 1fr 2fr; gap:12px; margin-bottom:12px;">
                    <div class="form-row">
                        <label class="form-label">Protocolo Interno</label>
                        <select id="cf-rule-protocol" style="width:100%;">
                            <option value="http">HTTP</option>
                            <option value="https">HTTPS</option>
                            <option value="tcp">TCP (SSH/MariaDB)</option>
                        </select>
                    </div>
                    <div class="form-row">
                        <label class="form-label">Destino Local (Host:Porta)</label>
                        <input type="text" id="cf-rule-dest" placeholder="ex: 127.0.0.1:8088" style="width:100%;">
                    </div>
                </div>

                <div class="form-row" style="margin-bottom:12px;">
                    <label class="form-label">Caminho Público (Opcional, ex: /phpmyadmin)</label>
                    <input type="text" id="cf-rule-path" placeholder="/" style="width:100%;">
                </div>
            </div>
            <div class="modal-footer" style="display:flex; justify-content:flex-end; gap:10px;">
                <button class="btn btn-secondary" onclick="closeModal('modal-cloudflare-rule')">Cancelar</button>
                <button class="btn btn-primary" onclick="saveCloudflareRule()">Criar Regra</button>
            </div>
        </div>
    </div>
"""

content = content.replace('</body>', new_modals + '\n</body>')
with open(html_file, 'w', encoding='utf-8') as f:
    f.write(content)
print("Sucesso")
