// Lobby do co-op no mundo da página do vel.gg (docs/COOP-ARCH.md §3/§6). Servido pelo main em
// https://vel.gg/__bo1z/lobby/lobby.mjs; o preload chama mountLobby({ api: window.__bo1zLobby, document, location }).
// Tela de mapas: o item JOGAR COM AMIGOS no estilo das linhas nativas e o painel da sala (grupo à esquerda, mapa à
// direita, ações embaixo). Página do mapa: indicador de ping num canto e avisos de conexão.
// Regra de segurança: texto que vem da rede ou do teclado (nomes, códigos, convite, mensagens) só entra por
// textContent (nós de texto); nada de HTML montado em string.
import * as core from './lobby-core.mjs';

export * from './lobby-core.mjs';

// Geometria da arte nativa (1920x1080, landing.js): linhas de 450x40 a cada 42 px a partir de x=352; o HELL MODE fica
// em y=889. O item entra uma linha acima dele; o painel cobre a caixa do MISSION SELECT, como uma tela do próprio menu.
const ITEM = { x: 352, y: 847, w: 450, h: 40 };
const PANEL = { x: 310, y: 105, w: 1300, h: 866 };
const FONTS = 'https://fonts.googleapis.com/css2?family=Roboto+Condensed:wght@400;500;700&family=Michroma&display=swap';
const FACES = ['500 20px "Roboto Condensed"', '400 20px Michroma'];
const COPIED_MS = 2200;
const mounted = new WeakMap(); // document -> handle (o preload pode chamar de novo)

const pct = (value, total) => `${(value / total * 100).toFixed(3)}%`;
const rect = r => `--x:${pct(r.x, 1920)};--y:${pct(r.y, 1080)};--w:${pct(r.w, 1920)};--h:${pct(r.h, 1080)}`;
// Mensagem de erro de uma chamada (o IPC do Electron embrulha: "Error invoking remote method '…': Error: …").
const callError = error => core.cleanText(String(error?.message ?? error ?? '')
  .replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/, ''), 200);

// Criação de elementos sem HTML em texto: filhos string viram nós de texto.
function maker(doc) {
  return function h(tag, props = {}, ...children) {
    const el = doc.createElement(tag);
    for (const [key, value] of Object.entries(props ?? {})) {
      if (value === null || value === undefined || value === false) continue;
      if (key === 'class') el.className = value;
      else if (key === 'style') el.style.cssText = value;
      else if (key === 'dataset') {
        for (const [k, v] of Object.entries(value)) if (v !== null && v !== undefined) el.dataset[k] = v;
      } else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
      else if (key === 'value' || key === 'maxLength' || key === 'hidden') el[key] = value;
      else el.setAttribute(key, value === true ? '' : String(value));
    }
    for (const child of children.flat(Infinity)) {
      if (child !== null && child !== undefined && child !== false) el.append(child);
    }
    return el;
  };
}

// CSS do lobby (mesma pasta deste módulo) e, só na tela de mapas, as fontes (Google Fonts carrega sob o COEP
// require-corp do vel.gg; sem rede, fica a pilha local do lobby.css). Resolve quando tudo chegou, ou em 2,5 s.
function addStyles(doc, { fonts }) {
  const head = doc.head ?? doc.documentElement;
  const sheet = (id, href, extra = {}) => {
    let link = doc.getElementById(id);
    if (!link) head.append(link = Object.assign(doc.createElement('link'), { id, rel: 'stylesheet', href, ...extra }));
    return link;
  };
  const loaded = link => new Promise(resolve => {
    if (link.sheet) return resolve();
    link.addEventListener('load', resolve, { once: true });
    link.addEventListener('error', resolve, { once: true });
  });
  const css = loaded(sheet('bo1z-lobby-css', new URL('./lobby.css', import.meta.url).href));
  // sem as fontes o item apareceria por um instante com outra letra (e "pularia" quando elas chegassem)
  const faces = fonts ? loaded(sheet('bo1z-lobby-fonts', FONTS, { crossOrigin: 'anonymous' }))
    .then(() => Promise.all(FACES.map(face => doc.fonts?.load(face).catch(() => null)))) : null;
  return Promise.race([Promise.all([css, faces]), new Promise(resolve => setTimeout(resolve, 2500))]);
}

// Barras de ping (4, como no lobby do jogo), coloridas pela qualidade.
function barsEl(h, bars, tone, label) {
  return h('span', { class: 'bz-bars', dataset: { bars: String(bars ?? 0), tone: tone ?? 'none' }, role: 'img',
    'aria-label': label }, h('i'), h('i'), h('i'), h('i'));
}

function badgeEl(h, badge) {
  return badge ? h('span', { class: 'bz-badge', dataset: { tone: badge.tone }, title: badge.title }, badge.text) : null;
}

export function mountLobby({ api, document: doc = globalThis.document, location: loc = globalThis.location } = {}) {
  if (!api || typeof api.getState !== 'function' || typeof api.onState !== 'function') return null;
  if (!doc?.documentElement) return null;
  if (mounted.has(doc)) return mounted.get(doc);
  const isMapPage = !!doc.documentElement.dataset?.map || !!doc.getElementById('game');
  const stage = isMapPage ? null : doc.querySelector('.stage');
  const handle = isMapPage ? mountHud({ api, doc }) : stage ? mountMenu({ api, doc, loc, stage }) : null;
  if (handle) mounted.set(doc, handle);
  return handle;
}

// Assina o estado do main (onState pode devolver a função de cancelar ou uma Promise dela).
async function subscribe(api, onState) {
  let off = null;
  try { off = await api.onState(onState); } catch { /* sem push: fica o getState inicial */ }
  try { onState(await api.getState()); } catch { /* main sem sessão: lobby fica parado */ }
  return () => { try { if (typeof off === 'function') off(); } catch { /* já cancelado */ } };
}

