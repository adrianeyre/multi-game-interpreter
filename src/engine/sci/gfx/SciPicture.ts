/**
 * A Picture: vector commands painted into three parallel buffers.
 *
 * Recognisably AGI's model with a richer opcode set — lines, fills, patterns,
 * palette operations — and the same three buffers: **visual** for what is seen,
 * **priority** for what occludes what, **control** for where the game may walk.
 * The priority buffer is the one that matters architecturally: it is painted
 * here, from the Picture, and carried on a Plane rather than being a property
 * of the screen (ADR 0015), which is what lets SCI2's compositor be the same
 * compositor with Planes that carry no mask.
 *
 * SCI1.1 Pictures additionally carry embedded cels alongside the vector
 * operations, which is where the format starts drifting toward SCI2's bitmaps
 * (#221, #227).
 */

import { readSciCel, type SciCel } from './SciView.js';

/** The three buffers a Picture paints, all the same size. */
export interface SciPictureBuffers {
  width: number;
  height: number;
  visual: Uint8Array;
  priority: Uint8Array;
  control: Uint8Array;
}

/**
 * One drawing operation, kept so the editor can show and change it (#220).
 *
 * **`args` holds the whole run, not its first point.** The first version of
 * this recorded only where a line run started and drew the rest without
 * recording it, which was enough to render a Picture and not enough to write
 * one back — so "the editor can show and change it" was true of six operations
 * out of fourteen and nothing said which. A command list that cannot be
 * re-emitted is a disassembly, not a representation.
 *
 * Points are absolute in every case, including the runs the resource stores as
 * deltas. The delta encodings are a *compression* of a path — a three-bit step
 * for `shortLines`, a signed byte for `mediumLines` — and holding the path
 * rather than the compression is what lets an author move a point that a
 * three-bit step could no longer reach. `writeSciPicture` picks the encoding.
 */
export interface SciPictureCommand {
  op: string;
  /** The operation's operands: a whole run of absolute x,y pairs for the runs. */
  args: number[];
  /** One texture index per point, where the pattern code says the run carries them. */
  textures?: number[];
  /**
   * Bytes this operation carried that the editor does not model.
   *
   * The extended opcodes — a palette, an embedded cel — are payloads rather
   * than operands, and an editor has nothing to say about them. Held as a span
   * of the original resource and copied verbatim on write, so a Picture whose
   * vectors were edited keeps its palette and its background exactly.
   */
  raw?: { at: number; length: number };
}

export interface SciPictureResult extends SciPictureBuffers {
  commands: SciPictureCommand[];
  /** Palette entries the Picture set for itself, as index/r/g/b quads. */
  palette: Array<{ index: number; r: number; g: number; b: number }>;
  /** EGA's own form: an index and a dithered colour pair, two bytes each. */
  egaPalette: Array<{ index: number; colour: number }>;
  /** Cels a SCI1.1 Picture embedded, drawn after the vectors. */
  cels: Array<{ cel: SciCel; x: number; y: number }>;
  /** An operation the reader did not know, which stops the walk. */
  unknown?: { at: number; op: number };
}

const OP_SET_COLOR = 0xf0;
const OP_DISABLE_VISUAL = 0xf1;
const OP_SET_PRIORITY = 0xf2;
const OP_DISABLE_PRIORITY = 0xf3;
const OP_SHORT_PATTERNS = 0xf4;
const OP_MEDIUM_LINES = 0xf5;
const OP_LONG_LINES = 0xf6;
const OP_SHORT_LINES = 0xf7;
const OP_FILL = 0xf8;
const OP_SET_PATTERN = 0xf9;
const OP_ABSOLUTE_PATTERN = 0xfa;
const OP_SET_CONTROL = 0xfb;
const OP_DISABLE_CONTROL = 0xfc;
const OP_MEDIUM_PATTERNS = 0xfd;
const OP_OPX = 0xfe;
const OP_TERMINATE = 0xff;

