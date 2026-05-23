import re

html_file = 'public/index.html'

with open(html_file, 'r', encoding='utf-8') as f:
    content = f.read()

new_modals = """
    <!-- MODAL: SSL MANUAL -->
    <div id="modal-ssl-manual" class="modal">
        <div class="modal-content" style="max-width:500px;">
            <div class="modal-header">
                <h3><i data-lucide="upload-cloud"></i> Upload Manual de Certificado</h3>
                <button class="close-btn" onclick="closeModal('modal-ssl-manual')"><i data-lucide="x"></i></button>
            </div>
            <div class="modal-body">
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:12px;">Cole o conteúdo do seu Certificado e Chave gerados externamente (ex: ZeroSSL).</p>
                
                <div class="form-row" style="margin-bottom:12px;">
                    <label class="form-label">Certificado (.crt / .pem)</label>
                    <textarea id="ssl-manual-cert" rows="6" style="width:100%; font-family:monospace; font-size:0.75rem;" placeholder="-----BEGIN CERTIFICATE-----"></textarea>
                </div>

                <div class="form-row" style="margin-bottom:12px;">
                    <label class="form-label">Chave Privada (.key / .pem)</label>
                    <textarea id="ssl-manual-key" rows="6" style="width:100%; font-family:monospace; font-size:0.75rem;" placeholder="-----BEGIN PRIVATE KEY-----"></textarea>
                </div>
                
                <div id="ssl-manual-status" style="margin-top:10px; font-size:0.85rem;"></div>
            </div>
            <div class="modal-footer" style="display:flex; justify-content:space-between;">
                <button class="btn btn-secondary" onclick="validateManualSSL()">Validar Certificado</button>
                <button class="btn btn-primary" onclick="saveManualSSL()">Salvar e Aplicar</button>
            </div>
        </div>
    </div>

    <!-- MODAL: SSL DUCKDNS -->
    <div id="modal-ssl-duckdns" class="modal">
        <div class="modal-content" style="max-width:500px;">
            <div class="modal-header">
                <h3><i data-lucide="zap"></i> Certificado Automático DuckDNS</h3>
                <button class="close-btn" onclick="closeModal('modal-ssl-duckdns')"><i data-lucide="x"></i></button>
            </div>
            <div class="modal-body">
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:12px;">Validação DNS-01 sem precisar abrir porta 80. O painel se comunica direto com o DuckDNS.</p>
                
                <div class="form-row" style="margin-bottom:12px;">
                    <label class="form-label">Subdomínio (ex: meupainel.duckdns.org)</label>
                    <input type="text" id="ssl-duckdns-domain" style="width:100%;">
                </div>

                <div class="form-row" style="margin-bottom:12px;">
                    <label class="form-label">Token do DuckDNS</label>
                    <input type="password" id="ssl-duckdns-token" style="width:100%;" placeholder="abcd-1234-efgh...">
                </div>

                <div class="form-row" style="margin-bottom:12px;">
                    <label class="form-label">E-mail (para alertas de expiração)</label>
                    <input type="email" id="ssl-duckdns-email" style="width:100%;">
                </div>
                
                <div id="ssl-duckdns-status" style="margin-top:10px; font-size:0.85rem;"></div>
            </div>
            <div class="modal-footer" style="display:flex; justify-content:space-between;">
                <button class="btn btn-secondary" onclick="testDuckDNSToken()">Testar Token</button>
                <button class="btn btn-primary" onclick="issueDuckDNSCert()">Gerar Certificado</button>
            </div>
        </div>
    </div>

    <!-- MODAL: SSL AUTOASSINADO -->
    <div id="modal-ssl-selfsigned" class="modal">
        <div class="modal-content" style="max-width:400px;">
            <div class="modal-header">
                <h3><i data-lucide="lock"></i> Certificado Autoassinado</h3>
                <button class="close-btn" onclick="closeModal('modal-ssl-selfsigned')"><i data-lucide="x"></i></button>
            </div>
            <div class="modal-body">
                <p style="font-size:0.85rem; color:var(--text-muted); margin-bottom:12px;">Gera um par de chaves usando OpenSSL localmente. Rápido e não depende de internet.</p>
                
                <div class="form-row" style="margin-bottom:12px;">
                    <label class="form-label">Domínio ou IP</label>
                    <input type="text" id="ssl-self-domain" value="localhost" style="width:100%;">
                </div>
                <div class="form-row" style="margin-bottom:12px;">
                    <label class="form-label">Validade (Dias)</label>
                    <input type="number" id="ssl-self-days" value="365" style="width:100%;">
                </div>
            </div>
            <div class="modal-footer">
                <button class="btn btn-warning btn-block" onclick="createSelfSignedSSL()">Gerar e Aplicar Localmente</button>
            </div>
        </div>
    </div>
"""

content = content.replace('</body>', new_modals + '\n</body>')
with open(html_file, 'w', encoding='utf-8') as f:
    f.write(content)
print("Sucesso")
