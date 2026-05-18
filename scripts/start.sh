#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Start Script com Auto-Restart v3.0
#  Compatível: Termux sem root, com root, Linux Padrão
#  SEM: sudo, systemctl, service, pkg autoremove, ufw
# =============================================================

export _termius_integration_installed="yes"

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PANEL_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
RUNTIME_DIR="$PANEL_DIR/.runtime"
START_LOCK_DIR="$RUNTIME_DIR/start.lock"
START_LOCK_PID="$START_LOCK_DIR/pid"

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
BLUE="\033[0;34m"
CYAN="\033[0;36m"
RESET="\033[0m"

log()  { echo -e "${BLUE}[*]${RESET} $1"; }
ok()   { echo -e "${GREEN}[+]${RESET} $1"; }
warn() { echo -e "${YELLOW}[!]${RESET} $1"; }
err()  { echo -e "${RED}[-]${RESET} $1"; }

echo ""
echo -e "${BLUE}============================================${RESET}"
echo -e "${BLUE}   TERMUX cPANEL — Iniciando serviços...   ${RESET}"
echo -e "${BLUE}============================================${RESET}"
log "Diretório: $PANEL_DIR"
echo ""

mkdir -p "$PANEL_DIR/logs"
mkdir -p "$RUNTIME_DIR"

# Garante que exista apenas um loop start.sh cuidando do painel.
if ! mkdir "$START_LOCK_DIR" 2>/dev/null; then
    OLD_START_PID="$(cat "$START_LOCK_PID" 2>/dev/null || true)"
    if [ -n "$OLD_START_PID" ] && kill -0 "$OLD_START_PID" 2>/dev/null; then
        warn "Loop start.sh anterior detectado (PID: $OLD_START_PID). Encerrando duplicado..."
        kill "$OLD_START_PID" 2>/dev/null || true
        sleep 1
        kill -9 "$OLD_START_PID" 2>/dev/null || true
    fi
    rm -rf "$START_LOCK_DIR"
    mkdir "$START_LOCK_DIR" 2>/dev/null || {
        err "NÃ£o foi possÃ­vel criar lock de inicializaÃ§Ã£o."
        exit 1
    }
fi
echo "$$" > "$START_LOCK_PID"
trap 'rm -rf "$START_LOCK_DIR"' EXIT INT TERM

cleanup_termux_api_duplicates() {
    # termux-battery-status pode travar e acumular subprocessos se chamado em paralelo.
    PIDS="$(pgrep -f 'termux-battery-status|termux-api BatteryStatus' 2>/dev/null | sort -n)"
    KEEP="$(printf '%s\n' "$PIDS" | tail -n 1)"
    for PID in $PIDS; do
        [ -z "$PID" ] && continue
        [ "$PID" = "$KEEP" ] && continue
        kill -9 "$PID" 2>/dev/null || true
    done
}

cleanup_panel_duplicates() {
    CURRENT_PID="${1:-}"
    PIDS="$(pgrep -f 'node .*server\.js|node server\.js|node.*termux-panel/server\.js' 2>/dev/null | sort -n)"
    for PID in $PIDS; do
        [ -z "$PID" ] && continue
        [ "$PID" = "$CURRENT_PID" ] && continue
        CWD="$(readlink "/proc/$PID/cwd" 2>/dev/null || true)"
        CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
        if [ "$CWD" != "$PANEL_DIR" ] && ! printf '%s' "$CMDLINE" | grep -F "$PANEL_DIR/server.js" >/dev/null 2>&1; then
            continue
        fi
        log "Encerrando instÃ¢ncia duplicada do painel (PID: $PID)..."
        kill "$PID" 2>/dev/null || true
        sleep 1
        kill -9 "$PID" 2>/dev/null || true
    done
}

cleanup_termux_api_duplicates

# Verifica server.js
if [ ! -f "$PANEL_DIR/server.js" ]; then
    err "server.js não encontrado em: $PANEL_DIR"
    err "Extraia corretamente: tar -xzvf termux-panel-dist.tar.gz -C ~/"
    exit 1
fi

# ─── Lê credenciais do banco salvas pelo instalador ─────────────
DB_USER="root"
DB_PASS=""
DB_PORT="3306"
DB_CONFIG="$PANEL_DIR/config/database.json"
DB_FILE="$PANEL_DIR/config/db.json"

if [ -f "$DB_CONFIG" ]; then
    DB_USER=$(python3 -c "import json; d=json.load(open('$DB_CONFIG')); print(d.get('user','root'))" 2>/dev/null || echo "root")
    DB_PASS=$(python3 -c "import json; d=json.load(open('$DB_CONFIG')); print(d.get('password',''))" 2>/dev/null || echo "")
    DB_PORT=$(python3 -c "import json; d=json.load(open('$DB_CONFIG')); print(d.get('port',3306))" 2>/dev/null || echo "3306")
elif [ -f "$DB_FILE" ]; then
    DB_USER=$(python3 -c "import json; d=json.load(open('$DB_FILE')); print(d.get('user','root'))" 2>/dev/null || echo "root")
    DB_PASS=$(python3 -c "import json; d=json.load(open('$DB_FILE')); print(d.get('password',''))" 2>/dev/null || echo "")
fi

MYSQL_DATA_DIR="$PREFIX/var/lib/mysql"

# ─── 1. PHP-FPM ─────────────────────────────────────────────────
log "Verificando PHP-FPM..."
mkdir -p "$PREFIX/var/run" "$PREFIX/tmp"

