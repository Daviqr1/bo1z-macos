// Mapas do vel.gg (MAP_LIST de https://vel.gg/bo1z/maps.js). Mesma lista e mesmo leitor do app (app/coop/session.js,
// CommonJS do Electron); a aba atualiza a lista lendo o maps.js do site como texto. Importar o maps.js na página não
// serve: ele fixa o mapa da página no primeiro import (landing.js evita isso pelo mesmo motivo).
export const DEFAULT_MAPS = Object.freeze([
  { zone: 'zombie_pentagon', slug: 'five', name: 'Five' },
  { zone: 'zombie_theater', slug: 'kino', name: 'Kino der Toten' },
  { zone: 'zombie_cod5_factory', slug: 'riese', name: 'Der Riese' },
  { zone: 'zombie_cod5_prototype', slug: 'nacht', name: 'Nacht der Untoten' },
  { zone: 'zombie_cod5_asylum', slug: 'verruckt', name: 'Verrückt' },
  { zone: 'zombie_cod5_sumpf', slug: 'shinonuma', name: 'Shi No Numa' },
  { zone: 'zombie_cosmodrome', slug: 'ascension', name: 'Ascension' },
  { zone: 'zombie_coast', slug: 'cotd', name: 'Call of the Dead' },
  { zone: 'zombie_temple', slug: 'shangrila', name: 'Shangri-La' },
  { zone: 'zombie_moon', slug: 'moon', name: 'Moon' },
].map(m => Object.freeze(m)));

export function parseMapList(text) {
  const list = [];
  for (const m of String(text).matchAll(/\{\s*zone:\s*'([a-z0-9_]+)',\s*slug:\s*'([a-z0-9_-]+)',\s*name:\s*'([^']{1,40})'/g))
    list.push({ zone: m[1], slug: m[2], name: m[3] });
  return list;
}
