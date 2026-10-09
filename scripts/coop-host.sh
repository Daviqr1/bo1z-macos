#!/bin/zsh
# Abre o app no Mac como HOST de uma sala de co-op (UDP 27960) e mostra o convite para mandar ao convidado.
#   ./scripts/coop-host.sh [CODIGO]
# O convidado (Windows) usa "Entrar na sala.cmd" com o IP e o código. Na primeira vez o macOS pode perguntar se o
# BO1 Zombies aceita conexões de entrada: clique em Permitir.
set -e
BIN="$HOME/Applications/BO1 Zombies.app/Contents/MacOS/Electron"
[[ -x "$BIN" ]] || { echo "Rode ./build.sh antes."; exit 1; }
if pgrep -f "BO1 Zombies.app/Contents/MacOS/Electron" >/dev/null; then echo "Feche o BO1 Zombies antes (Cmd+Q)."; exit 1; fi
CODE=${1:-$(LC_ALL=C tr -dc 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' </dev/urandom | head -c 5)}
BO1Z_COOP=host BO1Z_COOP_CODE=$CODE nohup "$BIN" >/dev/null 2>&1 &
TS=$( (tailscale ip -4 || /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4) 2>/dev/null | head -1 )
LAN=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
echo "Sala aberta. Código: $CODE"
[[ -n $TS ]] && echo "Convite (redes diferentes, Tailscale): IP $TS  código $CODE"
[[ -n $LAN ]] && echo "Convite (mesma casa):                 IP $LAN  código $CODE"
echo "Log do co-op: /Volumes/HighballGames/bo1z/logs/coop.log  (menu Co-op > Abrir log do co-op)"