/** The white a Picture starts as, and the priority and control it starts at. */
const CLEAR_VISUAL = 0x0f;
const CLEAR_PRIORITY = 0x00;
const CLEAR_CONTROL = 0x00;

export const SCI_PICTURE_WIDTH = 320;
export const SCI_PICTURE_HEIGHT = 190;

/**
 * Draws a Picture resource.
 *
 * `vga` selects the SCI1 reading of the extended opcodes and of the colour
 * byte: an EGA Picture's colour is a dithered *pair* of the sixteen, stored one
 * per byte and displayed by alternating, while a VGA one is a palette index.
 * Reading one as the other gives a picture of the right shapes in the wrong
 * colours, which is the fault class `verifying-version-support.md` names as the
 * one every report about engine state looks correct through.
 */
export function drawSciPicture(
  resource: Uint8Array,
  options: { vga?: boolean; width?: number; height?: number } = {},
): SciPictureResult {
  const width = options.width ?? SCI_PICTURE_WIDTH;
  const height = options.height ?? SCI_PICTURE_HEIGHT;
  const vga = options.vga ?? false;

  const buffers: SciPictureBuffers = {
    width,
    height,
    visual: new Uint8Array(width * height).fill(CLEAR_VISUAL),
    priority: new Uint8Array(width * height).fill(CLEAR_PRIORITY),
    control: new Uint8Array(width * height).fill(CLEAR_CONTROL),
  };
  const commands: SciPictureCommand[] = [];
  const palette: SciPictureResult['palette'] = [];
  const paletteEntries: SciPictureResult['egaPalette'] = [];
  const cels: SciPictureResult['cels'] = [];

  // A SCI1.1 Picture opens with a header size of 0x26 rather than a command,
  // because by then a Picture is a bitmap with vector operations after it
  // rather than the other way round (#221). Reported rather than drawn as
  // vectors: the vector walk over a bitmap produces a picture, and a picture
  // that is wrong for reasons nothing on screen explains is exactly the fault
  // class this renderer exists to avoid.
  if (resource.length > 1 && (resource[0] | (resource[1] << 8)) === 0x26) {
    return {
      ...buffers,
      commands: [],
      palette: [],
      egaPalette: [],
      cels: [],
      unknown: { at: 0, op: 0x26 },
    };
  }

  let at = 0;
  let colour = 0;
  let priority = 0;
  let control = 0;
  let drawVisual = false;
  let drawPriority = false;
  let drawControl = false;
  let patternCode = 0;

  const byte = (): number => resource[at++] ?? 0;

  /**
   * An absolute coordinate: one byte of high nibbles, then a byte each.
   *
   * Nine bits of x and eight of y packed into three bytes, which is how a
   * 320-wide picture fits coordinates in less than four. Getting the nibbles
   * the wrong way round puts every line in the picture somewhere plausible.
   */
  const absolute = (): [number, number] => {
    const high = byte();
    const x = ((high & 0xf0) << 4) | byte();
    const y = ((high & 0x0f) << 8) | byte();
    return [x, y];
  };

  /** A short relative step: two signed three-bit fields in one byte. */
  const relative = (x: number, y: number): [number, number] => {
    const step = byte();
    const dx = (step >> 4) & 0x07;
    const dy = step & 0x07;
    return [x + (step & 0x80 ? -dx : dx), y + (step & 0x08 ? -dy : dy)];
  };

  /** A medium relative step: a signed byte of y then a signed byte of x. */
  const medium = (x: number, y: number): [number, number] => {
    const stepY = byte();
    const dy = stepY & 0x80 ? -(stepY & 0x7f) : stepY;
    const stepX = byte();
    return [x + (stepX > 0x7f ? stepX - 0x100 : stepX), y + dy];
  };

  const plot = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const index = y * width + x;
    if (drawVisual) buffers.visual[index] = colour;
    if (drawPriority) buffers.priority[index] = priority;
    if (drawControl) buffers.control[index] = control;
  };

  const line = (x0: number, y0: number, x1: number, y1: number): void => {
    // Bresenham, which is what Sierra's own interpreter drew and therefore what
    // decides which pixels a fill can escape through. A different line
    // algorithm gives the same picture until a fill leaks.
    let x = x0;
    let y = y0;
    const dx = Math.abs(x1 - x0);
    const dy = -Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      plot(x, y);
      if (x === x1 && y === y1) break;
      const doubled = 2 * error;
      if (doubled >= dy) {
        error += dy;
        x += sx;
      }
      if (doubled <= dx) {
        error += dx;
        y += sy;
      }
    }
  };

  /**
   * A flood fill, bounded by whichever buffers are being drawn to.
   *
   * The boundary test is the subtle part and it is per-buffer: a fill into the
   * visual buffer stops at anything that is not the clear colour *in the visual
   * buffer*, regardless of what the priority buffer holds there. Testing the
   * wrong buffer produces a fill that stops at an invisible edge, which reads
   * as a missing wall.
   */
  const fill = (startX: number, startY: number): void => {
    if (!drawVisual && !drawPriority && !drawControl) return;
    if (startX < 0 || startY < 0 || startX >= width || startY >= height) return;

    const open = (x: number, y: number): boolean => {
      const index = y * width + x;
      if (drawVisual) return buffers.visual[index] === CLEAR_VISUAL;
      if (drawPriority) return buffers.priority[index] === CLEAR_PRIORITY;
      return buffers.control[index] === CLEAR_CONTROL;
    };
    if (!open(startX, startY)) return;

    // Visited is tracked separately from the buffers, and it has to be.
    // Filling with the clear colour writes a pixel that is still open, so a
    // fill that tested the buffer alone would push its neighbours for ever —
    // Quest for Glory II's Pictures do exactly that, and the symptom was an
    // "Invalid array length" from a stack of a hundred million entries rather
    // than anything about a Picture.
    const visited = new Uint8Array(width * height);
    const stack: number[] = [startY * width + startX];
    while (stack.length > 0) {
      const index = stack.pop()!;
      if (visited[index]) continue;
      visited[index] = 1;
      const x = index % width;
      const y = (index / width) | 0;
      if (!open(x, y)) continue;
      plot(x, y);
      if (x > 0) stack.push(index - 1);
      if (x + 1 < width) stack.push(index + 1);
      if (y > 0) stack.push(index - width);
      if (y + 1 < height) stack.push(index + width);
    }
  };

  /** A pattern brush: a circle or a box, solid or textured. */
  const pattern = (x: number, y: number, code: number): void => {
    const size = code & 0x07;
    const circle = (code & 0x10) !== 0;
    for (let dy = -size; dy <= size; dy++) {
      for (let dx = -size; dx <= size; dx++) {
        if (circle && dx * dx + dy * dy > size * size) continue;
        plot(x + dx, y + dy);
      }
    }
  };

  while (at < resource.length) {
    const opcode = byte();

    if (opcode < 0xf0) {
      // Not an operation: the walk has desynchronised, because every command
      // starts with a byte at or above 0xf0. Reported rather than skipped.
      return {
        ...buffers,
        commands,
        palette,
        cels,
        egaPalette: paletteEntries,
        unknown: { at: at - 1, op: opcode },
      };
    }

    switch (opcode) {
      case OP_SET_COLOR:
        colour = byte();
        drawVisual = true;
        commands.push({ op: 'setColour', args: [colour] });
        break;
      case OP_DISABLE_VISUAL:
        drawVisual = false;
        commands.push({ op: 'disableVisual', args: [] });
        break;
      case OP_SET_PRIORITY:
        priority = byte() & 0x0f;
        drawPriority = true;
        commands.push({ op: 'setPriority', args: [priority] });
        break;
      case OP_DISABLE_PRIORITY:
        drawPriority = false;
        commands.push({ op: 'disablePriority', args: [] });
        break;
      case OP_SET_CONTROL:
        control = byte() & 0x0f;
        drawControl = true;
        commands.push({ op: 'setControl', args: [control] });
        break;
      case OP_DISABLE_CONTROL:
        drawControl = false;
        commands.push({ op: 'disableControl', args: [] });
        break;

      case OP_LONG_LINES:
      case OP_MEDIUM_LINES:
      case OP_SHORT_LINES: {
        const step =
          opcode === OP_LONG_LINES ? absolute : opcode === OP_MEDIUM_LINES ? medium : relative;
        let [x, y] = absolute();
        const points = [x, y];
        while (at < resource.length && resource[at] < 0xf0) {
          const [nx, ny] = step(x, y);
          line(x, y, nx, ny);
          x = nx;
          y = ny;
          points.push(x, y);
        }
        commands.push({
          op:
            opcode === OP_LONG_LINES
              ? 'longLines'
              : opcode === OP_MEDIUM_LINES
                ? 'mediumLines'
                : 'shortLines',
          args: points,
        });
        break;
      }

      case OP_FILL: {
        const points: number[] = [];
        while (at < resource.length && resource[at] < 0xf0) {
          const [x, y] = absolute();
          points.push(x, y);
          fill(x, y);
        }
        commands.push({ op: 'fill', args: points });
        break;
      }

      case OP_SET_PATTERN:
        patternCode = byte();
        commands.push({ op: 'setPattern', args: [patternCode] });
        break;
      case OP_ABSOLUTE_PATTERN:
      case OP_SHORT_PATTERNS:
      case OP_MEDIUM_PATTERNS: {
        // A textured pattern carries a texture index before *every* coordinate
        // and a solid one carries none. The bit is in the pattern code set
        // earlier, not in the byte here — reading it from the wrong place
        // shifts every coordinate in the run by one byte.
        const textured = (patternCode & 0x20) !== 0;
        const textures: number[] = [];
        const points: number[] = [];

        // Guarded, because an `absolutePattern` run may legally be empty and
        // the original read its first point unconditionally only because it
        // read every point inside the loop.
        let x = 0;
        let y = 0;
        if (at < resource.length && resource[at] < 0xf0) {
          if (textured) textures.push(byte());
          [x, y] = absolute();
          pattern(x, y, patternCode);
          points.push(x, y);
        }

        const step =
          opcode === OP_ABSOLUTE_PATTERN
            ? absolute
            : opcode === OP_SHORT_PATTERNS
              ? relative
              : medium;
        while (at < resource.length && resource[at] < 0xf0) {
          if (textured) textures.push(byte());
          [x, y] = step(x, y);
          pattern(x, y, patternCode);
          points.push(x, y);
        }
        commands.push({
          op:
            opcode === OP_ABSOLUTE_PATTERN
              ? 'absolutePattern'
              : opcode === OP_SHORT_PATTERNS
                ? 'shortPatterns'
                : 'mediumPatterns',
          args: points,
          ...(textured ? { textures } : {}),
        });
        break;
      }

      case OP_OPX: {
        const opxAt = at - 1;
        const extended = byte();
        if (vga) {
          switch (extended) {
            case 0x00: {
              // Palette entries: pairs of index and colour, until a command.
              while (at < resource.length && resource[at] < 0xf0) {
                const index = byte();
                palette.push({ index, r: byte(), g: byte(), b: byte() });
              }
              break;
            }
            // falls through to the shared span record below
            case 0x01: {
              // An embedded View cel — and for a SCI1 VGA game this is not a
              // detail, it is **the room**.
              //
              // Every one of the 85 vector Pictures across the nine SCI1 VGA
              // demos carries one, and 81 of them are full screen: the vector
              // half paints the priority and control buffers and the visual
              // half is this cel. SCI0, SCI01 and SCI1 EGA-only carry none at
              // all, which is why a renderer written against SCI0 draws those
              // correctly and draws every VGA room as black with its actors
              // floating on it — nothing failed, and the background was simply
              // never asked for.
              //
              // Painted here rather than returned for a caller to composite,
              // because it arrives *in the stream*: a Picture with vector
              // operations after its cel means them to be on top of it, and a
              // caller painting the cels afterwards would put the background
              // over the art. It is still returned as well, so an editor can
              // see the Picture has one (#220).
              //
              // The three bytes in front are zero in all 85. They are skipped
              // rather than read as a position for that reason — a field this
              // project has only ever seen hold zero is a field it does not
              // know the meaning of, and inventing one would be a guess with a
              // renderer behind it.
              at += 3;
              const size = byte() | (byte() << 8);
              const cel = readSciCel(resource, at, true);
              if (cel) {
                cels.push({ cel, x: 0, y: 0 });
                paintCel(buffers, cel, 0, 0);
              }
              at += size;
              break;
            }
            case 0x02: {
              // A whole palette: 256 mapping bytes, four of timestamp, then
              // 1024 bytes of colour.
              at += 256 + 4;
              for (let index = 0; index < 256; index++) {
                at++;
                palette.push({ index, r: byte(), g: byte(), b: byte() });
              }
              break;
            }
            case 0x03:
              at += 14;
              break;
            case 0x04:
              at += 14;
              break;
            default:
              return {
                ...buffers,
                commands,
                palette,
                egaPalette: paletteEntries,
                cels,
                unknown: { at: at - 1, op: extended },
              };
          }
        } else {
          switch (extended) {
            case 0x00:
              // EGA palette *entries*: two bytes each, an index and a colour
              // pair — not the four a VGA entry takes. Establishing this
              // against real data rather than by symmetry with the VGA case was
              // the difference between Space Quest III's Pictures drawing and
              // its second Picture desynchronising at byte four.
              while (at < resource.length && resource[at] < 0xf0) {
                const index = byte();
                paletteEntries.push({ index, colour: byte() });
              }
              break;
            case 0x01:
              // A whole EGA palette: a palette number and 256 entries. 257
              // bytes, not 260 — the four-byte timestamp is the VGA form's.
              at += 1 + 256;
              break;
            case 0x02:
              at += 2;
              break;
            default:
              return {
                ...buffers,
                commands,
                palette,
                egaPalette: paletteEntries,
                cels,
                unknown: { at: at - 1, op: extended },
              };
          }
        }
        // The payload is not modelled, so it is recorded as a span of the
        // original and copied verbatim on write. That is what lets an author
        // edit a Picture's vectors and keep its palette and its background.
        commands.push({ op: 'extended', args: [extended], raw: { at: opxAt, length: at - opxAt } });
        break;
      }

      case OP_TERMINATE:
        commands.push({ op: 'terminate', args: [] });
        return { ...buffers, commands, palette, egaPalette: paletteEntries, cels };

      default:
        return {
          ...buffers,
          commands,
          palette,
          egaPalette: paletteEntries,
          cels,
          unknown: { at: at - 1, op: opcode },
        };
    }
  }

  return { ...buffers, commands, palette, egaPalette: paletteEntries, cels };
}

