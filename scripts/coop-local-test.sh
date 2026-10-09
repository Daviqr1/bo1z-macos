#!/bin/zsh
# F2: teste de co-op com duas instâncias no MESMO Mac (host + convidado), sala UDP em 127.0.0.1, sem WebRTC.
#   ./scripts/coop-local-test.sh [connect|manual] [--replay]
# connect: o convidado sobe direto com "+connect localhost" (sem +devmap).
# manual:  o convidado sobe solo no mesmo mapa; quando ele estiver jogando, o script manda "connect localhost".
# --replay: depois que o convidado entrar, move o convidado sozinho com a sua gravação (60 s), para você olhar no host.
# Grava tudo em /Volumes/HighballGames/bo1z/logs/coop-test-<data>/ (resumo.md responde às perguntas abertas da spec).
# Antes: ./build.sh (app atualizado) e o app fechado. O convidado usa um clone APFS do seu perfil (packs já baixados).
set -e
cd ${0:A:h}/..
STRATEGY=${1:-connect}
REPLAY=0; [[ " $* " == *" --replay "* ]] && REPLAY=1
APP="$HOME/Applications/BO1 Zombies.app"
BIN="$APP/Contents/MacOS/Electron"
IMAGE=/Volumes/SSD/Games/HighballGames.sparseimage
DATA=/Volumes/HighballGames/bo1z
[[ -x "$BIN" ]] || { echo "Não achei $BIN. Rode ./build.sh antes."; exit 1; }
[[ "$STRATEGY" == connect || "$STRATEGY" == manual ]] || { echo "estratégia: connect ou manual"; exit 1; }
if pgrep -f "BO1 Zombies.app/Contents/MacOS/Electron" >/dev/null; then echo "Feche o BO1 Zombies antes (Cmd+Q)."; exit 1; fi
[[ -d /Volumes/HighballGames ]] || hdiutil attach "$IMAGE" -noverify -quiet
OUT="$DATA/logs/coop-test-$(date +%Y%m%d-%H%M%S)-$STRATEGY"
mkdir -p "$OUT"

# Perfil do convidado: clone APFS (instantâneo, sem gastar espaço) do perfil normal, sem as travas do Chromium.
if [[ ! -d "$DATA/profile-guest" ]]; then
  echo "Clonando o perfil para o convidado (APFS)…"
  cp -cR "$DATA/profile" "$DATA/profile-guest"
  rm -f "$DATA/profile-guest"/Singleton*
fi

CODE=TESTE
echo "Subindo HOST (DevTools 9334) e CONVIDADO (DevTools 9335, sem som)…"
BO1Z_COOP=host BO1Z_COOP_BIND=127.0.0.1 BO1Z_COOP_CODE=$CODE \
  "$BIN" >"$OUT/host.out" 2>&1 &
HOST_PID=$!
sleep 4
BO1Z_PROFILE=guest BO1Z_DEBUG_PORT=9335 BO1Z_MUTE=1 BO1Z_COOP=guest BO1Z_COOP_HOST=127.0.0.1:27960 \
  BO1Z_COOP_CODE=$CODE BO1Z_COOP_START=$STRATEGY BO1Z_COOP_NAME=convidado \
  "$BIN" >"$OUT/guest.out" 2>&1 &
GUEST_PID=$!

node tools/coop-probe.mjs --out "$OUT" --quiet host:9334 convidado:9335 &
PROBE_PID=$!
node tools/recorder.mjs "$OUT/host-rec.jsonl" 2 9334 >/dev/null 2>&1 &
REC1=$!
node tools/recorder.mjs "$OUT/guest-rec.jsonl" 2 9335 >/dev/null 2>&1 &
REC2=$!

finish() {
  echo "\nEncerrando…"
  kill -TERM $PROBE_PID 2>/dev/null; sleep 2  # SIGINT é ignorado por jobs em segundo plano de script
  kill $REC1 $REC2 $HOST_PID $GUEST_PID 2>/dev/null || true
  cp "$DATA/logs/coop.log" "$OUT/coop-host.log" 2>/dev/null || true
  cp "$DATA/logs/coop-guest.log" "$OUT/coop-guest.log" 2>/dev/null || true
  echo "Pronto. Resultado: $OUT/resumo.md"
  echo "Mande essa pasta inteira (ou só resumo.md + coop-*.log) para a sessão na nuvem."
  exit 0
}
trap finish INT

cat <<MSG

1) Janela HOST (a primeira): escolha Call of the Dead e entre no jogo. Ainda NÃO clique para começar se houver
   tela de "clique para jogar": deixe o convidado conectar primeiro (pergunta 4 da spec).
2) Janela CONVIDADO (a segunda): escolha Call of the Dead também.
MSG
if [[ $STRATEGY == manual ]]; then
  echo "3) Quando o CONVIDADO estiver jogando sozinho no mapa, volte aqui e aperte Enter (manda 'connect localhost')."
  read -r
  node tools/console.mjs 9335 "connect localhost"
fi
if [[ $REPLAY == 1 ]]; then
  echo "Quando o convidado aparecer no jogo do host, aperte Enter para movê-lo com a gravação (60 s)."
  read -r
  node tools/replay.mjs 9335 --from 120 --duration 60
fi
echo "\nStatus ao vivo em $OUT/status.txt. Jogue um pouco; Ctrl+C aqui encerra e gera o resumo."
while true; do sleep 5; [[ -f "$OUT/status.txt" ]] && printf '\r%s' "$(tr '\n' ' ' < "$OUT/status.txt" | cut -c1-180)"; done
