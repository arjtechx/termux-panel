#!/bin/bash
# =============================================================
#  TERMUX cPANEL — WSL Installer & Runner v0.0.0.2
#  Suporta: Ubuntu, Debian, Arch, Alpine (via WSL)
# =============================================================

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
BLUE="\033[0;34m"
CYAN="\033[0;36m"
RESET="\033[0m"

banner() {
    echo -e "${BLUE}╔══════════════════════════════════════════════╗${RESET}"
    echo -e "${BLUE}║   ☁️  TERMUX cPANEL — WSL Installer          ║${RESET}"
    echo -e "${BLUE}║   v0.0.0.2-experimental                      ║${RESET}"
    echo -e "${BLUE}╚══════════════════════════════════════════════╝${RESET}"
    echo ""
}

ok()   { echo -e "${GREEN}[✓]${RESET} $1"; }
info() { echo -e "${CYAN}[•]${RESET} $1"; }
warn() { echo -e "${YELLOW}[!]${RESET} $1"; }
err()  { echo -e "${RED}[✗]${RESET} $1"; }

banner

# ── 0. Detecta distro WSL ────────────────────────────────────
DISTRO="unknown"
PKG_MGR="apt"
if [ -f /etc/os-release ]; then
    source /etc/os-release
    ID_LOWER=$(echo "$ID" | tr '[:upper:]' '[:lower:]')
    case "$ID_LOWER" in
        ubuntu|debian|linuxmint|pop) DISTRO="debian";  PKG_MGR="apt"    ;;
        fedora|rhel|centos)          DISTRO="fedora";  PKG_MGR="dnf"    ;;
        arch|manjaro)                DISTRO="arch";    PKG_MGR="pacman" ;;
        alpine)                      DISTRO="alpine";  PKG_MGR="apk"    ;;
        opensuse*)                   DISTRO="opensuse";PKG_MGR="zypper" ;;
        *)                           DISTRO="debian";  PKG_MGR="apt"    ;;
    esac
fi
info "Distro detectada: ${PRETTY_NAME:-$DISTRO} | Package manager: $PKG_MGR"
echo ""

# ── 1. Instala Node.js via NVM (universal) ───────────────────
NVM_DIR="$HOME/.nvm"

install_node_nvm() {
    info "Instalando NVM (Node Version Manager)..."
    curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash

    # Carrega nvm na sessão atual
    export NVM_DIR="$HOME/.nvm"
    [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

    if ! command -v nvm &>/dev/null; then
        err "NVM não pôde ser carregado. Tente fechar e reabrir o terminal WSL."
        exit 1
    fi

    info "Instalando Node.js LTS via NVM..."
    nvm install --lts
    nvm use --lts
    nvm alias default lts/*
    ok "Node.js $(node -v) instalado via NVM."
}

# Carrega nvm se já estiver instalado
[ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"

if ! command -v node &>/dev/null; then
    warn "Node.js não encontrado. Instalando automaticamente..."

    # Tenta instalar curl se necessário
    if ! command -v curl &>/dev/null; then
        info "Instalando curl..."
        case "$PKG_MGR" in
            apt)    sudo apt-get update -qq && sudo apt-get install -y curl ;;
            dnf)    sudo dnf install -y curl ;;
            pacman) sudo pacman -Sy --noconfirm curl ;;
            apk)    sudo apk add --no-cache curl ;;
            zypper) sudo zypper install -y curl ;;
        esac
    fi

    install_node_nvm
else
    NODE_VER=$(node -v)
    ok "Node.js $NODE_VER já instalado."
    # Atualiza para LTS se versão muito antiga
    MAJOR=$(echo "$NODE_VER" | sed 's/v\([0-9]*\).*/\1/')
    if [ "$MAJOR" -lt 16 ]; then
        warn "Versão $NODE_VER é muito antiga. Atualizando para LTS..."
        [ -s "$NVM_DIR/nvm.sh" ] && source "$NVM_DIR/nvm.sh"
        if command -v nvm &>/dev/null; then
            nvm install --lts && nvm use --lts && nvm alias default lts/*
            ok "Node.js $(node -v) atualizado."
        else
            install_node_nvm
        fi
    fi
fi

# ── 2. Navega para o diretório do projeto ────────────────────
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR" || { err "Não foi possível entrar na pasta do projeto."; exit 1; }
info "Diretório do projeto: $SCRIPT_DIR"

# ── 3. Remove system.json estático (auto-detecção cuida disso) ──
if [ -f "config/system.json" ]; then
    # Verifica se é o arquivo estático antigo (sem campo 'type')
    if ! grep -q '"type"' config/system.json 2>/dev/null; then
        warn "Removendo config/system.json estático antigo (será auto-gerado)..."
        rm -f config/system.json
    fi
fi
mkdir -p config

# ── 4. Instala dependências npm ──────────────────────────────
info "Instalando dependências npm..."
# Remove node_modules Windows (arquitetura incompatível com Linux)
if [ -d node_modules ] && file node_modules/.bin/node 2>/dev/null | grep -q "PE32"; then
    warn "node_modules compilados para Windows detectados. Removendo para recompilar no Linux..."
    rm -rf node_modules
fi

npm install --no-audit --no-fund --prefer-offline 2>&1 | tail -5
ok "Dependências instaladas."

# ── 5. Garante que as pastas necessárias existem ─────────────
mkdir -p logs data backups config
[ ! -f config/apps.json ]  && echo "[]" > config/apps.json
[ ! -f config/hosting.json ] && echo "[]" > config/hosting.json
[ ! -f config/auth.json ]  && echo '{"user":"admin","pass":"admin"}' > config/auth.json
[ ! -f config/noip.json ]  && echo '{"interval":15,"autostart":false}' > config/noip.json
[ ! -f config/db.json ]    && echo '{"host":"localhost","user":"root","password":""}' > config/db.json

# ── 6. Inicia o servidor ─────────────────────────────────────
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}║  ✅  Painel iniciando...                     ║${RESET}"
echo -e "${GREEN}║  🌐  http://localhost:8088                   ║${RESET}"
echo -e "${GREEN}║  👤  Usuário: admin  |  Senha: admin         ║${RESET}"
echo -e "${GREEN}╚══════════════════════════════════════════════╝${RESET}"
echo ""

node server.js
