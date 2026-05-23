#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Auto-Updater v4.0
#  Baixa da última GitHub Release e aplica a atualização de forma segura
# =============================================================

export _termius_integration_installed="yes"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PANEL_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
CONFIG_FILE="$PANEL_DIR/config/update.json"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"

# Configuração de logs para logs/update.log
mkdir -p "$PANEL_DIR/logs"
UPDATE_LOG="$PANEL_DIR/logs/update.log"
touch "$UPDATE_LOG" 2>/dev/null

log_file() {
  local level="$1"
  local msg="$2"
  local clean_msg="$(echo -e "$msg" | sed 's/\x1b\[[0-9;]*m//g')"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $clean_msg" >> "$UPDATE_LOG" 2>/dev/null
}

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
BLUE="\033[0;34m"
RESET="\033[0m"

log()  { echo -e "${BLUE}[*]${RESET} $1"; log_file "INFO" "$1"; }
ok()   { echo -e "${GREEN}[+]${RESET} $1"; log_file "OK" "$1"; }
warn() { echo -e "${YELLOW}[!]${RESET} $1"; log_file "WARN" "$1"; }
err()  { echo -e "${RED}[-]${RESET} $1"; log_file "ERRO" "$1"; }

echo -e "${BLUE}============================================${RESET}"
echo -e "${BLUE}   TERMUX cPANEL — Atualizando painel...   ${RESET}"
echo -e "${BLUE}============================================${RESET}"
echo ""

# -----------------------------------------------------------------
# LOCK DE ATUALIZAÇÃO EXCLUSIVO
# -----------------------------------------------------------------
LOCK_DIR="$HOME/.termux-panel-lock"
UPDATE_LOCK="$LOCK_DIR/update.lock"
mkdir -p "$LOCK_DIR"

if [ -f "$UPDATE_LOCK" ]; then
  OLD_UPDATE_PID="$(cat "$UPDATE_LOCK" 2>/dev/null)"
  if [ -n "$OLD_UPDATE_PID" ] && kill -0 "$OLD_UPDATE_PID" 2>/dev/null; then
    err "Atualização já está em andamento com PID $OLD_UPDATE_PID"
    exit 1
  else
    log "Lock antigo de atualização encontrado. Removendo..."
    rm -f "$UPDATE_LOCK"
  fi
fi

echo "$$" > "$UPDATE_LOCK"

cleanup_update_lock() {
  rm -f "$UPDATE_LOCK"
}
trap cleanup_update_lock EXIT INT TERM

# -----------------------------------------------------------------
# PARAR PAINEL ANTES DA ATUALIZAÇÃO
# -----------------------------------------------------------------
log "Parando painel antes da atualização..."
if [ -f "$PANEL_DIR/scripts/stop.sh" ]; then
  bash "$PANEL_DIR/scripts/stop.sh" || true
else
  log "Usando stop fallback..."
  for pid in $(ps -ef | grep -E "$PANEL_DIR/scripts/start.sh|bash scripts/start.sh|node .*server.js" | grep -v grep | awk '{print $2}'); do
    kill "$pid" 2>/dev/null || true
  done
fi
sleep 2

RUNNING="$(ps -ef | grep -E "$PANEL_DIR/scripts/start.sh|node .*server.js" | grep -v grep || true)"
if [ -n "$RUNNING" ]; then
  warn "Ainda existem processos do painel rodando:"
  echo "$RUNNING"
  log "Tentando força final..."
  for pid in $(echo "$RUNNING" | awk '{print $2}'); do
    kill -9 "$pid" 2>/dev/null || true
  done
fi

# Lê config de update
GITHUB_REPO=""
if [ -f "$CONFIG_FILE" ]; then
    GITHUB_REPO=$(python3 -c "import json,sys; d=json.load(open('$CONFIG_FILE')); print(d.get('github_repo',''))" 2>/dev/null || \
                 node -e "try{const d=require('$CONFIG_FILE');console.log(d.github_repo||'')}catch(e){}" 2>/dev/null)
fi

