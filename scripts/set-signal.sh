#!/bin/bash
# Grava no app a URL do servidor de convite (depois do deploy do signal/, ver signal/README.md), para os apps do Mac e
# do Windows já saírem sabendo para onde ir. Rode antes de ./build.sh e ./scripts/package-windows.sh.
#   ./scripts/set-signal.sh https://bo1z-signal.<sua-conta>.workers.dev
set -euo pipefail
cd "$(dirname "$0")/.."
URL=${1:?uso: ./scripts/set-signal.sh https://bo1z-signal.<conta>.workers.dev}
[[ $URL =~ ^https://[a-z0-9.-]+(:[0-9]+)?/?$ ]] || { echo "URL inválida (precisa ser https://host)"; exit 1; }
curl -fsS --max-time 10 "${URL%/}/health" >/dev/null || echo "aviso: ${URL%/}/health não respondeu (o deploy terminou?)"
printf '{\n  "signal": "%s"\n}\n' "${URL%/}" > app/coop/defaults.json
echo "ok: app/coop/defaults.json -> ${URL%/}"
