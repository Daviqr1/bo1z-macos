# Gravações de sessão (Call of the Dead, Mac, 2026-10-09)

`live-20261009.jsonl.gz`: uma linha JSON por evento, gravada por `tools/recorder.mjs` (DevTools 127.0.0.1:9334,
só leitura). Campo `t` = epoch ms do Mac; campo `k` = tipo:

| k | conteúdo |
| --- | --- |
| `f` | `i`: intervalos de present do motor (ms) no último ~1 s; `lost`: frames perdidos no anel |
| `g` | `gpu`: utilização da GPU (%) via ioreg |
| `m` | memória do motor a cada 10 s (`wasmBreak`, `textureStagingBytes`, `audioCachedPCMBytes`, …) |
| `w` | linha do console do site: `WEB_GPU_PIPESTAT_X` (busyMsPerFrame, pipes, perFrame.draws/passes/staging…), `KISAK_BROWSER view` (1/s: `origin=x,y,z`, `angles=pitch,yaw,roll`, `move`, `weaponstate`, `cmd`), `engine-initialized`, `map-loaded` |
| `s` | troca de tela da página (`loading`, `ready`, `playing`) e mapa |
| `i` | **input do jogador** (grampo I1 no glue): `ev` = sequência plana `[t_ms_página, tipo, a, b, ...]` com os argumentos exatos de `_KB_Input(tipo, a, b)`: 0 = tecla (a=keycode do motor, b=1 desce/0 sobe), 1 = char, 2 = mouse relativo (a=dx, b=dy), 3 = pointer lock, 4 = cursor de menu (x,y), 5+ = internos do site |
| `tune` / `err` | aplicação do tuner e erros do próprio gravador |

O grampo começou a gravar `i` a partir do reinício das ~11h da manhã (os registros `i` cobrem a última partida, ~11 min,
~45 mil eventos). `t_ms_página` é `performance.now()` da página (relógio diferente de `t`).
Replay: reinjetar com `globalThis.__bo1zKBInput(tipo, a, b)` no mesmo ritmo (`__bo1zReplaying = true` para não regravar).
Não é determinístico (IA dos zumbis sorteia), mas reproduz trajeto e ritmo de input para A/B de desempenho.