# -----------------------------------------------------------------
# MÉTODO 1: GitHub Releases (se repositório configurado)
# -----------------------------------------------------------------
if [ -n "$GITHUB_REPO" ] && [ "$GITHUB_REPO" != "null" ] && [ "$GITHUB_REPO" != "" ]; then
    TAG="latest"
    if [ -n "$1" ]; then
        TAG="$1"
        log "Versão manual solicitada via Bash: $TAG"
    else
        log "Buscando última versão (latest) do GitHub..."
    fi

    if [ "$TAG" = "latest" ]; then
        DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/latest/download/termux-panel-dist.tar.gz"
    else
        DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/download/$TAG/termux-panel-dist.tar.gz"
    fi
    TMP_TAR="/data/data/com.termux/files/home/termux-panel-$TAG.tar.gz"

    log "URL: $DOWNLOAD_URL"

    if curl -L --fail --progress-bar -o "$TMP_TAR" "$DOWNLOAD_URL"; then
        ok "Download concluído!"

        log "Extraindo arquivos do painel..."
        TMP_EXTRACT="/data/data/com.termux/files/home/tmp_extract"
        rm -rf "$TMP_EXTRACT"
        mkdir -p "$TMP_EXTRACT"

        if tar -xzvf "$TMP_TAR" -C "$TMP_EXTRACT" --strip-components=1; then
            ok "Extração básica concluída."
            log "Atualizando arquivos em: $PANEL_DIR"

            cp -rf "$TMP_EXTRACT/modules" "$PANEL_DIR/" 2>/dev/null || true
            cp -rf "$TMP_EXTRACT/public" "$PANEL_DIR/"
            cp -rf "$TMP_EXTRACT/scripts" "$PANEL_DIR/"
            cp -rf "$TMP_EXTRACT/services" "$PANEL_DIR/"
            cp -rf "$TMP_EXTRACT/src" "$PANEL_DIR/"
            cp -f "$TMP_EXTRACT/server.js" "$PANEL_DIR/"
            cp -f "$TMP_EXTRACT/install.sh" "$PANEL_DIR/"
            cp -f "$TMP_EXTRACT/package.json" "$PANEL_DIR/"
            cp -f "$TMP_EXTRACT/package-lock.json" "$PANEL_DIR/" 2>/dev/null || true
            cp -f "$TMP_EXTRACT/README.md" "$PANEL_DIR/"
            
            ok "Arquivos atualizados com sucesso!"
        else
            err "Falha ao extrair tarball."
            exit 1
        fi

        rm -rf "$TMP_EXTRACT"
        rm -f "$TMP_TAR"
    else
        err "Falha no download de $DOWNLOAD_URL"
        exit 1
    fi

# -----------------------------------------------------------------
# MÉTODO 2: Git pull (se for repositório Git local)
# -----------------------------------------------------------------
elif git -C "$PANEL_DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    log "Repositorio Git detectado. Rodando atualizacao segura..."
    cd "$PANEL_DIR"
    CURRENT_BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo main)"
    if [ -n "$(git status --porcelain 2>/dev/null)" ]; then
        warn "Mudancas locais detectadas. Nao sera usado reset --hard para nao apagar ajustes do painel."
    fi
    git fetch origin
    if ! git pull --ff-only origin "$CURRENT_BRANCH"; then
        err "Atualizacao Git bloqueada por divergencia local."
        exit 1
    fi
    ok "Codigo atualizado via git pull seguro."

# -----------------------------------------------------------------
# MÉTODO 3: Tarball manual no diretório home
# -----------------------------------------------------------------
else
    TAR_PATH="/data/data/com.termux/files/home/termux-panel-dist.tar.gz"
    if [ -f "$TAR_PATH" ]; then
        warn "Usando tarball local: $TAR_PATH"
        TMP_EXTRACT="/data/data/com.termux/files/home/tmp_extract"
        rm -rf "$TMP_EXTRACT"
        mkdir -p "$TMP_EXTRACT"
        
        tar -xzvf "$TAR_PATH" -C "$TMP_EXTRACT" --strip-components=1
        cp -rf "$TMP_EXTRACT/modules" "$PANEL_DIR/" 2>/dev/null || true
        cp -rf "$TMP_EXTRACT/public" "$PANEL_DIR/"
        cp -rf "$TMP_EXTRACT/scripts" "$PANEL_DIR/"
        cp -rf "$TMP_EXTRACT/services" "$PANEL_DIR/"
        cp -rf "$TMP_EXTRACT/src" "$PANEL_DIR/"
        cp -f "$TMP_EXTRACT/server.js" "$PANEL_DIR/"
        cp -f "$TMP_EXTRACT/install.sh" "$PANEL_DIR/"
        cp -f "$TMP_EXTRACT/package.json" "$PANEL_DIR/"
        cp -f "$TMP_EXTRACT/package-lock.json" "$PANEL_DIR/" 2>/dev/null || true
        cp -f "$TMP_EXTRACT/README.md" "$PANEL_DIR/"
        
        rm -rf "$TMP_EXTRACT"
        ok "Extraído do tarball local."
    else
        err "Nenhuma fonte de atualização disponível!"
        exit 1
    fi
fi

# -----------------------------------------------------------------
# PÓS-ATUALIZAÇÃO
# -----------------------------------------------------------------
cd "$PANEL_DIR"

log "Aplicando regras robustas do MariaDB (my.cnf) e permissões..."
mkdir -p "$PREFIX/etc"
mkdir -p "$PREFIX/var/run/mysqld"
chmod 777 "$PREFIX/var/run/mysqld" 2>/dev/null || true

