import re

html_file = 'public/index.html'

with open(html_file, 'r', encoding='utf-8') as f:
    content = f.read()

# Procura o bloco "Rede & Acesso Externo Card" e seus vizinhos
pattern = re.compile(r'<!-- Rede & Acesso Externo Card -->.*?<!-- Admin Auth Card -->', re.DOTALL)

new_content = """<!-- MÓDULO: REDE, SSL & CLOUDFLARE -->
                    <div class="card" style="grid-column: 1 / -1;">
                        <h3 class="card-title" style="margin-bottom:8px; display:flex; align-items:center;">
                            <i data-lucide="globe" style="color:var(--info); margin-right:8px;"></i> Rede, SSL & Acesso Externo
                        </h3>
                        <div style="background:rgba(239,68,68,0.1); border-left:4px solid var(--danger); padding:12px; border-radius:4px; margin-bottom:16px;">
                            <strong style="color:var(--danger); display:block; margin-bottom:4px;">Aviso Importante sobre Porta 80:</strong>
                            <span style="font-size:0.85rem; color:var(--text-color);">No Android/Termux, a porta 80 pode estar bloqueada por permissões do sistema, CGNAT ou operadora. A emissão automática oficial Let's Encrypt via HTTP Challenge pode falhar. Escolha abaixo alternativas 100% funcionais para ambientes móveis.</span>
                        </div>

                        <!-- 3 Cards de Modos SSL -->
                        <h4 style="margin-bottom:12px; font-size:1rem; border-bottom:1px solid var(--border-color); padding-bottom:6px;">1. Escolha o modo de HTTPS</h4>
                        <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px;">
                            
                            <!-- Upload Manual -->
                            <div style="background:var(--bg-secondary); padding:16px; border-radius:6px; border:1px solid var(--border-color);">
                                <h5 style="color:var(--success); margin-bottom:8px; display:flex; align-items:center;"><i data-lucide="upload-cloud" style="width:16px; margin-right:6px;"></i> Upload Manual</h5>
                                <ul style="font-size:0.75rem; color:var(--text-muted); margin-bottom:12px; padding-left:16px;">
                                    <li>Mais compatível</li>
                                    <li>Não exige porta 80</li>
                                    <li>Requer gerar fora do painel (ZeroSSL)</li>
                                </ul>
                                <button class="btn btn-secondary btn-sm btn-block" onclick="openModal('modal-ssl-manual')">Configurar Manual</button>
                            </div>

                            <!-- DuckDNS -->
                            <div style="background:var(--bg-secondary); padding:16px; border-radius:6px; border:1px solid var(--border-color);">
                                <h5 style="color:var(--primary); margin-bottom:8px; display:flex; align-items:center;"><i data-lucide="zap" style="width:16px; margin-right:6px;"></i> DNS Automático (DuckDNS)</h5>
                                <ul style="font-size:0.75rem; color:var(--text-muted); margin-bottom:12px; padding-left:16px;">
                                    <li>100% Automático</li>
                                    <li>Não exige porta 80 (Funciona no 4G/CGNAT)</li>
                                    <li>Requer Token DuckDNS</li>
                                </ul>
                                <button class="btn btn-primary btn-sm btn-block" onclick="openModal('modal-ssl-duckdns')">Configurar DuckDNS</button>
                            </div>

                            <!-- Autoassinado -->
                            <div style="background:var(--bg-secondary); padding:16px; border-radius:6px; border:1px solid var(--border-color);">
                                <h5 style="color:var(--warning); margin-bottom:8px; display:flex; align-items:center;"><i data-lucide="lock" style="width:16px; margin-right:6px;"></i> Autoassinado</h5>
                                <ul style="font-size:0.75rem; color:var(--text-muted); margin-bottom:12px; padding-left:16px;">
                                    <li>Funciona offline / Rápido</li>
                                    <li>Avisa "site inseguro" no navegador</li>
                                    <li>Ideal para testes/uso pessoal</li>
                                </ul>
                                <button class="btn btn-secondary btn-sm btn-block" onclick="openModal('modal-ssl-selfsigned')">Gerar Local</button>
                            </div>
                        </div>

                        <!-- Cloudflare Tunnel & Proxy -->
                        <h4 style="margin-bottom:12px; font-size:1rem; border-bottom:1px solid var(--border-color); padding-bottom:6px;">2. Cloudflare Tunnel & Proxy Reverso</h4>
                        <div style="background:var(--bg-secondary); border-radius:6px; border:1px solid var(--border-color); padding:16px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                                <p style="font-size:0.85rem; color:var(--text-muted); margin:0;">
                                    Gerencie regras e serviços locais expostos para a internet. Alterações não derrubam túneis ativos.
                                </p>
                                <button class="btn btn-primary btn-sm" onclick="openModal('modal-cloudflare-rule')"><i data-lucide="plus" style="width:14px;"></i> Nova Regra / Túnel</button>
                            </div>
                            
                            <!-- Tabela de Tunnels -->
                            <div class="table-responsive" style="margin-bottom: 0;">
                                <table class="table" style="font-size:0.85rem;">
                                    <thead>
                                        <tr>
                                            <th>Nome da Regra</th>
                                            <th>Domínio / Rota</th>
                                            <th>Serviço Local</th>
                                            <th>Status</th>
                                            <th>Ações</th>
                                        </tr>
                                    </thead>
                                    <tbody id="cloudflare-rules-list">
                                        <tr><td colspan="5" class="text-center text-muted">Carregando regras...</td></tr>
                                    </tbody>
                                </table>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Admin Auth Card -->"""

if pattern.search(content):
    content = pattern.sub(new_content, content)
    with open(html_file, 'w', encoding='utf-8') as f:
        f.write(content)
    print("Sucesso")
else:
    print("Falha ao encontrar o bloco no html")
