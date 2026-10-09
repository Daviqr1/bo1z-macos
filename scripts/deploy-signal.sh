#!/bin/bash
# Publica o servidor de convite (signal/: Cloudflare Worker + Durable Object, plano grátis) e grava a URL no app, para
# os apps do Mac e do Windows já saírem sabendo para onde ir. Uma vez só; rode de novo se mudar algo em signal/.
#   ./scripts/deploy-signal.sh
# Na primeira vez o wrangler abre o navegador para entrar (ou criar) a conta Cloudflare e pode perguntar o subdomínio
# *.workers.dev. Depois: ./build.sh (Mac) e ./scripts/package-windows.sh (zip do Windows), e é só mandar o link.
# TURN (opcional, para redes que não deixam ligar direto): veja signal/README.md.
set -euo pipefail
cd "$(dirname "$0")/.."
command -v node >/dev/null || { echo "precisa do Node 20 ou mais novo (https://nodejs.org)"; exit 1; }

cd signal
npm install --no-audit --no-fund --loglevel=error
if npx wrangler whoami 2>&1 | grep -qiE 'not (logged in|authenticated)'; then npx wrangler login; fi
log=$(mktemp)
trap 'rm -f "$log"' EXIT
npx wrangler deploy 2>&1 | tee "$log"
URL=$(grep -oE 'https://[a-z0-9.-]+\.workers\.dev' "$log" | head -1 || true)
cd ..
[ -n "$URL" ] || { echo "não achei a URL *.workers.dev na saída do deploy; rode ./scripts/set-signal.sh <url> à mão"; exit 1; }

for i in 1 2 3 4 5; do curl -fsS --max-time 10 "$URL/health" >/dev/null 2>&1 && break; sleep 3; done
./scripts/set-signal.sh "$URL"
echo
echo "pronto: convites em $URL/j/<código>"
echo "próximo passo: ./build.sh (Mac) e ./scripts/package-windows.sh (Windows)"
