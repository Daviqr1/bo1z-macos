// Janela net de ponta a ponta no Electron de verdade (test/electron/net-e2e.cjs): duas janelas net ocultas, WebRTC
// real, sinalização de teste em processo e páginas do jogo simuladas com MessageChannelMain. No Linux roda com
// xvfb-run (sem tela); no Mac, direto. Leva ~35 s (inclui os 15 s da detecção de par perdido).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const script = path.join(root, 'test', 'electron', 'net-e2e.cjs');
let electron = null;
try { electron = createRequire(import.meta.url)('electron'); } catch { /* sem a devDependency */ }
const linux = process.platform === 'linux';
const xvfb = linux && spawnSync('which', ['xvfb-run']).status === 0;
const skip = !electron || !existsSync(electron) ? 'electron não instalado (npm ci)'
  : linux && !xvfb ? 'xvfb-run não encontrado' : false;

function run() {
  const args = [...(linux ? ['--no-sandbox', '--disable-gpu'] : []), script];
  const child = linux ? spawn('xvfb-run', ['-a', electron, ...args]) : spawn(electron, args);
  let stdout = '', stderr = '';
  child.stdout.on('data', d => { stdout += d; });
  child.stderr.on('data', d => { stderr += d; });
  return new Promise(resolve => child.on('close', code => {
    const lines = stdout.split('\n').filter(l => l.startsWith('{')).map(l => JSON.parse(l));
    resolve({ code, lines, stderr });
  }));
}

test('janela net no Electron: sala, WebRTC real, pacotes de 1264 B, RTT, página nova, saída e volta, travamento',
  { skip, timeout: 180000 }, async () => {
    const { code, lines, stderr } = await run();
    const step = name => lines.find(l => l.step === name);
    const done = lines.find(l => l.done);
    const tail = stderr.split('\n').filter(l => !/dbus/.test(l)).slice(-20).join('\n');
    assert.ok(done?.ok, `e2e falhou (saída ${code}): ${done?.error ?? tail}`);

    const sala = step('sala');
    assert.match(sala.room, /^[A-HJKMNP-Z2-9]{5}$/);
    assert.equal(sala.signal, 'online');
    assert.equal(sala.lobbyMap, 'zombie_coast');

    const con = step('conectado');
    assert.equal(con.join.name, 'Irmao');
    assert.equal(con.join.slot, 1);
    assert.equal(con.hostView.link, 'direct');
    assert.equal(con.guestView.link, 'direct');

    // 1264 B nos dois sentidos pelo protocolo §1: host recebe com o id do convidado, convidado recebe sem id
    const { up, down, guestId } = step('trafego');
    for (const t of [up, down]) {
      assert.ok(t.got >= t.sent * 0.98, `entregues ${t.got}/${t.sent}`);
      assert.equal(t.valid, true);
      assert.deepEqual(t.sizes, [1264]);
    }
    assert.deepEqual(up.ids, [guestId]);
    assert.deepEqual(down.ids, [null]);

    const m = step('medidas');
    assert.equal(typeof m.hostPing, 'number');
    assert.equal(typeof m.guestPing, 'number');
    assert.ok(m.hostPing < 50, `RTT local ${m.hostPing} ms`);
    assert.equal(m.link, 'direct');
    assert.match(m.path, /^host\/udp -> host\/udp$/);

    // rajada maior que o canal: descarta (sem fila), e o tráfego normal continua
    const r = step('rajada');
    // (o limiar exato de 64 KiB é conferido no net-session.test.mjs; aqui, que o descarte explica a diferença)
    assert.equal(r.burst.valid, true);
    assert.ok(r.burst.got + r.congested >= r.burst.sent * 0.99, 'quase nada se perdeu além do descarte');
    assert.equal(r.recover.got, r.recover.sent);

    // ICE restart dos dois lados ao mesmo tempo (perfect negotiation) e RTCPeerConnection novo do convidado (gen 2):
    // nada de leave/join na página, tráfego inteiro depois
    const rn = step('renegociacao');
    for (const side of ['host', 'guest']) {
      assert.ok(rn.afterRestart[side].every(i => i.restarts >= 1 && i.link === 'direct'), JSON.stringify(rn.afterRestart));
      assert.ok(rn.afterReset[side].every(i => i.gen === 2 && i.sig === 'stable'), JSON.stringify(rn.afterReset));
    }
    assert.deepEqual([rn.restart.up, rn.restart.down, rn.reset.up, rn.reset.down].map(n => n >= rn.restart.sent * 0.98),
      [true, true, true, true], JSON.stringify(rn));
    assert.equal(rn.joins, 0);
    assert.equal(rn.leaves, 0);

    const p = step('pagina-nova');
    assert.equal(p.rejoin.id, guestId, 'ready reapresenta o convidado');
    assert.equal(p.toNew.got, p.toNew.sent);
    assert.equal(p.oldGotMore, 0, 'o port antigo não recebe mais nada');

    const f = step('fechou');
    assert.equal(f.leave.id, guestId);
    assert.equal(f.leave.reason, 'left');
    assert.ok(f.ms < 5000, `leave em ${f.ms} ms`);
    assert.equal(f.peers, 0);

    const v = step('voltou');
    assert.notEqual(v.back.id, v.oldId);
    assert.equal(v.link, 'direct');
    assert.equal(v.up.got, v.up.sent);
    assert.equal(v.down.got, v.down.sent);

    const c = step('travou');
    assert.equal(c.lost.reason, 'lost');
    assert.ok(c.ms >= 14000 && c.ms < 25000, `par perdido em ${c.ms} ms (15 s sem pong)`);
    assert.equal(c.peers, 0);
  });
