import { describe, expect, it } from 'vitest';
import { AgiPicture, writePictureCommands } from '../src/engine/agi/gfx/AgiPicture.js';
import {
  AGI_EGA_PALETTE,
  PICTURE_HEIGHT,
  PICTURE_WIDTH,
  PRIORITY_EMPTY,
  VISUAL_EMPTY,
  defaultPriorityForRow,
  priorityTable,
} from '../src/engine/agi/gfx/agiPalette.js';
import { Palette } from '../src/engine/gfx/Palette.js';
import { applyAgiPalette } from '../src/engine/agi/gfx/agiPalette.js';
import { buildPicture, samplePicture } from './fixtureAgi.js';

function run(commands: number[]): AgiPicture {
  const picture = new AgiPicture();
  picture.execute(new Uint8Array(buildPicture(commands)));
  return picture;
}

describe('the sixteen EGA colours', () => {
  /**
   * These are the values AGI's interpreter programmed the DAC with, and they
   * are 8-bit rather than the 6-bit values a SCUMM palette chunk holds — so
   * `normaliseDepth` must not be applied to them.
   */
  it('matches the standard AGI palette exactly', () => {
    expect(AGI_EGA_PALETTE).toHaveLength(16);
    expect(AGI_EGA_PALETTE[0]).toEqual([0x00, 0x00, 0x00]);
    expect(AGI_EGA_PALETTE[1]).toEqual([0x00, 0x00, 0xaa]);
    expect(AGI_EGA_PALETTE[6]).toEqual([0xaa, 0x55, 0x00]);
    expect(AGI_EGA_PALETTE[7]).toEqual([0xaa, 0xaa, 0xaa]);
    expect(AGI_EGA_PALETTE[8]).toEqual([0x55, 0x55, 0x55]);
    expect(AGI_EGA_PALETTE[15]).toEqual([0xff, 0xff, 0xff]);
  });

  /** ADR 0011: `Palette` narrows to sixteen entries without changing. */
  it('loads into the shared palette, which already handled sixteen entries', () => {
    const palette = new Palette();
    applyAgiPalette(palette);

    expect(palette.getColor(1)).toEqual([0x00, 0x00, 0xaa]);
    expect(palette.getColor(14)).toEqual([0xff, 0xff, 0x55]);
    // Everything above sixteen stays black, which is what an AGI game shows if
    // a bad index ever reaches the screen.
    expect(palette.getColor(200)).toEqual([0, 0, 0]);
  });
});

describe('priority bands map to pixel rows', () => {
  /**
   * A band off by one row produces a picture that is plausible and wrong, so
   * the arithmetic is asserted rather than eyeballed: 168 rows in fourteen
   * strips of twelve, numbered from one, clamped up to four.
   */
  it('clamps the top four strips to band 4', () => {
    expect(defaultPriorityForRow(0)).toBe(4);
    expect(defaultPriorityForRow(11)).toBe(4);
    expect(defaultPriorityForRow(12)).toBe(4);
    expect(defaultPriorityForRow(35)).toBe(4);
    expect(defaultPriorityForRow(47)).toBe(4);
  });

  it('starts counting bands at row 48, which is the fifth strip', () => {
    expect(defaultPriorityForRow(48)).toBe(5);
    expect(defaultPriorityForRow(59)).toBe(5);
    expect(defaultPriorityForRow(60)).toBe(6);
  });

  it('reaches band 14 on the last strip and never 15', () => {
    expect(defaultPriorityForRow(156)).toBe(14);
    expect(defaultPriorityForRow(PICTURE_HEIGHT - 1)).toBe(14);
    // 15 is not a band: it is the value an object takes to draw in front of
    // everything.
    for (let y = 0; y < PICTURE_HEIGHT; y++) {
      expect(defaultPriorityForRow(y)).toBeLessThanOrEqual(14);
      expect(defaultPriorityForRow(y)).toBeGreaterThanOrEqual(4);
    }
  });

  it('builds a table one entry per picture row', () => {
    expect(priorityTable()).toHaveLength(PICTURE_HEIGHT);
    expect([...priorityTable()].every((value) => value >= 4 && value <= 14)).toBe(true);
  });

  /**
   * `set.pri.base` moves the horizon. A game that sets it and is rendered with
   * the default table has its whole depth ordering wrong from that row on.
   */
  it('honours set.pri.base by moving where band 4 stops', () => {
    const table = priorityTable(100);
    expect(table[0]).toBe(4);
    expect(table[99]).toBe(4);
    expect(table[100]).toBe(5);
    expect(table[PICTURE_HEIGHT - 1]).toBeGreaterThan(5);
  });
});

