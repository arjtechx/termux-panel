@echo off
title Termux cPanel - WSL Runner
echo ==================================================
echo   Iniciando Termux cPanel no seu WSL...
echo ==================================================
echo.

:: Verifica se o WSL está instalado
where wsl >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo [ERRO] WSL nao encontrado no seu Windows!
    echo Certifique-se de que o Windows Subsystem for Linux esta ativado.
    echo.
    pause
    exit /b
)

:: Executa o script bash no WSL
wsl bash ./run-wsl.sh

pause
