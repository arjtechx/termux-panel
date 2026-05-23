#!/data/data/com.termux/files/usr/bin/bash
# Update helper: choose version by GitHub tag and invoke update.sh with chosen tag

set -e

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PANEL_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"
CONFIG_FILE="$PANEL_DIR/config/update.json"
UPDATE_SCRIPT="$SCRIPT_DIR/update.sh"

log()  { echo "[*] $1"; }
warn() { echo "[!] $1"; }
err()  { echo "[-] $1"; }

if [ ! -f "$UPDATE_SCRIPT" ]; then
    err "Script de update nao encontrado: $UPDATE_SCRIPT"
    exit 1
fi

GITHUB_REPO=""
if [ -f "$CONFIG_FILE" ]; then
    GITHUB_REPO=$(python3 -c "import json; d=json.load(open('$CONFIG_FILE')); print(d.get('github_repo',''))" 2>/dev/null || echo "")
fi
if [ -z "$GITHUB_REPO" ] || [ "$GITHUB_REPO" = "null" ]; then
    GITHUB_REPO="arjtechx/termux-panel"
fi

fetch_tags() {
    local repo="$1"
    local tags=""
    tags="$(curl -fsSL -H "User-Agent: termux-panel" "https://api.github.com/repos/$repo/tags?per_page=100" 2>/dev/null | \
        sed -n 's/.*"name":[[:space:]]*"\([^"]\+\)".*/\1/p' | \
        grep -E '^[vV]?[0-9]+' || true)"

    if [ -z "$tags" ]; then
        tags="$(git ls-remote --tags "https://github.com/$repo.git" 2>/dev/null | \
            sed -n 's|.*refs/tags/\([^ ^{]*\)\(\^{}\)\{0,1\}$|\1|p' | \
            grep -E '^[vV]?[0-9]+' || true)"
    fi

    printf '%s\n' "$tags" | awk 'NF' | awk '!seen[$0]++' | sort -Vr
}

if [ "$1" = "--latest" ]; then
    exec bash "$UPDATE_SCRIPT" latest
fi

if [ "$1" = "--list-tags" ]; then
    fetch_tags "$GITHUB_REPO"
    exit 0
fi

if [ -n "$1" ] && [ "$1" != "--choose" ]; then
    exec bash "$UPDATE_SCRIPT" "$1"
fi

log "Repositorio: $GITHUB_REPO"
mapfile -t TAGS < <(fetch_tags "$GITHUB_REPO")

if [ "${#TAGS[@]}" -eq 0 ]; then
    warn "Nao foi possivel listar tags. Usando latest."
    exec bash "$UPDATE_SCRIPT" latest
fi

echo ""
echo "Escolha a versao para atualizar:"
echo "  [0] latest"
for i in "${!TAGS[@]}"; do
    idx=$((i + 1))
    if [ "$idx" -gt 20 ]; then
        break
    fi
    echo "  [$idx] ${TAGS[$i]}"
done
echo "  [m] tag manual"
echo ""

read -r -p "Opcao [0]: " opt
opt="${opt:-0}"

if [ "$opt" = "0" ]; then
    exec bash "$UPDATE_SCRIPT" latest
fi

if [ "$opt" = "m" ] || [ "$opt" = "M" ]; then
    read -r -p "Digite a tag (ex: v0.2.86): " manual_tag
    if [ -z "$manual_tag" ]; then
        warn "Tag vazia. Usando latest."
        exec bash "$UPDATE_SCRIPT" latest
    fi
    exec bash "$UPDATE_SCRIPT" "$manual_tag"
fi

if ! printf '%s' "$opt" | grep -Eq '^[0-9]+$'; then
    warn "Opcao invalida. Usando latest."
    exec bash "$UPDATE_SCRIPT" latest
fi

selected_index=$((opt - 1))
if [ "$selected_index" -lt 0 ] || [ "$selected_index" -ge "${#TAGS[@]}" ]; then
    warn "Opcao fora da lista. Usando latest."
    exec bash "$UPDATE_SCRIPT" latest
fi

selected_tag="${TAGS[$selected_index]}"
log "Atualizando para tag: $selected_tag"
exec bash "$UPDATE_SCRIPT" "$selected_tag"
