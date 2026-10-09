// Lobby do co-op (docs/COOP-ARCH.md §3/§6): a parte pura, sem DOM. Textos em pt-BR, ping e barras, selos de conexão,
// validação do que o jogador digita, lista do grupo e escolha do mapa. lobby.mjs só desenha o que sai daqui; os testes
// (test/lobby.test.mjs) rodam isto no Node.

export const MAX_PLAYERS = 4;
export const ROOM_LEN = 5;
export const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // sem 0 O 1 I L (o servidor gera só destas)
export const UDP_PORT = 27960;
const ROOM = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{5}$/;
const IP_CODE = /^[A-Z0-9]{3,12}$/; // modo por IP: código escolhido pelo host (udp.js/session.js)
const IN_ROOM = new Set(['connecting', 'lobby', 'starting', 'playing']);

// Última reserva se nem o maps.js do site nem o State trouxerem a lista (mesma de app/coop/session.js).
export const DEFAULT_MAPS = Object.freeze([
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
].map(Object.freeze));

// Texto que veio da rede ou do teclado: sem caracteres de controle, sem espaços nas pontas, tamanho limitado.
export const cleanText = (text, max = 24) =>
  String(text ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, max);

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// ---- estado

export const inRoom = state => IN_ROOM.has(state?.phase);
// Há sala para mostrar (inclusive um erro no meio dela, como "sala cheia" depois de pedir para entrar).
export const hasRoom = state => inRoom(state) || (state?.phase === 'error' && !!state.role);

// Qual tela do painel: o estado manda (erro, sala); fora de sala, a tela que o jogador abriu (início, código, IP).
export function viewFor(state, uiView = 'home') {
  if (state?.phase === 'error') return 'error';
  if (inRoom(state)) return 'room';
  return ['home', 'join', 'ip'].includes(uiView) ? uiView : 'home';
}

// O painel abre sozinho quando uma sala aparece (convite aberto pelo link, entrada pelo bo1z://) ou já existe ao montar.
export const autoOpen = (prev, next) => !hasRoom(prev) && hasRoom(next);

// Convidado pronto: a janela net manda em you.ready; o modo por IP (session.js) guarda no topo do State.
export const guestReady = state => !!(state?.you?.ready ?? state?.ready);

// ---- mapas

export function normalizeMaps(list) {
  if (!Array.isArray(list)) return [];
  const out = [], seen = new Set();
  for (const m of list) {
    if (!m || typeof m !== 'object') continue;
    const zone = String(m.zone ?? ''), slug = String(m.slug ?? ''), name = cleanText(m.name, 40);
    if (!/^[a-z0-9_]{1,40}$/.test(zone) || !/^[a-z0-9_-]{1,40}$/.test(slug) || !name || seen.has(zone)) continue;
    seen.add(zone);
    out.push({ zone, slug, name });
  }
  return out;
}

// MAP_LIST do site (import do maps.js) > lista do State (o main também lê o maps.js) > lista embutida.
export function pickMapList(siteList, stateMaps) {
  for (const list of [siteList, stateMaps]) {
    const maps = normalizeMaps(list);
    if (maps.length) return maps;
  }
  return DEFAULT_MAPS.map(m => ({ ...m }));
}

export const findMap = (maps, key) => (key && maps?.find(m => m.zone === key || m.slug === key)) || null;

// Próximo/anterior na lista (dá a volta). Mapa desconhecido: começa do primeiro.
export function cycleMap(maps, key, delta) {
  if (!maps?.length) return null;
  const at = maps.findIndex(m => m.zone === key || m.slug === key);
  if (at < 0) return maps[0];
  return maps[((at + delta) % maps.length + maps.length) % maps.length];
}

// Mapa inicial ao criar sala: o da sala (se houver), senão o que está selecionado na lista nativa, senão o primeiro.
export const initialMap = (maps, { stateMap, landingPick } = {}) =>
  findMap(maps, stateMap?.zone) ?? findMap(maps, landingPick) ?? maps?.[0] ?? null;

