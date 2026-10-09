// Observa as instâncias de um teste de co-op pelo DevTools e grava tudo o que responde às perguntas abertas da spec.
// node tools/coop-probe.mjs --out <pasta> host:9334 convidado:9335 [--minutes 40] [--quiet]
// (--quiet: sem a linha de status ao vivo; SIGINT ou SIGTERM gravam o resumo e saem)
// Por instância (1 s): tela/mapa, estatísticas da ponte (__bo1zCoop.stats()), linhas novas do console do motor
// (five.console; sem o spam de WEB_GPU e com 1 linha de "view" a cada 5 s). Grava <pasta>/<nome>.jsonl e, no fim
// (Ctrl+C ou --minutes), <pasta>/resumo.md com um veredito por pergunta e as linhas de console que importam.
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { connectPage, sleep } from './cdp.mjs';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); if (i < 0) return dflt; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const out = opt('--out', `coop-probe-${new Date().toISOString().replace(/[:.]/g, '-')}`);
const minutes = Number(opt('--minutes', 40));
const quiet = argv.includes('--quiet') && (argv.splice(argv.indexOf('--quiet'), 1), true);
const targets = (argv.length ? argv : ['host:9334', 'convidado:9335']).map(s => { const [name, port] = s.split(':'); return { name, port: Number(port) }; });
mkdirSync(out, { recursive: true });

const INTERESTING = /connect|challenge|gamestate|Com_ERROR|ERROR|Scr_Error|script runtime|SV_|CL_|disconnect|EXE_|Going from|frontend|devmap|map_restart|loadingnewmap|spawn|client|player|qport|BO1Z_COOP|KISAK_BROWSER (engine|map|ready)|Loaded fastfile|out of memory|Sys_Error/i;
const state = Object.fromEntries(targets.map(t => [t.name, { seen: 0, screens: [], lines: [], last: null, lastView: 0, errors: 0 }]));

const SNAPSHOT = since => `(() => {
  const s = globalThis.five, c = s?.console ?? [], total = c.length + (s?.consoleDiscarded ?? 0);
  const fresh = c.slice(Math.max(0, c.length - (total - ${since})));
  return JSON.stringify({ screen: document.body?.dataset.screen ?? null, map: document.documentElement.dataset.map ?? null,
    total, coop: globalThis.__bo1zCoop?.stats?.() ?? null, kb: !!globalThis.__bo1zKB,
    lines: fresh.map(x => (x.error ? '!' : '') + String(x.message).slice(0, 2000)) });
})()`;

async function watch(t) {
  const st = state[t.name], file = `${out}/${t.name}.jsonl`;
  const write = o => appendFileSync(file, JSON.stringify({ t: Date.now(), ...o }) + '\n');
  while (!stop) {
    let page;
    try { page = await connectPage(t.port); } catch (error) { st.last = { error: error.message }; await sleep(2000); continue; }
    write({ k: 'page', url: page.url });
    st.seen = 0;
    while (!stop && !page.closed) {
      let o;
      try { o = JSON.parse(await page.evaluate(SNAPSHOT(st.seen))); } catch (error) { st.last = { error: error.message }; break; }
      st.seen = o.total;
      for (const line of o.lines) {
        if (/^!?WEB_GPU/.test(line)) continue;
        if (/KISAK_BROWSER view/.test(line)) { if (Date.now() - st.lastView < 5000) continue; st.lastView = Date.now(); }
        if (line.startsWith('!')) ++st.errors;
        write({ k: 'c', line });
        if (INTERESTING.test(line)) { st.lines.push(`${new Date().toISOString().slice(11, 19)} ${line.slice(0, 400)}`); if (st.lines.length > 400) st.lines.shift(); }
      }
      if (o.screen !== st.screens.at(-1)?.screen) { st.screens.push({ at: new Date().toISOString().slice(11, 19), screen: o.screen, map: o.map }); write({ k: 's', screen: o.screen, map: o.map }); }
      if (o.coop) write({ k: 'coop', stats: o.coop });
      st.last = o;
      await sleep(1000);
    }
    page.close();
    await sleep(1000);
  }
}

