import { describe, expect, it } from 'vitest';
import {
  Costume,
  costumeDecodeData,
  createCostumeData,
  decodeCel,
  getLimbCel,
  increaseAnims,
  newDirToOldDir,
  oldDirToNewDir,
} from '../src/engine/gfx/Costume.js';
import { buildCostumePayload, chunk } from './fixture.js';

function makeCostume(): Costume {
  return new Costume(1, new Uint8Array(chunk('COST', buildCostumePayload())));
}

describe('costume parsing', () => {
  it('reads the header and palette', () => {
    const costume = makeCostume();
    expect(costume.numAnim).toBe(1);
    expect(costume.format).toBe(0x58);
    expect(costume.numColors).toBe(16);
    expect(costume.noMirror).toBe(false);
    expect(costume.palette.length).toBe(16);
  });

  it('uses 4 bit colours for a 16 colour costume', () => {
    const costume = makeCostume();
    expect(costume.colorShift).toBe(4);
    expect(costume.colorMask).toBe(15);
  });
});

describe('facing quantisation', () => {
  it('maps degrees onto the four costume directions', () => {
    expect(newDirToOldDir(90)).toBe(1); // east
    expect(newDirToOldDir(180)).toBe(2); // south
    expect(newDirToOldDir(270)).toBe(0); // west
    expect(newDirToOldDir(0)).toBe(3); // north
  });

  it('round-trips back to degrees', () => {
    expect(oldDirToNewDir(0)).toBe(270);
    expect(oldDirToNewDir(1)).toBe(90);
    expect(oldDirToNewDir(2)).toBe(180);
    expect(oldDirToNewDir(3)).toBe(0);
  });
});

describe('costume animation', () => {
  it('starts a limb when a frame is decoded', () => {
    const costume = makeCostume();
    const cost = createCostumeData();

    expect(cost.curpos[0]).toBe(0xffff);
    costumeDecodeData(costume, cost, 90, 0, 0xffff);
    expect(cost.curpos[0]).not.toBe(0xffff);
  });

  it('leaves limbs untouched when the use-mask excludes them', () => {
    const costume = makeCostume();
    const cost = createCostumeData();
    costumeDecodeData(costume, cost, 90, 0, 0x0000);
    expect(cost.curpos[0]).toBe(0xffff);
  });

  it('ignores a frame beyond the costume animation count', () => {
    const costume = makeCostume();
    const cost = createCostumeData();
    costumeDecodeData(costume, cost, 90, 99, 0xffff);
    expect(cost.curpos[0]).toBe(0xffff);
  });

  it('advances animations without throwing', () => {
    const costume = makeCostume();
    const cost = createCostumeData();
    costumeDecodeData(costume, cost, 90, 0, 0xffff);
    expect(() => increaseAnims(costume, cost)).not.toThrow();
  });
});

describe('cel decoding', () => {
  it('reads the cel header', () => {
    const costume = makeCostume();
    const cost = createCostumeData();
    costumeDecodeData(costume, cost, 90, 0, 0xffff);

    const cel = getLimbCel(costume, cost, 0);
    expect(cel).not.toBeNull();
    expect(cel!.width).toBe(8);
    expect(cel!.height).toBe(8);
    expect(cel!.relY).toBe(-8);
  });

  it('returns null for a limb with no animation', () => {
    const costume = makeCostume();
    const cost = createCostumeData();
    expect(getLimbCel(costume, cost, 3)).toBeNull();
  });

  it('expands the run-length encoding in column-major order', () => {
    const costume = makeCostume();
    const cost = createCostumeData();
    costumeDecodeData(costume, cost, 90, 0, 0xffff);

    const cel = getLimbCel(costume, cost, 0)!;
    const pixels = decodeCel(costume, cel);

    expect(pixels.length).toBe(64);
    // The fixture encodes a run of 8 colour-1 pixels then 56 colour-2 pixels,
    // which fills the first column then the rest of the cel.
    expect([...pixels.slice(0, 8)]).toEqual(new Array(8).fill(1));
    expect([...pixels.slice(8, 16)]).toEqual(new Array(8).fill(2));
  });

  it('stops at the end of the cel rather than reading past it', () => {
    const costume = makeCostume();
    const cost = createCostumeData();
    costumeDecodeData(costume, cost, 90, 0, 0xffff);
    const cel = getLimbCel(costume, cost, 0)!;
    expect(decodeCel(costume, cel).length).toBe(cel.width * cel.height);
  });
});