describe('a picture starts empty in both buffers', () => {
  it('is white on the visual screen and 4 on the priority screen', () => {
    const picture = new AgiPicture();
    expect(picture.visualAt(0, 0)).toBe(VISUAL_EMPTY);
    expect(picture.priorityAt(0, 0)).toBe(PRIORITY_EMPTY);
    expect(picture.visual.every((pixel) => pixel === VISUAL_EMPTY)).toBe(true);
    expect(picture.priority.every((pixel) => pixel === PRIORITY_EMPTY)).toBe(true);
  });
});

describe('the draw commands', () => {
  it('changes the pen colour and draws only while enabled', () => {
    // Colour 2 on, a line, off, then a line that should draw nothing.
    const picture = run([0xf0, 2, 0xf6, 0, 0, 10, 0, 0xf1, 0xf6, 0, 5, 10, 5]);

    expect(picture.visualAt(5, 0)).toBe(2);
    expect(picture.visualAt(5, 5)).toBe(VISUAL_EMPTY);
  });

  it('produces both buffers from one pass', () => {
    const picture = run([
      0xf0,
      3, // visual colour 3
      0xf2,
      7, // priority colour 7
      0xf6,
      0,
      0,
      20,
      0, // one line, both buffers enabled
    ]);

    expect(picture.visualAt(10, 0)).toBe(3);
    expect(picture.priorityAt(10, 0)).toBe(7);
  });

  /**
   * The interleaving is why it has to be one pass: a stream can turn the visual
   * screen off, lay down priority-only boundaries, and turn it back on. Two
   * passes would have to replay the enable state and would drift from it.
   */
  it('draws priority-only boundaries with the visual screen off', () => {
    const picture = run([
      0xf2,
      6,
      0xf3,
      0xf2,
      6, // priority on
      0xf6,
      0,
      20,
      20,
      20,
    ]);

    expect(picture.priorityAt(10, 20)).toBe(6);
    expect(picture.visualAt(10, 20)).toBe(VISUAL_EMPTY);
  });

  it('draws an absolute line through every point it is given', () => {
    const picture = run([0xf0, 1, 0xf6, 0, 0, 30, 0, 30, 20, 0, 20, 0, 0]);

    expect(picture.visualAt(0, 0)).toBe(1);
    expect(picture.visualAt(30, 0)).toBe(1);
    expect(picture.visualAt(30, 20)).toBe(1);
    expect(picture.visualAt(0, 20)).toBe(1);
    expect(picture.visualAt(15, 10)).toBe(VISUAL_EMPTY);
  });

  it('draws a vertical and a horizontal line as exact spans', () => {
    const vertical = run([0xf0, 5, 0xf6, 10, 0, 10, 30]);
    for (let y = 0; y <= 30; y++) expect(vertical.visualAt(10, y)).toBe(5);
    expect(vertical.visualAt(10, 31)).toBe(VISUAL_EMPTY);

    const horizontal = run([0xf0, 5, 0xf6, 0, 40, 25, 40]);
    for (let x = 0; x <= 25; x++) expect(horizontal.visualAt(x, 40)).toBe(5);
  });

  /**
   * A displacement nibble is sign-and-magnitude, not two's complement. Read the
   * wrong way, -1 becomes +15 and the line shoots across the picture instead of
   * stepping back one pixel.
   */
  it('reads a relative line displacement as sign and magnitude', () => {
    // 0x91 is dx = -1, dy = +1.
    const picture = run([0xf0, 9, 0xf7, 20, 20, 0x91]);

    expect(picture.visualAt(20, 20)).toBe(9);
    expect(picture.visualAt(19, 21)).toBe(9);
    // Nothing 15 pixels to the right, which is where a two's complement
    // reading would have put it.
    expect(picture.visualAt(35, 21)).toBe(VISUAL_EMPTY);
  });

  it('keeps a relative displacement inside minus seven to plus seven', () => {
    // 0x77 is the largest positive step in both axes.
    const picture = run([0xf0, 9, 0xf7, 0, 0, 0x77]);
    expect(picture.visualAt(7, 7)).toBe(9);
  });

  it('draws a Y corner vertically first and an X corner horizontally first', () => {
    const yCorner = run([0xf0, 4, 0xf4, 10, 10, 30]);
    // The first argument after the start point is a y for a Y corner, so the
    // run goes down column 10.
    expect(yCorner.visualAt(10, 20)).toBe(4);

    const xCorner = run([0xf0, 4, 0xf5, 10, 10, 30]);
    // For an X corner it is an x, so the run goes along row 10.
    expect(xCorner.visualAt(20, 10)).toBe(4);
  });

  it('never draws a diagonal in a corner run', () => {
    const picture = run([0xf0, 4, 0xf4, 10, 10, 20, 30]);
    // Down column 10 then along row 20 — so (15, 15) is untouched.
    expect(picture.visualAt(10, 15)).toBe(4);
    expect(picture.visualAt(20, 20)).toBe(4);
    expect(picture.visualAt(15, 15)).toBe(VISUAL_EMPTY);
  });
});