function line(name) {
  const o = state[name].last;
  if (!o) return `${name}: …`;
  if (o.error) return `${name}: ${o.error}`;
  const c = o.coop, b = c?.bridge;
  if (!c) return `${name}: ${o.screen ?? '-'} ${o.map ?? ''} | co-op ${o.kb ? 'motor ok, ponte não iniciou' : 'sem motor ainda'}`;
  return `${name}: ${o.screen} ${o.map ?? ''} | pacotes in ${c.traffic.in} out ${c.traffic.out} | ` +
    `cas ${b.casRetries} clob ${b.clobbered} fant ${b.phantom} fila ${b.pending} perdidos ${b.dropped}` + (c.net?.rtt != null ? ` | rtt ${c.net.rtt} ms` : '');
}

function verdicts() {
  const host = Object.values(state)[0]?.last?.coop, guest = Object.values(state)[1]?.last?.coop;
  const g = Object.values(state)[1];
  const hostLines = Object.values(state)[0]?.lines ?? [], guestLines = g?.lines ?? [];
  const any = (lines, re) => lines.some(l => re.test(l));
  const v = [];
  v.push(`1. tag k chega ao servidor e ele responde no ring k: ${host?.bridge?.drainedForGuests > 0 ? 'SIM' : 'não observado'} ` +
    `(host drenou ${host?.bridge?.drainedForGuests ?? 0} pacotes dos rings dos convidados; convidado recebeu ${guest?.traffic?.in ?? 0})`);
  v.push(`2. corrida de 2 produtores no ring 1 do host: CAS refeitos ${host?.bridge?.casRetries ?? '?'}, clobbers ${host?.bridge?.clobbered ?? '?'}, ` +
    `fantasmas ${host?.bridge?.phantom ?? '?'} em ${host?.bridge?.injectedToServer ?? '?'} injetados`);
  v.push(`3. convidado sem servidor local carrega o mapa pelo connect: telas do convidado ${g?.screens.map(s => s.screen).join(' → ') || '?'}; ` +
    `connectResponse ${any(guestLines, /connectResponse/) ? 'visto' : 'não visto'}; gamestate ${any(guestLines, /gamestate/i) ? 'visto' : 'não visto'}; ` +
    `erros no console do convidado: ${g?.errors ?? '?'}`);
  v.push(`4. o script conta o convidado: confira na tela do host (dois jogadores no placar?). Linhas de conexão no host: ` +
    `${any(hostLines, /Going from CS_FREE to CS_CONNECTED|connected/i) ? 'sim' : 'nenhuma vista'}`);
  return v;
}

let stop = false;
const finish = () => {
  if (stop) return;
  stop = true;
  const md = [`# Teste de co-op — ${new Date().toISOString()}`, '', '## Perguntas abertas', '', ...verdicts(), '',
    ...Object.entries(state).flatMap(([name, st]) => [`## ${name}`, '', `Telas: ${st.screens.map(s => `${s.at} ${s.screen}`).join(', ')}`, '',
      'Estatísticas finais:', '', '```json', JSON.stringify(st.last?.coop ?? st.last, null, 1)?.slice(0, 6000) ?? '', '```', '',
      'Linhas de console relevantes:', '', '```', ...st.lines.slice(-200), '```', ''])];
  writeFileSync(`${out}/resumo.md`, md.join('\n'));
  console.log(`\nresumo: ${out}/resumo.md`);
  setTimeout(() => process.exit(0), 300);
};
process.on('SIGINT', finish);
process.on('SIGTERM', finish);
setTimeout(finish, minutes * 60e3);

for (const t of targets) watch(t);
while (!stop) {
  if (!quiet) process.stdout.write('\r' + targets.map(t => line(t.name)).join('  ||  ').slice(0, 400).padEnd(200));
  else writeFileSync(`${out}/status.txt`, targets.map(t => line(t.name)).join('\n') + '\n');
  await sleep(1000);
}
