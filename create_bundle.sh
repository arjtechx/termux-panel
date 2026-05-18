#!/data/data/com.termux/files/usr/bin/bash

# --- Script para Gerar o Pacote de Distribuição (Com Pasta) ---
BUNDLE_NAME="termux-panel-dist.tar.gz"

echo -e "\e[1;34m[*] Gerando pacote de distribuição (com pasta pai)...\e[0m"

# Subir um nível para incluir o nome da pasta no tar
cd ..
tar -czvf termux-panel/$BUNDLE_NAME \
    --exclude='termux-panel/node_modules' \
    --exclude='termux-panel/config' \
    --exclude='termux-panel/backups' \
    --exclude='termux-panel/.git' \
    --exclude='termux-panel/*.tar.gz' \
    --exclude='termux-panel/logs' \
    termux-panel/

echo -e "\n\e[1;32m✅ Pacote gerado com sucesso: $BUNDLE_NAME\e[0m"
