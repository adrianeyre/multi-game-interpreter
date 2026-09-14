/**
 * AGI Pictures: a list of draw commands executed into two buffers.
 *
 * A Picture is not a bitmap. It is pen colour changes, absolute and relative
 * line runs, corner runs, flood fills and pen plots, executed into the **visual**
 * screen and the **priority** screen in one pass. `CONTEXT.md` defines
 * **Priority band**: fifteen horizontal strips baked into the Picture that
 * decide what draws in front of what and what blocks walking. It does the job
 * SCUMM splits between z-order and walk boxes, but as a property of the picture
 * rather than of the room's geometry — which is why editing a Picture edits what
 * blocks walking (#135).
 *
 * Nothing here is shared with `src/engine/gfx/BitmapCodec.ts`. That decodes
 * SCUMM strip bitmaps, which have no relationship to a command stream.
 *
 * The algorithms are transcribed from ScummVM's `picture.cpp` rather than
 * derived, because every one of them fails *plausibly*: a line drawn with the
 * wrong rounding is still a line, a fill with the wrong boundary rule still
 * fills something, and a priority band off by one row still produces a picture.
 * #127 is explicit that no unit test catches those — so the tests here assert
 * the properties that are checkable (a fill stays inside the buffer, a
 * command stream terminates, both buffers come from one pass) and the rest is
 * judged by eye.
 */

import { PICTURE_HEIGHT, PICTURE_WIDTH, PRIORITY_EMPTY, VISUAL_EMPTY } from './agiPalette.js';

/** Any byte at or above this is a command; below it, argument data. */
const MIN_COMMAND = 0xf0;

/**
 * Pen shapes by size, as bitmap rows.
 *
 * One 16-bit word per row, most significant bit leftmost. Sizes 0 to 7, with
 * `CIRCLE_ROW_START` giving where each size's rows begin — size 0 is a single
 * pixel and size 7 is fifteen rows tall.
 */
const CIRCLE_ROW_START = [0, 1, 4, 9, 16, 25, 37, 50] as const;

const CIRCLE_ROWS = [
  0x8000,
  //
  0x0000, 0xe000, 0x0000,
  //
  0x7000, 0xf800, 0xf800, 0xf800, 0x7000,
  //
  0x3800, 0x7c00, 0xfe00, 0xfe00, 0xfe00, 0x7c00, 0x3800,
  //
  0x1c00, 0x7f00, 0xff80, 0xff80, 0xff80, 0xff80, 0xff80, 0x7f00, 0x1c00,
  //
  0x0e00, 0x3f80, 0x7fc0, 0x7fc0, 0xffe0, 0xffe0, 0xffe0, 0x7fc0, 0x7fc0, 0x3f80, 0x1f00, 0x0e00,
  //
  0x0f80, 0x3fe0, 0x7ff0, 0x7ff0, 0xfff8, 0xfff8, 0xfff8, 0xfff8, 0xfff8, 0x7ff0, 0x7ff0, 0x3fe0,
  0x0f80,
  //
  0x07c0, 0x1ff0, 0x3ff8, 0x7ffc, 0x7ffc, 0xfffe, 0xfffe, 0xfffe, 0xfffe, 0xfffe, 0x7ffc, 0x7ffc,
  0x3ff8, 0x1ff0, 0x07c0,
] as const;

/** What went wrong or was approximated, for the log. */
export interface PictureNote {
  offset: number;
  message: string;
}

export interface PictureResult {
  /** Commands executed, for a listing and for the editor. */
  commands: PictureCommand[];
  notes: PictureNote[];
  /** Set when the stream ran out without a 0xFF terminator. */
  unterminated: boolean;
}

/** One decoded draw command, which is also the editable form (#135). */
export interface PictureCommand {
  offset: number;
  opcode: number;
  name: string;
  /** The raw argument bytes, so an untouched Picture re-emits exactly. */
  args: number[];
}

/**
 * The two buffers a Picture draws into, and the machine that fills them.
 *
 * Both come out of one pass over the command stream, because the enable/disable
 * pairs interleave: a stream can turn the visual screen off, draw priority-only
 * boundaries, and turn it back on. Two passes would have to replay the enable
 * state and would drift from it.
 */
