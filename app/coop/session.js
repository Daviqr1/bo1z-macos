// Sessão de co-op no processo principal: o estado da sala (docs/COOP-ARCH.md §3), a janela oculta "net" (WebRTC +
// sinalização, §4/§5), o modo "por IP" (UDP direto, udp.js), a ligação de cada página do jogo ao transporte (§1), os
// links bo1z:// e a ida de todo mundo para o mapa quando o host inicia.
// As APIs do Electron entram por injeção (deps), para a lógica rodar nos testes sem Electron.
'use strict';
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const udp = require('./udp.js');

// Mapas do vel.gg (MAP_LIST de https://vel.gg/bo1z/maps.js); refreshMaps() atualiza a partir do site.
const DEFAULT_MAPS = [
  { zone: 'zombie_pentagon', slug: 'five', name: 'Five' },
  { zone: 'zombie_theater', slug: 'kino', name: 'Kino der Toten' },
  { zone: 'zombie_cod5_factory', slug: 'riese', name: 'Der Riese' },
  { zone: 'zombie_cod5_prototype', slug: 'nacht', name: 'Nacht der Untoten' },
  { zone: 'zombie_cod5_asylum', slug: 'verruckt', name: 'Verrückt' },
  { zone: 'zombie_cod5_sumpf', slug: 'shinonuma', name: 'Shi No Numa' },
  { zone: 'zombie_cosmodrome', slug: 'ascension', name: 'Ascension' },
  { zone: 'zombie_coast', slug: 'cotd', name: 'Call of the Dead' },
  { zone: 'zombie_temple', slug: 'shangrila', name: 'Shangri-La' },
  { zone: 'zombie_moon', slug: 'moon', name: 'Moon' },
];

// Lê as entradas { zone, slug, name } do texto do maps.js do site (sem executar o arquivo).
function parseMapList(text) {
  const list = [];
  for (const m of text.matchAll(/\{\s*zone:\s*'([a-z0-9_]+)',\s*slug:\s*'([a-z0-9_-]+)',\s*name:\s*'([^']{1,40})'/g))
    list.push({ zone: m[1], slug: m[2], name: m[3] });
  return list;
}

const cleanName = name => String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
const ROOM = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/; // código das salas do servidor de convite
const UDP_CODE = /^[A-Z0-9]{3,12}$/; // modo por IP: código escolhido pelo host
const PHASES_WITH_GAME = new Set(['starting', 'playing']);

// bo1z://join/<código>?s=<host da sinalização> | bo1z://ip/<endereço:porta>/<código>
function parseLink(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'bo1z:') return null;
  const parts = (u.hostname + u.pathname).split('/').filter(Boolean);
  if (parts[0] === 'join' && ROOM.test((parts[1] ?? '').toUpperCase())) {
    const s = u.searchParams.get('s');
    const signal = s && /^[a-z0-9.-]+(:\d+)?$/i.test(s) ? `https://${s}` : null;
    return { kind: 'join', code: parts[1].toUpperCase(), signal };
  }
  if (parts[0] === 'ip' && parts[1] && UDP_CODE.test((parts[2] ?? '').toUpperCase()))
    return { kind: 'ip', address: decodeURIComponent(parts[1]), code: parts[2].toUpperCase() };
  return null;
}

class CoopSession extends EventEmitter {
  // deps: { BrowserWindow, MessageChannelMain, clipboard, ipcMain, fetchText(url) }
  constructor({ deps, appDir, log = () => {}, prefsFile, signalUrl = '', gameUrl, env = process.env, udpPort = 27960 }) {
    super();
    Object.assign(this, { deps, appDir, log, prefsFile, signalUrl, gameUrl, udpPort });
    this.maps = DEFAULT_MAPS;
    this.prefs = this.loadPrefs();
    this.state = this.blankState();
    this.net = null; // janela oculta (WebRTC)
    this.transport = null; // CoopHost/CoopGuest (modo por IP)
    this.unbind = null;
    this.legacy = null;
    this.pageWatch = new WeakSet();
    // Modo antigo por variável de ambiente (scripts de teste): sala UDP já aberta, co-op em toda página de mapa.
    if (env.BO1Z_COOP === 'host' || env.BO1Z_COOP === 'guest') {
      this.legacy = { role: env.BO1Z_COOP, guestStart: env.BO1Z_COOP_START || 'shadow' };
      const name = cleanName(env.BO1Z_COOP_NAME) || this.prefs.name;
      this.connectByAddress({ role: env.BO1Z_COOP, address: env.BO1Z_COOP_HOST || '', code: env.BO1Z_COOP_CODE || '', name,
        bind: env.BO1Z_COOP_BIND, port: Number(env.BO1Z_COOP_PORT) || udpPort }).catch(error => this.log('sessão', error.message));
    }
    if (deps.ipcMain) {
      deps.ipcMain.on('bo1z:net-state', (event, s) => { if (this.net && event.sender === this.net.webContents) this.onNetState(s); });
    }
  }

