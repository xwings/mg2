#!/usr/bin/env python3
"""
mg2tools — unified CLI for reverse-engineering MG2's binary formats.

Replaces the previous pile of one-off .mjs scripts with a single Python
entry point. Subcommands are grouped into:

  disasm        — Capstone disassembly of MG2.EXE + ATT.LOD → disasm/
  dump-enemy    — ENEMY.TOS sprite sheet / paginated / single frame
  dump-pol001   — POL001.TOS NPC catalog (80 chars × idle-down frame)
  dump-pol      — POL.DAT patrol-path survey (stdout)
  dump-mg215    — MG2.15 glyph entries as ASCII (stdout)
  dump-names    — render entries 0-30 of every .15 as a PPM strip
  dump-sjn      — SJN.DAT quest-blocker rule table (stdout)
  scan-ops      — .15T state-mutating opcode scanner (stdout)
  smoke-15t     — parse every .15T, flag any that crash the interpreter

Image outputs land in ./dump/ (PPM — view with any modern image viewer,
or convert via ImageMagick:  magick dump/foo.ppm foo.png). Text reports
go to stdout unless --out is passed.

The script is intentionally self-contained — no dependencies beyond the
Python standard library and (for disasm subcommands only) `capstone`.
"""
from __future__ import annotations

import argparse
import os
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MG2 = ROOT / "mg2"
DUMP = ROOT / "dump"


# ----------------------------------------------------------------------
# Shared helpers
# ----------------------------------------------------------------------

def load_palette(path: Path = MG2 / "D" / "VGAM.DAC") -> bytes:
    return path.read_bytes()


def pal_rgb(pal: bytes, idx: int) -> tuple[int, int, int]:
    """VGA DAC → full-range RGB (stored as 6-bit, scaled to 8-bit)."""
    r = pal[idx * 3]
    g = pal[idx * 3 + 1]
    b = pal[idx * 3 + 2]
    return ((r << 2) | (r >> 4), (g << 2) | (g >> 4), (b << 2) | (b >> 4))


def write_ppm(path: Path, w: int, h: int, rgb: bytes | bytearray) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    header = f"P6\n{w} {h}\n255\n".encode("ascii")
    with path.open("wb") as f:
        f.write(header)
        f.write(bytes(rgb))


def u16le(buf: bytes, off: int) -> int:
    return buf[off] | (buf[off + 1] << 8)


# 3×5 bitmap font for numeric labels on contact sheets.
_DIGIT_FONT = {
    "0": ["111", "101", "101", "101", "111"],
    "1": ["010", "110", "010", "010", "111"],
    "2": ["111", "001", "111", "100", "111"],
    "3": ["111", "001", "111", "001", "111"],
    "4": ["101", "101", "111", "001", "001"],
    "5": ["111", "100", "111", "001", "111"],
    "6": ["111", "100", "111", "101", "111"],
    "7": ["111", "001", "010", "100", "100"],
    "8": ["111", "101", "111", "101", "111"],
    "9": ["111", "101", "111", "001", "111"],
}


def draw_num(img: bytearray, W: int, n: int, dx: int, dy: int,
             color: tuple[int, int, int] = (255, 255, 100)) -> None:
    for c in str(n):
        rows = _DIGIT_FONT.get(c)
        if not rows:
            dx += 4
            continue
        for y in range(5):
            for x in range(3):
                if rows[y][x] == "1":
                    i = ((dy + y) * W + (dx + x)) * 3
                    if 0 <= i < len(img) - 2:
                        img[i] = color[0]
                        img[i + 1] = color[1]
                        img[i + 2] = color[2]
        dx += 4


# ----------------------------------------------------------------------
# ENEMY.TOS — variable-size sprites referenced by (u16 HIGH, u16 LOW)
# big-endian word pair offsets. Per ATT.LOD CS:0xbc68.
# ----------------------------------------------------------------------

def _enemy_frames():
    buf = (MG2 / "D" / "ENEMY.TOS").read_bytes()

    def read_off(i: int) -> int:
        return (u16le(buf, i * 4) << 16) | u16le(buf, i * 4 + 2)

    first_off = read_off(0)
    count = first_off // 4
    frames: list[dict | None] = []
    for i in range(count):
        off = read_off(i)
        if off == 0 or off + 4 >= len(buf):
            frames.append(None)
            continue
        w = u16le(buf, off) + 1
        h = u16le(buf, off + 2) + 1
        data_start = off + 4
        size = w * h
        if (data_start + size > len(buf) or w > 320 or h > 200
                or w == 0 or h == 0):
            frames.append({"off": off, "w": w, "h": h, "bad": True})
            continue
        pixels = buf[data_start:data_start + size]
        frames.append({"off": off, "w": w, "h": h, "pixels": pixels})
    return frames, count


def cmd_enemy_sheet(args):
    """Contact sheet of every ENEMY.TOS frame."""
    pal = load_palette()
    frames, count = _enemy_frames()
    valid = [f for f in frames if f and not f.get("bad")]
    print(f"ENEMY.TOS: {count} header entries, {len(valid)} valid frames")

    sizes: dict[str, int] = {}
    for f in valid:
        k = f"{f['w']}x{f['h']}"
        sizes[k] = sizes.get(k, 0) + 1
    top = sorted(sizes.items(), key=lambda kv: -kv[1])[:10]
    print("top sizes:", top)

    max_w = max(f["w"] for f in valid)
    max_h = max(f["h"] for f in valid)
    cell_w, cell_h = max_w + 4, max_h + 12
    cols = 10
    rows = (count + cols - 1) // cols
    W, H = cols * cell_w, rows * cell_h
    img = bytearray(W * H * 3)
    for i in range(0, len(img), 3):
        img[i] = img[i + 1] = img[i + 2] = 30

    for idx, f in enumerate(frames):
        if not f or f.get("bad"):
            continue
        row, col = divmod(idx, cols)
        sx = col * cell_w + (cell_w - f["w"]) // 2
        sy = row * cell_h + 2
        for y in range(f["h"]):
            for x in range(f["w"]):
                pi = f["pixels"][y * f["w"] + x]
                if pi == 0xFF:
                    r, g, b = 50, 50, 50
                else:
                    r, g, b = pal_rgb(pal, pi)
                i = ((sy + y) * W + (sx + x)) * 3
                img[i] = r
                img[i + 1] = g
                img[i + 2] = b

    out = DUMP / "enemy_sheet.ppm"
    write_ppm(out, W, H, img)
    print(f"wrote {out} ({W}×{H})")


