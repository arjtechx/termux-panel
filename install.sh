#!/usr/bin/env bash

# --- Termux cPanel — Instalador Inteligente ---
# Suporte: Termux (Android) & Linux Padrão (Debian/Ubuntu)
# Versão: 3.0 — com detecção de conflitos MariaDB e recovery

BANNER="
   ______                               __
  / ____/___  ____  ____  ___  ____    / /
 / /   / __ \/ __ \/ __ \/ _ \/ / / /  / /
/ /___/ /_/ / / / / / / /  __/ /_/ /  / /
\____/ .___/_/ /_/_/ /_/\___/\__,_/  /_/
    /_/
      Management & Setup Assistant v3.0
"

# Cores
RED='\e[1;31m'
GREEN='\e[1;32m'
YELLOW='\e[1;33m'
BLUE='\e[1;34m'
CYAN='\e[1;36m'
RESET='\e[0m'

log()  { echo -e "${BLUE}[*]${RESET} $1"; }
ok()   { echo -e "${GREEN}[+]${RESET} $1"; }
warn() { echo -e "${YELLOW}[!]${RESET} $1"; }
err()  { echo -e "${RED}[-]${RESET} $1"; }
ask()  { echo -e "${CYAN}[?]${RESET} $1"; }

function show_banner() {
    clear
    echo -e "${BLUE}${BANNER}${RESET}"
}

# ─── Variáveis Globais ───────────────────────────────────────────
IS_TERMUX=false
HAS_ROOT=false
PKG_MGR="apt-get"
SUDO=""
ENV_PREFIX=""
MYSQL_DIR=""
INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

function repair_nginx_bootstrap() {
    if [ "$IS_TERMUX" != true ]; then
        return 0
    fi

    local repair_script="$INSTALLER_DIR/scripts/nginx-termux-repair.sh"
    if [ ! -f "$repair_script" ]; then
        warn "Reparo NGINX/mime.types nao encontrado: $repair_script"
        return 0
    fi

    log "Aplicando reparo base do NGINX/mime.types..."
    sh "$repair_script" || warn "Reparo NGINX/mime.types falhou. Rode: bash scripts/nginx-termux-repair.sh"
}

# ─── Detecção de SO ──────────────────────────────────────────────
function detect_os() {
    if [ -n "$PREFIX" ] && [[ "$PREFIX" == *"com.termux"* ]]; then
        IS_TERMUX=true
        PKG_MGR="pkg"
        ENV_PREFIX="$PREFIX"
    elif uname -o 2>/dev/null | grep -qi "Android"; then
        IS_TERMUX=true
        PKG_MGR="pkg"
        ENV_PREFIX="/data/data/com.termux/files/usr"
    else
        if [ "$EUID" -ne 0 ]; then
            if command -v sudo >/dev/null 2>&1; then
                SUDO="sudo "
                HAS_ROOT=true
            fi
        else
            HAS_ROOT=true
        fi
    fi

    if [ "$IS_TERMUX" = true ]; then
        MYSQL_DIR="$ENV_PREFIX/var/lib/mysql"
        log "Sistema detectado: ${CYAN}Termux (Android)${RESET}"
    else
        MYSQL_DIR="/var/lib/mysql"
        log "Sistema detectado: ${CYAN}Linux Padrão${RESET}"
    fi

    # Pergunta sobre Root no Termux
    if [ "$IS_TERMUX" = true ]; then
        ask "Seu aparelho possui acesso ROOT (Magisk/KernelSU)?"
        read -p "Ativar modo Superusuário? (s/N): " USE_ROOT
        if [[ "${USE_ROOT,,}" == "s" ]]; then
            if su -c 'echo ok' >/dev/null 2>&1; then
                HAS_ROOT=true
                ok "Acesso Root concedido!"
            else
                warn "Falha ao obter Root. Continuando no modo normal."
            fi
        fi
    fi
}

function save_system_config() {
    mkdir -p config
    cat <<EOF > config/system.json
{
    "is_termux": $IS_TERMUX,
    "has_root": $HAS_ROOT,
    "package_manager": "$PKG_MGR",
    "prefix": "$ENV_PREFIX"
}
EOF
}

# ─── [1] DETECÇÃO DE MARIADB ANTIGO ─────────────────────────────
function detect_mariadb() {
    local found=false
    if command -v mariadbd >/dev/null 2>&1; then found=true; fi
    if command -v mysqld >/dev/null 2>&1; then found=true; fi
    if [ "$IS_TERMUX" = true ] && pkg list-installed 2>/dev/null | grep -q "mariadb"; then found=true; fi
    if [ "$IS_TERMUX" = false ] && dpkg -l 2>/dev/null | grep -qw mariadb; then found=true; fi
    if [ -d "$MYSQL_DIR" ]; then found=true; fi

    echo "$found"
}

