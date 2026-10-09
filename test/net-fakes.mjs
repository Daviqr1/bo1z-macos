// Falsos para testar a janela net no Node: relógio manual, WebSocket ligado ao StubSignal, RTCPeerConnection /
// RTCDataChannel numa "rede" em memória (oferta/resposta, trickle ICE, ICE restart, queda) e MessagePort de página.
// Fiéis no que a NetSession usa: estados de sinalização (com rollback implícito), negotiationneeded só em 'stable',
// conexão só com descrições e candidatos dos dois lados batendo, canais negociados por id.

export const flush = () => new Promise(resolve => setImmediate(resolve));

export class FakeClock {
  constructor(start = 1000) {
    this.t = start;
    this.timers = new Map();
    this.seq = 0;
    this.now = () => this.t;
    this.wall = () => 1.7e12 + this.t;
    this.setTimeout = (fn, ms) => this.#add(fn, ms, 0);
    this.setInterval = (fn, ms) => this.#add(fn, ms, Math.max(1, ms));
    this.clearTimeout = id => { this.timers.delete(id); };
    this.clearInterval = id => { this.timers.delete(id); };
  }

  #add(fn, ms, every) {
    const id = ++this.seq;
    this.timers.set(id, { id, at: this.t + Math.max(0, ms ?? 0), fn, every });
    return id;
  }

  // Avança o tempo rodando os timers em ordem, com as promessas assentando entre um e outro.
  async advance(ms) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      let next = null;
      for (const tm of this.timers.values()) {
        if (tm.at <= end && (!next || tm.at < next.at || (tm.at === next.at && tm.id < next.id))) next = tm;
      }
      if (!next) break;
      this.t = next.at;
      if (next.every) next.at += next.every; else this.timers.delete(next.id);
      next.fn();
    }
    this.t = end;
    await flush();
  }
}

// WebSocket falso ligado ao StubSignal (entrega assíncrona, como a rede).
export function fakeWebSocket(stub) {
  return class FakeWebSocket {
    static all = [];
    static refuse = false; // servidor fora do ar

    constructor(url) {
      this.url = url;
      this.readyState = 0;
      FakeWebSocket.all.push(this);
      queueMicrotask(() => {
        if (this.readyState !== 0) return;
        if (FakeWebSocket.refuse) { this.readyState = 3; this.onerror?.({}); this.onclose?.({ code: 1006 }); return; }
        this.readyState = 1;
        this.handle = stub.attach({
          // o que o servidor mandou antes de fechar ainda chega (o close vem depois, na mesma fila)
          send: text => { if (this.readyState === 1) queueMicrotask(() => this.onmessage?.({ data: text })); },
          close: () => this.#lost(1000),
        });
        this.onopen?.({});
      });
    }

    send(text) {
      if (this.readyState !== 1) throw new Error('WebSocket fechado');
      const handle = this.handle;
      queueMicrotask(() => handle.onMessage(text));
    }

    close() {
      if (this.readyState >= 2) return;
      const was = this.readyState;
      this.readyState = 3;
      if (was === 1) queueMicrotask(() => this.handle.onClose());
    }

    // Queda de rede: os dois lados veem o socket fechar.
    drop() { this.#lost(1006); }

    #lost(code) {
      if (this.readyState === 3) return;
      const was = this.readyState;
      this.readyState = 3;
      if (was === 1) queueMicrotask(() => this.handle.onClose());
      queueMicrotask(() => this.onclose?.({ code }));
    }
  };
}

const domError = (name, message) => Object.assign(new Error(message), { name });

