// Estado da sala no documento offscreen da extensão: o equivalente do app/coop/session.js (processo principal do app)
// para o navegador, só com WebRTC. A rede é a NetSession da janela net do app (app/net/session.mjs, copiada no build);
// aqui fica o que o main do app faz em volta dela: estado da API do lobby (COOP-ARCH §3), lista de mapas, preferências,
// a aba "dona" da sala e a ida para o mapa quando o host inicia.
//
// Eventos: 'state' (State §3 + maps, name, browserInvite) e 'navigate' ({ url, map, tabId }).
import { DEFAULT_MAPS } from './maps.mjs';
import { GAME_URL, ROOM, inviteLink, mapPageUrl, normalizeSignal } from './invite.mjs';

const PHASES_WITH_GAME = new Set(['starting', 'playing']);
const NET_KEYS = ['phase', 'role', 'room', 'invite', 'you', 'peers', 'signal', 'error'];
const cleanName = name => String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
export const CALLS = new Set(['getState', 'create', 'join', 'connectByAddress', 'leave', 'setMap', 'setReady', 'start',
  'copyInvite']);

export const MESSAGES = Object.freeze({
  'no-net': 'A parte de rede do co-op (app/net) não veio neste build da extensão.',
  'no-signal': 'Servidor de convite não configurado. Abra as opções da extensão e informe o servidor ' +
    '(ou entre por um link de convite).',
  'bad-code': 'Código de sala inválido (5 letras/números).',
  'no-udp': 'Conectar por IP só funciona no app BO1 Zombies (o navegador não abre conexões UDP). ' +
    'Use Criar sala ou Entrar com código.',
  'bad-map': 'Mapa desconhecido.',
});

// startMap da rede: { zone, at } (app/net) ou só a zone. A chave muda a cada start, mesmo para o mesmo mapa.
function startInfo(startMap) {
  if (!startMap) return null;
  if (typeof startMap === 'string') return { zone: startMap, key: startMap };
  if (typeof startMap.zone === 'string') return { zone: startMap.zone, key: `${startMap.zone}@${startMap.at ?? ''}` };
  return null;
}

export class ExtSession {
  constructor({ net = null, log = () => {}, gameUrl = GAME_URL } = {}) {
    Object.assign(this, { net, log, gameUrl });
    this.handlers = { state: new Set(), navigate: new Set() };
    this.maps = DEFAULT_MAPS.map(m => ({ ...m }));
    this.prefs = { name: '', signal: '' };
    this.state = this.blank();
    this.owner = null; // aba que criou/entrou na sala: é ela que vai para o mapa
    this.signalUrl = null; // servidor da sala atual (para o convite do navegador)
    this.startKey = null;
  }

  on(type, fn) { this.handlers[type].add(fn); return () => this.handlers[type].delete(fn); }
  emit(type, value) {
    for (const fn of this.handlers[type]) {
      try { fn(value); } catch (error) { this.log(`handler ${type}: ${error.message}`); }
    }
  }

