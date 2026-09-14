/**
 * A View: cel groups in loops, and the thing a SCI actor actually is.
 *
 * Recognisably AGI's model with more in it — mirroring, transparency, scaling,
 * and per-pixel priority — and the per-pixel part is what matters most: a View
 * cel is blitted against the priority buffer pixel by pixel, so scenery painted
 * into the Picture can occlude the middle of an actor while its head shows
 * above. That is the property #225 tests the one-compositor claim against, and
 * it is why the buffer sits on a Plane rather than being a screen the renderer
 * happens to have.
 *
 * Three cel encodings behind one resource type: SCI0's EGA cels, SCI1's VGA
 * ones, and the **V56** form SCI1.1 introduced and everything after it kept.
 * Told apart by the resource's own bytes rather than by asking which Version is
 * running, so a release that disagrees with its bucket still draws — the same
 * rule ADR 0018 sets for the two kinds of Picture, and for the same reason.
 *
 * **V56 is the Picture's cel header.** A SCI1.1 View's cel and a SCI1.1
 * Picture's cel are the same 42-byte record with the same two-stream run-length
 * body, which is why `readSci11Cel` below serves both and `SciCelPicture` calls
 * into this file rather than carrying a copy. Discovered by reading King's
 * Quest VI, Space Quest 6, Torin's Passage and Lighthouse rather than assumed,
 * and it is more evidence for ADR 0015's claim that SCI's resource layout
 * drifts rather than breaks.
 */

export interface SciCel {
  width: number;
  height: number;
  /** Where the cel's origin sits relative to the actor's position. */
  displaceX: number;
  displaceY: number;
  /** The index that means "leave what is underneath". */
  clearKey: number;
  /** One byte per pixel, `clearKey` where nothing is drawn. */
  pixels: Uint8Array;
  /**
   * Where this cel's record sits in the resource it was read from, for the
   * forms that are written back in place rather than rebuilt.
   *
   * Absent for a cel that has no record of its own: a mirrored loop's cels are
   * another loop's pixels flipped, so writing a displacement "back" would write
   * it into the loop being mirrored and move both.
   */
  recordAt?: number;
}

export interface SciLoop {
  cels: SciCel[];
  /** True when this loop is another one drawn backwards. */
  mirrored: boolean;
  /** The loop it mirrors, when it does. */
  mirrorOf: number;
}