// Rede em memória para os RTCPeerConnection falsos. latency: atraso de entrega (ms do relógio falso).
export class FakeNet {
  constructor(clock, { latency = 10 } = {}) {
    this.clock = clock;
    this.latency = latency;
    this.down = false; // queda: nada passa; PCs conectados vão para 'disconnected'
    this.relay = false; // getStats mostra o caminho por TURN
    this.lossRate = 0; // fração de mensagens perdidas nos canais sem retransmissão
    this.pcs = new Set();
    this.created = [];
    const net = this;
    let pcSeq = 0;

    class FakeDataChannel {
      constructor(pc, label, opts) {
        Object.assign(this, { pc, label, id: opts.id, negotiated: opts.negotiated === true,
          ordered: opts.ordered !== false,
          reliable: opts.maxRetransmits === undefined && opts.maxPacketLifeTime === undefined });
        this.readyState = 'connecting';
        this.bufferedAmount = 0;
        this.binaryType = 'blob';
        this.held = []; // confiável: espera a rede voltar (como o SCTP retransmitindo)
        this.sent = 0;
        this.lossTick = 0;
      }

      send(data) {
        if (this.readyState !== 'open') throw domError('InvalidStateError', 'canal não está aberto');
        let copy;
        if (typeof data === 'string') copy = data;
        else if (data instanceof ArrayBuffer) copy = data.slice(0);
        else copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        ++this.sent;
        if (!this.pc.flowing()) { if (this.reliable) this.held.push(copy); return; }
        if (!this.reliable && net.lossRate && (++this.lossTick * net.lossRate) % 1 < net.lossRate) return;
        this.#deliver(copy);
      }

      #deliver(copy) {
        const remote = this.pc.remote?.channels.get(this.id);
        net.clock.setTimeout(() => {
          if (remote?.readyState === 'open') remote.onmessage?.({ data: copy });
        }, net.latency);
      }

      flushHeld() { for (const copy of this.held.splice(0)) this.#deliver(copy); }

      open() {
        if (this.readyState !== 'connecting') return;
        this.readyState = 'open';
        this.onopen?.({});
      }

      // remote: o outro lado fechou (SCTP ABORT): evento de close aqui.
      closeFrom(remote) {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        if (remote) this.onclose?.({});
      }

      close() {
        if (this.readyState === 'closed') return;
        this.readyState = 'closed';
        this.pc.remote?.channels.get(this.id)?.closeFrom(true);
      }
    }

    this.RTCPeerConnection = class FakePeerConnection {
      constructor(config = {}) {
        this.config = config;
        this.n = ++pcSeq;
        this.signalingState = 'stable';
        this.iceConnectionState = 'new';
        this.localDescription = null;
        this.remoteDescription = null;
        this.current = { local: null, remote: null };
        this.ufrag = null;
        this.negotiatedUfrags = null;
        this.restartWanted = false;
        this.negotiated = false;
        this.channels = new Map();
        this.remoteCandidates = new Set();
        this.remote = null; // FakePeerConnection do outro lado, depois de conectar
        this.closed = false;
        this.restarts = 0;
        net.pcs.add(this);
        net.created.push(this);
      }

      getConfiguration() { return { ...this.config }; }
      setConfiguration(config) { this.config = config; }

      createDataChannel(label, opts = {}) {
        const dc = new FakeDataChannel(this, label, opts);
        this.channels.set(opts.id, dc);
        this.#maybeNegotiate();
        if (this.remote && this.iceConnectionState === 'connected') queueMicrotask(() => dc.open());
        return dc;
      }

      restartIce() { this.restartWanted = true; ++this.restarts; this.#maybeNegotiate(); }

      flowing() { return !net.down && !this.closed && this.iceConnectionState === 'connected' && !!this.remote; }

      #maybeNegotiate() {
        if (this.nnQueued) return;
        this.nnQueued = true;
        queueMicrotask(() => {
          this.nnQueued = false;
          const needed = this.restartWanted || (!this.negotiated && this.channels.size);
          if (!this.closed && this.signalingState === 'stable' && needed) this.onnegotiationneeded?.({});
        });
      }

      async setLocalDescription(desc) {
        await null;
        if (this.closed) throw domError('InvalidStateError', 'fechado');
        if (desc?.type === 'rollback') { this.#rollback(); return; }
        const type = desc?.type ?? (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer');
        if (type === 'offer') {
          if (this.signalingState !== 'stable' && this.signalingState !== 'have-local-offer')
            throw domError('InvalidStateError', type);
          if (this.restartWanted || !this.ufrag) this.#newUfrag();
          this.restartWanted = false;
          this.localDescription = { type, sdp: JSON.stringify({ pc: this.n, ufrag: this.ufrag }) };
          this.signalingState = 'have-local-offer';
        } else {
          if (this.signalingState !== 'have-remote-offer') throw domError('InvalidStateError', type);
          // ICE restart pedido do outro lado (credenciais novas na oferta): as nossas também mudam
          const remoteUfrag = JSON.parse(this.remoteDescription.sdp).ufrag;
          const before = this.current.remote && JSON.parse(this.current.remote.sdp).ufrag;
          if (!this.ufrag || this.restartWanted || (before && before !== remoteUfrag)) this.#newUfrag();
          this.restartWanted = false;
          this.localDescription = { type, sdp: JSON.stringify({ pc: this.n, ufrag: this.ufrag }) };
          this.#stable();
        }
      }

      async setRemoteDescription(desc) {
        await null;
        if (this.closed) throw domError('InvalidStateError', 'fechado');
        JSON.parse(desc.sdp);
        if (desc.type === 'offer') {
          if (this.signalingState === 'have-local-offer') this.#rollback(); // rollback implícito (lado polite)
          if (this.signalingState !== 'stable') throw domError('InvalidStateError', 'oferta fora de stable');
          this.remoteDescription = desc;
          this.signalingState = 'have-remote-offer';
        } else if (desc.type === 'answer') {
          if (this.signalingState !== 'have-local-offer')
            throw domError('InvalidStateError', 'resposta fora de have-local-offer');
          this.remoteDescription = desc;
          this.#stable();
        }
      }

      async addIceCandidate(candidate) {
        await null;
        if (!this.remoteDescription) throw domError('InvalidStateError', 'sem descrição remota');
        this.remoteCandidates.add(candidate.usernameFragment);
        net.check();
      }

      async getStats() {
        const type = net.relay ? 'relay' : 'host';
        return new Map([
          ['T', { id: 'T', type: 'transport', selectedCandidatePairId: 'P' }],
          ['P', { id: 'P', type: 'candidate-pair', localCandidateId: 'L', remoteCandidateId: 'R', state: 'succeeded',
            nominated: true }],
          ['L', { id: 'L', type: 'local-candidate', candidateType: type, protocol: 'udp' }],
          ['R', { id: 'R', type: 'remote-candidate', candidateType: 'host', protocol: 'udp' }],
        ]);
      }

      close() {
        if (this.closed) return;
        this.closed = true;
        this.signalingState = 'closed';
        this.iceConnectionState = 'closed';
        for (const dc of this.channels.values()) dc.close();
        net.pcs.delete(this);
      }

      #newUfrag() {
        this.ufrag = `u${this.n}-${Math.random().toString(36).slice(2, 8)}`;
        const ufrag = this.ufrag;
        // trickle: um candidato por credencial, pouco depois
        net.clock.setTimeout(() => {
          if (this.closed || this.ufrag !== ufrag) return;
          this.onicecandidate?.({ candidate: { candidate: `candidate:${this.n} 1 udp 1 10.0.0.${this.n} 5000 typ host`,
            sdpMid: '0', sdpMLineIndex: 0, usernameFragment: ufrag } });
          this.onicecandidate?.({ candidate: null });
        }, 1);
      }

      #rollback() {
        this.signalingState = 'stable';
        this.localDescription = this.current.local;
        this.remoteDescription = this.current.remote;
        if (this.current.local) this.ufrag = JSON.parse(this.current.local.sdp).ufrag;
      }

      #stable() {
        this.signalingState = 'stable';
        this.current = { local: this.localDescription, remote: this.remoteDescription };
        this.negotiated = true;
        net.check();
        this.#maybeNegotiate();
      }

      setIce(state) {
        if (this.iceConnectionState === state) return;
        this.iceConnectionState = state;
        this.oniceconnectionstatechange?.({});
      }
    };
  }

  // Conecta os pares cujas descrições e candidatos batem (e reconecta depois de um ICE restart).
  check() {
    if (this.down) return;
    for (const a of this.pcs) {
      if (a.signalingState !== 'stable' || !a.current.remote) continue;
      const info = JSON.parse(a.current.remote.sdp);
      const b = [...this.pcs].find(pc => pc.n === info.pc);
      if (!b || b.signalingState !== 'stable' || !b.current.remote) continue;
      const back = JSON.parse(b.current.remote.sdp);
      if (back.pc !== a.n || back.ufrag !== a.ufrag || info.ufrag !== b.ufrag) continue;
      if (!a.remoteCandidates.has(b.ufrag) || !b.remoteCandidates.has(a.ufrag)) continue;
      if (a.iceConnectionState === 'connected' && a.remote === b) continue;
      if (a.stale === a.ufrag || b.stale === b.ufrag) continue; // depois de uma queda, só volta com ICE restart
      for (const pc of [a, b]) {
        pc.remote = pc === a ? b : a;
        if (pc.iceConnectionState === 'new') pc.setIce('checking');
      }
      this.clock.setTimeout(() => {
        for (const pc of [a, b]) {
          if (pc.closed) continue;
          pc.setIce('connected');
          for (const dc of pc.channels.values()) { dc.open(); dc.flushHeld(); }
        }
      }, this.latency);
    }
  }

  setDown(down) {
    this.down = down;
    if (down) {
      for (const pc of this.pcs) {
        if (pc.iceConnectionState === 'connected') { pc.stale = pc.ufrag; pc.setIce('disconnected'); }
      }
    } else this.check();
  }
}

// MessagePort da página do jogo: guarda o que a rede manda; page(m) simula a página mandando.
export class FakePort {
  constructor() { this.sent = []; this.onmessage = null; this.closed = false; }
  postMessage(m) { if (this.closed) throw new Error('port fechado'); this.sent.push(m); }
  start() {}
  close() { this.closed = true; }
  page(m) { this.onmessage?.({ data: m }); }
  of(t) { return this.sent.filter(m => m.t === t); }
}
