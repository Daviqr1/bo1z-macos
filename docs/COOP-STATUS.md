# Co-op P2P — estado em 2026-10-09 (sessão na nuvem)

Complementa [`COOP-P2P-SPEC.md`](COOP-P2P-SPEC.md). Nada aqui foi testado com o jogo rodando (a nuvem não tem os
packs nem GPU Apple); tudo o que depende do motor de verdade está marcado e tem script pronto para o Mac.

## 1. Resumo

- **F0 e F1 prontos e testados** (simulador fiel dos rings + ponte JS), com 29 testes `node --test` (2 rodam contra o wasm e o `engine.js` reais com `BO1Z_WASM`/`BO1Z_ENGINE_JS`), concorrência real em
  `worker_threads` e a cadência de frames da sua gravação (`recordings/live-20261009.jsonl.gz`).
- **Transporte trocado por um mais simples:** UDP direto entre os apps (processo principal do Electron), com código de
  sala. Funciona em `127.0.0.1` (teste F2), na rede de casa e pelo **Tailscale** (IP 100.x fixo entre redes diferentes,
  atravessa CGNAT). Sem Worker, sem signaling, sem TURN. O plano de WebRTC (F3) vira opcional.
- **Fiação no app pronta e testada no Electron real** (`tools/coop-smoke.mjs`: duas instâncias, host e convidado, com
  "motores" falsos na página; o handshake passa por preload → MessagePort → UDP → página → ring k → volta).
- **App Windows (F5)**: `main.js` com ramo de plataforma e `scripts/package-windows.sh` gera o zip portátil.
- **Verificação estática do wasm** respondeu às perguntas 1 e 4 do lado do servidor (favoráveis) e achou um **risco
  sério do lado do convidado** (seção 3.2) que só o teste F2 no Mac decide.

## 2. O que tem no repositório

| caminho | o quê |
| --- | --- |
| `app/coop/layout.mjs` | layout dos rings (§1.2 da spec) + checagem de coerência |
| `app/coop/wasmscan.mjs` | acha base/stride/offsets dos rings **por padrão de bytes** no wasm (âncora: `NET_GetLoopPacket`); no wasm atual acha exatamente o layout da spec e 7 produtores. Se o vel.gg mudar o motor e o padrão não fechar, o co-op desliga sozinho |
| `app/coop/ring.mjs` | acesso da ponte aos rings: `publish` (escreve o slot e publica com CAS) e leitor passivo com cursor próprio (não mexe no `get` do motor) |
| `app/coop/netbridge.mjs` | **F1**: `openHostRing()`, `injectToServer(bytes,k)`, `drainRing(k)`, `injectToClient(bytes)`, `drainClientOut()`, `pump()`, contadores de corrida |
| `app/coop/gluepatch.mjs` | patch **N1** do glue: expõe `globalThis.__bo1zKB = { memory, malloc, free, module }` logo depois de `initRuntime()` (antes do `main` do motor). Vale no glue formatado (build) e no minificado (em tempo de execução) |
| `app/coop/page.mjs` | co-op no mundo da página: reserva 8 rings no N1, liga ponte ↔ MessagePort, loga o handshake (OOB) e estatísticas (`BO1Z_COOP …` → `logs/coop.log`) |
| `app/coop/udp.js` | sala UDP (`CoopHost`/`CoopGuest`): HELLO com versão + código, WELCOME, DATA (pacote cru do motor), PING/PONG (RTT), BYE, timeout de 10 s, sala cheia |
| `app/coop/main-coop.js` | no `main.js`: serve `https://vel.gg/__bo1z/coop/*.mjs`, analisa o wasm, garante o N1 no glue, troca `+devmap` por `+connect localhost` no `engine.js` do convidado, liga UDP ↔ página |
| `sim/engine.mjs` | **F0**: emulação fiel do lado do motor (mesma sequência de loads/stores da desmontagem) |
| `sim/race*.mjs`, `sim/single-worker.mjs`, `sim/bench-race.mjs` | corrida de 2 produtores e caminhos de produtor único com threads de verdade |
| `sim/traffic.mjs` | lê a gravação: cadência de frames (108 fps, p50 8,4 ms, p95 15,4 ms) e os 44,8 mil inputs |
| `tools/coop-smoke.mjs` | smoke test no Electron real (Mac: `node tools/coop-smoke.mjs`; Linux: `xvfb-run -a …`) |
| `tools/coop-probe.mjs` | observa host e convidado pelo DevTools e escreve `resumo.md` com um veredito por pergunta aberta |
| `tools/console.mjs` | digita comandos no console do motor (`connect localhost`, `status`, `addtestclient`, `setqport N`) |
| `tools/replay.mjs` | reinjeta a sua gravação numa instância (move o jogador sozinho) |
| `scripts/coop-local-test.sh` | **F2 no Mac**: duas instâncias, sala em 127.0.0.1, probe + gravadores, resumo no fim |
| `scripts/coop-host.sh` | abre o app como host e mostra o convite (IP Tailscale / rede de casa + código) |
| `scripts/package-windows.sh` | **F5**: `dist/BO1-Zombies-win64.zip` (Electron oficial com sha256 conferido + `app/` sem nada derivado do vel.gg) |
| `scripts/windows/*.cmd`, `docs/WINDOWS-LEIA-ME.txt` | "Entrar na sala" / "Criar sala" e instruções para o seu irmão |

