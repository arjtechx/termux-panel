#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Start Script com Auto-Restart v4.0
#  Compatível: Termux sem root, com root, Linux Padrão
# =============================================================

export _termius_integration_installed="yes"

# Adquire WakeLock automaticamente para manter o Android acordado
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock
fi

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PANEL_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"

# Carrega biblioteca de gerenciamento de processos
if [ -f "$PANEL_DIR/scripts/lib/process-manager.sh" ]; then
  . "$PANEL_DIR/scripts/lib/process-manager.sh"
else
  echo "[ERRO] Biblioteca process-manager.sh não encontrada!"
  exit 1
fi

# Configuração de logs para logs/start.log
mkdir -p "$PANEL_DIR/logs"
START_LOG="$PANEL_DIR/logs/start.log"
touch "$START_LOG" 2>/dev/null

log_file() {
  local level="$1"
  local msg="$2"
  local clean_msg="$(echo -e "$msg" | sed 's/\x1b\[[0-9;]*m//g')"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] [$level] $clean_msg" >> "$START_LOG" 2>/dev/null
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

echo ""
echo -e "${BLUE}============================================${RESET}"
echo -e "${BLUE}   TERMUX cPANEL — Iniciando serviços...   ${RESET}"
echo -e "${BLUE}============================================${RESET}"
log "Diretório: $PANEL_DIR"
echo ""

# ---------------------------------------------------------
# LOCK GLOBAL start.sh
# ---------------------------------------------------------
if [ -f "$START_PID_FILE" ]; then
  OLD_START_PID="$(cat "$START_PID_FILE" 2>/dev/null)"
  if [ -n "$OLD_START_PID" ] && kill -0 "$OLD_START_PID" 2>/dev/null; then
    warn "Já existe um start.sh rodando com PID $OLD_START_PID"
    log "Use scripts/stop.sh ou o botão Reinício Seguro."
    exit 0
  else
    log "Lock antigo de start.sh encontrado. Removendo..."
    rm -f "$START_PID_FILE"
  fi
fi

echo "$$" > "$START_PID_FILE"

cleanup_start_lock() {
  log "Limpando lock do start.sh..."
  rm -f "$START_PID_FILE"
}
trap cleanup_start_lock EXIT INT TERM

# Lê configuração do sistema salvas pelo instalador (Root Strategy)
SYSTEM_CONFIG="$PANEL_DIR/config/system.json"
HAS_ROOT_CONFIG=false
if [ -f "$SYSTEM_CONFIG" ]; then
    HAS_ROOT_CONFIG=$(python3 -c "import json; print(json.load(open('$SYSTEM_CONFIG')).get('has_root', False))" 2>/dev/null || \
                     node -e "try{const d=require('$SYSTEM_CONFIG');console.log(d.has_root||false)}catch(e){console.log(false)}" 2>/dev/null || \
                     echo false)
fi

USE_SU=false
if [ "$HAS_ROOT_CONFIG" = "true" ] && command -v su >/dev/null 2>&1; then
    if su -c 'echo ok' >/dev/null 2>&1; then
        USE_SU=true
    fi
fi

cleanup_termux_api_duplicates() {
    PIDS="$(pgrep -f 'termux-battery-status|termux-api BatteryStatus' 2>/dev/null | sort -n)"
    KEEP="$(printf '%s\n' "$PIDS" | tail -n 1)"
    for PID in $PIDS; do
        [ -z "$PID" ] && continue
        [ "$PID" = "$KEEP" ] && continue
        kill -9 "$PID" 2>/dev/null || true
    done
}

cleanup_termux_api_duplicates

# Verifica server.js
if [ ! -f "$PANEL_DIR/server.js" ]; then
    err "server.js não encontrado em: $PANEL_DIR"
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

fpm_conf=""
for f in "$PREFIX/etc/php-fpm.d/www.conf" "$PREFIX/etc/php-fpm.conf"; do
    if [ -f "$f" ]; then
        fpm_conf="$f"
        break
    fi
done
if [ -n "$fpm_conf" ]; then
    if grep -q "listen =.*\.sock" "$fpm_conf" 2>/dev/null || ! grep -q "listen = 127.0.0.1:9070" "$fpm_conf" 2>/dev/null; then
        sed -i 's|^listen =.*|listen = 127.0.0.1:9070|' "$fpm_conf" 2>/dev/null || true
    fi
fi
if command -v php-fpm >/dev/null 2>&1; then
    if [ "$USE_SU" = "true" ]; then
        PHPOUT=$(su -c "php-fpm --daemonize" 2>&1)
    else
        PHPOUT=$(php-fpm --daemonize 2>&1)
    fi
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
    if mysql -u root -e "SELECT 1" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

