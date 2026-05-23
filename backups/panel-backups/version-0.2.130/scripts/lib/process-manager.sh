#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Process Manager Library v1.0
#  Biblioteca reutilizável para controle seguro de processos
# =============================================================

# Define caminhos globais robustos
LOCK_DIR="$HOME/.termux-panel-lock"
PID_FILE="$LOCK_DIR/panel.pid"
START_PID_FILE="$LOCK_DIR/start.pid"
UPDATE_LOCK="$LOCK_DIR/update.lock"

if [ -z "$PANEL_DIR" ]; then
  LIB_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
  PANEL_DIR="$( cd "$LIB_DIR/../.." && pwd )"
fi

mkdir -p "$LOCK_DIR"
mkdir -p "$PANEL_DIR/logs"
PROCESS_LOG="$PANEL_DIR/logs/process-manager.log"
touch "$PROCESS_LOG" 2>/dev/null

log_process() {
  local msg="$1"
  local clean_msg="$(echo -e "$msg" | sed 's/\x1b\[[0-9;]*m//g')"
  echo "$msg"
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $clean_msg" >> "$PROCESS_LOG" 2>/dev/null
}

# Função para matar processo graciosamente e depois forçar se necessário
kill_pid_gracefully() {
  local pid="$1"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log_process "[process-manager] Enviando SIGTERM para PID $pid..."
    kill "$pid" 2>/dev/null || true
    local limit=5
    while [ $limit -gt 0 ] && kill -0 "$pid" 2>/dev/null; do
      sleep 0.5
      limit=$((limit - 1))
    done
    if kill -0 "$pid" 2>/dev/null; then
      log_process "[process-manager] Processo PID $pid resistiu. Enviando SIGKILL..."
      kill -9 "$pid" 2>/dev/null || true
    fi
  fi
}

# Encontra PIDs dos scripts start.sh do painel (excluindo a si mesmo)
find_panel_start_processes() {
  local current_pid="$$"
  ps -ef 2>/dev/null | grep -E "scripts/start.sh|bash scripts/start.sh" | grep -v grep | awk '{print $2}' | grep -v "^$current_pid$" || true
}

# Encontra PIDs do node server.js associados ao termux-panel
find_panel_node_processes() {
  local pids=""
  for pid in $(ps -ef 2>/dev/null | grep "node" | grep -E "server\.js|desktop-server\.js" | grep -v grep | awk '{print $2}'); do
    local cmdline=""
    if [ -f "/proc/$pid/cmdline" ]; then
      cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    fi
    local cwd=""
    if [ -d "/proc/$pid/cwd" ] || [ -L "/proc/$pid/cwd" ]; then
      cwd="$(readlink "/proc/$pid/cwd" 2>/dev/null || true)"
    fi
    
    # Valida se pertence a este painel específico
    if [ "$cwd" = "$PANEL_DIR" ] || echo "$cmdline" | grep -q "$PANEL_DIR/server.js" || echo "$cmdline" | grep -q "termux-panel"; then
      pids="$pids $pid"
    fi
  done
  echo "$pids" | tr ' ' '\n' | grep -v '^$' || true
}

# Verifica qual PID ocupa a porta principal
check_panel_port() {
  local port="${1:-8088}"
  local port_pid=""
  if command -v ss >/dev/null 2>&1; then
    port_pid="$(ss -ltnp 2>/dev/null | grep ":$port " | sed -n 's/.*pid=\([0-9]*\).*/\1/p' | head -n1)"
  fi
  if [ -z "$port_pid" ] && command -v lsof >/dev/null 2>&1; then
    port_pid="$(lsof -t -i:"$port" -sTCP:LISTEN 2>/dev/null | head -n1)"
  fi
  if [ -z "$port_pid" ] && command -v fuser >/dev/null 2>&1; then
    port_pid="$(fuser "$port/tcp" 2>/dev/null | awk '{print $1}' | head -n1)"
  fi
  echo "$port_pid"
}

# Para todos os processos start.sh e node server.js da nossa aplicação graciosamente
stop_panel_safe() {
  log_process "[INFO] Iniciando parada segura dos processos do painel..."
  
  # 1. Encerra node server.js
  for pid in $(find_panel_node_processes); do
    log_process "[INFO] Encerrando node server.js PID $pid"
    kill_pid_gracefully "$pid"
  done
  
  # 2. Encerra start.sh
  for pid in $(find_panel_start_processes); do
    log_process "[INFO] Encerrando start.sh duplicado PID $pid"
    kill_pid_gracefully "$pid"
  done
  
  # 3. Limpa locks locais
  rm -f "$PID_FILE" "$START_PID_FILE" 2>/dev/null || true
  log_process "[OK] Processos antigos do painel parados."
}

# Função de diagnóstico de processos ativos
diagnose_panel_processes() {
  echo "=== TERMUX PANEL PROCESS DIAGNOSIS ==="
  echo "LOCK_DIR: $LOCK_DIR"
  echo "PANEL_DIR: $PANEL_DIR"
  echo ""
  
  echo "--- Processos start.sh ativos ---"
  local starts="$(find_panel_start_processes)"
  if [ -n "$starts" ]; then
    echo "$starts" | while read -r pid; do
      local cmd=""
      if [ -f "/proc/$pid/cmdline" ]; then
        cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
      fi
      echo "PID $pid: $cmd"
    done
  else
    echo "Nenhum"
  fi
  echo ""
  
  echo "--- Processos node server.js ativos ---"
  local nodes="$(find_panel_node_processes)"
  if [ -n "$nodes" ]; then
    echo "$nodes" | while read -r pid; do
      local cmd=""
      if [ -f "/proc/$pid/cmdline" ]; then
        cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)"
      fi
      echo "PID $pid: $cmd"
    done
  else
    echo "Nenhum"
  fi
  echo ""
  
  echo "--- Lock Files ---"
  if [ -f "$START_PID_FILE" ]; then
    local spid="$(cat "$START_PID_FILE")"
    if [ -n "$spid" ] && kill -0 "$spid" 2>/dev/null; then
      echo "start.pid: $spid (Ativo)"
    else
      echo "start.pid: $spid (Inativo / Órfão)"
    fi
  else
    echo "start.pid: Inexistente"
  fi
  
  if [ -f "$PID_FILE" ]; then
    local npid="$(cat "$PID_FILE")"
    if [ -n "$npid" ] && kill -0 "$npid" 2>/dev/null; then
      echo "panel.pid: $npid (Ativo)"
    else
      echo "panel.pid: $npid (Inativo / Órfão)"
    fi
  else
    echo "panel.pid: Inexistente"
  fi
  
  if [ -f "$UPDATE_LOCK" ]; then
    local upid="$(cat "$UPDATE_LOCK")"
    if [ -n "$upid" ] && kill -0 "$upid" 2>/dev/null; then
      echo "update.lock: $upid (Ativo)"
    else
      echo "update.lock: $upid (Inativo / Órfão)"
    fi
  else
    echo "update.lock: Inexistente"
  fi
}
