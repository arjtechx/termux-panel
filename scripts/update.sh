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

# 3. Executa a configuração SSO do phpMyAdmin para garantir que as portas e arquivos estejam sincronizados
echo -e "\033[0;34m[*] Aplicando correções automáticas do phpMyAdmin SSO...\033[0m"
if [ -f "scripts/setup-pma-sso.sh" ]; then
    bash scripts/setup-pma-sso.sh
fi

echo -e "\033[0;32m[+] Painel atualizado com sucesso!\033[0m"

# 4. Força o reinício do servidor Node.js
# Se rodando via PM2, o PM2 reinicia sozinho. Se rodando via node puro, matamos e reiniciamos.
echo -e "\033[1;33m[*] Reiniciando servidor do painel...\033[0m"
sleep 2

# Encontra a porta 8088 e mata o processo Node.js para que o PM2 / loop de inicialização o reinicie
PID=$(lsof -t -i:8088 2>/dev/null)
if [ -n "$PID" ]; then
    kill -9 "$PID"
else
    pkill -f "server.js" || exit 0
fi

exit 0