Comandos (nuvem ou Mac): `npm test` (29 testes, ~10 s), `npm run bench:race` (corrida na cadência gravada),
`npm run smoke` (Electron real; no Linux, com `xvfb-run -a`).

## 3. Verificação estática do wasm (sha256 `61192df3…cc98`, desmontagem com nomes)

### 3.1 Lado do servidor (host): favorável ao Plano A

- **Pergunta 1 (tag k → resposta no ring k): sim, estaticamente.** `NET_GetLoopPacket` põe o tag em `from.port`.
  `SV_DirectConnect` → `Netchan_Setup` grava esse `from` como `remoteAddress` do cliente, e `Netchan_Transmit` do
  servidor envia para o ring `remoteAddress.port & 0xffff`.
- **Correção da spec §1.2:** `NET_CompareBaseAdr` **compara a porta** quando o endereço é loopback (tipos 0/2). Só
  `NET_CompareAdr` ignora a porta. Consequências:
  - um convidado com tag `k ≠ 0` é um endereço-base diferente do cliente local do host (porta 0) e ganha slot próprio;
  - colisão de qport entre host e convidado não importa (a porta já separa);
  - o "fixing up a translated port" praticamente nunca dispara para loopback, porque o tag já entra no `Netchan_Setup`.
- **Handshake:**
  - o cliente manda `getchallenge` e depois `connect` com userinfo (`protocol=1044`, challenge, qport).
  - Para tipo 2 o servidor **pula** a checagem de challenge e a de senha/cliente privado. Não há ticket Steam no
    `connect`: o `steamauth` é um OOB separado, opcional.
  - Responde `connectResponse` e loga `Going from CS_FREE to CS_CONNECTED`.
- **Pergunta 4 (contagem):** `getnumexpectedplayers` conta os slots com `state > 1`, ou seja, conectado ou além. Só dá
  `Scr_Error` com `onlinegame` ou `systemlink` ligados. Um convidado que conecte antes da checagem do script entra na
  conta. O momento exato ainda precisa de teste.
- **Pacotes:**
  - cliente → servidor: `seq u32 | qport u16 | payload`; servidor → cliente: `seq u32 | payload`.
  - Fragmenta a partir de 1164 B, então nenhum pacote sequenciado passa de 1264 B.
  - OOB não tem limite explícito, mas na prática são strings curtas.
- **Pacote sequenciado de remetente desconhecido** recebe um OOB `disconnect` de volta. O cliente só obedece se
  estiver há mais de 3 s sem receber nada, então ruído de corrida não derruba ninguém.
- **Motor e página:** o motor roda numa pthread (`PROXY_TO_PTHREAD`), e a página é outra thread. A ponte roda na thread
  da página.

### 3.2 Lado do convidado: **risco real** (pergunta 3)

