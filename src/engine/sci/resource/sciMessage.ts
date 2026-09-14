/**
 * `MESSAGE` resources: displayable text moved out of the Script resource.
 *
 * SCI1.1's move, and the same one SCUMM v7 made — which ADR 0009 already ruled
 * on, so the ruling carries: text that lives in its own resource is **Project
 * content**, edited as itself rather than as bytes inside an instruction.
 *
 * **A Message is one authored thing with three faces**, and that is the shape
 * that matters (#221, #222). Its text, its recorded speech in `RESOURCE.AUD`
 * and its `sync36` mouth timing are all keyed by the *same* tuple — noun, verb,
 * condition, sequence — so they are one item with three faces rather than three
 * parallel tables that happen to share a key. Modelling them as parallel tables
 * is how a translation ends up with the right words and the wrong lip sync.
 */

/** The key every face of a Message shares. */
export interface SciMessageKey {
  noun: number;
  verb: number;
  cond: number;
  seq: number;
}

export interface SciMessage extends SciMessageKey {
  /** Who says it, as the game's own talker number. */
  talker: number;
  text: string;
  /** A Message this one defers to, when it has one. */
  reference?: SciMessageKey;
}

export interface SciMessageResource {
  /** The format version, as the resource states it: 2, 3, 4 or 5. */
  version: number;
  messages: SciMessage[];
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

/**
 * Reads a `MESSAGE` resource.
 *
 * The version is the first word divided by a thousand — Sierra wrote 4000 for
 * version 4 — and it decides both the header size and the record width. Two
 * shapes here: the early one at 4 bytes a record and the SCI1.1 one at 11, the
 * difference being the talker and the reference tuple.
 *
 * `detectMessageFunctionType` in ScummVM reads the same field for a different
 * purpose — only version 2 resources use `kGetMessage` rather than `kMessage` —
 * which is why the version is returned rather than consumed here.
 */
export function readSciMessages(resource: Uint8Array): SciMessageResource {
  if (resource.length < 10) return { version: 0, messages: [] };

  const version = Math.floor(u16(resource, 0) / 1000);
  const messages: SciMessage[] = [];

  // Version 4 and 5: ten bytes of header with the count at 8, then eleven-byte
  // records. Version 2 and 3: six bytes of header with the count at 4, then
  // four-byte keys followed by a text offset.
  const modern = version >= 4;
  const headerSize = modern ? 10 : 6;
  const recordSize = modern ? 11 : 10;
  const count = u16(resource, modern ? 8 : 4);

  for (let i = 0; i < count; i++) {
    const at = headerSize + i * recordSize;
    if (at + recordSize > resource.length) break;

    const key: SciMessageKey = {
      noun: resource[at],
      verb: resource[at + 1],
      cond: resource[at + 2],
      seq: resource[at + 3],
    };
    const talker = resource[at + 4];
    const offset = u16(resource, at + 5);
    const message: SciMessage = { ...key, talker, text: readText(resource, offset) };

    if (modern) {
      const reference: SciMessageKey = {
        noun: resource[at + 7],
        verb: resource[at + 8],
        cond: resource[at + 9],
        seq: resource[at + 10],
      };
      // A reference of all zeroes is "no reference", not a Message keyed by
      // four zeroes — and a game does have one keyed that way, so the two have
      // to be told apart rather than one standing in for the other.
      if (reference.noun || reference.verb || reference.cond || reference.seq) {
        message.reference = reference;
      }
    }
    messages.push(message);
  }

  return { version, messages };
}

/** A null-terminated string at an offset in the resource. */
function readText(resource: Uint8Array, offset: number): string {
  if (offset === 0 || offset >= resource.length) return '';
  let text = '';
  for (let at = offset; at < resource.length && resource[at] !== 0; at++) {
    text += String.fromCharCode(resource[at]);
  }
  return text;
}

/** `"1,2,0,1"` — the key as one string, for indexing the three faces together. */
export function messageKey(key: SciMessageKey): string {
  return `${key.noun},${key.verb},${key.cond},${key.seq}`;
}

/**
 * A Message with everything that belongs to it, gathered by key.
 *
 * The point of the type: `audio36` and `sync36` resources are numbered by an
 * *encoding* of the same tuple, so a Message's speech and its mouth timing are
 * found by asking for its key rather than by walking a parallel list and hoping
 * the orders match.
 */
export interface SciMessageWithFaces extends SciMessage {
  /** The `audio36` resource number holding the recording, when there is one. */
  audio?: number;
  /** The `sync36` resource number holding the mouth timing. */
  sync?: number;
}

/**
 * The resource number an `audio36` or `sync36` uses for a Message tuple.
 *
 * Sierra packs the four key parts into the number itself: eleven bits of noun,
 * then verb, condition and sequence. That packing is why the two resource types
 * can be keyed by the same tuple as the text without any table joining them —
 * and why a reader that invents its own numbering finds nothing.
 */
/**
 * One step of a `sync36` resource: when the mouth changes, and to what.
 *
 * A time in ticks and a cue the game's own scripts interpret — Sierra did not
 * standardise the cue values, and a talker's script decides what each means.
 * So this reads the timing and does not pretend to read the mouth shapes.
 */
export interface SciSyncStep {
  time: number;
  /** The cue for this step, or -1 where the resource carries none. */
  cue: number;
}

/**
 * Reads a `sync36` resource: the third face of a line of dialogue.
 *
 * The whole of the format, from `Sync::next` (`engines/sci/sound/sync.cpp`): a
 * run of signed 16-bit pairs, a time and then a cue, and a time of **-1** ends
 * it. A trailing time with no cue is legal and is what the last step of most
 * lines looks like, so a reader that insists on pairs drops the final mouth
 * movement of every line in the game.
 *
 * **Found by key, not by index.** The number this resource has is
 * `audio36Number` of the Message's own tuple, which is why `SciMessageWithFaces`
 * can hold text, speech and timing together without a table joining them. #221
 * asks for exactly that: a line of dialogue is one authored thing with three
 * faces, not three parallel lists that happen to share an order.
 */
export function readSciSync(resource: Uint8Array): SciSyncStep[] {
  const steps: SciSyncStep[] = [];
  const int16 = (at: number): number => {
    const value = resource[at] | (resource[at + 1] << 8);
    return value >= 0x8000 ? value - 0x10000 : value;
  };

  let at = 0;
  while (at + 1 < resource.length) {
    const time = int16(at);
    at += 2;
    if (time === -1) break;
    // The cue is optional, and its absence is the end of the resource rather
    // than a fault: `Sync::next` reads one only when there are two more bytes.
    const cue = at + 1 < resource.length ? int16(at) : -1;
    if (at + 1 < resource.length) at += 2;
    steps.push({ time, cue });
  }
  return steps;
}

export function audio36Number(key: SciMessageKey): number {
  return (
    ((key.noun & 0xff) << 24) |
    ((key.verb & 0xff) << 16) |
    ((key.cond & 0xff) << 8) |
    (key.seq & 0xff)
  );
}
