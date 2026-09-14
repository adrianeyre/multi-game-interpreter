import { append, chunk, u16le } from './encode.js';
import type { IndexedImage } from './ImageEncoder.js';

/** One drawn cel of a costume, positioned relative to the actor's feet. */
export interface CostumeCel {
  image: IndexedImage;
  /** Offset from the actor's origin. `relY` is normally negative. */
  relX?: number;
  relY?: number;
  /**
   * Engine ticks to hold this cel before advancing.
   *
   * Implemented by repeating the cel in the command stream, which is how the
   * original artwork does it — the alternative would be a per-actor animation
   * speed, and that is one rate for the whole costume rather than per cel.
   */
  hold?: number;
}

/**
 * One animation frame, with an optional cel per facing.
 *
 * Supplying only `all` reuses the same artwork for every direction, which is
 * what a simple game wants. Supplying `west` and leaving `east` unset gets the
 * east view for free — the engine mirrors it.
 */
export interface CostumeFrame {
  all?: CostumeCel | CostumeCel[];
  north?: CostumeCel | CostumeCel[];
  east?: CostumeCel | CostumeCel[];
  south?: CostumeCel | CostumeCel[];
  west?: CostumeCel | CostumeCel[];
}

/** Command bytes at or above this are reserved by the format. */
const MAX_CEL_INDEX = 0x77;

/** Default ticks per cel: roughly ten changes a second at 60 Hz. */
const DEFAULT_HOLD = 6;

export interface CostumeDefinition {
  /**
   * Palette indices for costume colours 1 upwards; colour 0 is transparent.
   *
   * Up to 15 with `colors: 16`, or 31 with `colors: 32`.
   */
  palette: number[];
  /**
   * How many colours the costume can address.
   *
   * The format packs a colour and a run length into one byte, so this is a
   * trade: 16 colours leaves 4 bits for run lengths, 32 leaves 3. Fewer bits
   * means more frequent explicit length bytes and slightly larger costumes,
   * which is a price worth paying for twice the palette.
   */
  colors?: 16 | 32;
  /**
   * Frames indexed by frame number. The engine's defaults are 1 = init,
   * 2 = walk, 3 = stand, 4 = talk start, 5 = talk stop, so index 0 is unused.
   */
  frames: CostumeFrame[];
  /** Set when the artwork already contains west-facing views. */
  noMirror?: boolean;
}

/** Direction order inside a costume: west, east, south, north. */
const DIRECTIONS = ['west', 'east', 'south', 'north'] as const;

/**
 * Builds a `COST` resource.
 *
 * The format is a small graph of offsets, all relative to byte 2 of the chunk:
 *
 *   8   animation count, format byte
 *   10  palette
 *   +0  offset of the animation command stream
 *   +2  16 limb frame tables
 *   +34 32 animation definitions
 *
 * Everything is written into one buffer and the offsets are back-patched, since
 * the tables come first but their targets' positions are only known afterwards.
 */