  blank() {
    return { phase: 'idle', mode: null, role: null, room: null, invite: null, you: null, map: null, peers: [], signal: 'n/a',
      error: null };
  }
  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }
  // Cópia serializável (vai pelo chrome.runtime.Port) com a lista de mapas, o nome salvo e o convite do navegador.
  getState() {
    const s = this.state;
    const browserInvite = s.room && this.signalUrl ? inviteLink({ code: s.room, signalUrl: this.signalUrl }) : null;
    return JSON.parse(JSON.stringify({ ...s, maps: this.maps, name: this.prefs.name, browserInvite }));
  }
  fail(code, message = MESSAGES[code] ?? code) {
    this.setState({ phase: 'error', error: { code, message } });
    return this.getState();
  }
  mapByZone(zone) { return this.maps.find(m => m.zone === zone) ?? null; }

  setPrefs(prefs = {}) {
    if (typeof prefs.name === 'string') this.prefs.name = cleanName(prefs.name);
    if (typeof prefs.signal === 'string') this.prefs.signal = prefs.signal.trim();
  }
  setMaps(list) {
    if (!Array.isArray(list) || !list.length) return;
    const ok = list.filter(m => m && /^[a-z0-9_]+$/.test(m.zone) && /^[a-z0-9_-]+$/.test(m.slug) && typeof m.name === 'string')
      .map(({ zone, slug, name }) => ({ zone, slug, name }));
    if (!ok.length || JSON.stringify(ok) === JSON.stringify(this.maps)) return;
    this.maps = ok;
    this.emit('state', this.getState());
  }
  remember(name) {
    const clean = cleanName(name);
    if (clean) this.prefs.name = clean;
    return clean || this.prefs.name || 'Jogador';
  }

  // A aba deve rodar o motor como host/convidado? (partida iniciada, aba dona da sala) -> { role, map, name } | null
  gameFor(tabId) {
    const s = this.state;
    if (!PHASES_WITH_GAME.has(s.phase) || !s.role || !s.map) return null;
    if (this.owner !== null && tabId !== this.owner) return null;
    const { zone, slug, name } = s.map;
    return { role: s.role, map: { zone, slug, name }, name: s.you?.name ?? this.prefs.name };
  }

  // Chamada da API do lobby (§3) vinda de uma aba (ctx.tabId) ou do popup.
  async call(fn, args = [], ctx = {}) {
    if (!CALLS.has(fn)) throw new Error(`chamada desconhecida: ${fn}`);
    const a = Array.isArray(args) ? args : [];
    return this[fn](a[0], ctx);
  }

  // ---- rede (NetSession)
  onNetState(s) {
    if (!s || typeof s !== 'object') return;
    if (this.state.mode !== 'webrtc' && (s.phase === 'idle' || !s.phase)) return; // estado inicial da rede: nada a fazer
    const patch = {};
    for (const key of NET_KEYS) if (key in s) patch[key] = s[key];
    // starting/playing são decididos aqui (navegação e página ativa); a rede fica em 'starting' para sempre depois do start
    const inGame = PHASES_WITH_GAME.has(this.state.phase);
    if (inGame && ['lobby', 'connecting', 'starting'].includes(patch.phase)) delete patch.phase;
    if (!inGame && patch.phase === 'starting') delete patch.phase; // beginGame decide
    if (s.lobbyMap) patch.map = this.mapByZone(s.lobbyMap) ?? this.state.map;
    if (s.phase === 'idle') { this.reset(); return; }
    this.setState({ mode: 'webrtc', ...patch });
    const start = startInfo(s.startMap);
    if (start && start.key !== this.startKey) this.beginGame(start.zone, start.key);
  }

  reset() {
    this.startKey = null;
    this.signalUrl = null;
    this.state = this.blank();
    this.emit('state', this.getState());
  }

  // ---- API do lobby (todas devolvem o State, menos copyInvite)
  async create({ name, map } = {}, ctx = {}) {
    if (!this.net) return this.fail('no-net');
    const signalUrl = normalizeSignal(this.prefs.signal);
    if (!signalUrl) return this.fail('no-signal');
    await this.leave();
    const you = this.remember(name);
    const zone = this.mapByZone(map)?.zone ?? this.state.map?.zone ?? 'zombie_coast';
    this.owner = ctx.tabId ?? null;
    this.signalUrl = signalUrl;
    this.setState({ phase: 'connecting', mode: 'webrtc', role: 'host', map: this.mapByZone(zone), error: null,
      signal: 'connecting' });
    this.net.command('config', { signalUrl, name: you });
    this.net.command('create', { name: you, map: zone });
    return this.getState();
  }

  async join({ code, name, signalUrl } = {}, ctx = {}) {
    if (!this.net) return this.fail('no-net');
    const room = String(code ?? '').toUpperCase().trim();
    if (!ROOM.test(room)) return this.fail('bad-code');
    const url = normalizeSignal(signalUrl) ?? normalizeSignal(this.prefs.signal);
    if (!url) return this.fail('no-signal');
    await this.leave();
    const you = this.remember(name);
    this.owner = ctx.tabId ?? null;
    this.signalUrl = url;
    this.setState({ phase: 'connecting', mode: 'webrtc', role: 'guest', room, error: null, signal: 'connecting' });
    this.net.command('config', { signalUrl: url, name: you });
    this.net.command('join', { code: room, name: you, signalUrl: url });
    return this.getState();
  }

  async connectByAddress() { return this.fail('no-udp'); }

  async leave() {
    if (this.state.mode === 'webrtc') this.net?.command('leave');
    this.owner = null;
    this.reset();
    return this.getState();
  }

  async setMap(zone) {
    const map = this.mapByZone(zone);
    if (!map || this.state.role !== 'host') return this.getState();
    this.setState({ map });
    this.net?.command('setMap', { map: zone });
    return this.getState();
  }

  async setReady(ready) {
    if (this.state.role !== 'guest') return this.getState();
    this.net?.command('setReady', { ready: !!ready });
    return this.getState();
  }

  async start() {
    if (this.state.role !== 'host' || !this.state.map || !this.state.room) return this.getState();
    this.net?.command('start', { map: this.state.map.zone });
    return this.getState();
  }

  async copyInvite() { return this.state.invite; }

  // Host iniciou (eco do servidor nos dois lados): a aba dona vai para a página do mapa, que começa sozinha.
  beginGame(zone, key = zone) {
    const map = this.mapByZone(zone);
    if (!map) return this.fail('bad-map', `Mapa desconhecido: ${zone}`);
    this.startKey = key;
    this.setState({ phase: 'starting', map, error: null });
    this.emit('navigate', { url: mapPageUrl(map.slug, this.gameUrl), map, tabId: this.owner });
    return this.getState();
  }

  // A página do mapa ligou a ponte (page.mjs) — ou não conseguiu (erro do motor no convidado).
  pageActive(role, tabId) {
    if (this.owner !== null && tabId !== undefined && tabId !== this.owner) return;
    if (this.state.phase === 'starting') this.setState({ phase: 'playing' });
    this.log(`página ativa como ${role}`);
  }
  pageError(code, message) {
    this.setState({ error: { code: String(code ?? 'engine'), message: String(message ?? '').slice(0, 300) } });
  }
}