export class AgiPicture {
  readonly visual = new Uint8Array(PICTURE_WIDTH * PICTURE_HEIGHT);
  readonly priority = new Uint8Array(PICTURE_WIDTH * PICTURE_HEIGHT);

  private visualColour = 0;
  private priorityColour = 0;
  private visualOn = false;
  private priorityOn = false;
  /** Pen size in the low three bits, rectangle at 0x10, splatter at 0x20. */
  private patternCode = 0;
  private patternNumber = 0;

  constructor() {
    this.clear();
  }

  /**
   * Resets both buffers to their sentinels.
   *
   * White on the visual screen and 4 on the priority screen, which are the
   * values a fill spreads over — so "empty" and "fillable" are the same state,
   * deliberately.
   */
  clear(): void {
    this.visual.fill(VISUAL_EMPTY);
    this.priority.fill(PRIORITY_EMPTY);
    this.visualOn = false;
    this.priorityOn = false;
    this.visualColour = 0;
    this.priorityColour = 0;
    this.patternCode = 0;
    this.patternNumber = 0;
  }

  /**
   * Executes a command stream into both buffers.
   *
   * The stream is a sequence of commands, each followed by as many argument
   * bytes as it wants — and "as many as it wants" is measured by reading until
   * a byte at or above 0xF0 appears. So a command is a *mode* rather than a
   * fixed-length instruction, and `0xF6 10 10 100 10 100 80` is one line
   * command with three points rather than three of anything.
   */
  execute(data: Uint8Array, options: { additive?: boolean } = {}): PictureResult {
    if (!options.additive) this.clear();

    const commands: PictureCommand[] = [];
    const notes: PictureNote[] = [];
    let at = 0;
    let unterminated = true;

    /** The next argument byte, or null when a command byte is next instead. */
    const arg = (): number | null => {
      if (at >= data.length) return null;
      const byte = data[at];
      if (byte >= MIN_COMMAND) return null;
      at++;
      return byte;
    };

    /** A coordinate pair, or null when either half is missing. */
    const coords = (): { x: number; y: number } | null => {
      const x = arg();
      if (x === null) return null;
      const y = arg();
      if (y === null) return null;
      return { x, y };
    };

    while (at < data.length) {
      const offset = at;
      const opcode = data[at++];

      if (opcode === 0xff) {
        unterminated = false;
        commands.push({ offset, opcode, name: 'end', args: [] });
        break;
      }

      if (opcode < MIN_COMMAND) {
        // Argument data where a command was expected. The stream and this
        // reader have diverged and every byte after is meaningless, so it
        // stops rather than resyncing — the same rule the disassembler follows,
        // for the same reason.
        notes.push({
          offset,
          message:
            `Expected a draw command at ${offset} and found argument byte ` +
            `0x${opcode.toString(16).padStart(2, '0')}. The rest of this picture ` +
            `cannot be read.`,
        });
        break;
      }

      const args: number[] = [];
      switch (opcode) {
        case 0xf0: {
          const colour = arg();
          if (colour === null) break;
          args.push(colour);
          this.visualColour = colour & 0x0f;
          this.visualOn = true;
          break;
        }
        case 0xf1:
          this.visualOn = false;
          break;
        case 0xf2: {
          const colour = arg();
          if (colour === null) break;
          args.push(colour);
          this.priorityColour = colour & 0x0f;
          this.priorityOn = true;
          break;
        }
        case 0xf3:
          this.priorityOn = false;
          break;
        case 0xf4:
        case 0xf5: {
          // A corner run never draws a diagonal: it alternates vertical and
          // horizontal segments. 0xF4 moves vertically first and 0xF5
          // horizontally, which is the whole difference between them.
          const start = coords();
          if (!start) break;
          args.push(start.x, start.y);
          let { x, y } = start;
          this.plot(x, y);
          let vertical = opcode === 0xf4;
          for (;;) {
            const next = arg();
            if (next === null) break;
            args.push(next);
            if (vertical) {
              this.line(x, y, x, next);
              y = next;
            } else {
              this.line(x, y, next, y);
              x = next;
            }
            vertical = !vertical;
          }
          break;
        }
        case 0xf6: {
          const start = coords();
          if (!start) break;
          args.push(start.x, start.y);
          let { x, y } = start;
          this.plot(x, y);
          for (;;) {
            const next = coords();
            if (!next) break;
            args.push(next.x, next.y);
            this.line(x, y, next.x, next.y);
            x = next.x;
            y = next.y;
          }
          break;
        }
        case 0xf7: {
          const start = coords();
          if (!start) break;
          args.push(start.x, start.y);
          let { x, y } = start;
          this.plot(x, y);
          for (;;) {
            const packed = arg();
            if (packed === null) break;
            args.push(packed);
            // Each nibble is sign-and-magnitude: bit 3 is the sign and the low
            // three bits the size, so the range is -7 to +7. Read as two's
            // complement instead, a displacement of -1 becomes +15 and the line
            // shoots off across the picture.
            let dx = (packed >> 4) & 0x0f;
            let dy = packed & 0x0f;
            if (dx & 0x08) dx = -(dx & 0x07);
            if (dy & 0x08) dy = -(dy & 0x07);
            this.line(x, y, x + dx, y + dy);
            x += dx;
            y += dy;
          }
          break;
        }
        case 0xf8: {
          for (;;) {
            const point = coords();
            if (!point) break;
            args.push(point.x, point.y);
            this.fill(point.x, point.y);
          }
          break;
        }
        case 0xf9: {
          const code = arg();
          if (code === null) break;
          args.push(code);
          this.patternCode = code;
          break;
        }
        case 0xfa: {
          for (;;) {
            // A splatter pen takes a texture number before each point; a solid
            // one does not. Reading the wrong number of arguments here shifts
            // every subsequent plot.
            if ((this.patternCode & 0x20) !== 0) {
              const texture = arg();
              if (texture === null) break;
              args.push(texture);
              this.patternNumber = texture;
            }
            const point = coords();
            if (!point) break;
            args.push(point.x, point.y);
            this.plotPattern(point.x, point.y);
          }
          break;
        }
        default:
          // 0xFB to 0xFE are unused in every AGI game anyone has catalogued.
          // Recorded rather than assumed harmless, because a stream that
          // contains one is a stream this reader does not understand.
          notes.push({
            offset,
            message:
              `Draw command 0x${opcode.toString(16)} at ${offset} is not one AGI ` +
              `defines. Its arguments were skipped, so anything after it may be ` +
              `misread.`,
          });
          for (;;) {
            const skipped = arg();
            if (skipped === null) break;
            args.push(skipped);
          }
          break;
      }

      commands.push({ offset, opcode, name: commandName(opcode), args });
    }

    if (unterminated) {
      notes.push({
        offset: data.length,
        message: 'This picture ran out of data without a 0xFF end command.',
      });
    }

    return { commands, notes, unterminated };
  }

