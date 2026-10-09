// Enlace WebRTC com um par (COOP-ARCH §5). Topologia estrela: o convidado (initiator) cria a oferta; o host responde.
//
// - DataChannels negociados: 'game' (id 0, sem ordem, sem retransmissão: semântica UDP, o netchan do motor cuida do
//   resto) e 'ctl' (id 1, confiável): ping/pong a cada 1 s (RTT), contadores para a perda e avisos do host.
// - Perfect negotiation: o convidado é o "impolite" (insiste na oferta dele numa colisão); o host é "polite" e só
//   oferece depois da primeira negociação (ICE restart). Sinais trazem "gen": um RTCPeerConnection novo do
//   convidado (gen + 1) faz o host trocar o dele.
// - ICE restart quando o iceConnectionState fica 'disconnected' > 3 s ou 'failed'. O convidado ainda troca o
//   RTCPeerConnection inteiro se nada voltar em 20 s (o restart sozinho não basta quando a associação SCTP morreu).
// - Perda do par: 15 s sem pong no ctl => 'lost'. Pong de novo => 'up'.
// - Congestionamento: game.bufferedAmount > 64 KiB descarta o pacote (nunca enfileira indefinidamente).
//
// Eventos: 'up' (enlace no ar pela primeira vez ou de volta depois de 'lost'), 'lost', 'change' (link/ping/perda),
// 'ctl' (mensagem de controle que não é do próprio enlace). Pacotes do jogo: callback onPacket(Uint8Array).
import { Emitter, isPlainObject, realClock } from './util.mjs';

export const MAX_PACKET = 1264;
export const MAX_BUFFERED = 64 * 1024;
const MAX_CTL = 4096;

export const PEER_DEFAULTS = Object.freeze({
  pingMs: 1000, // ping no ctl
  lostMs: 15000, // sem pong por isso => par perdido
  aliveMs: 5000, // pong mais velho que isso: mostra 'connecting' e ping null (está engasgando)
  disconnectedMs: 3000, // 'disconnected' por mais que isso => ICE restart
  restartGapMs: 10000, // intervalo mínimo entre ICE restarts seguidos
  resetMs: 20000, // convidado: sem pong por isso => RTCPeerConnection novo
  statsMs: 2000, // getStats (tipo do caminho) e contadores de perda
  probeMs: 250, // sondas no game (texto, fora do protocolo do motor) para medir a perda mesmo sem jogo rodando
});

