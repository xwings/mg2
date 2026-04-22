export const W = 320, H = 200, TW = 12, TH = 10;
export const VCOLS = 27, VROWS = 20;
export const MCOLS = 208, MROWS = 155;
export const LAYER2_OFF = MCOLS * MROWS * 2;
export const VOID = 0x07FF, TRANSP = 0xFF;
export const SMP_T = 1500, DOOR_T = 500, DOOR_B = 1500;
export const FPS = 30, DT = 1000 / FPS;
// Direction encoding (disasm 0x388D-0x3AAA NPC AI):
//   0 = UP   (Y--)   → PLAYER.TOS frames 0-1
//   1 = DOWN (Y++)   → frames 2-3
//   2 = LEFT (X--)   → frames 4-5
//   3 = RIGHT(X++)   → frames 6-7
// POL.DAT NPC `flag & 3` uses the same code, as do the FF70 walk opcode and
// player movement keys.
export const DIR_FRAMES = {0: [0, 1], 1: [2, 3], 2: [4, 5], 3: [6, 7]};
export const SAVE_KEY = 'mg2_save';

export async function loadBin(p){
  const r = await fetch('mg2/' + p);
  if(!r.ok) throw new Error('mg2/' + p);
  return r.arrayBuffer();
}
