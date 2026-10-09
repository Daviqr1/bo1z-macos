# BO1 Zombies — co-op P2P (Mac ⇄ Windows): especificação para implementação

Público: agente de implementação (sessão na nuvem). Autor do pedido: Davi (dono do projeto). Data: 2026-10-09.
Idioma do código/comentários: português, como o resto do app.

> **Atualização 2026-10-09 (sessão na nuvem):** F0, F1, a fiação no app e o zip do Windows estão prontos. O transporte
> v1 virou UDP direto entre os apps (rede de casa ou Tailscale) no lugar de Worker+WebRTC+TURN. A verificação estática
> confirmou o lado do servidor e achou um risco no convidado (o cgame lê dados do servidor direto). Estado, resultados
> e como testar no Mac: [`COOP-STATUS.md`](COOP-STATUS.md).

## 0. Objetivo

Dois a quatro jogadores na mesma partida de zombies (começando por **Call of the Dead / `zombie_coast`**), um no Mac
(app Electron `BO1 Zombies.app`) e outro(s) no Windows (mesmo app empacotado para Windows, ou Chrome). Fluxo de uso:

1. Host clica **"Criar sala"** → recebe um **link/código** (ex.: `bo1z://join/K7QX2` ou `https://<signal>/j/K7QX2`).
2. Convidado abre o link no app dele → os dois conectam por **WebRTC** (P2P; relay TURN quando o NAT impedir).
3. Host inicia o mapa; o convidado entra como jogador 2 na mesma partida.

Não há servidor de jogo central: o **host é o servidor autoritativo** (listen server do próprio motor).

## 1. O que existe hoje (leia antes de qualquer coisa)

### 1.1 O app (Electron 44.7, Mac)
- Fonte: `bo1z-app/` (este repositório). `app/main.js` (processo principal), `app/preload.js` (mundo da página),
  `patches/build-glue.mjs` (gera o glue patcheado), `build.sh` (monta o `.app` no Mac).
- Carrega `https://vel.gg/bo1z/` — port **WebAssembly fechado** de terceiros ("KisakBlack-web": reimplementação do
  Black Ops 1 compilada com Emscripten; wasm32, memória **compartilhada fixa de 2 GiB**, pthreads, WebGPU/WebGL2).
  Não temos o código-fonte do motor. Temos: o glue JS (`/bo1z/artifacts/KisakBlack-web.mjs`), o wasm
  (`/bo1z/artifacts/KisakBlack-web.wasm`, sha256 `61192df377020627…cc98` na análise), as páginas (`engine.js`,
  `play.js`, `maps.js`, `input.js`, `download-worker.js`…), todos públicos.
- O app **intercepta HTTPS** (`session.protocol.handle('https')`) e:
  - serve um glue patcheado no lugar de `KisakBlack-web.mjs` **só se o sha256 do original bater** com
    `patches/manifest.json` (senão passa o original);
  - injeta arquivos extras em packs (`patches/packs/<slug>/…`), adicionando-os ao `manifest.json` do mapa;
  - lê `config.json` (em `/Volumes/HighballGames/bo1z/` no Mac) a cada página: `commands` por mapa (`"*"` e zone)
    entram na linha de comando do motor antes do `+devmap` via `__kisakParity.commands` + `__headlessInput`
    (gancho que já existe no `engine.js` do site, linhas ~424-427).
- DevTools em `127.0.0.1:9334` (telemetria, testes). Gravador passivo `bo1z/tools/recorder.mjs`.
- `main.js` hoje é **específico de Mac** (monta imagem APFS com `hdiutil`, caminhos `/Volumes/...`). Precisa de ramo
  Windows (ver §6).

### 1.2 Fatos verificados sobre a rede do motor (análise estática do wasm + 2 rodadas de verificação adversarial)
- **Não há transporte de rede**: 171 imports, nenhum socket; zero `WebSocket`/`RTCPeerConnection` no glue/wasm.
  `NET_SendPacket`, `NET_GetPacket`, `Sys_SendPacket`, `Sys_GetPacket`, `NET_Init`, `NET_OpenIP` não existem.
  `NET_Restart` só registra `net_noudp=1`, `net_ip`, `net_port=3074`.
- **O netcode do jogo existe e funciona por loopback em memória**: `Netchan_*`, `NET_OutOfBand*`, `SV_DirectConnect`,
  `CL_Connect_f`, `NET_GetLoopPacket`, `Com_ServerPacketEvent`/`Com_ClientPacketEvent`. Topologia listen-server; o
  `main` do wasm força `+set dedicated 0 +set net_ip 127.0.0.1`. `sv_maxclients 24`.
