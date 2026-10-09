// Tela de opções: nome do jogador e servidor de sinalização (chrome.storage.local; as abas repassam ao offscreen).
import { loadPrefs, savePrefs } from './lib/prefs.mjs';

const $ = id => document.getElementById(id);
const prefs = await loadPrefs(chrome.storage.local);
$('name').value = prefs.name;
$('signal').value = prefs.signal;

$('form').addEventListener('submit', async event => {
  event.preventDefault();
  const r = await savePrefs(chrome.storage.local, { name: $('name').value, signal: $('signal').value });
  $('msg').className = `msg ${r.ok ? 'ok' : 'bad'}`;
  $('msg').textContent = r.ok ? 'Salvo.' : r.error;
  if (r.ok) { $('name').value = r.prefs.name; $('signal').value = r.prefs.signal; }
});
