#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Health Check & Auto-Fix Script
#  Verifica e corrige: NGINX, MariaDB, PHP, phpMyAdmin
# =============================================================

# Cores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m' # No Color

# Acumula erros e correções para o relatório final
ERRORS=0
FIXED=0
WARNINGS=0

log_ok()   { echo -e "${GREEN}[OK]${NC}    $1"; }
log_err()  { echo -e "${RED}[ERRO]${NC}  $1"; ((ERRORS++)); }
log_fix()  { echo -e "${YELLOW}[FIX]${NC}   $1"; ((FIXED++)); }
log_warn() { echo -e "${CYAN}[AVISO]${NC} $1"; ((WARNINGS++)); }
log_info() { echo -e "${BLUE}[INFO]${NC}  $1"; }
log_sep()  { echo -e "${BOLD}──────────────────────────────────────────${NC}"; }

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
HOME_DIR="${HOME:-/data/data/com.termux/files/home}"
NGINX_CONF_DIR="$PREFIX/etc/nginx"
NGINX_SITES_DIR="$PREFIX/etc/nginx/conf.d"
PHP_INI="$PREFIX/etc/php.ini"
PMA_DIR="$PREFIX/share/phpmyadmin"
PMA_NGINX_CONF="$NGINX_SITES_DIR/phpmyadmin.conf"
MARIADB_DATA="$PREFIX/var/lib/mysql"
PMA_PORT=8080

echo ""
echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║  TERMUX cPANEL — Health Check v1.0      ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

# =============================================================
# 1. PACOTES ESSENCIAIS
# =============================================================
log_sep
log_info "Verificando pacotes essenciais..."

check_pkg() {
    local pkg="$1"
    local display="${2:-$1}"
    if pkg list-installed 2>/dev/null | grep -q "^$pkg/"; then
        log_ok "$display instalado"
        return 0
    else
        log_err "$display NÃO está instalado"
        log_fix "Instalando $display..."
        pkg install -y "$pkg" 2>&1 | tail -5
        if pkg list-installed 2>/dev/null | grep -q "^$pkg/"; then
            log_ok "$display instalado com sucesso"
        else
            log_err "Falha ao instalar $display"
        fi
        return 1
    fi
}

check_pkg "nginx"       "NGINX"
check_pkg "php"         "PHP"
check_pkg "php-fpm"     "PHP-FPM"
check_pkg "mariadb"     "MariaDB"
check_pkg "phpmyadmin"  "phpMyAdmin"
check_pkg "curl"        "cURL"
check_pkg "wget"        "wget"

# =============================================================
# 2. DIRETÓRIOS ESSENCIAIS
# =============================================================
log_sep
log_info "Verificando estrutura de diretórios..."

ensure_dir() {
    local dir="$1"
    local label="${2:-$1}"
    if [ -d "$dir" ]; then
        log_ok "Diretório $label existe"
    else
        log_err "Diretório $label ausente: $dir"
        log_fix "Criando $dir..."
        mkdir -p "$dir"
        log_ok "Criado: $dir"
    fi
}

ensure_dir "$NGINX_CONF_DIR"       "nginx conf"
ensure_dir "$NGINX_SITES_DIR"      "nginx conf.d"
ensure_dir "$PREFIX/var/log/nginx" "nginx logs"
ensure_dir "$PREFIX/var/run"       "var/run"

# =============================================================
# 3. MARIADB
# =============================================================
log_sep
log_info "Verificando MariaDB..."

if [ -d "$MARIADB_DATA" ] && [ "$(ls -A "$MARIADB_DATA" 2>/dev/null)" ]; then
    log_ok "Data directory do MariaDB existe"
else
    log_err "Data directory do MariaDB está vazio ou ausente"
    log_fix "Inicializando MariaDB..."
    mysql_install_db --datadir="$MARIADB_DATA" 2>&1 | tail -5
    log_ok "MariaDB inicializado"
fi

# Verifica se processo está rodando
MARIADB_RUNNING=0
if pgrep -f "mariadbd" > /dev/null 2>&1 || pgrep -f "mysqld" > /dev/null 2>&1; then
    MARIADB_RUNNING=1
elif pgrep -x "mariadbd" > /dev/null 2>&1 || pgrep -x "mysqld" > /dev/null 2>&1; then
    MARIADB_RUNNING=1