export interface SciViewResource {
  loops: SciLoop[];
  /** Set when the View carries a palette of its own, as VGA Views may. */
  paletteOffset: number;
  /** True when cels are VGA, which changes only how a run is decoded. */
  vga: boolean;
  /**
   * Which of the three encodings this View turned out to be in.
   *
   * Reported rather than kept private, because "the actor is a rectangle of
   * noise" and "this View is in a form the reader did not recognise" are the
   * same fault seen from two ends, and only the second one is actionable.
   */
  encoding: 'ega' | 'vga' | 'v56';
  /** The display size a V56 View declares, where it declares one. */
  resolution: { width: number; height: number } | null;
  /**
   * The bytes this View was read from, kept for the in-place writer.
   *
   * ADR 0018's rule for Scripts, applied to artwork: a resource that is not
   * rebuilt keeps its own bytes, and an edit is a patch into them. It is what
   * makes a V56 View writable at all — the cel record has fields this reader
   * does not model, and rebuilding one would have to invent them.
   */
  source?: Uint8Array;
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function putS16(bytes: Uint8Array, at: number, value: number): void {
  const stored = value < 0 ? value + 0x10000 : value;
  bytes[at] = stored & 0xff;
  bytes[at + 1] = (stored >> 8) & 0xff;
}

function s8(value: number): number {
  return value > 0x7f ? value - 0x100 : value;
}

function s16(bytes: Uint8Array, at: number): number {
  const value = u16(bytes, at);
  return value > 0x7fff ? value - 0x10000 : value;
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/**
 * Decodes a View resource.
 *
 * The header is a loop count, a flags byte, a mirror mask, a version and a
 * palette offset, then a loop offset table. A loop is a cel count and a cel
 * offset table; a cel is an eight-byte header and a run-length stream.
 *
 * **Mirrored loops share their source's cels rather than copying them.** The
 * mask says which, and a decoder that reads a mirrored loop's offset as its own
 * data reads the previous loop's cels a second time — which draws, and draws
 * the actor facing the wrong way in half its directions.
 */
export function readSciView(resource: Uint8Array): SciViewResource {
  if (resource.length < 8) {
    return { loops: [], paletteOffset: 0, vga: false, encoding: 'ega', resolution: null };
  }
  if (isV56(resource)) return readV56View(resource);

  const loopCount = resource[0];
  const flags = resource[1];
  const mirrorMask = u16(resource, 2);
  const paletteOffset = u16(resource, 6);
  // Bit 7 of the flags byte is what the compressed-View rebuild writes for a
  // VGA cel stream, and what Sierra's own VGA Views carry.
  const vga = (flags & 0x80) !== 0;

  const loops: SciLoop[] = [];
  for (let loop = 0; loop < loopCount; loop++) {
    const offset = u16(resource, 8 + loop * 2);
    const mirrored = (mirrorMask & (1 << loop)) !== 0;

    if (offset + 4 > resource.length) {
      loops.push({ cels: [], mirrored, mirrorOf: loop });
      continue;
    }

    const celCount = resource[offset];
    const cels: SciCel[] = [];
    for (let cel = 0; cel < celCount; cel++) {
      const celAt = u16(resource, offset + 4 + cel * 2);
      const decoded = readSciCel(resource, celAt, vga);
      if (decoded) cels.push(decoded);
    }
    loops.push({ cels, mirrored, mirrorOf: loop });
  }

  // A mirrored loop's cels are the loop before it, drawn backwards. Resolved
  // here rather than at blit time so the renderer never asks which kind it has.
  for (let loop = 0; loop < loops.length; loop++) {
    if (!loops[loop].mirrored || loop === 0) continue;
    const source = loops[loop - 1];
    loops[loop] = {
      cels: source.cels.map(mirrorCel),
      mirrored: true,
      mirrorOf: loop - 1,
    };
  }

  return { loops, paletteOffset, vga, encoding: vga ? 'vga' : 'ega', resolution: null };
}

/**
 * Whether this is a V56 View, asked of the bytes and not of the Version.
 *
 * Three fields have to agree: a header size of 16 or 18, a loop record of 16
 * bytes, and a cel record of 36 or 52. One of them alone would misfire — an
 * SCI0 View with sixteen loops opens with the same two bytes as a SCI1.1
 * header — and all three agreeing by accident on a resource that is not one is
 * not a thing this project has managed to construct.
 *
 * The 36-and-52 pair is the SCI2.1 seam showing through: the later games'
 * larger cel record is where the scaling fields went, and it is why the header
 * size moves from 16 to 18 at the same time.
 */
function isV56(resource: Uint8Array): boolean {
  if (resource.length < 16) return false;
  const headerSize = u16(resource, 0);
  const loopSize = resource[12];
  const celSize = resource[13];
  return (
    (headerSize === 16 || headerSize === 18) &&
    loopSize === 16 &&
    (celSize === 36 || celSize === 52) &&
    resource[2] > 0 &&
    resource[2] < 100
  );
}

/**
 * The V56 form: a header, a table of loop records, and cel records they point at.
 *
 * A loop's first byte is the loop it *mirrors*, or 255 when it is its own. That
 * is the same idea SCI0 expressed as a bitmask, moved into the record — and the
 * indirection is followed here rather than at blit time so the rest of the
 * renderer never learns that mirrored loops exist.
 */
function readV56View(resource: Uint8Array): SciViewResource {
  // **Plus two, and the two are not padding.** The stored value counts the
  // header from after its own length word, so the loop table starts two bytes
  // later than it reads. Sixteen becomes eighteen and eighteen becomes twenty,
  // which is exactly the room the declared resolution at offsets 14 and 16
  // needs — a reader that trusts the stored number lands on the resolution's
  // low byte, reads 0xe0 as a mirror index, and returns a View with no cels in
  // it. Found that way rather than read off a wiki.
  const headerSize = u16(resource, 0) + 2;
  const loopCount = resource[2];
  const paletteOffset = u32(resource, 8);
  const loopSize = resource[12];
  const celSize = resource[13];
  const width = u16(resource, 14);
  const height = u16(resource, 16);

  const loops: SciLoop[] = [];
  for (let loop = 0; loop < loopCount; loop++) {
    const entry = headerSize + loop * loopSize;
    if (entry + loopSize > resource.length) {
      loops.push({ cels: [], mirrored: false, mirrorOf: loop });
      continue;
    }

    const mirrorOf = resource[entry];
    const mirrored = mirrorOf !== 0xff;
    // A mirrored loop's own record carries no cels; the one it names does.
    const source = mirrored ? headerSize + mirrorOf * loopSize : entry;
    if (mirrored && (mirrorOf >= loopCount || source + loopSize > resource.length)) {
      loops.push({ cels: [], mirrored: true, mirrorOf });
      continue;
    }

    const celCount = resource[source + 2];
    const celsAt = u32(resource, source + 12);
    // Zero here means the loop record did not point anywhere — offset zero is
    // the View's own header, and reading it as a cel produces a cel.
    if (celsAt === 0) {
      loops.push({ cels: [], mirrored, mirrorOf: mirrored ? mirrorOf : loop });
      continue;
    }
    const cels: SciCel[] = [];
    for (let index = 0; index < celCount; index++) {
      const at = celsAt + index * celSize;
      const cel = readSci11Cel(resource, at);
      if (!cel) continue;
      // The record is named only for a loop that owns it. A mirrored loop
      // shares the record of the loop it names, and an edit written through it
      // would move the original too.
      cels.push(mirrored ? mirrorCel(cel) : { ...cel, recordAt: at });
    }
    loops.push({ cels, mirrored, mirrorOf: mirrored ? mirrorOf : loop });
  }

  return {
    loops,
    paletteOffset,
    vga: true,
    encoding: 'v56',
    resolution: width > 0 && height > 0 ? { width, height } : null,
    source: resource,
  };
}

/**
 * One cel in the record SCI1.1 introduced, shared by Views and Pictures.
 *
 * Width, height, displacement and a transparent index, then two stream offsets
 * near the end: control bytes at 24 and the pixels they consume at 28. A
 * literal offset of zero means there is no second stream and the pixels follow
 * the control bytes inline — which King's Quest VI's own artwork does, and
 * which a reader assuming two streams decodes into something that fills the
 * frame and is not the picture.
 *
 * **`declaresCompression` is not a Version question in disguise.** The byte at
 * offset 9 is a compression method for a V56 View and for a SCI32 Picture's
 * cel, and it is *not one* for a SCI1.1 Picture's — King's Quest VI's Pictures
 * carry `0x0a` there, which is neither of Sierra's two methods. Those cels are
 * always the two-stream run-length form, and the caller that knows which
 * container it opened is the only thing that can say so.
 *
 * This was learned by breaking it: folding the SCI1.1 Picture's cel into this
 * reader without the flag made every SCI1.1 background refuse itself, and the
 * fixtures did not catch it because a fixture writes a zero there. `npm run
 * shot:sci` caught it, which is the reason #218 makes that a criterion.
 */
export function readSci11Cel(
  resource: Uint8Array,
  at: number,
  declaresCompression = true,
): SciCel | null {
  // A negative or out-of-range offset only. **Zero is not treated as absent
  // here**, because a guard that quietly means two things is how "this cel is
  // missing" and "this cel is at the start" become the same answer; a caller
  // for which zero means absent says so where it knows that.
  if (at < 0 || at + 32 > resource.length) return null;

  const width = u16(resource, at);
  const height = u16(resource, at + 2);
  // Refused rather than clamped, as `readSciCel` refuses: a cel larger than any
  // screen SCI drove is a header read at the wrong offset, and allocating for
  // it turns a bad offset into an allocation failure instead of a sentence.
  if (width === 0 || height === 0 || width > 2048 || height > 2048) return null;

  const displaceX = s16(resource, at + 4);
  const displaceY = s16(resource, at + 6);
  const clearKey = resource[at + 8];
  const compression = declaresCompression ? resource[at + 9] : 138;
  const rleAt = u32(resource, at + 24);
  const literalAt = u32(resource, at + 28);

  const pixels = new Uint8Array(width * height).fill(clearKey);

  if (compression === 0 && literalAt === 0) {
    // SCI32's uncompressed cel: the pixels are simply there, and offset 24
    // points at them. Every full-screen SCI2 background is one of these.
    if (rleAt + width * height > resource.length) return null;
    pixels.set(resource.subarray(rleAt, rleAt + width * height));
    return { width, height, displaceX, displaceY, clearKey, pixels };
  }
  if (compression !== 0 && compression !== 138) return null;
  if (rleAt >= resource.length) return null;

  unpackSci11Cel(resource, rleAt, literalAt, pixels);
  return { width, height, displaceX, displaceY, clearKey, pixels };
}

/**
 * The two-stream run-length body.
 *
 * A control byte's top two bits are the operation and its low six the run:
 * `0x00` takes that many pixels from the literal stream, `0x80` repeats one of
 * them, and `0xc0` skips — leaving the transparent index already filled in,
 * which is why the buffer is filled before this is called rather than after.
 */
export { unpackSci11Cel as unpackSci11CelForTest };

function unpackSci11Cel(
  resource: Uint8Array,
  rleAt: number,
  literalAt: number,
  pixels: Uint8Array,
): void {
  let control = rleAt;
  let literal = literalAt;
  const inline = literalAt === 0;
  let written = 0;

  while (written < pixels.length && control < resource.length) {
    const byte = resource[control++];
    const run = byte & 0x3f;
    const operation = byte & 0xc0;

    if (operation === 0x00) {
      for (let i = 0; i < run && written < pixels.length; i++) {
        pixels[written++] = resource[inline ? control++ : literal++] ?? 0;
      }
    } else if (operation === 0x80) {
      const colour = resource[inline ? control++ : literal++] ?? 0;
      for (let i = 0; i < run && written < pixels.length; i++) pixels[written++] = colour;
    } else {
      written += run;
    }
  }
}

/**
 * The inverse of `unpackSci11Cel`: pixels back into the two-stream body.
 *
 * **Written because a paint surface without it is an editor that loses the
 * picture.** `writeSciView` rebuilds a pre-V56 View from its cels and patches a
 * V56 one in place, so until this existed a V56 cel's pixels — SCI1.1 and every
 * SCI32 game — could be read and never written.
 *
 * The encoding decides itself run by run, which is all the format allows: a run
 * is at most 63 pixels because six bits hold it.
 *
 * - a run of the transparent index becomes a **skip**, which costs one byte
 *   however long it is and writes no literal at all;
 * - a run of one repeated colour becomes a **repeat**, one control byte and one
 *   literal;
 * - anything else becomes a **literal** run.
 *
 * A repeat is only worth taking for two pixels or more — one pixel costs the
 * same either way and starting a repeat for it would end a literal run that
 * could have swallowed it — so a single pixel between two others stays in the
 * literal run around it.
 *
 * `inline` writes the literals into the control stream after each control byte,
 * which is the form a cel with no separate literal offset uses.
 */
export function packSci11Cel(
  pixels: Uint8Array,
  clearKey: number,
  inline: boolean,
): { control: Uint8Array; literal: Uint8Array } {
  const control: number[] = [];
  const literal: number[] = [];
  const put = (byte: number): void => {
    (inline ? control : literal).push(byte);
  };

  let at = 0;
  while (at < pixels.length) {
    const value = pixels[at];

    // How many of the same value follow, capped at what six bits hold.
    let same = 1;
    while (same < 63 && at + same < pixels.length && pixels[at + same] === value) same++;

    if (value === clearKey) {
      control.push(0xc0 | same);
      at += same;
      continue;
    }
    if (same >= 2) {
      control.push(0x80 | same);
      put(value);
      at += same;
      continue;
    }

    // A literal run, ending where a worthwhile repeat or a skip begins.
    let run = 0;
    while (run < 63 && at + run < pixels.length) {
      const here = pixels[at + run];
      if (here === clearKey) break;
      if (
        run > 0 &&
        at + run + 1 < pixels.length &&
        pixels[at + run + 1] === here &&
        // Two ahead as well, or the repeat is not worth breaking the run for.
        at + run + 2 < pixels.length &&
        pixels[at + run + 2] === here
      ) {
        break;
      }
      run++;
    }
    control.push(0x00 | run);
    for (let i = 0; i < run; i++) put(pixels[at + i]);
    at += run;
  }

  return { control: Uint8Array.from(control), literal: Uint8Array.from(literal) };
}

/** One cel, decoded out of its run-length stream. */
export function readSciCel(resource: Uint8Array, at: number, vga: boolean): SciCel | null {
  if (at + 8 > resource.length) return null;

  const width = u16(resource, at);
  const height = u16(resource, at + 2);
  // Refused rather than clamped: a cel larger than the screen is a header read
  // at the wrong offset, and allocating for it is how a bad offset becomes an
  // allocation failure instead of a message.
  if (width === 0 || height === 0 || width > 640 || height > 480) return null;

  const displaceX = s8(resource[at + 4]);
  const displaceY = s8(resource[at + 5]);
  const clearKey = resource[at + 6];

  const pixels = new Uint8Array(width * height).fill(clearKey);
  let source = at + 8;
  let written = 0;
  const total = width * height;

  while (written < total && source < resource.length) {
    const control = resource[source++];
    if (vga) {
      // VGA: the top two bits are the operation and the low six the run
      // length. `0x00` is a literal run, `0x80` a fill and `0xc0` a skip.
      const run = control & 0x3f;
      const operation = control & 0xc0;
      if (operation === 0x00) {
        for (let i = 0; i < run && written < total; i++) pixels[written++] = resource[source++];
      } else if (operation === 0x80) {
        const colour = resource[source++];
        for (let i = 0; i < run && written < total; i++) pixels[written++] = colour;
      } else {
        written += run;
      }
      continue;
    }

    // **EGA: the run is the high nibble and the colour the low one.** This was
    // written the other way round, and the other way round is not merely wrong
    // — it is unreadable: King's Quest IV's View 879 opens `f0 f0 f0 10`,
    // which is three runs of fifteen and one of one, exactly the 46 pixels of
    // its first row. Read as colour-then-run, `f0` is colour 15 for a run of
    // *nought*, so every byte wrote nothing while the reader advanced, and
    // every actor in every SCI0 game came out as a column of stripes.
    //
    // ScummVM's `unpackCelData` is two lines and says the same thing:
    // `runLength = curByte >> 4; memset(..., curByte & 0x0F, ...)`.
    const run = control >> 4;
    const colour = control & 0x0f;
    for (let i = 0; i < run && written < total; i++) pixels[written++] = colour;
  }

  return { width, height, displaceX, displaceY, clearKey, pixels };
}

function mirrorCel(cel: SciCel): SciCel {
  const pixels = new Uint8Array(cel.pixels.length);
  for (let y = 0; y < cel.height; y++) {
    for (let x = 0; x < cel.width; x++) {
      pixels[y * cel.width + x] = cel.pixels[y * cel.width + (cel.width - 1 - x)];
    }
  }
  return {
    ...cel,
    // The displacement mirrors with the pixels, or a mirrored actor stands
    // half a cel to one side of where it did facing the other way.
    displaceX: -cel.displaceX,
    pixels,
  };
}

/**
 * Emits a cel's pixels back to a run-length stream (#220, #224).
 *
 * The inverse of the loop in `readSciCel`, and it chooses runs rather than
 * reproducing the ones it was given: a cel is held as pixels, so what came in
 * as a fill of nine and a fill of seven goes out as a fill of sixteen. That is
 * why a View nobody edited is carried through rather than re-emitted.
 *
 * **A run length is six bits for VGA and four for EGA**, and a longer one is
 * split rather than truncated — the difference between a cel that is shorter
 * than it should be and one that is wrong from the split onwards.
 */
function writeSciCelPixels(cel: SciCel, vga: boolean): number[] {
  const out: number[] = [];
  const limit = vga ? 0x3f : 0x0f;
  const total = cel.width * cel.height;
  let at = 0;

  while (at < total) {
    const colour = cel.pixels[at];
    let run = 1;
    while (at + run < total && cel.pixels[at + run] === colour && run < limit) run++;

    if (!vga) {
      // The run in the high nibble and the colour in the low one, matching the
      // reader above. An EGA cel can hold sixteen colours whatever the palette
      // says, and a colour above fifteen cannot be written at all — clamping is
      // honest where truncating the run would be silent.
      out.push((run << 4) | (colour & 0x0f));
      at += run;
      continue;
    }

    if (colour === cel.clearKey) out.push(0xc0 | run);
    else if (run > 1) out.push(0x80 | run, colour);
    else {
      // A literal run, which is worth using only where the pixels differ:
      // gather up to the limit of non-repeating, non-transparent ones.
      let length = 0;
      while (
        at + length < total &&
        length < limit &&
        cel.pixels[at + length] !== cel.clearKey &&
        !(at + length + 1 < total && cel.pixels[at + length] === cel.pixels[at + length + 1])
      ) {
        length++;
      }
      if (length === 0) length = 1;
      out.push(0x00 | length);
      for (let i = 0; i < length; i++) out.push(cel.pixels[at + i]);
      at += length;
      continue;
    }
    at += run;
  }
  return out;
}

/** Why a View cannot be written back, or null. */
export function describeUnwritableSciView(view: SciViewResource): string | null {
  if (view.encoding === 'v56' && !view.source) {
    return (
      'This is a V56 View — SCI1.1 and later, with a 36- or 52-byte cel record — and the bytes ' +
      'it was read from were not kept, so there is nothing to patch a change into.'
    );
  }
  return null;
}

/**
 * What a writable View still will not take, or null.
 *
 * **Not the same question as `describeUnwritableSciView`, and the difference is
 * the point.** That one says a View cannot be written at all. This one says a
 * View is written *in place* — so the fields the record holds are editable and
 * the pixels are not, because re-encoding a cel's run-length body changes its
 * length and moves every record after it.
 *
 * A V56 cel record carries scaling fields, a compression method and two stream
 * offsets that this reader does not model. Rebuilding one would have to invent
 * them; patching the four bytes of displacement inside it invents nothing.
 */
export function describeSciViewInPlace(view: SciViewResource): string | null {
  if (view.encoding !== 'v56') return null;
  return (
    "A V56 View is written back in place: each cel's origin is patched into the record it was " +
    'read from. Its artwork is not re-encoded — a cel body is two run-length streams whose ' +
    'length would change, and every record after it points at a fixed offset.'
  );
}

/**
 * Emits a View back to a resource (#220, #224).
 *
 * The SCI0 and SCI1 form only — a loop count, a flags byte, a mirror mask and a
 * palette offset, then a loop table, then a cel table per loop. V56 is refused
 * by name rather than half-written, because a V56 cel record carries scaling
 * fields this has no values for and inventing them would produce a View that
 * loads and draws an actor the wrong size.
 *
 * **A mirrored loop is written as a mirror, not as pixels.** `readSciView`
 * resolves one into the cels of the loop before it so the renderer never has to
 * ask; writing those pixels out would double the View's size and lose the fact
 * that Sierra meant them to be the same artwork.
 */
export function writeSciView(view: SciViewResource): Uint8Array {
  const refusal = describeUnwritableSciView(view);
  if (refusal) throw new Error(refusal);

  // V56 is patched rather than rebuilt, for the reason
  // `describeSciViewInPlace` gives. A cel with no record of its own is a
  // mirrored loop's, and is skipped rather than written through to the loop it
  // mirrors.
  if (view.encoding === 'v56' && view.source) {
    const patched = new Uint8Array(view.source);
    for (const loop of view.loops) {
      for (const cel of loop.cels) {
        if (cel.recordAt === undefined || cel.recordAt + 8 > patched.length) continue;
        putS16(patched, cel.recordAt + 4, cel.displaceX);
        putS16(patched, cel.recordAt + 6, cel.displaceY);
      }
    }
    return patched;
  }

  const loopCount = view.loops.length;
  let mirrorMask = 0;
  for (const [index, loop] of view.loops.entries()) {
    if (loop.mirrored && index > 0) mirrorMask |= 1 << index;
  }

  // Header, then the loop offset table. Both are fixed width, so where each
  // loop's record starts is known before any of them is built.
  const header = 8 + loopCount * 2;
  const loopBodies: number[][] = [];
  const loopOffsets: number[] = [];
  let at = header;

  for (const loop of view.loops) {
    loopOffsets.push(at);
    const written = loop.mirrored && mirrorMask !== 0 ? [] : loop.cels;
    // A loop record: a cel count, two bytes this format does not use, then a
    // cel offset each. The cel bodies follow the table.
    const tableSize = 4 + written.length * 2;
    const celBodies: number[][] = [];
    const celOffsets: number[] = [];
    let celAt = at + tableSize;
    for (const cel of written) {
      celOffsets.push(celAt);
      const body = [
        cel.width & 0xff,
        cel.width >> 8,
        cel.height & 0xff,
        cel.height >> 8,
        cel.displaceX & 0xff,
        cel.displaceY & 0xff,
        cel.clearKey & 0xff,
        0,
        ...writeSciCelPixels(cel, view.vga),
      ];
      celBodies.push(body);
      celAt += body.length;
    }
    const record = [written.length, 0, 0, 0];
    for (const offset of celOffsets) record.push(offset & 0xff, offset >> 8);
    for (const body of celBodies) record.push(...body);
    loopBodies.push(record);
    at += record.length;
  }

  const out = new Uint8Array(at);
  out[0] = loopCount;
  out[1] = view.vga ? 0x80 : 0;
  out[2] = mirrorMask & 0xff;
  out[3] = mirrorMask >> 8;
  out[6] = view.paletteOffset & 0xff;
  out[7] = view.paletteOffset >> 8;
  for (const [index, offset] of loopOffsets.entries()) {
    out[8 + index * 2] = offset & 0xff;
    out[8 + index * 2 + 1] = offset >> 8;
  }
  let write = header;
  for (const body of loopBodies) {
    out.set(body, write);
    write += body.length;
  }
  return out;
}
