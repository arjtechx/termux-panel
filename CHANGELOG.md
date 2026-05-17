# CHANGELOG — Termux cPanel

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
