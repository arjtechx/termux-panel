# ============================================================
#  TERMUX cPANEL — Assistente de Versão, Release e Push
# ============================================================
# Este script gerencia de forma interativa a publicação de novas
# versões do painel no GitHub, garantindo consistência e build limpa.
#
# Uso: PowerShell (abra na pasta do projeto e execute: .\auto-push.ps1)

$ErrorActionPreference = "Stop"

# Utilitários de Cores
function Green($t)  { Write-Host $t -ForegroundColor Green }
function Yellow($t) { Write-Host $t -ForegroundColor Yellow }
function Red($t)    { Write-Host $t -ForegroundColor Red }
function Blue($t)   { Write-Host $t -ForegroundColor Cyan }
function Magenta($t){ Write-Host $t -ForegroundColor Magenta }

Clear-Host
Magenta "=========================================================="
Magenta "        TERMUX cPANEL — ASSISTENTE DE RELEASE & PUSH      "
Magenta "=========================================================="
Write-Host ""

# 1. Validação de Pasta e Git
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ScriptDir

if (!(Test-Path ".git")) {
    Red "[ERRO] Este diretório não é um repositório Git ativo!"
    exit 1
}

$remotes = git remote -v 2>&1
if (!$remotes) {
    Red "[ERRO] Nenhum repositório GitHub remoto configurado."
    Yellow "Configure com: git remote add origin <URL_DO_REPO>"
    exit 1
}

# 2. Ler Versão Atual do package.json
if (!(Test-Path "package.json")) {
    Red "[ERRO] package.json não encontrado no diretório atual!"
    exit 1
}

$pjson = Get-Content -Path "package.json" -Raw | ConvertFrom-Json
$currentVersion = $pjson.version
Blue "[*] Versão ativa atual detetada: v$currentVersion"
Write-Host ""

# 3. Menu Interativo de Versão
Yellow "Como deseja definir a nova versão?"
Write-Host "  1) Patch Release (Correções simples, ex: v$currentVersion -> v$($currentVersion -replace '(\d+)$', { [int]$args[0].Value + 1 }))"
Write-Host "  2) Minor Release (Novos recursos compatíveis, ex: v$currentVersion -> v$($currentVersion -replace '(\d+)\.\d+$', { "$([int]$args[0].Groups[1].Value + 1).0" }))"
Write-Host "  3) Major Release (Grandes mudanças disruptivas)"
Write-Host "  4) Customizar Manualmente (Digitar versão personalizada)"
Write-Host "  5) Manter a versão atual (v$currentVersion)"
Write-Host ""
$option = Read-Host "Escolha uma opção [1-5]"

$newVersion = $currentVersion
if ($option -eq "1") {
    $newVersion = $currentVersion -replace '(\d+)$', { [int]$args[0].Value + 1 }
} elseif ($option -eq "2") {
    $newVersion = $currentVersion -replace '(\d+)\.\d+$', { "$([int]$args[0].Groups[1].Value + 1).0" }
} elseif ($option -eq "3") {
    $parts = $currentVersion.Split('.')
    $major = [int]$parts[0] + 1
    $newVersion = "$major.0.0"
} elseif ($option -eq "4") {
    Write-Host ""
    $newVersion = Read-Host "Digite a nova versão (ex: 0.3.1)"
    $newVersion = $newVersion.Trim().Replace("v", "")
}

if ($newVersion -match '^\d+\.\d+\.\d+$') {
    Green "[+] Nova versão definida para: v$newVersion"
} else {
    Red "[ERRO] Formato de versão inválido! Use o padrão X.Y.Z"
    exit 1
}
Write-Host ""

# 4. Notas de Lançamento (Release Notes)
Yellow "Digite as Notas de Lançamento (Release Notes) para esta versão:"
Yellow "(Ex: Novo botão de descompactar adicionado, correção de autologin, etc.)"
$releaseNotes = Read-Host "Notas"
if ([string]::IsNullOrWhiteSpace($releaseNotes)) {
    $releaseNotes = "Atualização automática e correções do sistema em $(Get-Date -Format 'dd/MM/yyyy HH:mm')."
}
Write-Host ""

# 5. Modificar os arquivos locais automaticamente
Blue "[*] Atualizando arquivos de configuração..."

