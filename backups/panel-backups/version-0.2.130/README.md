# ☁️ Termux cPanel (Professional Management Dashboard)

Um painel de gerenciamento web de alto nível, mobile-first e ultra-responsivo para transformar seu **Termux** (Android) em um servidor de hospedagem profissional.

![App Preview](https://img.shields.io/badge/Interface-Premium-blue)
![Theme](https://img.shields.io/badge/Theme-Dark%20Neon%20|%20Light%20Pro-purple)
![Responsive](https://img.shields.io/badge/Responsive-All%20Devices-green)

## 🚀 Funcionalidades Principais

### 📊 Monitoramento em Tempo Real
- Visualização de uso de **CPU, Memória RAM e Armazenamento**.
- Gráficos de tráfego de rede (Upload/Download).
- Status de bateria e temperatura do hardware.

### 📁 Gerenciamento de Arquivos
- Navegador de arquivos integrado.
- Upload, download, edição e exclusão de arquivos diretamente pelo navegador.
- Visualização rápida de conteúdos de texto e logs.

### 💻 Terminal SSH Web
- Terminal totalmente funcional integrado (via Xterm.js).
- Conexão segura via Socket.io.
- Gerenciamento remoto total sem precisar de apps extras.

### 🗄️ Banco de Dados (MariaDB/MySQL)
- Assistente de configuração inicial.
- Criação de bancos de dados, usuários e senhas.
- Atribuição automática de privilégios.
- Interface simplificada para visualização de tabelas.

### 🌐 Proxy Reverso (NGINX)
- Gerenciamento de sites e domínios.
- Criação rápida de arquivos de configuração `.conf`.
- Redirecionamento de portas facilitado para seus apps.

### 🕒 Automação e Utilidades
- **Cronjobs**: Edite e gerencie tarefas agendadas.
- **No-IP Updater**: Atualizador nativo de DDNS com suporte a IPv6 e auto-start.
- **Sistema de Backup**: Gere backups completos (`.tar.gz`) do servidor + Dumps do banco de dados com um clique.

### 🛠️ Controles de Sistema
- **Reiniciar**: Reinicia o Termux (requer Root).
- **Wake Lock**: Mantém o Termux ativo em segundo plano.
- **SSHD**: Liga/Desliga o servidor SSH nativo.

## 🎨 Design & UX
- **Dual Theme**: Alterne entre o modo **Light Pro** (visual corporativo clean) e **Dark Neon** (estética Cyberpunk/Hacker).
- **App Look**: Navegação inferior em dispositivos móveis e layout com Glassmorphism.
- **Performance**: Interface leve construída com Vanilla JS e CSS puro para máxima velocidade no Android.

## 🛠️ Tecnologias Utilizadas
- **Backend**: Node.js & Express.
- **Comunicação**: Socket.io (Real-time).
- **Ícones**: Lucide Icons.
- **Terminal**: Xterm.js.
- **Estilos**: CSS3 Moderno (Variables & Grid).

## 📥 Instalação e Gerenciamento

O painel inclui um script de gerenciamento automatizado (`install.sh`) que cuida da instalação, atualização e desinstalação.

### 🚀 Opção A: Instalação via Pacote (Recomendado)
Se você baixou o arquivo `termux-panel-dist.tar.gz`:
1. Mova o arquivo para o seu diretório home no Termux.
2. Descompacte:
   ```bash
   tar -xzvf termux-panel-dist.tar.gz
   ```
3. Entre na pasta, execute o instalador e volte:
   ```bash
   cd termux-panel && chmod +x install.sh && ./install.sh && cd ..
   ```

### 📋 Opções do Menu Management
- **1) Instalar/Reconfigurar**: Instala dependências e configura seu usuário/senha.
- **2) Atualizar**: Sincroniza as bibliotecas do sistema.
- **3) Limpar Dados**: Remove configurações e backups, resetando o painel.
- **4) Remover Sistema**: Desinstala as dependências do Termux.

## 📦 Empacotamento para Distribuição
Para criar seu próprio pacote de instalação para mover para outros dispositivos:
1. Execute: `./create_bundle.sh`
2. Isso gerará o arquivo `termux-panel-dist.tar.gz` excluindo arquivos desnecessários (`node_modules`, `config` pessoal, etc).

## 🔐 Acesso ao Painel

Após a instalação, o painel estará protegido por uma tela de login.

- **Usuário Padrão**: `admin`
- **Senha Padrão**: `admin`
- **URL**: `http://localhost:8088`

> [!TIP]
> Você pode alterar o usuário e senha a qualquer momento rodando a **Opção 1** do `install.sh`.

## 🔒 Segurança
- O painel possui autenticação de sessão via cookie.
- **Importante**: Se expor o painel para a internet via Tunnel, altere a senha padrão imediatamente no arquivo `config/auth.json` ou via instalador.

---
*Desenvolvido para máxima produtividade no gerenciamento de servidores mobile.*