- Todos os 7 pontos de envio fazem `br_table [2,2,0,1]` sobre `adr.type`: tipo 2 (`NA_LOOPBACK`) grava no ring;
  tipos 0/1 nada; tipo ≥3 (IP/broadcast) é **descartado**. `NET_StringToAdr` só aceita `localhost`, `localhost:N`,
  `LOCALHOST` (tipo 2; porta = bswap16(atoi(N)), ou 3074) — nunca IP.
- **Rings de loopback** (endereços absolutos na memória wasm; memória é `SharedArrayBuffer`, acessível do JS):
  - `loopbacks[]` base **135783616** (`0x817E4C0`), **20360 B** por ring; 16 slots × **1272 B**:
    `data[0..1263]`, `len` (i32) em +1264, `tag/porta` (i32) em +1268; contadores u32 `get` em +20352, `send` em
    +20356; se `send-get >= 17`, `get = send-16` (sobrescreve).
  - `loopbacks[0]` = caixa de entrada do **cliente local**; `loopbacks[1]` = caixa de entrada do **servidor**.
  - Cliente envia (`sock<=0`) → `loopbacks[1]`. Servidor envia (`sock==1`) → `loopbacks[adr.port & 0xffff]`.
  - `NET_GetLoopPacket` devolve `from = {type 2, port = int em +1268}`. `NET_CompareAdr` de loopback ignora porta.
  - `loopbacks[2]` cairia em 135824336 (ponteiro do dvar `showpackets`) → o array tem tamanho 2 de verdade.
- `netQueue` (resto do RX real) em 135889920: 16 slots × 1288 B (netadr 16 B + dados em +16, len +1280), `get`
  135910528, `send` 135910532; lido por `Com_ClientPacketEvent`. Escritor único no wasm: ramo "rcon".
- **qport**: sorteado por instância no `main` (entropia, `&0xffff`, evita ≤1), global em **135910540**;
  pode ser forçado com `Net_SetQPort_f`.
