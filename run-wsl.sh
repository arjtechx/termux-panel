#!/bin/bash
# =============================================================
#  TERMUX cPANEL — WSL Local Runner
# =============================================================

GREEN="\033[0;32m"
YELLOW="\033[1;33m"
RED="\033[0;31m"
BLUE="\033[0;34m"
RESET="\033[0m"

echo -e "${BLUE}============================================${RESET}"
echo -e "${BLUE}   TERMUX cPANEL — Executando no WSL        ${RESET}"
echo -e "${BLUE}============================================${RESET}"
echo ""

# 1. Verifica se Node.js e NPM estão instalados no WSL
if ! command -v node &> /dev/null; then
    echo -e "${RED}[-] Node.js não está instalado no seu WSL!${RESET}"
    echo -e "${YELLOW}[*] Instale rodando os comandos abaixo no seu terminal WSL:${RESET}"
    echo -e "    sudo apt update"
    echo -e "    sudo apt install -y nodejs npm"
    exit 1
fi

if ! command -v npm &> /dev/null; then
    echo -e "${RED}[-] NPM não está instalado no seu WSL!${RESET}"
    echo -e "${YELLOW}[*] Instale rodando: sudo apt install -y npm${RESET}"
    exit 1
fi

# 2. Navega para o diretório do script
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$SCRIPT_DIR"

# 3. Limpa dependências nativas antigas se houver conflito de arquitetura Windows/Linux
# O npm install no Linux recompila os pacotes nativos (como ssh2) para Linux.
echo -e "${BLUE}[*] Instalando/atualizando dependências no WSL...${RESET}"
npm install --no-audit --no-fund

# 4. Cria arquivo config/system.json de teste se não existir
mkdir -p config
if [ ! -f "config/system.json" ]; then
    echo -e "${BLUE}[*] Configurando sistema para ambiente de desenvolvimento Linux...${RESET}"
    cat <<EOF > config/system.json
{
    "is_termux": false,
    "has_root": false,
    "package_manager": "apt",
    "prefix": "/usr"
}
EOF
fi

# 5. Inicializa o servidor Node
echo -e "${GREEN}[+] Inicializando servidor Termux cPanel no WSL...${RESET}"
echo -e "${GREEN}[+] Painel disponível localmente em: http://localhost:8088${RESET}"
echo ""
node server.js
