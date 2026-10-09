@echo off
title BO1 Zombies - criar sala
echo Criar uma sala de co-op do BO1 Zombies (porta UDP 27960)
echo.
set /p CODE=Escolha um codigo de 5 letras (ex. ZUMBI): 
set BO1Z_COOP=host
set BO1Z_COOP_CODE=%CODE%
start "" "%~dp0BO1 Zombies.exe"
echo.
echo Se o Windows perguntar sobre o firewall, clique em Permitir.
echo Passe para o outro jogador: o seu IP do Tailscale (100.x) e o codigo %CODE%.
echo Log do co-op: %LOCALAPPDATA%\BO1 Zombies\logs\coop.log
pause
