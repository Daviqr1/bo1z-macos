#!/bin/bash
# F5: monta dist/BO1-Zombies-win64.zip, o app portátil para o Windows (roda no Mac ou no Linux).
#   ./scripts/package-windows.sh
# Usa o Electron oficial da mesma versão do package.json (sha256 conferido contra node_modules/electron/checksums.json),
# troca o default_app pelo nosso app/ e renomeia electron.exe. NÃO entra no zip: o glue patcheado e o mod da caixa
# (derivados de código de terceiros). No Windows os patches de desempenho ficam desligados (config "patches": false) e o
# patch de co-op (N1) é aplicado em tempo de execução sobre o glue original baixado do vel.gg.
set -euo pipefail
cd "$(dirname "$0")/.."
[[ -f node_modules/electron/package.json ]] || npm ci
VER=$(node -p "require('./node_modules/electron/package.json').version")
ZIP="electron-v$VER-win32-x64.zip"
SHA=$(node -p "require('./node_modules/electron/checksums.json')['$ZIP']")
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/bo1z"
mkdir -p "$CACHE" dist
[[ -f "$CACHE/$ZIP" ]] || curl -fL --retry 3 -o "$CACHE/$ZIP" "https://github.com/electron/electron/releases/download/v$VER/$ZIP"
echo "$SHA  $CACHE/$ZIP" | shasum -a 256 -c - >/dev/null || { echo "sha256 do $ZIP não confere"; rm -f "$CACHE/$ZIP"; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/BO1 Zombies"
unzip -q "$CACHE/$ZIP" -d "$OUT"
rm -f "$OUT/resources/default_app.asar"
mkdir -p "$OUT/resources/app"
cp -R app/. "$OUT/resources/app/"
rm -rf "$OUT/resources/app/patches/packs"
rm -f "$OUT/resources/app/patches/"*.mjs
mv "$OUT/electron.exe" "$OUT/BO1 Zombies.exe"
cp scripts/windows/*.cmd "$OUT/"
cp docs/WINDOWS-LEIA-ME.txt "$OUT/LEIA-ME.txt"
rm -f dist/BO1-Zombies-win64.zip
( cd "$WORK" && zip -qr -9 - "BO1 Zombies" ) > dist/BO1-Zombies-win64.zip
echo "ok: dist/BO1-Zombies-win64.zip ($(du -h dist/BO1-Zombies-win64.zip | cut -f1))"
