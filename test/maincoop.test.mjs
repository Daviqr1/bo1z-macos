// Funções puras do co-op no main (sem Electron): config, patch do engine.js do convidado, convite.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';

const { coopSettings, patchEngineForGuest, inviteAddresses } = createRequire(import.meta.url)('../app/coop/main-coop.js');

// Trecho com a mesma forma do engine.js do vel.gg (o arquivo real não é versionado; BO1Z_ENGINE_JS=<caminho> testa nele).
const ENGINE = `const fiveArguments = ['+set', 'x', '1',
  '+devmap', mapId,
];
function start() {
    if (/Com_ERROR:\\s*PLATFORM_DISCONNECTED_FROM_SERVER/.test(message)) quit('disconnect');
    const args = [...fiveArguments];
    args.splice(args.indexOf('+devmap'), 0, '+set', 'sensitivity', '5');
    state.arguments = args;
}`;

test('config do co-op: padrão desligado, env tem prioridade, role inválido vira off', () => {
  assert.equal(coopSettings({}, {}).role, 'off');
  assert.equal(coopSettings({}, {}).guestStart, 'shadow');
  const c = coopSettings({ coop: { role: 'guest', host: '1.2.3.4', code: 'AAAAA' } }, { BO1Z_COOP_HOST: '100.64.0.9:27961', BO1Z_COOP_START: 'manual' });
  assert.deepEqual([c.role, c.host, c.code, c.guestStart, c.port], ['guest', '100.64.0.9:27961', 'AAAAA', 'manual', 27960]);
  assert.equal(coopSettings({ coop: { role: 'server' } }, {}).role, 'off');
  assert.equal(coopSettings({}, { BO1Z_COOP: 'host', BO1Z_COOP_PORT: '28000' }).port, 28000);
});

test('engine.js do convidado: +devmap vira +connect localhost depois dos splices; página não sai no disconnect', () => {
  const { text, applied } = patchEngineForGuest(ENGINE, 'connect');
  assert.deepEqual(applied, ['connect', 'noquit']);
  // executa o trecho patcheado e confere os argumentos finais
  const run = guest => {
    const state = {}, quits = [];
    new Function('mapId', 'message', 'quit', 'state', 'globalThis', text + '\nstart();')('zombie_coast', 'Com_ERROR: PLATFORM_DISCONNECTED_FROM_SERVER', w => quits.push(w), state, { __bo1zCoopGuest: guest });
    return { args: state.arguments, quits };
  };
  assert.deepEqual(run(true), { args: ['+set', 'x', '1', '+set', 'sensitivity', '5', '+connect', 'localhost'], quits: [] });
  assert.deepEqual(run(false), { args: ['+set', 'x', '1', '+set', 'sensitivity', '5', '+devmap', 'zombie_coast'], quits: ['disconnect'] });
  assert.deepEqual(patchEngineForGuest(ENGINE, 'manual').applied, ['noquit']);
  // shadow (padrão): mantém o +devmap (servidor local com os dados do mapa) e conecta no host logo depois
  const shadow = patchEngineForGuest(ENGINE, 'shadow');
  assert.deepEqual(shadow.applied, ['shadow', 'noquit']);
  const state = {};
  new Function('mapId', 'message', 'quit', 'state', 'globalThis', shadow.text + '\nstart();')('zombie_cod5_prototype', '', () => {}, state, { __bo1zCoopGuest: true });
  assert.deepEqual(state.arguments.slice(-4), ['+devmap', 'zombie_cod5_prototype', '+connect', 'localhost:3074']);
  assert.throws(() => patchEngineForGuest('state.arguments = args;', 'connect'), /sem \+devmap/);
});

const REAL = process.env.BO1Z_ENGINE_JS;
test('engine.js real do site (BO1Z_ENGINE_JS)', { skip: !REAL || !existsSync(REAL) }, () => {
  assert.deepEqual(patchEngineForGuest(readFileSync(REAL, 'utf8'), 'connect').applied, ['connect', 'noquit']);
  assert.deepEqual(patchEngineForGuest(readFileSync(REAL, 'utf8'), 'shadow').applied, ['shadow', 'noquit']);
});

test('convite lista endereços IPv4 com porta', () => {
  for (const a of inviteAddresses(27960)) assert.match(a, /^\d+\.\d+\.\d+\.\d+:27960( \(Tailscale\))?$/);
});