# Atualizar package.json
$pjson.version = $newVersion
# Formatar o JSON com recuo bonito e escrever mantendo codificação UTF-8 simples
$pjsonJson = ConvertTo-Json $pjson -Depth 100
$pjsonJson | Set-Content -Path "package.json" -Encoding utf8
Green "  [OK] package.json atualizado para v$newVersion"

# Atualizar public/index.html (cache busting do script)
if (Test-Path "public/index.html") {
    $html = Get-Content -Path "public/index.html" -Raw
    $html = $html -replace 'filemanager\.js\?v=[\d\.\-]+', "filemanager.js?v=$newVersion"
    $html | Set-Content -Path "public/index.html" -Encoding utf8
    Green "  [OK] public/index.html atualizado com cache-buster v$newVersion"
}

Write-Host ""

# 6. Contingência: Gerar Pacote Offline Local
Yellow "Deseja gerar o pacote compactado local (.tar.gz) no seu PC de forma preventiva? (S/N)"
$generateLocal = Read-Host "Opção"
if ($generateLocal.ToUpper() -eq "S") {
    Blue "[*] Gerando termux-panel-dist.tar.gz localmente..."
    $distTar = "termux-panel-dist.tar.gz"
    if (Test-Path $distTar) { Remove-Item $distTar -Force }
    
    # Criar pasta temporária para empacotar limpo
    $tempBuild = Join-Path $env:TEMP "termux-panel-build"
    if (Test-Path $tempBuild) { Remove-Item $tempBuild -Recurse -Force }
    New-Item -ItemType Directory -Path (Join-Path $tempBuild "termux-panel") | Out-Null
    
    # Copiar arquivos necessários
    $items = @("public", "scripts", "services", "src", "install.sh", "package.json", "package-lock.json", "README.md", "server.js")
    foreach ($item in $items) {
        if (Test-Path $item) {
            Copy-Item -Path $item -Destination (Join-Path $tempBuild "termux-panel") -Recurse -Force
        }
    }
    
    # Executar tar do Windows nativo
    tar.exe -czvf $distTar -C $tempBuild termux-panel
    Remove-Item $tempBuild -Recurse -Force
    Green "[+] Pacote local gerado com sucesso: $distTar (Pronto para contingência!)"
    Write-Host ""
}

# 7. Git Add, Commit, Tag e Push
Blue "[*] Iniciando publicação no GitHub..."

# Verificar se há alterações
$status = git status --porcelain
if ($status) {
    git add -A
    git commit -m "release: v$newVersion - $releaseNotes"
    Green "  [OK] Alterações commitadas localmente."
} else {
    Yellow "  [!] Nenhuma alteração pendente de código além das versões."
    git add package.json public/index.html
    git commit -m "release: bump version to v$newVersion"
}

# Puxar antes de enviar para evitar conflitos (Pull preventivo)
try {
    Blue "[*] Sincronizando repositório remoto (git pull)..."
    git pull origin master --rebase
} catch {
    Yellow "[AVISO] Não foi possível fazer o rebase automático. Prosseguindo..."
}

# Enviar branch principal
Blue "[*] Enviando branch master para o GitHub..."
git push origin master

# Criar e Enviar TAG
Blue "[*] Criando Tag Git oficial da versão v$newVersion..."
# Deleta tag local antiga se existir para evitar conflitos
if (git tag -l "v$newVersion") {
    git tag -d "v$newVersion" | Out-Null
}
git tag -a "v$newVersion" -m "$releaseNotes"

Blue "[*] Enviando Tag v$newVersion para o GitHub..."
# Deleta tag remota antiga se existir para evitar conflito na nuvem
git push origin :refs/tags/v$newVersion 2>$null
git push origin "v$newVersion"

Write-Host ""
Green "=========================================================="
Green "      🎉 SUCESSO! ATUALIZAÇÃO ENVIADA COM SUCESSO!        "
Green "=========================================================="
Green " Versão Publicada: v$newVersion"
Green " Notas do Lançamento: $releaseNotes"
Write-Host ""
Blue "[INFO] O GitHub Actions está compilando o pacote agora."
Blue "[INFO] Em 1-2 minutos, acesse a aba 'Diagnóstico / Fix' no painel"
Blue "[INFO] do seu Termux e instale a nova versão v$newVersion de forma"
Blue "[INFO] totalmente automática e 100% assistida!"
Write-Host ""
Read-Host "Pressione Enter para fechar o assistente..."