- `SV_ReadPackets` corrige `remoteAddress.port` a partir de `from.port` (string "SV_ReadPackets: fixing up a
  translated port"). `SV_DirectConnect` trata como **reconexão** quem casar `CompareBaseAdr` e (qport **ou** porta):
  um remoto com tag 0 colide com o cliente local do host.
  *Correção (verificação de 2026-10-09):* `NET_CompareBaseAdr` **compara a porta** para loopback (tipos 0/2); só
  `NET_CompareAdr` a ignora. Um convidado com tag `k ≠ 0` é outro endereço-base e ganha slot próprio; o tag entra em
  `remoteAddress` já no `Netchan_Setup` (o "fixing up" quase não dispara para loopback). Ver COOP-STATUS §3.
- `malloc`/`free` estão exportados; `engine.js` já usa `module._malloc` da página.
- Build tem **1 cliente local só** (assert `localClientNum < 1`); splitscreen não serve.
- Zombies decide solo/co-op **quando o mapa começa**: `getnumexpectedplayers` conta clientes conectados naquele
  momento (`Scr_Error "SP party count is not ported"` se `onlinegame`/`systemlink` estiverem ligados);
  `numremoteclients` sempre 0. Entrada no meio da partida não é coberta.
- Fontes da análise (no Mac, não versionadas): `scratchpad/gpu/analysis/kb.wat` (desmontagem), `engine-console.txt`,
  relatórios `round2/net-*`. Se precisar, regenere: `wasm2wat KisakBlack-web.wasm` (wabt) — os nomes de função
  estão na name section.

## 2. Arquitetura escolhida

### Plano A (principal): ponte JS sobre os rings, **sem patch no wasm**
Ideia (achada pelo verificador e ainda **não testada em runtime**): o servidor escreve para `loopbacks[k]` com
`k = porta & 0xffff`, e `base + k*20360` cabe nos 2 GiB. Então o JS do host pode criar rings extras **no heap**:

1. Host: `ptr = _malloc(2*20360 + 16)`; zera; escolhe `k = ceil((ptr - 135783616) / 20360)` de modo que
   `[base + k*20360, base + (k+1)*20360)` caia dentro do bloco. Um `k` por convidado (k ≥ 2, nunca 0/1).
2. Pacote do convidado chega pela rede → JS do host escreve no **`S.loopbacks[1]`** (inbox do servidor) com
   **`+1268 = k`** (respeitando o protocolo do ring: escrever slot `send % 16`, depois `Atomics.add(send,1)`).
3. O servidor passa a responder para o ring `k` daquele cliente (via `from.port = k` → `remoteAddress.port`).
   JS do host drena o ring `k` (`get`/`send` em +20352/+20356) e manda pela rede ao convidado.
4. Convidado: instância **sem servidor local** (não sobe `+devmap`; ver §4.3). O cliente dele envia para
   `C.loopbacks[1]` → JS drena e manda ao host. Pacotes do host → JS escreve em `C.loopbacks[0]` (inbox do cliente).
   O convidado executa `connect localhost` (aceito pelo `NET_StringToAdr`).
5. qport distinto por instância (já sorteado); o tag `k` separa os clientes no host.

Riscos conhecidos (tratar explicitamente):
- **Dois produtores** em `S.loopbacks[1]` (o cliente local do host e a ponte JS): o motor lê `send`, escreve o
  slot e só depois faz `atomic.rmw.add`. Mitigação: injetar com `Atomics.compareExchange` no `send` e reservar o
  slot antes de escrever; tolerar descarte ocasional (o netchan já retransmite o confiável). Medir corrupção.
- Ring `k` no heap: garantir que o bloco não é liberado; checar alinhamento (4 B) e que o motor nunca escreve
  além de `20360` B por ring.
- Ordem/tempo: drenar com `Atomics.waitAsync` no contador `send` (ou poll a ~1 ms) — **fora** da thread do motor.
  A página do vel.gg roda o motor em pthreads; a ponte vive no mundo da página (preload/glue patcheado).
- Momento de entrada: convidado precisa estar **conectado antes** do script de zombies contar os jogadores. Estratégia
  a validar: host sobe o mapa com espera (ex.: segurar no "click to start"/intro) até todos `connected`; testar se
  `flag("all_players_connected")`/`getnumexpectedplayers` enxerga o convidado. Se não der, ver Plano B.

### Plano B (fallback): patch pequeno do wasm
Relocar/ampliar `loopbacks[]` para N rings (8 ocorrências de `i32.const 135783616` + 14 memargs
`offset=135803972`; os `i32.const` já são LEB de 5 bytes; offsets uleb precisam ficar < 2^28) **ou** usar o import
existente `emscripten_asm_const_int` com uma entrada nova em `ASM_CONSTS` (o app já serve glue patcheado) chamada nos
`default` dos `br_table` (NA_IP) e estender `NET_StringToAdr`. Servir o wasm patcheado pelo mesmo mecanismo de
sha256 do `main.js` (entrada `KisakBlack-web.wasm` no `patches/manifest.json`). Só se o Plano A falhar.

### Transporte
- *v1 implementada (2026-10-09):* UDP direto entre os processos principais dos apps (`app/coop/udp.js`), com código de
  sala; rede de casa ou Tailscale (atravessa CGNAT sem TURN). O WebRTC abaixo fica para quando o Tailscale não servir.
- **WebRTC DataChannel** `game`: `ordered:false, maxRetransmits:0` (semântica UDP; o netchan faz a confiabilidade).
  Datagrama ≤ **1264 B** (cabe no MTU do SCTP sem fragmentar). Canal `ctl` confiável para controle/ping (2 s).
- Topologia em **estrela**: cada convidado ⇄ host. Convidado faz a offer. Timeout de abertura 8 s → cair para relay.
- ICE: STUN `stun.cloudflare.com:3478` (+ Google como fallback). **TURN obrigatório como fallback** (CGNAT/4G no
  Brasil): Cloudflare Realtime TURN (`turn.cloudflare.com`, portas 3478/udp, 443/udp, 3478/tcp, 80/tcp, 5349/tcp,
  443/tcp; credencial curta via `POST https://rtc.live.cloudflare.com/v1/turn/keys/{KEY_ID}/credentials/generate-ice-servers`
  com Bearer e `{"ttl":N}`, TTL ≤ 48 h; 1.000 GB/mês grátis e depois US$0,05/GB — confirmar no painel). Alternativa:
  coturn na VPS do Davi.
- Onde a WebRTC vive: no **mundo da página** do vel.gg (precisa de acesso ao SAB da memória wasm). A UI de sala e o
  signaling ficam no app (janela/overlay próprio ou processo principal), **não** dentro da página do site.

### Signaling (convite)
- **Cloudflare Worker + Durable Object** (um DO por sala; código de 5–6 caracteres sem `0 O 1 I L`), Hibernatable
  WebSocket API (`ctx.acceptWebSocket`, `webSocketMessage`, `getWebSockets`, `serializeAttachment` ≤ 16 KiB). Workers
  Free com DO SQLite basta (signaling = dezenas de mensagens por sessão).
- Mensagens (JSON): `hello{version}`, `room.create{map, maxPlayers}`, `room.join{code}`, `room.state{players, slots,
  ready}`, `rtc.signal{to, sdp|candidate}` (trickle ICE), `room.start{map, launch}`, `room.end`, `ping`.
- Endpoint `/ice`: emite credenciais TURN **só para quem está numa sala válida** e com rate limit.
- Validar `Upgrade: websocket`, limitar tamanho de mensagem (≤ 16 KiB) e taxa; `webSocketClose` fecha o socket.
- O WebSocket do signaling é aberto pelo **processo principal** (Node não manda `Origin`) ou o servidor aceita a
  origem do app — o renderer na página do vel.gg mandaria `Origin: https://vel.gg`.
- Referência de protocolo já desenhado (sem LICENSE no repo, então **reimplementar**, não copiar):
  `spacemandev-git/bo1-zombies-decompiled` → `web/shared/protocol.ts`, `web/server/lobby.ts`,
  `web/client/src/net/peer.ts`, `transport.ts`, `docs/multiplayer.md`, `docs/web-engine-interface.md` §3.

## 3. Fases e critérios de pronto

| fase | entrega | critério de pronto | onde testar |
| --- | --- | --- | --- |
| F0 | **Simulador de rings** em Node: implementa o layout de §1.2 sobre um `SharedArrayBuffer`, com produtor "motor" e a ponte | testes de concorrência (2 produtores), wrap-around de 16 slots, `send-get>=17` | nuvem |
| F1 | **Ponte JS** (`netbridge.mjs`): `openHostRing(k)`, `injectToServer(bytes, k)`, `drainRing(k)`, `injectToClient(bytes)`, `drainClientOut()`; ligada ao `Module` via glue patcheado (expor `Module` ou `HEAPU8`/`_malloc` em `globalThis.__bo1zKB`) | testes do F0 passam com a ponte real | nuvem |
| F2 | **Loopback 2 instâncias no mesmo Mac**: duas janelas/perfis do app, host + convidado, ponte via `BroadcastChannel`/IPC local (sem WebRTC) | convidado conecta (`SV_DirectConnect` no log), vê o host e zumbis; host vê o convidado | Mac do Davi (script pronto para ele rodar) |
| F3 | **Signaling** (Worker+DO) + **WebRTC** + TURN | dois apps em redes diferentes trocam pacotes; RTT/perda medidos (burst test sem o jogo) | nuvem (deploy) + Mac/Windows |
| F4 | **Fluxo de jogo**: criar sala → link → entrar → host inicia CotD com o convidado contado como jogador | partida de 2 jogadores até o round 5 sem desync/queda | Mac + Windows |
| F5 | **App Windows**: ramo de plataforma no `main.js` + zip portátil | irmão abre o zip, joga solo e entra na sala | Windows do irmão |
| F6 | Robustez: reconexão (janela 30 s), host saiu = fim da sala, contagem de perda/latência na UI, 3–4 jogadores | sessões de 30 min estáveis | Mac + Windows |

## 4. Detalhes de implementação

### 4.1 Acesso à memória do motor
- O glue é modularizado (`createKisakBrowser`); o objeto `Module` não é global. Adicionar no `patches/build-glue.mjs`
  uma linha que exponha o necessário após a instanciação (padrão já usado: o patch I1 envolve `_KB_Input` perto de
  `_KB_Input = Module["_KB_Input"] = wasmExports["KB_Input"]`). Ex.: `globalThis.__bo1zKB = { HEAPU8, HEAP32, _malloc,
  _free, memory: wasmMemory }` — confirmar os nomes no glue formatado (`npx prettier@3.3.3 --parser babel`).
- Toda patch do glue continua condicionada ao sha256 do original (se o vel.gg atualizar, os endereços do §1.2
  provavelmente mudam: **revalidar os endereços por padrão de bytes**, não por constante fixa, e desligar o co-op se
  não baterem).

### 4.2 Host
- Sobe o mapa normalmente (`+devmap zombie_coast` pelo site). Antes de liberar o "click to start", espera os
  convidados conectarem (estado da sala no signaling + `SV_DirectConnect` observado no console da página
  `five.console`).
- Um ring `k` por convidado; tabela `k ↔ peerId`. Drenagem e injeção fora da thread do motor.

### 4.3 Convidado
- Precisa do **mesmo pack** do mapa (baixado do vel.gg pelo próprio app dele — **nunca** redistribuir assets).
- Precisa subir o motor **sem servidor local**: hoje o `engine.js` sempre acrescenta `+devmap <mapa>`. Opções a
  avaliar: (a) servir um `engine.js` patcheado (mesma interceptação) que troque `+devmap` por `+connect localhost`
  no modo convidado; (b) subir com `+devmap` e logo `disconnect`/`killserver` antes de conectar. Validar que o pack
  do mapa é carregado pelo `connect` (gamestate do host manda o mapa).
- `NET_StringToAdr("localhost")` → tipo 2; o cliente envia ao `C.loopbacks[1]` que a ponte drena.

### 4.4 Dvars/comandos relevantes
- Já usados pelo app: `com_filter_output 1`, `con_hidechannel server` (spam), `r_webgpu_pipeline 2`, `fs_mods boxfix`,
  `boxfix_start beach_chest` (mod que põe a caixa no spawn da CotD).
- **Não** ligar `systemlink`/`onlinegame` (`getnumexpectedplayers` dá `Scr_Error`).
- `kisak_testclient`/`addtestclient` existem (bots) — úteis para testar multi-cliente no servidor antes da rede.

## 5. Testes (a nuvem não tem os assets nem GPU Apple)
- F0/F1: unitários em Node com o simulador; cobrir corrida de 2 produtores, wrap, perda, pacotes de 1264 B.
- Para F2+: entregar **scripts prontos para o Davi rodar no Mac** (ex.: `scripts/coop-local-test.sh` que abre duas
  instâncias com perfis distintos e portas DevTools 9334/9335 e coleta logs), e um checklist para o Windows do irmão.
- Telemetria: reaproveitar `bo1z/tools/recorder.mjs` (DevTools 127.0.0.1) por instância.
- Nunca gerar áudio audível em testes automatizados (`BO1Z_MUTE=1`).

## 6. App para Windows
- `main.js`: ramo por plataforma — userData em `app.getPath('appData')/BO1 Zombies`, sem `hdiutil`/`/Volumes`,
  menus adequados; `patches:false` como padrão no Windows até medir os patches de desempenho em D3D12.
- Empacotamento a partir do Mac: zip portátil (baixar `electron-v44.7.0-win32-x64.zip` oficial, apagar
  `resources/default_app.asar`, copiar `app/` para `resources/app`, renomear `electron.exe` → `BO1 Zombies.exe`).
  **Não** incluir no zip o glue patcheado (`*.patched.mjs`) nem o mod derivado de script da Activision: aplicar os
  patches **em runtime** sobre o original baixado do vel.gg (diff sobre o texto original + checagem de sha256).
- SmartScreen: zip sem assinatura → "Mais informações" → "Executar assim mesmo" (ou "Desbloquear" nas propriedades).
- Alternativa sem instalar: Chrome no Windows em `vel.gg/bo1z` joga solo, mas **não** tem a ponte de rede.

## 7. Restrições e cuidados
- Uso **privado** (Davi e irmão). Sem página pública de download. Não redistribuir wasm/glue/assets do vel.gg nem
  arquivos do jogo; o app baixa tudo do site em cada máquina.
- O motor é de terceiros e fechado: patches de wasm (Plano B) só para uso local.
- Não mudar comportamento do jogo solo: tudo de co-op atrás de um modo explícito (sala ativa).
- Commits: `feat|fix|docs|chore(escopo): descrição`, sem linhas de co-autoria.

## 8. Perguntas em aberto (responder com teste)

Status em 2026-10-09 (1 e 4 favoráveis pela análise estática; 3 com risco alto): ver COOP-STATUS §7.

1. O tag `k` em +1268 sobrevive até `remoteAddress.port` e o servidor responde no ring `k`? (estático diz que sim)
2. Corrida de 2 produtores em `S.loopbacks[1]`: qual a taxa de corrupção observada? Precisa do Plano B?
3. O convidado consegue subir sem servidor local e carregar o mapa via `connect localhost`?
4. O script de zombies conta o convidado se ele conectar antes do fim do carregamento do host?
5. Latência real Mac ⇄ Windows (mesma casa / redes diferentes) e taxa de queda para TURN.
6. Os patches de desempenho (a, c, e, P01) funcionam no Windows/D3D12?
