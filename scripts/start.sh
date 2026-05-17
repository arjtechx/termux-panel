#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Start Script com Auto-Restart
#  Estratégia: tenta iniciar cada serviço e interpreta a saída
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
# Tenta iniciar e detecta se já estava rodando pelo erro de porta
# -----------------------------------------------------------------
start_phpfpm() {
    log "Iniciando PHP-FPM..."

    mkdir -p "$PREFIX/var/run" "$PREFIX/tmp"

    # Captura stdout+stderr juntos para analisar o resultado
    OUTPUT=$(php-fpm --daemonize 2>&1)
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        ok "PHP-FPM iniciado com sucesso."
        return
    fi

    # Se o erro é "Address already in use" → PHP-FPM JÁ ESTAVA RODANDO
    if echo "$OUTPUT" | grep -qi "address already in use\|already running\|already started"; then
        ok "PHP-FPM já estava rodando (porta ocupada — OK)."
        return
    fi

    # Fallback: tenta modo background simples
    php-fpm 2>/dev/null &
    sleep 1

    # Testa se php-cli responde (indicativo de que o ambiente PHP existe)
    if command -v php > /dev/null 2>&1; then
        warn "PHP-FPM pode não ter iniciado, mas PHP está disponível no sistema."
    else
        warn "PHP-FPM e PHP não encontrados. phpMyAdmin funcionará em modo limitado."
    fi
}

# -----------------------------------------------------------------
# 2. INICIAR MARIADB
# Tenta conectar primeiro, inicia só se necessário
# -----------------------------------------------------------------
start_mariadb() {
    log "Iniciando MariaDB..."

    # Teste rápido de conexão real com mysql client
    if mysql -u root -e "SELECT 1" > /dev/null 2>&1; then
        ok "MariaDB já está rodando (conexão testada)."
        return
    fi

    # Inicializa o banco se ainda não foi feito
    if [ ! -d "$PREFIX/var/lib/mysql/mysql" ]; then
        warn "Banco de dados não inicializado. Rodando mysql_install_db..."
        mysql_install_db 2>/dev/null
    fi

    # Inicia em background
    mysqld_safe --datadir="$PREFIX/var/lib/mysql" > /dev/null 2>&1 &
    MYSQLD_PID=$!

    # Aguarda até 8 segundos testando conexão
    for i in 1 2 3 4 5 6 7 8; do
        sleep 1
        if mysql -u root -e "SELECT 1" > /dev/null 2>&1; then
            ok "MariaDB iniciado com sucesso."
            return
        fi
    done

    warn "MariaDB não respondeu a tempo. Gerenciamento de banco pode ser limitado."
}

# -----------------------------------------------------------------
# 3. INICIAR NGINX
# Tenta iniciar, detecta se já rodava pelo erro ou pelo reload
# -----------------------------------------------------------------
start_nginx() {
    log "Iniciando NGINX..."

    OUTPUT=$(nginx 2>&1)
    EXIT_CODE=$?

    if [ $EXIT_CODE -eq 0 ]; then
        ok "NGINX iniciado com sucesso."
        return
    fi

    # Se o bind falhou → NGINX JÁ ESTAVA RODANDO → tenta reload
    if echo "$OUTPUT" | grep -qi "address already in use\|bind() to.*failed\|already running"; then
        nginx -s reload 2>/dev/null && ok "NGINX já estava rodando. Configuração recarregada." || ok "NGINX já estava ativo."
        return
    fi

    # Mostra o erro real de configuração para diagnóstico
    warn "NGINX não pôde iniciar. Erro:"
    echo "$OUTPUT" | head -5
    warn "Rode 'nginx -t' no Termux para ver o erro completo."
}

# -----------------------------------------------------------------
# 4. INICIAR PAINEL NODE.JS (loop infinito de auto-restart)
# -----------------------------------------------------------------
start_panel() {
    if [ ! -d "$PANEL_DIR" ]; then
        err "Pasta do painel não encontrada: $PANEL_DIR"
        exit 1
    fi

    cd "$PANEL_DIR"

    # Mata qualquer instância anterior na porta 8088
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
        warn "Servidor encerrado (código: $EXIT_CODE). Reiniciando em 3 segundos..."
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
