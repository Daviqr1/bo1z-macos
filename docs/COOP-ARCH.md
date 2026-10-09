# Co-op — arquitetura do produto (salas, convite por link, WebRTC, lobby)

Complementa `COOP-P2P-SPEC.md` e `COOP-STATUS.md`. O caminho do motor (ponte nos rings, estratégia shadow, patch G1)
já foi validado com dois motores reais; este documento define as peças em volta dele e **as interfaces entre elas**.
Código e comentários em português, como o resto do repositório. Sem dependências de runtime novas no app (só APIs do
Electron/Chromium/Node); dependências de desenvolvimento são aceitáveis (ex.: `ws` para o servidor de teste).

## Visão geral

```
 vel.gg (página do jogo, mundo principal)              app Electron (processo principal)              nuvem
 ┌─────────────────────────────┐   IPC (contextBridge)  ┌──────────────────────────────┐
 │ lobby (app/lobby/*.mjs)     │◄──── __bo1zLobby ─────►│ session.js (estado da sala)  │
 │ page.mjs + netbridge (rings)│                        │ main-coop.js (wasm/engine.js)│
 └──────────────┬──────────────┘                        └──────────────┬───────────────┘
                │ MessagePort (pacotes do motor)                       │ IPC (bo1z:net-*)
                ▼                                                      ▼
 ┌────────────────────────────────────────────────────────────────────────────┐   WebSocket   ┌──────────────────┐
 │ janela oculta "net" (app/net/net.html + net.mjs): SignalClient,            │◄─────────────►│ signal/ (Worker  │
 │ RTCPeerConnection por par, DataChannels game/ctl, estatísticas             │               │ + Durable Object)│
 └────────────────────────────────────────────────────────────────────────────┘               └──────────────────┘
                ▲ WebRTC (P2P direto; TURN da Cloudflare quando o NAT não deixa)
                ▼
          app do outro jogador (mesma estrutura)
```

- A janela "net" vive o tempo todo do app (não navega): a conexão sobrevive à troca lobby → mapa e ao recarregar.
- Cada página do jogo recebe um `MessagePort` ligado direto à janela net (sem passar pelo main) com o **protocolo de
  pacotes** abaixo, o mesmo que `app/coop/udp.js` (`bindPage`) já fala. `page.mjs` não muda.
- O modo "por IP" (UDP direto, rede de casa/Tailscale, `app/coop/udp.js`) continua como alternativa no lobby.

## 1. Protocolo de pacotes (página do jogo ⇄ transporte) — já existe

Mensagens no `MessagePort` (structured clone; `b` é `Uint8Array` com ≤ 1264 bytes, pacote cru do motor):

| direção | mensagem |
| --- | --- |
| transporte → página (host) | `{ t:'join', id, slot, name }`, `{ t:'leave', id, reason }`, `{ t:'pkt', id, b }` |
| transporte → página (convidado) | `{ t:'pkt', b }` |
| transporte → página | `{ t:'net', stats }` (a cada 2 s, opcional) |
| página → transporte | `{ t:'ready', role, rings }`, `{ t:'pkt', id?, b }` (host manda com `id` do destino), `{ t:'full', id }` |

Regras: semântica UDP (sem garantia, sem ordem); nunca enfileirar indefinidamente (descartar quando o canal estiver
congestionado); `id` é uma string estável por convidado durante a sala. Ao receber `ready` de uma página nova, o
transporte reapresenta (`join`) os convidados já conectados.

## 2. Protocolo de sinalização (app ⇄ signal/, WebSocket JSON, versão 1)

URL: `wss://<host>/ws?v=1`. Toda mensagem é um objeto JSON com `t`. Tamanho máximo 16 KiB. O primeiro envio do
cliente é obrigatoriamente `hello`.

Cliente → servidor:

| `t` | campos | quem |
| --- | --- | --- |
| `hello` | `v:1, role:'host'\|'guest', name, room?` (convidado: código; host: omitido = criar) `, resume?` (token de reentrada) | todos |
| `signal` | `to, data` (`data` = `{ sdp }` ou `{ candidate }`, opaco para o servidor) | todos |
| `lobby` | `data:{ map }` (zone do mapa, ex. `zombie_coast`) | host |
| `ready` | `ready:boolean` | convidado |
| `start` | `map` | host |
| `kick` | `id` | host |
| `ping` | `ts` | todos |
| `leave` | — | todos |