start_mariadb_daemon() {
    if [ ! -d "$MYSQL_DATA_DIR/mysql" ]; then
        warn "Banco de dados não inicializado. Inicializando..."
        if [ "$USE_SU" = "true" ]; then
            if command -v mariadb-install-db >/dev/null 2>&1; then
                su -c "mariadb-install-db" >/dev/null 2>&1
            elif command -v mysql_install_db >/dev/null 2>&1; then
                su -c "mysql_install_db" >/dev/null 2>&1
            fi
        else
            if command -v mariadb-install-db >/dev/null 2>&1; then
                mariadb-install-db >/dev/null 2>&1
            elif command -v mysql_install_db >/dev/null 2>&1; then
                mysql_install_db >/dev/null 2>&1
            else
                err "Inicializador do MariaDB não encontrado!"
                return 1
            fi
        fi
    fi

    if [ "$USE_SU" = "true" ]; then
        if command -v mariadbd-safe >/dev/null 2>&1; then
            su -c "mariadbd-safe --datadir=\"$MYSQL_DATA_DIR\" >/dev/null 2>&1 &"
        elif command -v mysqld_safe >/dev/null 2>&1; then
            su -c "mysqld_safe --datadir=\"$MYSQL_DATA_DIR\" >/dev/null 2>&1 &"
        elif command -v mariadbd >/dev/null 2>&1; then
            su -c "mariadbd --datadir=\"$MYSQL_DATA_DIR\" --user=root >/dev/null 2>&1 &"
        elif command -v mysqld >/dev/null 2>&1; then
            su -c "mysqld --datadir=\"$MYSQL_DATA_DIR\" --user=root >/dev/null 2>&1 &"
        fi
    else
        if command -v mariadbd-safe >/dev/null 2>&1; then
            mariadbd-safe --datadir="$MYSQL_DATA_DIR" >/dev/null 2>&1 &
        elif command -v mysqld_safe >/dev/null 2>&1; then
            mysqld_safe --datadir="$MYSQL_DATA_DIR" >/dev/null 2>&1 &
        elif command -v mariadbd >/dev/null 2>&1; then
            mariadbd --datadir="$MYSQL_DATA_DIR" --user="$(whoami)" >/dev/null 2>&1 &
        elif command -v mysqld >/dev/null 2>&1; then
            mysqld --datadir="$MYSQL_DATA_DIR" --user="$(whoami)" >/dev/null 2>&1 &
        fi
    fi

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
    if [ -f "$PANEL_DIR/scripts/nginx-termux-repair.sh" ]; then
        sh "$PANEL_DIR/scripts/nginx-termux-repair.sh" >"$PREFIX/tmp/termux-panel-nginx-repair.log" 2>&1 || \
            warn "Reparo NGINX/mime.types falhou."
    fi

    if [ -f "$PANEL_DIR/scripts/setup-pma-sso.sh" ]; then
        bash "$PANEL_DIR/scripts/setup-pma-sso.sh" >/dev/null 2>&1 && \
            ok "SSO do phpMyAdmin configurado." || \
            warn "SSO do phpMyAdmin nao foi configurado."
    fi

    if [ "$USE_SU" = "true" ]; then
        NGOUT=$(su -c "nginx" 2>&1)
    else
        NGOUT=$(nginx 2>&1)
    fi
    NGCODE=$?
    if [ $NGCODE -eq 0 ]; then
        ok "NGINX iniciado."
    elif echo "$NGOUT" | grep -qi "already in use\|bind().*failed\|already running"; then
        if [ "$USE_SU" = "true" ]; then
            su -c "nginx -s reload" 2>/dev/null && ok "NGINX recarregado." || ok "NGINX já ativo."
        else
            nginx -s reload 2>/dev/null && ok "NGINX recarregado." || ok "NGINX já ativo."
        fi
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

PANEL_PORT="${PANEL_PORT:-$PORT}"

# Verifica se a porta está ocupada
PORT_PID="$(check_panel_port "$PANEL_PORT")"
if [ -n "$PORT_PID" ]; then
  CMD="$(ps -p "$PORT_PID" -o args= 2>/dev/null)"
  if echo "$CMD" | grep -q "$PANEL_DIR/server.js"; then
    log "Porta $PANEL_PORT ocupada por painel antigo PID $PORT_PID. Encerrando..."
    kill_pid_gracefully "$PORT_PID"
  else
    err "Porta $PANEL_PORT está ocupada por outro processo:"
    echo "$CMD"
    err "Altere PANEL_PORT ou pare o processo manualmente."
    exit 1
  fi
fi

# Carrega configuração de memória (Seguro / Balanceado / Desempenho)
MEMORY_CONFIG="$PANEL_DIR/config/memory.json"
NODE_MEMORY_MODE="balanced"
if [ -f "$MEMORY_CONFIG" ]; then
  NODE_MEMORY_MODE=$(python3 -c "import json; print(json.load(open('$MEMORY_CONFIG')).get('mode', 'balanced'))" 2>/dev/null || \
                     node -e "try{const d=require('$MEMORY_CONFIG');console.log(d.mode||'balanced')}catch(e){console.log('balanced')}" 2>/dev/null || \
                     echo "balanced")
fi

case "$NODE_MEMORY_MODE" in
  safe)
    NODE_MAX_OLD_SPACE_SIZE=128
    ;;
  performance)
    NODE_MAX_OLD_SPACE_SIZE=512
    ;;
  balanced|"")
    NODE_MAX_OLD_SPACE_SIZE="${NODE_MAX_OLD_SPACE_SIZE:-256}"
    ;;