/**
 * Composites a Picture's own embedded cel into its visual buffer.
 *
 * Visual only. The cel is the room's artwork; the occlusion mask is what the
 * Picture's vector operations paint, and a background that also stamped a
 * priority would occlude every actor standing in front of it.
 *
 * `clearKey` means "leave what is underneath", which for a full-screen
 * background is usually nothing and for a partial one is the vector art
 * already painted.
 */
function paintCel(
  buffers: SciPictureBuffers,
  cel: { width: number; height: number; clearKey: number; pixels: Uint8Array },
  x: number,
  y: number,
): void {
  for (let row = 0; row < cel.height; row++) {
    const destinationY = y + row;
    if (destinationY < 0 || destinationY >= buffers.height) continue;
    for (let column = 0; column < cel.width; column++) {
      const destinationX = x + column;
      if (destinationX < 0 || destinationX >= buffers.width) continue;
      const pixel = cel.pixels[row * cel.width + column];
      if (pixel === cel.clearKey) continue;
      buffers.visual[destinationY * buffers.width + destinationX] = pixel;
    }
  }
}

/**
 * Where a Picture's top row lands on the screen.
 *
 * A SCI16 Picture is 320x190 on a 320x200 screen, and the ten rows it does not
 * cover are the status bar Sierra's interpreter drew at the **top** — so the
 * artwork starts ten rows down and every actor coordinate in the game is
 * measured from there. Placed at zero instead, a room renders complete with a
 * black band along the bottom and every actor ten rows high, which is a picture
 * nothing in a log disagrees with and which is why this was found by looking at
 * one rather than by a test.
 *
 * Derived from the two heights rather than branched on the Version, because
 * SCI32's Planes are the size of their display and land at zero by the same
 * arithmetic. A Picture at least as tall as the screen has no bar to make room
 * for.
 */
