#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Stop Script v1.0
# =============================================================

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PANEL_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
LOCK_DIR="$HOME/.termux-panel-lock"
PID_FILE="$LOCK_DIR/panel.pid"
START_PID_FILE="$LOCK_DIR/start.pid"

mkdir -p "$LOCK_DIR"

echo "[INFO] Parando Termux Panel..."

if [ -f "$PANEL_DIR/scripts/lib/process-manager.sh" ]; then
  . "$PANEL_DIR/scripts/lib/process-manager.sh"
  stop_panel_safe
else
  echo "[WARN] Biblioteca process-manager.sh não encontrada. Usando fallback."

  for pid in $(ps -ef | grep -E "$PANEL_DIR/scripts/start.sh|bash scripts/start.sh|node .*server.js" | grep -v grep | awk '{print $2}'); do
    echo "[INFO] Encerrando PID $pid"
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -0 "$pid" 2>/dev/null && kill -9 "$pid" 2>/dev/null || true
  done
fi

rm -f "$PID_FILE" "$START_PID_FILE"

echo "[OK] Painel parado."
ps -ef 2>/dev/null | grep -E "start.sh|server.js|node" | grep -v grep || true
