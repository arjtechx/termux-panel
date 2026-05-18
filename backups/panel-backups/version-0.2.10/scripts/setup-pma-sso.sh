#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — phpMyAdmin SSO Setup Script
#  v2.0.0 - Robust Permissions and Perfect Signon Injection
# =============================================================

PREFIX="${PREFIX:-/data/data/com.termux/files/usr}"
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
CURRENT_USER=$(whoami)

echo "=== Iniciando Setup do phpMyAdmin SSO ==="

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
        
        # Garante a propriedade do diretório para o usuário atual
        chown -R "$CURRENT_USER" "$PMA_DIR" 2>/dev/null
        
        # Copia o autologin.php
        if [ -f "$SCRIPT_DIR/autologin.php" ]; then
            cp "$SCRIPT_DIR/autologin.php" "$PMA_DIR/"
            chmod 644 "$PMA_DIR/autologin.php"
            chown "$CURRENT_USER" "$PMA_DIR/autologin.php" 2>/dev/null
            echo "  [+] Copiado autologin.php com permissões corretas"
        else
            echo "  [-] autologin.php não encontrado em $SCRIPT_DIR"
            continue
        fi

        PMA_CONFIG="$PMA_DIR/config.inc.php"
        if [ -f "$PMA_CONFIG" ]; then
            echo "  [*] Configurando auth_type = 'signon'..."
            chmod 644 "$PMA_CONFIG"
            chown "$CURRENT_USER" "$PMA_CONFIG" 2>/dev/null
            
            # Remove configurações antigas de SSO para evitar duplicação ou conflitos
            sed -i "/\['auth_type'\] = 'signon'/d" "$PMA_CONFIG"
            sed -i "/\['SignonSession'\]/d" "$PMA_CONFIG"
            sed -i "/\['SignonURL'\]/d" "$PMA_CONFIG"
            sed -i "/\['LogoutURL'\]/d" "$PMA_CONFIG"
            
            # Altera de cookie para signon na linha padrão se existir
            sed -i "s/\['auth_type'\] = 'cookie'/\['auth_type'\] = 'signon'/g" "$PMA_CONFIG"
            
            # Injeta as configurações atualizadas do SSO logo abaixo da definição de 'host'
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
    echo "SSO configurado com sucesso em todas as instâncias do phpMyAdmin!"
    exit 0
else
    echo "Nenhum diretório do phpMyAdmin foi configurado!"
    exit 1
fi
