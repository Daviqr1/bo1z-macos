// Preferências da extensão (chrome.storage.local): nome do jogador e servidor de sinalização. O documento offscreen
// não acessa chrome.storage: as abas e o popup mandam as preferências para ele.
import { DEFAULT_SIGNAL } from './defaults.mjs';
import { normalizeSignal } from './invite.mjs';

export const cleanName = name => String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);

export async function loadPrefs(storage) {
  let saved = {};
  try { saved = await storage.get(['name', 'signal']); } catch { /* sem storage: padrões */ }
  return { name: cleanName(saved.name), signal: saved.signal || DEFAULT_SIGNAL || '' };
}

// Grava só o que é válido; devolve { ok, prefs?, error? } (mensagens para a tela de opções).
export async function savePrefs(storage, { name, signal } = {}) {
  const patch = {};
  if (name !== undefined) patch.name = cleanName(name);
  if (signal !== undefined) {
    const text = String(signal).trim();
    if (text && !normalizeSignal(text))
      return { ok: false, error: 'Servidor inválido: use o endereço (ex.: bo1z-signal.fulano.workers.dev) ou uma URL https://.' };
    patch.signal = text;
  }
  await storage.set(patch);
  return { ok: true, prefs: await loadPrefs(storage) };
}
