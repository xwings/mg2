// Item-name resolution for inventory / pickup labels.
//
// The original renders EVERY item name from P.15 at the raw item id:
// inventory draw 0x4b87, shop buy/sell 0x776f/0x79f0/0x4c19 all call the
// P.15 glyph renderer (0xA21, EMS pages 4-5 filled from `.\D\P.15` by the
// boot loader at 0xaaed) with bx = item id. M.15 holds spell names,
// MG2.15 UI labels, ATT.15 battle strings — none of them item names.
//
// The old per-kind cascade (TRY_BY_TYPE) predates that finding; it's kept
// only as a fallback for ids with no P.15 entry, then the area script's
// first page (legacy path for odd pickups).

import {runScript15T} from './script.js';

export function createItemNameResolver({tryByType, tables, getScript, getCurrentAreaScript}){
  function pageToGlyphs(page){
    if(!page || page.length === 0) return null;
    const chunks = [];
    for(const line of page){
      for(const cell of line){
        if(cell.glyph) chunks.push(cell.glyph);
      }
    }
    if(chunks.length === 0) return null;
    const out = new Uint8Array(chunks.length * 30);
    for(let i = 0; i < chunks.length; i++) out.set(chunks[i], i * 30);
    return out;
  }

  // Returns {glyphs, source} or null. P.15[id] is authoritative; the
  // kind-based cascade only fills gaps.
  function lookupItemTable(itemId, kind){
    const p15 = tables.potion && tables.potion[itemId];
    if(p15) return {glyphs: p15, source: 'potion'};
    const tries = tryByType[kind] || tryByType.basic;
    let fallback = null, fallbackSrc = null;
    for(const [src] of tries){
      const g = tables[src][itemId];
      if(!g) continue;
      if(g.length / 30 >= 2) return {glyphs: g, source: src};
      if(!fallback){ fallback = g; fallbackSrc = src; }
    }
    return fallback ? {glyphs: fallback, source: fallbackSrc} : null;
  }

  async function resolveItemName(itemId, kind = 'basic'){
    const fromTable = lookupItemTable(itemId, kind);
    if(fromTable) return fromTable;
    const scriptName = getCurrentAreaScript();
    if(!scriptName) return null;
    const scr = await getScript(scriptName);
    if(!scr || itemId >= scr.entries.length) return null;
    const r = runScript15T(scr, itemId);
    const glyphs = pageToGlyphs(r.pages[0]);
    return glyphs ? {glyphs, source: 'script'} : null;
  }

  return {pageToGlyphs, lookupItemTable, resolveItemName};
}
