// Extensão do navegador: codificação dos pacotes do motor no chrome.runtime.Port (JSON) e convite/URLs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENCODINGS, MAX_PACKET, fromBase64, packMsg, percentiles, toBase64, unpackMsg } from '../browser/src/lib/wire.mjs';
import { inviteLink, mapPageUrl, normalizeSignal, parseInviteHash, parseJoinInput, signalParam, slugFromPath }
  from '../browser/src/lib/invite.mjs';

// o Port do Chrome serializa em JSON: é o que passa de verdade
const viaPort = v => JSON.parse(JSON.stringify(v));
const bytes = n => Uint8Array.from({ length: n }, (_, i) => (i * 37 + 11) & 255);

test('base64: nativo e reserva (btoa/atob) dão o mesmo resultado, inclusive vazio e 1264 B', () => {
  for (const n of [0, 1, 2, 3, 100, 1264, 70000]) {
    const b = bytes(n), text = toBase64(b, false);
    assert.equal(text, Buffer.from(b).toString('base64'));
    assert.deepEqual(fromBase64(text, false), b);
    if (typeof Uint8Array.prototype.toBase64 === 'function') assert.equal(toBase64(b, true), text);
  }
});

test('pacote do host (com id) e do convidado (sem id) atravessam o JSON e voltam iguais, nas 3 codificações', () => {
  for (const enc of Object.keys(ENCODINGS)) {
    for (const m of [{ t: 'pkt', id: 'k7Qx2abc', b: bytes(300) }, { t: 'pkt', b: bytes(1264) }, { t: 'pkt', id: 'x', b: bytes(1) }]) {
      const w = viaPort(packMsg(m, enc));
      assert.equal(w.t, 'p');
      const back = unpackMsg(w);
      assert.ok(back.b instanceof Uint8Array);
      assert.deepEqual([...back.b], [...m.b]);
      assert.equal(back.id, m.id);
      assert.equal('id' in back, 'id' in m);
    }
  }
  // base64 é o padrão e não leva o campo da codificação
  assert.deepEqual(Object.keys(packMsg({ t: 'pkt', b: bytes(4) })).sort(), ['b', 't']);
  // tamanho no fio: base64 ~4/3; array de números bem maior
  const b = bytes(1264);
  assert.ok(JSON.stringify(packMsg({ t: 'pkt', b })).length < 1264 * 1.4);
  assert.ok(JSON.stringify(packMsg({ t: 'pkt', b }, 'arr')).length > 1264 * 3);
});

test('demais mensagens do protocolo §1 passam inteiras; lixo e pacote grande demais são descartados', () => {
  for (const m of [{ t: 'join', id: 'a', slot: 1, name: 'Davi' }, { t: 'leave', id: 'a', reason: 'lost' },
    { t: 'ready', role: 'host', rings: [5, 6] }, { t: 'net', stats: { peers: [] } }, { t: 'full', id: 'a' }]) {
    assert.deepEqual(unpackMsg(viaPort(packMsg(m))), m);
  }
  assert.equal(unpackMsg(viaPort(packMsg({ t: 'pkt', b: bytes(MAX_PACKET + 1) }))), null);
  assert.equal(unpackMsg({ t: 'p', b: '' }), null);
  assert.equal(unpackMsg({ t: 'p', b: '%%%' }), null);
  assert.equal(unpackMsg({ t: 'p', b: 'AAAA', e: 'zip' }), null);
  assert.equal(unpackMsg({ t: 'm', m: null }), null);
  assert.equal(unpackMsg({ t: 'm', m: { x: 1 } }), null);
  assert.equal(unpackMsg(null), null);
  // id vira string mesmo se vier número
  assert.equal(unpackMsg({ t: 'p', i: 7, b: 'AQ==' }).id, '7');
});

test('percentis para os relatórios de latência', () => {
  const p = percentiles(Array.from({ length: 100 }, (_, i) => i + 1));
  assert.deepEqual(p, { p50: 51, p99: 100, max: 100, n: 100 });
  assert.deepEqual(percentiles([]), { p50: null, p99: null, max: null, n: 0 });
});

test('convite do navegador: formato, leitura do hash, servidor por host ou loopback', () => {
  const link = inviteLink({ code: 'K7QX2', signalUrl: 'https://bo1z-signal.davi.workers.dev' });
  assert.equal(link, 'https://vel.gg/bo1z/#bo1z-join=K7QX2&s=bo1z-signal.davi.workers.dev');
  assert.deepEqual(parseInviteHash(new URL(link).hash), { code: 'K7QX2', signalUrl: 'https://bo1z-signal.davi.workers.dev' });
  assert.deepEqual(parseInviteHash('#bo1z-join=k7qx2'), { code: 'K7QX2', signalUrl: null });
  // servidor local de teste (http só em loopback) e wss/ws/caminho
  const local = inviteLink({ code: 'K7QX2', signalUrl: 'http://127.0.0.1:8787' });
  assert.equal(parseInviteHash(new URL(local).hash).signalUrl, 'http://127.0.0.1:8787');
  assert.equal(normalizeSignal('wss://sig.example.com/ws'), 'https://sig.example.com');
  assert.equal(normalizeSignal('ws://localhost:8787/ws?v=1'), 'http://localhost:8787');
  assert.equal(normalizeSignal('sig.example.com:8443'), 'https://sig.example.com:8443');
  assert.equal(signalParam('https://sig.example.com/'), 'sig.example.com');
  // recusados: http fora de loopback, credenciais, lixo, código fora do alfabeto
  assert.equal(normalizeSignal('http://evil.example.com'), null);
  assert.equal(normalizeSignal('https://user:pw@sig.example.com'), null);
  assert.equal(normalizeSignal('javascript:alert(1)'), null);
  assert.equal(normalizeSignal(''), null);
  assert.equal(parseInviteHash('#bo1z-join=K7QO2&s=x.com'), null);
  assert.equal(parseInviteHash('#bo1z-start'), null);
  assert.equal(parseInviteHash('#bo1z-join=K7QX2&s=http://evil.example.com').signalUrl, null);
  assert.equal(inviteLink({ code: 'K7QX2', signalUrl: 'http://evil.example.com' }), null);
});

test('campo "entrar com código": código, convite do navegador, página /j/ e link do app', () => {
  assert.deepEqual(parseJoinInput(' k7q-x2 '), { code: 'K7QX2', signalUrl: null });
  assert.deepEqual(parseJoinInput('https://vel.gg/bo1z/#bo1z-join=K7QX2&s=sig.example.com'), { code: 'K7QX2', signalUrl: 'https://sig.example.com' });
  assert.deepEqual(parseJoinInput('https://sig.example.com/j/k7qx2'), { code: 'K7QX2', signalUrl: 'https://sig.example.com' });
  assert.deepEqual(parseJoinInput('bo1z://join/K7QX2?s=sig.example.com'), { code: 'K7QX2', signalUrl: 'https://sig.example.com' });
  assert.equal(parseJoinInput('ABC'), null);
  assert.equal(parseJoinInput('https://sig.example.com/j/K7QO2'), null);
});

test('URLs do jogo: mapa pela página e navegação de início automático', () => {
  assert.equal(slugFromPath('/bo1z/nacht'), 'nacht');
  assert.equal(slugFromPath('/bo1z/nacht/'), 'nacht');
  assert.equal(slugFromPath('/bo1z'), null);
  assert.equal(slugFromPath('/bo1z/'), null);
  assert.equal(mapPageUrl('cotd'), 'https://vel.gg/bo1z/cotd#bo1z-start');
});
