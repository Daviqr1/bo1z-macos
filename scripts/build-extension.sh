#!/bin/bash
# Monta a extensão do navegador (Chrome/Edge, MV3) em browser/dist/ e o zip dist/BO1-Zombies-extensao.zip.
#   ./scripts/build-extension.sh [pasta de saída]
# Junta browser/src/ com os módulos do co-op que rodam na página (app/coop), a rede da janela net (app/net) e o lobby
# (app/lobby), mais os ícones do app. Nada do vel.gg/Activision entra (o wasm, o glue e o engine.js são os do site,
# ganchados em tempo de execução); o script confere isso no fim.
# Rede/lobby ausentes: a extensão monta assim mesmo (sem rede, criar/entrar avisa; sem lobby, a sala fica no popup).
# Para testar peças que ainda não entraram no branch: BO1Z_EXT_NET_DIR=<pasta com session.mjs …>, BO1Z_EXT_LOBBY_DIR=<…>.
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-browser/dist}
NET=${BO1Z_EXT_NET_DIR:-app/net}
LOBBY=${BO1Z_EXT_LOBBY_DIR:-app/lobby}
ZIP=${BO1Z_EXT_ZIP:-dist/BO1-Zombies-extensao.zip}

rm -rf "$OUT"
mkdir -p "$OUT/coop" "$OUT/icons"
cp -R browser/src/. "$OUT/"
# ponte, rings e análise/patch do wasm (o resto de app/coop é do processo principal do app)
for f in page netbridge ring layout bytes bridge-worker wasmscan wasmpatch; do cp "app/coop/$f.mjs" "$OUT/coop/"; done
if [[ -f "$NET/session.mjs" ]]; then
  mkdir -p "$OUT/net" && cp "$NET"/*.mjs "$OUT/net/"
else
  echo "aviso: $NET/session.mjs não existe: extensão sem rede (criar/entrar vão avisar)"
fi
if [[ -f "$LOBBY/lobby.mjs" ]]; then
  mkdir -p "$OUT/lobby"
  find "$LOBBY" -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.css' -o -name '*.svg' -o -name '*.png' -o -name '*.webp' \
    -o -name '*.woff2' -o -name '*.json' \) -exec cp {} "$OUT/lobby/" \;
else
  echo "aviso: $LOBBY/lobby.mjs não existe: sem lobby na página (a sala fica no popup da extensão)"
fi
# servidor de convite embutido (o mesmo do app, scripts/set-signal.sh)
SIGNAL=$(node -p "try { require('./app/coop/defaults.json').signal || '' } catch { '' }")
node -e "process.stdout.write('// Gerado por scripts/build-extension.sh a partir de app/coop/defaults.json.\nexport const DEFAULT_SIGNAL = ' + JSON.stringify(process.argv[1]) + ';\n')" "$SIGNAL" > "$OUT/lib/defaults.mjs"
cp icon/AppIcon.iconset/icon_16x16.png "$OUT/icons/16.png"
cp icon/AppIcon.iconset/icon_32x32.png "$OUT/icons/32.png"
cp icon/AppIcon.iconset/icon_128x128.png "$OUT/icons/128.png"

# conferências: sintaxe de todos os scripts, manifest válido, nada de terceiros
for f in $(find "$OUT" -name '*.mjs' -o -name '*.js'); do node --check "$f" >/dev/null || { echo "erro de sintaxe: $f"; exit 1; }; done
node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$OUT/manifest.json"
if find "$OUT" \( -iname '*.wasm' -o -iname 'KisakBlack*' -o -name 'engine.js' -o -name 'play.js' -o -name '*.pack' -o -name '*.ff' \) | grep -q .; then
  echo "erro: arquivo do vel.gg no pacote"; exit 1
fi

mkdir -p "$(dirname "$ZIP")"
rm -f "$ZIP"
( cd "$OUT" && zip -qr -X -9 - . ) > "$ZIP"
echo "ok: $OUT ($(find "$OUT" -type f | wc -l | tr -d ' ') arquivos) e $ZIP ($(du -h "$ZIP" | cut -f1))"
