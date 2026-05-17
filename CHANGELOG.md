# CHANGELOG — Termux cPanel

---

## 🏆 MARCO v1.2.2 — 2026-05-17 (Hospedagem Estabilizada & Nginx Wildcards)

### ✅ Novidades da Versão
- **Aprimoramento do Monitoramento de Status (ss -tulpn):** Para serviços PHP, Estáticos e Proxies, o status de atividade agora é monitorado unicamente através da escuta ativa de suas portas públicas (`listenPort`) no sistema via utilitário `ss` com fallback robusto, sem dependência do estado do PID do processo pai. Para apps Node/Python, a integridade do PID + porta interna (`targetPort`) segue mantida de forma independente.
- **Dynamic Port Opening ("Abrir" inteligente):** O botão "Abrir" no card de hospedagem passa a construir a URL de acesso dinamicamente com base no IP ativo de acesso do painel (`window.location.hostname`) ou domínio configurado, assegurando que o usuário consiga carregar o seu projeto em qualquer aparelho da rede local sem caminhos quebrados.
- **Wildcard Nginx default bindings:** As novas configurações criadas no Nginx passam a adotar por padrão `server_name _;` associado a `listen 0.0.0.0:PORTA;`, garantindo acessibilidade universal em toda a rede local por padrão.
- **Website PHP Custom Label:** Renomeado o selo descritivo de serviços PHP de "PHP-FPM" para "Website PHP" para melhor legibilidade no painel.

---

## 🏆 MARCO v1.2.1 — 2026-05-17 (Resiliência & Bypasses de Taxa de API)

### ✅ Novidades da Versão
- **Bypass de Limite de Taxa (Rate Limit) da API do GitHub:** Implementado um mecanismo inteligente e automatizado de **Dual-Fallback** no backend (`server.js`). Caso o GitHub retorne erros `403` ou `Timeout` de API nas consultas de check/versions, o cPanel executa uma query nativa e levíssima com `git ls-remote --tags` em background. Isso contorna completamente qualquer bloqueio de IP ou lentidão da operadora móvel.
- **Correção da Ordem de Inicialização das Configurações de Hospedagem:** Reordenadas e hasteadas as declarações de `PREFIX` e `NGINX_CONF_DIR` para o início do bloco correspondente, eliminando eventuais erros de referência durante chamadas aos endpoints.
- **Estabilização da Sintaxe do Backend:** Corrigido o fechamento do bloco `catch` na rota de verificação do sistema, assegurando 100% de conformidade sintática no interpretador V8 do Node.js.

---

## 🏆 MARCO v1.2.0 — 2026-05-17 (Hospedagem Unificada)

**Nova aba premium unificando Websites (PHP/HTML), Apps (Node.js/Python) e Proxies Reversos!**

### ✅ Novidades da Versão
- **Aba Hospedagem ("Sites & Apps"):** Nova aba premium completa, substituindo a antiga "NGINX" do menu lateral.
- **Visual Curado & Responsivo:** Layout de grid de cards com filtros rápidos, badges coloridos, monitoramento integrado e animações fluidas.
- **Portas & Segurança (Regras do NGINX):** Escuta automática das portas públicas sob o endereço genérico `0.0.0.0` para permitir acesso instantâneo de outros aparelhos na rede local (ex: `192.168.1.103`), eliminando erros de amarração com `127.0.0.1`.
- **Validação com `nginx -t` preventiva:** Todas as configurações de servidores virtuais são validadas sintaticamente antes de serem gravadas no cPanel. Em caso de erro, o painel descarta o arquivo inválido automaticamente (rollback) e exibe o erro claro para o usuário.
- **App Daemon & Process Checker:** Novo monitor inteligente de aplicativos que valida se um serviço Node/Python está realmente "online" com base no PID e na escuta ativa de sua porta interna (`targetPort`).
- **Auto-Restart Background Loop:** Processo de background que monitora a saúde das aplicações a cada 15 segundos e restabelece serviços com falha automaticamente de forma totalmente autônoma.
- **Visualizador de Logs integrado:** Acompanhamento em tempo real das saídas padrão (`stdout`) e de erro (`stderr`) dos servidores e apps diretamente no painel.

---

## 🏆 MARCO v1.0 — 2026-05-16

**Git Tag:** `v1.0-marco`
**Commit:** `03f34f1`

### ✅ Funcionalidades Presentes neste Marco

#### Interface & Layout
- **AppShell** — Navbar fixa no topo + Sidebar lateral + Área de conteúdo com scroll independente
- **Boot Sequence** — Tela de inicialização com terminal de logs animado e barra de progresso
- **Temas** — Dark Mode e Light Mode com toggle, salvo no localStorage
- **Responsivo** — Mobile nav no rodapé, sidebar deslizante no celular

#### Módulos Funcionais
| Módulo | Status |
|---|---|
| Dashboard (CPU, RAM, Temp, Storage, Rede) | ✅ |
| Gerenciador de Apps | ✅ |
| Tabela de Processos | ✅ |
| Gerenciador de Arquivos | ✅ |
| Terminal SSH Web | ✅ |
| Banco de Dados (MariaDB) | ✅ |
| NGINX Virtual Hosts | ✅ |
| Cronjobs Editor | ✅ |
| NO-IP IPv6 | ✅ |
| Visualizador de Logs | ✅ |
| Backups | ✅ |
| Documentação (Markdown) | ✅ |

#### Controles da Sidebar
- Reiniciar servidor (ROOT)
- Wake Lock / SSHD / MariaDB

#### Arquitetura
- `public/index.html` — Estrutura completa AppShell com todos os módulos
- `public/style.css` — CSS Premium v4.0 com variáveis de tema, animações, grid responsiva
- `public/app.js` — Core Logic v4.0 com boot sequence, safeFetch, Socket.io, navegação

---

### 🔄 Como restaurar este Marco

Se o visual quebrar no futuro, execute:

```bash
git checkout v1.0-marco -- public/index.html public/style.css public/app.js
```

Isso vai restaurar exatamente os arquivos visuais deste momento, sem alterar o `server.js`.

---
