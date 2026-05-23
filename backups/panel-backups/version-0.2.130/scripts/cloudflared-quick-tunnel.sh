#!/data/data/com.termux/files/usr/bin/sh
set -eu

TARGET_URL="${1:-http://127.0.0.1:8080}"

echo "[cloudflared] Iniciando tunel temporario sem login"
echo "[cloudflared] URL local: $TARGET_URL"
echo "[cloudflared] Este modo nao usa cert.pem, token, dashboard ou named tunnel."

exec cloudflared tunnel --url "$TARGET_URL"
