#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPanel - phpMyAdmin SSO Setup Script
#  Configures autologin.php, phpMyAdmin signon, and NGINX :8080.
# =============================================================

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CURRENT_USER="$(whoami)"
NGINX_CONF_DIR="$PREFIX/etc/nginx/conf.d"
PMA_NGINX_CONF="$NGINX_CONF_DIR/phpmyadmin.conf"
PMA_PORT="${PMA_PORT:-8080}"

echo "=== Iniciando setup do phpMyAdmin SSO ==="

find_phpmyadmin_dir() {
    local paths=(
        "$PREFIX/share/phpmyadmin"
        "/data/data/com.termux/files/home/server/sites/phpmyadmin"
        "/usr/share/phpmyadmin"
    )

    local dir
    for dir in "${paths[@]}"; do
        if [ -d "$dir" ]; then
            printf '%s\n' "$dir"
            return 0
        fi
    done

    find "$PREFIX/share" -name "phpmyadmin" -type d 2>/dev/null | head -1
}

detect_fastcgi_pass() {
    # Termux/Android: Força comunicação TCP 127.0.0.1:9000 para evitar instabilidade/falhas de Sockets Unix
    printf '127.0.0.1:9000\n'
}

detect_fastcgi_include() {
    local include_file
    for include_file in \
        "$PREFIX/etc/nginx/fastcgi_params" \
        "$PREFIX/etc/nginx/fastcgi.conf" \
        "/etc/nginx/fastcgi_params" \
        "/etc/nginx/fastcgi.conf"; do
        if [ -f "$include_file" ]; then
            printf '%s\n' "$include_file"
            return 0
        fi
    done

    include_file="$PREFIX/etc/nginx/fastcgi_params"
    mkdir -p "$(dirname "$include_file")"
    cat > "$include_file" <<'FASTCGI_PARAMS'
fastcgi_param  QUERY_STRING       $query_string;
fastcgi_param  REQUEST_METHOD     $request_method;
fastcgi_param  CONTENT_TYPE       $content_type;
fastcgi_param  CONTENT_LENGTH     $content_length;
fastcgi_param  SCRIPT_NAME        $fastcgi_script_name;
fastcgi_param  REQUEST_URI        $request_uri;
fastcgi_param  DOCUMENT_URI       $document_uri;
fastcgi_param  DOCUMENT_ROOT      $document_root;
fastcgi_param  SERVER_PROTOCOL    $server_protocol;
fastcgi_param  REQUEST_SCHEME     $scheme;
fastcgi_param  HTTPS              $https if_not_empty;
fastcgi_param  GATEWAY_INTERFACE  CGI/1.1;
fastcgi_param  SERVER_SOFTWARE    nginx/$nginx_version;
fastcgi_param  REMOTE_ADDR        $remote_addr;
fastcgi_param  REMOTE_PORT        $remote_port;
fastcgi_param  SERVER_ADDR        $server_addr;
fastcgi_param  SERVER_PORT        $server_port;
fastcgi_param  SERVER_NAME        $server_name;
fastcgi_param  REDIRECT_STATUS    200;
FASTCGI_PARAMS
    printf '%s\n' "$include_file"
}

configure_phpmyadmin_sso() {
    local pma_dir="$1"
    local pma_config="$pma_dir/config.inc.php"
    local sample_config="$pma_dir/config.sample.inc.php"

    echo "Configurando phpMyAdmin em: $pma_dir"
    chown -R "$CURRENT_USER" "$pma_dir" 2>/dev/null || true

    if [ ! -f "$pma_config" ] && [ -f "$sample_config" ]; then
        cp "$sample_config" "$pma_config"
    fi

    if [ ! -f "$pma_config" ]; then
        echo "  [-] config.inc.php nao encontrado em $pma_dir"
        return 1
    fi

    chmod 644 "$pma_config"
    chown "$CURRENT_USER" "$pma_config" 2>/dev/null || true

    # Garante que criamos o test.php para diagnóstico mínimo obrigatório
    echo "<?php phpinfo(); ?>" > "$pma_dir/test.php"
    chmod 644 "$pma_dir/test.php"
    chown "$CURRENT_USER" "$pma_dir/test.php" 2>/dev/null || true
    echo "  [+] test.php de diagnóstico criado"

    # Remove configurações SSO antigas ou conflitantes
    sed -i "/\['auth_type'\]/d" "$pma_config" 2>/dev/null || true
    sed -i "/\['SignonSession'\]/d" "$pma_config" 2>/dev/null || true
    sed -i "/\['SignonURL'\]/d" "$pma_config" 2>/dev/null || true
    sed -i "/\['LogoutURL'\]/d" "$pma_config" 2>/dev/null || true
    sed -i "/\['host'\]/d" "$pma_config" 2>/dev/null || true
    sed -i "/\['port'\]/d" "$pma_config" 2>/dev/null || true

    # Insere configurações 100% estáveis usando TCP/IP 127.0.0.1 e Cookie Auth (evita loops)
    if grep -q "\['Servers'\]" "$pma_config"; then
        # Adiciona na primeira Server config
        sed -i "/\['Servers'\]/a \
\$cfg['Servers'][\$i]['host'] = '127.0.0.1';\n\
\$cfg['Servers'][\$i]['port'] = '3306';\n\
\$cfg['Servers'][\$i]['auth_type'] = 'cookie';\n\
\$cfg['Servers'][\$i]['AllowNoPassword'] = true;\n\
" "$pma_config"
    else
        cat >> "$pma_config" <<'PHP_CONFIG'

$i = $i ?? 1;
$cfg['Servers'][$i]['host'] = '127.0.0.1';
$cfg['Servers'][$i]['port'] = '3306';
$cfg['Servers'][$i]['auth_type'] = 'cookie';
$cfg['Servers'][$i]['AllowNoPassword'] = true;
PHP_CONFIG
    fi

    echo "  [+] config.inc.php ajustado para Cookie Auth (TCP/IP 127.0.0.1)"
}