export class PeerLink extends Emitter {
  constructor({ id, initiator, iceServers = [], RTCPeerConnection, clock = realClock, log = () => {}, sendSignal,
    options = {} }) {
    super();
    Object.assign(this, { id, initiator, iceServers, RTC: RTCPeerConnection, clock, log, sendSignal });
    this.opt = { ...PEER_DEFAULTS, ...options };
    this.polite = !initiator;
    this.gen = 0;
    this.pc = null;
    this.game = null;
    this.ctl = null;
    this.closed = false;
    this.everUp = false;
    this.lost = false;
    this.lastPong = null;
    this.rtt = null; // média móvel (ms)
    this.rttLast = null;
    this.linkType = null; // 'direct' | 'relay' (getStats)
    this.path = null;
    this.onPacket = null;
    this.pingSeq = 0;
    this.lastRestart = -Infinity;
    this.badIceSince = null;
    this.lastReset = -Infinity;
    // Perda: contamos tudo o que passa no game (pacotes + sondas); o par manda os dele no ctl a cada statsMs.
    this.gameTx = 0;
    this.gameRx = 0;
    this.lossWindow = [];
    this.lossDown = null; // par -> nós
    this.lossUp = null; // nós -> par (calculada do lado de lá)
    this.counters = { rx: 0, tx: 0, rxBytes: 0, txBytes: 0, dropped: 0, congested: 0, restarts: 0, resets: 0 };
    this.signalQueue = Promise.resolve(); // sinais em ordem: setRemoteDescription é assíncrono
    this.timers = [
      clock.setInterval(() => this.#tick(), this.opt.pingMs),
      clock.setInterval(() => this.#stats(), this.opt.statsMs),
      clock.setInterval(() => this.#probe(), this.opt.probeMs),
    ];
    if (initiator) this.#newPc(1);
  }

  // Estado visível (§3: link e ping do par).
  get link() {
    if (this.lost) return 'lost';
    if (this.#alive() && this.linkType) return this.linkType;
    return 'connecting';
  }

  get ping() { return this.#alive() && this.rtt !== null ? Math.round(this.rtt) : null; }

  // Perda em % (0–100, uma casa), o pior dos dois sentidos; null sem amostras suficientes.
  get loss() {
    const values = [this.lossDown, this.lossUp].filter(x => typeof x === 'number');
    return values.length ? Math.round(Math.max(...values) * 1000) / 10 : null;
  }

  get open() { return this.ctl?.readyState === 'open'; }

  // Pong recente: o enlace está passando dados agora.
  #alive() { return this.open && this.lastPong !== null && this.clock.now() - this.lastPong <= this.opt.aliveMs; }
  get alive() { return this.#alive(); }

  // Pacote do motor para o par. false = descartado (canal fechado ou congestionado).
  send(bytes) {
    const game = this.game;
    if (!game || game.readyState !== 'open') { ++this.counters.dropped; return false; }
    if (game.bufferedAmount > MAX_BUFFERED) { ++this.counters.dropped; ++this.counters.congested; return false; }
    try { game.send(bytes); } catch { ++this.counters.dropped; return false; }
    ++this.gameTx; ++this.counters.tx; this.counters.txBytes += bytes.length;
    return true;
  }

  sendCtl(msg) {
    if (!this.open) return false;
    try { this.ctl.send(JSON.stringify(msg)); return true; } catch { return false; }
  }

  // Sinal recebido do par pela sinalização ({ sdp } ou { candidate }, com gen).
  signal(data) {
    this.signalQueue = this.signalQueue.then(() => this.#onSignal(data))
      .catch(error => this.log(`sinal ignorado: ${error.message}`));
    return this.signalQueue;
  }

  setIceServers(iceServers) {
    this.iceServers = iceServers;
    try { this.pc?.setConfiguration({ ...this.pc.getConfiguration(), iceServers }); } catch (error) {
      this.log(`setConfiguration: ${error.message}`);
    }
  }

  restartIce(why) {
    const pc = this.pc;
    if (!pc || this.closed || (!this.initiator && !pc.remoteDescription)) return false;
    if (this.clock.now() - this.lastRestart < this.opt.restartGapMs) return false;
    this.lastRestart = this.clock.now();
    ++this.counters.restarts;
    this.log(`ICE restart (${why})`);
    pc.restartIce();
    return true;
  }

  // Convidado: RTCPeerConnection novo (gen + 1); o host troca o dele quando a oferta chegar.
  reset(why) {
    if (this.closed || !this.initiator) return;
    this.lastReset = this.clock.now();
    ++this.counters.resets;
    this.log(`RTCPeerConnection novo (${why})`);
    this.#newPc(this.gen + 1);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const t of this.timers) this.clock.clearInterval(t);
    this.clock.clearTimeout(this.discTimer);
    this.#closePc();
  }

  stats() {
    return { id: this.id, gen: this.gen, link: this.link, rtt: this.rtt === null ? null : +this.rtt.toFixed(1),
      loss: this.loss, ice: this.pc?.iceConnectionState ?? null, path: this.path, ...this.counters };
  }

  #closePc() {
    const { pc, game, ctl } = this;
    this.pc = this.game = this.ctl = null;
    for (const dc of [game, ctl]) if (dc) { dc.onopen = dc.onclose = dc.onmessage = null; try { dc.close(); } catch {} }
    if (pc) {
      pc.onnegotiationneeded = pc.onicecandidate = pc.oniceconnectionstatechange = null;
      try { pc.close(); } catch {}
    }
  }

  #newPc(gen) {
    this.#closePc();
    this.gen = gen;
    this.genStart = this.clock.now();
    this.makingOffer = false;
    this.ignoreOffer = false;
    this.badIceSince = null;
    this.linkType = null;
    const pc = new this.RTC({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
    const game = pc.createDataChannel('game', { negotiated: true, id: 0, ordered: false, maxRetransmits: 0 });
    const ctl = pc.createDataChannel('ctl', { negotiated: true, id: 1 });
    Object.assign(this, { pc, game, ctl });
    const mine = () => this.pc === pc; // eventos de um RTCPeerConnection antigo ficam mudos
    game.binaryType = ctl.binaryType = 'arraybuffer';
    pc.onnegotiationneeded = () => { if (mine()) this.#negotiate(pc); };
    pc.onicecandidate = ({ candidate }) => {
      if (mine() && candidate) this.sendSignal({ candidate: candidate.toJSON?.() ?? candidate, gen });
    };
    pc.oniceconnectionstatechange = () => { if (mine()) this.#iceState(pc.iceConnectionState); };
    ctl.onopen = () => { if (mine()) this.#opened(); };
    ctl.onclose = () => { if (mine()) this.#channelClosed('ctl'); };
    game.onclose = () => { if (mine()) this.#channelClosed('game'); };
    ctl.onmessage = event => { if (mine()) this.#onCtl(event.data); };
    game.onmessage = event => { if (mine()) this.#onGame(event.data); };
    this.emit('change');
  }

  async #negotiate(pc) {
    if (!this.initiator && !pc.remoteDescription) return; // a primeira oferta é sempre do convidado
    try {
      this.makingOffer = true;
      await pc.setLocalDescription();
      if (this.pc !== pc) return;
      const { type, sdp } = pc.localDescription;
      this.sendSignal({ sdp: { type, sdp }, gen: this.gen });
    } catch (error) {
      this.log(`oferta falhou: ${error.message}`);
    } finally {
      if (this.pc === pc) this.makingOffer = false;
    }
  }

  async #onSignal(data) {
    if (this.closed || !isPlainObject(data)) return;
    const gen = Number.isSafeInteger(data.gen) && data.gen > 0 ? data.gen : 1;
    if (gen < this.gen) return; // de um RTCPeerConnection que já foi trocado
    if (gen > this.gen) {
      if (this.initiator) return; // só o convidado inaugura geração
      this.log(`geração ${gen} do convidado (era ${this.gen})`);
      this.#newPc(gen);
    }
    const pc = this.pc;
    if (isPlainObject(data.sdp)) {
      const { type, sdp } = data.sdp;
      if ((type !== 'offer' && type !== 'answer') || typeof sdp !== 'string') return;
      const collision = type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) { this.log('oferta do host ignorada (colisão; a do convidado vale)'); return; }
      if (type === 'answer' && pc.signalingState !== 'have-local-offer') return; // resposta atrasada
      await pc.setRemoteDescription({ type, sdp }); // polite numa colisão: rollback implícito
      if (this.pc !== pc || type !== 'offer') return;
      await pc.setLocalDescription();
      if (this.pc !== pc) return;
      this.sendSignal({ sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp }, gen });
    } else if (isPlainObject(data.candidate)) {
      try { await pc.addIceCandidate(data.candidate); } catch (error) {
        if (!this.ignoreOffer) this.log(`candidato recusado: ${error.message}`);
      }
    }
  }

  #iceState(state) {
    this.clock.clearTimeout(this.discTimer);
    this.emit('change');
    if (state === 'connected' || state === 'completed') { this.badIceSince = null; this.#stats(); return; }
    if (state !== 'disconnected' && state !== 'failed') return;
    this.badIceSince ??= this.clock.now();
    if (state === 'failed') this.restartIce('failed');
    else {
      const pc = this.pc;
      this.discTimer = this.clock.setTimeout(() => {
        if (this.pc === pc && pc.iceConnectionState === 'disconnected') this.restartIce('disconnected > 3 s');
      }, this.opt.disconnectedMs);
    }
  }

  // Canais abertos: o enlace está de pé (o ping já sai, para medir o RTT logo).
  #opened() {
    this.log(`canais abertos (gen ${this.gen})`);
    this.lastPong = this.clock.now(); // conta a janela de perda a partir daqui
    this.#markUp();
    this.#ping();
    this.#stats();
  }

  #markUp() {
    if (!this.everUp) { this.everUp = true; this.lost = false; this.emit('up'); }
    else if (this.lost) { this.lost = false; this.log('par de volta'); this.emit('up'); }
    this.emit('change');
  }

  #channelClosed(which) {
    this.log(`canal ${which} fechou (gen ${this.gen})`);
    this.emit('change');
    // Associação SCTP morta não volta com ICE restart: o convidado refaz o RTCPeerConnection (com intervalo mínimo).
    if (this.initiator && !this.closed && this.clock.now() - this.lastReset > 5000) this.reset(`canal ${which} fechou`);
  }

  #onGame(data) {
    ++this.gameRx;
    if (typeof data === 'string') return; // sonda de perda
    const size = data?.byteLength ?? 0;
    if (!size || size > MAX_PACKET) { ++this.counters.dropped; return; }
    ++this.counters.rx; this.counters.rxBytes += size;
    this.onPacket?.(new Uint8Array(data));
  }

  #onCtl(data) {
    if (typeof data !== 'string' || data.length > MAX_CTL) return;
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (!isPlainObject(m)) return;
    if (m.t === 'ping') { if (Number.isFinite(m.ts)) this.sendCtl({ t: 'pong', n: m.n, ts: m.ts }); return; }
    if (m.t === 'pong') { this.#pong(m); return; }
    if (m.t === 'cnt') { this.#counts(m); return; }
    this.emit('ctl', m);
  }

  #pong(m) {
    const sample = this.clock.now() - m.ts;
    if (!Number.isFinite(sample) || sample < 0 || sample > 60000) return;
    const before = this.ping;
    this.rttLast = sample;
    this.rtt = this.rtt === null || !this.#alive() ? sample : this.rtt * 0.8 + sample * 0.2;
    this.lastPong = this.clock.now();
    if (this.lost || !this.everUp) this.#markUp();
    else if (this.ping !== before) this.emit('change');
  }

  // Contadores do par: quanto ele mandou no game (para a nossa perda de recepção) e a perda que ele mediu (a nossa
  // de envio). Janela de ~10 s; precisa de pelo menos 8 mensagens para valer.
  #counts(m) {
    if (!Number.isSafeInteger(m.tx) || m.tx < 0) return;
    const w = this.lossWindow;
    w.push({ tx: m.tx, rx: this.gameRx });
    if (w.length > 6) w.shift();
    const sent = w.at(-1).tx - w[0].tx, got = w.at(-1).rx - w[0].rx;
    const before = this.loss;
    if (sent < 0) this.lossWindow = [w.at(-1)]; // o par recomeçou a contagem
    else if (sent >= 8) this.lossDown = Math.min(1, Math.max(0, 1 - got / sent));
    if (typeof m.loss === 'number' && m.loss >= 0 && m.loss <= 1) this.lossUp = m.loss;
    if (this.loss !== before) this.emit('change');
  }

  #ping() { this.sendCtl({ t: 'ping', n: ++this.pingSeq, ts: this.clock.now() }); }

  #probe() {
    const game = this.game;
    if (game?.readyState !== 'open' || game.bufferedAmount > MAX_BUFFERED) return;
    try { game.send('p'); ++this.gameTx; } catch { /* fechando */ }
  }

  #tick() {
    if (this.closed) return;
    const now = this.clock.now();
    if (this.open) this.#ping();
    if (this.everUp && !this.lost && now - this.lastPong > this.opt.lostMs) {
      this.lost = true;
      this.log(`par perdido (${Math.round((now - this.lastPong) / 1000)} s sem pong)`);
      this.emit('lost');
    }
    const ice = this.pc?.iceConnectionState;
    if ((ice === 'disconnected' || ice === 'failed') && now - (this.badIceSince ?? now) >= this.opt.disconnectedMs)
      this.restartIce(`ICE ainda ${ice}`);
    if (this.initiator && now - Math.max(this.lastPong ?? -Infinity, this.genStart) > this.opt.resetMs)
      this.reset(`${Math.round(this.opt.resetMs / 1000)} s sem resposta`);
    this.emit('change'); // ping/link envelhecem com o tempo
  }

  async #stats() {
    if (this.open) this.sendCtl({ t: 'cnt', tx: this.gameTx, rx: this.gameRx, loss: this.lossDown });
    const pc = this.pc;
    const ice = pc?.iceConnectionState;
    if (!pc?.getStats || (ice !== 'connected' && ice !== 'completed')) return;
    let report;
    try { report = await pc.getStats(); } catch { return; }
    if (this.pc !== pc) return;
    const all = new Map();
    report.forEach(s => all.set(s.id, s));
    let pair = null;
    for (const s of all.values()) {
      if (s.type === 'transport' && s.selectedCandidatePairId) pair = all.get(s.selectedCandidatePairId);
    }
    if (!pair) for (const s of all.values()) {
      if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) pair = s;
    }
    if (!pair) return;
    const local = all.get(pair.localCandidateId), remote = all.get(pair.remoteCandidateId);
    const type = local?.candidateType === 'relay' || remote?.candidateType === 'relay' ? 'relay' : 'direct';
    const describe = c => !c ? '?'
      : `${c.candidateType}/${c.protocol ?? '?'}${c.relayProtocol ? '/' + c.relayProtocol : ''}`;
    const path = `${describe(local)} -> ${describe(remote)}`;
    if (type !== this.linkType || path !== this.path) {
      this.log(`caminho ${type}: ${path}`);
      this.linkType = type;
      this.path = path;
      this.emit('change');
    }
  }
}