export function sci16PictureTop(pictureHeight: number, screenHeight: number): number {
  return Math.max(0, screenHeight - pictureHeight);
}

/**
 * Emits a command list back to a Picture resource (#220, #224).
 *
 * The counterpart of `drawSciPicture`, and the thing that makes "vector
 * Pictures editable" true rather than aspirational: without it the editor can
 * show a Picture's operations and cannot save a change to one.
 *
 * **`original` is the resource the commands were read from**, and it is needed
 * because a command list does not model everything a Picture carries. The
 * extended opcodes — a 1,284-byte palette, a full-screen embedded cel — are
 * payloads rather than operands, and they are copied verbatim from the span the
 * reader recorded. So an author who moves a line keeps the room's artwork and
 * its colours exactly, and a Picture nobody edited is not re-emitted at all
 * (ADR 0010: byte-identity is a property of resources nobody touched, and the
 * cheapest guarantee of it is not to rebuild them).
 *
 * **Line and pattern runs are re-encoded rather than reproduced.** The three
 * encodings differ only in how far one point may be from the last — nine bits
 * absolute, a signed byte, three bits — so this picks the tightest one that
 * fits the whole run and falls back to absolute. An author who drags a point
 * out of a three-bit step's reach gets a `longLines` run rather than an error,
 * which is the behaviour that makes the editor usable; it also means an
 * unedited run may come back in a different encoding, which is why an untouched
 * Picture is carried through instead.
 */
