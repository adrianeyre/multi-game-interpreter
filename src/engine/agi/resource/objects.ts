/**
 * The `OBJECT` file: AGI's inventory items and where each one starts.
 *
 * A plain file rather than an indexed resource, like `WORDS.TOK` — read by name
 * and not through the `*DIR` tables.
 *
 * Each item is a name and a room number, and the room number is the whole of
 * AGI's inventory model: an item is "in the player's hands" when its room
 * number is the carried-room sentinel, "in room 12" when it is 12, and out of
 * the game when it is 0. There is no separate owner table the way SCUMM has
 * one, which is why `has()` is a comparison rather than a lookup.
 */

import { readU16LE } from '../../util/ByteStream.js';
import { avisDurgan } from './logicMessages.js';

/**
 * The room number that means "the player is carrying this".
 *
 * 255 rather than a flag, because that is how AGI stores it: `get` writes 255
 * into the item's room and `has()` compares against it.
 */
export const CARRIED_ROOM = 255;

export interface AgiInventoryItem {
  readonly name: string;
  /** Where the item starts. Mutable state lives in the engine, not here. */
  readonly startRoom: number;
}

export interface AgiObjectFile {
  readonly items: readonly AgiInventoryItem[];
  /** How many objects the game asked the interpreter to animate at once. */
  readonly maxAnimatedObjects: number;
  /** Whether the file was obfuscated, so a re-emit matches (#133). */
  readonly encrypted: boolean;
}

/**
 * Reads `OBJECT`.
 *
 *   0..1  offset to the first item name, measured from byte 3
 *   2     the largest number of animated objects the game uses
 *   3..   three bytes per item: a 16-bit name offset (from byte 3) and a
 *         one-byte starting room
 *   then  the names, NUL-terminated
 *
 * The item count is not written down anywhere: it is the first name's offset
 * divided by three, because the records run from byte 3 up to where the names
 * begin. So a wrong reading of that first field produces a wrong number of
 * items rather than an error.
 *
 * **Encryption is detected rather than assumed.** Most releases obfuscate the
 * whole file with "Avis Durgan"; the early AGI v2 games do not. Nothing in the
 * file says which, so both readings are tried and the one that produces a
 * sane structure wins — a game's inventory read the wrong way is a list of
 * items with noise for names, which is a symptom a long way from its cause.
 */
export function readObjectFile(bytes: Uint8Array): AgiObjectFile {
  const plain = tryReadObjects(bytes);
  const decrypted = tryReadObjects(avisDurgan(bytes));

  // Prefer whichever produced readable names. Both can parse structurally —
  // the offsets are just numbers — so the names are what tells them apart.
  const plainScore = plain ? scoreNames(plain.items) : -1;
  const decryptedScore = decrypted ? scoreNames(decrypted.items) : -1;

  if (decrypted && decryptedScore >= plainScore) {
    return { ...decrypted, encrypted: true };
  }
  if (plain) return { ...plain, encrypted: false };

  throw new Error(
    `The OBJECT file could not be read either as plain text or obfuscated with ` +
      `"Avis Durgan". It is ${bytes.length} bytes, and an AGI OBJECT file opens ` +
      `with a 16-bit offset to its own name table.`,
  );
}

function tryReadObjects(
  bytes: Uint8Array,
): { items: AgiInventoryItem[]; maxAnimatedObjects: number } | null {
  if (bytes.length < 3) return null;

  const namesAt = readU16LE(bytes, 0);
  const maxAnimatedObjects = bytes[2];
  // The records fill the space between the header and the names, so the count
  // is a division rather than a field.
  const count = Math.floor(namesAt / 3);
  if (count <= 0 || count > 512) return null;
  if (3 + count * 3 > bytes.length + 3) return null;

  const items: AgiInventoryItem[] = [];
  for (let index = 0; index < count; index++) {
    const at = 3 + index * 3;
    if (at + 2 >= bytes.length) return null;
    // Offsets are measured from byte 3, not from the start of the file.
    const nameAt = 3 + readU16LE(bytes, at);
    const startRoom = bytes[at + 2];

    let name = '';
    if (nameAt < bytes.length) {
      let end = nameAt;
      while (end < bytes.length && bytes[end] !== 0) end++;
      name = String.fromCharCode(...bytes.subarray(nameAt, end));
    }
    items.push({ name, startRoom });
  }

  return { items, maxAnimatedObjects };
}

/**
 * How many item names look like words rather than noise.
 *
 * The test for "did we decrypt this correctly". Deliberately a count rather
 * than a threshold: the two readings are compared against each other, so what
 * matters is which is *more* readable, not whether either passes a bar.
 */
function scoreNames(items: readonly AgiInventoryItem[]): number {
  let score = 0;
  for (const item of items) {
    if (item.name.length === 0) continue;
    // Printable ASCII with at least one letter is what an item name is.
    if (/^[\x20-\x7e]+$/.test(item.name) && /[A-Za-z]/.test(item.name)) score++;
  }
  return score;
}

/**
 * Re-emits an `OBJECT` file.
 *
 * Names are emitted in item order and shared where two items have the same
 * name — which they do: AGI's own files point several "?" placeholders at one
 * string, and emitting a copy each would work and not be the same bytes.
 */
export function writeObjectFile(
  items: readonly AgiInventoryItem[],
  maxAnimatedObjects: number,
  encrypted: boolean,
): Uint8Array {
  const namesAt = items.length * 3;
  const nameOffsets = new Map<string, number>();
  const nameBytes: number[] = [];

  for (const item of items) {
    if (nameOffsets.has(item.name)) continue;
    nameOffsets.set(item.name, namesAt + nameBytes.length);
    nameBytes.push(...[...item.name].map((character) => character.charCodeAt(0)), 0);
  }

  const out: number[] = [namesAt & 0xff, (namesAt >> 8) & 0xff, maxAnimatedObjects];
  for (const item of items) {
    const offset = nameOffsets.get(item.name)!;
    out.push(offset & 0xff, (offset >> 8) & 0xff, item.startRoom);
  }
  out.push(...nameBytes);

  const bytes = new Uint8Array(out);
  return encrypted ? avisDurgan(bytes) : bytes;
}