**Servidor local do frontend.** Sem `+devmap`, o `Com_Init` sobe sozinho um servidor local com o mapa `frontend`
(`Com_LoadFrontEnd` → `map frontend`).
- `connect localhost` com servidor local rodando o derruba por um caminho adiado (`SV_Frame` → `Com_Shutdown`) e
  conecta pelo ring 1, que a ponte lê.
- Não deu para confirmar estaticamente a ordem entre o `+connect` da linha de comando e o `map frontend`.

**O cliente/cgame deste motor (SP) lê o servidor direto da memória.** Exemplos:
- `CG_SetupWeaponDef` → `SV_GetConfigstring`
- `CG_InitFakeEntities` → `G_ParseSpawnVars`/`G_SpawnString` (string de entidades do BSP)
- `CG_FireWeapon` → RNG do jogo (`G_flrand`)
- `CG_ProcessEntity` → `G_SP_MeasureEffectiveWeight` (peso de animação)
- `CL_ParseGamestate` → `SV_GetLicenseType`/`SV_IsServerRanked`

No host isso funciona, porque o servidor está no mesmo processo. **Num convidado sem um servidor do mesmo mapa
rodando, essas leituras pegam dados vazios ou de outro mapa.** O fork `spacemandev-git/bo1-zombies-decompiled` lista
bloqueios parecidos, como anim trees e o servidor do frontend.

Por isso o app oferece **duas estratégias de entrada do convidado** (`BO1Z_COOP_START` / `coop.guestStart`):

| estratégia | como | aposta |
| --- | --- | --- |
| `connect` | o `engine.js` do convidado sobe com `+connect localhost` no lugar de `+devmap zombie_coast` | o motor aguenta um cliente sem servidor do mapa |
| `manual` | o convidado sobe solo no mesmo mapa e depois roda `connect localhost` (`tools/console.mjs 9335 "connect localhost"`) | os dados do servidor local, do mesmo mapa, sobram na memória depois do `Com_Shutdown` e o cgame lê algo coerente |

Nas duas, a página do convidado não sai sozinha no `PLATFORM_DISCONNECTED_FROM_SERVER` (patch `noquit` no `engine.js`).
Se nenhuma funcionar, o Plano A morre no convidado. Restariam:
- Plano B ampliado: patch no wasm redirecionando essas leituras;
- pedir ao autor do vel.gg um "seam" de rede como o do fork do spacemandev;
- adotar aquele port aberto quando ele amadurecer.

### 3.3 Corrida de 2 produtores no ring 1 do host (pergunta 2)

O motor lê `send` com um load comum, copia e só então soma. A ponte grava o slot e publica com CAS, e depois confere:
- **`casRetries`**: o motor publicou no meio;
- **`clobbered`**: o motor escreveu por cima do slot da ponte;
- **`phantom`**: o motor publicou o slot seguinte sem escrevê-lo, então o servidor lê um pacote velho.

| cenário | resultado |
| --- | --- |
| estresse (~330 mil pacotes/s) | a corrida aparece em ~1% dos pacotes; nas medições, anomalias (misturado, repetido, perdido) ≤ 2× eventos detectados pelos contadores (o teste exige ≤ 3×) |
| cadência real da gravação (motor a ~108 fps, ponte no ritmo de outro jogador), 15 s | **0 eventos em 1.765 injeções** |
| caminhos de produtor único (servidor → ring k, ponte → ring 0 do convidado) | sem pacote misturado, mesmo com o leitor atrasado (o leitor descarta o slot que pode estar sendo reescrito) |

Pela janela de corrida, de µs, a expectativa é algo como um evento a cada vários minutos de jogo. O netchan absorve
(sequência repetida é descartada, o confiável é retransmitido). O teste F2 mede o número real.

**Heap.** O servidor só endereça `k ≤ 0xffff`, ou seja, rings abaixo de ~1,47 GB. Na gravação, o `wasmBreak` chega a
1,77 GB. Por isso a ponte reserva os 8 rings no N1, antes do `main` do motor, e recusa (com mensagem) um ring fora do
alcance.

## 4. Próximo passo: teste F2 no seu Mac

