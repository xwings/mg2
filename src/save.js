// 5-slot JSON save system in localStorage.
// Key: mg2_save_N  (N = 0..4). Each slot holds a {meta, state} blob.
// Slot 0 is the "quick save" slot targeted by legacy code paths.

const NUM_SLOTS = 5;
const slotKey = (n) => 'mg2_save_' + n;

export function saveToSlot(slot, data){
  if(slot < 0 || slot >= NUM_SLOTS) return false;
  try {
    const blob = {
      meta: {
        slot,
        time: Date.now(),
        area: data.area,
        map: data.map || '',
        hp: data.hp,
        maxHp: data.maxHp,
        gold: data.gold,
        pX: data.pX,
        pY: data.pY,
      },
      state: data,
      version: 1,
    };
    localStorage.setItem(slotKey(slot), JSON.stringify(blob));
    return true;
  } catch(e){ return false; }
}

export function loadFromSlot(slot){
  if(slot < 0 || slot >= NUM_SLOTS) return null;
  try {
    const s = localStorage.getItem(slotKey(slot));
    if(!s) return null;
    const blob = JSON.parse(s);
    return blob.state || null;
  } catch(e){ return null; }
}

export function slotExists(slot){
  return !!localStorage.getItem(slotKey(slot));
}

// Summary of all 5 slots for the load/save menu — nulls for empty slots.
export function listSlots(){
  const out = [];
  for(let i = 0; i < NUM_SLOTS; i++){
    const s = localStorage.getItem(slotKey(i));
    if(!s){ out.push(null); continue; }
    try {
      const blob = JSON.parse(s);
      out.push(blob.meta || null);
    } catch(e){ out.push(null); }
  }
  return out;
}

export function deleteSlot(slot){
  if(slot < 0 || slot >= NUM_SLOTS) return false;
  localStorage.removeItem(slotKey(slot));
  return true;
}

// Trigger a browser download of slot N as a JSON file. The browser will
// save to the user's Downloads folder — we have no filesystem access from
// JS, so this is the only way to get the save off localStorage.
export function exportSlotToFile(slot){
  if(slot < 0 || slot >= NUM_SLOTS) return false;
  const raw = localStorage.getItem(slotKey(slot));
  if(!raw) return false;
  const blob = new Blob([raw], {type: 'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  // Stamp filename with the slot and current date so multiple exports don't collide.
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  a.download = `mg2_save_${slot + 1}_${ts}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}

// Open a native file picker, read the chosen JSON, and overwrite slot N in
// localStorage. Resolves with {ok, error} — ok=true means the slot was
// updated and the caller should refresh its slot list.
export function importFileToSlot(slot){
  if(slot < 0 || slot >= NUM_SLOTS) return Promise.resolve({ok: false, error: 'bad slot'});
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.style.display = 'none';
    document.body.appendChild(input);
    const cleanup = () => input.remove();
    // `cancel` fires when the user closes the dialog without picking.
    input.addEventListener('cancel', () => { cleanup(); resolve({ok: false, error: 'cancelled'}); });
    input.addEventListener('change', async () => {
      const f = input.files && input.files[0];
      if(!f){ cleanup(); resolve({ok: false, error: 'no file'}); return; }
      try {
        const text = await f.text();
        // Validate: must parse and look like our blob shape. We don't
        // attempt schema migration here — just enough to reject junk.
        const blob = JSON.parse(text);
        if(!blob || typeof blob !== 'object' || !blob.state){
          cleanup(); resolve({ok: false, error: 'invalid save file'}); return;
        }
        localStorage.setItem(slotKey(slot), text);
        cleanup();
        resolve({ok: true});
      } catch(e){
        cleanup();
        resolve({ok: false, error: 'parse error'});
      }
    });
    input.click();
  });
}

export const SAVE_SLOTS = NUM_SLOTS;

// Legacy helpers — route to slot 0 so existing callers keep working.
export function saveGame(s){ return saveToSlot(0, s); }
export function loadGameState(){ return loadFromSlot(0); }
export function hasSave(){
  for(let i = 0; i < NUM_SLOTS; i++) if(slotExists(i)) return true;
  return false;
}