def cmd_enemy_indexed(args):
    """Paginated labelled sheets — 50 frames per sheet, 5 cols × 10 rows."""
    pal = load_palette()
    frames, count = _enemy_frames()
    cols = 5
    cell_w, cell_h = 160, 140
    SLICE = 50
    sheet_num = 0
    for base in range(0, count, SLICE):
        rows = (min(SLICE, count - base) + cols - 1) // cols
        W, H = cols * cell_w, rows * cell_h
        img = bytearray(W * H * 3)
        for i in range(0, len(img), 3):
            img[i] = img[i + 1] = img[i + 2] = 25
        for slot in range(min(SLICE, count - base)):
            fid = base + slot
            f = frames[fid]
            r_, c_ = divmod(slot, cols)
            cx, cy = c_ * cell_w, r_ * cell_h
            draw_num(img, W, fid, cx + 2, cy + 2)
            if not f or f.get("bad"):
                continue
            sx = cx + (cell_w - f["w"]) // 2
            sy = cy + 12 + (cell_h - 12 - f["h"]) // 2
            for y in range(f["h"]):
                for x in range(f["w"]):
                    pi = f["pixels"][y * f["w"] + x]
                    if pi == 0xFF:
                        continue
                    r, g, b = pal_rgb(pal, pi)
                    i = ((sy + y) * W + (sx + x)) * 3
                    if 0 <= i < len(img) - 2:
                        img[i], img[i + 1], img[i + 2] = r, g, b
        out = DUMP / f"enemy_indexed_{sheet_num}.ppm"
        write_ppm(out, W, H, img)
        print(f"sheet {sheet_num}: ids {base}..{min(base+SLICE-1, count-1)}"
              f"  {W}×{H}  -> {out}")
        sheet_num += 1


def cmd_enemy_single(args):
    """Single frame at 3× scale — useful for verifying fine detail."""
    pal = load_palette()
    frames, _count = _enemy_frames()
    fid = args.id
    f = frames[fid] if 0 <= fid < len(frames) else None
    if not f or f.get("bad"):
        sys.exit(f"no valid frame at id={fid}")
    scale = args.scale
    w, h = f["w"] * scale, f["h"] * scale
    img = bytearray(w * h * 3)
    for i in range(0, len(img), 3):
        img[i] = img[i + 1] = img[i + 2] = 30
    for y in range(f["h"]):
        for x in range(f["w"]):
            pi = f["pixels"][y * f["w"] + x]
            if pi == 0xFF:
                continue
            r, g, b = pal_rgb(pal, pi)
            for dy in range(scale):
                for dx in range(scale):
                    i = ((y * scale + dy) * w + (x * scale + dx)) * 3
                    img[i], img[i + 1], img[i + 2] = r, g, b
    out = DUMP / f"enemy_{fid}.ppm"
    write_ppm(out, w, h, img)
    print(f"id={fid}: {f['w']}×{f['h']} @ file 0x{f['off']:x}  -> {out}")


# ----------------------------------------------------------------------
# POL001.TOS — 80 chars × 8 frames × 24×24 raw.
# ----------------------------------------------------------------------

def cmd_pol001_sheet(args):
    """10 × 8 grid of the DOWN-idle frame of every NPC character."""
    pal = load_palette()
    buf = (MG2 / "D" / "POL001.TOS").read_bytes()
    W_SP, H_SP = 24, 24
    FRAMES_PER_CHAR = 8
    CHARS = 80
    cols, rows = 10, 8
    W = cols * (W_SP + 4)
    H = rows * (H_SP + 12)
    img = bytearray(W * H * 3)
    for i in range(0, len(img), 3):
        img[i] = img[i + 1] = img[i + 2] = 30
    for c in range(CHARS):
        r_, c_ = divmod(c, cols)
        sx = c_ * (W_SP + 4) + 2
        sy = r_ * (H_SP + 12) + 2
        frame_off = (c * FRAMES_PER_CHAR + 2) * W_SP * H_SP
        if frame_off + W_SP * H_SP > len(buf):
            break
        for y in range(H_SP):
            for x in range(W_SP):
                pi = buf[frame_off + y * W_SP + x]
                if pi == 0xFF:
                    r, g, b = 40, 40, 40
                else:
                    r, g, b = pal_rgb(pal, pi)
                i = ((sy + y) * W + (sx + x)) * 3
                img[i], img[i + 1], img[i + 2] = r, g, b
    out = DUMP / "pol001_sheet.ppm"
    write_ppm(out, W, H, img)
    print(f"wrote {out} ({W}×{H}) — char id = row*10 + col")


# ----------------------------------------------------------------------
# POL.DAT patrol path survey.
# ----------------------------------------------------------------------

