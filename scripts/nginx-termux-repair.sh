#!/data/data/com.termux/files/usr/bin/sh
set +e

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PANEL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
NGINX_DIR="$PREFIX/etc/nginx"
NGINX_CONF="$NGINX_DIR/nginx.conf"
MIME_TYPES="$NGINX_DIR/mime.types"
CONF_D="$NGINX_DIR/conf.d"
LOG_DIR="$PANEL_DIR/logs"
RUN_DIR="$PANEL_DIR/logs"

echo "[nginx] Reparando bootstrap do NGINX no Termux"
echo "[nginx] PREFIX=$PREFIX"

mkdir -p "$NGINX_DIR" "$CONF_D" "$LOG_DIR" "$RUN_DIR"
chmod 777 "$RUN_DIR" "$LOG_DIR" 2>/dev/null || true
rm -f "$RUN_DIR/nginx.pid" 2>/dev/null || true

if [ ! -f "$MIME_TYPES" ]; then
    echo "[nginx] mime.types ausente: $MIME_TYPES"
    if command -v pkg >/dev/null 2>&1; then
        echo "[nginx] Tentando restaurar com: pkg reinstall nginx -y"
        pkg reinstall nginx -y 2>&1 || true
    fi
fi

if [ ! -f "$MIME_TYPES" ]; then
    echo "[nginx] Criando mime.types minimo para desbloquear o boot"
    cat > "$MIME_TYPES" <<'MIME_TYPES'
types {
    text/html                             html htm shtml;
    text/css                              css;
    text/xml                              xml;
    image/gif                             gif;
    image/jpeg                            jpeg jpg;
    application/javascript                js;
    application/json                      json;
    image/png                             png;
    image/svg+xml                         svg svgz;
    image/x-icon                          ico;
    text/plain                            txt;
    application/pdf                       pdf;
    application/octet-stream              bin exe dll;
}
MIME_TYPES
fi

if [ -f "$NGINX_CONF" ]; then
    cp "$NGINX_CONF" "$NGINX_CONF.bak.$(date +%s)" 2>/dev/null || true
fi

cat > "$NGINX_CONF" <<NGINX_CONF
worker_processes auto;
error_log  $LOG_DIR/error.log warn;
pid        $RUN_DIR/nginx.pid;

events {
    worker_connections 256;
}

http {
    include       $MIME_TYPES;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout 65;
    client_max_body_size 100m;

    include $CONF_D/*.conf;
}
NGINX_CONF

echo "[nginx] nginx.conf escrito com include absoluto de mime.types"
nginx -t
exit $?
