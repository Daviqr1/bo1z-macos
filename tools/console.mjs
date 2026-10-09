// Digita comandos no console do motor de uma instância do app (via DevTools), como se fosse no teclado.
// node tools/console.mjs [porta=9334] "connect localhost" ["outro comando" ...]
// Exemplos: "connect localhost" (convidado, estratégia manual), "addtestclient" (bot no host), "status", "setqport 4321".
// Usa o KB_Input cru (sem passar pelo grampo I1): abre o console (~ = 126), digita cada comando + Enter (13), fecha.
import { connectPage } from './cdp.mjs';

const args = process.argv.slice(2);
const port = /^\d+$/.test(args[0] ?? '') ? Number(args.shift()) : 9334;
if (!args.length) { console.error('uso: node tools/console.mjs [porta] "comando" ...'); process.exit(2); }

const page = await connectPage(port);
const result = await page.evaluate(`(async cmds => {
  const input = globalThis.__bo1zKBInput ?? globalThis.__bo1zKB?.module?._KB_Input;
  if (!input) return 'sem KB_Input: o glue servido não tem os patches I1/N1';
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const key = async k => { input(0, k, 1); await wait(40); input(0, k, 0); await wait(40); };
  await key(126);
  for (const cmd of cmds) {
    for (const ch of cmd) { input(1, ch.codePointAt(0), 0); await wait(10); }
    await key(13);
    await wait(150);
  }
  await key(126);
  return 'ok';
})(${JSON.stringify(args)})`);
console.log(`[${port}] ${result}`);
page.close();