# ─── [2] PARAR PROCESSOS MARIADB ────────────────────────────────
function stop_mariadb() {
    log "Parando processos MariaDB/MySQL..."
    pkill -9 mariadbd 2>/dev/null || true
    pkill -9 mysqld    2>/dev/null || true
    pkill -9 mysqld_safe 2>/dev/null || true
    sleep 2
    ok "Processos encerrados."
}

# ─── [3] REMOÇÃO COMPLETA DO MARIADB ────────────────────────────
function remove_mariadb_completely() {
    stop_mariadb

    log "Removendo pacotes MariaDB..."
    if [ "$IS_TERMUX" = true ]; then
        # NÃO usar pkg autoremove — não existe no Termux
        pkg uninstall mariadb -y 2>/dev/null || apt remove mariadb -y 2>/dev/null || true
        apt purge  mariadb -y 2>/dev/null || true
    else
        ${SUDO}apt-get remove  --purge mariadb-server mariadb-client -y 2>/dev/null || true
        ${SUDO}apt-get autoremove -y 2>/dev/null || true
    fi

    log "Limpando dados e arquivos antigos..."
    rm -rf "$MYSQL_DIR"
    rm -rf "$ENV_PREFIX/etc/my.cnf" 2>/dev/null || true
    rm -rf "$ENV_PREFIX/var/run/mysqld" 2>/dev/null || true
    rm -rf "$ENV_PREFIX/tmp/mysql.sock" 2>/dev/null || true
    rm -rf ~/.mysql_history 2>/dev/null || true
    rm -rf ~/.my.cnf        2>/dev/null || true
    ok "MariaDB removido completamente."
}

# ─── [4] REPARAR PACOTES QUEBRADOS ──────────────────────────────
function repair_packages() {
    log "Reparando sistema de pacotes..."
    if [ "$IS_TERMUX" = true ]; then
        pkg clean        2>/dev/null || true
        apt autoclean    2>/dev/null || true
        apt --fix-broken install -y 2>/dev/null || true
        dpkg --configure -a 2>/dev/null || true
        apt update 2>/dev/null || true
    else
        ${SUDO}apt-get autoclean    2>/dev/null || true
        ${SUDO}apt-get --fix-broken install -y 2>/dev/null || true
        ${SUDO}dpkg --configure -a  2>/dev/null || true
        ${SUDO}apt-get update       2>/dev/null || true
    fi
    ok "Sistema de pacotes reparado."
}

# ─── [5] INSTALAR MARIADB LIMPO ─────────────────────────────────
function install_mariadb_clean() {
    log "Instalando MariaDB do zero..."
    if [ "$IS_TERMUX" = true ]; then
        pkg install mariadb -y
    else
        ${SUDO}apt-get install mariadb-server mariadb-client -y
    fi

    if ! command -v mariadbd >/dev/null 2>&1 && ! command -v mysqld >/dev/null 2>&1; then
        err "Falha na instalação do MariaDB!"
        return 1
    fi
    ok "MariaDB instalado com sucesso."
}

# ─── [5.5] GERAR CONFIGURAÇÃO MY.CNF DO MARIADB ──────────────────
function generate_my_cnf() {
    log "Gerando configuração do MariaDB (my.cnf)..."
    local PANEL_DIR="$(pwd)"
    mkdir -p "$PANEL_DIR/logs"
    chmod 777 "$PANEL_DIR/logs" 2>/dev/null || true

    if [ "$IS_TERMUX" = true ]; then
        mkdir -p "$ENV_PREFIX/etc"
        mkdir -p "$ENV_PREFIX/var/run/mysqld"
        chmod 777 "$ENV_PREFIX/var/run/mysqld" 2>/dev/null || true
        
        cat <<EOF > "$ENV_PREFIX/etc/my.cnf"
[client]
socket = $ENV_PREFIX/var/run/mysqld/mysqld.sock
port = 3306

[mysqld]
socket = $ENV_PREFIX/var/run/mysqld/mysqld.sock
port = 3306
datadir = $MYSQL_DIR
bind-address = 127.0.0.1
default-storage-engine = InnoDB
innodb_file_per_table = 1
log-error = $PANEL_DIR/logs/mariadb.log
EOF
    else
        ${SUDO}mkdir -p "/etc"
        ${SUDO}mkdir -p "/var/run/mysqld"
        ${SUDO}chmod 777 "/var/run/mysqld" 2>/dev/null || true
        
        cat <<EOF | ${SUDO}tee "/etc/my.cnf" >/dev/null
[client]
socket = /var/run/mysqld/mysqld.sock
port = 3306

[mysqld]
socket = /var/run/mysqld/mysqld.sock
port = 3306
datadir = $MYSQL_DIR
bind-address = 127.0.0.1
default-storage-engine = InnoDB
innodb_file_per_table = 1
log-error = $PANEL_DIR/logs/mariadb.log
EOF
    fi
    ok "my.cnf gerado com sucesso."
}