def cmd_pol_patrols(args):
    buf = (MG2 / "S" / "POL.DAT").read_bytes()
    total, patrol = 0, 0
    examples = []
    for aid in range(200):
        if aid * 4 + 4 > len(buf):
            break
        off = u16le(buf, aid * 4)
        count = u16le(buf, aid * 4 + 2)
        if off == 0 or count == 0 or count > 50:
            continue
        for i in range(count):
            e = off + 28 + i * 20
            if e + 20 > len(buf):
                break
            y = u16le(buf, e)
            x = u16le(buf, e + 2)
            y2 = u16le(buf, e + 4)
            x2 = u16le(buf, e + 6)
            sprite = u16le(buf, e + 8)
            flag = u16le(buf, e + 10)
            if x == 10 and y == 10 and sprite == 0:
                continue
            total += 1
            if x != x2 or y != y2:
                patrol += 1
                if len(examples) < 20:
                    examples.append((aid, i, x, y, x2, y2, sprite, flag & 3))
    print(f"Total NPCs: {total}, with patrol path (X!=X2 || Y!=Y2): {patrol}")
    if examples:
        print("\nExamples:")
        for aid, i, x, y, x2, y2, sp, d in examples:
            print(f"  area={aid} npc#{i}: ({x},{y}) → ({x2},{y2})"
                  f" sprite={sp} dir={d}")


# ----------------------------------------------------------------------
# .15 glyph tables (MG2.15 / M.15 / ATT.15 / P.15 / STA.15).
# Each entry: (u8 glyph_count, u16 offset) then N × 30-byte 16×15 bitmap.
# ----------------------------------------------------------------------

def _parse_15(buf: bytes) -> dict[int, dict]:
    out = {}
    for i in range(1000):
        if i * 3 + 3 > len(buf):
            break
        c = buf[i * 3]
        o = u16le(buf, i * 3 + 1)
        if 0 < c < 16 and o + c * 30 <= len(buf):
            out[i] = {"count": c, "data": buf[o:o + c * 30]}
    return out


def cmd_mg215(args):
    """Render .15 glyph entries as ASCII (## = ink, spaces = background)."""
    fname = args.file
    buf = (MG2 / "D" / fname).read_bytes()
    tbl = _parse_15(buf)
    # Range: "5" -> single, "5-20" -> inclusive
    if "-" in args.range:
        lo, hi = (int(x) for x in args.range.split("-"))
    else:
        lo = hi = int(args.range)
    for i in range(lo, hi + 1):
        e = tbl.get(i)
        if not e:
            print(f"#{i}: (empty)")
            continue
        print(f"\n#{i} ({e['count']} glyphs):")
        # 16×15 per glyph, side-by-side.
        blocks = []
        for g in range(e["count"]):
            lines = []
            for row in range(15):
                w = (e["data"][g * 30 + row * 2] << 8) | e["data"][g * 30 + row * 2 + 1]
                s = ""
                for col in range(16):
                    s += "##" if (w & (1 << (15 - col))) else "  "
                lines.append(s)
            blocks.append(lines)
        for row in range(15):
            print("  " + " | ".join(b[row] for b in blocks))


def cmd_name_tables(args):
    """Render entries 0-30 of every .15 file as a PPM strip."""
    files = ["ATT.15", "MG2.15", "M.15", "P.15"]
    # Some installations also ship STA.15 (status-screen) — include if present.
    if (MG2 / "D" / "STA.15").exists():
        files.append("STA.15")

    tests = ([*range(100, 127)] + [200, 210, 211, 212, 220])

    for fname in files:
        buf = (MG2 / "D" / fname).read_bytes()
        tbl = _parse_15(buf)
        row_h = 20
        W, H = 360, row_h * len(tests) + 8
        img = bytearray(W * H * 3)
        for i in range(0, len(img), 3):
            img[i] = img[i + 1] = img[i + 2] = 30
        for t, fid in enumerate(tests):
            y = t * row_h + 2
            draw_num(img, W, fid, 4, y + 5)
            e = tbl.get(fid)
            if not e:
                continue
            for g in range(e["count"]):
                gb = e["data"][g * 30:g * 30 + 30]
                # Draw 16×15 glyph at (32 + g*17, y).
                dx0 = 32 + g * 17
                for gy in range(15):
                    hi_, lo_ = gb[gy * 2], gb[gy * 2 + 1]
                    for gx in range(16):
                        bit = ((hi_ >> (7 - gx)) & 1) if gx < 8 \
                              else ((lo_ >> (15 - gx)) & 1)
                        if bit:
                            i = ((y + gy) * W + (dx0 + gx)) * 3
                            if 0 <= i < len(img) - 2:
                                img[i], img[i + 1], img[i + 2] = 255, 255, 240
        out = DUMP / f"names_{fname}.ppm"
        write_ppm(out, W, H, img)
        print(f"wrote {out} ({len(tbl)} valid entries)")


# ----------------------------------------------------------------------
# SJN.DAT — per-area conditional NPC override table (FF80 dispatcher).
# ----------------------------------------------------------------------

_SJN_OPS = ["==", "!=", ">=", "<=", ">", "<"]
_SJN_FIELDS = {0: "Y", 2: "X", 4: "Y2", 6: "X2",
               8: "sprite", 0x0A: "flag", 0x0E: "timer", 0x10: "step"}


