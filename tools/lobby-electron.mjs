// Lobby no app de verdade (Electron, main.js + preload.js + session.js + UDP), guiado pela interface como um jogador:
// duas instâncias (host e convidado, cada uma com a sua pasta), sem servidor de convite. O host tenta CRIAR SALA (erro
// explicando o modo por IP) e abre a sala POR IP; o convidado cola o convite do host e entra; PRONTO, troca de mapa,
// e o host sai (o convidado vê o aviso). Confere o DOM em cada passo e salva fotos. Não inicia a partida (isso
// baixaria o pack do mapa; o caminho do início é testado em test/session.test.mjs e tools/coop-e2e.mjs).
//
// Uso (Linux sem tela): node tools/lobby-electron.mjs [--out <pasta>]   (precisa de xvfb-run e node_modules/electron)
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectPage, sleep } from './cdp.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const OUT = path.resolve(arg('--out', process.env.BO1Z_SHOTS ?? path.join(tmpdir(), 'bo1z-lobby-shots')));
const electron = path.join(root, 'node_modules/electron/dist/electron');
const q = selector => `document.querySelector(${JSON.stringify(selector)})`;
const all = selector => `[...document.querySelectorAll(${JSON.stringify(selector)})]`;
let failures = 0;
const check = (label, pass) => { console.log(`${pass ? '✓' : '✗'} ${label}`); if (!pass) failures++; return pass; };

const freePort = () => new Promise(resolve => {
  const server = createServer();
  server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
});

const procs = [], homes = [];
function kill() {
  for (const p of procs) try { process.kill(-p.pid, 'SIGKILL'); } catch { /* já saiu */ }
  for (const dir of homes) try { rmSync(dir, { recursive: true, force: true }); } catch { /* ok */ }
}
// fim: mata cada grupo (xvfb-run, Xvfb, Electron e filhos) e espera sair de fato (nada órfão)
async function cleanup() {
  const exits = procs.map(p => (p.exitCode === null && p.signalCode === null ? new Promise(r => p.once('exit', r)) : null));
  kill();
  await Promise.race([Promise.all(exits), sleep(5000)]);
}
process.on('exit', kill);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { kill(); process.exit(130); });