  /** Writes one pixel to whichever buffers are enabled. */
  private plot(x: number, y: number): void {
    if (x < 0 || y < 0 || x >= PICTURE_WIDTH || y >= PICTURE_HEIGHT) return;
    const at = y * PICTURE_WIDTH + x;
    if (this.visualOn) this.visual[at] = this.visualColour;
    if (this.priorityOn) this.priority[at] = this.priorityColour;
  }

  /**
   * Draws a line, with AGI's own rounding.
   *
   * Transcribed from ScummVM: the dominant axis drives the loop and the other
   * axis's error accumulator starts at *half* the dominant delta. That
   * half-delta bias is the whole of AGI's rounding, and a line drawn without it
   * is off by a pixel in the middle — which is not visible on a straight edge
   * and is very visible where two lines were meant to meet.
   */
  private line(fromX: number, fromY: number, toX: number, toY: number): void {
    let x1 = clamp(fromX, 0, PICTURE_WIDTH - 1);
    let y1 = clamp(fromY, 0, PICTURE_HEIGHT - 1);
    const x2 = clamp(toX, 0, PICTURE_WIDTH - 1);
    const y2 = clamp(toY, 0, PICTURE_HEIGHT - 1);

    if (x1 === x2) {
      const [top, bottom] = y1 <= y2 ? [y1, y2] : [y2, y1];
      for (let y = top; y <= bottom; y++) this.plot(x1, y);
      return;
    }
    if (y1 === y2) {
      const [left, right] = x1 <= x2 ? [x1, x2] : [x2, x1];
      for (let x = left; x <= right; x++) this.plot(x, y1);
      return;
    }

    let deltaX = x2 - x1;
    let deltaY = y2 - y1;
    const stepX = deltaX < 0 ? -1 : 1;
    const stepY = deltaY < 0 ? -1 : 1;
    deltaX = Math.abs(deltaX);
    deltaY = Math.abs(deltaY);

    let detDelta: number;
    let errorX: number;
    let errorY: number;
    if (deltaY > deltaX) {
      detDelta = deltaY;
      errorX = Math.floor(deltaY / 2);
      errorY = 0;
    } else {
      detDelta = deltaX;
      errorX = 0;
      errorY = Math.floor(deltaX / 2);
    }

    this.plot(x1, y1);
    for (let i = detDelta; i > 0; i--) {
      errorY += deltaY;
      if (errorY >= detDelta) {
        errorY -= detDelta;
        y1 += stepY;
      }
      errorX += deltaX;
      if (errorX >= detDelta) {
        errorX -= detDelta;
        x1 += stepX;
      }
      this.plot(x1, y1);
    }
  }

