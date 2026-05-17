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
# Utilitários de detecção
# -----------------------------------------------------------------

# Detecta processo por nome parcial (mais robusto que pgrep -x)
is_running() {
    pgrep -f "$1" > /dev/null 2>&1
}

# Detecta se uma porta TCP está em uso (serviço respondendo)
port_in_use() {
    local port=$1
    (echo >/dev/tcp/127.0.0.1/$port) 2>/dev/null && return 0 || return 1
}

# -----------------------------------------------------------------
# 1. INICIAR PHP-FPM
# -----------------------------------------------------------------
start_phpfpm() {
    # Verifica por nome parcial (cobre php-fpm, php-fpm8.2, php-fpm8.3...)
    if is_running "php-fpm"; then
        ok "PHP-FPM já está rodando."
        return
    fi

    # Verifica se a porta 9000 já está ocupada (pode ser outro processo)
    if port_in_use 9000; then
        ok "Porta 9000 já em uso — PHP-FPM está ativo."
        return
    fi

    log "Iniciando PHP-FPM..."

    # Garante que os diretórios necessários existem
    mkdir -p "$PREFIX/var/run" "$PREFIX/tmp"

    # Tenta iniciar em modo daemon, fallback para background
    php-fpm --daemonize 2>/dev/null \
        || php-fpm -D 2>/dev/null \
        || { php-fpm > /dev/null 2>&1 & sleep 1; }

    sleep 1

    if is_running "php-fpm" || port_in_use 9000; then
        ok "PHP-FPM iniciado com sucesso."
    else
        warn "PHP-FPM não pôde iniciar (phpMyAdmin funcionará sem PHP dinâmico)."
    fi
}

# -----------------------------------------------------------------
# 2. INICIAR MARIADB
# -----------------------------------------------------------------
start_mariadb() {
    # Verifica por nome parcial (cobre mysqld, mariadbd)
    if is_running "mysqld" || is_running "mariadbd"; then
        ok "MariaDB já está rodando."
        return
    fi

    # Verifica porta 3306
    if port_in_use 3306; then
        ok "Porta 3306 já em uso — MariaDB está ativo."
        return
    fi

    log "Iniciando MariaDB..."

    # Inicializa o banco se ainda não foi feito
    if [ ! -d "$PREFIX/var/lib/mysql/mysql" ]; then
        warn "Banco de dados não inicializado. Rodando mysql_install_db..."
        mysql_install_db 2>/dev/null
    fi

    mysqld_safe --datadir="$PREFIX/var/lib/mysql" > /dev/null 2>&1 &

    sleep 3

    if is_running "mysqld" || is_running "mariadbd" || port_in_use 3306; then
        ok "MariaDB iniciado com sucesso."
    else
        warn "MariaDB não está respondendo (gerenciamento de banco pode ser limitado)."
    fi
}

# -----------------------------------------------------------------
# 3. INICIAR NGINX
# -----------------------------------------------------------------
start_nginx() {
    # Verifica por nome parcial
    if is_running "nginx"; then
        ok "NGINX já está rodando."
        return
    fi

    # Verifica porta 80 ou 8080
    if port_in_use 80 || port_in_use 8080; then
        ok "NGINX já está ativo (porta 80 ou 8080 em uso)."
        return
    fi

    log "Iniciando NGINX..."
    nginx 2>/dev/null

    sleep 1

    if is_running "nginx" || port_in_use 8080; then
        ok "NGINX iniciado com sucesso."
    else
        # Testa o config antes de reportar erro
        CONFIG_ERR=$(nginx -t 2>&1)
        warn "NGINX não pôde iniciar."
        warn "Erro de configuração: $CONFIG_ERR"
    fi
}

# -----------------------------------------------------------------
# 4. INICIAR PAINEL NODE.JS (com loop infinito de auto-restart)
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
