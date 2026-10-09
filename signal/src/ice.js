// Servidores ICE entregues no welcome (docs/COOP-ARCH.md §2). Com TURN_KEY_ID e TURN_KEY_API_TOKEN, pede uma
// credencial curta ao TURN da Cloudflare Realtime (atravessa CGNAT/4G quando o P2P direto não fecha); sem elas, só
// STUN. Nunca rejeita: erro na API vira só STUN (o P2P direto ainda funciona na maioria das redes) e esse resultado
// fica num cache curto para não martelar a API enquanto ela estiver fora.

export const STUN_ONLY = Object.freeze([
  Object.freeze({ urls: Object.freeze(['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302']) }),
]);

export const ICE_API = 'https://rtc.live.cloudflare.com/v1/turn/keys';

export const ICE_DEFAULTS = Object.freeze({
  ttl: 86400, // segundos de validade pedidos à Cloudflare (spec: 24 h; o máximo deles é 48 h)
  cacheMs: 60 * 60e3, // reaproveita a credencial por 1 h: quem recebe sempre leva pelo menos 23 h de validade
  failMs: 60e3, // depois de um erro, 1 min só com STUN antes de tentar de novo
  timeoutMs: 4000, // o welcome espera por isso; mais que alguns segundos atrasa a entrada na sala
});

// Aceita os dois formatos da API (lista de servidores ou um objeto só, do endpoint antigo). Tira as URLs na porta
// 53: navegadores bloqueiam essa porta e o candidato só serve para esperar o timeout. TURN sem credencial é inútil.
export function normalizeIceServers(body) {
  let list = body?.iceServers;
  if (list && !Array.isArray(list)) list = [list];
  if (!Array.isArray(list)) throw new Error('resposta sem iceServers');
  const servers = [];
  for (const entry of list) {
    const raw = Array.isArray(entry?.urls) ? entry.urls : [entry?.urls];
    const urls = raw.filter(url => typeof url === 'string' && /^(stun|turns?):/.test(url) && !/:53(\?|$)/.test(url));
    if (!urls.length) continue;
    const turn = urls.some(url => url.startsWith('turn'));
    if (turn && (typeof entry.username !== 'string' || typeof entry.credential !== 'string')) continue;
    servers.push(turn ? { urls, username: entry.username, credential: entry.credential } : { urls });
  }
  if (!servers.some(server => server.urls.some(url => url.startsWith('turn')))) throw new Error('resposta sem TURN');
  return servers;
}

// Devolve iceServers() -> Promise<RTCIceServer[]>. Pedidos simultâneos dividem a mesma chamada à API.
export function createIceProvider({ keyId, token, fetch: doFetch = globalThis.fetch, now = Date.now, log = () => {},
  ...options } = {}) {
  const o = { ...ICE_DEFAULTS, ...options };
  let cached = null, until = 0, pending = null;

  async function request() {
    const response = await doFetch(`${ICE_API}/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl: o.ttl }),
      signal: AbortSignal.timeout(o.timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalizeIceServers(await response.json());
  }

  return function iceServers() {
    if (!keyId || !token) return Promise.resolve(STUN_ONLY);
    if (cached && now() < until) return Promise.resolve(cached);
    pending ??= request().then(
      servers => { cached = servers; until = now() + o.cacheMs; return servers; },
      error => {
        log(`TURN indisponível (${error?.name === 'TimeoutError' ? 'timeout' : error?.message}); usando só STUN`);
        cached = STUN_ONLY; until = now() + o.failMs;
        return STUN_ONLY;
      },
    ).finally(() => { pending = null; });
    return pending;
  };
}