def cmd_sjn(args):
    d = (MG2 / "S" / "SJN.DAT").read_bytes()
    total_cond = 0
    total_areas = 0
    for aid in range(200):
        if aid * 4 + 4 > len(d):
            break
        off = u16le(d, aid * 4)
        sz = u16le(d, aid * 4 + 2)
        if not off or not sz or off + sz > len(d):
            continue
        body = d[off:off + sz]
        conds = []
        i = 0
        while i < len(body):
            if i + 4 > len(body):
                break
            w = body[i] | (body[i + 1] << 8)
            if w == 0xFF1A:
                break
            cond = {"flag": w, "op": body[i + 2], "val": body[i + 3],
                    "results": []}
            j = i + 4
            while j < len(body):
                if j + 1 < len(body) and body[j] == 0x1A and body[j + 1] == 0xFF:
                    j += 2
                    break
                if body[j] == 0xF0:
                    cond["results"].append(
                        ("NPC_FIELD", body[j + 1], body[j + 2], body[j + 3]))
                    j += 4
                elif body[j] == 0xF1:
                    cond["results"].append(("F1", bytes(body[j + 1:j + 7])))
                    j += 7
                else:
                    cond["results"].append(("GENERIC", bytes(body[j:j + 6])))
                    j += 6
            conds.append(cond)
            i = j
        if conds:
            total_areas += 1
            total_cond += len(conds)
            print(f"\nAREA {aid} (offset 0x{off:x}, {sz} bytes)"
                  f" — {len(conds)} condition(s):")
            for c in conds:
                op = _SJN_OPS[c["op"]] if c["op"] < len(_SJN_OPS) \
                    else f"op{c['op']}"
                print(f"  if flag[{c['flag']}] {op} {c['val']}:")
                for r in c["results"]:
                    if r[0] == "NPC_FIELD":
                        _, npc, field, val = r
                        fname = _SJN_FIELDS.get(field, f"+0x{field:x}")
                        print(f"    NPC[{npc}].{fname} = {val}")
                    else:
                        kind, raw = r
                        print(f"    {kind}: " + " ".join(f"{b:02x}" for b in raw))
    print(f"\n=== Total: {total_areas} areas, {total_cond} conditions ===")


# ----------------------------------------------------------------------
# .15T script parser — mirrors src/script.js so the op-scanner and
# smoke-tester don't depend on node.
# ----------------------------------------------------------------------

OP_STRIDES = {
    # continuing
    0xFF08: 2,
    0xFF20: 6, 0xFF30: 6,
    0xFF50: 0x20, 0xFF55: 6,
    0xFF60: 0x20, 0xFF65: 0x0A, 0xFF70: 8,
    0xFF80: 0x0A,
    0xFF90: 0x20, 0xFF91: 0x20,
    0xFFA0: 0x20, 0xFFA2: 0x20,
    0xFFB0: 0x0A,
    0xFFC0: 6, 0xFFD0: 6, 0xFFE0: 6, 0xFFF0: 6,
    # terminators
    0xFF01: 4, 0xFF02: 4, 0xFF03: 4,
    0xFF09: 4, 0xFF10: 0x14,
    0xFFFF: 2,
}
TERMINATORS = {0xFF01, 0xFF02, 0xFF03, 0xFF09, 0xFF10, 0xFFFF}
MAX_ENTRIES = 200


def parse_script_15t(buf: bytes):
    """Return dict with .buf and .entries (list of {off, size}) or None."""
    entries = []
    valid = 0
    lowest = len(buf)
    for i in range(MAX_ENTRIES):
        base = i * 6
        if base + 6 > lowest:
            break
        off = u16le(buf, base + 2)
        size = u16le(buf, base + 4)
        if off >= 384 and size > 0 and off + size <= len(buf):
            entries.append({"off": off, "size": size})
            valid += 1
            if off < lowest:
                lowest = off
        else:
            entries.append({"off": 0, "size": 0})
    if valid == 0:
        return None
    return {"buf": buf, "entries": entries}


def parse_cutscene_15t(buf: bytes):
    """Fallback for files without a proper entry header (e.g. TS001.15T)."""
    start = -1
    for i in range(0, len(buf) - 1, 2):
        w = u16le(buf, i)
        if 0xFF00 <= w <= 0xFFFF:
            start = i
            break
    if start < 0:
        return None
    return {"buf": buf, "entries": [{"off": start, "size": len(buf) - start}]}


def run_script_15t(script: dict, idx: int):
    """Return {pages, ops} — matches src/script.js behavior, sans rendering."""
    e = script["entries"][idx]
    if not e or e["size"] == 0 or e["off"] == 0:
        return {"pages": [], "ops": []}
    buf = script["buf"]
    start, end = e["off"], e["off"] + e["size"]
    pages = []
    ops = []
    line, page = [], []

    def flush_line():
        nonlocal line, page
        if line:
            page.append(line)
            line = []

    def flush_page():
        nonlocal page
        flush_line()
        if page:
            pages.append(page)
            page = []

    i = start
    guard = 0
    while i + 1 < end and guard < 20000:
        guard += 1
        w = u16le(buf, i)
        if w >= 0xFF00:
            stride = OP_STRIDES.get(w, 2)
            if w in (0xFF01, 0xFF02, 0xFF03):
                ops.append({"op": w, "pageIdx": len(pages)})
                flush_page()
                break
            if w == 0xFF08:
                flush_line()
                if len(page) >= 4:
                    flush_page()
            elif w == 0xFF09:
                ops.append({"op": w, "pageIdx": len(pages)})
                flush_page()
                break
            elif w == 0xFF10:
                ops.append({
                    "op": w, "pageIdx": len(pages),
                    "context": u16le(buf, i + 2),
                    "enemy": u16le(buf, i + 4),
                    "aux1": u16le(buf, i + 6),
                    "aux2": u16le(buf, i + 8),
                    "aux3": u16le(buf, i + 10),
                    "aux4": u16le(buf, i + 12),
                    "cond": u16le(buf, i + 14),
                    "flagIdx": u16le(buf, i + 16),
                    "flagVal": u16le(buf, i + 18),
                })
            elif w == 0xFF20:
                ops.append({"op": w, "pageIdx": len(pages),
                            "flag": u16le(buf, i + 2),
                            "value": u16le(buf, i + 4)})
            elif w == 0xFF60:
                ops.append({"op": w, "pageIdx": len(pages),
                            "npcIdx": u16le(buf, i + 2),
                            "y": u16le(buf, i + 4),
                            "x": u16le(buf, i + 6),
                            "sprite": u16le(buf, i + 8),
                            "timer": u16le(buf, i + 10)})
            elif w == 0xFF65:
                ops.append({"op": w, "pageIdx": len(pages),
                            "npcIdx": u16le(buf, i + 2),
                            "field": u16le(buf, i + 4),
                            "value": u16le(buf, i + 6)})
            elif w == 0xFF70:
                ops.append({"op": w, "pageIdx": len(pages),
                            "dir": u16le(buf, i + 2),
                            "npcIdx": u16le(buf, i + 4),
                            "extra": u16le(buf, i + 6)})
            elif w in OP_STRIDES:
                # Known opcode without structured params — capture the
                # opcode itself so scan-ops / smoke-15t can report it.
                ops.append({"op": w, "pageIdx": len(pages)})
            # Truly unknown 0xFFxx opcodes: advance `stride` and emit nothing.
            i += stride
            if w in TERMINATORS:
                flush_page()
                break
        elif w in (0xC000, 0xC001):
            line.append({"space": True})
            i += 2
            if len(line) >= 18:
                flush_line()
                if len(page) >= 4:
                    flush_page()
        else:
            count = w
            if count == 0 or count > 50 or i + 2 + count * 30 > end:
                i += 2
                continue
            i += 2
            for _ in range(count):
                line.append({"glyph": buf[i:i + 30]})
                i += 30
                if len(line) >= 18:
                    flush_line()
                    if len(page) >= 4:
                        flush_page()
    flush_page()
    return {"pages": pages, "ops": ops}


