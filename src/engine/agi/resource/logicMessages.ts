/**
 * A Logic's own message table.
 *
 * Lives on the engine side rather than under `authoring/` because the
 * *interpreter* needs it: `print` reads a message every time it runs, and a
 * second decryptor written for that path is how the two drifted apart once
 * already — see the note on `readLogicMessages`.
 *
 * `CONTEXT.md` defines **Logic** as an AGI script resource that "holds its own
 * message table, so a room's text lives with the code that shows it rather than
 * in a central string pool". That is not a small detail: it is the reason an
 * AGI project needs no shared string pool and therefore has no edit whose reach
 * an author cannot see, which is where AGI escapes ADR 0009's problem rather
 * than merely not having it yet (ADR 0013).
 */

import { readU16LE } from '../../util/ByteStream.js';

/**
 * The key AGI obfuscates Logic messages and the `OBJECT` file with.
 *
 * Eleven bytes, applied cyclically from the start of the encrypted region. Not
 * encryption in any useful sense — it is a colleague's name, and Lance Ewing's
 * specification says as much — but it has to be applied or every message reads
 * as noise.
 */
export const AVIS_DURGAN = 'Avis Durgan';

/** XORs a region with the repeating key, in place on a copy. */
export function avisDurgan(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (const [index, byte] of bytes.entries()) {
    out[index] = byte ^ AVIS_DURGAN.charCodeAt(index % AVIS_DURGAN.length);
  }
  return out;
}

export interface AgiLogicMessages {
  /**
   * Messages by the number `print` uses, which is 1-based.
   *
   * Index 0 is always undefined, deliberately: `print 1` shows the first
   * message, and an off-by-one here shows the wrong line rather than failing.
   */
  readonly texts: ReadonlyArray<string | undefined>;
  /** Where the bytecode ends and the message section begins. */
  readonly bytecodeSize: number;
  readonly sectionAt: number;
  /** Total size of the message section, as the resource records it. */
  readonly sectionSize: number;
}

/**
 * Splits a Logic resource into its bytecode length and its messages.
 *
 * The layout, from ScummVM's `decodeLogic` and the AGI Specification:
 *
 *   0..1                     bytecode size, little-endian
 *   2..2+size-1              bytecode
 *   m = 2 + size             message count, one byte
 *   m+1..m+2                 total size of the message section, little-endian
 *   m+3..m+3+2*count-1       one 16-bit offset per message
 *   m+3+2*count..            the message text, NUL-separated
 *
 * **A message offset is relative to `m + 1`.** That is the one detail no prose
 * source states outright, and the one that puts every string a byte out if it
 * is guessed — which reads as an off-by-one in the text rather than as a
 * failure. It is transcribed from ScummVM, whose comment says so in as many
 * words.
 *
 * **The key repeats from the start of the text region, not from each message.**
 * That is the detail this file exists to hold in one place. A decryptor that
 * restarts the key at each message decodes the *first* message correctly and
 * turns every later one into noise — which reads as a game with some text and
 * some garbage, and is exactly what a second copy of this logic produced before
 * it was deleted. Found by running a real fan game, not by any test here.
 *
 * `encrypted` says whether to un-obfuscate the text. It is false for a
 * resource that arrived LZW-compressed, because the interpreter's own condition
 * is `~flags & RES_COMPRESSED` — the compression already obscured it, so there
 * is no second pass. Getting this backwards turns every message into noise.
 */
export function readLogicMessages(bytes: Uint8Array, encrypted: boolean): AgiLogicMessages {
  if (bytes.length < 2) {
    throw new Error(
      `A Logic resource is ${bytes.length} bytes, which is shorter than the ` +
        `two-byte length field it must open with.`,
    );
  }

  const bytecodeSize = readU16LE(bytes, 0);
  const sectionAt = 2 + bytecodeSize;

  if (sectionAt >= bytes.length) {
    throw new Error(
      `This Logic says its bytecode is ${bytecodeSize} bytes, which puts the ` +
        `message section at ${sectionAt} in a ${bytes.length} byte resource — ` +
        `past the end of it. Either the length field is wrong or the resource ` +
        `is truncated.`,
    );
  }

  const count = bytes[sectionAt];
  const sectionSize = readU16LE(bytes, sectionAt + 1);
  const offsetsAt = sectionAt + 3;
  const stringsAt = offsetsAt + count * 2;

  if (stringsAt > bytes.length) {
    throw new Error(
      `This Logic claims ${count} messages, whose offset table would end at ` +
        `${stringsAt} in a ${bytes.length} byte resource.`,
    );
  }

  // The size field covers itself, the offset table and the text, which is why
  // both are subtracted to get the length of the text.
  const stringsSize = Math.max(0, Math.min(sectionSize - 2 - count * 2, bytes.length - stringsAt));
  const raw = bytes.subarray(stringsAt, stringsAt + stringsSize);
  const text = encrypted && count > 0 ? avisDurgan(raw) : raw;

  const texts: Array<string | undefined> = [undefined];
  for (let index = 0; index < count; index++) {
    const offset = readU16LE(bytes, offsetsAt + index * 2);
    // Zero means the message is absent rather than at the start of the text.
    // ScummVM notes it is unsure this ever happens; treating it as absent
    // rather than as offset 0 costs nothing and cannot show the wrong line.
    if (offset === 0) {
      texts.push(undefined);
      continue;
    }
    const at = sectionAt + 1 + offset - stringsAt;
    if (at < 0 || at >= text.length) {
      texts.push(undefined);
      continue;
    }
    let end = at;
    while (end < text.length && text[end] !== 0) end++;
    texts.push(String.fromCharCode(...text.subarray(at, end)));
  }

  return { texts, bytecodeSize, sectionAt, sectionSize };
}

/**
 * Re-emits a message table, byte for byte where nothing changed.
 *
 * The inverse of `readLogicMessages`, and the reason the round-trip in ADR 0013
 * is testable: a Logic's messages are part of the resource, so re-emitting one
 * means rebuilding the offset table and re-applying the obfuscation exactly.
 */
export function writeLogicMessages(
  texts: ReadonlyArray<string | undefined>,
  encrypted: boolean,
): Uint8Array {
  // Index 0 is the unused slot that makes `print 1` the first message.
  const messages = texts.slice(1);
  const count = messages.length;

  const bodies = messages.map((message) =>
    message === undefined
      ? null
      : Uint8Array.from([...[...message].map((c) => c.charCodeAt(0)), 0]),
  );

  const offsets: number[] = [];
  let cursor = 2 + count * 2;
  for (const body of bodies) {
    if (body === null) {
      offsets.push(0);
      continue;
    }
    offsets.push(cursor);
    cursor += body.length;
  }

  const textBytes = new Uint8Array(cursor - (2 + count * 2));
  let at = 0;
  for (const body of bodies) {
    if (body === null) continue;
    textBytes.set(body, at);
    at += body.length;
  }

  const sectionSize = 2 + count * 2 + textBytes.length;
  const out = new Uint8Array(3 + count * 2 + textBytes.length);
  out[0] = count;
  out[1] = sectionSize & 0xff;
  out[2] = (sectionSize >> 8) & 0xff;
  for (const [index, offset] of offsets.entries()) {
    out[3 + index * 2] = offset & 0xff;
    out[4 + index * 2] = (offset >> 8) & 0xff;
  }
  out.set(encrypted && count > 0 ? avisDurgan(textBytes) : textBytes, 3 + count * 2);
  return out;
}