esac

log "Memória Node configurada: ${NODE_MAX_OLD_SPACE_SIZE} MB"
log "Modo de memória: ${NODE_MEMORY_MODE}"

# Root: aplica prioridade (se disponível)
if [ "$USE_SU" = "true" ]; then
    log "Root detectado! Aplicando prioridades VIP..."
    bash "$PANEL_DIR/scripts/prioritize.sh" >/dev/null 2>&1 &
fi

ok "Auto-restart ativo — limite de 5 quedas por minuto."
log "Acesse: http://0.0.0.0:${PANEL_PORT}"
echo ""

# Cloudflared sidecar: reinicia junto com o painel para aplicar regras novas
restart_cloudflared_with_panel() {
  local cf_config="$HOME/.cloudflared/config.yml"
  local cf_log="$PANEL_DIR/logs/cloudflared.log"

  if ! command -v cloudflared >/dev/null 2>&1; then
    warn "cloudflared não encontrado no PATH. Pulando auto-start do túnel."
    return 0
  fi

  if [ ! -f "$cf_config" ]; then
    warn "config.yml do cloudflared não encontrado em $cf_config. Pulando auto-start do túnel."
    return 0
  fi

  if ! grep -qi "^ingress:" "$cf_config" 2>/dev/null; then
    warn "config.yml sem bloco ingress. Pulando auto-start do cloudflared."
    return 0
  fi

  log "Reiniciando processo cloudflared para aplicar regras atuais..."
  pkill -x cloudflared 2>/dev/null || true
  sleep 1

  nohup cloudflared --config "$cf_config" tunnel run >>"$cf_log" 2>&1 &
  sleep 2

  if pgrep -x cloudflared >/dev/null 2>&1; then
    ok "Cloudflared iniciado junto com o painel."
  else
    warn "Cloudflared não iniciou automaticamente. Verifique logs/cloudflared.log."
  fi
}

restart_cloudflared_with_panel

# Loop de auto-restart com limites de tentativas
RESTART_COUNT=0
RESTART_WINDOW_START=$(date +%s)

while true; do
  EXISTING_NODE="$(find_panel_node_processes)"
  if [ -n "$EXISTING_NODE" ]; then
    warn "Já existe node server.js rodando PID $EXISTING_NODE"
    exit 0
  fi

  node --max-old-space-size="$NODE_MAX_OLD_SPACE_SIZE" "$PANEL_DIR/server.js" &
  NODE_PID=$!
  echo "$NODE_PID" > "$PID_FILE"
  
  wait "$NODE_PID"
  EXIT_CODE=$?
  
  if [ "$EXIT_CODE" = "143" ]; then
    ok "Servidor encerrado por SIGTERM/código 143. Parada controlada."
  elif [ "$EXIT_CODE" = "137" ]; then
    err "Servidor encerrado por SIGKILL/código 137. Possível OOM Killer/falta de memória."
  elif [ "$EXIT_CODE" != "0" ]; then
    warn "Servidor saiu com código $EXIT_CODE."
  fi
  
  NOW=$(date +%s)
  if [ $((NOW - RESTART_WINDOW_START)) -gt 60 ]; then
    RESTART_COUNT=0
    RESTART_WINDOW_START=$NOW
  fi
  
  RESTART_COUNT=$((RESTART_COUNT + 1))
  if [ "$RESTART_COUNT" -ge 5 ]; then
    err "O servidor caiu 5 vezes em menos de 60 segundos. Abortando auto-restart."
    rm -f "$PID_FILE"
    exit 1
  fi
  
  if [ "$EXIT_CODE" = "143" ]; then
    log "Encerramento controlado. Não reiniciando."
    rm -f "$PID_FILE"
    exit 0
  fi
  
  warn "Reiniciando em 5s..."
  sleep 5
done