  /**
   * Whether a fill may spread to this pixel.
   *
   * Three rules in order, transcribed from ScummVM's `draw_FillCheck`, and the
   * order matters because the modes overlap:
   *
   * - visual only: spread where the visual pixel is still white
   * - priority only: spread where the priority pixel is still 4
   * - both: the visual pixel must be white *and* the fill colour must not be
   *   white, because a white fill over white has no boundary to stop at and
   *   would flood the whole picture
   */
  private fillable(x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= PICTURE_WIDTH || y >= PICTURE_HEIGHT) return false;
    const at = y * PICTURE_WIDTH + x;

    if (!this.priorityOn && this.visualOn && this.visualColour !== VISUAL_EMPTY) {
      return this.visual[at] === VISUAL_EMPTY;
    }
    if (this.priorityOn && !this.visualOn && this.priorityColour !== PRIORITY_EMPTY) {
      return this.priority[at] === PRIORITY_EMPTY;
    }
    return this.visualOn && this.visual[at] === VISUAL_EMPTY && this.visualColour !== VISUAL_EMPTY;
  }

  /**
   * Flood fill, bounded by construction.
   *
   * A span fill over an explicit stack rather than recursion: a 160x168 buffer
   * is 26,880 pixels and a recursive fill over it overflows the JavaScript
   * stack on a large region, which is a crash rather than a leak. The stack is
   * capped at the pixel count for the same reason — a malformed command stream
   * cannot make it grow without bound (#127).
   */
  private fill(seedX: number, seedY: number): void {
    if (!this.visualOn && !this.priorityOn) return;

    const stack: number[] = [seedX, seedY];
    const limit = PICTURE_WIDTH * PICTURE_HEIGHT * 2;

    while (stack.length > 0) {
      if (stack.length > limit) return;
      const y = stack.pop()!;
      const x = stack.pop()!;
      if (!this.fillable(x, y)) continue;

      // Walk left to the start of this span, then right across it, seeding the
      // rows above and below once per contiguous run rather than once per
      // pixel.
      let left = x;
      while (this.fillable(left - 1, y)) left--;

      let spanUp = true;
      let spanDown = true;
      for (let column = left; column < PICTURE_WIDTH && this.fillable(column, y); column++) {
        this.plot(column, y);

        if (this.fillable(column, y - 1)) {
          if (spanUp) {
            stack.push(column, y - 1);
            spanUp = false;
          }
        } else {
          spanUp = true;
        }

        if (this.fillable(column, y + 1)) {
          if (spanDown) {
            stack.push(column, y + 1);
            spanDown = false;
          }
        } else {
          spanDown = true;
        }
      }
    }
  }

  /**
   * Plots the pen: a circle or a rectangle, solid or splattered.
   *
   * The pen's x origin is centred by doubling, subtracting the size, clamping
   * and halving — which looks like a roundabout way to write `x - size / 2` and
   * is not: the doubling happens in the 320-wide output space, so the clamp
   * bounds it against the *displayed* width before it comes back to 160.
   */
  private plotPattern(x: number, y: number): void {
    const size = this.patternCode & 0x07;
    const rows = CIRCLE_ROW_START[size];
    const height = (size << 1) + 1;
    const width = height << 1;

    const originX = clamp(x * 2 - size, 0, PICTURE_WIDTH * 2 - 2 * size) >> 1;
    const originY = clamp(y - size, 0, PICTURE_HEIGHT - 1 - 2 * size);

    // A rectangle pen bypasses the circle mask, so every column in the
    // bounding box is a candidate.
    const rectangle = (this.patternCode & 0x10) !== 0;
    const splatter = (this.patternCode & 0x20) !== 0;
    // The splatter texture is a shift register rather than a lookup table,
    // seeded from the pattern number forced odd.
    let register = this.patternNumber | 0x01;

    for (let row = 0; row < height; row++) {
      const mask = CIRCLE_ROWS[rows + row] ?? 0;
      let penX = originX;
      for (let counter = 0; counter < width; counter += 4) {
        const inShape = rectangle || (0x8000 >>> (counter >> 1)) & mask;
        if (!inShape) continue;

        if (splatter) {
          const bit = register & 1;
          register >>= 1;
          if (bit !== 0) register ^= 0xb8;
          // Splatter plots only where the register's low two bits are 2, which
          // is what makes a texture rather than a solid blob.
          if ((register & 0x03) !== 0x02) {
            penX++;
            continue;
          }
        }

        this.plot(penX, originY + row);
        penX++;
      }
    }
  }

  /**
   * The visual buffer doubled to the 320-wide display.
   *
   * Pictures are stored at 160 wide because an AGI pixel is two EGA pixels, so
   * this is the picture as it was always meant to look rather than a scale-up.
   */
  toScreenRow(y: number, out: Uint8Array, at: number): void {
    const row = y * PICTURE_WIDTH;
    for (let x = 0; x < PICTURE_WIDTH; x++) {
      const colour = this.visual[row + x];
      out[at + x * 2] = colour;
      out[at + x * 2 + 1] = colour;
    }
  }

  /** The priority at a screen position, which is what blocks walking. */
  priorityAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= PICTURE_WIDTH || y >= PICTURE_HEIGHT) return PRIORITY_EMPTY;
    return this.priority[y * PICTURE_WIDTH + x];
  }

  visualAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= PICTURE_WIDTH || y >= PICTURE_HEIGHT) return VISUAL_EMPTY;
    return this.visual[y * PICTURE_WIDTH + x];
  }
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