async function launch(name) {
  const home = mkdtempSync(path.join(tmpdir(), `bo1z-lobby-${name}-`));
  homes.push(home);
  // porta UDP 0: o sistema escolhe (não briga com outro teste na 27960); sem servidor de convite
  writeFileSync(path.join(home, 'config.json'), JSON.stringify({ url: 'https://vel.gg/bo1z/', volume: 0, renderScale: 0.3,
    coop: { signal: '', port: 0 } }));
  const port = await freePort();
  const env = { ...process.env, BO1Z_HOME: home, BO1Z_MUTE: '1', BO1Z_DEBUG_PORT: String(port), BO1Z_SIGNAL: '' };
  // grupo de processos próprio: no fim mata o grupo inteiro
  const p = spawn('xvfb-run', ['-a', '-s', '-screen 0 1280x800x24', electron, '--no-sandbox', '--mute-audio',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', path.join(root, 'app')],
  { env, stdio: 'ignore', detached: true });
  procs.push(p);
  for (let i = 0; i < 120; ++i) {
    await sleep(500);
    try {
      const page = await connectPage(port, { match: 'vel.gg' });
      if (await page.evaluate(`!!${q('#bo1z-coop-item')} && !${q('#bo1z-lobby[data-loading]')}`)) return ui(name, page);
      page.close();
    } catch { /* app ainda subindo */ }
  }
  throw new Error(`${name}: o lobby não apareceu na tela de mapas`);
}

// Ações de jogador na página (mouse e teclado de verdade, pelo DevTools).
function ui(name, page) {
  const center = selector => page.evaluate(`(() => { const r = ${q(selector)}?.getBoundingClientRect();
    return r && r.width ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null; })()`);
  const KEYS = { Enter: 13, Escape: 27, ArrowRight: 39 };
  return {
    name, page,
    eval: expr => page.evaluate(expr),
    async until(expr, ms = 15000) {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        try { if (await page.evaluate(expr)) return true; } catch { /* navegando */ }
        await sleep(150);
      }
      return false;
    },
    async click(selector) {
      const at = await center(selector);
      if (!at) throw new Error(`${name}: sem ${selector}`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased'])
        await page.send('Input.dispatchMouseEvent', { type, x: at.x, y: at.y, button: 'left', clickCount: 1 });
      await sleep(250);
    },
    async type(selector, text) {
      await page.evaluate(`(() => { const el = ${q(selector)}; el.focus(); el.select(); })()`);
      await page.send('Input.insertText', { text });
    },
    async key(key) {
      const base = { key, code: key, windowsVirtualKeyCode: KEYS[key], nativeVirtualKeyCode: KEYS[key] };
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base });
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
      await sleep(200);
    },
    async shot(file) {
      await sleep(400);
      const r = await page.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(path.join(OUT, file), Buffer.from(r.result.data, 'base64'));
      console.log(`  foto ${path.join(OUT, file)}`);
    },
    text: selector => page.evaluate(`${q(selector)}?.textContent ?? null`),
  };
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const host = await launch('host');
  check('host: preload expôs __bo1zLobby e o lobby montou na tela de mapas',
    await host.eval(`typeof window.__bo1zLobby?.getState === 'function' && !!${q('#bo1z-coop-item')}`));
  check('host: CSS do lobby servido pelo main', await host.eval(`!!${q('#bo1z-lobby-css')}?.sheet`));
  check('host: fonte condensada carregou (Google Fonts sob o COEP do vel.gg, pelo protocolo https do main)',
    await host.until(`document.fonts.check('500 20px "Roboto Condensed"')`, 8000));
  await host.shot('app-01-menu.png');

  await host.click('#bo1z-coop-item');
  check('host: painel abre', await host.until(`!${q('#bo1z-lobby .bz-backdrop')}.hidden`));
  await host.type('[data-nav=name]', 'Davi');
  await host.click('[data-nav=create]');
  check('host: CRIAR SALA sem servidor de convite explica o modo por IP',
    await host.until(`${q('.bz-alert-title')}?.textContent === 'SEM SERVIDOR DE CONVITE'`));
  await host.shot('app-02-sem-servidor.png');
  await host.click('[data-nav=fix]');
  check('host: CONECTAR POR IP leva à tela do modo por IP', await host.until(`${q('.bz-title')}?.textContent === 'CONECTAR POR IP'`));
  await host.click('[data-nav=ip-role]');
  check('host: papel HOSPEDAR', (await host.text('[data-nav=ip-role]'))?.includes('HOSPEDAR'));
  await host.click('[data-nav=ip-go]');
  check('host: sala aberta por IP', await host.until(`${q('.bz-link')}?.textContent.includes('código')`));
  const invite = await host.text('.bz-link') ?? '';
  console.log(`  convite do host: ${invite}`);
  const parts = /:(\d+) · código ([A-Z0-9]+)$/.exec(invite);
  if (!check('host: convite com IP:porta e código', !!parts)) throw new Error('sem convite');

  const guest = await launch('convidado');
  await guest.click('#bo1z-coop-item');
  await guest.type('[data-nav=name]', 'Irmão');
  await guest.click('[data-nav=ip]');
  // convite colado como veio do host; sem IP de rede local na máquina, usa 127.0.0.1 com a porta do convite
  await guest.type('[data-nav=address]', invite.startsWith('?') ? `127.0.0.1:${parts[1]} · código ${parts[2]}` : invite);
  await guest.click('[data-nav=ip-go]');
  check('convidado: entrou na sala do host (selo LAN e nome do host)', await guest.until(
    `${all('.bz-badge')}.some(b => b.textContent === 'LAN') && ${q('.bz-member .bz-name-text')}?.textContent === 'Davi'`, 20000));
  check('host: vê o convidado com o nome dele, LAN e ping em ms', await host.until(
    `${all('.bz-name-text')}.some(n => n.textContent === 'Irmão') && /ms$/.test(${q('.bz-ping')}?.textContent ?? '')`, 15000));
  await guest.click('[data-nav=ready]');
  check('convidado: PRONTO: SIM', await guest.until(`${q('[data-nav=ready]')}?.textContent.includes('SIM')`));
  check('host: vê o convidado PRONTO', await host.until(`!!${q('.bz-ready[data-ready]')}`));
  check('host: INICIAR PARTIDA aceso com o convidado pronto', await host.eval(`!${q('[data-nav=start]')}?.hasAttribute('data-dim')`));
  const before = await guest.text('.bz-art-name');
  await host.eval(`${q('[data-nav=map]')}.focus()`);
  await host.key('ArrowRight');
  check('convidado: vê o mapa que o host escolheu', await guest.until(`${q('.bz-art-name')}?.textContent !== ${JSON.stringify(before)}`));
  await host.shot('app-03-host-com-convidado.png');
  await guest.shot('app-04-convidado-pronto.png');

  await host.click('[data-nav=leave]');
  check('host: sair com convidado pede confirmação', await host.until(`!${q('.bz-confirm')}.hidden`));
  await host.click('.bz-confirm [data-nav=yes]');
  check('host: voltou ao início', await host.until(`${q('.bz-title')}?.textContent === 'JOGAR COM AMIGOS' && !!${q('[data-nav=create]')}`));
  // O HOST SAIU quando o BYE do host chega; CONEXÃO PERDIDA quando o convidado só percebe pelo timeout de 10 s do UDP
  // (hoje CoopHost.close() em app/coop/udp.js fecha o socket logo depois de mandar o BYE, e o BYE se perde).
  check('convidado: aviso claro de que o host saiu ou caiu',
    await guest.until(`/O HOST SAIU|CONEXÃO PERDIDA/.test(${q('.bz-alert')}?.textContent ?? '')`, 15000));
  const how = await guest.text('.bz-alert strong');
  console.log(`  convidado viu: ${how}${how === 'O HOST SAIU' ? '' : ' (o BYE do host não chegou; percebeu pelo timeout)'}`);
  await guest.shot('app-05-convidado-host-saiu.png');
  host.page.close(); guest.page.close();
}

main().catch(error => { failures++; console.error(error); })
  .then(async () => {
    await cleanup();
    console.log(failures ? `\n${failures} falha(s)` : '\ntudo certo');
    process.exit(failures ? 1 : 0);
  });
