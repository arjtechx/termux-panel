#!/data/data/com.termux/files/usr/bin/bash

# --- Termux cPanel Management Script ---

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

function install_panel() {
    show_banner
    echo -e "\e[1;32m[*] Verificando dependências do sistema...\e[0m"
    
    DEPS=(nodejs mariadb nginx termux-api coreutils procps zip unzip psmisc)
    MISSING=()

    for dep in "${DEPS[@]}"; do
        if ! pkg list-installed $dep &>/dev/null; then
            MISSING+=($dep)
        fi
    done

    if [ ${#MISSING[@]} -gt 0 ]; then
        echo -e "[*] Instalando: ${MISSING[*]}"
        pkg update -y
        pkg install "${MISSING[@]}" -y
    else
        echo -e "\e[1;32m[+] Todas as dependências do sistema já estão instaladas.\e[0m"
    fi
    
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
    
    if [ ! -d "$PREFIX/var/lib/mysql" ]; then
        echo "[*] Inicializando base de dados MariaDB..."
        mysql_install_db
    fi

    echo "{\"host\":\"localhost\", \"user\":\"$DB_USER\", \"password\":\"$DB_PASS\"}" > config/db.json
    echo -e "\e[1;32m[+] Configuração do banco salva.\e[0m"
    
    npm install
    echo -e "\e[1;32m✅ Instalação concluída!\e[0m"
    sleep 2
}

function update_panel() {
    show_banner
    echo -e "\e[1;33m[*] Atualizando dependências...\e[0m"
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

function remove_dependencies() {
    show_banner
    echo -e "\e[1;31m[!] Removendo dependências do sistema (Node, MariaDB, NGINX)...\e[0m"
    pkg uninstall nodejs mariadb nginx -y
    pkg autoremove -y
    echo -e "\e[1;32m✅ Dependências removidas.\e[0m"
    sleep 2
}

while true; do
    show_banner
    echo -e "1) 🚀 Instalar / Reconfigurar"
    echo -e "2) 🔄 Atualizar Dependências"
    echo -e "3) 🧹 Limpar Dados e Configurações"
    echo -e "4) 🗑️  Remover Dependências do Sistema"
    echo -e "5) ▶️  Iniciar Painel"
    echo -e "0) ❌ Sair"
    echo -en "\nEscolha uma opção: "
    read opt

    case $opt in
        1) install_panel ;;
        2) update_panel ;;
        3) uninstall_all ;;
        4) remove_dependencies ;;
        5) fuser -k 8088/tcp 2>/dev/null; pkill -9 -f "node server.js" 2>/dev/null; sleep 1; node server.js; break ;;
        0) break ;;
        *) echo "Opção inválida" ;;
    esac
done
