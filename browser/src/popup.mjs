// Popup da extensão: a sala sem depender do lobby na página (criar, entrar, pronto, iniciar, convite, sair). Fala com o
// offscreen pelo mesmo protocolo das abas (lib/hub.mjs), como 'bo1z-ui'. A aba do vel.gg ativa vira a dona da sala.
import { loadPrefs, savePrefs } from './lib/prefs.mjs';
import { parseJoinInput } from './lib/invite.mjs';

const $ = id => document.getElementById(id);
const say = (text, bad = false) => { $('msg').textContent = text ?? ''; $('msg').className = `msg ${bad ? 'bad' : ''}`; };
const PHASES = { connecting: 'Conectando…', lobby: 'Na sala', starting: 'Iniciando a partida…', playing: 'Em jogo',
  error: 'Erro' };

const prefs = await loadPrefs(chrome.storage.local);
$('name').value = prefs.name;
await chrome.runtime.sendMessage({ to: 'sw', t: 'ensure' }).catch(() => null);
const [tab] = await chrome.tabs.query({ active: true, currentWindow: true, url: 'https://vel.gg/*' }).catch(() => []);
const port = chrome.runtime.connect({ name: 'bo1z-ui' });
const calls = new Map();
let seq = 0, state = null;

const call = (fn, ...args) => new Promise((resolve, reject) => {
  const id = `u${++seq}`;
  calls.set(id, { resolve, reject });
  port.postMessage({ t: 'call', id, fn, args, tabId: tab?.id ?? null });
});

port.onMessage.addListener(m => {
  if (m.t === 'hello' || m.t === 'state') render(m.state);
  else if (m.t === 'result') {
    const p = calls.get(m.id);
    calls.delete(m.id);
    if (m.ok) p?.resolve(m.value); else p?.reject(new Error(m.error));
  }
});
port.postMessage({ t: 'hello', href: 'popup' });
port.postMessage({ t: 'prefs', prefs });

function render(s) {
  state = s;
  const inRoom = ['connecting', 'lobby', 'starting', 'playing'].includes(s.phase);
  $('idle').hidden = inRoom;
  $('room').hidden = !inRoom;
  const select = $('map');
  if (select.options.length !== s.maps.length) select.replaceChildren(...s.maps.map(m => new Option(m.name, m.zone)));
  if (s.map) select.value = s.map.zone;
  $('title').textContent = `${s.room ? `Sala ${s.room}` : 'Sala'} · ${PHASES[s.phase] ?? s.phase}`;
  $('mapname').textContent = s.map ? `Mapa: ${s.map.name}` : '';
  const me = s.you ? [{ ...s.you, role: s.role, link: null, ping: null, me: true }] : [];
  $('players').replaceChildren(...[...me, ...s.peers].map(p => {
    const li = document.createElement('li');
    const who = document.createElement('span');
    who.textContent = `${p.name}${p.me ? ' (você)' : ''}${p.role === 'host' ? ' · host' : p.ready ? ' · pronto' : ''}`;
    const net = document.createElement('span');
    if (!p.me) {
      net.textContent = p.ping === null || p.ping === undefined ? '— ms' : `${Math.round(p.ping)} ms`;
      const tag = document.createElement('span');
      tag.className = `tag ${p.link}`;
      tag.textContent = { direct: 'DIRETO', relay: 'RELAY', lan: 'LAN', lost: 'PERDIDO', connecting: '…' }[p.link] ?? '';
      net.append(tag);
    }
    li.append(who, net);
    return li;
  }));
  $('start').hidden = s.role !== 'host';
  $('start').disabled = s.phase !== 'lobby' && s.phase !== 'playing';
  $('ready').hidden = s.role !== 'guest';
  const ready = s.you?.ready === true;
  $('ready').textContent = ready ? 'Não estou pronto' : 'Pronto';
  if (s.error) say(s.error.message, true); else if (s.phase !== 'error') say('');
}

const act = fn => async () => { try { await fn(); } catch (error) { say(error.message, true); } };
const name = async () => {
  const r = await savePrefs(chrome.storage.local, { name: $('name').value });
  return r.prefs?.name || 'Jogador';
};

$('create').onclick = act(async () => { await call('create', { name: await name(), map: $('map').value }); });
$('join').onclick = act(async () => {
  const parsed = parseJoinInput($('code').value);
  if (!parsed) { say('Código inválido: são 5 letras/números, ou cole o link do convite.', true); return; }
  await call('join', { code: parsed.code, signalUrl: parsed.signalUrl, name: await name() });
});
$('map').onchange = act(async () => { if (state?.role === 'host') await call('setMap', $('map').value); });
$('ready').onclick = act(async () => { await call('setReady', !(state?.you?.ready === true)); });
$('start').onclick = act(async () => { await call('start'); });
$('leave').onclick = act(async () => { await call('leave'); });
$('copy').onclick = act(async () => {
  const link = state?.invite ?? state?.browserInvite;
  if (!link) { say('Ainda sem convite (conectando ao servidor).', true); return; }
  await navigator.clipboard.writeText(link);
  say(`Convite copiado: ${link}`);
});
