#!/bin/zsh
# Monta ~/Applications/BO1 Zombies.app a partir do Electron em node_modules + app/ + icon/AppIcon.icns.
set -e
cd ${0:A:h}
OUT="$HOME/Applications/BO1 Zombies.app"
PB=/usr/libexec/PlistBuddy
mkdir -p "$HOME/Applications"
[[ -d "$OUT" ]] && mv "$OUT" "/private/tmp/BO1 Zombies.app.old.$$"
cp -R node_modules/electron/dist/Electron.app "$OUT"
R="$OUT/Contents/Resources"
mv "$R/default_app.asar" "/private/tmp/default_app.asar.$$" 2>/dev/null || true
cp -R app "$R/app"
cp icon/AppIcon.icns "$R/electron.icns"
P="$OUT/Contents/Info.plist"
$PB -c "Set :CFBundleName BO1 Zombies" -c "Set :CFBundleDisplayName BO1 Zombies" \
    -c "Set :CFBundleIdentifier com.davi.bo1zombies" "$P"
$PB -c "Add :LSApplicationCategoryType string public.app-category.games" "$P" 2>/dev/null || true
codesign --force --deep -s - "$OUT" 2>&1 | grep -v "replacing existing signature" || true
touch "$OUT"
echo "ok: $OUT"