if command -v php-fpm >/dev/null 2>&1; then
    PHPOUT=$(php-fpm --daemonize 2>&1)
    PHPCODE=$?
    if [ $PHPCODE -eq 0 ]; then
        ok "PHP-FPM iniciado."
    elif echo "$PHPOUT" | grep -qi "already in use\|already running"; then
        ok "PHP-FPM já está rodando."
    else
        warn "PHP-FPM: $(echo "$PHPOUT" | head -1)"
    fi
else
    warn "PHP-FPM não instalado. Pulando."
fi

# ─── 2. MARIADB — detecção inteligente e inicialização ──────────
log "Verificando MariaDB..."

mariadb_is_running() {
    if mysql -u "$DB_USER" ${DB_PASS:+-p"$DB_PASS"} -e "SELECT 1" >/dev/null 2>&1; then
        return 0
    fi
    # Fallback: tenta root sem senha (instalação nova)
    if mysql -u root -e "SELECT 1" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

start_mariadb_daemon() {
    # Inicializa estrutura se necessário
    if [ ! -d "$MYSQL_DATA_DIR/mysql" ]; then
        warn "Banco de dados não inicializado. Inicializando..."
        if command -v mariadb-install-db >/dev/null 2>&1; then
            mariadb-install-db >/dev/null 2>&1
        elif command -v mysql_install_db >/dev/null 2>&1; then
            mysql_install_db >/dev/null 2>&1
        else
            err "Inicializador do MariaDB não encontrado!"
            return 1
        fi
    fi

    # Inicia o daemon — SEM systemctl, SEM service
    if command -v mariadbd-safe >/dev/null 2>&1; then
        mariadbd-safe --datadir="$MYSQL_DATA_DIR" >/dev/null 2>&1 &
    elif command -v mysqld_safe >/dev/null 2>&1; then
        mysqld_safe --datadir="$MYSQL_DATA_DIR" >/dev/null 2>&1 &
    elif command -v mariadbd >/dev/null 2>&1; then
        mariadbd --datadir="$MYSQL_DATA_DIR" --user="$(whoami)" >/dev/null 2>&1 &
    elif command -v mysqld >/dev/null 2>&1; then
        mysqld --datadir="$MYSQL_DATA_DIR" --user="$(whoami)" >/dev/null 2>&1 &
    else
        err "Nenhum daemon MariaDB/MySQL encontrado!"
        return 1
    fi

    # Aguarda resposta (até 20s)
    local tries=0
    while [ $tries -lt 10 ]; do
        sleep 2
        if mariadb_is_running; then
            return 0
        fi
        tries=$((tries + 1))
    done
    return 1
}

if mariadb_is_running; then
    ok "MariaDB já está rodando."
else
    log "Iniciando MariaDB..."
    if start_mariadb_daemon; then
        ok "MariaDB iniciado com sucesso."
    else
        warn "MariaDB não respondeu. Gerenciamento de banco pode ser limitado."
    fi
fi

# ─── 3. NGINX ────────────────────────────────────────────────────
log "Verificando NGINX..."
if command -v nginx >/dev/null 2>&1; then
    NGOUT=$(nginx 2>&1)
    NGCODE=$?
    if [ $NGCODE -eq 0 ]; then
        ok "NGINX iniciado."
    elif echo "$NGOUT" | grep -qi "already in use\|bind().*failed\|already running"; then
        nginx -s reload 2>/dev/null && ok "NGINX recarregado." || ok "NGINX já ativo."
    else
        warn "NGINX: $(echo "$NGOUT" | head -1)"
    fi
else
    warn "NGINX não instalado. Pulando."
fi

# ─── 4. PAINEL NODE.JS ───────────────────────────────────────────
echo ""
ok "Serviços verificados! Iniciando painel Node.js..."

cd "$PANEL_DIR"

# Detecta porta configurada
PORT=8088
SERVER_CONFIG_FILE="$PANEL_DIR/config/server.json"
if [ -f "$SERVER_CONFIG_FILE" ]; then
    PORT=$(python3 -c "import json; print(json.load(open('$SERVER_CONFIG_FILE')).get('port', 8088))" 2>/dev/null || \
           node -e "try{const d=require('$SERVER_CONFIG_FILE');console.log(d.port||8088)}catch(e){console.log(8088)}" 2>/dev/null || \
           echo 8088)
fi

# Mata instância anterior na porta
OLDPID=$(lsof -t -i:$PORT 2>/dev/null)
if [ -n "$OLDPID" ]; then
    log "Encerrando instância anterior (PID: $OLDPID)..."
    kill -9 "$OLDPID" 2>/dev/null
    sleep 1
else
    fuser -k $PORT/tcp >/dev/null 2>&1 || true
fi
cleanup_panel_duplicates
sleep 1

ok "Auto-restart ativado — painel reinicia se cair."
log "Acesse: http://0.0.0.0:${PORT}"
echo ""

# Root: aplica prioridade (se disponível)
if command -v su >/dev/null 2>&1 && su -c 'echo ok' >/dev/null 2>&1; then
    log "Root detectado! Aplicando prioridades VIP..."
    bash "$PANEL_DIR/scripts/prioritize.sh" >/dev/null 2>&1 &
fi

# Loop de auto-restart
while true; do
    cleanup_termux_api_duplicates
    cleanup_panel_duplicates
    node "$PANEL_DIR/server.js"
    warn "Servidor encerrado. Reiniciando em 3s..."
    sleep 3
done