def _script_to_area():
    """POL.DAT area header → script name map, for scan-ops labelling."""
    pol = (MG2 / "S" / "POL.DAT").read_bytes()
    out = {}
    for aid in range(200):
        off = u16le(pol, aid * 4)
        cnt = u16le(pol, aid * 4 + 2)
        if off == 0 or cnt == 0:
            continue
        name = ""
        for i in range(8):
            b = pol[off + i]
            if b < 32:
                break
            name += chr(b)
        name = name.strip()
        if name:
            out[name + ".15T"] = aid
    return out


def cmd_scan_ops(args):
    """Report every FF10/FF20/FF60/FF65/FF70 in every .15T file."""
    sdir = MG2 / "S"
    files = sorted(p.name for p in sdir.iterdir() if p.suffix.upper() == ".15T")
    all_ops = []
    for fname in files:
        buf = (sdir / fname).read_bytes()
        script = parse_script_15t(buf) or parse_cutscene_15t(buf)
        if not script:
            continue
        for idx, e in enumerate(script["entries"]):
            if e["size"] == 0:
                continue
            try:
                r = run_script_15t(script, idx)
            except Exception:
                continue
            for o in r["ops"]:
                if o["op"] in (0xFF10, 0xFF20, 0xFF60, 0xFF65, 0xFF70):
                    all_ops.append({"file": fname, "entry": idx, **o})

    print(f"Scanned {len(all_ops)} state-affecting ops across {len(files)} .15T files.\n")

    ff20 = [o for o in all_ops if o["op"] == 0xFF20]
    print(f"FF20 (flag set) — {len(ff20)} occurrences:")
    writers: dict[str, list[str]] = {}
    for o in ff20:
        k = f"flag[{o['flag']}]={o['value']}"
        writers.setdefault(k, []).append(f"{o['file']}#{o['entry']}")
    for k in sorted(writers):
        uniq = list(dict.fromkeys(writers[k]))
        tail = f" (+{len(uniq)-6} more)" if len(uniq) > 6 else ""
        print(f"  {k:<18} set by: {', '.join(uniq[:6])}{tail}")

    ff65 = [o for o in all_ops if o["op"] == 0xFF65]
    hides = [o for o in ff65 if o.get("field") == 0 and o.get("value", 0) >= 155]
    print(f"\nFF65 (NPC field write — used to hide blockers) — {len(ff65)} occurrences:")
    print(f"  Hide-by-Y-sentinel (field=0, value≥155): {len(hides)}")
    for h in hides[:20]:
        print(f"    {h['file']}#{h['entry']}: NPC {h['npcIdx']} → Y={h['value']}")

    ff60 = [o for o in all_ops if o["op"] == 0xFF60]
    moves = [o for o in ff60 if o["x"] != 0xFFFF and o["y"] != 0xFFFF]

    def off_map(o):
        return o["x"] >= 208 or o["y"] >= 155 or (o["x"] == 0 and o["y"] == 0)
    hides60 = [o for o in moves if off_map(o)]
    aside = [o for o in moves if not off_map(o)]
    print(f"\nFF60 (NPC teleport) — total {len(ff60)}, with-coords {len(moves)}")
    print(f"  HIDE-by-FF60 (off-map sentinel) — {len(hides60)}:")
    for m in hides60:
        print(f"    {m['file']}#{m['entry']}: NPC {m['npcIdx']} → ({m['x']}, {m['y']})")
    print(f"  STEP-ASIDE — {len(aside)}:")
    for m in aside:
        sp = "-" if m["sprite"] == 0xFFFF else m["sprite"]
        print(f"    {m['file']}#{m['entry']}: NPC {m['npcIdx']}"
              f" → ({m['x']}, {m['y']}) sprite={sp}")

    sta = _script_to_area()
    print("\n=== AREA-MAPPED summary (file → area) ===")
    print("  HIDE_WHEN_FLAG candidates:")
    bysrc: dict[str, list[str]] = {}
    for o in ff20:
        aid = sta.get(o["file"])
        if aid is None:
            continue
        npc_raw = o["entry"] // 10
        k = f"flag[{o['flag']}]={o['value']}"
        bysrc.setdefault(k, []).append(
            f"area {aid} ({o['file'].replace('.15T','')})"
            f" NPC {npc_raw} entry {o['entry']}")
    for k in sorted(bysrc):
        print(f"  {k:<15} written by:")
        for s in list(dict.fromkeys(bysrc[k]))[:4]:
            print(f"      {s}")

    ff10 = [o for o in all_ops if o["op"] == 0xFF10]
    print(f"\nFF10 (conditional flag set + branch) — {len(ff10)} occurrences.")