  blankState() {
    return { phase: 'idle', mode: null, role: null, room: null, invite: null, you: null, map: null, peers: [],
      signal: this.signalUrl ? 'n/a' : 'n/a', error: null };
  }

  loadPrefs() {
    try { return { name: os.userInfo().username.slice(0, 24), ...JSON.parse(fs.readFileSync(this.prefsFile, 'utf8')) }; }
    catch { return { name: (() => { try { return os.userInfo().username.slice(0, 24); } catch { return 'Jogador'; } })() }; }
  }
  savePrefs() {
    if (!this.prefsFile) return;
    try { fs.mkdirSync(path.dirname(this.prefsFile), { recursive: true }); fs.writeFileSync(this.prefsFile, JSON.stringify(this.prefs, null, 2)); }
    catch (error) { this.log('sessão', `prefs: ${error.message}`); }
  }

  get role() { return this.state.role; }
  get mode() { return this.state.mode; }
  // O motor da página atual deve rodar como host/convidado do co-op?
  gameRole() {
    if (this.legacy) return this.legacy.role;
    return PHASES_WITH_GAME.has(this.state.phase) ? this.state.role : null;
  }
  guestStart() { return this.legacy?.guestStart ?? 'shadow'; }
  mapByZone(zone) { return this.maps.find(m => m.zone === zone) ?? null; }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.getState());
  }
  getState() { return JSON.parse(JSON.stringify({ ...this.state, maps: this.maps, name: this.prefs.name })); }
  fail(code, message) { this.setState({ phase: 'error', error: { code, message } }); return this.getState(); }

  async refreshMaps() {
    if (!this.deps.fetchText) return;
    try {
      const list = parseMapList(await this.deps.fetchText(new URL('maps.js', this.gameUrl).href));
      if (list.length) { this.maps = list; this.emit('state', this.getState()); }
    } catch (error) { this.log('sessão', `maps.js: ${error.message}`); }
  }

  remember(name) {
    const clean = cleanName(name);
    if (clean && clean !== this.prefs.name) { this.prefs.name = clean; this.savePrefs(); }
    return clean || this.prefs.name || 'Jogador';
  }

  // ---- janela net (WebRTC) ----
  ensureNet() {
    if (this.net && !this.net.isDestroyed()) return this.net;
    const { BrowserWindow } = this.deps;
    this.net = new BrowserWindow({ show: false, width: 200, height: 200, webPreferences: {
      preload: path.join(this.appDir, 'net', 'net-preload.js'), backgroundThrottling: false, spellcheck: false } });
    this.netReady = new Promise(resolve => this.net.webContents.once('did-finish-load', resolve));
    this.net.loadFile(path.join(this.appDir, 'net', 'net.html'));
    this.net.on('closed', () => { this.net = null; });
    return this.net;
  }
  async netCmd(cmd, args = {}) {
    const win = this.ensureNet();
    await this.netReady;
    win.webContents.send('bo1z:net-cmd', { cmd, args });
  }
  onNetState(s) {
    if (!s || typeof s !== 'object') return;
    const patch = {};
    for (const key of ['phase', 'role', 'room', 'invite', 'you', 'peers', 'signal', 'error']) if (key in s) patch[key] = s[key];
    // a rede não sabe de "starting/playing": quem decide é a navegação daqui
    if (PHASES_WITH_GAME.has(this.state.phase) && (patch.phase === 'lobby' || patch.phase === 'connecting')) delete patch.phase;
    if (s.lobbyMap) patch.map = this.mapByZone(s.lobbyMap) ?? this.state.map;
    this.setState({ mode: 'webrtc', ...patch });
    if (s.startMap && s.startMap !== this.startedMap) this.beginGame(s.startMap);
    if (s.phase === 'idle' && this.state.mode === 'webrtc') this.setState({ ...this.blankState() });
  }

  // ---- API do lobby (§3) ----
  async create({ name, map } = {}) {
    if (!this.signalUrl) return this.fail('no-signal', 'Servidor de convite não configurado (coop.signal no config.json). Use "Conectar por IP".');
    await this.leave();
    const you = this.remember(name);
    const zone = this.mapByZone(map)?.zone ?? this.state.map?.zone ?? 'zombie_coast';
    this.setState({ phase: 'connecting', mode: 'webrtc', role: 'host', map: this.mapByZone(zone), error: null, signal: 'connecting' });
    await this.netCmd('config', { signalUrl: this.signalUrl, name: you });
    await this.netCmd('create', { name: you, map: zone });
    return this.getState();
  }

  async join({ code, name, signalUrl } = {}) {
    const room = String(code ?? '').toUpperCase().trim();
    if (!ROOM.test(room)) return this.fail('bad-code', 'Código de sala inválido (5 letras/números).');
    const url = signalUrl || this.signalUrl;
    if (!url) return this.fail('no-signal', 'Servidor de convite não configurado. Use "Conectar por IP".');
    await this.leave();
    const you = this.remember(name);
    this.setState({ phase: 'connecting', mode: 'webrtc', role: 'guest', room, error: null, signal: 'connecting' });
    await this.netCmd('config', { signalUrl: url, name: you });
    await this.netCmd('join', { code: room, name: you });
    return this.getState();
  }

  // Modo "por IP": UDP direto (rede de casa/Tailscale). Host abre a porta; convidado conecta em address.
  async connectByAddress({ role = 'guest', address = '', code = '', name, bind, port } = {}) {
    if (!this.legacy) await this.leave();
    const you = this.remember(name);
    if (role === 'host') {
      const room = UDP_CODE.test(String(code).toUpperCase()) ? String(code).toUpperCase() : udp.roomCode();
      const t = new udp.CoopHost({ port: port ?? this.udpPort, bind: bind || '0.0.0.0', maxGuests: 3, code: room, log: this.log });
      this.transport = t;
      this.setState({ phase: 'connecting', mode: 'udp', role: 'host', room, you: { id: 'host', name: you }, error: null, signal: 'n/a',
        map: this.state.map ?? this.mapByZone('zombie_coast'), peers: [] });
      try { await t.start(); } catch (error) { this.transport = null; return this.fail('udp-port', `Não abriu a porta UDP ${t.port}: ${error.message}`); }
      const addr = udp.inviteAddresses ? udp.inviteAddresses(t.port) : [];
      this.setState({ phase: 'lobby', invite: `${addr[0] ? addr[0].replace(/ \(Tailscale\)$/, '') : `?:${t.port}`} · código ${room}` });
      t.on('join', (id, info) => {
        this.setState({ peers: [...this.state.peers.filter(p => p.id !== id), { id, name: info.name || 'convidado', role: 'guest', ready: false, ping: null, link: 'lan', loss: null }] });
        t.sendCtl({ t: 'lobby', map: this.state.map?.zone, hostName: you }, id);
      });
      t.on('leave', id => this.setState({ peers: this.state.peers.filter(p => p.id !== id) }));
      t.on('ctl', (id, m) => { if (m.t === 'ready') this.setState({ peers: this.state.peers.map(p => p.id === id ? { ...p, ready: !!m.ready } : p) }); });
    } else {
      if (!address) return this.fail('bad-address', 'Informe o endereço do host (IP:porta).');
      const t = new udp.CoopGuest({ host: address, code: String(code).toUpperCase(), name: you, log: this.log });
      this.transport = t;
      this.setState({ phase: 'connecting', mode: 'udp', role: 'guest', room: String(code).toUpperCase() || null, you: { id: 'me', name: you },
        error: null, signal: 'n/a', peers: [] });
      t.on('welcome', () => this.setState({ phase: this.legacy ? 'playing' : 'lobby',
        peers: [{ id: 'host', name: this.hostName || 'host', role: 'host', ready: true, ping: null, link: 'lan', loss: null }] }));
      t.on('reject', reason => this.fail('rejected', `Recusado pelo host: ${reason}`));
      t.on('lost', reason => this.setState({ peers: this.state.peers.map(p => ({ ...p, link: 'lost' })), error: { code: 'lost', message: `Conexão perdida: ${reason}` } }));
      t.on('ctl', m => {
        if (m.t === 'lobby') {
          this.hostName = cleanName(m.hostName) || this.hostName;
          this.setState({ map: this.mapByZone(m.map) ?? this.state.map,
            peers: this.state.peers.map(p => p.id === 'host' ? { ...p, name: this.hostName || 'host' } : p) });
        }
        else if (m.t === 'start') this.beginGame(m.map);
      });
      t.start();
    }
    this.pingTimer = setInterval(() => this.refreshUdpStats(), 1000);
    return this.getState();
  }

  refreshUdpStats() {
    const t = this.transport;
    if (!t) return;
    const s = t.stats();
    if (this.state.role === 'host') {
      const rtt = new Map(s.peers.map(p => [p.id, p.rtt]));
      this.setState({ peers: this.state.peers.map(p => ({ ...p, ping: rtt.get(p.id) ?? p.ping })) });
    } else this.setState({ peers: this.state.peers.map(p => ({ ...p, ping: s.rtt ?? p.ping, link: s.welcomed ? 'lan' : 'lost' })) });
  }

  async leave() {
    clearInterval(this.pingTimer);
    this.unbind?.(); this.unbind = null;
    if (this.transport) { this.transport.close(); this.transport = null; }
    if (this.state.mode === 'webrtc' && this.net) await this.netCmd('leave');
    this.startedMap = null;
    this.setState(this.blankState());
    return this.getState();
  }

  async setMap(zone) {
    const map = this.mapByZone(zone);
    if (!map || this.state.role !== 'host') return this.getState();
    this.setState({ map });
    if (this.state.mode === 'webrtc') await this.netCmd('setMap', { map: zone });
    else this.transport?.sendCtl?.({ t: 'lobby', map: zone, hostName: this.prefs.name });
    return this.getState();
  }

  async setReady(ready) {
    if (this.state.role !== 'guest') return this.getState();
    if (this.state.mode === 'webrtc') await this.netCmd('setReady', { ready: !!ready });
    else this.transport?.sendCtl?.({ t: 'ready', ready: !!ready });
    this.setState({ peers: this.state.peers, ready: !!ready });
    return this.getState();
  }

  async start() {
    if (this.state.role !== 'host' || !this.state.map) return this.getState();
    const zone = this.state.map.zone;
    if (this.state.mode === 'webrtc') await this.netCmd('start', { map: zone });
    else { this.transport?.sendCtl?.({ t: 'start', map: zone }); this.beginGame(zone); }
    return this.getState();
  }

  async copyInvite() {
    const text = this.state.invite;
    if (text) this.deps.clipboard?.writeText(text);
    return text;
  }

  // Host iniciou: todos vão para a página do mapa (início automático; no convidado, estratégia shadow + G1).
  beginGame(zone) {
    const map = this.mapByZone(zone);
    if (!map) return this.fail('bad-map', `Mapa desconhecido: ${zone}`);
    this.startedMap = zone;
    this.setState({ phase: 'starting', map });
    this.emit('navigate', { url: new URL(map.slug, this.gameUrl).href, map });
  }

  // A página do mapa ativou a ponte (page.mjs).
  pageActive(role) {
    if (this.state.phase === 'starting' || this.legacy) this.setState({ phase: 'playing' });
    this.log('sessão', `página ativa como ${role}`);
  }

  // Página do jogo pediu o port de pacotes (bo1z:coop-hello).
  attachPage(webContents) {
    const { MessageChannelMain } = this.deps;
    const { port1, port2 } = new MessageChannelMain();
    webContents.postMessage('bo1z:coop-port', null, [port2]);
    if (this.state.mode === 'webrtc' && this.net) {
      this.net.webContents.postMessage('bo1z:net-port', null, [port1]);
    } else if (this.transport) {
      this.unbind?.();
      this.currentPort?.close();
      this.currentPort = port1;
      this.unbind = udp.bindPage(this.transport, this.state.role, port1, handler => port1.on('message', e => handler(e.data)), this.log);
      port1.start();
    } else port1.close();
    if (!this.pageWatch.has(webContents)) {
      this.pageWatch.add(webContents);
      webContents.once('destroyed', () => { if (this.transport) { this.unbind?.(); this.unbind = null; } });
    }
  }

  async handleLink(url) {
    const link = parseLink(url);
    if (!link) return false;
    if (link.kind === 'join') await this.join({ code: link.code, name: this.prefs.name, signalUrl: link.signal });
    else await this.connectByAddress({ role: 'guest', address: link.address, code: link.code, name: this.prefs.name });
    return true;
  }

  close() {
    clearInterval(this.pingTimer);
    this.transport?.close();
    if (this.net && !this.net.isDestroyed()) this.net.destroy();
  }
}

module.exports = { CoopSession, parseLink, parseMapList, DEFAULT_MAPS };
