#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Start Script com Auto-Restart
#  Inicia: PHP-FPM → MariaDB → NGINX → Painel Node.js
# =============================================================

PANEL_DIR="/data/data/com.termux/files/home/termux-panel"
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

# -----------------------------------------------------------------
# 1. INICIAR PHP-FPM
# -----------------------------------------------------------------
start_phpfpm() {
    # Verifica se já está rodando
    if pgrep -x php-fpm > /dev/null 2>&1; then
        ok "PHP-FPM já está rodando."
        return
    fi

    log "Iniciando PHP-FPM..."

    # Garante que o diretório de run existe
    mkdir -p "$PREFIX/var/run"
    mkdir -p "$PREFIX/tmp"

    php-fpm --daemonize 2>/dev/null || php-fpm -D 2>/dev/null || php-fpm &

    sleep 1
    if pgrep -x php-fpm > /dev/null 2>&1; then
        ok "PHP-FPM iniciado com sucesso."
    else
        warn "PHP-FPM não pôde iniciar (phpMyAdmin funcionará sem PHP dinâmico)."
    fi
}

# -----------------------------------------------------------------
# 2. INICIAR MARIADB
# -----------------------------------------------------------------
start_mariadb() {
    if pgrep -x mysqld > /dev/null 2>&1 || pgrep -x mariadbd > /dev/null 2>&1; then
        ok "MariaDB já está rodando."
        return
    fi

    log "Iniciando MariaDB..."

    # Inicializa o banco se ainda não foi inicializado
    if [ ! -d "$PREFIX/var/lib/mysql/mysql" ]; then
        warn "Banco de dados não inicializado. Rodando mysql_install_db..."
        mysql_install_db 2>/dev/null
    fi

    mysqld_safe --datadir="$PREFIX/var/lib/mysql" > /dev/null 2>&1 &

    sleep 2
    if pgrep -x mysqld > /dev/null 2>&1 || pgrep -x mariadbd > /dev/null 2>&1; then
        ok "MariaDB iniciado com sucesso."
    else
        warn "MariaDB não está rodando (gerenciamento de banco pode ser limitado)."
    fi
}

# -----------------------------------------------------------------
# 3. INICIAR NGINX
# -----------------------------------------------------------------
start_nginx() {
    if pgrep -x nginx > /dev/null 2>&1; then
        ok "NGINX já está rodando."
        return
    fi

    log "Iniciando NGINX..."
    nginx 2>/dev/null

    sleep 1
    if pgrep -x nginx > /dev/null 2>&1; then
        ok "NGINX iniciado com sucesso."
    else
        warn "NGINX não pôde iniciar (sites estáticos e phpMyAdmin via porta 8080 indisponível)."
    fi
}

# -----------------------------------------------------------------
# 4. INICIAR PAINEL NODE.JS (com auto-restart infinito)
# -----------------------------------------------------------------
start_panel() {
    if [ ! -d "$PANEL_DIR" ]; then
        err "Pasta do painel não encontrada: $PANEL_DIR"
        exit 1
    fi

    cd "$PANEL_DIR"

    # Mata qualquer instância antiga do servidor antes de iniciar
    OLDPID=$(lsof -t -i:8088 2>/dev/null)
    if [ -n "$OLDPID" ]; then
        log "Encerrando instância anterior do painel (PID: $OLDPID)..."
        kill -9 "$OLDPID" 2>/dev/null
        sleep 1
    fi

    ok "Sistema de auto-restart ativado. O painel reinicia automaticamente se cair."
    log "Painel acessível em: http://0.0.0.0:8088"
    echo ""

    # Loop infinito de auto-restart do Node.js
    while true; do
        log "Iniciando servidor Node.js..."
        node server.js
        EXIT_CODE=$?
        warn "Servidor encerrado (código $EXIT_CODE). Reiniciando em 3 segundos..."
        sleep 3
    done
}

# -----------------------------------------------------------------
# MAIN
# -----------------------------------------------------------------
echo ""
echo -e "${BLUE}============================================${RESET}"
echo -e "${BLUE}   TERMUX cPANEL — Iniciando serviços...   ${RESET}"
echo -e "${BLUE}============================================${RESET}"
echo ""

start_phpfpm
start_mariadb
start_nginx

echo ""
start_panel
