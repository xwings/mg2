// NPC dialog + cutscene runner.
//
// An NPC's dialog block lives at `.15T` entries [rawIdx*10 .. rawIdx*10+9]
// (disasm 0x2D86 → 0x8840). Entry +0 is an FF10-conditional dispatch
// stub, +1 is the default page, +2..+9 are alternates selected by quest
// state. We try the default then a few alternates if the default is empty.
//
// State-mutating opcodes (FF20 flag set, FF60 NPC teleport, etc.) fire
// via `applyScriptOps` when the player advances to each page. A callback
// (`onPageOpsApplied`) lets the host re-evaluate quest-flag-dependent
// systems (SJN blockers) immediately after each page.

import {runScript15T, applyScriptOps} from './script.js';

export function createDialogSystem({
  state, npcData, getScript, shop, ST, scriptCtx, onPageOpsApplied,
}){
  // Dialog state — read by the renderer for the dialog box, updated here.
  let currentNPC = null;
  let currentNPCName = '';
  let pages = [];
  let ops = [];
  let pageIdx = 0;
  let appliedFor = -1;

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

  function advance(){
    pageIdx++;
    if(pageIdx >= pages.length){
      state.state = ST.PLAY;
      currentNPC = null;
      return;
    }
    applyPageOps();
  }
  function close(){
    state.state = ST.PLAY;
    currentNPC = null;
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
    if(!r || r.pages.length === 0) return false;
    pages = r.pages;
    ops = r.ops || [];
    pageIdx = 0;
    appliedFor = -1;
    currentNPCName = speakerName;
    currentNPC = speakerSprite != null ? {sprite: speakerSprite} : null;
    for(const eff of r.effects){ if(eff.type === 'gold') state.gold += eff.value; }
    state.state = ST.NPC_TALK;
    applyPageOps();
    return true;
  }

  // Open an NPC's dialog. Falls through to the shop/inn UI if the NPC
  // is registered in SHOP_BY_NPC; returns null/empty if no dialog exists.
  async function openNPCTalk(npc){
    const aScript = npcData[state.curArea]?.script || '';
    const rawIdx = npc.rawIdx ?? (npcData[state.curArea]?.npcs || []).indexOf(npc);
    if(shop.tryOpenShop(state.curArea, rawIdx, ST)) return {opened: 'shop'};
    const scr = await getScript(aScript);
    if(!scr) return {opened: 'none', reason: 'no-script', scriptName: aScript};
    let found = false;
    for(let p = 1; p <= 4; p++){
      const idx = rawIdx * 10 + p;
      if(idx >= scr.entries.length) continue;
      const r = runScript15T(scr, idx);
      if(r.pages.length > 0){
        pages = r.pages;
        ops = r.ops || [];
        for(const eff of r.effects){ if(eff.type === 'gold') state.gold += eff.value; }
        found = true;
        break;
      }
    }
    if(!found) return {opened: 'none', reason: 'empty', rawIdx};
    currentNPC = npc;
    currentNPCName = '';
    pageIdx = 0;
    appliedFor = -1;
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
