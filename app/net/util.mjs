// Utilitários da janela net (sem APIs do navegador no topo do módulo: tudo roda também no Node, nos testes).

// Emissor mínimo. Um handler que lança não derruba os outros: o erro sobe numa microtask (console no navegador,
// falha visível no node --test).
export class Emitter {
  #handlers = new Map();

  on(type, fn) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(fn);
    return () => this.off(type, fn);
  }

  off(type, fn) { this.#handlers.get(type)?.delete(fn); }

  emit(type, ...args) {
    for (const fn of [...(this.#handlers.get(type) ?? [])]) {
      try { fn(...args); } catch (error) { queueMicrotask(() => { throw error; }); }
    }
  }
}

// Relógio real. Os testes injetam um falso com a mesma forma (now monotônico em ms, wall = epoch ms).
export const realClock = Object.freeze({
  now: () => performance.now(),
  wall: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: id => clearTimeout(id),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: id => clearInterval(id),
});

// Código de sala: 5 caracteres sem 0 O 1 I L (COOP-ARCH §2).
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${ROOM_ALPHABET}]{5}$`);

// Aceita o código puro ("abc23", "ABC-23") ou o próprio convite: https://<host>/j/<sala> e bo1z://join/<sala>?s=<host>.
// Devolve { code, server } (server = URL do servidor de sinalização tirada do convite, ou null) ou null se inválido.
export function parseRoomCode(input) {
  const text = String(input ?? '').trim();
  let raw = text, server = null;
  const link = /^(?:(https?|wss?):\/\/([^/?#]+)\/j\/|bo1z:\/\/join\/)([^/?#]+)(?:\?(.*))?/i.exec(text);
  if (link) {
    raw = decodeURIComponent(link[3]);
    if (link[2]) server = `${/^(https|wss)$/i.test(link[1]) ? 'wss' : 'ws'}://${link[2]}`;
    const s = new URLSearchParams(link[4] ?? '').get('s');
    if (s) server = /^wss?:\/\//i.test(s) ? s : /^https?:\/\//i.test(s) ? s.replace(/^http/i, 'ws') : `wss://${s}`;
  }
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  return CODE_RE.test(code) ? { code, server } : null;
}

// URL do WebSocket de sinalização: aceita "host", "https://host", "wss://host" ou a URL completa; garante /ws e ?v=1.
export function normalizeSignalUrl(input, version = 1) {
  let text = String(input ?? '').trim();
  if (!text) throw new Error('URL de sinalização vazia');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = 'wss://' + text;
  const url = new URL(text);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  if (url.protocol !== 'wss:' && url.protocol !== 'ws:') throw new Error(`protocolo não suportado: ${url.protocol}`);
  if (url.pathname === '' || url.pathname === '/') url.pathname = '/ws';
  url.searchParams.set('v', String(version));
  url.hash = '';
  return url.href;
}

// Nome visível: sem caracteres de controle, até 32 caracteres.
export function sanitizeName(name, fallback = 'Jogador') {
  const clean = String(name ?? '').replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 32);
  return clean || fallback;
}

export const isPlainObject = x => x !== null && typeof x === 'object' && !Array.isArray(x);
