#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Auto-Updater
#  Baixa da última GitHub Release e aplica a atualização
# =============================================================

# Silencia intromissões do Termius no terminal
export _termius_integration_installed="yes"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PANEL_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
CONFIG_FILE="$PANEL_DIR/config/update.json"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
BLUE="\033[0;34m"
RESET="\033[0m"

log()  { echo -e "${BLUE}[*]${RESET} $1"; }
ok()   { echo -e "${GREEN}[+]${RESET} $1"; }
warn() { echo -e "${YELLOW}[!]${RESET} $1"; }
err()  { echo -e "${RED}[-]${RESET} $1"; }

# Lê config de update
GITHUB_REPO=""
if [ -f "$CONFIG_FILE" ]; then
    GITHUB_REPO=$(python3 -c "import json,sys; d=json.load(open('$CONFIG_FILE')); print(d.get('github_repo',''))" 2>/dev/null || \
                 node -e "try{const d=require('$CONFIG_FILE');console.log(d.github_repo||'')}catch(e){}" 2>/dev/null)
fi

echo -e "${BLUE}============================================${RESET}"
echo -e "${BLUE}   TERMUX cPANEL — Atualizando painel...   ${RESET}"
echo -e "${BLUE}============================================${RESET}"
echo ""

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

            # Copia recursivamente mantendo e atualizando os diretórios locais
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
        err "Verifique se o repositório está público e tem releases geradas."
        exit 1
    fi

# -----------------------------------------------------------------
# MÉTODO 2: Git pull (se for repositório Git local)
# -----------------------------------------------------------------
elif git -C "$PANEL_DIR" rev-parse --is-inside-work-tree > /dev/null 2>&1; then
    log "Repositório Git detectado. Rodando git pull..."
    cd "$PANEL_DIR"
    git fetch --all
    git reset --hard origin/master || git reset --hard origin/main
    git pull
    ok "Código atualizado via git pull."

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
        err "Configure um repositório GitHub no painel ou coloque termux-panel-dist.tar.gz em ~/"
        exit 1
    fi
fi

# -----------------------------------------------------------------
# PÓS-ATUALIZAÇÃO
# -----------------------------------------------------------------
cd "$PANEL_DIR"
mkdir -p "$PANEL_DIR/logs"

log "Atualizando dependências Node.js..."
npm install --no-audit --no-fund

log "Aplicando configuração SSO do phpMyAdmin..."
if [ -f "$SCRIPT_DIR/setup-pma-sso.sh" ]; then
    bash "$SCRIPT_DIR/setup-pma-sso.sh"
fi

log "Verificando e iniciando PHP-FPM..."
mkdir -p "$PREFIX/var/run" "$PREFIX/tmp"
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

ok "Painel atualizado com sucesso!"
log "Encerrando para auto-restart..."
sleep 2

# Detecta a porta atual do painel de forma dinâmica
PORT=8088
SERVER_CONFIG_FILE="$PANEL_DIR/config/server.json"
if [ -f "$SERVER_CONFIG_FILE" ]; then
    PORT=$(python3 -c "import json; print(json.load(open('$SERVER_CONFIG_FILE')).get('port', 8088))" 2>/dev/null || \
           node -e "try{const d=require('$SERVER_CONFIG_FILE');console.log(d.port||8088)}catch(e){console.log(8088)}" 2>/dev/null || \
           echo 8088)
fi

# Mata o servidor para que o loop start.sh o reinicie
OLDPID=$(lsof -t -i:$PORT 2>/dev/null)
if [ -n "$OLDPID" ]; then
    kill -9 "$OLDPID" 2>/dev/null
else
    for PID in $(pgrep -f 'node .*server\.js|node server\.js|node.*termux-panel/server\.js' 2>/dev/null); do
        CWD="$(readlink "/proc/$PID/cwd" 2>/dev/null || true)"
        CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
        if [ "$CWD" != "$PANEL_DIR" ] && ! printf '%s' "$CMDLINE" | grep -F "$PANEL_DIR/server.js" >/dev/null 2>&1; then
            continue
        fi
        kill -9 "$PID" 2>/dev/null || true
    done
fi

# Se nao ha loop de auto-restart ativo, inicia pelo start.sh com lock anti-duplicidade
sleep 2
if ! lsof -t -i:$PORT > /dev/null 2>&1; then
    nohup bash "$PANEL_DIR/scripts/start.sh" > "$PANEL_DIR/panel.log" 2>&1 &
    PID_BG=$!
    ok "Painel reiniciado em background. PID: $PID_BG"
fi

exit 0
