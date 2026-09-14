/**
 * Low-level writers for SCUMM's container format.
 *
 * The engine reads these structures; this is the other half of the same
 * contract. Keeping the two in one repository means a format mistake shows up
 * as a failing round-trip test rather than as a corrupted game months later.
 */

export type Bytes = Uint8Array | number[];

function toArray(value: Bytes): number[] {
  return Array.isArray(value) ? value : [...value];
}

export function u16le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff];
}

export function u32le(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff];
}

export function u32be(value: number): number[] {
  return [(value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function tagBytes(tag: string): number[] {
  if (tag.length !== 4) throw new Error(`Chunk tag "${tag}" must be exactly 4 characters`);
  return [...tag].map((character) => character.charCodeAt(0));
}

/**
 * Appends bytes to an array without spreading them as call arguments.
 *
 * `target.push(...source)` passes every byte as a separate argument, and an
 * argument list has a hard limit — tens of thousands of entries. An authored
 * room never comes close. A room decompiled from a published game is hundreds
 * of kilobytes, and the compile fails with "Maximum call stack size exceeded",
 * which says nothing about the actual problem being the size of the payload.
 */
export function append(target: number[], source: Bytes): void {
  for (let i = 0; i < source.length; i++) target.push(source[i]);
}

/** Wraps a payload in a chunk header. The stored size includes the header. */
export function chunk(tag: string, payload: Bytes): number[] {
  const body = toArray(payload);
  const out: number[] = [];
  append(out, tagBytes(tag));
  append(out, u32be(body.length + 8));
  append(out, body);
  return out;
}

export function concat(...parts: Bytes[]): number[] {
  const out: number[] = [];
  for (const part of parts) append(out, toArray(part));
  return out;
}

/** Applies the single-byte obfuscation the game files ship with. */
export function encrypt(bytes: Bytes, key: number): Uint8Array {
  const source = toArray(bytes);
  const out = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) out[i] = (source[i] ^ key) & 0xff;
  return out;
}

/** A NUL-terminated string, with newlines as the 0xFF 01 escape. */
export function messageBytes(text: string): number[] {
  const out: number[] = [];
  for (const character of text) {
    if (character === '\n') {
      out.push(0xff, 1);
      continue;
    }
    const code = character.charCodeAt(0);
    out.push(code > 0xfd ? 0x3f : code);
  }
  out.push(0);
  return out;
}