Servidor → cliente:

| `t` | campos |
| --- | --- |
| `welcome` | `room, you, role, hostId, peers:[{ id, name, role, ready }], lobby:{ map }, ice:[RTCIceServer], resume, invite` (`invite` = URL `https://<host>/j/<room>`) |
| `peer-joined` | `peer:{ id, name, role, ready }` |
| `peer-left` | `id, reason` |
| `peer-ready` | `id, ready` |
| `signal` | `from, data` |
| `lobby` | `data:{ map }` |
| `start` | `map, at` (epoch ms do servidor) |
| `pong` | `ts` |
| `error` | `code, message` — códigos: `version`, `room-not-found`, `room-full`, `bad-message`, `rate`, `forbidden`, `name` |
| `closed` | `reason` (`host-left`, `kicked`, `expired`) |

Regras da sala:
- Código de 5 caracteres de `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (sem 0 O 1 I L), gerado no servidor.
- Até 4 jogadores (host + 3). `id` de par: string aleatória de 8 caracteres, nunca reutilizada na sala.
- O host sair encerra a sala depois de 30 s de tolerância (reentrada com `resume`); convidado que cai pode voltar com
  `resume` enquanto a sala existir (mesmo `id`).
- `signal` só é encaminhado entre host ⇄ convidado (estrela). Mensagens de host só aceitas do host.
- Limite de taxa por socket (ex.: 50 mensagens/s com rajada de 100; acima disso `error rate` e fechamento).
- Sala sem ninguém por 10 min some.
- `ice`: se o Worker tiver `TURN_KEY_ID` e `TURN_KEY_API_TOKEN`, pede credenciais curtas à Cloudflare Realtime TURN
  (`POST https://rtc.live.cloudflare.com/v1/turn/keys/<id>/credentials/generate-ice-servers`, Bearer, `{"ttl":86400}`)
  e devolve `iceServers`; sem isso, só STUN (`stun:stun.cloudflare.com:3478`, `stun:stun.l.google.com:19302`).
- `GET /j/<room>`: página de convite (HTML, pt-BR, visual do jogo) que tenta abrir `bo1z://join/<room>?s=<host>` e
  explica o que fazer se o app não abrir (instalar, ou o link de download configurado em `DOWNLOAD_WIN_URL` /
  `DOWNLOAD_MAC_URL`). `GET /health` → `{ ok:true, v:1 }`.

## 3. API do lobby (página ⇄ main): `window.__bo1zLobby`

Exposta pelo preload com `contextBridge` (todas as funções devolvem `Promise`):

```js
__bo1zLobby.getState()                       // -> State
__bo1zLobby.onState(cb)                      // cb(State) a cada mudança; devolve função para cancelar
__bo1zLobby.create({ name, map })            // host: cria sala (via signaling; WebRTC)
__bo1zLobby.join({ code, name })             // convidado: entra pelo código
__bo1zLobby.connectByAddress({ address, code, name, role }) // modo "por IP" (UDP), host ou convidado
__bo1zLobby.leave()
__bo1zLobby.setMap(zone)                     // host
__bo1zLobby.setReady(ready)                  // convidado
__bo1zLobby.start()                          // host: todos navegam para o mapa
__bo1zLobby.copyInvite()                     // -> string (link), também copia para a área de transferência
```

```ts
State = {
  phase: 'idle' | 'connecting' | 'lobby' | 'starting' | 'playing' | 'error',
  mode: 'webrtc' | 'udp' | null,
  role: 'host' | 'guest' | null,
  room: string | null,            // código
  invite: string | null,          // https://<signal>/j/<room>
  you: { id, name } | null,
  map: { zone, slug, name } | null,
  peers: [{ id, name, role, ready, ping: number|null, link: 'direct'|'relay'|'connecting'|'lan'|'lost', loss: number|null }],
  signal: 'online' | 'connecting' | 'offline' | 'n/a',
  error: { code, message } | null,
}
```

