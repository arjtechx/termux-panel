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
    local sock
    for sock in \
        "$PREFIX/var/run/php-fpm.sock" \
        "$PREFIX/tmp/php-fpm.sock" \
        "/tmp/php-fpm.sock"; do
        if [ -S "$sock" ]; then
            printf 'unix:%s\n' "$sock"
            return 0
        fi
    done

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

    if [ ! -f "$SCRIPT_DIR/autologin.php" ]; then
        echo "  [-] autologin.php nao encontrado em $SCRIPT_DIR"
        return 1
    fi

    cp "$SCRIPT_DIR/autologin.php" "$pma_dir/autologin.php"
    chmod 644 "$pma_dir/autologin.php"
    chown "$CURRENT_USER" "$pma_dir/autologin.php" 2>/dev/null || true
    echo "  [+] autologin.php copiado"

    if [ ! -f "$pma_config" ] && [ -f "$sample_config" ]; then
        cp "$sample_config" "$pma_config"
    fi

    if [ ! -f "$pma_config" ]; then
        echo "  [-] config.inc.php nao encontrado em $pma_dir"
        return 1
    fi

    chmod 644 "$pma_config"
    chown "$CURRENT_USER" "$pma_config" 2>/dev/null || true

    sed -i "/\['auth_type'\] = 'signon'/d" "$pma_config"
    sed -i "/\['SignonSession'\]/d" "$pma_config"
    sed -i "/\['SignonURL'\]/d" "$pma_config"
    sed -i "/\['LogoutURL'\]/d" "$pma_config"
    sed -i "s/\['auth_type'\] = 'cookie'/\['auth_type'\] = 'signon'/g" "$pma_config"

    if grep -q "\['host'\]" "$pma_config"; then
        sed -i "/\['host'\]/a \
\$cfg['Servers'][\$i]['auth_type'] = 'signon';\n\
\$cfg['Servers'][\$i]['SignonSession'] = 'PMA_single_signon';\n\
\$cfg['Servers'][\$i]['SignonURL'] = '/phpmyadmin/autologin.php';\n\
\$cfg['Servers'][\$i]['LogoutURL'] = '/phpmyadmin/';\n\
" "$pma_config"
    else
        cat >> "$pma_config" <<'PHP_CONFIG'

$i = $i ?? 1;
$cfg['Servers'][$i]['host'] = '127.0.0.1';
$cfg['Servers'][$i]['auth_type'] = 'signon';
$cfg['Servers'][$i]['SignonSession'] = 'PMA_single_signon';
$cfg['Servers'][$i]['SignonURL'] = '/phpmyadmin/autologin.php';
$cfg['Servers'][$i]['LogoutURL'] = '/phpmyadmin/';
PHP_CONFIG
    fi

    echo "  [+] config.inc.php ajustado para SSO"
}

configure_nginx_vhost() {
    local pma_dir="$1"
    local fastcgi_pass
    local fastcgi_include
    fastcgi_pass="$(detect_fastcgi_pass)"
    fastcgi_include="$(detect_fastcgi_include)"

    mkdir -p "$NGINX_CONF_DIR" "$PREFIX/var/log/nginx"

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
