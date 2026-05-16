# CHANGELOG — Termux cPanel

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