# ─── [6] INICIALIZAR BANCO DE DADOS ─────────────────────────────
function init_mariadb() {
    log "Inicializando banco de dados..."
    if [ -d "$MYSQL_DIR/mysql" ]; then
        warn "Banco já inicializado, pulando."
        return 0
    fi

    mkdir -p "$MYSQL_DIR"

    if command -v mariadb-install-db >/dev/null 2>&1; then
        mariadb-install-db 2>/dev/null
    elif command -v mysql_install_db >/dev/null 2>&1; then
        mysql_install_db 2>/dev/null
    else
        err "Nenhum inicializador de banco encontrado!"
        return 1
    fi
    ok "Banco inicializado."
}

# ─── [7] SUBIR SERVIDOR TEMPORÁRIO ──────────────────────────────
function start_mariadb_temp() {
    log "Iniciando servidor MariaDB temporário..."
    
    # Garante o diretório do socket do MariaDB para evitar crashes
    local run_dir="$ENV_PREFIX/var/run/mysqld"
    mkdir -p "$run_dir"
    chmod 777 "$run_dir" 2>/dev/null || true
    chown "$(whoami)" "$run_dir" 2>/dev/null || true

    # Garante permissões do diretório de dados
    mkdir -p "$MYSQL_DIR"
    chmod -R 777 "$MYSQL_DIR" 2>/dev/null || true
    chown -R "$(whoami)" "$MYSQL_DIR" 2>/dev/null || true

    if mysql -u root -e "SELECT 1" >/dev/null 2>&1; then
        ok "MariaDB já está respondendo."
        return 0
    fi

    if command -v mariadbd-safe >/dev/null 2>&1; then
        mariadbd-safe --datadir="$MYSQL_DIR" --socket="$run_dir/mysqld.sock" --port=3306 >/dev/null 2>&1 &
    elif command -v mysqld_safe >/dev/null 2>&1; then
        mysqld_safe --datadir="$MYSQL_DIR" --socket="$run_dir/mysqld.sock" --port=3306 >/dev/null 2>&1 &
    else
        err "Nenhum daemon MariaDB encontrado!"
        return 1
    fi

    log "Aguardando MariaDB iniciar..."
    local tries=0
    while [ $tries -lt 10 ]; do
        sleep 2
        if mysql -u root -e "SELECT 1" >/dev/null 2>&1; then
            ok "MariaDB está respondendo!"
            return 0
        fi
        tries=$((tries + 1))
        echo -n "."
    done
    echo ""
    err "MariaDB não respondeu após 20s."
    return 1
}