def cmd_smoke_15t(args):
    """Parse every .15T and report any file that crashes the interpreter."""
    sdir = MG2 / "S"
    files = sorted(p.name for p in sdir.iterdir() if p.suffix.upper() == ".15T")
    hard_fail = soft_fail = 0
    op_counts: dict[int, int] = {}
    stats = []
    for fname in files:
        buf = (sdir / fname).read_bytes()
        script = parse_script_15t(buf)
        parser = "header"
        if not script:
            script = parse_cutscene_15t(buf)
            parser = "cutscene"
        if not script:
            hard_fail += 1
            print(f"FAIL  {fname}: no parser succeeded")
            continue
        tot_e = tot_p = tot_o = 0
        seen: set[int] = set()
        for idx, e in enumerate(script["entries"]):
            if e["size"] == 0:
                continue
            tot_e += 1
            try:
                r = run_script_15t(script, idx)
            except Exception as ex:
                soft_fail += 1
                print(f"FAIL  {fname}#{idx}: {ex}")
                continue
            tot_p += len(r["pages"])
            tot_o += len(r["ops"])
            for o in r["ops"]:
                seen.add(o["op"])
                op_counts[o["op"]] = op_counts.get(o["op"], 0) + 1
        stats.append({
            "f": fname, "parser": parser,
            "entries": tot_e, "pages": tot_p, "ops": tot_o,
            "opcodes": sorted(seen),
        })

    print(f"\nParsed {len(files)} files, hardFail={hard_fail},"
          f" softFail={soft_fail}")
    print("\nOpcode usage across all entries:")
    for op, n in sorted(op_counts.items()):
        stride = OP_STRIDES.get(op)
        known = f"stride={stride}" if stride is not None else "UNKNOWN"
        print(f"  0x{op:04X}  {n:5d}×  {known}")

    print("\nPer-file summary (first 20):")
    for s in stats[:20]:
        codes = " ".join(f"0x{o:04X}" for o in s["opcodes"])
        print(f"  {s['f']:<15} {s['parser']:<9}"
              f" entries={s['entries']:2d} pages={s['pages']:3d}"
              f" ops={s['ops']:3d}  {codes}")

    cut = [s for s in stats if s["parser"] == "cutscene"]
    if cut:
        print("\nFiles with cutscene fallback:")
        for s in cut:
            codes = " ".join(f"0x{o:04X}" for o in s["opcodes"])
            print(f"  {s['f']}  pages={s['pages']} ops={s['ops']}  {codes}")


# ----------------------------------------------------------------------
# Disassembly (MG2.EXE + ATT.LOD) — imports capstone lazily.
# ----------------------------------------------------------------------

DISASM_SECTIONS = [
    (0x0000, "00_header.asm", "MZ header padding (zero-filled)", []),
    (0x0200, "01_bootstrap.asm", "Startup / file I/O / delay helpers", [
        (0x0244, "set ds from cs:0x64"),
        (0x05ED, "busy-wait delay (counter in bx)"),
    ]),
    (0x0A00, "02_graphics.asm", "Graphics primitives", [
        (0x0A21, "render MG2.15 glyph sequence by item_id"),
        (0x0ABB, "single 16x15 glyph blit"),
    ]),
    (0x14F2, "03_main.asm", "VGA blit + main game loop", [
        (0x14F2, "VGA blit: REP MOVSD 16000 dwords -> A000:0000"),
        (0x168E, "entry point"),
        (0x16DC, "main game loop"),
        (0x17C5, "player sprite render (70x35 composite)"),
    ]),
    (0x1893, "04_combat.asm", "Combat entry + encounter system", [
        (0x1893, "battle-entry check (cs:0x3a2a flag + cs:0x9d counter)"),
        (0x199C, "battle state machine setup"),
        (0x1EC4, "another cs:0x3a2a check"),
    ]),
    (0x2055, "05_triggers.asm", "Trigger check + area loading", [
        (0x2055, "trigger check against player_X / player_Y"),
        (0x20E8, "area loader dispatch"),
        (0x2190, "INOUT.DAT area block load"),
        (0x22E6, "set player position (from trigger target)"),
    ]),
    (0x234E, "06_npc_load.asm", "POL.DAT NPC loader", [
        (0x234E, "POL.DAT per-area load into ds:0x367C"),
    ]),
    (0x2480, "07_packbits.asm", "PackBits decoders", [
        (0x2480, "PackBits decode with 0xFF transparency"),
        (0x24BF, "PackBits decode without transparency"),
    ]),
    (0x24F1, "08_input.asm", "Input handler + misc", [
        (0x24F1, "keyboard input handler"),
        (0x25C0, "collision check (map lookup)"),
        (0x2D0B, "NPC interaction lookup"),
    ]),
    (0x33A9, "09_render.asm", "Full frame render pipeline", [
        (0x33A9, "full frame render (tiles + overlay + NPCs + player)"),
        (0x33B6, "tile map render"),
        (0x340A, "layer-2 overlay pass"),
        (0x3481, "NPC sprite render"),
        (0x351B, "single tile draw (12x10)"),
    ]),
    (0x376C, "10_npc_ai.asm", "NPC AI / walk logic", [
        (0x376C, "NPC AI tick (pattern check cs:0xb24d)"),
        (0x3885, "reset NPC AI counter"),
        (0x388D, "NPC horizontal move (X vs X2)"),
        (0x3952, "NPC vertical move (Y vs Y2)"),
        (0x3BFE, "per-NPC sprite draw (EMS-paged from POL001.TOS)"),
    ]),
    (0x3BFE, "11_game_logic.asm", "Menus / save-load / HUD / high-level", [
        (0x3BFE, "NPC draw continuation (shared with 10_npc_ai)"),
        (0x8300, "menu/UI entry"),
        (0x83CF, "encounter/trigger helper"),
        (0x8514, "treasure pickup dispatch (flag2 bucket)"),
        (0x855B, "gold pickup (adds id to cs:0xb1d1)"),
        (0x85A9, "weapon/armor script dispatch"),
    ]),
    (0x8840, "12_script.asm", "Script (.15T) interpreter", [
        (0x8840, "script dispatcher (dx=script_id * 0x3c)"),
        (0x89B0, "opcode dispatch loop"),
        (0x8A75, "default glyph-draw (30-byte 16x15 bitmap)"),
        (0x8B6C, "opcode FF08: new text buffer / line"),
        (0x8B82, "opcode FF01: clear + fade"),
        (0x8C00, "opcode FF10: set NPC state (8 params)"),
        (0x8CBB, "opcode FF20: set game flag"),
        (0x8CDD, "opcode FF30: gold/pickup count add"),
        (0x8D7A, "opcode FF50: play sound + wait"),
        (0x8DC4, "opcode FF60: NPC teleport/init"),
        (0x8E3C, "opcode FF70: NPC walk animation"),
        (0xA80D, "initial asset load sequence"),
    ]),
    (0xB180, "13_data.bin.txt",
     "Binary data: strings, item tables, glyphs, save layout", []),
]


