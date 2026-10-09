// Cliente mínimo do DevTools (127.0.0.1:<porta>) para as ferramentas: acha a aba do vel.gg e avalia expressões nela.
export async function connectPage(port = 9334, { match = 'vel.gg' } = {}) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = targets.find(t => t.type === 'page' && t.url.includes(match));
  if (!page) throw new Error(`nenhuma aba ${match} no DevTools ${port}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0, closed = false;
  const pending = new Map();
  ws.onclose = () => { closed = true; for (const r of pending.values()) r({ error: { message: 'fechado' } }); pending.clear(); };
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } };
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`DevTools ${port}: falha no WebSocket`)); });
  const send = (method, params = {}) => new Promise(resolve => {
    if (closed) return resolve({ error: { message: 'fechado' } });
    const i = ++id; pending.set(i, resolve); ws.send(JSON.stringify({ id: i, method, params }));
  });
  // Avalia na página; a expressão deve devolver algo serializável (ou uma Promise disso).
  const evaluate = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.error) throw new Error(r.error.message);
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? r.result.exceptionDetails.text);
    return r.result?.result?.value;
  };
  return { url: page.url, evaluate, send, close: () => ws.close(), get closed() { return closed; } };
}

export const sleep = ms => new Promise(r => setTimeout(r, ms));
