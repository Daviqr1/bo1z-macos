// Convite pelo navegador e marcas na URL do vel.gg (lidas pelos content scripts em document_start).
//
//   https://vel.gg/bo1z/#bo1z-join=<código>&s=<servidor de sinalização>
//     <código>: 5 caracteres de ABCDEFGHJKMNPQRSTUVWXYZ23456789 (COOP-ARCH §2), maiúsculas ou minúsculas
//     <servidor>: o host (ex.: bo1z-signal.fulano.workers.dev, vira https://<host>); para testes locais também
//                 http://127.0.0.1:8787 (http/ws só em endereço de loopback)
//   A extensão lê o hash, tira da barra de endereço e entra na sala com o nome salvo nas opções.
//
//   https://vel.gg/bo1z/<mapa>#bo1z-start
//     Navegação da própria extensão quando o host inicia a partida: a página do mapa começa sozinha
//     (globalThis.__kisakLandingPick, como na escolha de mapa da tela inicial do site).

export const GAME_URL = 'https://vel.gg/bo1z/';
export const ROOM = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
export const JOIN_KEY = 'bo1z-join';
export const START_MARK = '#bo1z-start';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const HOST = /^[a-z0-9.-]+(:\d{1,5})?$/i;

// Servidor de sinalização digitado (opções) ou vindo do convite -> URL base (https://host ou http://loopback:porta),
// ou null se não for aceitável. O cliente de sinalização (app/net) troca o esquema por wss/ws e acrescenta /ws?v=1.
export function normalizeSignal(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;
  if (HOST.test(text)) return `https://${text.toLowerCase()}`;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.username || url.password) return null;
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  if (!secure && !((url.protocol === 'http:' || url.protocol === 'ws:') && LOOPBACK.has(url.hostname))) return null;
  return `${secure ? 'https' : 'http'}://${url.host}${url.pathname.replace(/\/(ws)?$/, '')}`;
}

// Valor do s= no convite: só o host quando é https (o formato curto do convite); a URL inteira no caso de loopback.
export function signalParam(signalUrl) {
  const url = normalizeSignal(signalUrl);
  if (!url) return null;
  const u = new URL(url);
  return u.protocol === 'https:' && u.pathname === '/' ? u.host : url;
}

export function inviteLink({ code, signalUrl }, base = GAME_URL) {
  const s = signalParam(signalUrl);
  if (!ROOM.test(String(code ?? '')) || !s) return null;
  return `${base}#${JOIN_KEY}=${code}&s=${encodeURIComponent(s)}`;
}

// location.hash -> { code, signalUrl } | null
export function parseInviteHash(hash) {
  const text = String(hash ?? '').replace(/^#/, '');
  if (!text.startsWith(JOIN_KEY + '=')) return null;
  const params = new URLSearchParams(text);
  const code = String(params.get(JOIN_KEY) ?? '').trim().toUpperCase();
  if (!ROOM.test(code)) return null;
  const s = params.get('s');
  return { code, signalUrl: s ? normalizeSignal(s) : null };
}

// O que o jogador cola no campo "entrar com código": o código, o convite do navegador, o da página do servidor
// (https://<servidor>/j/<código>) ou o do app (bo1z://join/<código>?s=<servidor>). -> { code, signalUrl } | null
export function parseJoinInput(input) {
  const text = String(input ?? '').trim();
  const hash = text.indexOf('#' + JOIN_KEY + '=');
  if (hash >= 0) return parseInviteHash(text.slice(hash));
  const page = /^(https?):\/\/([^/?#]+)\/j\/([^/?#]+)/i.exec(text);
  if (page) {
    const code = decodeURIComponent(page[3]).toUpperCase();
    return ROOM.test(code) ? { code, signalUrl: normalizeSignal(`${page[1]}://${page[2]}`) } : null;
  }
  const app = /^bo1z:\/\/join\/([^/?#]+)(?:\?(.*))?$/i.exec(text);
  if (app) {
    const code = decodeURIComponent(app[1]).toUpperCase(), s = new URLSearchParams(app[2] ?? '').get('s');
    return ROOM.test(code) ? { code, signalUrl: s ? normalizeSignal(s) : null } : null;
  }
  const code = text.toUpperCase().replace(/[\s-]/g, '');
  return ROOM.test(code) ? { code, signalUrl: null } : null;
}

// Mapa da página do jogo pela URL: /bo1z/<slug> (null na tela inicial /bo1z).
export function slugFromPath(pathname) {
  const m = /^\/bo1z\/([a-z0-9_-]+)\/?$/i.exec(String(pathname ?? ''));
  return m ? m[1].toLowerCase() : null;
}

export const mapPageUrl = (slug, base = GAME_URL) => new URL(slug, base).href + START_MARK;