```sh
cd bo1z-app && git pull && npm ci && node patches/build-glue.mjs && ./build.sh
./scripts/coop-local-test.sh connect      # depois, se precisar: ./scripts/coop-local-test.sh manual
```

O script:
- clona o seu perfil para o convidado (clone APFS, sem gastar espaço);
- sobe as duas janelas (host com som, convidado mudo);
- grava tudo em `/Volumes/HighballGames/bo1z/logs/coop-test-<data>-<estratégia>/`.

O que fazer:
1. Na janela do host, entre em Call of the Dead **sem passar da tela de "clique para jogar"**.
2. Na janela do convidado, escolha Call of the Dead.
3. Quando terminar, aperte Ctrl+C e mande a pasta (ou `resumo.md` + `coop-*.log`) para a próxima sessão.

O `resumo.md` traz um veredito por pergunta, as telas de cada instância e as linhas de console que importam (connect,
challenge, gamestate, erros).

## 5. Co-op Mac ⇄ Windows (depois do F2)

- **Seu irmão:** instala o Tailscale e entra na sua rede. Você gera o zip com `./scripts/package-windows.sh` e manda
  `dist/BO1-Zombies-win64.zip` (instruções no `LEIA-ME.txt` dentro do zip).
- **Você:** roda `./scripts/coop-host.sh`, que mostra o IP 100.x e o código. Ele usa "Entrar na sala.cmd".
- Se estiverem na mesma casa, o IP da rede local basta.

## 6. Pesquisa: vibeslops.luckeysystems.com ("Claude of Duty: Vibe Slops II") e BO2

- **Não é o Black Ops 2 rodando, nem zombies.** É um FPS novo em three.js/WebGL2, feito por agentes de IA, com assets
  extraídos dos `.ff` do BO2 PC pelo OpenAssetTools.
  - Modo: free-for-all contra bots em Hijacked e Nuketown 2025.
  - Assets da Activision redistribuídos pelo próprio site.
  - Código MIT em `github.com/luckeyfaraday/claude-of-duty`; os assets não são licenciados.
- **O multiplayer deles** é um relay WebSocket num Cloudflare Worker + Durable Object (sala de 6 caracteres):
  - o navegador do host simula tudo e manda snapshots JSON a 20 Hz;
  - os convidados mandam input;
  - não usam WebRTC nem TURN.

  Funciona porque o jogo inteiro é JS deles. Não se aplica ao nosso motor, que tem netcode próprio e precisa
  transportar os pacotes crus do motor (é o que a ponte faz).
- **O mesmo autor tem uma reconstrução do Kino der Toten (BO1) com co-op de até 4 já no ar:**
  `kino-der-toten.pages.dev` → "Play with friends". É o caminho de "jogar hoje" sem instalar nada, mas só tem o Kino, é
  uma recriação e depende de um site de terceiro.
- **BO2 zombies no navegador:** não existe. O realista é o Plutonium T6 nativo no Windows, que exige ter o BO2. No Mac
  não há caminho.
- **O que dá para "desburocratizar" de verdade no nosso projeto:**
  - o transporte: UDP + Tailscale no lugar de Worker + WebRTC + TURN (feito);
  - o resto depende de o motor do vel.gg aceitar um convidado (seção 3.2).

## 7. Perguntas abertas (spec §8)

| # | pergunta | status |
| --- | --- | --- |
| 1 | tag k → `remoteAddress.port` → resposta no ring k | **sim, estático** (falta confirmar em execução: o probe mostra `drainedForGuests > 0`) |
| 2 | corrupção pela corrida no ring 1 | simulado: 0 na cadência real; medir no F2 (`casRetries`/`clobbered`/`phantom`) |
| 3 | convidado sem servidor local carrega o mapa via `connect localhost` | **risco alto** (3.2); F2 com `connect` e `manual` |
| 4 | o script conta o convidado | conta quem estiver em `state > 1` na hora da checagem; F2 mede o momento |
| 5 | latência Mac ⇄ Windows, queda para relay | Tailscale mostra direto/DERP (`tailscale status`); o app loga o RTT da sala |
| 6 | patches de desempenho no Windows/D3D12 | desligados no Windows por padrão; medir depois |