def _format_data_rows(addr: int, chunk: bytes, width: int = 16) -> list[str]:
    lines = []
    for i in range(0, len(chunk), width):
        row = chunk[i:i + width]
        hx = " ".join(f"{b:02x}" for b in row)
        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in row)
        lines.append(f"    {addr+i:5x}:\t{hx:<47}\t|{asc}|")
    return lines


def _make_banner(fname: str, title: str, lo: int, hi: int,
                 symbols: list[tuple[int, str]]) -> list[str]:
    out = [
        "; " + "=" * 72,
        f"; {fname}",
        f"; {title}",
        f"; Address range: 0x{lo:04X} .. 0x{hi:04X}  ({hi - lo} bytes)",
        "; " + "-" * 72,
    ]
    if symbols:
        out.append("; Known symbols in this range:")
        for addr, desc in symbols:
            out.append(f";   0x{addr:04X}  {desc}")
    out.append("; " + "=" * 72)
    out.append("")
    return out


def cmd_disasm(args):
    """Disassemble MG2.EXE → disasm/<section>.asm + index.md."""
    try:
        from capstone import Cs, CS_ARCH_X86, CS_MODE_16
    except ImportError:
        sys.exit("capstone required: pip install capstone")

    exe = MG2 / "MG2.EXE"
    out_dir = ROOT / "disasm"
    data = exe.read_bytes()
    if data[:2] != b"MZ":
        sys.exit(f"{exe}: not an MZ binary")
    e_cparhdr = u16le(data, 8)
    e_ip = u16le(data, 0x14)
    e_cs = u16le(data, 0x16)
    image = data[e_cparhdr * 16:]
    entry = e_cs * 16 + e_ip
    print(f"[+] {exe.name}: {len(image)} bytes, entry CS:0x{entry:04X}")

    out_dir.mkdir(parents=True, exist_ok=True)
    for old in list(out_dir.glob("*.asm")) + list(out_dir.glob("*.bin.txt")):
        old.unlink()

    sections = []
    for i, (lo, fname, title, syms) in enumerate(DISASM_SECTIONS):
        hi = DISASM_SECTIONS[i + 1][0] if i + 1 < len(DISASM_SECTIONS) \
            else len(image)
        sections.append((lo, hi, fname, title, syms))

    index = [
        "# MG2.EXE Disassembly Index", "",
        f"Image size: {len(image)} bytes. Entry CS:0x{entry:04X}.",
        f"MZ header stripped ({e_cparhdr * 16} bytes),"
        " so addresses below are CS-relative.", "",
        "| File | Range | Bytes | Content |",
        "|---|---|---|---|",
    ]

    md = Cs(CS_ARCH_X86, CS_MODE_16)
    md.detail = False

    for lo, hi, fname, title, syms in sections:
        banner = _make_banner(fname, title, lo, hi, syms)
        is_data = fname.endswith(".bin.txt")
        lines = list(banner)
        if is_data:
            lines.extend(_format_data_rows(lo, image[lo:hi]))
        else:
            last_end = lo
            for ins in md.disasm(image[lo:hi], lo):
                if ins.address > last_end:
                    lines.append(
                        f";-- undecoded bytes 0x{last_end:04X}..0x{ins.address:04X}")
                    lines.extend(
                        _format_data_rows(last_end, image[last_end:ins.address]))
                hex_bytes = " ".join(f"{b:02x}" for b in ins.bytes)
                lines.append(
                    f"    {ins.address:5x}:\t{hex_bytes:<21}\t"
                    f"{ins.mnemonic} {ins.op_str}".rstrip())
                last_end = ins.address + len(ins.bytes)
            if last_end < hi:
                lines.append(
                    f";-- undecoded tail 0x{last_end:04X}..0x{hi:04X}")
                lines.extend(_format_data_rows(last_end, image[last_end:hi]))
        (out_dir / fname).write_text("\n".join(lines) + "\n")
        count = sum(1 for l in lines if l.startswith("    ") and ":\t" in l)
        index.append(f"| [{fname}]({fname}) | 0x{lo:04X}-0x{hi-1:04X}"
                     f" | {hi-lo} | {title} |")
        print(f"  [+] {fname:22s} 0x{lo:04X}-0x{hi-1:04X}"
              f"  {hi-lo:5d} B  {count:5d} lines")

    (out_dir / "index.md").write_text("\n".join(index) + "\n")
    print(f"[+] wrote {len(sections)} sections to {out_dir}")


