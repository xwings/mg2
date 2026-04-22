// Item-name resolution for inventory / pickup labels.
//
// MG2 ships four shared string tables (MG2.15, M.15, ATT.15, P.15) each
// holding a different CATEGORY of names: UI labels, spells, weapons,
// potions. The original engine swaps which file is mapped into EMS pages
// 4-5 vs 6-7 depending on context (disasm 0xA21 vs 0xA6F).
//
// Our cascade: given a pickup's `kind` (from GEM.DAT flag2_hi), try each
// table in priority order. First table with ≥ 2 glyphs wins. Equipment
// pickups from `.15T` scripts (disasm 0x85A9 → 0x8840) fall back to the
// area script's first page.

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

  // Returns {glyphs, source} or null. `kind` is 'basic' | 'equip' | 'magic'.
  function lookupItemTable(itemId, kind){
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
