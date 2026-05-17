# Auto-Push para GitHub
# Uso: .\auto-push.ps1 -m "mensagem do commit"
# Ou só: .\auto-push.ps1  (usa mensagem automática com timestamp)

param(
    [string]$m = ""
)

$ErrorActionPreference = "Stop"

# Cor para output
function Green($t)  { Write-Host $t -ForegroundColor Green }
function Yellow($t) { Write-Host $t -ForegroundColor Yellow }
function Red($t)    { Write-Host $t -ForegroundColor Red }
function Blue($t)   { Write-Host $t -ForegroundColor Cyan }

Blue "============================================"
Blue "   TERMUX cPANEL — Auto Push para GitHub   "
Blue "============================================"
Write-Host ""

# Vai para a pasta do projeto
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

# Verifica se o remote está configurado
$remotes = git remote -v 2>&1
if (-not $remotes) {
    Red "Nenhum remote configurado!"
    Write-Host ""
    Yellow "Configure com:"
    Write-Host "  git remote add origin https://github.com/SEU_USUARIO/SEU_REPO.git"
    Write-Host ""
    Yellow "Depois rode: .\auto-push.ps1"
    exit 1
}

# Monta a mensagem do commit
if ($m -eq "") {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm"
    $CommitMsg = "chore: auto-update $timestamp"
} else {
    $CommitMsg = $m
}

# Adiciona todos os arquivos modificados
Blue "[*] Adicionando alterações..."
git add -A

# Verifica se há algo para commitar
$status = git status --porcelain
if (-not $status) {
    Yellow "[!] Nenhuma alteração detectada. Nada a enviar."
    exit 0
}

# Mostra o que será commitado
Yellow "Alterações a enviar:"
git status --short
Write-Host ""

# Commit
Blue "[*] Commitando: $CommitMsg"
git commit -m $CommitMsg

# Push
Blue "[*] Enviando para o GitHub..."
git push origin HEAD

Write-Host ""
Green "[+] Código enviado com sucesso!"
Green "[+] O GitHub Actions irá empacotar o .tar.gz automaticamente."
Green "[+] Em ~30 segundos, clique 'Atualizar Agora' no painel do Termux."
Write-Host ""