def cmd_disasm_attlod(args):
    """Disassemble ATT.LOD (battle overlay MZ) → disasm/att_lod.asm."""
    try:
        from capstone import Cs, CS_ARCH_X86, CS_MODE_16
    except ImportError:
        sys.exit("capstone required: pip install capstone")

    lod = MG2 / "ATT.LOD"
    out = ROOT / "disasm" / "att_lod.asm"
    d = lod.read_bytes()
    hdr_paras = u16le(d, 8)
    pages, last_page = u16le(d, 4), u16le(d, 6)
    init_ip, init_cs = u16le(d, 0x14), u16le(d, 0x16)
    code_start = hdr_paras * 16
    code_end = pages * 512 - ((512 - last_page) if last_page else 0)
    image = d[code_start:code_end]
    print(f"ATT.LOD: code {code_start:x}..{code_end:x} size {len(image)},"
          f" entry {init_cs:04x}:{init_ip:04x}")

    md = Cs(CS_ARCH_X86, CS_MODE_16)
    md.detail = False

    entry_off = init_cs * 16 + init_ip
    lines = [
        "; ATT.LOD disassembly — battle-mode overlay",
        f"; code {code_start:#x}..{code_end:#x} ({len(image)} bytes)",
        f"; entry CS:IP = {init_cs:04x}:{init_ip:04x}"
        f" (image offset 0x{entry_off:x})",
        "",
        ";============ DATA SEGMENT (0x0000 .. entry) ============",
        "; Everything up to the entry point is initialised data — strings,",
        "; the encounter-pool table, frame-format constants etc. Dumped as",
        "; bytes since Capstone would misinterpret it as code.",
        "",
    ]
    for off in range(0, entry_off, 16):
        row = image[off:off + 16]
        hx = " ".join(f"{b:02x}" for b in row)
        asc = "".join(chr(b) if 32 <= b < 127 else "." for b in row)
        lines.append(f"{off:06x}  {hx:<48}  {asc}")

    lines.append("")
    lines.append(";================ CODE (from entry point) ================")
    lines.append("")
    for insn in md.disasm(image[entry_off:], entry_off):
        lines.append(
            f"{insn.address:06x}  {insn.bytes.hex():<14}"
            f" {insn.mnemonic} {insn.op_str}")

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(lines))
    print(f"wrote {out} ({out.stat().st_size} bytes)")


# ----------------------------------------------------------------------
# Argparse wiring
# ----------------------------------------------------------------------

def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="mg2tools",
        description="MG2 binary-format reverse-engineering CLI. "
                    "Image outputs → ./dump/ (PPM). "
                    "Disasm outputs → ./disasm/.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = p.add_subparsers(dest="cmd", required=True, metavar="COMMAND")

    def add(name, func, help):
        sp = sub.add_parser(name, help=help)
        sp.set_defaults(func=func)
        return sp

    add("enemy-sheet", cmd_enemy_sheet,
        "ENEMY.TOS contact sheet (one cell per frame).")
    add("enemy-indexed", cmd_enemy_indexed,
        "ENEMY.TOS paginated sheets with numeric labels (50/sheet).")

    sp = add("enemy-single", cmd_enemy_single,
             "Render a single ENEMY.TOS frame at N× scale.")
    sp.add_argument("id", type=int, help="frame index (0-based)")
    sp.add_argument("--scale", type=int, default=3)

    add("pol001-sheet", cmd_pol001_sheet,
        "POL001.TOS NPC catalog (80 chars × idle-down frame).")
    add("pol-patrols", cmd_pol_patrols,
        "POL.DAT: list NPCs whose X2,Y2 differ from X,Y.")

    sp = add("mg215", cmd_mg215,
             "Render a .15 glyph entry (or range) as ASCII art.")
    sp.add_argument("--file", default="MG2.15",
                    choices=["MG2.15", "M.15", "ATT.15", "P.15", "STA.15"])
    sp.add_argument("range", nargs="?", default="0-30",
                    help="single ID or range lo-hi (default 0-30)")

    add("name-tables", cmd_name_tables,
        "Render entries 100-126 + 200,210-212,220 of every .15 as PPM strip.")
    add("sjn", cmd_sjn,
        "Decode S/SJN.DAT quest-blocker rule table.")
    add("scan-ops", cmd_scan_ops,
        "Scan every .15T for FF10/FF20/FF60/FF65/FF70 and summarise.")
    add("smoke-15t", cmd_smoke_15t,
        "Parse every .15T — flag any file that crashes the interpreter.")
    add("disasm", cmd_disasm,
        "Capstone-disassemble MG2.EXE → disasm/.")
    add("disasm-attlod", cmd_disasm_attlod,
        "Capstone-disassemble ATT.LOD → disasm/att_lod.asm.")
    return p


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    args.func(args)
    return 0


if __name__ == "__main__":
    sys.exit(main())
