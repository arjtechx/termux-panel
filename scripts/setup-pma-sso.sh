#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — phpMyAdmin SSO Setup Script
# =============================================================

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Lista de caminhos potenciais do phpMyAdmin
PMA_PATHS=(
    "/data/data/com.termux/files/home/server/sites/phpmyadmin"
    "$PREFIX/share/phpmyadmin"
)

# Tenta encontrar outros dinamicamente
ALT_PMA=$(find "$PREFIX/share" -name "phpmyadmin" -type d 2>/dev/null | head -1)
if [ -n "$ALT_PMA" ] && [ "$ALT_PMA" != "$PREFIX/share/phpmyadmin" ]; then
    PMA_PATHS+=("$ALT_PMA")
fi

CONFIGURED_ANY=false

for PMA_DIR in "${PMA_PATHS[@]}"; do
    if [ -d "$PMA_DIR" ]; then
        echo "Configurando phpMyAdmin em: $PMA_DIR"
        
        # Copia o autologin.php
        if [ -f "$SCRIPT_DIR/autologin.php" ]; then
            cp "$SCRIPT_DIR/autologin.php" "$PMA_DIR/"
            echo "  [+] Copiado autologin.php"
        else
            echo "  [-] autologin.php não encontrado em $SCRIPT_DIR"
            continue
        fi

        PMA_CONFIG="$PMA_DIR/config.inc.php"
        if [ -f "$PMA_CONFIG" ]; then
            echo "  [*] Configurando auth_type = 'signon'..."
            
            # Remove configurações antigas para evitar duplicação
            sed -i "/\['auth_type'\] = 'signon'/d" "$PMA_CONFIG"
            sed -i "/\['SignonSession'\]/d" "$PMA_CONFIG"
            sed -i "/\['SignonURL'\]/d" "$PMA_CONFIG"
            sed -i "/\['LogoutURL'\]/d" "$PMA_CONFIG"
            
            # Altera de cookie para signon se necessário
            sed -i "s/\['auth_type'\] = 'cookie'/\['auth_type'\] = 'signon'/g" "$PMA_CONFIG"
            
            # Injeta as configurações do SSO
            if ! grep -q "'SignonSession'" "$PMA_CONFIG"; then
                sed -i "/\['host'\]/a \
\$cfg['Servers'][\$i]['auth_type'] = 'signon';\n\
\$cfg['Servers'][\$i]['SignonSession'] = 'PMA_single_signon';\n\
\$cfg['Servers'][\$i]['SignonURL'] = '/phpmyadmin/autologin.php';\n\
\$cfg['Servers'][\$i]['LogoutURL'] = 'http://127.0.0.1:8088/';\n\
" "$PMA_CONFIG"
            fi
            echo "  [+] SSO configurado com sucesso!"
            CONFIGURED_ANY=true
        else
            echo "  [-] config.inc.php não encontrado neste diretório."
        fi
    fi
done

if [ "$CONFIGURED_ANY" = true ]; then
    echo "SSO configurado com sucesso em todas as instâncias ativas do phpMyAdmin!"
    exit 0
else
    echo "Nenhum diretório do phpMyAdmin foi configurado com sucesso!"
    exit 1
fi