describe('flood fill', () => {
  it('fills inside a closed boundary and stops at it', () => {
    const picture = run([
      0xf0,
      1,
      0xf6,
      10,
      10,
      40,
      10,
      40,
      40,
      10,
      40,
      10,
      10, // a box in colour 1
      0xf0,
      2,
      0xf8,
      25,
      25, // fill it in colour 2
    ]);

    expect(picture.visualAt(25, 25)).toBe(2);
    expect(picture.visualAt(11, 11)).toBe(2);
    // The boundary keeps its own colour, and outside stays empty.
    expect(picture.visualAt(10, 10)).toBe(1);
    expect(picture.visualAt(5, 5)).toBe(VISUAL_EMPTY);
    expect(picture.visualAt(100, 100)).toBe(VISUAL_EMPTY);
  });

  /**
   * A white fill over white has no boundary to stop at, so it would flood the
   * whole picture. AGI treats it as a no-op instead, which is why "empty" and
   * "fillable" are deliberately the same value.
   */
  it('does nothing when asked to fill white over white', () => {
    const picture = run([0xf0, VISUAL_EMPTY, 0xf8, 40, 40]);
    expect(picture.visual.every((pixel) => pixel === VISUAL_EMPTY)).toBe(true);
  });

  it('does nothing when neither buffer is enabled', () => {
    const picture = run([0xf1, 0xf3, 0xf8, 40, 40]);
    expect(picture.visual.every((pixel) => pixel === VISUAL_EMPTY)).toBe(true);
    expect(picture.priority.every((pixel) => pixel === PRIORITY_EMPTY)).toBe(true);
  });

  /**
   * The checkable half of "a fill that leaks is what no unit test catches": a
   * leak *within* the picture is judged by eye, but a fill escaping the buffer
   * or running away on a malformed stream is a fault a test can hold (#127).
   */
  it('cannot escape the buffer, even filling from a corner with no boundary', () => {
    const picture = run([0xf0, 6, 0xf8, 0, 0]);

    // Every pixel filled and nothing beyond — which is the whole buffer, since
    // an unbounded fill from a corner legitimately covers it.
    expect(picture.visual).toHaveLength(PICTURE_WIDTH * PICTURE_HEIGHT);
    expect(picture.visual.every((pixel) => pixel === 6)).toBe(true);
  });

  it('terminates on a fill seeded outside the picture', () => {
    const picture = run([0xf0, 6, 0xf8, 200, 200]);
    expect(picture.visual.every((pixel) => pixel === VISUAL_EMPTY)).toBe(true);
  });

  it('fills the priority buffer over its own sentinel when only priority is on', () => {
    const picture = run([
      // A priority-only boundary, then a priority-only fill inside it.
      0xf2, 8, 0xf6, 10, 100, 40, 100, 40, 130, 10, 130, 10, 100, 0xf2, 9, 0xf8, 25, 115,
    ]);

    expect(picture.priorityAt(25, 115)).toBe(9);
    expect(picture.priorityAt(10, 100)).toBe(8);
  });
});

