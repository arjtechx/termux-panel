#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — phpMyAdmin SSO Setup Script
# =============================================================

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
PMA_DIR="$PREFIX/share/phpmyadmin"

echo "Verificando phpMyAdmin..."
CUSTOM_PMA="/data/data/com.termux/files/home/server/sites/phpmyadmin"

if [ -d "$CUSTOM_PMA" ]; then
    PMA_DIR="$CUSTOM_PMA"
elif [ ! -d "$PMA_DIR" ]; then
    ALT_PMA=$(find "$PREFIX/share" -name "phpmyadmin" -type d 2>/dev/null | head -1)
    if [ -n "$ALT_PMA" ]; then
        PMA_DIR="$ALT_PMA"
    else
        echo "phpMyAdmin não encontrado!"
        exit 1
    fi
fi

echo "Pasta do phpMyAdmin: $PMA_DIR"

# Copia o autologin.php
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
if [ -f "$SCRIPT_DIR/autologin.php" ]; then
    cp "$SCRIPT_DIR/autologin.php" "$PMA_DIR/"
    echo "Copiado autologin.php para $PMA_DIR"
else
    echo "autologin.php não encontrado no repositório!"
    exit 1
fi

PMA_CONFIG="$PMA_DIR/config.inc.php"
if [ ! -f "$PMA_CONFIG" ]; then
    echo "config.inc.php não encontrado, execute o health-check primeiro."
    exit 1
fi

echo "Configurando auth_type = 'signon'..."

# Remove configurações antigas de signon caso existam para evitar duplicação
sed -i "/\['auth_type'\] = 'signon'/d" "$PMA_CONFIG"
sed -i "/\['SignonSession'\]/d" "$PMA_CONFIG"
sed -i "/\['SignonURL'\]/d" "$PMA_CONFIG"

# Altera o auth_type de cookie para signon (caso exista como cookie)
sed -i "s/\['auth_type'\] = 'cookie'/\['auth_type'\] = 'signon'/g" "$PMA_CONFIG"

# Injeta as variáveis do Signon logo após o host
if ! grep -q "'SignonSession'" "$PMA_CONFIG"; then
    sed -i "/\['host'\]/a \
\$cfg['Servers'][\$i]['auth_type'] = 'signon';\n\
\$cfg['Servers'][\$i]['SignonSession'] = 'PMA_single_signon';\n\
\$cfg['Servers'][\$i]['SignonURL'] = '/phpmyadmin/autologin.php';\n\
\$cfg['Servers'][\$i]['LogoutURL'] = 'http://127.0.0.1:8088/';\n\
" "$PMA_CONFIG"
fi

echo "SSO configurado com sucesso no phpMyAdmin!"
exit 0
