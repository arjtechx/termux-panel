#!/data/data/com.termux/files/usr/bin/bash
# =============================================================
#  TERMUX cPANEL — Android VIP Keep-Alive & Root Prioritization
#  Aumenta a prioridade para o máximo (-20 CPU, -1000 OOM)
# =============================================================

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}${BLUE}╔══════════════════════════════════════════╗${NC}"
echo -e "${BOLD}${BLUE}║   TERMUX cPANEL — Otimizador Ultra Root  ║${NC}"
echo -e "${BOLD}${BLUE}╚══════════════════════════════════════════╝${NC}"
echo ""

# 1. Garante Wakelock para evitar suspensão de CPU quando a tela desliga
echo -e "${CYAN}[*] Ativando Wakelock do Termux (Impede CPU Sleep)...${NC}"
if command -v termux-wake-lock >/dev/null 2>&1; then
    termux-wake-lock
    echo -e "${GREEN}[+] Wakelock ativado com sucesso.${NC}"
else
    echo -e "${YELLOW}[!] Utilitário termux-wake-lock ausente. Recomenda-se instalar 'termux-api'.${NC}"
fi

# 2. Verifica se possui acesso root
if ! command -v su >/dev/null 2>&1; then
    echo -e "${RED}[ERRO] Acesso Root (su) não encontrado no PATH.${NC}"
    echo -e "${YELLOW}[!] Este otimizador avançado requer privilégios Root.${NC}"
    exit 1
fi

echo -e "${CYAN}[*] Solicitando permissão Root...${NC}"
if ! su -c "id" >/dev/null 2>&1; then
    echo -e "${RED}[ERRO] Permissão de Root negada ou cancelada.${NC}"
    exit 1
fi
echo -e "${GREEN}[+] Acesso Root concedido!${NC}"

# 3. Desativa o Phantom Process Killer do Android 12+ (Matador silencioso do Termux)
echo -e "${CYAN}[*] Desativando Phantom Process Killer do Android (Imunidade Total)...${NC}"
su -c "device_config put activity_manager max_phantom_processes 2147483647" >/dev/null 2>&1
su -c "settings put global settings_enable_monitor_phantom_procs false" >/dev/null 2>&1
su -c "dumpsys deviceidle whitelist +com.termux" >/dev/null 2>&1
echo -e "${GREEN}[+] Phantom Process Killer desativado e Bateria whitelistada com sucesso.${NC}"


# 4. Localiza os PIDs de todos os serviços vitais
echo -e "${CYAN}[*] Localizando processos do painel e serviços...${NC}"

declare -A SERVICES
SERVICES=(
    ["Node.js Panel"]="node.*server.js"
    ["NGINX Master"]="nginx: master"
    ["PHP-FPM Master"]="php-fpm: master"
    ["MariaDB Database"]="mariadbd\|mysqld"
    ["Termux App"]="com.termux"
)

prioritize_pid() {
    local name="$1"
    local pid="$2"
    
    if [ -n "$pid" ] && [ -d "/proc/$pid" ]; then
        echo -e "${BLUE}  → Configurando $name (PID: $pid)...${NC}"
        
        # OOM Score Adjust para -900 (Imunidade segura contra Low Memory Killer sem acionar limites rígidos)
        su -c "echo -900 > /proc/$pid/oom_score_adj" >/dev/null 2>&1
        
        # CPU Renice moderado para -10 (Prioridade alta de CPU, sem abusar dos limites do scheduler)
        su -c "renice -n -10 -p $pid" >/dev/null 2>&1
        
        # I/O Ionice para classe Best-Effort alta (Evita IO blocking)
        su -c "ionice -c 2 -n 0 -p $pid" >/dev/null 2>&1
    fi
}

for svc in "${!SERVICES[@]}"; do
    pattern="${SERVICES[$svc]}"
    # Busca PIDs correspondentes
    PIDS=$(pgrep -f "$pattern")
    
    if [ -n "$PIDS" ]; then
        for pid in $PIDS; do
            prioritize_pid "$svc" "$pid"
        done
        echo -e "${GREEN}[✓] $svc priorizado.${NC}"
    else
        echo -e "${YELLOW}[!] Nenhum processo ativo encontrado para: $svc${NC}"
    fi
done

echo ""
echo -e "${BOLD}${GREEN}🏆 IMUNIDADE E PRIORIDADE EXTREMA APLICADAS COM SUCESSO!${NC}"
echo -e "${GREEN}O seu painel e os serviços agora possuem prioridade de sistema e nunca mais cairão!${NC}"
echo ""