export function writeSciPicture(
  commands: readonly SciPictureCommand[],
  original: Uint8Array,
): Uint8Array {
  const out: number[] = [];

  const putAbsolute = (x: number, y: number): void => {
    out.push(((x >> 4) & 0xf0) | ((y >> 8) & 0x0f), x & 0xff, y & 0xff);
  };

  /**
   * A step byte may never reach 0xf0, whatever fits in its fields.
   *
   * A run ends when the next byte is an opcode, and every opcode is 0xf0 or
   * above — so a step that encodes to 0xf0 *is* a terminator, and the run it
   * was meant to continue stops there. Sierra's own encoder had the same
   * constraint and its data never violates it; this one did, and the symptom
   * was a Picture that re-read as a quarter of its commands and then reported
   * an unknown opcode at the byte after the truncation.
   *
   * `shortLines` reaches it at `dx === -7` (0x80 | 0x70) and `mediumLines` at
   * `dy <= -112` (0x80 | 112). Both are rejected here, and the run falls back
   * to the next encoding out — which is what the fallback chain is for.
   */
  const inOpcodeRange = (value: number): boolean => value >= 0xf0;

  /** A short step, or null when the delta is out of a three-bit field's reach. */
  const shortStep = (dx: number, dy: number): number | null => {
    if (Math.abs(dx) > 7 || Math.abs(dy) > 7) return null;
    const step = (dx < 0 ? 0x80 : 0) | (Math.abs(dx) << 4) | (dy < 0 ? 0x08 : 0) | Math.abs(dy);
    return inOpcodeRange(step) ? null : step;
  };

  /** A medium step, or null when either delta is out of a signed byte's reach. */
  const mediumStep = (dx: number, dy: number): number[] | null => {
    if (dy < -127 || dy > 127 || dx < -128 || dx > 127) return null;
    const first = dy < 0 ? 0x80 | -dy : dy;
    // Only the first byte can end a run, because that is the one the reader
    // tests. The second is read unconditionally once the step has started.
    return inOpcodeRange(first) ? null : [first, dx < 0 ? dx + 0x100 : dx];
  };

  /** Which encoding a whole run fits in, tightest first. */
  const encodingFor = (points: readonly number[]): 'short' | 'medium' | 'long' => {
    let short = true;
    let medium = true;
    for (let i = 2; i < points.length; i += 2) {
      const dx = points[i] - points[i - 2];
      const dy = points[i + 1] - points[i - 1];
      if (shortStep(dx, dy) === null) short = false;
      if (mediumStep(dx, dy) === null) medium = false;
    }
    return short ? 'short' : medium ? 'medium' : 'long';
  };

  const putRun = (
    points: readonly number[],
    textures: readonly number[] | undefined,
    opcodes: { short: number; medium: number; long: number },
  ): void => {
    if (points.length < 2) return;
    // A texture byte leads its point, so it is the byte the reader tests for
    // the end of the run and must not reach the opcode range either. Clamped
    // rather than rejected: a texture index is a pattern lookup and 0xef is as
    // valid as 0xf0, where refusing the run would lose the operation.
    const texture = (index: number): number => Math.min(textures?.[index] ?? 0, 0xef);
    const encoding = encodingFor(points);
    out.push(opcodes[encoding]);
    if (textures) out.push(texture(0));
    putAbsolute(points[0], points[1]);
    for (let i = 2; i < points.length; i += 2) {
      if (textures) out.push(texture(i / 2));
      const dx = points[i] - points[i - 2];
      const dy = points[i + 1] - points[i - 1];
      if (encoding === 'short') out.push(shortStep(dx, dy)!);
      else if (encoding === 'medium') out.push(...mediumStep(dx, dy)!);
      else putAbsolute(points[i], points[i + 1]);
    }
  };

  for (const command of commands) {
    switch (command.op) {
      case 'setColour':
        out.push(OP_SET_COLOR, command.args[0] & 0xff);
        break;
      case 'disableVisual':
        out.push(OP_DISABLE_VISUAL);
        break;
      case 'setPriority':
        out.push(OP_SET_PRIORITY, command.args[0] & 0x0f);
        break;
      case 'disablePriority':
        out.push(OP_DISABLE_PRIORITY);
        break;
      case 'setControl':
        out.push(OP_SET_CONTROL, command.args[0] & 0x0f);
        break;
      case 'disableControl':
        out.push(OP_DISABLE_CONTROL);
        break;
      case 'setPattern':
        out.push(OP_SET_PATTERN, command.args[0] & 0xff);
        break;

      case 'longLines':
      case 'mediumLines':
      case 'shortLines':
        putRun(command.args, undefined, {
          short: OP_SHORT_LINES,
          medium: OP_MEDIUM_LINES,
          long: OP_LONG_LINES,
        });
        break;

      case 'absolutePattern':
      case 'shortPatterns':
      case 'mediumPatterns':
        putRun(command.args, command.textures, {
          short: OP_SHORT_PATTERNS,
          medium: OP_MEDIUM_PATTERNS,
          long: OP_ABSOLUTE_PATTERN,
        });
        break;

      case 'fill': {
        // Every point absolute, because a fill run has no delta encoding: each
        // coordinate is a separate seed rather than a step along a path.
        if (command.args.length < 2) break;
        out.push(OP_FILL);
        for (let i = 0; i < command.args.length; i += 2) {
          putAbsolute(command.args[i], command.args[i + 1]);
        }
        break;
      }

      case 'extended': {
        const span = command.raw;
        if (!span) break;
        for (let i = 0; i < span.length; i++) out.push(original[span.at + i] ?? 0);
        break;
      }

      case 'terminate':
        out.push(OP_TERMINATE);
        break;

      default:
        // An operation nothing here emits is dropped rather than guessed at,
        // and the caller is told by the count coming back short.
        break;
    }
  }

  if (out[out.length - 1] !== OP_TERMINATE) out.push(OP_TERMINATE);
  return new Uint8Array(out);
}