describe('re-decoding a limb when an actor turns', () => {
  /**
   * Turning an actor does not restart its animation: the engine walks the
   * limbs and calls `costumeDecodeData` again with the frame each limb is
   * already playing, taken from `cost.frame[]`. That only works if what was
   * stored there is a frame.
   *
   * Storing the animation index instead — direction and frame combined — meant
   * the second decode computed `direction + (direction + frame * 4) * 4`,
   * which soon exceeds `numAnim`. The decode then returns without touching the
   * limb, so an actor that turns is drawn missing whichever body parts had
   * been animating.
   */
  function bigCostume(): Costume {
    return new Costume(1, new Uint8Array(chunk('COST', buildCostumePayload({ numAnim: 15 }))));
  }

  it('records the frame a limb is playing, not the animation index', () => {
    const costume = bigCostume();
    const cost = createCostumeData();

    // Facing east is old direction 1, so frame 2 is animation 9: a value that
    // is indistinguishable from the frame only when both are 0.
    costumeDecodeData(costume, cost, 90, 2, 0xffff);

    expect(newDirToOldDir(90) + 2 * 4).toBe(9);
    expect(cost.frame[0]).toBe(2);
  });

  it('decodes the limb again in the new direction', () => {
    const costume = bigCostume();
    const cost = createCostumeData();

    costumeDecodeData(costume, cost, 90, 2, 0xffff);
    const before = cost.curpos[0];

    // What the engine does on a turn, for the one limb that is animating.
    const frame = cost.frame[0];
    cost.curpos[0] = 0xfffe; // a value neither decode would leave behind
    costumeDecodeData(costume, cost, 180, frame, 0x8000);

    expect(cost.curpos[0]).toBe(before);
    expect(cost.frame[0]).toBe(2);
  });

  it('survives a turn for every direction', () => {
    const costume = bigCostume();
    const cost = createCostumeData();
    costumeDecodeData(costume, cost, 90, 2, 0xffff);

    for (const facing of [0, 90, 180, 270]) {
      cost.curpos[0] = 0xfffe;
      costumeDecodeData(costume, cost, facing, cost.frame[0], 0x8000);
      expect(cost.curpos[0], `facing ${facing}`).not.toBe(0xfffe);
    }
  });
});

/**
 * Where a costume's offsets are counted from, which changed at v6.
 *
 * v5 counts from byte 2 of the `COST` chunk and v6 from byte 8, past the chunk
 * header. Six bytes — and the reason this went unnoticed is that the wrong base
 * does not look like a failure. It yields a plausible animation count, a format
 * byte that is merely unusual, and artwork that decodes to *something*: Sam &
 * Max's actors were drawn on screen while its costumes were being read six
 * bytes into the wrong place.
 *
 * What it actually broke was the importer, which trusts the cel dimensions it
 * reads: two costumes produced cels of 51579x5706 and it sat there for twenty
 * seconds each, allocating buffers, so clicking "Edit game…" appeared to do
 * nothing at all.
 */
describe('the version a costume was written for', () => {
  const costumeChunk = (version: number, numAnim = 1) =>
    new Uint8Array(chunk('COST', buildCostumePayload({ numAnim, version })));

  it('reads a v6 costume from byte 8, where its own header ends', () => {
    const costume = new Costume(1, costumeChunk(6), 6);

    expect(costume.base).toBe(8);
    expect(costume.format).toBe(0x58);
    expect(costume.numAnim).toBe(1);
    expect(costume.numColors).toBe(16);
  });

  it('reads a v5 costume from byte 2, as it always did', () => {
    const costume = new Costume(1, costumeChunk(5), 5);

    expect(costume.base).toBe(2);
    expect(costume.format).toBe(0x58);
  });

  /**
   * Refused rather than guessed at. A wrong format byte means the base is
   * wrong, so the palette, the offset tables and every cel after it are
   * somebody else's bytes — and assuming 16 colours and carrying on is exactly
   * what let a whole version's costumes be misread in silence.
   */
  it('refuses a costume read at the wrong base rather than reading noise', () => {
    expect(() => new Costume(1, costumeChunk(6), 5)).toThrow(/format byte/);
    expect(() => new Costume(1, costumeChunk(5), 6)).toThrow(/format byte/);
  });

  it('names the version it was read as, since that is the thing to change', () => {
    expect(() => new Costume(7, costumeChunk(6), 5)).toThrow(/v5/);
  });

  /** v6 added two format bytes whose only difference is that they exist. */
  it("accepts v6's own format bytes", () => {
    for (const [format, colors] of [
      [0x60, 16],
      [0x61, 32],
    ] as const) {
      const bytes = costumeChunk(6);
      // The format byte sits one past `numAnim`, which for v6 is chunk byte 14.
      bytes[15] = format;
      expect(new Costume(1, bytes, 6).numColors).toBe(colors);
    }
  });
});