// =====================================================================================================================
// Tela de mapas: item JOGAR COM AMIGOS + painel da sala

function mountMenu({ api, doc, loc, stage }) {
  const h = maker(doc);
  const base = doc.baseURI || loc?.href;
  let state = { phase: 'idle', peers: [] }, siteMaps = null, maps = core.pickMapList(null, null), destroyed = false;
  const ui = { open: false, view: 'home', busy: null, formError: null, confirm: null, toast: null, copiedUntil: 0,
    mapZone: null, form: { name: '', code: '', address: '', ipCode: '', ipRole: 'guest' }, nameTouched: false };
  const ready = addStyles(doc, { fonts: true });

  // MAP_LIST do site por import dinâmico. A query separa este módulo do maps.js que o play.js importa depois de uma
  // escolha na própria página (ele fixa o mapa no import, pelo <html data-map>; não podemos importá-lo antes dele).
  import(new URL('maps.js?bo1z-lobby', base).href)
    .then(m => { siteMaps = m.MAP_LIST; maps = core.pickMapList(siteMaps, state.maps); render(); })
    .catch(() => { /* fica a lista do State */ });

  // ---- esqueleto
  const layer = h('div', { id: 'bo1z-lobby', class: 'bz-layer', dataset: { loading: '' } });
  const itemBadge = h('span', { class: 'bz-item-badge' });
  const item = h('button', { id: 'bo1z-coop-item', class: 'bz-item', type: 'button', style: rect(ITEM),
    'aria-haspopup': 'dialog', 'aria-label': 'Jogar com amigos: criar ou entrar numa sala de co-op', onclick: () => open() },
  h('span', { class: 'bz-item-label' }, 'JOGAR COM AMIGOS'), itemBadge);
  const titleEl = h('h2', { class: 'bz-title', id: 'bz-title' }, 'JOGAR COM AMIGOS');
  const headInfo = h('div', { class: 'bz-head-info' });
  const left = h('div', { class: 'bz-col bz-left' });
  const right = h('div', { class: 'bz-col bz-right' });
  const statusEl = h('p', { class: 'bz-status', role: 'status', 'aria-live': 'polite' });
  const keysEl = h('div', { class: 'bz-keys', 'aria-hidden': 'true' });
  const confirmEl = h('div', { class: 'bz-confirm', hidden: true, role: 'alertdialog', 'aria-modal': 'true' });
  const panel = h('section', { class: 'bz-panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bz-title',
    style: rect(PANEL) },
  h('header', { class: 'bz-head' }, titleEl, headInfo),
  h('div', { class: 'bz-body' }, left, right),
  h('footer', { class: 'bz-foot' }, statusEl, keysEl),
  confirmEl);
  const backdrop = h('div', { class: 'bz-backdrop', hidden: true,
    onmousedown: event => { if (event.target === backdrop) close(); } }, panel);
  layer.append(item, backdrop);
  stage.append(layer);
  ready.then(() => delete layer.dataset.loading);

  // ---- seções que se atualizam sozinhas: só refazem o DOM quando a assinatura muda. O ping muda a cada segundo, mas
  // as linhas de ação não são refeitas por isso, então um clique nunca cai no meio de uma troca de elementos.
  const slots = new Map();
  function patch(key, parent, sig, build) {
    let slot = slots.get(key);
    if (!slot) slots.set(key, slot = { parent, el: h('div', { class: `bz-slot bz-slot-${key}` }), sig: null });
    if (slot.el.parentNode !== parent) parent.append(slot.el);
    if (slot.sig === sig) return;
    const focused = slot.el.contains(doc.activeElement) ? doc.activeElement : null;
    const caret = focused?.tagName === 'INPUT' ? [focused.selectionStart, focused.selectionEnd] : null;
    slot.sig = sig;
    slot.el.replaceChildren(...[build()].flat(Infinity).filter(Boolean));
    // o foco volta para o elemento equivalente da versão nova (mesma chave de navegação)
    const again = focused?.dataset?.nav && slot.el.querySelector(`[data-nav="${CSS.escape(focused.dataset.nav)}"]`);
    if (!again) return;
    again.focus({ preventScroll: true });
    if (caret) try { again.setSelectionRange(...caret); } catch { /* campo sem seleção */ }
  }
  // Tira da coluna o que não pertence à tela atual.
  function useSlots(parent, keys) {
    for (const [key, slot] of slots) {
      if (slot.parent === parent && !keys.includes(key)) { slot.el.remove(); slots.delete(key); }
    }
  }

  // ---- peças do menu
  // Linha de ação no estilo das linhas nativas (faixa escura; com foco, faixa branca e texto preto).
  function row(nav, label, action, { hint = null, dim = false, busy = false, cls = '' } = {}) {
    return h('button', { type: 'button', class: `bz-row ${cls}`.trim(), dataset: { nav, dim: dim ? '' : null },
      'aria-busy': busy ? 'true' : null, onclick: event => { event.preventDefault(); if (!ui.busy) action(event); } },
    h('span', { class: 'bz-row-label' }, label), hint ? h('span', { class: 'bz-row-hint' }, hint) : null);
  }
  // Seletor ◀ mapa ▶: setas do teclado ou clique nas pontas.
  function mapRow(nav, map, onCycle) {
    const name = map?.name ?? '—';
    return h('button', { type: 'button', class: 'bz-row bz-cycle', dataset: { nav, cycle: '' },
      'aria-label': `Mapa: ${name} (setas para trocar)`,
      onclick: event => { if (!ui.busy) onCycle(event.target.closest?.('[data-dir]')?.dataset.dir === 'prev' ? -1 : 1); } },
    h('span', { class: 'bz-row-label' }, 'MAPA:'),
    h('span', { class: 'bz-cycle-box' },
      h('span', { class: 'bz-arrow', dataset: { dir: 'prev' } }, '◀'),
      h('span', { class: 'bz-cycle-value' }, name.toUpperCase()),
      h('span', { class: 'bz-arrow', dataset: { dir: 'next' } }, '▶')));
  }
  function field(nav, label, { value, maxLength, placeholder, submit, upper = false, wide = false, note = null }) {
    const input = h('input', { class: `bz-input${wide ? ' bz-input-code' : ''}`, dataset: { nav, submit },
      value: value ?? '', maxLength, placeholder, spellcheck: 'false', autocomplete: 'off',
      autocapitalize: upper ? 'characters' : 'off', 'aria-label': label,
      oninput: event => {
        const el = event.target;
        if (upper) {
          const [a, b] = [el.selectionStart, el.selectionEnd];
          el.value = el.value.toUpperCase();
          try { el.setSelectionRange(a, b); } catch { /* campo sem seleção */ }
        }
        ui.form[nav] = el.value;
        if (nav === 'name') ui.nameTouched = true;
        if (ui.formError) { ui.formError = null; render(); }
      } });
    return h('label', { class: 'bz-field' }, h('span', { class: 'bz-field-label' }, label), input,
      note ? h('span', { class: 'bz-field-note' }, note) : null);
  }
  const para = (text, cls = '') => h('p', { class: `bz-text ${cls}`.trim() }, text);

  // Arte do lado direito do menu de mapas nativo (título, imagem e descrição do mapa); sem ela, a tela de carregamento
  // com o nome por cima; sem nenhuma, só o nome.
  function mapCard(map, { caption = null } = {}) {
    const art = core.mapArt(map, base);
    const name = h('div', { class: 'bz-art-name' }, (map?.name ?? 'Mapa').toUpperCase());
    const frame = h('div', { class: 'bz-art-frame' }, name);
    const box = h('figure', { class: 'bz-art', dataset: { fallback: art ? null : '' } }, frame,
      caption ? h('figcaption', { class: 'bz-art-caption' }, caption) : null);
    if (art) {
      const img = h('img', { class: 'bz-art-img', alt: map.name, src: art.panel, decoding: 'async', draggable: 'false' });
      img.addEventListener('error', () => {
        if (art.loadscreen && img.src !== art.loadscreen) { img.src = art.loadscreen; box.dataset.loadscreen = ''; }
        else { img.remove(); box.dataset.fallback = ''; }
      });
      frame.prepend(img);
    }
    return box;
  }
  const infoCard = (title, lines) => h('div', { class: 'bz-info' }, h('h3', { class: 'bz-info-title' }, title),
    h('ul', {}, lines.map(line => h('li', {}, line))));

  // ---- telas
  const selectedMap = () => core.findMap(maps, ui.mapZone)
    ?? core.initialMap(maps, { stateMap: state.map, landingPick: landingPick() });
  const nameValue = () => (ui.nameTouched ? ui.form.name : ui.form.name || core.cleanText(state.name));
  const optName = () => core.cleanText(nameValue()) || undefined; // vazio: o main usa o nome salvo
  const roomMap = () => (state.map ? core.findMap(maps, state.map.zone) ?? state.map : null);

  function homeView() {
    const map = selectedMap();
    useSlots(left, ['home-form']); useSlots(right, ['home-map']);
    patch('home-form', left, JSON.stringify(['home', ui.busy, ui.formError, ui.nameTouched || nameValue()]), () => [
      field('name', 'SEU NOME', { value: nameValue(), maxLength: 24, placeholder: 'Seu nome no jogo', submit: 'create',
        note: gameNameNote(nameValue()) }),
      ui.formError ? para(ui.formError, 'bz-error') : null,
      h('div', { class: 'bz-rows' },
        row('create', 'CRIAR SALA', createRoom, { busy: ui.busy === 'create', hint: 'convite por link' }),
        row('join', 'ENTRAR COM CÓDIGO', () => go('join')),
        row('ip', 'CONECTAR POR IP', () => go('ip'), { hint: 'rede de casa / Tailscale' }),
        row('close', 'VOLTAR AOS MAPAS', () => close())),
      h('ol', { class: 'bz-steps' }, [
        ['CRIE A SALA', ' e escolha o mapa ao lado.'],
        ['COPIE O CONVITE', ' e mande o link (WhatsApp, Discord…): quem abre cai direto na sala.'],
        ['INICIE A PARTIDA', ' quando os amigos marcarem PRONTO.'],
      ].map(([what, rest]) => h('li', {}, h('span', {}, h('b', {}, what), rest)))),
    ]);
    patch('home-map', right, JSON.stringify(['home', map?.zone]), () => [
      mapCard(map),
      mapRow('map', map, delta => { ui.mapZone = core.cycleMap(maps, map?.zone, delta)?.zone ?? null; render(); }),
    ]);
  }

  function joinView() {
    useSlots(left, ['join-form']); useSlots(right, ['join-info']);
    patch('join-form', left, JSON.stringify(['join', ui.busy, ui.formError]), () => [
      field('code', 'CÓDIGO DA SALA', { value: ui.form.code, maxLength: 120, placeholder: 'K7QX2', submit: 'join-go',
        wide: true, note: 'Pode colar o link do convite inteiro.' }),
      ui.formError ? para(ui.formError, 'bz-error') : null,
      h('div', { class: 'bz-rows' },
        row('join-go', 'ENTRAR NA SALA', joinRoom, { busy: ui.busy === 'join' }),
        row('back', 'VOLTAR', () => go('home'))),
    ]);
    patch('join-info', right, 'join', () => infoCard('COMO ENTRAR', [
      'Recebeu um link? Abra-o: o app abre e entra na sala sozinho.',
      'Ou digite aqui as 5 letras do código (ex.: K7QX2). Códigos não usam 0, O, 1, I nem L.',
      'O host escolhe o mapa. Marque PRONTO e espere ele iniciar.',
    ]));
  }

  function ipView() {
    const host = ui.form.ipRole === 'host';
    const flip = () => { ui.form.ipRole = host ? 'guest' : 'host'; ui.formError = null; render(); };
    useSlots(left, ['ip-form']); useSlots(right, ['ip-info']);
    patch('ip-form', left, JSON.stringify(['ip', host, ui.busy, ui.formError]), () => [
      h('div', { class: 'bz-rows' },
        row('ip-role', `PAPEL: ${host ? 'HOSPEDAR A SALA' : 'ENTRAR NA SALA'}`, flip,
          { cls: 'bz-toggle', hint: '◀ ▶' })),
      host ? null : field('address', 'IP DO HOST', { value: ui.form.address, maxLength: 80, placeholder: '100.64.1.2:27960',
        submit: 'ip-go', note: 'Pode colar o convite do host (IP e código) aqui.' }),
      field('ipCode', host ? 'CÓDIGO (OPCIONAL)' : 'CÓDIGO', { value: ui.form.ipCode, maxLength: 12, submit: 'ip-go',
        placeholder: host ? 'sorteado se vazio' : 'ZUMBI', upper: true }),
      ui.formError ? para(ui.formError, 'bz-error') : null,
      h('div', { class: 'bz-rows' },
        row('ip-go', host ? 'ABRIR SALA' : 'CONECTAR', connectIp, { busy: ui.busy === 'connectByAddress' }),
        row('back', 'VOLTAR', () => go('home'))),
    ]);
    patch('ip-info', right, JSON.stringify(['ip', host]), () => infoCard('MODO POR IP', host ? [
      'Use na mesma rede de casa ou com o Tailscale (grátis), que liga casas diferentes sem abrir porta no roteador.',
      `O app abre a porta UDP ${core.UDP_PORT} neste computador e mostra o IP e o código para você mandar.`,
      'Com o Tailscale, mande o IP 100.x dele; na mesma casa, o IP da rede local (192.168.x.x).',
    ] : [
      'Peça ao host o IP e o código que aparecem na sala dele.',
      'Mesma casa: IP da rede local (ex.: 192.168.0.10). Casas diferentes: IP 100.x do Tailscale. ' +
        `Porta padrão ${core.UDP_PORT}.`,
      'Sem servidor de convite no meio: a conexão vai direto entre os dois computadores.',
    ]));
  }

  function roomView() {
    const isHost = state.role === 'host', map = roomMap(), ready = core.guestReady(state);
    const start = core.startAction(state), invite = core.inviteInfo(state), copied = Date.now() < ui.copiedUntil;
    const rows = core.partyRows(state);
    useSlots(left, ['party', 'room-actions']); useSlots(right, ['room-map', 'room-invite']);
    patch('party', left, JSON.stringify(rows), () => [
      h('h3', { class: 'bz-label' }, 'GRUPO ',
        h('span', { class: 'bz-count' }, `${rows.filter(r => !r.empty).length}/${core.MAX_PLAYERS}`)),
      h('ol', { class: 'bz-party' }, rows.map(partyRow)),
    ]);
    const actionsSig = [state.role, state.phase, start.mode, start.ready, ready, map?.zone, !!invite?.invite, copied,
      ui.busy, ui.formError, state.error?.code ?? null, state.error?.message ?? null];
    patch('room-actions', left, JSON.stringify(actionsSig), () => [
      state.error ? errorBanner(state.error) : null,
      ui.formError ? para(ui.formError, 'bz-error') : null,
      h('div', { class: 'bz-rows' },
        isHost && start.mode !== 'off'
          ? row('start', state.phase === 'playing' ? 'INICIAR DE NOVO' : 'INICIAR PARTIDA', startGame,
            { dim: !start.ready, busy: ui.busy === 'start', hint: start.ready ? null : 'sem convidado pronto' }) : null,
        isHost && state.phase === 'starting' ? row('start', 'INICIANDO…', () => {}, { dim: true }) : null,
        isHost && ['lobby', 'connecting'].includes(state.phase)
          ? mapRow('map', map, delta => changeMap(core.cycleMap(maps, map?.zone, delta))) : null,
        !isHost && state.phase === 'lobby' ? row('ready', `PRONTO: ${ready ? 'SIM' : 'NÃO'}`, toggleReady,
          { cls: `bz-toggle${ready ? ' bz-on' : ''}`, busy: ui.busy === 'setReady' }) : null,
        invite?.invite ? row('copy', copied ? 'CONVITE COPIADO!' : 'COPIAR CONVITE', copyInvite,
          { cls: copied ? 'bz-done' : '', busy: ui.busy === 'copyInvite' }) : null,
        row('leave', state.phase === 'connecting' ? 'CANCELAR' : 'SAIR DA SALA', leaveRoom, { busy: ui.busy === 'leave' }),
        row('close', 'VOLTAR AOS MAPAS', () => close(), { hint: 'a sala continua' })),
    ]);
    patch('room-map', right, JSON.stringify(['room', map?.zone, isHost]), () =>
      mapCard(map, { caption: isHost ? null : 'O HOST ESCOLHE O MAPA' }));
    patch('room-invite', right, JSON.stringify([invite, copied, state.mode, state.signal]), () => inviteBox(invite, copied));
  }

  function errorView() {
    const e = core.errorText(state.error) ?? { title: 'ERRO', text: 'Algo deu errado.', hint: null, suggest: 'home' };
    const map = roomMap();
    useSlots(left, ['error']); useSlots(right, ['error-info']);
    patch('error', left, JSON.stringify([e, ui.busy]), () => [
      h('div', { class: 'bz-alert', role: 'alert' }, h('h3', { class: 'bz-alert-title' }, e.title), para(e.text),
        e.hint ? para(e.hint, 'bz-help') : null),
      h('div', { class: 'bz-rows' },
        e.suggest === 'ip' ? row('fix', 'CONECTAR POR IP', () => resetTo('ip')) : null,
        e.suggest === 'join' ? row('fix', 'DIGITAR O CÓDIGO DE NOVO', () => resetTo('join')) : null,
        row('back', 'VOLTAR', () => resetTo('home'), { busy: ui.busy === 'leave' })),
    ]);
    patch('error-info', right, JSON.stringify(['error', e.suggest, map?.zone]), () => {
      if (e.suggest === 'ip') return infoCard('MODO POR IP', [
        'Funciona sem servidor de convite: na mesma rede de casa ou com o Tailscale entre casas diferentes.',
        'Quem hospeda escolhe HOSPEDAR A SALA e passa o IP e o código; quem entra escolhe ENTRAR NA SALA e digita os dois.',
      ]);
      if (e.suggest === 'join') return infoCard('O CÓDIGO', [
        'São 5 letras/números, como K7QX2. Não existem 0, O, 1, I nem L.',
        'O jeito mais fácil é abrir o link do convite: o app entra sozinho.',
      ]);
      return map ? mapCard(map) : infoCard('E AGORA?', [
        'Peça um convite novo ao host, ou crie a sua sala e chame os amigos.',
        'Se continuar dando erro, o log do co-op fica no menu Co-op do app.',
      ]);
    });
  }

  const seenMembers = new Set(); // quem já apareceu na lista não é animado de novo a cada atualização de ping
  function partyRow(r) {
    if (r.empty) return h('li', { class: 'bz-member bz-empty' }, h('span', { class: 'bz-name' }, 'VAGA LIVRE'));
    const fresh = !seenMembers.has(r.id);
    seenMembers.add(r.id);
    const q = core.quality(r.ping, r);
    return h('li', { class: `bz-member${fresh ? ' bz-new' : ''}`,
      dataset: { lost: r.link === 'lost' ? '' : null, you: r.you ? '' : null } },
    h('span', { class: 'bz-name' }, h('span', { class: 'bz-name-text' }, r.name),
      r.host ? h('span', { class: 'bz-tag bz-tag-host', title: 'Quem hospeda a partida' }, 'HOST') : null,
      r.you ? h('span', { class: 'bz-tag bz-tag-you' }, 'VOCÊ') : null),
    h('span', { class: 'bz-ready', dataset: { ready: r.ready ? '' : null } },
      r.host ? '' : r.ready ? 'PRONTO' : 'AGUARDANDO'),
    h('span', { class: 'bz-net' }, r.you ? null : [
      barsEl(h, r.bars, q.tone, `qualidade ${q.label.toLowerCase()}`),
      h('span', { class: 'bz-ping' }, r.pingLabel), badgeEl(h, r.badge)]));
  }

  const SIGNAL = { online: 'SERVIDOR ONLINE', connecting: 'CONECTANDO AO SERVIDOR…', offline: 'SERVIDOR FORA DO AR' };
  function inviteBox(invite, copied) {
    if (!invite) return null;
    const udp = state.mode === 'udp', signal = udp ? 'MODO POR IP' : SIGNAL[state.signal] ?? null;
    return h('div', { class: 'bz-invite' },
      h('div', { class: 'bz-invite-head' }, h('span', { class: 'bz-label-sm' }, 'CÓDIGO DA SALA'),
        signal ? h('span', { class: 'bz-signal', dataset: { s: udp ? 'ip' : state.signal } }, signal) : null),
      h('div', { class: 'bz-code', 'aria-label': `código ${invite.code ?? ''}` }, invite.code ?? '—'),
      invite.invite
        ? h('div', { class: `bz-link${copied ? ' bz-copied' : ''}`, title: invite.invite }, invite.invite) : null,
      para(invite.kind === 'ip' ? 'Mande o IP e o código: o amigo usa CONECTAR POR IP → ENTRAR NA SALA.'
        : 'Mande o link: quem tem o app abre direto na sala; ou passe só o código.', 'bz-help'));
  }

  function errorBanner(error) {
    const e = core.errorText(error);
    return e ? h('div', { class: 'bz-alert bz-alert-inline', role: 'alert' }, h('strong', {}, e.title), ' ', e.text) : null;
  }

  function gameNameNote(name) {
    const clean = core.cleanText(name), inGame = core.gameName(clean);
    return clean && inGame !== clean ? `No placar do jogo aparece como “${inGame}”.` : null;
  }

  // ---- ações
  async function call(fn, ...args) {
    if (ui.busy) return undefined;
    ui.busy = fn; ui.formError = null; render();
    try {
      const result = await api[fn](...args);
      if (result && typeof result === 'object' && typeof result.phase === 'string') setState(result);
      return result;
    } catch (error) {
      ui.formError = `Não deu certo: ${callError(error) || 'erro desconhecido'}.`;
      return undefined;
    } finally { ui.busy = null; render(); }
  }
  // Erro do formulário: mostra e devolve o foco ao campo que precisa de correção.
  function formError(text, nav) { ui.formError = text; drawNow(); focusNav(nav); }

  function createRoom() {
    const name = core.validateName(nameValue());
    if (!name.ok) return formError(name.error, 'name');
    ui.form.name = name.name;
    call('create', { name: name.name, map: selectedMap()?.zone });
  }
  function joinRoom() {
    const code = core.validateCode(ui.form.code);
    if (!code.ok) return formError(code.error, 'code');
    ui.form.code = code.code;
    call('join', { code: code.code, name: optName() });
  }
  function connectIp() {
    const role = ui.form.ipRole === 'host' ? 'host' : 'guest';
    let address = '';
    if (role === 'guest') {
      const pasted = core.parseIpInvite(ui.form.address);
      if (pasted) { ui.form.address = pasted.address; if (!ui.form.ipCode) ui.form.ipCode = pasted.code; }
      const a = core.validateAddress(ui.form.address);
      if (!a.ok) return formError(a.error, 'address');
      address = a.address;
    }
    const code = core.validateIpCode(ui.form.ipCode, role);
    if (!code.ok) return formError(code.error, 'ipCode');
    call('connectByAddress', { role, address, code: code.code, name: optName() });
  }
  function startGame() {
    const start = core.startAction(state);
    if (start.mode === 'go') call('start');
    else if (start.mode === 'confirm') ask({ ...start.confirm, yes: 'INICIAR', action: () => call('start') });
  }
  const toggleReady = () => call('setReady', !core.guestReady(state));
  function changeMap(map) { if (map && map.zone !== state.map?.zone) call('setMap', map.zone); }
  async function copyInvite() {
    let text = await call('copyInvite');
    if (typeof text !== 'string' || !text) {
      // reserva: a área de transferência do próprio navegador
      text = state.invite || null;
      try { if (text) await globalThis.navigator?.clipboard?.writeText(text); } catch { text = null; }
    }
    if (!text) { ui.formError = 'Não há convite para copiar ainda.'; render(); return; }
    ui.formError = null;
    ui.copiedUntil = Date.now() + COPIED_MS;
    render();
    setTimeout(render, COPIED_MS + 50);
  }
  function leaveRoom() {
    const guests = (state.peers ?? []).filter(p => p?.role === 'guest').length;
    if (state.role !== 'host' || !guests) return resetTo('home');
    ask({ title: 'FECHAR A SALA?', text: 'Você é o host: sair fecha a sala para todos.', yes: 'SAIR E FECHAR',
      action: () => resetTo('home') });
  }
  async function resetTo(view) {
    ui.view = view; ui.formError = null;
    await call('leave');
    ui.view = view;
    drawNow();
    focusFirst();
  }
  function go(view) { ui.view = view; ui.formError = null; drawNow(); focusFirst(); }

  function ask(confirm) { ui.confirm = confirm; drawNow(); focusFirst(); }
  function answer(yes) {
    const confirm = ui.confirm;
    ui.confirm = null; drawNow(); focusFirst();
    if (yes) confirm?.action?.();
  }

  // ---- abrir/fechar, foco e teclado
  function open() {
    if (ui.open || destroyed) return;
    ui.open = true;
    backdrop.hidden = false;
    layer.dataset.open = '';
    drawNow();
    focusFirst();
  }
  function close() {
    if (!ui.open) return;
    ui.open = false; ui.confirm = null;
    backdrop.hidden = true;
    delete layer.dataset.open;
    if (!core.hasRoom(state)) ui.view = 'home';
    item.focus({ preventScroll: true });
  }
  const navItems = () => [...(ui.confirm ? confirmEl : panel).querySelectorAll('[data-nav]')]
    .filter(el => !el.closest('[hidden]') && (ui.confirm || !confirmEl.contains(el)));
  function focusNav(key) { navItems().find(el => el.dataset.nav === key)?.focus({ preventScroll: true }); }
  function focusFirst() {
    const items = navItems();
    // o foco vai para a primeira ação (não para um campo que já vem preenchido, como o nome)
    (items.find(el => el.tagName !== 'INPUT' || !el.value) ?? items[0])?.focus({ preventScroll: true });
  }
  function moveFocus(delta) {
    const items = navItems();
    if (!items.length) return;
    const at = items.indexOf(doc.activeElement);
    const next = at < 0 ? (delta > 0 ? 0 : items.length - 1) : (at + delta + items.length) % items.length;
    items[next].focus({ preventScroll: true });
  }

  function onKey(event) {
    if (destroyed || !layer.isConnected) return;
    if (!ui.open) { landingKey(event); return; }
    const target = doc.activeElement, inInput = target?.tagName === 'INPUT';
    const stop = () => { event.preventDefault(); event.stopPropagation(); };
    const view = core.viewFor(state, ui.view);
    switch (event.key) {
      case 'Escape':
        stop();
        if (ui.confirm) answer(false);
        else if (view === 'join' || view === 'ip') go('home');
        else if (view === 'error') resetTo('home');
        else close();
        return;
      case 'ArrowDown': stop(); moveFocus(1); return;
      case 'ArrowUp': stop(); moveFocus(-1); return;
      case 'Tab': stop(); moveFocus(event.shiftKey ? -1 : 1); return;
      case 'ArrowLeft': case 'ArrowRight': {
        if (inInput || !panel.contains(target)) return;
        const dir = event.key === 'ArrowLeft' ? 'prev' : 'next';
        if (target.dataset.cycle !== undefined) { stop(); target.querySelector(`[data-dir="${dir}"]`)?.click(); }
        else if (target.classList.contains('bz-toggle')) { stop(); target.click(); }
        else if (ui.confirm) { stop(); moveFocus(dir === 'prev' ? -1 : 1); }
        return;
      }
      case 'Enter':
        // Enter num campo aciona a ação dele (CRIAR SALA, ENTRAR NA SALA, CONECTAR)
        if (inInput) { stop(); focusNav(target.dataset.submit); doc.activeElement?.click(); }
        return;
      default:
    }
  }
  // Com o painel fechado: setas percorrem a lista nativa, o item e o HELL MODE, como no menu do jogo.
  function landingKey(event) {
    if ((event.key !== 'ArrowDown' && event.key !== 'ArrowUp') || event.altKey || event.ctrlKey || event.metaKey) return;
    if (doc.body?.classList.contains('picked')) return;
    const list = [...stage.querySelectorAll('a[data-pick]'), item, stage.querySelector('#horde-toggle')].filter(Boolean);
    const target = doc.activeElement;
    if (target && target !== doc.body && !list.includes(target)) return;
    event.preventDefault();
    const at = list.indexOf(target);
    // primeira seta: vai para a linha já realçada (o menu abre com Kino selecionado)
    if (at < 0) {
      list[Math.max(0, list.findIndex(el => el.dataset?.pick && el.dataset.pick === landingPick()))].focus();
      return;
    }
    list[(at + (event.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length].focus();
  }
  // Mouse por cima de uma linha leva o foco junto (como o realce nativo segue o ponteiro), menos quando se digita.
  panel.addEventListener('mouseover', event => {
    const target = event.target.closest?.('button[data-nav]');
    if (!target || doc.activeElement === target || doc.activeElement?.tagName === 'INPUT') return;
    target.focus({ preventScroll: true });
  });
  // Foco que escapa do painel aberto (clique fora, Tab do navegador) volta para ele.
  const onFocusIn = event => { if (ui.open && !destroyed && !panel.contains(event.target)) focusFirst(); };
  doc.addEventListener('focusin', onFocusIn);
  doc.addEventListener('keydown', onKey, true);

  // Mapa selecionado na lista nativa (landing.js marca .focus.selected logo depois do link da linha).
  function landingPick() {
    return stage.querySelector('.focus.selected')?.previousElementSibling?.dataset?.pick ?? null;
  }
  // Com sala aberta, escolher um mapa na lista não começa um jogo solo: no host troca o mapa da sala; no convidado
  // abre o painel (quem escolhe é o host).
  const onPick = event => {
    const link = event.target.closest?.('a[data-pick]');
    if (!link || !core.hasRoom(state)) return;
    event.preventDefault(); event.stopPropagation();
    const map = core.findMap(maps, link.dataset.pick);
    if (state.role === 'host' && state.phase === 'lobby' && map) changeMap(map);
    else if (state.role === 'guest') showToast('Quem escolhe o mapa é o host.');
    open(); render();
  };
  stage.addEventListener('click', onPick, true);

  function showToast(text, ms = 2500) {
    ui.toast = { text, until: Date.now() + ms };
    setTimeout(render, ms + 50);
  }

  // ---- desenho
  let scheduled = false;
  function render() {
    if (destroyed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => { if (scheduled) { scheduled = false; draw(); } });
  }
  // Desenha já (antes de mover o foco para a tela nova).
  function drawNow() { if (!destroyed) { scheduled = false; draw(); } }
  const TITLES = { join: 'ENTRAR COM CÓDIGO', ip: 'CONECTAR POR IP' };
  function draw() {
    const status = core.itemStatus(state);
    itemBadge.textContent = status?.text ?? '';
    itemBadge.dataset.tone = status?.tone ?? '';
    if (status) item.dataset.room = ''; else delete item.dataset.room;
    if (!ui.open) return;
    const view = core.viewFor(state, ui.view);
    panel.dataset.view = view;
    titleEl.textContent = view === 'room' ? (state.role === 'host' ? 'SUA SALA' : 'NA SALA')
      : TITLES[view] ?? 'JOGAR COM AMIGOS';
    headInfo.replaceChildren(...headBits(view));
    ({ home: homeView, join: joinView, ip: ipView, room: roomView, error: errorView })[view]();
    const toast = ui.toast && Date.now() < ui.toast.until ? ui.toast.text : null;
    statusEl.textContent = toast ?? (ui.busy ? busyText(ui.busy) : core.statusText(state));
    const bad = state.phase === 'error' || (view === 'room' && state.error);
    statusEl.dataset.tone = bad ? 'bad' : ui.busy || state.phase === 'connecting' ? 'wait' : '';
    keysEl.replaceChildren(...keyHints(view).map(([key, text]) => h('span', { class: 'bz-key' }, h('kbd', {}, key), text)));
    drawConfirm();
    // a tela mudou por baixo (estado novo) e o elemento com foco sumiu: o foco vai para a primeira ação
    if (!panel.contains(doc.activeElement)) focusFirst();
  }
  function headBits(view) {
    if (view !== 'room' && view !== 'error') return [h('span', { class: 'bz-head-sub' }, 'CO-OP ATÉ 4 JOGADORES')];
    return [state.room ? h('span', { class: 'bz-head-room' }, 'SALA ', h('b', {}, core.cleanText(state.room, 12))) : null,
      h('span', { class: 'bz-head-sub' }, state.mode === 'udp' ? 'POR IP' : 'POR CONVITE')].filter(Boolean);
  }
  const BUSY = { create: 'Criando a sala…', join: 'Entrando na sala…', connectByAddress: 'Conectando…',
    leave: 'Saindo da sala…', start: 'Iniciando a partida…', setReady: 'Avisando o host…',
    setMap: 'Trocando o mapa…', copyInvite: 'Copiando o convite…' };
  const busyText = fn => BUSY[fn] ?? 'Aguarde…';
  function keyHints(view) {
    const hints = [['↑↓', 'NAVEGAR'], ['ENTER', 'SELECIONAR']];
    if (view === 'home' || (view === 'room' && state.role === 'host')) hints.push(['←→', 'MAPA']);
    if (view === 'ip') hints.push(['←→', 'PAPEL']);
    hints.push(['ESC', ui.confirm ? 'CANCELAR' : view === 'home' || view === 'room' ? 'FECHAR' : 'VOLTAR']);
    return hints;
  }
  function drawConfirm() {
    const c = ui.confirm;
    confirmEl.hidden = !c;
    if (!c) { delete panel.dataset.confirm; delete confirmEl.dataset.sig; confirmEl.replaceChildren(); return; }
    panel.dataset.confirm = '';
    if (confirmEl.dataset.sig === c.title + c.text) return;
    confirmEl.dataset.sig = c.title + c.text;
    confirmEl.replaceChildren(h('div', { class: 'bz-confirm-box' },
      h('h3', { class: 'bz-alert-title' }, c.title), para(c.text),
      h('div', { class: 'bz-rows' },
        row('yes', c.yes ?? 'CONFIRMAR', () => answer(true)),
        row('no', 'CANCELAR', () => answer(false)))));
  }

  // ---- estado
  function setState(next) {
    if (!next || typeof next !== 'object' || destroyed) return;
    const prev = state;
    state = next;
    if (!siteMaps && Array.isArray(next.maps)) maps = core.pickMapList(null, next.maps);
    if (!ui.nameTouched && !ui.form.name && next.name) ui.form.name = core.cleanText(next.name);
    // convite pendente (link aberto com o app fechado, bo1z:// recebido agora): o painel abre sozinho na sala
    if (core.autoOpen(prev, next) && !ui.open) open();
    render();
  }

  let unsubscribe = () => {};
  subscribe(api, setState).then(off => { if (destroyed) off(); else unsubscribe = off; });
  render();

  return {
    kind: 'menu',
    open, close,
    get state() { return state; },
    get view() { return ui.open ? core.viewFor(state, ui.view) : null; },
    destroy() {
      destroyed = true;
      unsubscribe();
      doc.removeEventListener('keydown', onKey, true);
      doc.removeEventListener('focusin', onFocusIn);
      stage.removeEventListener('click', onPick, true);
      layer.remove();
      mounted.delete(doc);
    },
  };
}

// =====================================================================================================================
// Página do mapa: indicador discreto (canto superior direito, longe do HUD do jogo: rodada embaixo à esquerda, pontos
// e munição embaixo à direita, Options do site em cima à esquerda) e avisos de conexão no topo. Nada aqui recebe
// clique: o jogo usa o ponteiro.

function mountHud({ api, doc }) {
  const h = maker(doc);
  let state = null, destroyed = false, styled = false, transient = null, transientTimer = null, sig = null;
  const hud = h('aside', { id: 'bo1z-coop-hud', class: 'bz-hud', hidden: true, 'aria-label': 'Conexão do co-op' });
  const notice = h('div', { id: 'bo1z-coop-notice', class: 'bz-notice', hidden: true, role: 'status',
    'aria-live': 'polite' });
  const attach = () => { if (doc.body && !hud.isConnected) doc.body.append(hud, notice); };
  attach();
  // A página pode trocar o <body> inteiro (landing.js faz isso ao escolher um mapa); o indicador volta para o novo.
  const observer = typeof MutationObserver === 'function' ? new MutationObserver(attach) : null;
  observer?.observe(doc.documentElement, { childList: true });
  // só aparece com o CSS no lugar (sem ele, viraria texto solto no fim da página)
  addStyles(doc, { fonts: false }).then(() => { styled = true; draw(); });

  function draw() {
    if (destroyed || !styled) return;
    const model = core.indicator(state);
    const shown = transient && !model.notice ? transient : model.notice;
    const next = JSON.stringify([model, shown]);
    if (next === sig) return;
    sig = next;
    hud.hidden = !model.show;
    if (model.show) {
      const rows = model.rows.length ? model.rows
        : [{ name: state?.role === 'host' ? 'Aguardando amigos' : 'Host', ping: '—', bars: 0, tone: 'none' }];
      hud.dataset.tone = model.worst?.tone ?? 'none';
      hud.replaceChildren(h('div', { class: 'bz-hud-title' }, model.title), ...rows.slice(0, 3).map(r =>
        h('div', { class: 'bz-hud-row', dataset: { lost: r.lost ? '' : null } },
          barsEl(h, r.bars, r.tone, `ping ${r.ping}`), h('span', { class: 'bz-hud-name' }, r.name),
          h('span', { class: 'bz-hud-ping' }, r.ping), badgeEl(h, r.badge))));
    }
    notice.hidden = !shown;
    if (shown) {
      notice.dataset.tone = shown.tone;
      notice.replaceChildren(h('strong', { class: 'bz-notice-title' }, shown.title),
        h('span', { class: 'bz-notice-text' }, shown.text));
    }
  }
  function setState(next) {
    if (!next || typeof next !== 'object' || destroyed) return;
    const gone = core.departed(state, next);
    state = next;
    if (gone.length) {
      const who = gone.join(', ').toUpperCase();
      transient = { tone: 'warn', title: `${who} ${gone.length === 1 ? 'SAIU' : 'SAÍRAM'} DA PARTIDA`,
        text: 'A partida continua para quem ficou.' };
      clearTimeout(transientTimer);
      transientTimer = setTimeout(() => { transient = null; draw(); }, 7000);
    }
    draw();
  }
  let unsubscribe = () => {};
  subscribe(api, setState).then(off => { if (destroyed) off(); else unsubscribe = off; });
  return {
    kind: 'hud',
    get state() { return state; },
    destroy() {
      destroyed = true;
      unsubscribe();
      observer?.disconnect();
      clearTimeout(transientTimer);
      hud.remove(); notice.remove();
      mounted.delete(doc);
    },
  };
}