/** Names for a listing and for the Picture editor's command list (#135). */
export function commandName(opcode: number): string {
  switch (opcode) {
    case 0xf0:
      return 'set.visual.colour';
    case 0xf1:
      return 'visual.off';
    case 0xf2:
      return 'set.priority.colour';
    case 0xf3:
      return 'priority.off';
    case 0xf4:
      return 'y.corner';
    case 0xf5:
      return 'x.corner';
    case 0xf6:
      return 'absolute.line';
    case 0xf7:
      return 'relative.line';
    case 0xf8:
      return 'fill';
    case 0xf9:
      return 'set.pen';
    case 0xfa:
      return 'plot.pen';
    case 0xff:
      return 'end';
    default:
      return `unknown.0x${opcode.toString(16)}`;
  }
}

/**
 * Re-emits a command list as bytes.
 *
 * The inverse of `execute`'s decoding, and trivially exact because a Picture's
 * stored form *is* its editable form: a command is an opcode and its argument
 * bytes, so an untouched Picture round-trips without anything having to be
 * reconstructed (#135).
 */
export function writePictureCommands(commands: readonly PictureCommand[]): Uint8Array {
  const out: number[] = [];
  for (const command of commands) {
    out.push(command.opcode, ...command.args);
  }
  return new Uint8Array(out);
}
