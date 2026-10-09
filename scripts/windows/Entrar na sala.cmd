@echo off
title BO1 Zombies - entrar na sala
echo Entrar numa sala de co-op do BO1 Zombies
echo.
set /p HOST=IP do host (o 100.x do Tailscale dele, ou o IP da rede de casa): 
set /p CODE=Codigo da sala (5 letras): 
set BO1Z_COOP=guest
set BO1Z_COOP_HOST=%HOST%
set BO1Z_COOP_CODE=%CODE%
set BO1Z_COOP_NAME=%USERNAME%
start "" "%~dp0BO1 Zombies.exe"
echo.
echo Abrindo o jogo. Escolha o MESMO mapa do host (Call of the Dead).
echo Log do co-op: %LOCALAPPDATA%\BO1 Zombies\logs\coop.log
timeout /t 8 >nul
