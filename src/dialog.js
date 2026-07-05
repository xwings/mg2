// NPC dialog + cutscene runner.
//
// An NPC's dialog block lives at `.15T` entries [rawIdx*10 .. rawIdx*10+9]
// (disasm 0x2D86 → 0x8840). Sub-entry 0 is the flag-check dispatch table
// (handled by lookupStride60), +1 is the default page, +2..+9 are
// alternates selected by quest state.
//
// State-mutating opcodes (FF20 flag set, FF60 NPC teleport, etc.) fire
// via `applyScriptOps` when the player advances to each page. A callback
// (`onPageOpsApplied`) lets the host re-evaluate quest-flag-dependent
// systems (SJN blockers) immediately after each page.
//
// Shopkeepers/inns are NOT a separate NPC table: their dialog terminates
// in FF01 (inn) / FF02 (item shop) / FF03 (equip shop), and the trade UI
// opens when the dialog's last page is dismissed (disasm 0x8B82/0x8BAC/
// 0x8BD6).

import {runScript15T, runScript15Tat, lookupStride60, applyScriptOps} from './script.js';

export function createDialogSystem({
  state, npcData, getScript, shop, ST, scriptCtx, onPageOpsApplied, onClose,
}){
  // Dialog state — read by the renderer for the dialog box, updated here.
  let currentNPC = null;
  let currentNPCName = '';
  let pages = [];
  let ops = [];
  let pageIdx = 0;
  let appliedFor = -1;
  let shopOp = null;      // pending FF01/FF02/FF03 from the current dialog

  function getState(){
    return {currentNPC, currentNPCName, pages, pageIdx};
  }

  // Run the state-mutating ops for the current page (once per page).
  function applyPageOps(){
    if(appliedFor === pageIdx) return;
    applyScriptOps(ops, pageIdx, scriptCtx);
    appliedFor = pageIdx;
    if(onPageOpsApplied) onPageOpsApplied();
  }

  // Dialog dismissed — either hand over to the shop UI (FF01/02/03
  // terminator) or return to play.
  function finish(){
    // Trailing ops (pushed after the last page flush, e.g. an FF80 tile
    // stamp at the end of a script) carry pageIdx == pages.length and
    // would otherwise never fire.
    applyScriptOps(ops, pages.length, scriptCtx);
    if(onPageOpsApplied) onPageOpsApplied();
    currentNPC = null;
    if(onClose) onClose();
    const op = shopOp;
    shopOp = null;
    if(op){
      if(op.op === 0xFF01) shop.openInn(op.price, ST);
      else shop.openShop(op.stock, op.op === 0xFF03 ? 'equip' : 'items', ST);
      return;
    }
    state.state = ST.PLAY;
  }

  function advance(){
    pageIdx++;
    if(pageIdx >= pages.length){
      finish();
      return;
    }
    applyPageOps();
  }
  function close(){
    finish();
  }

  function setResult(r){
    pages = r.pages;
    ops = r.ops || [];
    shopOp = ops.find(o => o.op >= 0xFF01 && o.op <= 0xFF03) || null;
    pageIdx = 0;
    appliedFor = -1;
    for(const eff of r.effects){ if(eff.type === 'gold') state.gold += eff.value; }
  }

  // Open a freeform script entry (used for cutscenes like TS001).
  // Returns true on success (pages present), false otherwise.
  async function runScript(scriptName, entryIdx, speakerName, speakerSprite){
    const scr = await getScript(scriptName);
    if(!scr) return false;
    return openResult(runScript15T(scr, entryIdx), speakerName, speakerSprite);
  }

  // Open a parsed script-run result directly (used for stride-60
  // fountain / notice-board scripts that don't map to a normal entry).
  function openResult(r, speakerName = '', speakerSprite = null){
    if(!r || (r.pages.length === 0 && !(r.ops || []).some(o => o.op >= 0xFF01 && o.op <= 0xFF03))) return false;
    setResult(r);
    currentNPCName = speakerName;
    currentNPC = speakerSprite != null ? {sprite: speakerSprite} : null;
    if(pages.length === 0){ finish(); return true; }   // pure shop stub
    state.state = ST.NPC_TALK;
    applyPageOps();
    return true;
  }

  // Open an NPC's dialog via the stride-60 flag dispatcher — the same
  // path MG2.EXE takes (0x2D86 → 0x8840 with dx = rawIdx). Falls back to
  // scanning sub-entries 1-4 when the dispatch table yields nothing.
  async function openNPCTalk(npc){
    const aScript = npcData[state.curArea]?.script || '';
    const rawIdx = npc.rawIdx ?? (npcData[state.curArea]?.npcs || []).indexOf(npc);
    const scr = await getScript(aScript);
    if(!scr) return {opened: 'none', reason: 'no-script', scriptName: aScript};
    let r = null;
    const sub = lookupStride60(scr, rawIdx, scriptCtx.flags);
    if(sub) r = runScript15Tat(scr, sub.off, sub.size);
    if(!r || (r.pages.length === 0 && r.ops.length === 0)){
      for(let p = 1; p <= 4; p++){
        const idx = rawIdx * 10 + p;
        if(idx >= scr.entries.length) continue;
        const alt = runScript15T(scr, idx);
        if(alt.pages.length > 0){ r = alt; break; }
      }
    }
    if(!r || (r.pages.length === 0 && !r.ops.some(o => o.op >= 0xFF01 && o.op <= 0xFF03))){
      return {opened: 'none', reason: 'empty', rawIdx};
    }
    setResult(r);
    currentNPC = npc;
    currentNPCName = '';
    if(pages.length === 0){ finish(); return {opened: 'shop', rawIdx}; }
    state.state = ST.NPC_TALK;
    applyPageOps();
    return {opened: 'dialog', rawIdx};
  }

  return {
    openNPCTalk, runScript, openResult, advance, close, applyPageOps, getState,
    get currentNPC(){ return currentNPC; },
    get currentNPCName(){ return currentNPCName; },
    get pages(){ return pages; },
    get pageIdx(){ return pageIdx; },
  };
}