configure_nginx_vhost() {
    local pma_dir="$1"
    local fastcgi_pass
    local fastcgi_include
    fastcgi_pass="$(detect_fastcgi_pass)"
    fastcgi_include="$(detect_fastcgi_include)"

    # Garante que o diretório etc/nginx exista e tem permissões corretas
    local nginx_main_dir="$(dirname "$NGINX_CONF_DIR")"
    local mime_types="$nginx_main_dir/mime.types"
    mkdir -p "$nginx_main_dir" "$NGINX_CONF_DIR" "$PREFIX/var/log/nginx" "$PREFIX/var/run"
    chmod -R 777 "$nginx_main_dir" "$PREFIX/var/log/nginx" "$PREFIX/var/run" 2>/dev/null || true
    chown -R "$(whoami)" "$nginx_main_dir" "$PREFIX/var/log/nginx" "$PREFIX/var/run" 2>/dev/null || true

    if [ -f "$SCRIPT_DIR/nginx-termux-repair.sh" ]; then
        sh "$SCRIPT_DIR/nginx-termux-repair.sh" >/dev/null 2>&1 || true
    fi

    # Garante que o arquivo nginx.conf principal exista
    local nginx_main="$nginx_main_dir/nginx.conf"
    if [ ! -f "$nginx_main" ]; then
        echo "  [-] nginx.conf principal ausente. Criando..."
        cat > "$nginx_main" << 'NGINX_CONF'
worker_processes  auto;
error_log  /data/data/com.termux/files/usr/var/log/nginx/error.log warn;
pid        /data/data/com.termux/files/usr/var/run/nginx.pid;

events {
    worker_connections  256;
}

http {
    include       /data/data/com.termux/files/usr/etc/nginx/mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout  65;
    client_max_body_size 100m;

    include /data/data/com.termux/files/usr/etc/nginx/conf.d/*.conf;
}
NGINX_CONF
        echo "  [+] nginx.conf principal criado com sucesso."
    fi

    cat > "$PMA_NGINX_CONF" <<PMA_CONF
server {
    listen       ${PMA_PORT};
    server_name  localhost 127.0.0.1 _;

    access_log  ${PREFIX}/var/log/nginx/phpmyadmin_access.log;
    error_log   ${PREFIX}/var/log/nginx/phpmyadmin_error.log;

    client_max_body_size 100m;

    location = / {
        return 302 /phpmyadmin/;
    }

    location /phpmyadmin/ {
        alias ${pma_dir}/;
        index index.php index.html;
        try_files \$uri \$uri/ /phpmyadmin/index.php?\$query_string;
    }

    location ~ ^/phpmyadmin/(.+\\.php)$ {
        alias ${pma_dir}/\$1;
        fastcgi_pass  ${fastcgi_pass};
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME \$request_filename;
        include       ${fastcgi_include};
    }

    location ~ /\\.(ht|git) {
        deny all;
    }
}
PMA_CONF

    echo "  [+] vhost NGINX criado em $PMA_NGINX_CONF usando fastcgi_pass=$fastcgi_pass"
    echo "  [+] include FastCGI: $fastcgi_include"
}

PMA_DIR="$(find_phpmyadmin_dir)"
if [ -z "$PMA_DIR" ] || [ ! -d "$PMA_DIR" ]; then
    echo "[-] phpMyAdmin nao encontrado. Instale com: pkg install phpmyadmin php-fpm"
    exit 1
fi

configure_phpmyadmin_sso "$PMA_DIR" || exit 1
configure_nginx_vhost "$PMA_DIR" || exit 1

echo "SSO do phpMyAdmin configurado com sucesso."
exit 0