# ─── [8] CONFIGURAR USUÁRIO E BANCO VIA PAINEL ──────────────────
function configure_database_interactive() {
    echo ""
    echo -e "${CYAN}════════════════════════════════════════${RESET}"
    echo -e "${CYAN}   CONFIGURAÇÃO DO BANCO DE DADOS       ${RESET}"
    echo -e "${CYAN}════════════════════════════════════════${RESET}"
    echo ""

    read -p "  Usuário Admin DB    [padrão: admin]: " DB_USER
    DB_USER=${DB_USER:-admin}

    read -s -p "  Senha Admin DB     [padrão: admin123]: " DB_PASS
    echo ""
    DB_PASS=${DB_PASS:-admin123}

    read -p "  Porta MariaDB      [padrão: 3306]: " DB_PORT
    DB_PORT=${DB_PORT:-3306}

    read -p "  Nome do Banco      [padrão: painel]: " DB_NAME
    DB_NAME=${DB_NAME:-painel}

    echo ""
    log "Criando banco '$DB_NAME' e usuário '$DB_USER'..."

    # Executa os SQLs como root sem senha (instalação nova)
    mysql -u root 2>/dev/null <<EOSQL
CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;
CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
CREATE USER IF NOT EXISTS '${DB_USER}'@'127.0.0.1' IDENTIFIED BY '${DB_PASS}';
GRANT ALL PRIVILEGES ON *.* TO '${DB_USER}'@'localhost' WITH GRANT OPTION;
GRANT ALL PRIVILEGES ON *.* TO '${DB_USER}'@'127.0.0.1' WITH GRANT OPTION;
FLUSH PRIVILEGES;
EOSQL

    local sql_result=$?

    if [ $sql_result -ne 0 ]; then
        warn "Criação via root sem senha falhou. Tentando alternativa..."
        mysql -u root -e "
            CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\`;
            CREATE USER IF NOT EXISTS '${DB_USER}'@'localhost' IDENTIFIED BY '${DB_PASS}';
            GRANT ALL PRIVILEGES ON *.* TO '${DB_USER}'@'localhost' WITH GRANT OPTION;
            FLUSH PRIVILEGES;" 2>/dev/null || true
    fi

    # ─── [9] SALVAR CONFIG ───────────────────────────────────────
    mkdir -p config
    cat <<EOF > config/database.json
{
    "host": "127.0.0.1",
    "port": $DB_PORT,
    "database": "$DB_NAME",
    "user": "$DB_USER",
    "password": "$DB_PASS"
}
EOF

    # Manter compatibilidade com db.json (usado pelo server.js)
    cat <<EOF > config/db.json
{
    "host": "127.0.0.1",
    "port": $DB_PORT,
    "database": "$DB_NAME",
    "user": "$DB_USER",
    "password": "$DB_PASS"
}
EOF

    ok "Configuração salva em config/database.json e config/db.json"
}

# ─── [10] TESTE DE CONEXÃO ──────────────────────────────────────
function test_db_connection() {
    local cfg_user="$1"
    local cfg_pass="$2"
    local cfg_port="${3:-3306}"

    log "Testando conexão com MariaDB..."
    if mariadb -u "$cfg_user" -p"$cfg_pass" -P "$cfg_port" -e "SHOW DATABASES;" >/dev/null 2>&1; then
        ok "Conexão OK! Bancos disponíveis:"
        mariadb -u "$cfg_user" -p"$cfg_pass" -P "$cfg_port" -e "SHOW DATABASES;" 2>/dev/null
        return 0
    else
        err "Falha ao conectar com usuário '$cfg_user'."
        echo ""
        ask "O que deseja fazer?"
        echo "  [1] Reconfigurar usuário/senha"
        echo "  [2] Continuar assim mesmo"
        read -p "Opção: " retry_opt
        if [[ "$retry_opt" == "1" ]]; then
            configure_database_interactive
            if [ -f config/database.json ]; then
                local u p po
                u=$(python3 -c "import json,sys; d=json.load(open('config/database.json')); print(d.get('user',''))" 2>/dev/null)
                p=$(python3 -c "import json,sys; d=json.load(open('config/database.json')); print(d.get('password',''))" 2>/dev/null)
                po=$(python3 -c "import json,sys; d=json.load(open('config/database.json')); print(d.get('port',3306))" 2>/dev/null)
                test_db_connection "$u" "$p" "$po"
            fi
        fi
        return 1
    fi
}

# ─── [11] GERAR config.inc.php DO PHPMYADMIN ────────────────────
function generate_phpmyadmin_config() {
    local pma_cfg_dir=""
    if [ -d "$ENV_PREFIX/share/phpmyadmin" ]; then
        pma_cfg_dir="$ENV_PREFIX/share/phpmyadmin"
    elif [ -d "/usr/share/phpmyadmin" ]; then
        pma_cfg_dir="/usr/share/phpmyadmin"
    fi

    if [ -z "$pma_cfg_dir" ]; then
        warn "phpMyAdmin não encontrado. Pulando configuração."
        return
    fi

    local db_user db_pass
    db_user=$(python3 -c "import json; d=json.load(open('config/database.json')); print(d.get('user','admin'))" 2>/dev/null || echo "admin")
    db_pass=$(python3 -c "import json; d=json.load(open('config/database.json')); print(d.get('password',''))" 2>/dev/null || echo "")

    cat <<EOF > "$pma_cfg_dir/config.inc.php"
<?php
\$cfg['blowfish_secret'] = '$(cat /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 32)';
\$i = 0;
\$i++;
\$cfg['Servers'][\$i]['auth_type']   = 'config';
\$cfg['Servers'][\$i]['host']        = '127.0.0.1';
\$cfg['Servers'][\$i]['port']        = '3306';
\$cfg['Servers'][\$i]['user']        = '${db_user}';
\$cfg['Servers'][\$i]['password']    = '${db_pass}';
\$cfg['Servers'][\$i]['AllowNoPassword'] = true;
EOF
    ok "config.inc.php do phpMyAdmin gerado em: $pma_cfg_dir"
}

# ─── [12] RECUPERAÇÃO DO MARIADB (Recovery) ─────────────────────
function mariadb_recovery() {
    show_banner
    echo -e "${RED}════════════════════════════════════════${RESET}"
    echo -e "${RED}     RECOVERY DO MARIADB                ${RESET}"
    echo -e "${RED}════════════════════════════════════════${RESET}"
    echo ""
    echo "  [1] Reparar tabelas corrompidas"
    echo "  [2] Reinstalar MariaDB (dados SERÃO apagados)"
    echo "  [3] Restaurar último backup SQL"
    echo "  [0] Voltar"
    echo ""
    read -p "Opção: " ropt

    case $ropt in
        1)
            log "Reparando tabelas..."
            stop_mariadb
            if command -v mariadbd >/dev/null 2>&1; then
                mariadbd --user=root --skip-grant-tables --skip-networking &
            else
                mysqld --user=root --skip-grant-tables --skip-networking &
            fi
            sleep 4
            mysqlcheck --all-databases --repair --auto-repair -u root 2>/dev/null || \
                mariadb-check --all-databases --repair --auto-repair -u root 2>/dev/null || \
                warn "mysqlcheck não encontrado."
            pkill -9 mariadbd 2>/dev/null; pkill -9 mysqld 2>/dev/null
            sleep 2
            start_mariadb_temp
            ok "Reparo concluído."
            ;;
        2)
            warn "ATENÇÃO: Todos os dados do banco serão apagados!"
            read -p "Confirma? (sim/N): " CONF
            if [[ "${CONF,,}" == "sim" ]]; then
                remove_mariadb_completely
                repair_packages
                install_mariadb_clean
                init_mariadb
                start_mariadb_temp
                configure_database_interactive
                ok "MariaDB reinstalado com sucesso!"
            else
                warn "Cancelado."
            fi
            ;;
        3)
            local backup_dir
            backup_dir="$(cd "$(dirname "$0")" && pwd)/../backups"
            if [ ! -d "$backup_dir" ]; then
                err "Pasta de backups não encontrada: $backup_dir"
            else
                echo "Backups disponíveis:"
                ls -lh "$backup_dir"/*.sql 2>/dev/null || err "Nenhum backup .sql encontrado."
                read -p "Nome do arquivo (ex: db-all-2025.sql): " bkfile
                local bkpath="$backup_dir/$bkfile"
                if [ -f "$bkpath" ]; then
                    local db_user db_pass
                    db_user=$(python3 -c "import json; d=json.load(open('config/database.json')); print(d.get('user','root'))" 2>/dev/null || echo "root")
                    db_pass=$(python3 -c "import json; d=json.load(open('config/database.json')); print(d.get('password',''))" 2>/dev/null || echo "")
                    mysql -u "$db_user" -p"$db_pass" < "$bkpath" && ok "Backup restaurado!" || err "Falha na restauração."
                else
                    err "Arquivo não encontrado: $bkpath"
                fi
            fi
            ;;
        0) return ;;
        *) warn "Opção inválida." ;;
    esac
    sleep 3
}

# ─── MENU: INSTALAÇÃO PRINCIPAL ──────────────────────────────────
function install_panel() {
    show_banner
    detect_os

    echo ""
    log "Verificando instalação existente do MariaDB..."
    local mariadb_found
    mariadb_found=$(detect_mariadb)

    if [ "$mariadb_found" = "true" ]; then
        echo ""
        warn "MariaDB existente detectado!"
        echo ""
        echo "  [1] Reutilizar instalação atual"
        echo "  [2] Reinstalar do zero (REMOVE dados antigos)"
        echo ""
        read -p "Opção: " db_opt

        if [[ "$db_opt" == "2" ]]; then
            remove_mariadb_completely
            repair_packages
            install_mariadb_clean
            init_mariadb
        else
            log "Reutilizando MariaDB existente..."
            repair_packages
        fi
    else
        log "Nenhum MariaDB encontrado. Instalando..."
        repair_packages
        install_mariadb_clean
        init_mariadb
    fi

    # Subir MariaDB
    generate_my_cnf
    start_mariadb_temp

    # Verificar deps restantes (nodejs, nginx, etc.)
    log "Instalando outras dependências..."
    if [ "$IS_TERMUX" = true ]; then
        pkg install -y nodejs nginx cloudflared termux-api coreutils procps zip unzip psmisc lsof python php php-fpm phpmyadmin 2>/dev/null || true
        repair_nginx_bootstrap
    else
        ${SUDO}apt-get install -y nodejs nginx coreutils procps zip unzip psmisc lsof python3 php-fpm 2>/dev/null || true
    fi

    # Validação e Download do Cloudflared oficial se ausente ou quebrado
    function ensure_cloudflared_binary() {
        if command -v cloudflared >/dev/null 2>&1; then
            ok "Cloudflared já está instalado e funcional no sistema."
            return 0
        fi

        log "Aviso: 'cloudflared' não foi encontrado no PATH. Iniciando download do binário oficial da Cloudflare..."
        
        local arch
        arch=$(uname -m)
        local download_url=""
        
        case "$arch" in
            x86_64)
                download_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
                ;;
            aarch64)
                download_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64"
                ;;
            armv7l|armhf)
                download_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm"
                ;;
            i386|i686)
                download_url="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-386"
                ;;
            *)
                warn "Arquitetura '$arch' desconhecida para download automatizado. Instale o cloudflared manualmente."
                return 1
                ;;
        esac

        local install_dest
        if [ "$IS_TERMUX" = true ]; then
            install_dest="$PREFIX/bin/cloudflared"
        else
            install_dest="/usr/local/bin/cloudflared"
        fi

        log "Baixando binário oficial ($arch) de: $download_url"
        local tmp_bin
        tmp_bin=$(mktemp)
        if curl -L -s -S -o "$tmp_bin" "$download_url"; then
            if [ "$IS_TERMUX" = true ]; then
                cp "$tmp_bin" "$install_dest"
                chmod +x "$install_dest"
            else
                ${SUDO}cp "$tmp_bin" "$install_dest"
                ${SUDO}chmod +x "$install_dest"
            fi
            rm -f "$tmp_bin"
            ok "Cloudflared instalado com sucesso em $install_dest."
        else
            rm -f "$tmp_bin"
            warn "Falha ao baixar o cloudflared. Certifique-se de que possui internet ativa e tente novamente."
            return 1
        fi
    }

    ensure_cloudflared_binary

    save_system_config

    # ─── Configurar acesso ao painel ────────────────────────────
    echo ""
    echo -e "${CYAN}════════════════════════════════════════${RESET}"
    echo -e "${CYAN}   CONFIGURAÇÃO DE ACESSO AO PAINEL     ${RESET}"
    echo -e "${CYAN}════════════════════════════════════════${RESET}"
    echo ""
    read -p "  Usuário admin painel [padrão: admin]: " ADMIN_USER
    ADMIN_USER=${ADMIN_USER:-admin}
    read -s -p "  Senha admin painel   [padrão: admin]: " ADMIN_PASS
    echo ""
    ADMIN_PASS=${ADMIN_PASS:-admin}

    mkdir -p config
    echo "{\"user\":\"$ADMIN_USER\", \"pass\":\"$ADMIN_PASS\"}" > config/auth.json
    ok "Acesso ao painel configurado."

    # ─── Configurar banco de dados ───────────────────────────────
    configure_database_interactive

    # ─── Testar conexão ─────────────────────────────────────────
    local db_user db_pass db_port
    db_user=$(python3 -c "import json; d=json.load(open('config/database.json')); print(d.get('user','admin'))" 2>/dev/null || echo "admin")
    db_pass=$(python3 -c "import json; d=json.load(open('config/database.json')); print(d.get('password',''))" 2>/dev/null || echo "")
    db_port=$(python3 -c "import json; d=json.load(open('config/database.json')); print(d.get('port',3306))" 2>/dev/null || echo "3306")
    test_db_connection "$db_user" "$db_pass" "$db_port"

    # ─── phpMyAdmin ──────────────────────────────────────────────
    generate_phpmyadmin_config
    repair_nginx_bootstrap
    if [ -f "scripts/setup-pma-sso.sh" ]; then
        bash scripts/setup-pma-sso.sh || warn "SSO do phpMyAdmin nao foi configurado. Rode scripts/health-check.sh para detalhes."
    fi

    # ─── Ajustar Permissões Críticas ─────────────────────────────
    log "Garantindo permissões corretas para o usuário local..."
    if [ "$IS_TERMUX" = true ]; then
        local current_user
        current_user=$(whoami)
        mkdir -p "$ENV_PREFIX/var/run" "$ENV_PREFIX/var/log/nginx" "$ENV_PREFIX/var/lib/mysql" "$ENV_PREFIX/tmp" "$ENV_PREFIX/etc/nginx" "$ENV_PREFIX/etc/nginx/conf.d"
        chmod -R 777 "$ENV_PREFIX/var/run" "$ENV_PREFIX/var/log/nginx" "$ENV_PREFIX/var/lib/mysql" "$ENV_PREFIX/tmp" "$ENV_PREFIX/etc/nginx" "$ENV_PREFIX/etc/nginx/conf.d" 2>/dev/null || true
        chown -R "$current_user" "$ENV_PREFIX/var/run" "$ENV_PREFIX/var/log/nginx" "$ENV_PREFIX/var/lib/mysql" "$ENV_PREFIX/tmp" "$ENV_PREFIX/etc/nginx" "$ENV_PREFIX/etc/nginx/conf.d" 2>/dev/null || true
    fi

    # ─── Node.js deps ────────────────────────────────────────────
    echo ""
    log "Instalando bibliotecas Node.js..."
    # npm install  # Desativado para evitar reinstalação automática de dependências
    if [ -d "node_modules" ]; then
        ok "Dependências Node já presentes."
    else
        warn "Diretório node_modules não encontrado. Instale manualmente se necessário."
    fi

    echo ""
    echo -e "${GREEN}════════════════════════════════════════${RESET}"
    ok "Instalação concluída com sucesso!"
    echo -e "${GREEN}════════════════════════════════════════${RESET}"
    sleep 2
}

function update_panel() {
    show_banner
    detect_os
    
    # ─── Gerar my.cnf robusto se necessário ──────────────────────
    generate_my_cnf
    
    # ─── Ajustar Permissões Críticas ─────────────────────────────
    log "Garantindo permissões corretas para o usuário local..."
    if [ "$IS_TERMUX" = true ]; then
        local current_user
        current_user=$(whoami)
        mkdir -p "$ENV_PREFIX/var/run" "$ENV_PREFIX/var/log/nginx" "$ENV_PREFIX/var/lib/mysql" "$ENV_PREFIX/tmp" "$ENV_PREFIX/etc/nginx" "$ENV_PREFIX/etc/nginx/conf.d"
        chmod -R 777 "$ENV_PREFIX/var/run" "$ENV_PREFIX/var/log/nginx" "$ENV_PREFIX/var/lib/mysql" "$ENV_PREFIX/tmp" "$ENV_PREFIX/etc/nginx" "$ENV_PREFIX/etc/nginx/conf.d" 2>/dev/null || true
        chown -R "$current_user" "$ENV_PREFIX/var/run" "$ENV_PREFIX/var/log/nginx" "$ENV_PREFIX/var/lib/mysql" "$ENV_PREFIX/tmp" "$ENV_PREFIX/etc/nginx" "$ENV_PREFIX/etc/nginx/conf.d" 2>/dev/null || true
    fi

    repair_nginx_bootstrap
    if [ -f "scripts/setup-pma-sso.sh" ]; then
        bash scripts/setup-pma-sso.sh || warn "SSO do phpMyAdmin nao foi configurado. Rode scripts/health-check.sh para detalhes."
    fi

    # ─── Atualizando dependências Node...
    log "Atualizando dependências Node..."
    # npm install  # Desativado para evitar reinstalação automática de dependências
    if [ -d "node_modules" ]; then
        ok "Dependências Node já presentes."
    else
        warn "Diretório node_modules não encontrado. Instale manualmente se necessário."
    fi
    sleep 2
}

function uninstall_all() {
    show_banner
    warn "ATENÇÃO: Isso removerá todos os dados do painel!"
    read -p "Tem certeza? (s/n): " CONFIRM
    if [[ "$CONFIRM" == "s" ]]; then
        rm -rf config backups node_modules
        ok "Dados removidos. Para apagar a pasta: rm -rf $(pwd)"
    fi
    sleep 2
}

function remove_dependencies_menu() {
    show_banner
    detect_os
    warn "Removendo todas as dependências do sistema..."
    stop_mariadb
    if [ "$IS_TERMUX" = true ]; then
        # NÃO usar pkg autoremove
        pkg uninstall mariadb nodejs nginx php -y 2>/dev/null || apt remove mariadb nodejs nginx php -y 2>/dev/null || true
        apt purge  mariadb nodejs nginx php -y 2>/dev/null || true
    else
        ${SUDO}apt-get remove --purge mariadb-server nodejs nginx php-fpm -y 2>/dev/null || true
        ${SUDO}apt-get autoremove -y 2>/dev/null || true
    fi
    ok "Dependências removidas."
    sleep 2
}

function setup_boot_autostart() {
    show_banner
    detect_os
    if [ "$IS_TERMUX" = false ]; then
        warn "Em Linux Padrão, use systemd para auto-start. Suporte manual em breve."
        read
        return
    fi

    BASHRC="/data/data/com.termux/files/home/.bashrc"
    touch "$BASHRC"

    if grep -q "termux-panel/scripts/start.sh" "$BASHRC" 2>/dev/null; then
        ok "Auto-início já configurado!"
        read -p "Deseja REMOVER? (s/n): " REM_OPT
        if [[ "$REM_OPT" == "s" ]]; then
            node -e "
const fs = require('fs');
const p = '$BASHRC';
const lines = fs.readFileSync(p, 'utf8').split('\n');
const clean = lines.filter(l => !l.includes('termux-panel/scripts/start.sh')).join('\n');
fs.writeFileSync(p, clean);
" 2>/dev/null
            warn "Auto-início removido."
        fi
    else
        echo "bash ~/termux-panel/scripts/start.sh" >> "$BASHRC"
        ok "Auto-início configurado!"
    fi
    sleep 3
}

# ─── MENU PRINCIPAL ──────────────────────────────────────────────
while true; do
    show_banner
    echo -e "  ${GREEN}1)${RESET} 🚀 Instalar / Reconfigurar"
    echo -e "  ${GREEN}2)${RESET} 🔄 Atualizar Dependências Node"
    echo -e "  ${GREEN}3)${RESET} 🧹 Limpar Dados e Configurações"
    echo -e "  ${GREEN}4)${RESET} 🗑️  Remover Dependências do Sistema"
    echo -e "  ${GREEN}5)${RESET} ▶️  Iniciar Painel (modo básico)"
    echo -e "  ${GREEN}6)${RESET} 🔁 Iniciar com Auto-Restart + Serviços"
    echo -e "  ${GREEN}7)${RESET} ⚙️  Configurar Auto-Início no Termux"
    echo -e "  ${GREEN}8)${RESET} 🔧 Recovery do MariaDB"
    echo -e "  ${GREEN}9)${RESET} 🛠️  Reparar Pacotes APT/DPKG"
    echo -e "  ${RED}0)${RESET} ❌ Sair"
    echo ""
    read -p "Escolha uma opção: " opt

    case $opt in
        1) install_panel ;;
        2) update_panel ;;
        3) uninstall_all ;;
        4) remove_dependencies_menu ;;
        5)
            detect_os 2>/dev/null
            PORT=8088
            if [ -f "config/server.json" ]; then
                PORT=$(python3 -c "import json; print(json.load(open('config/server.json')).get('port', 8088))" 2>/dev/null || echo 8088)
            fi
            fuser -k "$PORT/tcp" 2>/dev/null
            PANEL_DIR="$(pwd)"
            for PID in $(pgrep -f 'node .*server\.js|node server\.js|node.*termux-panel/server\.js' 2>/dev/null); do
                CWD="$(readlink "/proc/$PID/cwd" 2>/dev/null || true)"
                CMDLINE="$(tr '\0' ' ' < "/proc/$PID/cmdline" 2>/dev/null || true)"
                if [ "$CWD" != "$PANEL_DIR" ] && ! printf '%s' "$CMDLINE" | grep -F "$PANEL_DIR/server.js" >/dev/null 2>&1; then
                    continue
                fi
                kill -9 "$PID" 2>/dev/null || true
            done
            for PID in $(pgrep -f 'termux-battery-status|termux-api BatteryStatus' 2>/dev/null); do
                kill -9 "$PID" 2>/dev/null || true
            done
            sleep 1
            NODE_MAX_OLD_SPACE_SIZE="${NODE_MAX_OLD_SPACE_SIZE:-256}"
            node --max-old-space-size="$NODE_MAX_OLD_SPACE_SIZE" server.js
            break
            ;;
        6) exec bash scripts/start.sh ;;
        7) setup_boot_autostart ;;
        8) mariadb_recovery ;;
        9)
            detect_os 2>/dev/null
            repair_packages
            read -p "Pressione Enter para continuar..."
            ;;
        0) break ;;
        *) warn "Opção inválida." ;;
    esac
done
