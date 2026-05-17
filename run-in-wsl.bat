@echo off
chcp 65001 >nul 2>&1
title Termux cPanel — WSL Installer

echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║   ☁️  TERMUX cPANEL — Instalador WSL         ║
echo  ║   v0.0.0.2-experimental                      ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: ── Verifica WSL ────────────────────────────────────────────
where wsl >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERRO] WSL nao encontrado!
    echo.
    echo  Para instalar o WSL, abra o PowerShell como Admin e rode:
    echo    wsl --install
    echo.
    echo  Reinicie o PC e execute este instalador novamente.
    echo.
    pause
    exit /b 1
)

:: ── Verifica se há alguma distro WSL instalada ───────────────
wsl --list --quiet >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERRO] Nenhuma distro Linux instalada no WSL!
    echo.
    echo  Instale o Ubuntu via Microsoft Store ou rode:
    echo    wsl --install -d Ubuntu
    echo.
    pause
    exit /b 1
)

echo  [OK] WSL detectado. Iniciando instalacao no Linux...
echo.

:: ── Converte o caminho Windows para path WSL ────────────────
:: Ex: C:\Users\gabri\...\termux-panel → /mnt/c/Users/gabri/.../termux-panel
set "WIN_PATH=%~dp0"
set "WIN_PATH=%WIN_PATH:\=/%"
set "WIN_PATH=%WIN_PATH::=%"
set "WSL_PATH=/mnt/%WIN_PATH:~0,1%%WIN_PATH:~1%"
:: Remove barra final
if "%WSL_PATH:~-1%"=="/" set "WSL_PATH=%WSL_PATH:~0,-1%"

:: Converte letra de drive para minúsculo via WSL
for /f "delims=" %%i in ('wsl wslpath -a "%~dp0."') do set "WSL_PATH=%%i"

echo  Caminho WSL: %WSL_PATH%
echo.

:: ── Executa o script de instalação no WSL ───────────────────
wsl bash -c "cd '%WSL_PATH%' && chmod +x run-wsl.sh && bash run-wsl.sh"

echo.
echo  ══════════════════════════════════════════════════
echo  Servidor encerrado. Pressione qualquer tecla para fechar.
pause >nul
