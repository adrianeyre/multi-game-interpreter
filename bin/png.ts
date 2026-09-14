/**
 * A minimal PNG writer, so a diagnostic adds no dependency to the package.
 *
 * Extracted from `bin/scumm-shot.ts`, where it had already been copied once
 * into `bin/agi-render.ts` — two identical copies is the point at which the
 * third one should be a shared file rather than a third copy. SCI's shot tool
 * is that third caller (#218).
 */

import { deflateSync } from 'node:zlib';

export function writePng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const crcTable = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  const crc = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };

  const chunk = (type: string, data: Uint8Array): number[] => {
    const body = new Uint8Array(4 + data.length);
    for (const [index, character] of [...type].entries()) body[index] = character.charCodeAt(0);
    body.set(data, 4);
    const length = data.length;
    const check = crc(body);
    return [
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
      ...body,
      (check >>> 24) & 0xff,
      (check >>> 16) & 0xff,
      (check >>> 8) & 0xff,
      check & 0xff,
    ];
  };

  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const at = y * (1 + width * 3);
    raw[at] = 0;
    raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), at + 1);
  }

  const header = new Uint8Array([
    (width >>> 24) & 0xff,
    (width >>> 16) & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    (height >>> 24) & 0xff,
    (height >>> 16) & 0xff,
    (height >>> 8) & 0xff,
    height & 0xff,
    8,
    2,
    0,
    0,
    0,
  ]);

  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', header),
    ...chunk('IDAT', new Uint8Array(deflateSync(raw))),
    ...chunk('IEND', new Uint8Array(0)),
  ]);
}