// Arte do próprio site, por URL (nada copiado para o repositório): o lado direito do menu de mapas nativo, e a tela de
// carregamento como reserva.
export function mapArt(map, base) {
  if (!map || !/^[a-z0-9_-]+$/.test(map.slug ?? '')) return null;
  return {
    panel: new URL(`art/mapselect-panel-${map.slug}.webp`, base).href,
    loadscreen: /^[a-z0-9_]+$/.test(map.zone ?? '') ? new URL(`art/loadscreen_${map.zone}.webp`, base).href : null,
  };
}

// ---- ping, qualidade e selo

// 4 barras até 60 ms, 3 até 120, 2 até 200, 1 acima; perda de pacotes tira barra (3%: uma, 10%: duas).
export function pingBars(ping, { loss = null, link = null } = {}) {
  if (link === 'lost' || typeof ping !== 'number' || !Number.isFinite(ping) || ping < 0) return 0;
  let bars = ping <= 60 ? 4 : ping <= 120 ? 3 : ping <= 200 ? 2 : 1;
  if (typeof loss === 'number' && Number.isFinite(loss)) bars -= loss >= 10 ? 2 : loss >= 3 ? 1 : 0;
  return Math.max(1, bars);
}

export function pingText(ping) {
  if (typeof ping !== 'number' || !Number.isFinite(ping) || ping < 0) return '—';
  if (ping < 1) return '<1 ms';
  return ping >= 999 ? '999+ ms' : `${Math.round(ping)} ms`;
}

const TONE = ['none', 'bad', 'ok', 'good', 'good'];
const LABEL = ['—', 'RUIM', 'INSTÁVEL', 'BOA', 'ÓTIMA'];
export function quality(ping, { loss = null, link = null } = {}) {
  const bars = pingBars(ping, { loss, link });
  return { bars, tone: link === 'lost' ? 'bad' : TONE[bars], label: link === 'lost' ? 'CAIU' : LABEL[bars] };
}

const BADGES = {
  direct: { text: 'DIRETO', tone: 'good', title: 'Conexão direta entre vocês (P2P): a de menor latência.' },
  relay: { text: 'RELAY', tone: 'warn',
    title: 'Passando por um servidor de retransmissão (TURN): funciona, com um pouco mais de latência.' },
  lan: { text: 'LAN', tone: 'good', title: 'Modo por IP: rede de casa ou Tailscale.' },
  connecting: { text: 'CONECTANDO', tone: 'wait', title: 'Abrindo a conexão…' },
  lost: { text: 'CAIU', tone: 'bad', title: 'Sem resposta: a conexão caiu.' },
};
export const linkBadge = link => BADGES[link] ?? null;

// ---- validação do que o jogador digita

export function validateName(text) {
  const name = cleanText(text, 24);
  if (!name) return { ok: false, error: 'Digite seu nome (até 24 letras).' };
  return { ok: true, name };
}

// Como o nome aparece no placar do motor (mesma regra do main-coop.js: ASCII simples, até 15).
export const gameName = name => cleanText(name).replace(/[^A-Za-z0-9_.\- ]/g, '').trim().slice(0, 15) || 'Player';

