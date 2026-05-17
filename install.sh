#!/usr/bin/env bash

# --- cPanel Management Script ---
# Multi-OS: Termux (Android) & Linux Padrão (Debian/Ubuntu)

BANNER="
   ______                               __
  / ____/___  ____  ____  ___  ____    / /
 / /   / __ \/ __ \/ __ \/ _ \/ / / /  / / 
/ /___/ /_/ / / / / / / /  __/ /_/ /  / /  
\____/ .___/_/ /_/_/ /_/\___/\__,_/  /_/   
    /_/                                    
      Management & Setup Assistant
"

function show_banner() {
    clear
    echo -e "\e[1;34m$BANNER\e[0m"
}

# Variáveis globais para SO
IS_TERMUX=false
HAS_ROOT=false
PKG_MGR="apt-get"
SUDO=""
ENV_PREFIX=""

function detect_os() {
    if [ -n "$PREFIX" ] && [[ "$PREFIX" == *"com.termux"* ]]; then
        IS_TERMUX=true
        PKG_MGR="pkg"
        ENV_PREFIX="$PREFIX"
        echo -e "\e[1;34m[*] Sistema detectado: Termux (Android)\e[0m"
    elif uname -o 2>/dev/null | grep -qi "Android"; then
        IS_TERMUX=true
        PKG_MGR="pkg"
        ENV_PREFIX="/data/data/com.termux/files/usr"
        echo -e "\e[1;34m[*] Sistema detectado: Termux (Android)\e[0m"
    else
        echo -e "\e[1;34m[*] Sistema detectado: Linux Padrão\e[0m"
        if [ "$EUID" -ne 0 ]; then
            if command -v sudo >/dev/null 2>&1; then
                SUDO="sudo "
                HAS_ROOT=true
            else
                echo -e "\e[1;33m[!] Aviso: Você não é root e o 'sudo' não foi encontrado.\e[0m"
            fi
        else
            HAS_ROOT=true
        fi
    fi
    
    # Se for Termux, pergunta se o usuário quer usar Root (su)
    if [ "$IS_TERMUX" = true ]; then
        echo -e "\e[1;33m[?] O seu aparelho Android possui acesso ROOT (Magisk, KernelSU, etc)?\e[0m"
        read -p "Deseja ativar o modo Superusuário no painel para recursos avançados? (s/N): " USE_ROOT
        if [[ "${USE_ROOT,,}" == "s" ]]; then
            echo -e "[*] Testando acesso root..."
            if su -c 'echo "Root OK"' >/dev/null 2>&1; then
                HAS_ROOT=true
                echo -e "\e[1;32m[+] Acesso Root concedido e ativado!\e[0m"
            else
                echo -e "\e[1;31m[-] Falha ao obter Root via 'su'. Continuando no modo usuário normal.\e[0m"
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

function get_deps() {
    if [ "$IS_TERMUX" = true ]; then
        echo "nodejs mariadb nginx termux-api coreutils procps zip unzip psmisc lsof python php"
    else
        echo "nodejs mariadb-server nginx coreutils procps zip unzip psmisc lsof python3 php-fpm"
    fi
}

function check_missing_deps() {
    local deps=($(get_deps))
    local missing=()
    for dep in "${deps[@]}"; do
        if [ "$IS_TERMUX" = true ]; then
            if ! pkg list-installed $dep &>/dev/null; then missing+=($dep); fi
        else
            if ! dpkg -l | grep -qw "^ii  $dep"; then missing+=($dep); fi
        fi
    done
    echo "${missing[@]}"
}

function install_deps() {
    local to_install=("$@")
    if [ ${#to_install[@]} -gt 0 ]; then
        echo -e "[*] Instalando: ${to_install[*]}"
        $SUDO $PKG_MGR update -y
        $SUDO $PKG_MGR install -y "${to_install[@]}"
    fi
}

function remove_deps() {
    local deps=($(get_deps))
    echo -e "\e[1;31m[*] Removendo dependências...\e[0m"
    if [ "$IS_TERMUX" = true ]; then
        pkg uninstall "${deps[@]}" -y
        pkg autoremove -y
    else
        $SUDO apt-get remove --purge "${deps[@]}" -y
        $SUDO apt-get autoremove -y
    fi
}

function install_panel() {
    show_banner
    detect_os
    
    echo -e "\e[1;32m[*] Verificando dependências do sistema...\e[0m"
    local missing=($(check_missing_deps))

    local mysql_dir="$ENV_PREFIX/var/lib/mysql"
    if [ "$IS_TERMUX" = false ]; then
        mysql_dir="/var/lib/mysql"
    fi

    # Verifica se já existe algo instalado (se faltam poucas ou nenhuma config/banco)
    if [ ${#missing[@]} -eq 0 ] || [ -f "config/auth.json" ] || [ -d "$mysql_dir" ]; then
        echo -e "\n\e[1;33m[!] Foi detectada uma instalação existente no sistema.\e[0m"
        read -p "Deseja remover todas as dependências e dados (banco, configurações) para uma instalação LIMPA? (s/N): " CLEAN_INSTALL
        if [[ "${CLEAN_INSTALL,,}" == "s" ]]; then
            echo -e "\e[1;31m[*] Removendo dependências, banco de dados e configurações...\e[0m"
            remove_deps
            rm -rf config backups node_modules
            $SUDO rm -rf "$mysql_dir"
            echo -e "\e[1;32m[*] Sistema limpo. Instalando dependências do zero...\e[0m"
            local all_deps=($(get_deps))
            install_deps "${all_deps[@]}"
        else
            echo -e "\e[1;32m[*] Continuando com a instalação existente...\e[0m"
            install_deps "${missing[@]}"
        fi
    else
        install_deps "${missing[@]}"
        echo -e "\e[1;32m[+] Todas as dependências do sistema instaladas.\e[0m"
    fi
    
    save_system_config

    echo -e "\n\e[1;34m[Configuração de Acesso]\e[0m"
    read -p "Usuário admin (padrão admin): " ADMIN_USER
    ADMIN_USER=${ADMIN_USER:-admin}
    read -s -p "Senha admin (padrão admin): " ADMIN_PASS
    echo ""
    ADMIN_PASS=${ADMIN_PASS:-admin}

    mkdir -p config
    echo "{\"user\":\"$ADMIN_USER\", \"pass\":\"$ADMIN_PASS\"}" > config/auth.json
    echo -e "\e[1;32m[+] Acesso ao painel configurado.\e[0m"

    echo -e "\n\e[1;34m[Configuração do Banco de Dados MariaDB]\e[0m"
    read -p "Usuário Root do MariaDB (padrão root): " DB_USER
    DB_USER=${DB_USER:-root}
    read -s -p "Senha Root do MariaDB (deixe vazio se não houver): " DB_PASS
    echo ""
    
    if [ "$IS_TERMUX" = true ] && [ ! -d "$mysql_dir" ]; then
        echo "[*] Inicializando base de dados MariaDB..."
        mysql_install_db
    fi

    echo "{\"host\":\"localhost\", \"user\":\"$DB_USER\", \"password\":\"$DB_PASS\"}" > config/db.json
    echo -e "\e[1;32m[+] Configuração do banco salva.\e[0m"
    
    echo -e "\n\e[1;34m[*] Instalando bibliotecas do Node.js...\e[0m"
    npm install
    echo -e "\e[1;32m✅ Instalação concluída!\e[0m"
    sleep 2
}

function update_panel() {
    show_banner
    echo -e "\e[1;33m[*] Atualizando dependências Node...\e[0m"
    npm install
    echo -e "\e[1;32m✅ Atualização concluída!\e[0m"
    sleep 2
}

function uninstall_all() {
    show_banner
    echo -e "\e[1;31m[!] ATENÇÃO: Isso removerá todos os dados do painel!\e[0m"
    read -p "Tem certeza? (s/n): " CONFIRM
    if [[ "$CONFIRM" == "s" ]]; then
        rm -rf config backups node_modules
        echo -e "\e[1;32m✅ Dados removidos. Para apagar a pasta do projeto, use: rm -rf $(pwd)\e[0m"
    fi
    sleep 2
}

function remove_dependencies_menu() {
    show_banner
    detect_os
    echo -e "\e[1;31m[!] ATENÇÃO: Removendo todas as dependências do sistema...\e[0m"
    remove_deps
    echo -e "\e[1;32m✅ Dependências removidas.\e[0m"
    sleep 2
}

function setup_boot_autostart() {
    show_banner
    detect_os
    if [ "$IS_TERMUX" = false ]; then
        echo -e "\e[1;33m[!] Em distros Linux Padrão, recomenda-se criar um serviço do systemd ao invés do .bashrc.\e[0m"
        echo -e "O suporte automático para systemd será adicionado no futuro. Pressione Enter para continuar..."
        read
        return
    fi

    BASHRC="/data/data/com.termux/files/home/.bashrc"
    touch "$BASHRC"
    
    if grep -q "termux-panel/scripts/start.sh" "$BASHRC" 2>/dev/null; then
        echo -e "\e[1;32m[+] A auto-inicialização já está configurada no seu Termux!\e[0m"
        echo ""
        read -p "Deseja REMOVER a auto-inicialização? (s/n): " REM_OPT
        if [[ "$REM_OPT" == "s" ]]; then
            node -e "
const fs = require('fs');
const path = '$BASHRC';
const lines = fs.readFileSync(path, 'utf8').split('\n');
const clean = lines.filter(l => !l.includes('termux-panel/scripts/start.sh')).join('\n');
fs.writeFileSync(path, clean);
" 2>/dev/null
            echo -e "\e[1;31m[-] Auto-inicialização removida.\e[0m"
        fi
    else
        echo "bash ~/termux-panel/scripts/start.sh" >> "$BASHRC"
        echo -e "\e[1;32m✅ Auto-inicialização configurada com sucesso!\e[0m"
    fi
    sleep 3
}

while true; do
    show_banner
    echo -e "1) 🚀 Instalar / Reconfigurar"
    echo -e "2) 🔄 Atualizar Dependências Node"
    echo -e "3) 🧹 Limpar Dados e Configurações"
    echo -e "4) 🗑️  Remover Dependências do Sistema"
    echo -e "5) ▶️  Iniciar Painel (modo básico)"
    echo -e "6) 🔁 Iniciar com Auto-Restart + PHP + NGINX + MariaDB"
    echo -e "7) ⚙️  Configurar Auto-Início ao abrir o Termux"
    echo -e "0) ❌ Sair"
    echo -en "\nEscolha uma opção: "
    read opt

    case $opt in
        1) install_panel ;;
        2) update_panel ;;
        3) uninstall_all ;;
        4) remove_dependencies_menu ;;
        5) fuser -k 8088/tcp 2>/dev/null; pkill -9 -f "node server.js" 2>/dev/null; sleep 1; node server.js; break ;;
        6) bash scripts/start.sh; break ;;
        7) setup_boot_autostart ;;
        0) break ;;
        *) echo "Opção inválida" ;;
    esac
done
