#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Auto-Updater
#  Baixa da última GitHub Release e aplica a atualização
# =============================================================

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
    log "Baixando atualização do GitHub: $GITHUB_REPO"

    DOWNLOAD_URL="https://github.com/$GITHUB_REPO/releases/latest/download/termux-panel-dist.tar.gz"
    TMP_TAR="/data/data/com.termux/files/home/termux-panel-latest.tar.gz"

    log "URL: $DOWNLOAD_URL"

    if curl -L --fail --progress-bar -o "$TMP_TAR" "$DOWNLOAD_URL"; then
        ok "Download concluído!"

        log "Extraindo arquivos..."
        # Extrai preservando a pasta config/
        tar -xzvf "$TMP_TAR" -C "/data/data/com.termux/files/home/" \
            --strip-components=1 \
            --exclude="termux-panel/config" \
            --exclude="termux-panel/node_modules"

        rm -f "$TMP_TAR"
        ok "Arquivos extraídos com sucesso!"

    else
        err "Falha no download de $DOWNLOAD_URL"
        err "Verifique se o repositório '$GITHUB_REPO' existe e tem releases."
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
        tar -xzvf "$TAR_PATH" -C "/data/data/com.termux/files/home/" --strip-components=1
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

# Mata o servidor para que o loop start.sh o reinicie
OLDPID=$(lsof -t -i:8088 2>/dev/null)
if [ -n "$OLDPID" ]; then
    kill -9 "$OLDPID" 2>/dev/null
else
    pkill -f "server.js" 2>/dev/null || true
fi

# Se não há loop de auto-restart ativo, inicia em background
sleep 2
if ! lsof -t -i:8088 > /dev/null 2>&1; then
    nohup node "$PANEL_DIR/server.js" > "$PANEL_DIR/panel.log" 2>&1 &
    ok "Painel reiniciado em background (PID: $!)."
fi

exit 0
