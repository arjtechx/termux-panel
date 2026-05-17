#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Start Script com Auto-Restart
#  Auto-detecta o diretório do painel
# =============================================================

# Auto-detecta a pasta do painel a partir do local deste script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PANEL_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
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

echo ""
echo -e "${BLUE}============================================${RESET}"
echo -e "${BLUE}   TERMUX cPANEL — Iniciando serviços...   ${RESET}"
echo -e "${BLUE}============================================${RESET}"
log "Diretório do painel: $PANEL_DIR"
echo ""

# -----------------------------------------------------------------
# Verifica se server.js existe antes de qualquer coisa
# -----------------------------------------------------------------
if [ ! -f "$PANEL_DIR/server.js" ]; then
    err "server.js não encontrado em: $PANEL_DIR"
    err "Verifique se extraiu o tar.gz corretamente."
    err "Dica: tar -xzvf termux-panel-dist.tar.gz -C ~/"
    exit 1
fi

# -----------------------------------------------------------------
# 1. PHP-FPM — tenta iniciar e interpreta erro de "já rodando"
# -----------------------------------------------------------------
log "Verificando PHP-FPM..."
mkdir -p "$PREFIX/var/run" "$PREFIX/tmp"

PHPOUT=$(php-fpm --daemonize 2>&1)
PHPCODE=$?
if [ $PHPCODE -eq 0 ]; then
    ok "PHP-FPM iniciado."
elif echo "$PHPOUT" | grep -qi "already in use\|already running"; then
    ok "PHP-FPM já está rodando."
else
    warn "PHP-FPM: $PHPOUT" | head -1
fi

# -----------------------------------------------------------------
# 2. MARIADB — testa conexão real primeiro
# -----------------------------------------------------------------
log "Verificando MariaDB..."
if mysql -u root -e "SELECT 1" > /dev/null 2>&1; then
    ok "MariaDB já está rodando."
else
    # Inicializa se necessário
    if [ ! -d "$PREFIX/var/lib/mysql/mysql" ]; then
        warn "Inicializando banco de dados..."
        mysql_install_db 2>/dev/null
    fi
    mysqld_safe --datadir="$PREFIX/var/lib/mysql" > /dev/null 2>&1 &
    sleep 3
    if mysql -u root -e "SELECT 1" > /dev/null 2>&1; then
        ok "MariaDB iniciado."
    else
        warn "MariaDB não respondeu. Gerenciamento de banco pode ser limitado."
    fi
fi

# -----------------------------------------------------------------
# 3. NGINX — tenta iniciar, faz reload se já estiver rodando
# -----------------------------------------------------------------
log "Verificando NGINX..."
NGOUT=$(nginx 2>&1)
NGCODE=$?
if [ $NGCODE -eq 0 ]; then
    ok "NGINX iniciado."
elif echo "$NGOUT" | grep -qi "already in use\|bind() to.*failed\|already running"; then
    nginx -s reload 2>/dev/null && ok "NGINX já rodando — recarregado." || ok "NGINX já ativo."
else
    warn "NGINX: $(echo "$NGOUT" | head -1)"
fi

# -----------------------------------------------------------------
# 4. PAINEL NODE.JS — loop infinito de auto-restart
# -----------------------------------------------------------------
echo ""
ok "Todos os serviços verificados! Iniciando painel..."

cd "$PANEL_DIR"

# Mata qualquer instância antiga na porta 8088
OLDPID=$(lsof -t -i:8088 2>/dev/null)
if [ -n "$OLDPID" ]; then
    log "Encerrando instância anterior (PID: $OLDPID)..."
    kill -9 "$OLDPID" 2>/dev/null
    sleep 1
else
    # Fallback robusto usando fuser e pkill caso lsof não esteja disponível
    fuser -k 8088/tcp >/dev/null 2>&1
    pkill -9 -f "node.*server.js" 2>/dev/null || true
    sleep 1
fi

ok "Auto-restart ativado — painel reinicia se cair."
log "Acesse: http://0.0.0.0:8088"
echo ""

while true; do
    node "$PANEL_DIR/server.js"
    warn "Servidor encerrado. Reiniciando em 3s..."
    sleep 3
done
