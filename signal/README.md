# bo1z-signal: salas e convites do co-op

Servidor de sinalização do co-op do BO1 Zombies: um Cloudflare Worker com um Durable Object por sala. Ele cria a sala,
entrega o código de 5 letras e o link de convite, mostra quem está no lobby e passa as ofertas e os candidatos do
WebRTC entre o host e cada convidado. O jogo em si não passa por aqui: os pacotes do motor vão direto de app para app
(WebRTC P2P). Quando a rede não deixa o P2P direto fechar (CGNAT, 4G), vão pelo TURN da Cloudflare.

Protocolo: [`docs/COOP-ARCH.md`](../docs/COOP-ARCH.md) §2. As decisões de implementação estão em
[Detalhes do protocolo](#detalhes-do-protocolo).

| arquivo | o quê |
| --- | --- |
| `src/room.js` | lógica da sala, pura (roda igual no Worker e no Node): hello/welcome, entrada, reentrada, signal, lobby, limites, prazos |
| `src/do.js` | Durable Object `RoomDO`: WebSockets hibernáveis, estado no storage (SQLite), alarm como despertador |
| `src/index.js` | Worker: `GET /health`, `GET /j/<código>` (convite), `GET /ws` (WebSocket, roteado para a sala) |
| `src/ice.js` | servidores ICE: credencial curta do TURN da Cloudflare (com cache) ou só STUN |
| `src/invite.js` | página de convite (pt-BR, visual de menu do Black Ops) que abre `bo1z://join/<código>?s=<servidor>` |
| `dev-server.mjs` | o mesmo servidor em Node puro (http + ws), para testes e para rodar em casa |
| `wrangler.toml` | configuração do Worker (`bo1z-signal`, binding `ROOMS`, migration SQLite) |

## Colocar no ar (uma vez, uns 10 minutos)

Precisa de uma conta gratuita na Cloudflare e do Node 22.

```sh
cd signal
npm install                 # instala o wrangler (só para deploy/dev; o Worker não tem dependências)
npx wrangler login          # abre o navegador para autorizar a sua conta
npx wrangler deploy         # publica; no fim mostra a URL, ex. https://bo1z-signal.<sua-conta>.workers.dev
```

Confira:

```sh
curl https://bo1z-signal.<sua-conta>.workers.dev/health       # {"ok":true,"v":1}
```

Abra `https://bo1z-signal.<sua-conta>.workers.dev/j/ABCDE` no navegador para ver a página de convite.

No app, o endereço da sinalização é `wss://bo1z-signal.<sua-conta>.workers.dev` (configuração `signalUrl`). O
WebSocket fica em `/ws?v=1`.

### TURN (recomendado)

Sem TURN, o welcome só leva STUN. Isso resolve a maioria das redes de casa, mas não quem está atrás de CGNAT, comum em
4G e em algumas operadoras de fibra. Para ligar o TURN:

1. No painel da Cloudflare, abra **Realtime → TURN Server → Create**
   (atalho: <https://dash.cloudflare.com/?to=/:account/calls>). Anote o **Turn Token ID** e o **API Token**.
2. Grave os dois como segredos do Worker. O wrangler pede o valor; cole e dê Enter:

   ```sh
   npx wrangler secret put TURN_KEY_ID
   npx wrangler secret put TURN_KEY_API_TOKEN
   ```

O `secret put` já publica uma versão nova do Worker, sem precisar de `deploy`. Como todo deploy, derruba os WebSockets
abertos: faça fora de partida. O Worker pede credenciais de 24 h à API da Cloudflare e reaproveita cada uma por 1 h. Quem entra recebe sempre pelo menos 23 h de validade. Se a API falhar, a sala continua funcionando só com
STUN e o Worker tenta de novo 1 minuto depois.

### Opcional

Edite `wrangler.toml`, descomente `[vars]` e rode `npx wrangler deploy` de novo:

- `DOWNLOAD_WIN_URL` e `DOWNLOAD_MAC_URL`: links de download mostrados na página de convite para quem ainda não tem o
  app. Só `http(s)` é aceito.
- `PUBLIC_ORIGIN`: domínio próprio usado nos convites (ex. `https://salas.seudominio.com`), se você ligar um custom
  domain ao Worker.

Deploy novo derruba os WebSockets abertos (limitação da Cloudflare). As salas não se perdem: o estado fica no storage e
os apps voltam com o token de reentrada. Mesmo assim, evite fazer deploy no meio de uma partida.

## Custo

Para dois ou quatro jogadores, fica tudo dentro do plano gratuito.

- **Workers Free**: 100 mil requisições por dia. O plano gratuito usa Durable Objects com SQLite, que é o tipo
  configurado aqui.
  - Cada mensagem WebSocket recebida conta como 1/20 de requisição.
  - Uma sessão de jogo usa algumas dezenas de mensagens: hello, sinalização do WebRTC e lobby.
  - Os sockets hibernam, então não há cobrança de duração enquanto ninguém fala.
  - O `{"t":"ping"}` de keepalive é respondido pelo runtime sem acordar a sala.
- **TURN** só conta o tráfego que passa pelo relay, ou seja, quando o P2P direto não fecha.
  - O primeiro 1.000 GB por mês é grátis. Depois disso, US$ 0,05/GB.
  - O co-op é leve: na ordem de 100 MB por hora por convidado em relay (estimativa pelo tráfego do netchan).
  - O painel pode pedir um meio de pagamento cadastrado para liberar o Realtime. Confira lá.

## Rodar local

```sh
npm run dev                  # o Worker de verdade (workerd) em http://127.0.0.1:8787
node dev-server.mjs 8787     # ou o servidor Node (mesmo protocolo, salas só na memória)
```

O `dev-server.mjs` escuta em `0.0.0.0` por padrão, então serve na rede de casa ou no Tailscale. Ele mostra os
endereços da máquina ao subir.

Variáveis aceitas: `PORT`, `HOST`, `PUBLIC_ORIGIN`, `TURN_KEY_ID`/`TURN_KEY_API_TOKEN` e `DOWNLOAD_*_URL`. Para testes
há também prazos curtos: `HOST_GRACE_MS`, `GUEST_GRACE_MS`, `EMPTY_TTL_MS` e `HELLO_TIMEOUT_MS`. No `wrangler dev`,
passe com `--var NOME:valor`. Em produção, deixe os prazos padrão.

## Testes

Da raiz do repositório:

```sh
node --test test/signal-*.test.mjs        # ou: npm test (a suíte inteira)
```

| arquivo | o que testa |
| --- | --- |
| `signal-room.test.mjs` | a sala inteira sem rede, com relógio de mentira: protocolo, prazos, hibernação, abusos |
| `signal-dev.test.mjs` | ponta a ponta com WebSocket de verdade contra o `dev-server.mjs` |
| `signal-ice.test.mjs` | TURN: pedido, cache, falhas, timeout |
| `signal-invite.test.mjs` | página de convite: escape e CSP; se houver Chromium (`BO1Z_CHROME`), roda a página de verdade |

O teste de ponta a ponta também roda contra o Worker de verdade:

```sh
(cd signal && npx wrangler dev --port 8787 --var HOST_GRACE_MS:1500 --var GUEST_GRACE_MS:1500) &
BO1Z_SIGNAL_URL=http://127.0.0.1:8787 node --test test/signal-dev.test.mjs
```

## Detalhes do protocolo

### Como o socket chega à sala

O `hello` só chega depois do upgrade, quando o Worker já escolheu o Durable Object. Por isso o roteamento vai na URL:

- **Host criando sala**: `/ws?v=1`, sem `room`.
  - O Worker sorteia o código e encaminha o upgrade para `idFromName(código)`.
  - Se esse código já estiver em uso, a sala responde 409 e o Worker sorteia outro.
  - O `hello` do host vem sem `room`; o código chega no `welcome`.
- **Convidado entrando**, ou **qualquer reentrada** (host ou convidado com `resume`): `/ws?v=1&room=<código>`.
  - O `hello` traz o mesmo código.
- **Código fora do alfabeto ou `v` diferente de 1 na URL**: o Worker responde ao primeiro envio do cliente com o
  `error` do protocolo (`room-not-found` ou `version`) e fecha.

### O que o servidor manda

- **`welcome.peers`** são os *outros* jogadores presentes. Você vem em `you`/`role`.
  - A lista inclui quem caiu há menos de 30 s, que ainda está na sala esperando reentrada.
  - O host aparece com `ready: true`.
- **Eventos de estado** vão para todos, inclusive quem originou: `lobby`, `peer-ready` e `start`. O cliente pode usá-los
  como confirmação.
- **`peer-joined`** vai para todos menos quem entrou.
- **Mapa novo no `lobby`** desfaz o `ready` dos convidados, que recebem `peer-ready` com `ready: false`: o pronto anterior
  era para outro mapa.
- **Extensões compatíveis**, que clientes antigos podem ignorar:
  - `welcome.started` (`{ map, at }` da última partida iniciada, ou `null`);
  - `pong.now`: hora do servidor, para calcular o desvio do relógio e usar o `at` do `start`.

### Quedas e reentrada

- **Socket que cai sem `leave`** é uma queda: ninguém é avisado na hora, porque o WebRTC pode continuar de pé.
- **Host caído**: a sala espera 30 s.
  - Se ele voltar com `resume`, recebe o mesmo `id` e os convidados nem percebem.
  - Se não voltar, todos recebem `closed {reason:'host-left'}`.
- **Convidado caído por mais de 30 s**: os outros recebem `peer-left {reason:'lost'}` e a vaga fica livre.
  - O token continua valendo enquanto a sala existir.
  - Se ele voltar com vaga, recebe o mesmo `id` e os outros recebem `peer-joined`.
- **`leave` do host** encerra a sala na hora.
- **`leave` de convidado** manda `peer-left {reason:'left'}` aos outros e invalida o token.
- **`kick`** manda `closed {reason:'kicked'}` ao expulso, `peer-left {reason:'kicked'}` aos outros e invalida o token.
- **Reentrada com a conexão antiga ainda aberta** (meia-aberta, por exemplo quando o Wi-Fi trocou): a nova assume e a
  antiga é fechada com o código 4001.
- **`signal` para quem está sem conexão** é descartado em silêncio, como no resto da sinalização (melhor esforço). O
  WebRTC refaz a negociação quando precisa.
- **`closed {reason:'expired'}`**: sala sem nenhuma conexão por 10 min some.
  - Com o host ausente, a sala já acaba em 30 s.
  - Os 10 min servem de garantia, junto com a **ronda**: com a sala viva, há sempre um alarm a no máximo 10 min. Se a
    Cloudflare reiniciar o objeto sem avisar, a ronda nota que ninguém voltou e apaga o estado.

### Limites e fechamento

| limite | valor |
| --- | --- |
| jogadores por sala | 4 (host + 3) |
| tamanho de mensagem | 16 KiB em UTF-8 |
| taxa por socket | 50 mensagens/s, rajada de 100 |
| tempo para o `hello` | 10 s |
| sockets por sala | 12 (contando reentradas e conexões sem hello) |
| ids por sala | 256 (nunca se repetem) |
| mensagens inválidas | 20, depois de entrar na sala |

Nomes têm de 1 a 24 caracteres visíveis: sem controles, marcas de direção nem caracteres invisíveis. O código da sala
aceita minúsculas e espaços em volta.

Códigos de fechamento (o motivo de verdade vai antes, numa mensagem `error`/`closed`):

| código | quando |
| --- | --- |
| 1000 | `leave`, `kick`, sala encerrada |
| 1009 | mensagem grande demais |
| 4000 | erro do protocolo |
| 4001 | substituída por reentrada |
| 4002 | `hello` não chegou a tempo |
| 4008 | taxa estourada |

### Recomendações para o cliente (janela net)

- Mande o `hello` assim que o socket abrir.
- Guarde `resume` e o código. Ao cair, reconecte em `/ws?v=1&room=<código>` com backoff curto (0,5 s, 1 s, 2 s…) e o
  mesmo `hello` mais `resume`.
  - O `welcome` da reentrada traz `ice` novo: use em `setConfiguration`.
  - `room-not-found` ou `forbidden` na reentrada significa que a sala acabou ou que você foi removido.
- Mande `{"t":"ping"}` exatamente assim a cada 30 s como keepalive. No Durable Object, o runtime responde
  `{"t":"pong"}` sem acordar a sala; isso nem conta no limite de taxa. No `dev-server.mjs`, quem responde é a sala, e
  conta.
  - Use `{"t":"ping","ts":…}` quando quiser medir RTT e desvio de relógio.
- Origem não é checada: não há cookie nem credencial ambiente. O segredo de cada jogador é o token de reentrada.
