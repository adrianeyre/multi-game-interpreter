/**
 * The header of an AGOS graphics resource.
 *
 * A graphics resource is not a bitmap. It is a small table of **images** and
 * **animations**, each of which is an entry pointing at a VGA script
 * (`vgaScript.ts`) — so "draw room 12" means "run the script entry 12 names",
 * and the pixels are whatever that script places.
 *
 * That is why a renderer for AGOS is not a decoder plus a blit: the decoders in
 * `agosImage.ts` are the easy half, and the half that decides *what* is drawn is
 * a second bytecode interpreter.
 *
 * ## The header is not at the start of the file
 *
 * This is the one thing worth reading before the rest, because getting it wrong
 * costs everything downstream and costs it silently. The resource begins with a
 * few words of its own, one of which is **where the header is**; the counts and
 * the table offsets live there rather than at offset zero.
 *
 * Reading the header at zero yields counts and offsets that are other things
 * entirely, and in Simon 1 those other things happen to be small — so every
 * zone reported *no images and no animations*, every `drawImage` answered
 * false, and a game running its scripts correctly drew a black screen with
 * nothing in any report to say why. The tables were there the whole time,
 * eighty bytes further in.
 *
 * ## Three layouts, and the word that says which
 *
 * The counts and table offsets sit at the same places inside the header in
 * every Version; what differs is how to *find* the header, how wide an entry
 * is, and — for AGOS 2 alone — the byte order.
 *
 * | Version           | Header at                | Byte order |
 * | ----------------- | ------------------------ | ---------- |
 * | Simon 1, Simon 2  | word at +4               | big        |
 * | Elvira 1/2, Waxworks | word at +10, then +20 | big        |
 * | Feeble, PuzzlePack   | word at +2            | little     |
 *
 * The byte order is the surprise, because everything else AGOS ships is
 * big-endian and `agosVersion.ts` says so. It is right about the games it is
 * describing: this resource in the two AGOS 2 games is genuinely little-endian,
 * which is a fact about one file in one pair of Versions rather than a change
 * of mind about the family.
 */

/** Which of the three layouts a resource is in. */
export type VgaFileLayout = 'simon' | 'old-bundle' | 'agos2';

export interface VgaEntry {
  readonly id: number;
  /** Where this entry's VGA script starts, as an offset into the resource. */
  readonly scriptOffset: number;
  /** Simon and Waxworks carry a colour with an image entry; Feeble does not. */
  readonly colour?: number;
}

export interface VgaFile {
  readonly images: readonly VgaEntry[];
  readonly animations: readonly VgaEntry[];
  /** Where the header turned out to be, so a diagnostic can say. */
  readonly headerAt: number;
}

function readU16BE(data: Uint8Array, offset: number): number {
  const high = data[offset];
  const low = data[offset + 1];
  if (high === undefined || low === undefined) {
    throw new Error(`graphics resource ends at ${offset}, inside its header`);
  }
  return (high << 8) | low;
}

function readU16LE(data: Uint8Array, offset: number): number {
  const low = data[offset];
  const high = data[offset + 1];
  if (high === undefined || low === undefined) {
    throw new Error(`graphics resource ends at ${offset}, inside its header`);
  }
  return (high << 8) | low;
}

/** The shape of one layout, gathered so the reader below has no branches in it. */
interface LayoutShape {
  readonly word: (data: Uint8Array, offset: number) => number;
  /** Where the word naming the header sits, and what to add to what it says. */
  readonly headerPointerAt: number;
  readonly headerBias: number;
  readonly imageStride: number;
  readonly animationStride: number;
}

const LAYOUTS: Record<VgaFileLayout, LayoutShape> = {
  simon: {
    word: readU16BE,
    headerPointerAt: 4,
    headerBias: 0,
    // `ImageHeader_Simon` and `AnimationHeader_Simon`.
    imageStride: 8,
    animationStride: 6,
  },
  'old-bundle': {
    word: readU16BE,
    headerPointerAt: 10,
    // Twenty bytes past what the word says, in the reference and without an
    // explanation there either. Kept as a bias rather than folded into the
    // pointer so the two facts stay separable if one of them turns out to be a
    // Version's rather than the layout's.
    headerBias: 20,
    // `ImageHeader_WW` and `AnimationHeader_WW`. The animation entry is
    // **eight** bytes here where Simon's is six, and its script offset is at
    // +6 rather than +4 — the one place the two big-endian layouts disagree
    // about an entry rather than about where the header is.
    imageStride: 8,
    animationStride: 8,
  },
  agos2: {
    word: readU16LE,
    headerPointerAt: 2,
    headerBias: 0,
    // `ImageHeader_Feeble` and `AnimationHeader_Feeble`.
    imageStride: 8,
    animationStride: 6,
  },
};

/**
 * Reads the tables out of a graphics resource.
 *
 * The layout is a parameter rather than something inferred from the bytes, for
 * the reason it always was: inferring it would mean guessing between three
 * plausible readings of the same eighteen bytes, and a wrong guess yields entry
 * counts in the tens of thousands. What changed is that there are three of them
 * and the third is not AGOS 2 — the old-bundle games are their own layout, not
 * Simon's.
 *
 * A table that runs past the end of the resource stops rather than throwing:
 * the entries read are real, and a count that overruns is worth reporting as a
 * short table rather than as an unreadable game.
 */
export function readVgaFile(
  data: Uint8Array,
  options: { agos2?: boolean; layout?: VgaFileLayout } = {},
): VgaFile {
  const shape = LAYOUTS[options.layout ?? (options.agos2 ? 'agos2' : 'simon')];
  const word = shape.word;

  const headerAt = word(data, shape.headerPointerAt) + shape.headerBias;
  // `VgaFile1Header_Common` and `VgaFile1Header_Feeble` differ by the leading
  // word Feeble drops, which is why the two sets of offsets are two apart.
  const agos2 = shape === LAYOUTS.agos2;
  const imageCount = word(data, headerAt + (agos2 ? 0 : 2));
  const animationCount = word(data, headerAt + (agos2 ? 4 : 6));
  const imageTable = word(data, headerAt + (agos2 ? 8 : 10));
  const animationTable = word(data, headerAt + (agos2 ? 12 : 14));

  const images: VgaEntry[] = [];
  for (let index = 0; index < imageCount; index += 1) {
    const at = imageTable + index * shape.imageStride;
    if (at + shape.imageStride > data.length) break;
    images.push(
      agos2
        ? { id: word(data, at), scriptOffset: word(data, at + 4) }
        : {
            id: word(data, at),
            colour: word(data, at + 2),
            scriptOffset: word(data, at + 6),
          },
    );
  }

  const animations: VgaEntry[] = [];
  for (let index = 0; index < animationCount; index += 1) {
    const at = animationTable + index * shape.animationStride;
    if (at + shape.animationStride > data.length) break;
    animations.push(
      agos2
        ? { id: word(data, at + 4), scriptOffset: word(data, at) }
        : {
            id: word(data, at),
            scriptOffset: word(data, at + (shape.animationStride === 8 ? 6 : 4)),
          },
    );
  }

  return { images, animations, headerAt };
}

/** The layout a Version's graphics resources are in. */
export function vgaLayoutFor(version: string): VgaFileLayout {
  if (version === 'Feeble' || version === 'PuzzlePack') return 'agos2';
  if (version === 'Simon1' || version === 'Simon2') return 'simon';
  return 'old-bundle';
}
