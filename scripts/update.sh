#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Auto-Updater Script
# =============================================================

echo -e "\033[0;34m[*] Iniciando processo de atualização do Painel...\033[0m"

# Navega para a pasta do painel (garante que estamos no diretório correto)
PANEL_DIR="/data/data/com.termux/files/home/termux-panel"
if [ -d "$PANEL_DIR" ]; then
    cd "$PANEL_DIR"
fi

# 1. Verifica se está em um repositório git
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo -e "\033[0;32m[+] Repositório Git detectado. Rodando git pull...\033[0m"
    git fetch --all
    git reset --hard origin/master || git reset --hard origin/main
    git pull
else
    echo -e "\033[1;33m[*] Instalação manual detectada. Buscando tarball de atualização...\033[0m"

    # Se houver um arquivo termux-panel-dist.tar.gz na pasta home, extraímos ele
    TAR_PATH="/data/data/com.termux/files/home/termux-panel-dist.tar.gz"
    if [ -f "$TAR_PATH" ]; then
        echo -e "\033[0;32m[+] Arquivo termux-panel-dist.tar.gz encontrado. Extraindo...\033[0m"
        tar -xzvf "$TAR_PATH" -C "/data/data/com.termux/files/home/" --strip-components=1
    else
        echo -e "\033[0;31m[-] Nenhuma fonte de atualização encontrada (Git ou termux-panel-dist.tar.gz no Home).\033[0m"
        exit 1
    fi
fi

# 2. Instala novas dependências
echo -e "\033[0;34m[*] Atualizando dependências do Node.js...\033[0m"
npm install --no-audit --no-fund

# 3. Executa a configuração SSO do phpMyAdmin
echo -e "\033[0;34m[*] Aplicando correções automáticas do phpMyAdmin SSO...\033[0m"
if [ -f "scripts/setup-pma-sso.sh" ]; then
    bash scripts/setup-pma-sso.sh
fi

echo -e "\033[0;32m[+] Painel atualizado com sucesso!\033[0m"

# 4. Inicia PHP-FPM se não estiver rodando
echo -e "\033[0;34m[*] Verificando PHP-FPM...\033[0m"
if ! pgrep -x php-fpm > /dev/null 2>&1; then
    echo -e "\033[1;33m[*] PHP-FPM não está rodando. Iniciando...\033[0m"
    PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
    mkdir -p "$PREFIX/var/run"
    php-fpm --daemonize 2>/dev/null || php-fpm -D 2>/dev/null || php-fpm &
    sleep 1
    if pgrep -x php-fpm > /dev/null 2>&1; then
        echo -e "\033[0;32m[+] PHP-FPM iniciado.\033[0m"
    else
        echo -e "\033[1;33m[!] PHP-FPM não pôde iniciar automaticamente.\033[0m"
    fi
else
    echo -e "\033[0;32m[+] PHP-FPM já está rodando.\033[0m"
fi

# 5. Reinicia o NGINX para carregar a nova configuração SSO
echo -e "\033[0;34m[*] Recarregando NGINX...\033[0m"
if pgrep -x nginx > /dev/null 2>&1; then
    nginx -s reload 2>/dev/null && echo -e "\033[0;32m[+] NGINX recarregado.\033[0m"
else
    nginx 2>/dev/null && echo -e "\033[0;32m[+] NGINX iniciado.\033[0m"
fi

# 6. Reinicia o painel — mata o processo atual e o loop start.sh reinicia automaticamente
echo -e "\033[1;33m[*] Encerrando processo do painel para auto-restart...\033[0m"
sleep 2

OLDPID=$(lsof -t -i:8088 2>/dev/null)
if [ -n "$OLDPID" ]; then
    kill -9 "$OLDPID" 2>/dev/null
    echo -e "\033[0;32m[+] Processo encerrado. O auto-restart iniciará o painel automaticamente.\033[0m"
else
    # Fallback caso não encontre via lsof
    pkill -f "server.js" 2>/dev/null
    echo -e "\033[0;32m[+] Sinal de restart enviado.\033[0m"
fi

# Pequena espera para que o start.sh pegue o restart
sleep 1

# Caso o start.sh não esteja rodando (sessão iniciada sem ele), inicia o painel diretamente em background
if ! lsof -t -i:8088 > /dev/null 2>&1; then
    echo -e "\033[0;34m[*] Nenhum auto-restart detectado. Iniciando painel diretamente...\033[0m"
    sleep 2
    if ! lsof -t -i:8088 > /dev/null 2>&1; then
        nohup node server.js > /tmp/panel.log 2>&1 &
        echo -e "\033[0;32m[+] Painel reiniciado em background (PID: $!).\033[0m"
    fi
fi

exit 0
