#!/data/data/com.termux/files/usr/bin/sh
set +e

CLOUDFLARED_HOME="${1:-$HOME/.cloudflared}"
TUNNELS_DIR="${2:-}"

echo "[cloudflared] Ambiente:"
echo "  HOME=$HOME"
echo "  CLOUDFLARED_HOME=$CLOUDFLARED_HOME"
echo "  TUNNELS_DIR=$TUNNELS_DIR"

echo "[cloudflared] Parando processos antigos..."
pkill -f 'cloudflared.*tunnel' 2>/dev/null || true

echo "[cloudflared] Removendo cert.pem..."
rm -fv "$CLOUDFLARED_HOME/cert.pem" 2>/dev/null || true

echo "[cloudflared] Removendo credenciais .json antigas..."
find "$CLOUDFLARED_HOME" -maxdepth 1 -type f -name '*.json' -print -delete 2>/dev/null || true

if [ -n "$TUNNELS_DIR" ]; then
    echo "[cloudflared] Removendo tuneis cadastrados no painel..."
    find "$TUNNELS_DIR" -mindepth 1 -maxdepth 1 -type d -print -exec rm -rf {} + 2>/dev/null || true
fi

echo "[cloudflared] Estado final:"
if [ -f "$CLOUDFLARED_HOME/cert.pem" ]; then
    echo "  cert.pem ainda existe"
else
    echo "  cert.pem removido"
fi

echo "[cloudflared] Limpeza concluida."