elif mysql -u root -e "SELECT 1" >/dev/null 2>&1 || nc -z 127.0.0.1 3306 2>/dev/null; then
    MARIADB_RUNNING=1
fi

if [ $MARIADB_RUNNING -eq 1 ]; then
    log_ok "Processo MariaDB está rodando"
    
    # Verifica porta 3306
    if nc -z 127.0.0.1 3306 2>/dev/null; then
        log_ok "Porta 3306 (MariaDB) está acessível"
    else
        log_warn "MariaDB em execução mas porta 3306 não responde"
    fi
else
    log_warn "Processo MariaDB não está em execução"
    log_fix "Iniciando MariaDB em background..."
    
    # Garante o diretório de socket do MariaDB para evitar crashes
    mkdir -p "$PREFIX/var/run/mysqld"
    chmod 777 "$PREFIX/var/run/mysqld" 2>/dev/null
    mkdir -p "$PREFIX/tmp"
    
    # Inicia usando o script mysqld_safe correto do Termux
    mysqld_safe --datadir="$MARIADB_DATA" > "$PREFIX/tmp/mariadb_start.log" 2>&1 &
    sleep 4
    if pgrep -f "mariadbd" > /dev/null 2>&1 || pgrep -f "mysqld" > /dev/null 2>&1 || nc -z 127.0.0.1 3306 2>/dev/null; then
        log_ok "MariaDB iniciado com sucesso"
    else
        log_err "Não foi possível iniciar o MariaDB"
        if [ -f "$PREFIX/tmp/mariadb_start.log" ]; then
            log_info "Erros de inicialização do MariaDB:"
            cat "$PREFIX/tmp/mariadb_start.log" | while IFS= read -r line; do
                echo -e "  ${RED}→ $line${NC}"
            done
        fi
    fi
fi

# =============================================================
# 4. PHP
# =============================================================
log_sep
log_info "Verificando PHP..."

if command -v php > /dev/null 2>&1; then
    PHP_VER=$(php -r 'echo PHP_MAJOR_VERSION.".".PHP_MINOR_VERSION;' 2>/dev/null)
    log_ok "PHP $PHP_VER encontrado"

    # Extensões necessárias para phpMyAdmin
    REQUIRED_EXT=("mysqli" "mbstring" "json" "session" "zip")
    for ext in "${REQUIRED_EXT[@]}"; do
        if php -m 2>/dev/null | grep -qi "^$ext$"; then
            log_ok "Extensão PHP: $ext"
        else
            log_warn "Extensão PHP ausente: $ext (phpMyAdmin pode não funcionar)"
        fi
    done
else
    log_err "PHP não encontrado no PATH"
fi

# Verifica PHP-FPM
PHP_FPM_RUNNING=0
if pgrep -f "php-fpm" > /dev/null 2>&1 || pgrep -x "php-fpm" > /dev/null 2>&1; then
    PHP_FPM_RUNNING=1
elif nc -z 127.0.0.1 9000 2>/dev/null; then
    PHP_FPM_RUNNING=1
fi

if [ $PHP_FPM_RUNNING -eq 1 ]; then
    log_ok "PHP-FPM está rodando"
else
    log_warn "PHP-FPM não está em execução"
    log_fix "Iniciando PHP-FPM..."
    mkdir -p "$PREFIX/var/run" "$PREFIX/tmp"
    
    PHPOUT=$(php-fpm --daemonize 2>&1)
    sleep 2
    if pgrep -f "php-fpm" > /dev/null 2>&1 || pgrep -x "php-fpm" > /dev/null 2>&1 || nc -z 127.0.0.1 9000 2>/dev/null; then
        log_ok "PHP-FPM iniciado"
    else
        log_err "Falha ao iniciar PHP-FPM: $PHPOUT"
    fi
fi

# Socket PHP-FPM
PHP_SOCK="$PREFIX/var/run/php-fpm.sock"
if [ -S "$PHP_SOCK" ]; then
    log_ok "Socket PHP-FPM: $PHP_SOCK"
else
    # Tenta socket alternativo
    PHP_SOCK2="$PREFIX/tmp/php-fpm.sock"
    if [ -S "$PHP_SOCK2" ]; then
        log_warn "PHP-FPM socket em local alternativo: $PHP_SOCK2"
        PHP_SOCK="$PHP_SOCK2"
    else
        log_warn "Socket PHP-FPM não encontrado (tentativas: $PHP_SOCK, $PHP_SOCK2)"
    fi