Quando o host chama `start()`, todos recebem `phase:'starting'` com `map`, e o **main** navega a janela do jogo para
a página do mapa (`https://vel.gg/bo1z/<slug>`) com início automático (`globalThis.__kisakLandingPick = true` antes do
`play.js`). No convidado, o main serve o `engine.js`/wasm do convidado (estratégia shadow + G1) a partir daí.
`phase:'playing'` quando a página do mapa ativou `page.mjs`.

## 4. Janela net (main ⇄ net, IPC)

Canais (`ipcMain`/`ipcRenderer` via preload da janela net, `app/net/net-preload.js`):
- main → net: `bo1z:net-cmd` com `{ cmd, args }` — `cmd` ∈ `create`, `join`, `leave`, `setMap`, `setReady`, `start`,
  `config` (`{ signalUrl, name }`).
- net → main: `bo1z:net-state` com o `State` parcial (campos de §3 que a rede conhece: `phase`, `role`, `room`,
  `invite`, `you`, `peers`, `signal`, `error`, `lobbyMap`, `startMap`).
- Port de pacotes: o main cria `MessageChannelMain` a cada página do jogo que pede (`bo1z:coop-hello`), manda um lado
  para a página (como hoje) e o outro para a janela net (`webContents.postMessage('bo1z:net-port', null, [port])`).
  A janela net fala o protocolo da §1 nesse port.

## 5. WebRTC (janela net)

- Topologia estrela: cada convidado ⇄ host. O **convidado** cria a oferta.
- DataChannels negociados (`negotiated:true`): `game` (`id:0, ordered:false, maxRetransmits:0`) e `ctl`
  (`id:1`, confiável e ordenado; ping/pong a cada 1 s para RTT e detecção de queda).
- `iceServers` do `welcome`. Trickle ICE via `signal`. ICE restart quando `iceConnectionState` fica `disconnected` por
  mais de 3 s ou `failed`; se o `ctl` ficar 15 s sem pong, o par é dado como perdido (`link:'lost'`, `leave` no port).
- `link`: tipo do par de candidatos selecionado em `getStats()` (`relay` se algum lado for `relay`, senão `direct`).
- Congestionamento: se `game.bufferedAmount > 64 KiB`, descarta o pacote (semântica UDP).

## 6. Lobby (visual)

- Na tela de mapas do vel.gg (a seleção nativa de zombies), um item **JOGAR COM AMIGOS** no mesmo estilo dos itens
  nativos (texto branco condensado, realce no hover, como o toggle HORDE MODE). Ele abre o painel de sala, também com
  o visual do menu do BO1: fundo escuro translúcido, títulos em caixa alta, laranja/branco de destaque.
- Painel: criar sala / entrar com código / conectar por IP; lista de até 4 jogadores (nome, ping em ms com barras,
  selo DIRETO/RELAY/LAN, pronto); mapa escolhido com a arte do próprio site (`https://vel.gg/bo1z/art/...`); botões
  COPIAR CONVITE, INICIAR PARTIDA (host), PRONTO (convidado), SAIR DA SALA; mensagens de estado em português.
- Na página do mapa, um indicador discreto (canto) com ping e qualidade enquanto houver sala.
- Mapas: `MAP_LIST` de `https://vel.gg/bo1z/maps.js` (carregado em tempo de execução).

## 7. Navegador (fase 2)

Extensão MV3 (Chrome/Edge) que injeta o mesmo co-op na página do vel.gg: gancho em `WebAssembly.instantiateStreaming`
(captura memória/exports e aplica G1 no convidado), lobby igual, rede num documento offscreen (sobrevive à
navegação). Fica depois do app.

## Propriedade dos arquivos (para trabalho em paralelo)

| peça | arquivos |
| --- | --- |
| sinalização | `signal/**`, `test/signal*.test.mjs` |
| rede (janela net) | `app/net/**`, `test/net*.test.mjs` |
| lobby | `app/lobby/**`, `test/lobby*.test.mjs`, `tools/lobby-*.mjs` |
| integração (main, preload, session, coop) | `app/main.js`, `app/preload.js`, `app/coop/**`, `build.sh`, `scripts/**` |