export function buildCostume(definition: CostumeDefinition): number[] {
  const numColors = definition.colors ?? 32;
  const palette = new Array(numColors).fill(0);
  for (let i = 0; i < Math.min(definition.palette.length, numColors); i++) {
    palette[i] = definition.palette[i];
  }

  const body: number[] = [];
  const push = (...values: number[]): number => {
    const at = body.length;
    append(body, values);
    return at;
  };

  const animCmdPointerAt = push(0, 0);
  const frameTableAt = push(...new Array(32).fill(0));
  const dataTableAt = push(...new Array(64).fill(0));

  // Offsets are relative to chunk byte 2; the tables begin at chunk byte
  // 10 + numColors, i.e. body byte 8 + numColors.
  const bodyBase = 8 + numColors;
  const rel = (bodyOffset: number): number => bodyBase + bodyOffset;

  // Each distinct cel gets an index, and a command byte of that value draws it.
  // Command 0x7B is the "nothing to draw" marker.
  const celOffsets: number[] = [];

  /**
   * Cels already written, by their encoded form.
   *
   * A costume stores one animation per direction, so a pose drawn the same way
   * whichever way the character faces writes that same drawing four times.
   * With four poses that is sixteen copies of one picture, against a format
   * that allows 120 in total — which is how an imported costume ran out of
   * room for artwork it did not actually have. Identical cels now share one
   * entry, which is both smaller and what the format's command bytes are for.
   */
  const celsByContent = new Map<string, number>();

  /** Emits a cel's pixels and returns the command byte that draws it. */
  const addCel = (cel: CostumeCel): number => {
    const { image } = cel;
    const relX = (cel.relX ?? -(image.width >> 1)) & 0xffff;
    const relY = (cel.relY ?? -image.height) & 0xffff;
    const pixels = encodeCelPixels(image, numColors);

    // Keyed on everything that makes one cel different from another: two cels
    // that would encode to the same bytes are the same picture.
    const key = `${image.width}x${image.height}:${relX},${relY}:${String.fromCharCode(...pixels)}`;
    const existing = celsByContent.get(key);
    if (existing !== undefined) return existing;

    const at = push(
      ...u16le(image.width),
      ...u16le(image.height),
      ...u16le(relX),
      ...u16le(relY),
      ...u16le(0),
      ...u16le(0),
      ...pixels,
    );
    celOffsets.push(rel(at));
    celsByContent.set(key, celOffsets.length - 1);
    if (celOffsets.length - 1 > MAX_CEL_INDEX) {
      throw new Error(
        `A costume can hold at most ${MAX_CEL_INDEX + 1} distinct cels; ` +
          `command bytes above that are reserved by the format`,
      );
    }
    return celOffsets.length - 1;
  };

  /**
   * The command stream.
   *
   * An animation is a *range* of this array, which the engine walks one entry
   * per tick and loops. So a multi-cel walk is consecutive entries, and holding
   * a cel is simply repeating its command byte.
   */
  const commandStream: number[] = [];

  /** Appends a run for one animation, returning where it starts and its length. */
  const addRun = (cels: CostumeCel[]): { start: number; length: number } => {
    const start = commandStream.length;
    for (const cel of cels) {
      const command = addCel(cel);
      const hold = Math.max(1, Math.min(0x7f, cel.hold ?? DEFAULT_HOLD));
      for (let tick = 0; tick < hold; tick++) commandStream.push(command);
    }
    return { start, length: commandStream.length - start };
  };

  const asList = (value: CostumeCel | CostumeCel[] | undefined): CostumeCel[] => {
    if (!value) return [];
    return Array.isArray(value) ? value : [value];
  };

  // Frame 0 is never played; a placeholder keeps frame numbers aligned with
  // the engine's defaults (1 = init, 2 = walk, ...).
  const frameRuns: Array<Array<{ start: number; length: number } | null>> = [];
  for (const frame of definition.frames) {
    const perDirection: Array<{ start: number; length: number } | null> = [];
    for (const direction of DIRECTIONS) {
      const cels = asList(frame[direction] ?? frame.all);
      perDirection.push(cels.length > 0 ? addRun(cels) : null);
    }
    frameRuns.push(perDirection);
  }

  const animCmdsAt = push(...commandStream, 0x7b);

  // Limb 0's frame table maps a command byte -> that cel's offset.
  const limbFramesAt = push(...celOffsets.flatMap((offset) => u16le(offset)));

  // One animation definition per (frame, direction) pair. The engine indexes
  // them as `direction + frame * 4`.
  // A shared "limb 0 draws nothing" definition, for frames with no artwork in
  // a given direction.
  const emptyAnimAt = push(...u16le(0x8000), ...u16le(0xffff));

  // Body offsets first; converted to costume-relative offsets in one pass, so
  // the two kinds of offset never mix.
  const animBodyOffsets: number[] = [];
  for (const perDirection of frameRuns) {
    for (const run of perDirection) {
      if (!run) {
        animBodyOffsets.push(emptyAnimAt);
        continue;
      }
      // Limb 0 only: mask 0x8000, the run's first command, and a length byte
      // of (count - 1). Bit 7 clear means loop rather than play once and hold.
      animBodyOffsets.push(push(...u16le(0x8000), ...u16le(run.start), (run.length - 1) & 0x7f));
    }
  }
  const animOffsets = animBodyOffsets.map(rel);

  const write16 = (at: number, value: number): void => {
    body[at] = value & 0xff;
    body[at + 1] = (value >> 8) & 0xff;
  };

  write16(animCmdPointerAt, rel(animCmdsAt));
  write16(frameTableAt, rel(limbFramesAt));

  for (let i = 0; i < 32; i++) {
    write16(dataTableAt + i * 2, animOffsets[i] ?? rel(emptyAnimAt));
  }

  // 0x58 is the 16 colour format, 0x59 the 32 colour one.
  const formatByte = (numColors === 32 ? 0x59 : 0x58) | (definition.noMirror ? 0x80 : 0x00);

  return chunk('COST', [
    animOffsets.length, // number of animations
    formatByte,
    ...palette,
    ...body,
  ]);
}

/**
 * Run-length encodes a cel in column-major order.
 *
 * The encoding packs a 4 bit colour and a 4 bit length into one byte; a length
 * of zero means the real length follows in the next byte, which is how runs
 * longer than 15 are expressed. Runs continue across column boundaries.
 */
export function encodeCelPixels(image: IndexedImage, numColors: 16 | 32 = 32): number[] {
  const out: number[] = [];
  const total = image.width * image.height;
  if (total === 0) return out;

  // The byte splits into a colour and a run length. Wider colours mean a
  // narrower length field.
  const shift = numColors === 32 ? 3 : 4;
  const colorMask = numColors === 32 ? 0x1f : 0x0f;
  const maxInlineRun = (1 << shift) - 1;

  const at = (index: number): number => {
    const column = Math.floor(index / image.height);
    const row = index % image.height;
    return image.pixels[row * image.width + column] & colorMask;
  };

  let index = 0;
  while (index < total) {
    const color = at(index);
    let run = 1;
    // 255 is the longest an explicit length byte can express.
    while (index + run < total && at(index + run) === color && run < 255) run++;

    if (run <= maxInlineRun) {
      out.push((color << shift) | run);
    } else {
      // A zero length field means "the real length is the next byte".
      out.push(color << shift, run);
    }
    index += run;
  }

  return out;
}