// Aceita o código puro ou o link de convite inteiro (https://<servidor>/j/<código>, bo1z://join/<código>).
export function validateCode(text) {
  let raw = String(text ?? '').trim();
  const link = /(?:\/j\/|join\/)([A-Za-z0-9]+)(?:[/?#]|$)/i.exec(raw);
  if (link) raw = link[1];
  const code = raw.toUpperCase().replace(/[\s-]/g, '');
  if (!code) return { ok: false, error: 'Digite o código da sala (5 letras ou números).' };
  if (/[^A-Z0-9]/.test(code)) return { ok: false, error: 'O código só tem letras e números.' };
  if (code.length !== ROOM_LEN) {
    return { ok: false, error: `O código tem ${ROOM_LEN} caracteres (você digitou ${code.length}).` };
  }
  if (!ROOM.test(code)) return { ok: false, error: 'Os códigos não usam 0, O, 1, I nem L: confira com quem mandou.' };
  return { ok: true, code };
}

// Convite do modo por IP, como o host vê ("100.64.1.2:27960 · código ZUMBI") ou como link (bo1z://ip/<end>/<código>).
export function parseIpInvite(text) {
  const s = String(text ?? '').trim();
  const link = /^bo1z:\/\/ip\/([^/\s]+)\/([A-Za-z0-9]{3,12})\/?$/i.exec(s);
  if (link) {
    let address = link[1];
    try { address = decodeURIComponent(address); } catch { /* fica como veio */ }
    return { address, code: link[2].toUpperCase() };
  }
  const m = /^(\S+?)\s*[·|,;]?\s*c[óo]digo\s*:?\s*([A-Za-z0-9]{3,12})$/i.exec(s);
  return m ? { address: m[1], code: m[2].toUpperCase() } : null;
}

const isIPv4 = s => {
  const parts = s.split('.');
  return parts.length === 4 && parts.every(x => /^\d{1,3}$/.test(x) && Number(x) <= 255);
};

// IP (ou nome, como o do Tailscale) com porta opcional; sem porta, a padrão do modo por IP.
export function validateAddress(text) {
  const s = String(text ?? '').trim();
  if (!s) return { ok: false, error: 'Digite o IP do host (ex.: 100.64.1.2 ou 192.168.0.10).' };
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([A-Za-z0-9.-]+))(?::(\d{1,5}))?$/.exec(s);
  if (!m) return { ok: false, error: 'Endereço inválido. Use IP ou IP:porta (ex.: 192.168.0.10:27960).' };
  const host = m[1] ?? m[2], port = m[3] === undefined ? UDP_PORT : Number(m[3]);
  if (!m[1] && (/^[.-]|[.-]$|\.\./.test(host) || (/^[\d.]+$/.test(host) && !isIPv4(host))))
    return { ok: false, error: 'Endereço inválido. Confira os números do IP.' };
  if (port < 1 || port > 65535) return { ok: false, error: `Porta inválida (1 a 65535; a padrão é ${UDP_PORT}).` };
  return { ok: true, address: m[1] ? `[${host}]:${port}` : `${host}:${port}` };
}

// Código do modo por IP: o host pode deixar vazio (o app sorteia); o convidado precisa do código do host.
export function validateIpCode(text, role) {
  const code = String(text ?? '').trim().toUpperCase().replace(/[\s-]/g, '');
  if (!code) return role === 'host' ? { ok: true, code: '' } : { ok: false, error: 'Digite o código que o host passou.' };
  if (!IP_CODE.test(code)) return { ok: false, error: 'O código tem de 3 a 12 letras/números.' };
  return { ok: true, code };
}

// ---- erros e estado em texto

// Códigos de session.js (no-signal, bad-code, udp-port, bad-address, rejected, lost, bad-map), da janela net (config,
// code, offline, no-map, closed…) e do servidor de convite (§2: room-not-found, room-full, version…).
const ERRORS = {
  'no-signal': { title: 'SEM SERVIDOR DE CONVITE', suggest: 'ip',
    text: 'Este app não tem um servidor de convite configurado, então salas por link não funcionam.',
    hint: 'Dá para jogar pelo modo POR IP: na mesma rede de casa (ou com o Tailscale, de casas diferentes), um ' +
      'escolhe HOSPEDAR e passa o IP e o código; o outro escolhe ENTRAR e digita os dois.' },
  'room-full': { title: 'SALA CHEIA', text: 'A sala já tem 4 jogadores, o máximo.',
    hint: 'Peça para alguém sair ou crie outra sala.', suggest: 'home' },
  'room-not-found': { title: 'CÓDIGO ERRADO', text: 'Não existe sala com esse código (ou ela já foi fechada).',
    hint: 'Confira as 5 letras ou peça um convite novo ao host.', suggest: 'join' },
  'host-left': { title: 'O HOST SAIU', text: 'O host saiu e a sala foi fechada.',
    hint: 'Quando ele criar outra sala, entre pelo convite novo.', suggest: 'home' },
  'kicked': { title: 'REMOVIDO DA SALA', text: 'O host removeu você da sala.', suggest: 'home' },
  'expired': { title: 'SALA EXPIRADA', text: 'A sala ficou vazia tempo demais e foi fechada.', hint: 'Crie outra sala.',
    suggest: 'home' },
  'offline': { title: 'SERVIDOR FORA DO AR', text: 'Sem conexão com o servidor de convite; tentando de novo…',
    hint: 'Se não voltar, use CONECTAR POR IP.', suggest: 'ip' },
  'version': { title: 'VERSÕES DIFERENTES', text: 'O app de vocês está em versões diferentes.',
    hint: 'Atualizem o app e tentem de novo.', suggest: 'home' },
  'udp-port': { title: 'PORTA UDP OCUPADA', text: null, suggest: 'ip',
    hint: 'Feche o outro programa que usa a porta ou troque "coop.port" no config.json.' },
  'bad-address': { title: 'ENDEREÇO INVÁLIDO', text: 'Informe o IP do host, ex.: 100.64.1.2:27960.', suggest: 'ip' },
  'rate': { title: 'DEVAGAR', text: 'Mensagens demais para o servidor de convite.',
    hint: 'Espere alguns segundos e tente de novo.', suggest: 'home' },
  'forbidden': { title: 'NÃO PERMITIDO', text: 'O servidor recusou esta ação.', suggest: 'home' },
  'name': { title: 'NOME INVÁLIDO', text: 'Escolha outro nome (até 24 letras).', suggest: 'home' },
  'no-map': { title: 'SEM MAPA', text: 'Escolha um mapa antes de iniciar.', suggest: 'home' },
  'bad-map': { title: 'MAPA DESCONHECIDO', text: null, suggest: 'home' },
};
const ALIASES = { 'bad-code': 'room-not-found', 'code': 'room-not-found', 'config': 'no-signal', 'closed': 'host-left' };

// { title, text, hint, suggest } — suggest = tela que resolve ('ip', 'join', 'home'). A mensagem de quem gerou o erro
// (session.js, janela net, servidor) só aparece quando não há texto próprio para o código.
export function errorText(error) {
  if (!error) return null;
  let code = ALIASES[error.code] ?? String(error.code ?? '');
  const message = cleanText(error.message, 300);
  if (code === 'rejected') { // modo por IP: o host recusou (udp.js manda o motivo em texto)
    if (/cheia/i.test(message)) code = 'room-full';
    else if (/vers[ãa]o/i.test(message)) code = 'version';
    else if (/c[óo]digo/i.test(message)) {
      return { title: 'CÓDIGO ERRADO', text: 'O host recusou: o código da sala não confere.',
        hint: 'Confira o código que o host passou.', suggest: 'ip' };
    } else return { title: 'RECUSADO PELO HOST', text: message || 'O host recusou a entrada.', hint: null, suggest: 'ip' };
  }
  if (code === 'lost') { // modo por IP: 'host saiu' (BYE) ou 'sem resposta do host' (10 s sem nada)
    if (/host saiu/i.test(message)) code = 'host-left';
    else return { title: 'CONEXÃO PERDIDA', text: 'O host parou de responder.',
      hint: 'Confira a internet (ou o Tailscale) dos dois e entre de novo.', suggest: 'home' };
  }
  if (code === 'room-not-found' && /inv[áa]lido/i.test(message)) {
    return { title: 'CÓDIGO INVÁLIDO', text: 'Esse código não tem o formato certo (5 letras/números).',
      hint: 'Os códigos não usam 0, O, 1, I nem L.', suggest: 'join' };
  }
  const known = ERRORS[code];
  if (known) {
    return { title: known.title, text: known.text ?? (message || known.title), hint: known.hint ?? null,
      suggest: known.suggest };
  }
  return { title: 'ALGO DEU ERRADO', text: message || `Erro: ${code || 'desconhecido'}`, hint: null, suggest: 'home' };
}

// Linha de estado do painel, por fase e papel.
export function statusText(state) {
  const phase = state?.phase ?? 'idle', role = state?.role, udp = state?.mode === 'udp', mapName = state?.map?.name;
  if (phase === 'error') return errorText(state.error)?.text ?? 'Algo deu errado.';
  if (phase === 'idle' || !role) return 'Crie uma sala e mande o convite, ou entre com o código que você recebeu.';
  if (phase === 'connecting') {
    if (role === 'host') return udp ? 'Abrindo a sala na porta UDP…' : 'Criando a sala no servidor de convite…';
    if (udp) return 'Procurando o host…';
    return state.room ? `Entrando na sala ${cleanText(state.room, 12)}…` : 'Entrando na sala…';
  }
  if (phase === 'starting') return `Iniciando ${mapName ?? 'a partida'}…`;
  if (phase === 'playing') return `Partida em andamento${mapName ? ` em ${mapName}` : ''}.`;
  const guests = (state.peers ?? []).filter(p => p?.role === 'guest' && p.link !== 'lost');
  if (role === 'host') {
    if (!guests.length) return 'Sala aberta. Copie o convite e mande para os amigos.';
    const waiting = guests.filter(p => !p.ready).length;
    if (!waiting) return guests.length === 1 ? 'Seu amigo está pronto. Pode iniciar!' : 'Todos prontos. Pode iniciar!';
    return `Aguardando ${plural(waiting, 'convidado', 'convidados')} marcar PRONTO.`;
  }
  const host = (state.peers ?? []).find(p => p?.role === 'host');
  if (host?.link === 'lost') return 'Sem resposta do host…';
  return guestReady(state) ? 'Você está pronto. Aguardando o host iniciar.'
    : 'Marque PRONTO. O host escolhe o mapa e inicia a partida.';
}

// Selo à direita do item JOGAR COM AMIGOS na tela de mapas.
export function itemStatus(state) {
  if (state?.phase === 'error') return { text: 'ERRO NA SALA', tone: 'bad' };
  if (!inRoom(state)) return null;
  if (state.phase === 'connecting') return { text: 'CONECTANDO…', tone: 'wait' };
  if (state.phase === 'starting' || state.phase === 'playing') return { text: 'EM PARTIDA', tone: 'good' };
  const count = Math.min(MAX_PLAYERS, 1 + (state.peers ?? []).filter(p => p && p.id !== state.you?.id).length);
  const room = cleanText(state.room, 12);
  return { text: `${room ? `SALA ${room}` : 'NA SALA'} · ${count}/${MAX_PLAYERS}`, tone: 'good' };
}

// ---- grupo

function peerRow(p) {
  const host = p.role === 'host';
  return { id: String(p.id ?? ''), name: cleanText(p.name) || (host ? 'Host' : 'Convidado'), role: host ? 'host' : 'guest',
    ready: host || !!p.ready, ping: typeof p.ping === 'number' ? p.ping : null,
    link: typeof p.link === 'string' ? p.link : null, loss: typeof p.loss === 'number' ? p.loss : null, you: false };
}

// Linhas do grupo: host primeiro, depois os convidados (você marcado), completando até 4 com vagas livres. O seu ping
// não aparece na sua linha: no convidado ele é o da linha do host (topologia estrela). Quem caiu fica sem ping (o
// último medido enganaria).
export function partyRows(state, max = MAX_PLAYERS) {
  if (!state?.role) return [];
  const youId = state.you?.id ?? null;
  const me = { id: youId ?? 'voce', name: cleanText(state.you?.name) || cleanText(state.name) || 'Você', role: state.role,
    ready: state.role === 'host' || guestReady(state), ping: null, link: null, loss: null, you: true };
  const peers = (Array.isArray(state.peers) ? state.peers : [])
    .filter(p => p && typeof p === 'object' && (youId === null || p.id !== youId)).map(peerRow);
  const host = state.role === 'host' ? me : peers.find(p => p.role === 'host');
  const guests = [...(state.role === 'guest' ? [me] : []), ...peers.filter(p => p !== host && p.role === 'guest')];
  const rows = [host, ...guests].filter(Boolean).slice(0, max).map(p => ({ ...p, host: p.role === 'host',
    bars: p.you ? null : pingBars(p.ping, p),
    pingLabel: p.you ? '' : p.link === 'lost' ? '—' : pingText(p.ping),
    badge: p.you ? null : linkBadge(p.link) }));
  while (rows.length < max) rows.push({ empty: true, id: `vaga-${rows.length}` });
  return rows;
}

// Quem sumiu da lista entre dois estados (aviso "fulano saiu" na página do mapa).
export function departed(prev, next) {
  if (!prev?.peers?.length || !hasRoom(next)) return [];
  const now = new Set((next.peers ?? []).map(p => p?.id));
  return prev.peers.filter(p => p && !now.has(p.id)).map(p => cleanText(p.name) || 'Um jogador');
}

// INICIAR PARTIDA (host): 'go' com todos os convidados prontos; 'confirm' (pede confirmação) sozinho ou com alguém
// ainda não pronto — ready diz se o botão aparece aceso (há convidado pronto); 'off' fora do lobby.
export function startAction(state) {
  const off = { mode: 'off', ready: false, confirm: null };
  if (state?.role !== 'host' || !state.map || !['lobby', 'playing'].includes(state.phase)) return off;
  const guests = (state.peers ?? []).filter(p => p?.role === 'guest' && p.link !== 'lost');
  const ready = guests.filter(p => p.ready).length;
  if (!guests.length) {
    return { mode: 'confirm', ready: false, confirm: { title: 'INICIAR SOZINHO?',
      text: 'Ninguém entrou na sala ainda. Quem chegar depois do início não entra nesta partida.' } };
  }
  if (ready < guests.length) {
    const missing = plural(guests.length - ready, 'convidado ainda não marcou', 'convidados ainda não marcaram');
    return { mode: 'confirm', ready: ready > 0, confirm: { title: 'INICIAR ASSIM MESMO?',
      text: `${missing} PRONTO. Todos da sala vão para o mapa.` } };
  }
  return { mode: 'go', ready: true, confirm: null };
}

export function inviteInfo(state) {
  if (!hasRoom(state)) return null;
  const code = cleanText(state.room, 12) || null, invite = cleanText(state.invite, 300) || null;
  return { code, invite, kind: state.mode === 'udp' ? 'ip' : 'link' };
}

// ---- página do mapa: indicador de ping no canto e avisos

const NOTICE_LOST_HOST = { tone: 'bad', title: 'A CONEXÃO COM O HOST CAIU',
  text: 'Sem resposta do host. Se não voltar em alguns segundos, volte ao menu de mapas e entre de novo.' };
const NOTICE_CONNECTING = { tone: 'wait', title: 'CONECTANDO AO HOST…',
  text: 'O mapa carrega normalmente; você entra no jogo do host assim que ele responder.' };

export function indicator(state) {
  if (!hasRoom(state)) return { show: false, rows: [], notice: null };
  const rows = partyRows(state).filter(r => !r.empty && !r.you).map(r => ({ id: r.id, name: r.name, host: r.host,
    ping: r.pingLabel, bars: r.bars, badge: r.badge, tone: quality(r.ping, r).tone, lost: r.link === 'lost' }));
  let notice = null;
  const guest = state.role === 'guest';
  // erro explícito (o host saiu, sala fechada) vem antes do enlace caído: diz o porquê
  if (state.phase === 'error' || (guest && state.error)) {
    const e = errorText(state.error);
    notice = { tone: 'bad', title: e?.title ?? 'ERRO', text: e?.text ?? '' };
  } else if (guest && rows.find(r => r.host)?.lost) notice = NOTICE_LOST_HOST;
  else if (guest && state.phase !== 'playing') notice = NOTICE_CONNECTING;
  else if (state.role === 'host') {
    const lost = rows.filter(r => r.lost).map(r => r.name.toUpperCase());
    if (lost.length) {
      notice = { tone: 'bad', title: `${lost.join(', ')} ${lost.length === 1 ? 'CAIU' : 'CAÍRAM'}`,
        text: 'A conexão parou de responder. A partida continua para quem ficou.' };
    }
  }
  const worst = rows.reduce((w, r) => (w === null || (r.bars ?? 0) < (w.bars ?? 0) ? r : w), null);
  return { show: true, title: state.room ? `CO-OP · ${cleanText(state.room, 12)}` : 'CO-OP', rows, worst, notice };
}