MARIADB_DATA="${MARIADB_DATA:-$PREFIX/var/lib/mysql}"

if [ ! -f "$PREFIX/etc/my.cnf" ]; then
    cat <<EOF > "$PREFIX/etc/my.cnf"
[client]
socket = $PREFIX/var/run/mysqld/mysqld.sock
port = 3306

[mysqld]
socket = $PREFIX/var/run/mysqld/mysqld.sock
port = 3306
datadir = $MARIADB_DATA
bind-address = 127.0.0.1
default-storage-engine = InnoDB
innodb_file_per_table = 1
EOF
    ok "my.cnf configurado com sucesso."
fi

current_user=$(whoami)
mkdir -p "$PREFIX/var/run" "$PREFIX/var/log/nginx" "$PREFIX/var/lib/mysql" "$PREFIX/tmp" "$PREFIX/etc/nginx" "$PREFIX/etc/nginx/conf.d"
chmod -R 777 "$PREFIX/var/run" "$PREFIX/var/log/nginx" "$PREFIX/var/lib/mysql" "$PREFIX/tmp" "$PREFIX/etc/nginx" "$PREFIX/etc/nginx/conf.d" 2>/dev/null || true
chown -R "$current_user" "$PREFIX/var/run" "$PREFIX/var/log/nginx" "$PREFIX/var/lib/mysql" "$PREFIX/tmp" "$PREFIX/etc/nginx" "$PREFIX/etc/nginx/conf.d" 2>/dev/null || true
rm -f "$PREFIX/var/run/nginx.pid" 2>/dev/null || true

log "Aplicando reparo base do NGINX/mime.types..."
if [ -f "$SCRIPT_DIR/nginx-termux-repair.sh" ]; then
    sh "$SCRIPT_DIR/nginx-termux-repair.sh" || warn "Reparo NGINX/mime.types falhou."
fi

log "Aplicando dependências Node.js..."
if [ -d "node_modules" ]; then
    ok "Dependências Node já presentes."
else
    warn "Diretório node_modules não encontrado. Executando npm install..."
    npm install --no-audit --no-fund || true
fi

function ensure_cloudflared_binary() {
    if command -v cloudflared >/dev/null 2>&1; then
        return 0
    fi
    log "Aviso: 'cloudflared' não encontrado. Baixando binário oficial da Cloudflare..."
    local arch
    arch=$(uname -m)
    local download_url=""
    case "$arch" in
        x86_64) download_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" ;;
        aarch64) download_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64" ;;
        armv7l|armhf) download_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm" ;;
        i386|i686) download_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-386" ;;
        *) return 1 ;;
    esac
    local install_dest
    if echo "$PREFIX" | grep -q "com.termux"; then
        install_dest="$PREFIX/bin/cloudflared"
    else
        install_dest="/usr/local/bin/cloudflared"
    fi
    log "Baixando binário de: $download_url"
    local tmp_bin=$(mktemp)
    if curl -L -s -S -o "$tmp_bin" "$download_url"; then
        cp "$tmp_bin" "$install_dest"
        chmod +x "$install_dest"
        rm -f "$tmp_bin"
        ok "Cloudflared instalado com sucesso."
    else
        rm -f "$tmp_bin"
        warn "Falha ao baixar o cloudflared."
    fi
}
ensure_cloudflared_binary

log "Aplicando configuração SSO do phpMyAdmin..."
if [ -f "$SCRIPT_DIR/setup-pma-sso.sh" ]; then
    bash "$SCRIPT_DIR/setup-pma-sso.sh"
fi

log "Verificando e iniciando PHP-FPM..."
PHPOUT=$(php-fpm --daemonize 2>&1)
if [ $? -eq 0 ]; then
    ok "PHP-FPM iniciado."
elif echo "$PHPOUT" | grep -qi "already in use\|already running"; then
    ok "PHP-FPM já estava rodando."
fi

log "Recarregando NGINX..."
NGOUT=$(nginx 2>&1)
if [ $? -eq 0 ]; then
    ok "NGINX iniciado."
elif echo "$NGOUT" | grep -qi "already in use\|already running"; then
    nginx -s reload 2>/dev/null && ok "NGINX recarregado." || ok "NGINX ativo."
fi

# Chmod nos scripts
chmod +x "$PANEL_DIR"/scripts/*.sh 2>/dev/null || true
chmod +x "$PANEL_DIR"/scripts/lib/*.sh 2>/dev/null || true

ok "Painel atualizado com sucesso!"
log "Iniciando painel atualizado..."
nohup bash "$PANEL_DIR/scripts/start.sh" >/dev/null 2>&1 &
PID_BG=$!
ok "Painel reiniciado em background. PID: $PID_BG"

exit 0
