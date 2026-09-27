/**
 * A SCI32 cel's link points: named positions inside a cel, for attaching one
 * thing to another.
 *
 * Lighthouse's weapon-building puzzle asks where on a part the next part
 * joins, and `CelLink`'s two real sub-functions — 2 for x and 3 for y — are
 * that question. The answer is in the View resource and nowhere else: from
 * View version 0x84 a cel header carries, at 36, the offset of a table of
 * six-byte records and, at 40, how many there are. Each is an x, a y, and at
 * byte 4 the link's ID.
 *
 * `CelObjView::getLinkPosition` (`engines/sci/graphics/celobj32.cpp`) and the
 * header walk in `CelObjView`'s constructor, fetched 2026-09-27. A loop that
 * mirrors another reads the other's cels and flips x — with SSCI's off-by-one
 * fixed, as ScummVM fixes it. No link of that ID answers (-1, -1).
 */

export function sci32CelLink(
  view: Uint8Array,
  loop: number,
  cel: number,
  linkId: number,
): { x: number; y: number } | null {
  if (view.length < 20) return null;
  const u16 = (at: number): number => (view[at] ?? 0) | ((view[at + 1] ?? 0) << 8);
  const s16 = (at: number): number => (u16(at) << 16) >> 16;
  const u32 = (at: number): number => (u16(at) | (u16(at + 2) << 16)) >>> 0;
  const s8 = (at: number): number => ((view[at] ?? 0) << 24) >> 24;

  // Links arrived with View version 0x84; ScummVM refuses anything older.
  if (view[18] < 0x84) return null;

  const loopCount = view[2];
  if (loopCount === 0) return null;
  const loopNo = Math.min(Math.max(0, loop), loopCount - 1);
  const viewHeaderSize = u16(0);
  const loopHeaderSize = view[12];
  const celHeaderSize = view[13];

  let loopHeader = 2 + viewHeaderSize + loopHeaderSize * loopNo;
  let mirrored = false;
  if (s8(loopHeader) !== -1) {
    mirrored = view[loopHeader + 1] === 1;
    loopHeader = 2 + viewHeaderSize + loopHeaderSize * s8(loopHeader);
  }
  const celCount = view[loopHeader + 2];
  if (celCount === 0) return null;
  const celNo = Math.min(cel, celCount - 1);
  const celHeader = u32(loopHeader + 12) + celHeaderSize * celNo;
  if (celHeader + 42 > view.length) return null;

  const width = u16(celHeader);
  const count = s16(celHeader + 40);
  const table = u32(celHeader + 36);
  for (let index = 0; index < count; index++) {
    const record = table + index * 6;
    if (record + 6 > view.length) break;
    if (view[record + 4] !== linkId) continue;
    const x = s16(record);
    return { x: mirrored ? width - x - 1 : x, y: s16(record + 2) };
  }
  return { x: -1, y: -1 };
}