fi

# =============================================================
# 5. NGINX CONFIG
# =============================================================
log_sep
log_info "Verificando configuração do NGINX..."

NGINX_MAIN="$NGINX_CONF_DIR/nginx.conf"

# nginx.conf base
if [ -f "$NGINX_MAIN" ]; then
    log_ok "nginx.conf encontrado"
    # Testa sintaxe
    if nginx -t 2>/dev/null; then
        log_ok "Sintaxe do nginx.conf é válida"
        
        # Garante que o nginx.conf carregue a pasta conf.d/*.conf
        if ! grep -q "conf.d/\*\.conf" "$NGINX_MAIN"; then
            log_warn "nginx.conf encontrado, mas NÃO contém o include para conf.d/*.conf!"
            cp "$NGINX_MAIN" "$NGINX_MAIN.bak.$(date +%s)"
            log_fix "Backup criado, reescrevendo nginx.conf com suporte a conf.d..."
            
            cat > "$NGINX_MAIN" << 'NGINX_CONF'
worker_processes  auto;
error_log  /data/data/com.termux/files/usr/var/log/nginx/error.log warn;
pid        /data/data/com.termux/files/usr/var/run/nginx.pid;

events {
    worker_connections  256;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout  65;
    client_max_body_size 100m;

    include /data/data/com.termux/files/usr/etc/nginx/conf.d/*.conf;
}
NGINX_CONF
            log_ok "nginx.conf atualizado com sucesso"
        fi
    else
        log_err "Erro de sintaxe no nginx.conf"
        # Backup e recria
        cp "$NGINX_MAIN" "$NGINX_MAIN.bak.$(date +%s)"
        log_fix "Backup criado, reescrevendo nginx.conf..."

        cat > "$NGINX_MAIN" << 'NGINX_CONF'
worker_processes  auto;
error_log  /data/data/com.termux/files/usr/var/log/nginx/error.log warn;
pid        /data/data/com.termux/files/usr/var/run/nginx.pid;

events {
    worker_connections  256;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout  65;
    client_max_body_size 100m;

    include /data/data/com.termux/files/usr/etc/nginx/conf.d/*.conf;
}
NGINX_CONF
        log_ok "nginx.conf recriado com configuração padrão"
    fi
else
    log_err "nginx.conf não encontrado!"
    log_fix "Criando nginx.conf padrão..."
    cat > "$NGINX_MAIN" << 'NGINX_CONF'
worker_processes  auto;
error_log  /data/data/com.termux/files/usr/var/log/nginx/error.log warn;
pid        /data/data/com.termux/files/usr/var/run/nginx.pid;

events {
    worker_connections  256;
}

http {
    include       mime.types;
    default_type  application/octet-stream;
    sendfile      on;
    keepalive_timeout  65;
    client_max_body_size 100m;

    include /data/data/com.termux/files/usr/etc/nginx/conf.d/*.conf;
}
NGINX_CONF
    log_ok "nginx.conf criado"
fi

# =============================================================
# 6. PHPMYADMIN — NGINX VHOST
# =============================================================
log_sep
log_info "Verificando configuração phpMyAdmin no NGINX..."

# Detecta o socket PHP-FPM correto
DETECTED_SOCK=""
for try_sock in \
    "$PREFIX/var/run/php-fpm.sock" \
    "$PREFIX/tmp/php-fpm.sock" \
    "/tmp/php-fpm.sock"; do
    if [ -S "$try_sock" ]; then
        DETECTED_SOCK="$try_sock"
        break
    fi
done
[ -z "$DETECTED_SOCK" ] && DETECTED_SOCK="$PREFIX/var/run/php-fpm.sock"
log_info "Socket PHP-FPM a usar: $DETECTED_SOCK"

# Verifica se o diretório do phpMyAdmin existe
if [ -d "$PMA_DIR" ]; then
    log_ok "Diretório phpMyAdmin: $PMA_DIR"
else
    # Tenta localizar
    ALT_PMA=$(find "$PREFIX/share" -name "phpmyadmin" -type d 2>/dev/null | head -1)
    if [ -n "$ALT_PMA" ]; then
        PMA_DIR="$ALT_PMA"
        log_warn "phpMyAdmin encontrado em local alternativo: $PMA_DIR"
    else
        log_err "Diretório phpMyAdmin não encontrado"
        log_fix "Tente: pkg install phpmyadmin"
    fi
fi

# Cria/corrige o vhost do phpMyAdmin
if [ -f "$PMA_NGINX_CONF" ]; then
    log_ok "Arquivo de vhost phpMyAdmin existe"
    # Verifica se o conteúdo referencia o diretório correto
    if grep -q "$PMA_DIR" "$PMA_NGINX_CONF" 2>/dev/null && grep -q "/phpmyadmin/" "$PMA_NGINX_CONF" 2>/dev/null && ! grep -q "include       fastcgi_params;" "$PMA_NGINX_CONF" 2>/dev/null; then
        log_ok "Vhost aponta para o diretório correto"
    else
        log_warn "Vhost phpMyAdmin com referência incorreta de path"
        log_fix "Recriando vhost phpMyAdmin..."
        REWRITE_PMA=true
    fi
else
    log_err "Vhost phpMyAdmin não encontrado: $PMA_NGINX_CONF"
    log_fix "Criando vhost phpMyAdmin na porta $PMA_PORT..."
    REWRITE_PMA=true
fi

if [ "$REWRITE_PMA" = true ]; then
    FASTCGI_PASS="unix:${DETECTED_SOCK}"
    if [ ! -S "$DETECTED_SOCK" ]; then
        FASTCGI_PASS="127.0.0.1:9000"
    fi
    FASTCGI_INCLUDE=""
    for try_include in \
        "$PREFIX/etc/nginx/fastcgi_params" \
        "$PREFIX/etc/nginx/fastcgi.conf" \
        "/etc/nginx/fastcgi_params" \
        "/etc/nginx/fastcgi.conf"; do
        if [ -f "$try_include" ]; then
            FASTCGI_INCLUDE="$try_include"
            break
        fi
    done
    if [ -z "$FASTCGI_INCLUDE" ]; then
        FASTCGI_INCLUDE="$PREFIX/etc/nginx/fastcgi_params"
        mkdir -p "$(dirname "$FASTCGI_INCLUDE")"
        cat > "$FASTCGI_INCLUDE" <<'FASTCGI_PARAMS'
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
    fi

    cat > "$PMA_NGINX_CONF" << PMA_CONF
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
        alias ${PMA_DIR}/;
        index index.php index.html;
        try_files \$uri \$uri/ /phpmyadmin/index.php?\$query_string;
    }

    location ~ ^/phpmyadmin/(.+\\.php)$ {
        alias ${PMA_DIR}/\$1;
        fastcgi_pass  ${FASTCGI_PASS};
        fastcgi_index index.php;
        fastcgi_param SCRIPT_FILENAME \$request_filename;
        include       ${FASTCGI_INCLUDE};
    }

    location ~ /\\.(ht|git) {
        deny all;
    }
}
PMA_CONF
    log_ok "Vhost phpMyAdmin criado: $PMA_NGINX_CONF (porta $PMA_PORT)"
fi

# =============================================================
# 7. phpMyAdmin — config.inc.php
# =============================================================
log_sep
log_info "Verificando config.inc.php do phpMyAdmin..."

PMA_CONFIG="$PMA_DIR/config.inc.php"
PMA_CONFIG_SAMPLE="$PMA_DIR/config.sample.inc.php"

if [ -f "$PMA_CONFIG" ]; then
    log_ok "config.inc.php existe"
    # Verifica se tem blowfish_secret definido
    if grep -q "blowfish_secret" "$PMA_CONFIG" 2>/dev/null; then
        SECRET=$(grep "blowfish_secret" "$PMA_CONFIG" | sed "s/.*'\(.*\)'.*/\1/" | head -1)
        if [ ${#SECRET} -ge 32 ]; then
            log_ok "blowfish_secret configurado (${#SECRET} chars)"
        else
            log_warn "blowfish_secret muito curto (${#SECRET} chars, mínimo 32)"
            log_fix "Atualizando blowfish_secret..."
            NEW_SECRET=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 48)
            sed -i "s/\(blowfish_secret.*'\).*\('.*\)/\1${NEW_SECRET}\2/" "$PMA_CONFIG"
            log_ok "blowfish_secret atualizado"
        fi
    else
        log_warn "blowfish_secret não encontrado no config"
    fi
else
    log_err "config.inc.php não encontrado"
    if [ -f "$PMA_CONFIG_SAMPLE" ]; then
        log_fix "Criando a partir do config.sample.inc.php..."
        cp "$PMA_CONFIG_SAMPLE" "$PMA_CONFIG"

        # Gera blowfish_secret seguro
        NEW_SECRET=$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 48)
        sed -i "s/\(blowfish_secret.*'\).*\('\)/\1${NEW_SECRET}\2/" "$PMA_CONFIG"

        # Configura host do MariaDB
        sed -i "s/\['host'\] = .*/['host'] = 'localhost';/" "$PMA_CONFIG" 2>/dev/null
        log_ok "config.inc.php criado com blowfish_secret seguro"
    else
        log_err "config.sample.inc.php também não encontrado — reinstale o phpMyAdmin"
    fi
fi

# =============================================================
# 8. NGINX — INICIAR/RECARREGAR
# =============================================================
log_sep
log_info "Verificando processo NGINX..."

NGINX_RUNNING=0
if pgrep -f "nginx" > /dev/null 2>&1 || pgrep -x "nginx" > /dev/null 2>&1; then
    NGINX_RUNNING=1
elif nginx -s reload >/dev/null 2>&1; then
    NGINX_RUNNING=1
fi

if [ $NGINX_RUNNING -eq 1 ]; then
    log_ok "NGINX está rodando"
    # Recarrega para pegar novas configs
    log_fix "Recarregando configurações do NGINX..."
    nginx -s reload 2>/dev/null && log_ok "NGINX recarregado" || log_warn "Falha ao recarregar NGINX"
    
    # Verifica porta 80
    if nc -z 127.0.0.1 80 2>/dev/null; then
        log_ok "Porta 80 (NGINX) está acessível"
    else
        log_warn "Porta 80 não responde"
    fi

    # Verifica porta phpMyAdmin
    if nc -z 127.0.0.1 "$PMA_PORT" 2>/dev/null; then
        log_ok "Porta $PMA_PORT (phpMyAdmin) está acessível"
    else
        log_warn "Porta $PMA_PORT (phpMyAdmin) não responde ainda"
    fi
else
    log_warn "NGINX não está em execução"
    log_fix "Testando configuração e iniciando NGINX..."
    if nginx -t 2>/dev/null; then
        NGOUT=$(nginx 2>&1)
        sleep 2
        if pgrep -f "nginx" > /dev/null 2>&1 || pgrep -x "nginx" > /dev/null 2>&1 || nginx -s reload >/dev/null 2>&1; then
            log_ok "NGINX iniciado com sucesso"
        else
            log_err "Falha ao iniciar NGINX: $NGOUT"
        fi
    else
        log_err "Config NGINX com erros — não iniciado"
        nginx -t 2>&1 | while IFS= read -r line; do
            echo -e "  ${RED}→ $line${NC}"
        done
    fi
fi

# =============================================================
# 9. RELATÓRIO FINAL
# =============================================================
log_sep
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║           RELATÓRIO FINAL                ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════╝${NC}"
echo ""

if [ $ERRORS -eq 0 ] && [ $FIXED -eq 0 ]; then
    echo -e "${GREEN}${BOLD}✅  Tudo OK! Nenhum problema encontrado.${NC}"
elif [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}${BOLD}✅  Problemas encontrados e corrigidos!${NC}"
else
    echo -e "${YELLOW}${BOLD}⚠️  Alguns problemas persistem.${NC}"
fi

echo ""
echo -e "  Erros restantes : ${RED}$ERRORS${NC}"
echo -e "  Correções feitas: ${GREEN}$FIXED${NC}"
echo -e "  Avisos          : ${YELLOW}$WARNINGS${NC}"
echo ""

if nc -z 127.0.0.1 "$PMA_PORT" 2>/dev/null; then
    echo -e "${GREEN}${BOLD}🌐 phpMyAdmin disponível em: http://localhost:${PMA_PORT}${NC}"
fi
if nc -z 127.0.0.1 80 2>/dev/null; then
    echo -e "${GREEN}${BOLD}🌐 NGINX disponível em: http://localhost:80${NC}"
fi

echo ""
echo -e "${BOLD}Dica: execute novamente para confirmar que tudo está OK.${NC}"
echo ""

# Retorna código de saída baseado nos erros
exit $ERRORS