describe('the pen', () => {
  it('plots a single pixel at pen size zero', () => {
    const picture = run([0xf0, 3, 0xf9, 0, 0xfa, 50, 50]);
    expect(picture.visualAt(50, 50)).toBe(3);
  });

  it('plots a wider shape at a larger pen size', () => {
    const small = run([0xf0, 3, 0xf9, 0, 0xfa, 50, 50]);
    const large = run([0xf0, 3, 0xf9, 4, 0xfa, 50, 50]);

    const count = (picture: AgiPicture): number =>
      [...picture.visual].filter((pixel) => pixel === 3).length;
    expect(count(large)).toBeGreaterThan(count(small));
  });

  it('reads a texture number before each point for a splatter pen only', () => {
    // Splatter is bit 0x20. With it set, each plot takes three arguments.
    const splatter = run([0xf0, 3, 0xf9, 0x25, 0xfa, 10, 60, 60]);
    // The important property is that the stream stayed in step: a solid reading
    // of a splatter stream would treat the texture as an x coordinate and put
    // the pen somewhere else entirely.
    expect(splatter.visual.some((pixel) => pixel === 3)).toBe(true);
  });

  it('draws a rectangle pen wider than a circle pen of the same size', () => {
    const circle = run([0xf0, 3, 0xf9, 0x05, 0xfa, 80, 80]);
    const rectangle = run([0xf0, 3, 0xf9, 0x15, 0xfa, 80, 80]);

    const count = (picture: AgiPicture): number =>
      [...picture.visual].filter((pixel) => pixel === 3).length;
    expect(count(rectangle)).toBeGreaterThanOrEqual(count(circle));
  });
});

describe('reading a malformed command stream', () => {
  it('reports a stream that never ends rather than assuming it did', () => {
    const picture = new AgiPicture();
    const result = picture.execute(new Uint8Array([0xf0, 2, 0xf6, 0, 0, 10, 10]));

    expect(result.unterminated).toBe(true);
    expect(result.notes.map((note) => note.message).join(' ')).toMatch(/without a 0xFF/);
  });

  it('stops when argument data appears where a command was expected', () => {
    const picture = new AgiPicture();
    const result = picture.execute(new Uint8Array([0x05, 0xff]));

    expect(result.notes[0].message).toMatch(/Expected a draw command/);
  });

  it('records an undefined command rather than assuming it is harmless', () => {
    const picture = new AgiPicture();
    const result = picture.execute(new Uint8Array([0xfc, 1, 2, 0xff]));

    expect(result.notes.map((note) => note.message).join(' ')).toMatch(/not one AGI defines/);
    expect(result.unterminated).toBe(false);
  });
});

describe('a picture is doubled to the display width', () => {
  /**
   * Pictures are stored 160 wide because an AGI pixel is two EGA pixels, so
   * this is the picture as it was always meant to look rather than a scale-up.
   */
  it('writes each stored pixel twice', () => {
    const picture = run([0xf0, 12, 0xf6, 0, 0, 2, 0]);
    const row = new Uint8Array(320);
    picture.toScreenRow(0, row, 0);

    expect([...row.subarray(0, 6)]).toEqual([12, 12, 12, 12, 12, 12]);
    expect(row).toHaveLength(PICTURE_WIDTH * 2);
  });
});

describe('a picture round-trips through its command list', () => {
  /**
   * The stored form *is* the editable form, which is the whole reason picture
   * editing is easier here than in SCUMM (#135) — so an untouched Picture
   * re-emits byte for byte without anything being reconstructed.
   */
  it('re-emits the fixture picture byte for byte', () => {
    const original = new Uint8Array(buildPicture(samplePicture()));
    const picture = new AgiPicture();
    const result = picture.execute(original);

    expect(result.notes).toEqual([]);
    expect([...writePictureCommands(result.commands)]).toEqual([...original]);
  });

  it('decodes every command class the fixture uses', () => {
    const picture = new AgiPicture();
    const { commands } = picture.execute(new Uint8Array(buildPicture(samplePicture())));

    const names = new Set(commands.map((command) => command.name));
    for (const name of [
      'set.visual.colour',
      'set.priority.colour',
      'absolute.line',
      'relative.line',
      'fill',
      'visual.off',
      'priority.off',
      'set.pen',
      'plot.pen',
      'end',
    ]) {
      expect(names, `missing ${name}`).toContain(name);
    }
  });
});
