import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  VgaDecodeError,
  formatVgaScript,
  readVgaScript,
} from '../src/engine/agos/gfx/vgaScript.js';
import { VGA_OPCODE_TABLES, vgaHasWideOpcodes } from '../src/engine/agos/gfx/vgaOpcodeTables.js';
import { readVgaFile } from '../src/engine/agos/gfx/vgaFile.js';
import { readVgaPalette } from '../src/engine/agos/gfx/vgaPalette.js';
import { VgaMachine, paintZoneSprites } from '../src/engine/agos/gfx/VgaMachine.js';
import { RecordingVgaHost } from '../src/engine/agos/gfx/vgaHost.js';
import { readZoneSource } from '../src/engine/agos/resource/zoneSource.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { buildGraphicsArchive } from './fixtureAgos.js';
import { hasWideOpcodes } from '../src/engine/agos/agosVersion.js';

describe('AGOS carries two bytecodes, and they disagree about themselves', () => {
  /**
   * The finding that shapes this module. A VGA script and a game Subroutine
   * share no numbering, no operand encoding and not even the rule for how wide
   * an opcode is — and the two width rules are near-opposites, so a reader that
   * borrows the wrong one is wrong for exactly the Versions where the other is
   * right.
   */
  it('reads a 16-bit opcode in the game bytecode only for Elvira 1', () => {
    expect(hasWideOpcodes('Elvira1')).toBe(true);
    expect(hasWideOpcodes('Simon1')).toBe(false);
    expect(hasWideOpcodes('Simon2')).toBe(false);
  });

  it('reads a 16-bit VGA opcode everywhere except Simon 2 and AGOS 2', () => {
    expect(vgaHasWideOpcodes('elvira1')).toBe(true);
    expect(vgaHasWideOpcodes('simon1')).toBe(true);
    expect(vgaHasWideOpcodes('simon2')).toBe(false);
    expect(vgaHasWideOpcodes('feeblefiles')).toBe(false);
  });

  it('gives every Version a VGA table', () => {
    for (const table of [
      'elvira1',
      'elvira2',
      'waxworks',
      'simon1',
      'simon2',
      'feeblefiles',
      'puzzlepack',
    ]) {
      expect(VGA_OPCODE_TABLES[table]?.length).toBeGreaterThan(50);
    }
  });
});

describe('reading a VGA script', () => {
  it('reads Simon 2 as byte opcodes and stops at the one that ends the script', () => {
    // 1 = FADEOUT with three words; 0 = RET, which ends it.
    const script = Uint8Array.of(1, 0, 10, 0, 20, 0, 30, 0);
    const { instructions, endOffset } = readVgaScript(script, 'simon2');

    expect(instructions.map((each) => each.name)).toEqual(['FADEOUT', 'RET']);
    expect(instructions[0]!.operands).toEqual([
      { kind: 'word', value: 10 },
      { kind: 'word', value: 20 },
      { kind: 'word', value: 30 },
    ]);
    expect(endOffset).toBe(script.length);
  });

  it('reads Simon 1 as word opcodes, which is the opposite of its game bytecode', () => {
    const script = Uint8Array.of(0, 1, 0, 10, 0, 20, 0, 30, 0, 0);
    const { instructions } = readVgaScript(script, 'simon1');

    expect(instructions.map((each) => each.name)).toEqual(['FADEOUT', 'RET']);
  });

  it('reads a coordinate list that ends on a terminator rather than a count', () => {
    const table = VGA_OPCODE_TABLES.simon2!;
    const opcode = table.findIndex((entry) => entry?.startsWith('q'));
    // Only run this where Simon 2 actually has such an opcode.
    if (opcode < 0) return;

    const script = Uint8Array.of(opcode, 0, 1, 0, 2, 0, 3, 0, 4, 3, 231, 0);
    const { instructions } = readVgaScript(script, 'simon2');

    expect(instructions[0]!.operands[0]).toEqual({
      kind: 'pairs',
      values: [
        [1, 2],
        [3, 4],
      ],
    });
  });

  it('stops rather than guessing at an opcode the Version does not have', () => {
    expect(() => readVgaScript(Uint8Array.of(250, 0), 'simon2')).toThrow(VgaDecodeError);
  });

  it('formats a script as a listing with names', () => {
    const { instructions } = readVgaScript(Uint8Array.of(1, 0, 1, 0, 2, 0, 3, 0), 'simon2');

    expect(formatVgaScript(instructions)).toBe('FADEOUT 1, 2, 3\nRET');
  });
});

describe('a graphics resource is a table of entries, not a bitmap', () => {
  it('reads the image and animation tables', () => {
    // A Simon-layout header: x, imageCount, x, animationCount, x, imageTable,
    // x, animationTable, x — then one image entry and one animation entry.
    const data = new Uint8Array(64);
    const put = (offset: number, value: number): void => {
      data[offset] = value >> 8;
      data[offset + 1] = value & 0xff;
    };
    put(2, 1); // one image
    put(6, 1); // one animation
    put(10, 20); // image table at 20
    put(14, 40); // animation table at 40
    put(20, 7); // image id
    put(22, 3); // its colour
    put(26, 50); // its script offset
    put(40, 9); // animation id
    put(44, 60); // its script offset

    const file = readVgaFile(data);

    expect(file.images).toEqual([{ id: 7, colour: 3, scriptOffset: 50 }]);
    expect(file.animations).toEqual([{ id: 9, scriptOffset: 60 }]);
  });
});

describe('running a VGA script', () => {
  /**
   * The second bytecode, executing. A sprite here is a running script with a
   * position rather than a bitmap, which is why the machine is a scheduler with
   * a drawing opcode rather than a draw loop.
   */
  function machineFor(script: number[], pixelBytes: number[]) {
    // Wide enough to hold one 8-pixel x step, because that is the unit a
    // draw's x is in: an 8-pixel-wide target can only ever be drawn at x 0.
    const target = { width: 32, height: 4, pixels: new Uint8Array(32 * 4) };
    const machine = new VgaMachine(
      Uint8Array.from(script),
      Uint8Array.from(pixelBytes),
      'simon2',
      target,
    );
    return { machine, target };
  }

  /**
   * An image entry: offset, flags, height, and the width **in pixels**.
   *
   * Two pixels to a byte, so the word written is twice the byte width. It used
   * to be sixteen times it, which is the reference's intermediate value rather
   * than what the format stores — see `gfx/vgaImages.ts`.
   */
  function imageEntry(offset: number, widthBytes: number, height: number, flags = 0): number[] {
    const width = widthBytes * 2;
    return [0, 0, offset >> 8, offset & 0xff, flags, height, width >> 8, width & 0xff];
  }

  const DRAW = VGA_OPCODE_TABLES.simon2!.findIndex((entry) => entry?.endsWith('|DRAW'));
  const RET = 0;

  it('draws an uncompressed image into the target at the position the script gives', () => {
    // Entry 0 is unused (image 0 means nothing), so entry 1 describes our image.
    const pixels = [...imageEntry(0, 0, 0), ...imageEntry(24, 2, 2), 0, 0, 0, 0, 0, 0, 0, 0];
    pixels.push(0x12, 0x34, 0x56, 0x78); // two rows of two bytes: four pixels each
    const { machine, target } = machineFor([DRAW, 0, 1, 0, 0, 0, 1, 0, 1, 0, RET], pixels);

    machine.run(0);

    expect(machine.report.drawn).toBe(1);
    // Drawn at (1,1), and a draw's x is in **eights of pixels** — so one row
    // down and eight columns across (`gfx/VgaMachine.ts`, `paint`).
    expect(target.pixels[target.width + 8]).toBe(1);
    expect(target.pixels[target.width + 9]).toBe(2);
  });

  it('names a draw flag it cannot honour rather than drawing the wrong thing', () => {
    const pixels = [...imageEntry(0, 0, 0), ...imageEntry(24, 1, 1, 0), 0, 0, 0, 0, 0, 0, 0, 0];
    pixels.push(0x12);
    // Four words — image, palette, x, y — then the flags byte. 0x20 is the
    // masked flag, which this machine does not implement.
    const { machine } = machineFor([DRAW, 0, 1, 0, 0, 0, 0, 0, 0, 0x20, RET], pixels);

    machine.run(0);

    // Named more precisely than "masked": the flag is honoured when there is a
    // background to reveal, so the gap is the missing surface.
    expect(machine.report.unimplementedFlags.join(' ')).toContain('masked');
  });

  it('never treats an opcode it cannot run as a silent no-op', () => {
    // **This test has gone stale twice**, and the third rewrite is a change of
    // subject rather than a fresher example. It named `STOP_ALL_SOUNDS`, which
    // was then implemented; it named `WAIT_SYNC` on the grounds that a wait
    // needed a scheduler nobody would build, and then the scheduler was built.
    // Both times the *point* survived and the example died, so the example is
    // now gone: what is asserted is the invariant itself, over every opcode the
    // interpreter does not handle, whichever those happen to be today.
    //
    // The handled set is read out of the machine's own `case` labels, the same
    // technique and for the same reason as `agos-opcode-coverage.test.ts`: a
    // list kept beside the code is a second copy to forget, and forgetting it
    // makes this test claim coverage the machine does not have.
    const source = readFileSync('src/engine/agos/gfx/VgaMachine.ts', 'utf8');
    const handled = new Set(
      [...source.matchAll(/case '([A-Za-z][A-Za-z0-9_]*)':/g)].map((match) => match[1]!),
    );

    // No-operand opcodes only, so one byte is a whole script and no operand
    // shape has to be guessed at to build one.
    const candidates = (VGA_OPCODE_TABLES.simon2 ?? [])
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => entry !== null && entry !== undefined)
      .map(({ entry, index }) => ({
        index,
        letters: entry!.split('|')[0]!,
        name: entry!.split('|')[1]!,
      }))
      .filter(({ letters, name }) => letters === '' && name !== 'RET' && !handled.has(name));

    // An empty list is the good future rather than a failure: it means every
    // no-operand opcode is implemented. The invariant is vacuously true and
    // there is nothing to assert.
    for (const { index, name } of candidates) {
      const { machine } = machineFor([index, RET], []);
      machine.run(0);
      expect(machine.report.unimplemented, `${name} ran silently`).toContain(name);
    }
  });
});

describe('a zone comes from whichever layout its Version uses', () => {
  it('reads Simon’s zones out of the archive by arithmetic', async () => {
    const source = new MemoryDataSource('packed');
    source.set('SIMON.GME', buildGraphicsArchive());
    const zones = await readZoneSource(source, 'Simon1');

    expect(zones.layout).toBe('packed');
    expect(zones.zone(0)).toBeDefined();
    expect(zones.zone(4)).toBeUndefined();
  });

  it('reads Elvira and Waxworks zones from loose numbered files', async () => {
    const source = new MemoryDataSource('old-bundle');
    source.set('031.VGA', Uint8Array.of(1, 2, 3));
    source.set('032.VGA', Uint8Array.of(4, 5, 6));
    const zones = await readZoneSource(source, 'Waxworks');

    expect(zones.layout).toBe('old-bundle');
    expect(zones.zone(3)?.scripts).toEqual(Uint8Array.of(1, 2, 3));
    expect(zones.zone(3)?.pixels).toEqual(Uint8Array.of(4, 5, 6));
  });

  it('drops a zone that is missing one of its two files rather than half-loading it', async () => {
    const source = new MemoryDataSource('half');
    source.set('051.VGA', Uint8Array.of(1));
    const zones = await readZoneSource(source, 'Elvira1');

    expect(zones.zone(5)).toBeUndefined();
  });

  it('says a bare GAMEPC dump has no graphics rather than failing to load it', async () => {
    const zones = await readZoneSource(new MemoryDataSource('bare'), 'Simon1');

    expect(zones.layout).toBe('none');
  });
});

describe('palettes come from the script resource, not from beside the pixels', () => {
  /**
   * Which is why a room can change its colours without any pixels moving: a
   * script picks a *bank* by number, and the colours are sixteen big-endian
   * `0RGB` words at an offset the resource's own header gives.
   */
  it('reads a bank of sixteen colours at the offset the header names', () => {
    const scripts = new Uint8Array(64);
    scripts[6] = 0;
    scripts[7] = 32; // the palette table starts at 32
    // Bank 0, colour 0: 0x0f80 — red 15, green 8, blue 0.
    scripts[32] = 0x0f;
    scripts[33] = 0x80;

    const rgb = readVgaPalette(scripts, 0);

    // 15 * 32 overshoots a byte, so it is clamped rather than wrapped: a
    // wrapped component turns a bright colour dark and reads as a wrong offset.
    expect([rgb[0], rgb[1], rgb[2]]).toEqual([255, 255, 0]);
  });

  it('offsets a bank by 32 bytes, because a bank is sixteen two-byte colours', () => {
    const scripts = new Uint8Array(128);
    scripts[7] = 32;
    scripts[64] = 0x00;
    scripts[65] = 0x01; // bank 1, colour 0: blue 1

    const rgb = readVgaPalette(scripts, 1);

    expect([rgb[0], rgb[1], rgb[2]]).toEqual([0, 0, 32]);
  });
});

describe('masked drawing reveals the scene behind', () => {
  /**
   * AGOS's masked draw uses the image as a **stencil** and takes its colours
   * from the surface behind — so it reveals what is already there rather than
   * painting something new. That is how a character reappears from behind
   * scenery it walked in front of, and it is why painting the stencil instead
   * would put a solid silhouette exactly where the character should be.
   */
  const DRAW_OPCODE = VGA_OPCODE_TABLES.simon2!.findIndex((entry) => entry?.endsWith('|DRAW'));
  const RET_OPCODE = 0;

  function maskedMachine(pixelBytes: number[], background?: Uint8Array) {
    const target = {
      width: 8,
      height: 4,
      pixels: new Uint8Array(32),
      ...(background ? { background } : {}),
    };
    const machine = new VgaMachine(
      Uint8Array.from([DRAW_OPCODE, 0, 1, 0, 0, 0, 0, 0, 0, DRAW_MASKED, RET_OPCODE]),
      Uint8Array.from(pixelBytes),
      'simon2',
      target,
    );
    return { machine, target };
  }

  /** An image entry: offset, flags, height, width in bits. */
  function entry(offset: number, widthBytes: number, height: number): number[] {
    const bits = widthBytes * 16;
    return [0, 0, offset >> 8, offset & 0xff, 0, height, bits >> 8, bits & 0xff];
  }

  const DRAW_MASKED = 0x20;

  it('takes the shape from the image and the colour from behind', () => {
    const pixels = [...entry(0, 0, 0), ...entry(16, 1, 1)];
    pixels.push(0x12);
    const background = new Uint8Array(32).fill(9);

    const { machine, target } = maskedMachine(pixels, background);
    machine.run(0);

    // Both nibbles are ink, so both pixels are revealed from the background —
    // as 9, not as the image's own 1 and 2.
    expect(target.pixels[0]).toBe(9);
    expect(target.pixels[1]).toBe(9);
    expect(machine.report.unimplementedFlags).toEqual([]);
  });

  it('says so rather than painting the stencil when there is nothing behind', () => {
    const pixels = [...entry(0, 0, 0), ...entry(16, 1, 1)];
    pixels.push(0x12);

    const { machine, target } = maskedMachine(pixels);
    machine.run(0);

    expect(machine.report.unimplementedFlags.join(' ')).toContain('no background surface');
    // Nothing drawn: a silhouette would sit exactly where a character should
    // have reappeared.
    expect([...target.pixels].every((pixel) => pixel === 0)).toBe(true);
  });
});

describe('depth scaling, which is how Feeble puts an actor in the distance', () => {
  /**
   * The factor arrives as **millionths** — an integer standing in for a float.
   * Taken at face value it is a scale of hundreds of thousands, which is the
   * sort of wrongness that shows up as nothing on screen rather than as an
   * error.
   */
  function scaledMachine(pixelBytes: number[], script: number[]) {
    const target = { width: 16, height: 16, pixels: new Uint8Array(256) };
    const machine = new VgaMachine(
      Uint8Array.from(script),
      Uint8Array.from(pixelBytes),
      'feeblefiles',
      target,
    );
    return { machine, target };
  }

  function entryFor(offset: number, widthBytes: number, height: number): number[] {
    const bits = widthBytes * 16;
    return [0, 0, offset >> 8, offset & 0xff, 0, height, bits >> 8, bits & 0xff];
  }

  it('draws unscaled where no script has set a scale', () => {
    const drawOpcode = VGA_OPCODE_TABLES.feeblefiles!.findIndex((entry) =>
      entry?.endsWith('|DRAW'),
    );
    const pixels = [...entryFor(0, 0, 0), ...entryFor(16, 1, 1)];
    pixels.push(0x11);

    const { machine, target } = scaledMachine(pixels, [drawOpcode, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    machine.run(0);

    // Two pixels from one byte, unscaled: every Version but Feeble takes this
    // path without anything asking which Version it is.
    expect(target.pixels[0]).toBe(1);
    expect(target.pixels[1]).toBe(1);
    expect(target.pixels[2]).toBe(0);
  });

  it('grows a sprite below the baseline', () => {
    const setScale = VGA_OPCODE_TABLES.feeblefiles!.findIndex((entry) =>
      entry?.endsWith('|SETSCALE'),
    );
    const drawOpcode = VGA_OPCODE_TABLES.feeblefiles!.findIndex((entry) =>
      entry?.endsWith('|DRAW'),
    );
    const pixels = [...entryFor(0, 0, 0), ...entryFor(16, 1, 1)];
    pixels.push(0x11);

    // Baseline 0, and the largest factor a word can hold — 65535 millionths,
    // about 0.066 per row. A sprite eight rows below the baseline is therefore
    // about half again as wide. The cap is the format's, not a choice: the
    // factor is a 16-bit word standing in for a float.
    const { machine, target } = scaledMachine(pixels, [
      setScale,
      0,
      0,
      0xff,
      0xff,
      drawOpcode,
      0,
      1,
      0,
      0,
      0,
      0,
      0,
      8,
      0,
      0,
    ]);
    machine.run(0);

    // The row the sprite was drawn at now holds more than the two pixels the
    // unscaled image has.
    const row = 8;
    const inked = [...target.pixels.slice(row * 16, row * 16 + 16)].filter((p) => p !== 0);
    expect(inked.length).toBeGreaterThan(2);
  });
});

/**
 * The three `v`-form variable opcodes, and the mistake their shape invites.
 *
 * `SUB_VAR` is `vd` — a variable index and an immediate — so it is `ADD_VAR`
 * the other way round. `COPY_VAR` and `ADD_VAR_F` are `vv`: **both** operands
 * are variable indices, so the second is *read* rather than taken as a value.
 * That is the whole reason they are separate opcodes rather than a wider
 * operand on `SET_VAR` and `ADD_VAR`, and reading the second as a literal is
 * the fault the shape invites — it would pass on any script whose source
 * variable happens to be numbered the same as its contents, which the third
 * test below rules out by making those differ.
 */
describe('the variable VGA opcodes', () => {
  // `simon2` rather than `simon1`, and the reason is worth a line: Simon 1's
  // table is addressed by **two-byte** opcodes (`vgaHasWideOpcodes`) while
  // Simon 2's is one byte, so a single-byte emit against the Simon 1 table is
  // read as a word and lands nowhere. Both tables carry all three opcodes.
  const TABLE = 'simon2';

  function opcode(name: string): number {
    const at = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith(`|${name}`));
    expect(at, `${name} is in the ${TABLE} table`).toBeGreaterThanOrEqual(0);
    return at;
  }

  /** A two-byte big-endian operand, which is what `v`, `d`, `i` and `w` all take. */
  function word(value: number): number[] {
    return [(value >> 8) & 0xff, value & 0xff];
  }

  function run(script: number[]) {
    // Wide enough to hold one 8-pixel x step, because that is the unit a
    // draw's x is in: an 8-pixel-wide target can only ever be drawn at x 0.
    const target = { width: 32, height: 4, pixels: new Uint8Array(32 * 4) };
    const machine = new VgaMachine(Uint8Array.from(script), new Uint8Array(64), TABLE, target);
    machine.run(0);
    return machine;
  }

  const RET = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith('|RET'));

  it('subtracts an immediate from a variable', () => {
    const machine = run([
      opcode('SET_VAR'),
      ...word(4),
      ...word(30),
      opcode('SUB_VAR'),
      ...word(4),
      ...word(12),
      RET,
    ]);
    expect(machine.variables[4]).toBe(18);
  });

  it('subtracts past zero rather than clamping', () => {
    // Nothing in the encoding says these are unsigned, and a clamp would be an
    // invention — `d` is read as a *signed* word by the decoder.
    const machine = run([
      opcode('SET_VAR'),
      ...word(1),
      ...word(5),
      opcode('SUB_VAR'),
      ...word(1),
      ...word(9),
      RET,
    ]);
    expect(machine.variables[1]).toBe(-4);
  });

  it('copies one variable into another, reading the source rather than its number', () => {
    // Source is variable 7 holding 99. If the second operand were taken as a
    // literal, the destination would end up 7.
    const machine = run([
      opcode('SET_VAR'),
      ...word(7),
      ...word(99),
      opcode('COPY_VAR'),
      ...word(7),
      ...word(2),
      RET,
    ]);
    const { variables } = machine;
    expect(variables[2]).toBe(99);
    expect(variables[7]).toBe(99);
  });

  /**
   * The direction, on its own, because it is the half of this opcode that can
   * be wrong while everything else about it is right.
   *
   * `vc32_copyVar` reads the *first* operand's contents and writes them to the
   * second — the opposite order from `ADD_VAR_F` beside it, and the opposite
   * order from how an assignment reads. Written the intuitive way round this
   * still passes the test above whenever the destination happens to be empty,
   * so the case that separates them is one where **both** variables hold
   * something.
   */
  it('copies the first operand into the second, not the other way about', () => {
    const machine = run([
      opcode('SET_VAR'),
      ...word(4),
      ...word(11),
      opcode('SET_VAR'),
      ...word(5),
      ...word(22),
      opcode('COPY_VAR'),
      ...word(4),
      ...word(5),
      RET,
    ]);
    const { variables } = machine;
    expect(variables[4]).toBe(11);
    expect(variables[5]).toBe(11);
  });

  it('adds one variable to another, reading both', () => {
    const machine = run([
      opcode('SET_VAR'),
      ...word(3),
      ...word(40),
      opcode('SET_VAR'),
      ...word(8),
      ...word(2),
      opcode('ADD_VAR_F'),
      ...word(3),
      ...word(8),
      RET,
    ]);
    const { variables } = machine;
    expect(variables[3]).toBe(42);
    // The source is untouched — this adds into the destination, not both ways.
    expect(variables[8]).toBe(2);
  });

  it('reports none of the three as unimplemented any more', () => {
    const machine = run([
      opcode('SET_VAR'),
      ...word(0),
      ...word(1),
      opcode('SUB_VAR'),
      ...word(0),
      ...word(1),
      opcode('COPY_VAR'),
      ...word(0),
      ...word(0),
      opcode('ADD_VAR_F'),
      ...word(0),
      ...word(0),
      RET,
    ]);
    const { unimplemented } = machine.report;
    for (const name of ['SUB_VAR', 'COPY_VAR', 'ADD_VAR_F']) {
      expect(unimplemented).not.toContain(name);
    }
  });
});

/**
 * Four opcodes whose whole observable behaviour is a record.
 *
 * Nothing under this machine draws or keeps a clock, so `MOUSE_ON`,
 * `MOUSE_OFF` and `SET_FRAME_RATE` can only note what a script asked for —
 * which is the pattern `SkyWorld` follows for its pointer, and which makes the
 * record the thing a test can hold. `STOP_ANIMATE` is different: it acts, but
 * on a sprite *named by id* rather than on the one running, which is how a
 * script stops something other than itself.
 */
describe('the recording VGA opcodes', () => {
  const TABLE = 'simon2';

  function opcode(name: string): number {
    const at = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith(`|${name}`));
    expect(at, `${name} is in the ${TABLE} table`).toBeGreaterThanOrEqual(0);
    return at;
  }

  function word(value: number): number[] {
    return [(value >> 8) & 0xff, value & 0xff];
  }

  function machineOf(script: number[]) {
    // Wide enough to hold one 8-pixel x step, because that is the unit a
    // draw's x is in: an 8-pixel-wide target can only ever be drawn at x 0.
    const target = { width: 32, height: 4, pixels: new Uint8Array(32 * 4) };
    return new VgaMachine(Uint8Array.from(script), new Uint8Array(64), TABLE, target);
  }

  const RET = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith('|RET'));

  it('shows and hides the pointer, starting shown', () => {
    const hide = machineOf([opcode('MOUSE_OFF'), RET]);
    expect(hide.mouseVisible).toBe(true);
    hide.run(0);
    expect(hide.mouseVisible).toBe(false);

    const show = machineOf([opcode('MOUSE_OFF'), opcode('MOUSE_ON'), RET]);
    show.run(0);
    expect(show.mouseVisible).toBe(true);
  });

  /**
   * The bits are one bank for the whole engine, not one per zone.
   *
   * `vc49_setBit` and `vc50_clearBit` call `setBitFlag`, which writes
   * `_bitArray` — an engine member, and the same one the game bytecode's
   * `oe2_bSet` writes. `setupVideoOpcodes` installs those handlers for every
   * zone, so a bit a zone 11 sprite raises is the bit a zone 1 sprite lowers.
   *
   * A bank per machine is the shape that looks harmless. What it cost is in
   * `docs/released-games.md`: Simon 1's opening raises bit 11 from zone 11 and
   * lowers it from zone 1, the lower never arrived, and the walk's stop script
   * — which guards itself with `IF_BIT_CLEAR 11` — armed a `WAIT_SYNC 1104`
   * that fired on the first turn of the player's first walk and stopped it
   * before a step.
   */
  it('shares one bit bank between machines when an Engine supplies one', () => {
    const guard = (): number[] => [
      opcode('IF_BIT_CLEAR'),
      ...word(11),
      opcode('SET_FRAME_RATE'),
      ...word(25),
      RET,
    ];

    // Its own bank by default, which is what the sweep and the decoding tests
    // want: a machine with no Engine behind it still runs.
    const alone = machineOf(guard());
    alone.run(0);
    expect(alone.frameRate).toBe(25);

    const bits = new Set<number>();
    const raiser = machineOf([opcode('SET_BIT'), ...word(11), RET]);
    const reader = machineOf(guard());
    raiser.bits = bits;
    reader.bits = bits;

    raiser.run(0);
    reader.run(0);
    // The guard saw another machine's bit and skipped past the rate.
    expect(reader.frameRate).toBeNull();

    const lowerer = machineOf([opcode('CLEAR_BIT'), ...word(11), RET]);
    const after = machineOf(guard());
    lowerer.bits = bits;
    after.bits = bits;

    lowerer.run(0);
    after.run(0);
    expect(after.frameRate).toBe(25);
  });

  it('keeps the frame rate a script asks for without claiming to honour it', () => {
    const machine = machineOf([opcode('SET_FRAME_RATE'), ...word(25), RET]);
    expect(machine.frameRate).toBeNull();
    machine.run(0);
    expect(machine.frameRate).toBe(25);
  });

  it('reports none of the three as unimplemented any more', () => {
    const machine = machineOf([
      opcode('MOUSE_OFF'),
      opcode('MOUSE_ON'),
      opcode('SET_FRAME_RATE'),
      ...word(10),
      RET,
    ]);
    machine.run(0);
    const { unimplemented } = machine.report;
    for (const name of ['MOUSE_ON', 'MOUSE_OFF', 'SET_FRAME_RATE']) {
      expect(unimplemented).not.toContain(name);
    }
  });

  /**
   * `STOP_ANIMATE`'s arity, now that it is established rather than open.
   *
   * One word in Simon 1, two in Simon 2 — and the two words are (zone, sprite),
   * settled by decoding every zone script: the first operand is always a small
   * zone number and the second the sprite. So Simon 2 stops the *second*
   * operand's sprite in the first's zone, and Simon 1's single word is a global
   * sprite id. The sprite it names may live in another zone, so the stop goes
   * through the host, which owns the rest.
   */
  it('stops the sprite Simon 2 names by (zone, sprite), through the host', () => {
    const host = new RecordingVgaHost();
    const target = { width: 32, height: 4, pixels: new Uint8Array(32 * 4) };
    const machine = new VgaMachine(
      Uint8Array.from([opcode('STOP_ANIMATE'), ...word(124), ...word(51), RET]),
      new Uint8Array(64),
      TABLE,
      target,
      host,
    );

    machine.run(0);

    // The sprite, not the zone, and it reaches the host so a cross-zone stop
    // is not silently dropped.
    expect(host.record.spritesStopped).toEqual([51]);
    expect(machine.report.unimplemented).not.toContain('STOP_ANIMATE');
  });

  it('keeps STOP_ANIMATE two words wide in Simon 2 and one in Simon 1', () => {
    expect(VGA_OPCODE_TABLES.simon1).toContain('d|STOP_ANIMATE');
    expect(VGA_OPCODE_TABLES.simon2).toContain('dd|STOP_ANIMATE');
  });

  /**
   * Fault 3. `SET_MARK` and `CLEAR_MARK` are `bb`, and the bit is the *second*
   * operand — the first is zero across every zone script. The mark reaches the
   * host, which shares one sixteen-bit word with the game bytecode, so an
   * animation setting a mark here is a mark a `os2_waitMark` sees. Left
   * unimplemented, a cutscene's pacing collapsed: every wait fell through at
   * once.
   */
  it('raises and lowers the bit its second operand names, through the host', () => {
    const host = new RecordingVgaHost();
    const target = { width: 32, height: 4, pixels: new Uint8Array(32 * 4) };
    const machine = new VgaMachine(
      Uint8Array.from([opcode('SET_MARK'), 0, 5, opcode('CLEAR_MARK'), 0, 9, RET]),
      new Uint8Array(64),
      TABLE,
      target,
      host,
    );

    machine.run(0);

    expect(host.record.marksSet).toEqual([5]);
    expect(host.record.marksCleared).toEqual([9]);
    expect(machine.report.unimplemented).not.toContain('SET_MARK');
    expect(machine.report.unimplemented).not.toContain('CLEAR_MARK');
  });

  /**
   * Fault 2. Simon 2's `NEW_SPRITE` is `dddddd` and carries the zone as an
   * operand, because its animation ids are zone-local: the same id runs in many
   * zones and the id cannot say which. Re-deriving the zone as `id / 100` —
   * Simon 1's rule, where ids are global — sent every start to zone 0 or
   * thereabouts and nothing appeared.
   *
   * **The zone is the second operand.** `vc3_loadSprite` reads `windowNum`
   * first for every Version and only then branches to read a zone for Simon 2,
   * so the shape is (window, zone, id, x, y, palette). Taking the first operand
   * instead gives the window — 3 or 4 in a real game — and looks every sprite
   * up in a zone that holds none: measured against Simon 2, 28,785 failed
   * starts against 38 successes, and no Simon anywhere on screen. With the
   * second, none fail. That is why this test names both numbers.
   *
   * Here the window is 4, the zone 124 and the sprite 51, whose hundreds column
   * is zero.
   */
  it('starts a sprite in the zone Simon 2 names, not its window and not the id hundreds column', () => {
    const started: { zone: number; id: number; x: number; y: number; palette: number }[] = [];
    const host = Object.assign(new RecordingVgaHost(), {
      startSpriteInZone: (zone: number, id: number, x: number, y: number, palette: number) => {
        started.push({ zone, id, x, y, palette });
        return true;
      },
    });
    const target = { width: 32, height: 4, pixels: new Uint8Array(32 * 4) };
    // dddddd: window, zone, id, x, y, palette.
    const machine = new VgaMachine(
      Uint8Array.from([
        opcode('NEW_SPRITE'),
        ...word(4),
        ...word(124),
        ...word(51),
        ...word(160),
        ...word(96),
        ...word(3),
        RET,
      ]),
      new Uint8Array(64),
      TABLE,
      target,
      host,
    );

    machine.run(0);

    expect(started).toEqual([{ zone: 124, id: 51, x: 160, y: 96, palette: 3 }]);
  });
});

/**
 * Fault 4. The Simon 2 VGA opcodes the machine used to run silently.
 *
 * Simon 2's drawing table carries eleven opcodes Simon 1's does not, and every
 * one of them landed in `unimplemented` and did nothing. They are the pacing
 * and control-flow of a Simon 2 cutscene — a long delay, a batch stop, three
 * variable comparisons, a slow fade, and the four MIDI opcodes — so a script
 * that reached one ran on as if it were a no-op. Their semantics are the
 * reference's (ScummVM `vga_s2.cpp`, `vc56`–`vc72`): the comparisons' sense in
 * particular is the reverse of their names, which is the mistake the names
 * invite.
 */
describe("Simon 2's own VGA opcodes are run, not recorded as gaps", () => {
  const TABLE = 'simon2';

  function opcode(name: string): number {
    const at = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith(`|${name}`));
    expect(at, `${name} is in the ${TABLE} table`).toBeGreaterThanOrEqual(0);
    return at;
  }

  function word(value: number): number[] {
    return [(value >> 8) & 0xff, value & 0xff];
  }

  function machineOf(script: number[], host?: RecordingVgaHost) {
    const target = { width: 32, height: 4, pixels: new Uint8Array(32 * 4) };
    return new VgaMachine(Uint8Array.from(script), new Uint8Array(64), TABLE, target, host);
  }

  const RET = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith('|RET'));

  function spriteWithId(id: number) {
    return {
      id,
      x: 0,
      y: 0,
      palette: 0,
      priority: 0,
      image: 0,
      flags: 0,
      scriptOffset: 0,
      halted: false,
      resumeOffset: null as number | null,
      wakeAtTick: null as number | null,
      waitingForSync: null as number | null,
      sequence: 0,
    };
  }

  /**
   * `WAIT_BIG` is `DELAY` with a `w` counter: it suspends the running sprite
   * and wakes it a number of frames later. Here the sprite reaches it, sleeps,
   * and is not woken by a tick before its time.
   */
  it('suspends a sprite on WAIT_BIG until its frames elapse', () => {
    const machine = machineOf([opcode('WAIT_BIG'), ...word(2), RET]);
    const sprite = spriteWithId(1);
    machine.sprites.push(sprite);
    machine.run(0, sprite);

    expect(sprite.wakeAtTick).not.toBeNull();
    expect(machine.report.unimplemented).not.toContain('WAIT_BIG');
    // Two frames times the frame count (1 by default), so one tick is not
    // enough to wake it.
    machine.tick();
    expect(sprite.resumeOffset).not.toBeNull();
  });

  /**
   * `SET_PRIORITIES` writes one sprite's draw priority by (zone, sprite,
   * priority). The machine holds one zone, so it writes its own sprite with
   * that id — the id, not the zone in the first operand.
   */
  it('sets the named sprite’s priority, by id not zone', () => {
    const machine = machineOf([
      opcode('SET_PRIORITIES'),
      ...word(124),
      ...word(51),
      ...word(7),
      RET,
    ]);
    const sprite = spriteWithId(51);
    machine.sprites.push(sprite);
    machine.run(0);

    expect(sprite.priority).toBe(7);
    expect(machine.report.unimplemented).not.toContain('SET_PRIORITIES');
  });

  /**
   * `STOP_ANIMATIONS` halts a range of sprites in a zone — (zone, first, last),
   * inclusive of last — each through the host that owns the zone.
   */
  it('stops a range of sprites through the host, inclusive of the last', () => {
    const host = new RecordingVgaHost();
    const machine = machineOf(
      [opcode('STOP_ANIMATIONS'), ...word(124), ...word(50), ...word(52), RET],
      host,
    );
    machine.run(0);

    expect(host.record.spritesStopped).toEqual([50, 51, 52]);
    expect(machine.report.unimplemented).not.toContain('STOP_ANIMATIONS');
  });

  /**
   * `SLOW_FADE_IN` is a real fade, counted like the fast fades because
   * honouring it needs a clock and a target palette this machine does not keep.
   */
  it('counts SLOW_FADE_IN as a fade it cannot perform', () => {
    const machine = machineOf([opcode('SLOW_FADE_IN'), RET]);
    machine.run(0);

    expect(machine.fadesRequested).toBe(1);
    expect(machine.report.unimplemented).not.toContain('SLOW_FADE_IN');
  });

  /**
   * The three variable comparisons, whose sense is the reference's and reversed
   * from the name: a failed test skips the next instruction. Each is checked
   * both ways — the branch taken and the branch skipped — because a flipped
   * comparison passes one direction and fails the other.
   */
  it('takes IF_VAR_EQUAL only when the two variables are equal', () => {
    // var 0 := 5, var 1 := 5; equal, so the following SET_VAR runs.
    const equal = machineOf([
      opcode('SET_VAR'),
      ...word(0),
      ...word(5),
      opcode('SET_VAR'),
      ...word(1),
      ...word(5),
      opcode('IF_VAR_EQUAL'),
      ...word(0),
      ...word(1),
      opcode('SET_VAR'),
      ...word(2),
      ...word(9),
      RET,
    ]);
    equal.run(0);
    expect(equal.variables[2]).toBe(9);
    expect(equal.report.unimplemented).not.toContain('IF_VAR_EQUAL');

    // var 1 := 6; unequal, so the following SET_VAR is skipped.
    const unequal = machineOf([
      opcode('SET_VAR'),
      ...word(0),
      ...word(5),
      opcode('SET_VAR'),
      ...word(1),
      ...word(6),
      opcode('IF_VAR_EQUAL'),
      ...word(0),
      ...word(1),
      opcode('SET_VAR'),
      ...word(2),
      ...word(9),
      RET,
    ]);
    unequal.run(0);
    expect(unequal.variables[2] ?? 0).toBe(0);
  });

  it('takes IF_VAR_LE when a is not greater-or-equal to b, skips otherwise', () => {
    // 3 <= 5: a < b, so NOT (a >= b) — the branch is taken.
    const taken = machineOf([
      opcode('SET_VAR'),
      ...word(0),
      ...word(3),
      opcode('SET_VAR'),
      ...word(1),
      ...word(5),
      opcode('IF_VAR_LE'),
      ...word(0),
      ...word(1),
      opcode('SET_VAR'),
      ...word(2),
      ...word(9),
      RET,
    ]);
    taken.run(0);
    expect(taken.variables[2]).toBe(9);

    // 5 >= 5: the reference skips on `>=`, so the branch is skipped.
    const skipped = machineOf([
      opcode('SET_VAR'),
      ...word(0),
      ...word(5),
      opcode('SET_VAR'),
      ...word(1),
      ...word(5),
      opcode('IF_VAR_LE'),
      ...word(0),
      ...word(1),
      opcode('SET_VAR'),
      ...word(2),
      ...word(9),
      RET,
    ]);
    skipped.run(0);
    expect(skipped.variables[2] ?? 0).toBe(0);
    expect(skipped.report.unimplemented).not.toContain('IF_VAR_LE');
  });

  it('takes IF_VAR_GE when a is not less-or-equal to b, skips otherwise', () => {
    // 7 vs 5: a > b, so NOT (a <= b) — the branch is taken.
    const taken = machineOf([
      opcode('SET_VAR'),
      ...word(0),
      ...word(7),
      opcode('SET_VAR'),
      ...word(1),
      ...word(5),
      opcode('IF_VAR_GE'),
      ...word(0),
      ...word(1),
      opcode('SET_VAR'),
      ...word(2),
      ...word(9),
      RET,
    ]);
    taken.run(0);
    expect(taken.variables[2]).toBe(9);

    // 5 <= 5: the reference skips on `<=`, so the branch is skipped.
    const skipped = machineOf([
      opcode('SET_VAR'),
      ...word(0),
      ...word(5),
      opcode('SET_VAR'),
      ...word(1),
      ...word(5),
      opcode('IF_VAR_GE'),
      ...word(0),
      ...word(1),
      opcode('SET_VAR'),
      ...word(2),
      ...word(9),
      RET,
    ]);
    skipped.run(0);
    expect(skipped.variables[2] ?? 0).toBe(0);
    expect(skipped.report.unimplemented).not.toContain('IF_VAR_GE');
  });

  /**
   * The four MIDI opcodes. Three ask for a track and are counted, because this
   * machine has no mixer; `IF_SEQ_WAITING` reads the other end and always skips
   * the next instruction, because with no player nothing is ever waiting.
   */
  it('counts PLAY_SEQ, JOIN_SEQ and SEQUE as music requests', () => {
    const machine = machineOf([
      opcode('PLAY_SEQ'),
      ...word(3),
      ...word(0),
      opcode('JOIN_SEQ'),
      ...word(4),
      ...word(0),
      opcode('SEQUE'),
      ...word(5),
      ...word(1),
      RET,
    ]);
    machine.run(0);

    expect(machine.midiRequests).toBe(3);
    for (const name of ['PLAY_SEQ', 'JOIN_SEQ', 'SEQUE']) {
      expect(machine.report.unimplemented).not.toContain(name);
    }
  });

  it('always skips after IF_SEQ_WAITING, because nothing is playing', () => {
    const machine = machineOf([
      opcode('IF_SEQ_WAITING'),
      opcode('SET_VAR'),
      ...word(0),
      ...word(9),
      RET,
    ]);
    machine.run(0);

    // The SET_VAR after it was skipped: no player means nothing is waiting.
    expect(machine.variables[0] ?? 0).toBe(0);
    expect(machine.report.unimplemented).not.toContain('IF_SEQ_WAITING');
  });
});

/**
 * Three more records, and the two neighbours left out on the same check.
 *
 * These three carry the **same operand shape in every Version**, verified
 * rather than assumed — which is the check `STOP_ANIMATE` failed. Two
 * neighbours fail it too and are named in the last test here, so the reason
 * lives beside the code rather than in a commit message.
 */
describe('the sync, sound and pathfind records', () => {
  const TABLE = 'simon2';

  function opcode(name: string): number {
    const at = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith(`|${name}`));
    expect(at, `${name} is in the ${TABLE} table`).toBeGreaterThanOrEqual(0);
    return at;
  }

  function word(value: number): number[] {
    return [(value >> 8) & 0xff, value & 0xff];
  }

  function machineOf(script: number[]) {
    // Wide enough to hold one 8-pixel x step, because that is the unit a
    // draw's x is in: an 8-pixel-wide target can only ever be drawn at x 0.
    const target = { width: 32, height: 4, pixels: new Uint8Array(32 * 4) };
    return new VgaMachine(Uint8Array.from(script), new Uint8Array(64), TABLE, target);
  }

  const RET = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith('|RET'));

  it('keeps every sync a script raises, in order', () => {
    const machine = machineOf([
      opcode('SYNC'),
      ...word(4),
      opcode('SYNC'),
      ...word(9),
      opcode('SYNC'),
      ...word(4),
      RET,
    ]);
    machine.run(0);
    // A list rather than a set: raising the same sync twice is two events, and
    // collapsing them would lose the thing a waiter counts.
    expect([...machine.syncs]).toEqual([4, 9, 4]);
  });

  it('counts the stop-all-sounds and clear-pathfind requests', () => {
    const machine = machineOf([
      opcode('STOP_ALL_SOUNDS'),
      opcode('CLEAR_PATHFIND_ARRAY'),
      opcode('STOP_ALL_SOUNDS'),
      RET,
    ]);
    expect(machine.stopAllSoundsCount).toBe(0);
    machine.run(0);
    expect(machine.stopAllSoundsCount).toBe(2);
    expect(machine.clearPathfindCount).toBe(1);
  });

  it('reports none of the three as unimplemented any more', () => {
    const machine = machineOf([
      opcode('SYNC'),
      ...word(1),
      opcode('STOP_ALL_SOUNDS'),
      opcode('CLEAR_PATHFIND_ARRAY'),
      RET,
    ]);
    machine.run(0);
    const { unimplemented } = machine.report;
    for (const name of ['SYNC', 'STOP_ALL_SOUNDS', 'CLEAR_PATHFIND_ARRAY']) {
      expect(unimplemented).not.toContain(name);
    }
  });

  /**
   * `DELAY` and `WAIT_SYNC` are left out for two different reasons, and both
   * are the kind that a passing test on one Version would hide.
   */
  it('carries DELAY at three different operand widths across the Versions', () => {
    const widths = new Set<string>();
    for (const table of Object.values(VGA_OPCODE_TABLES)) {
      for (const entry of table ?? []) {
        if (entry?.endsWith('|DELAY')) widths.add(entry.slice(0, entry.length - '|DELAY'.length));
      }
    }
    // Three different widths, which is the real fact. The claim that used to
    // sit here — that `b` is not a letter the operand decoder knows — was
    // simply false: `vgaScript.ts` has decoded `b` all along, which is why
    // DELAY could be implemented without touching the decoder.
    expect(widths.size).toBeGreaterThan(1);
    expect(widths).toContain('b');
  });

  it('suspends a sprite on WAIT_SYNC and resumes it when SYNC raises that id', () => {
    // The pause this used to be unable to sit in. A sprite that reaches
    // WAIT_SYNC stops there and stays stopped across ticks, and the *only*
    // thing that frees it is a script raising the id it named — which is what
    // makes the pairing a wait rather than a record.
    const waiter = {
      id: 1,
      x: 0,
      y: 0,
      palette: 0,
      priority: 0,
      image: 0,
      flags: 0,
      scriptOffset: 0,
      halted: false,
      resumeOffset: null as number | null,
      wakeAtTick: null as number | null,
      waitingForSync: null as number | null,
      sequence: 0,
    };

    const machine = machineOf([opcode('WAIT_SYNC'), ...word(3), RET]);
    machine.sprites.push(waiter);
    machine.run(0, waiter);

    expect(waiter.waitingForSync).toBe(3);
    expect(machine.report.unimplemented).not.toContain('WAIT_SYNC');

    // A timer is not a sync: ticking leaves it exactly where it was.
    machine.tick();
    machine.tick();
    expect(waiter.waitingForSync).toBe(3);

    // Now a script raises 3, and the waiter is free.
    const raiser = machineOf([opcode('SYNC'), ...word(3), RET]);
    raiser.sprites.push(waiter);
    raiser.run(0);

    expect(waiter.waitingForSync).toBeNull();
  });
});

/**
 * `JUMP_REL`, and why it refuses rather than guesses.
 *
 * The displacement is in bytes, and **what it is measured from is not
 * established** — the byte after the operand, or the instruction's own start.
 * Picking one and being wrong would shift every jump by three bytes, which
 * reads as a script misbehaving rather than as a decode fault. So the machine
 * resolves the target against the offsets the decoder produced and only jumps
 * when it lands exactly on an instruction boundary; anything else is recorded
 * and the script runs on.
 *
 * This also required `VgaInstruction` to carry its `offset`, which it did not
 * before — the arity of the control-flow opcodes was always knowable and their
 * destination was not.
 */
describe('jumping inside a VGA script', () => {
  const TABLE = 'simon2';

  function opcode(name: string): number {
    const at = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith(`|${name}`));
    expect(at, `${name} is in the ${TABLE} table`).toBeGreaterThanOrEqual(0);
    return at;
  }

  function word(value: number): number[] {
    return [(value >> 8) & 0xff, value & 0xff];
  }

  function machineOf(script: number[]) {
    // Wide enough to hold one 8-pixel x step, because that is the unit a
    // draw's x is in: an 8-pixel-wide target can only ever be drawn at x 0.
    const target = { width: 32, height: 4, pixels: new Uint8Array(32 * 4) };
    return new VgaMachine(Uint8Array.from(script), new Uint8Array(64), TABLE, target);
  }

  const RET = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith('|RET'));

  /**
   * `JUMP_REL d` at 0 (three bytes), then two `SET_VAR` of five bytes each at
   * offsets 3 and 8, then `RET`. A displacement of 5 from the byte after the
   * operand lands on 8 — the second `SET_VAR` — skipping the first.
   */
  it('skips an instruction when the displacement lands on a boundary', () => {
    const machine = machineOf([
      opcode('JUMP_REL'),
      ...word(5),
      opcode('SET_VAR'),
      ...word(0),
      ...word(1),
      opcode('SET_VAR'),
      ...word(0),
      ...word(2),
      RET,
    ]);
    machine.run(0);

    // 2, not 1: the first SET_VAR was jumped over.
    expect(machine.variables[0]).toBe(2);
    expect([...machine.unresolvedJumps]).toEqual([]);
  });

  it('records a jump that lands mid-instruction rather than taking it', () => {
    // A displacement of 1 targets offset 4, which is inside the first
    // SET_VAR's operands and not an instruction the decoder produced.
    const machine = machineOf([
      opcode('JUMP_REL'),
      ...word(1),
      opcode('SET_VAR'),
      ...word(0),
      ...word(7),
      RET,
    ]);
    machine.run(0);

    expect([...machine.unresolvedJumps]).toEqual([0]);
    // The script ran on rather than stopping, so the SET_VAR after it still ran.
    expect(machine.variables[0]).toBe(7);
  });

  it('abandons a script that jumps to itself for ever instead of hanging', () => {
    // A backwards jump onto its own start. A script that loops is a fact about
    // the script; a reader that hangs on one is a fault in the reader.
    const machine = machineOf([opcode('JUMP_REL'), ...word(-3), RET]);
    machine.run(0);

    expect(machine.runawayScripts).toBe(1);
  });
});

/**
 * `BLACK_PALETTE`, taken; the fades, counted.
 *
 * All three have no operands in every Version that carries them, so arity is
 * not the question here — the question is whether the end state is knowable.
 * Going black is; a fade is not, because it needs a clock.
 */
describe('the palette opcodes with no operands', () => {
  const TABLE = 'simon2';

  function opcode(name: string): number {
    const at = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith(`|${name}`));
    expect(at, `${name} is in the ${TABLE} table`).toBeGreaterThanOrEqual(0);
    return at;
  }

  const RET = VGA_OPCODE_TABLES[TABLE]!.findIndex((entry) => entry?.endsWith('|RET'));

  function machineOf(script: number[], setPalette?: (bank: number, rgb: Uint8Array) => void) {
    const target = {
      width: 8,
      height: 4,
      pixels: new Uint8Array(32),
      ...(setPalette ? { setPalette } : {}),
    };
    return new VgaMachine(Uint8Array.from(script), new Uint8Array(64), TABLE, target);
  }

  it('sets every colour to black, and counts as a palette change', () => {
    let got: Uint8Array | null = null;
    const machine = machineOf([opcode('BLACK_PALETTE'), RET], (_bank, rgb) => {
      got = rgb;
    });
    machine.run(0);

    expect(got).not.toBeNull();
    expect(got!.length).toBe(256 * 3);
    // Every byte, not just the first — a partial black is a different bug.
    expect(got!.some((value) => value !== 0)).toBe(false);
    expect(machine.report.palettesSet).toBe(1);
  });

  it('counts a fade rather than performing half of one', () => {
    // A fade-out's end state is black and a fade-in's is the palette it came
    // from, which nothing here remembers. Honouring the out-half alone would
    // leave a script that fades out and back on a black screen — worse than
    // not fading, because a count can be read and a black screen cannot be
    // explained.
    let calls = 0;
    const machine = machineOf([opcode('FASTFADEOUT'), opcode('FASTFADEIN'), RET], () => {
      calls += 1;
    });
    machine.run(0);

    expect(machine.fadesRequested).toBe(2);
    expect(calls).toBe(0);
    for (const name of ['FASTFADEOUT', 'FASTFADEIN']) {
      expect(machine.report.unimplemented).not.toContain(name);
    }
  });

  it('runs a SET_REPEAT/END_REPEAT loop the stated number of times', () => {
    // Which operand carries the count was the open question, and the reference
    // settles it: `SET_REPEAT` announces it and the *matching* `END_REPEAT`
    // owns and decrements it.
    //
    // The count is kept in a side table rather than written back over the
    // operand, which is what the original does. That is a deliberate
    // difference: a loop that rewrote its own bytes would break ADR 0030's
    // guarantee that a resource re-emits as the bytes it arrived as, and a
    // byte-identity check that passes before play and fails after it is worse
    // than no check.
    const machine = machineOf([opcode('SET_REPEAT'), 0, 2, 0, 3, RET]);
    machine.run(0);
    // Whatever the loop did, it did not report itself as unrunnable.
    expect(machine.report.unimplemented).not.toContain('SET_REPEAT');
  });

  /**
   * **`END_REPEAT`'s displacement lands inside `SET_REPEAT`, not on an
   * instruction**, and that is what makes the arithmetic look wrong until you
   * have read `vc21_endRepeat`. The original keeps the loop counter in the
   * script bytes — `vc20_setRepeat` writes it over its own second operand — so
   * the displacement points at that counter: three past it for Simon 2 and
   * AGOS 2, four for the rest, and then two more to step over the counter and
   * reach the loop body.
   *
   * Without the bias the jump lands on the `SET_REPEAT` itself, which is a
   * valid instruction boundary and therefore not reported — it re-announces the
   * count and loops for ever, or in Simon 2's own scripts lands mid-operand and
   * is recorded as unresolved. The opening carried 126 of those.
   *
   * The layout below is the one the games use, with the offsets spelled out:
   *
   * ```
   * 0  SET_REPEAT 2, 0   (1 + 2 + 2 = 5 bytes; the counter word is at 3)
   * 5  SYNC 7            (1 + 2 = 3 bytes)
   * 8  END_REPEAT -11    (1 + 2 = 3 bytes; base after the operand is 11)
   * 11 RET
   * ```
   *
   * `11 + (-11) = 0`, `+3` is the counter at 3, `+2` is the body at 5.
   */
  it('sends END_REPEAT back to the loop body, past the counter inside SET_REPEAT', () => {
    const machine = machineOf([
      opcode('SET_REPEAT'),
      0,
      2,
      0,
      0,
      opcode('SYNC'),
      0,
      7,
      opcode('END_REPEAT'),
      0xff,
      0xf5,
      RET,
    ]);

    machine.run(0);

    // The body ran more than once, and the jump found an instruction.
    expect(machine.syncs.length).toBeGreaterThan(1);
    expect(machine.unresolvedJumps).toEqual([]);
  });
});

/**
 * The `DUMMY` opcodes, and why a no-op is the implementation.
 *
 * These are slots the original interpreter occupied and did nothing for, so
 * consuming their operands and doing nothing is the behaviour rather than an
 * omission. The distinction matters for the coverage figure: an unimplemented
 * opcode is a gap somebody should close, and one of these is a gap that does
 * not exist — conflating them would make the number lie in the flattering
 * direction, which is why they are counted on their own.
 */
describe('the DUMMY VGA opcodes', () => {
  const TABLE = 'simon2';
  const entries = VGA_OPCODE_TABLES[TABLE]!;
  const RET = entries.findIndex((entry) => entry?.endsWith('|RET'));

  /** Discovered rather than named: not every Version carries every DUMMY. */
  const dummies = entries
    .map((entry, opcode) => ({ entry, opcode }))
    .filter((row): row is { entry: string; opcode: number } => /\|DUMMY_/.test(row.entry ?? ''));

  function machineOf(script: number[]) {
    // Wide enough to hold one 8-pixel x step, because that is the unit a
    // draw's x is in: an 8-pixel-wide target can only ever be drawn at x 0.
    const target = { width: 32, height: 4, pixels: new Uint8Array(32 * 4) };
    return new VgaMachine(Uint8Array.from(script), new Uint8Array(64), TABLE, target);
  }

  it('has some to test, or this whole block is vacuous', () => {
    expect(dummies.length).toBeGreaterThan(0);
  });

  it('runs each one, consuming its operands, and reports none unimplemented', () => {
    for (const { entry, opcode } of dummies) {
      const letters = entry.slice(0, entry.indexOf('|'));
      // Two bytes per operand letter: every letter these use is a word.
      const operandBytes = new Array<number>(letters.length * 2).fill(0);
      const machine = machineOf([opcode, ...operandBytes, RET]);

      expect(() => machine.run(0)).not.toThrow();
      expect(machine.dummiesRun).toBe(1);
      expect(machine.report.unimplemented).toEqual([]);
    }
  });

  it('counts them apart from real work, so the figure stays honest', () => {
    const first = dummies[0]!;
    const letters = first.entry.slice(0, first.entry.indexOf('|'));
    const machine = machineOf([
      first.opcode,
      ...new Array<number>(letters.length * 2).fill(0),
      first.opcode,
      ...new Array<number>(letters.length * 2).fill(0),
      RET,
    ]);
    machine.run(0);

    expect(machine.dummiesRun).toBe(2);
    // Not folded into any of the other tallies.
    expect(machine.report.drawn).toBe(0);
    expect(machine.report.palettesSet).toBe(0);
  });
});

/**
 * One z-order for the whole game, not one per zone.
 *
 * `AGOSEngine::animateSprites` (`draw.cpp:202`) walks a single `_vgaSprites`
 * array that every zone appends to, and `vc23_setPriority` (`vga.cpp:1275`)
 * keeps that one array in priority order. Drawing zone by zone makes the zone
 * the outer sort key instead, and the priorities only order sprites within it.
 */
describe('sprites drawn across zones', () => {
  /** An image entry, as `imageEntry` above: offset, flags, height, width. */
  function solid(colour: number): Uint8Array {
    // Entry 0 is unused — image 0 means "showing nothing" — so entry 1 is the
    // one drawn: one byte wide and one row tall, and a byte holds two pixels.
    const bytes = [
      ...[0, 0, 0, 0, 0, 0, 0, 0],
      ...[0, 0, 0, 16, 0, 1, 0, 2],
      (colour << 4) | colour,
    ];
    return Uint8Array.from(bytes);
  }

  function zoneWith(target: { width: number; height: number; pixels: Uint8Array }, colour: number) {
    return new VgaMachine(new Uint8Array(8), solid(colour), 'simon1', target);
  }

  function spriteOf(priority: number, sequence: number) {
    return {
      id: 1,
      x: 0,
      y: 0,
      palette: 0,
      priority,
      image: 1,
      // Opaque, so colour zero still writes and the test reads a painted pixel
      // rather than a skipped one.
      flags: 2,
      scriptOffset: 0,
      halted: false,
      resumeOffset: null as number | null,
      wakeAtTick: null as number | null,
      waitingForSync: null as number | null,
      sequence,
    };
  }

  /**
   * Measured in Simon 1's first room before this existed: Simon stands at
   * priority 40 in zone 11 and the fire burns at priority 30 in zone 64, and
   * every frame the fire was painted over him — a walk that ended in front of
   * the fireplace put the flames through his robe.
   */
  it('puts a high-priority sprite in front of a low-priority one from a later zone', () => {
    const target = { width: 8, height: 1, pixels: new Uint8Array(8) };
    const front = zoneWith(target, 5);
    const behind = zoneWith(target, 9);
    front.sprites.push(spriteOf(40, 0));
    behind.sprites.push(spriteOf(30, 1));

    paintZoneSprites([front, behind]);

    expect(target.pixels[0]).toBe(5);
  });

  it('falls back to creation order where two priorities are equal', () => {
    const target = { width: 8, height: 1, pixels: new Uint8Array(8) };
    const earlier = zoneWith(target, 5);
    const later = zoneWith(target, 9);
    earlier.sprites.push(spriteOf(40, 7));
    later.sprites.push(spriteOf(40, 2));

    paintZoneSprites([earlier, later]);

    // The one created first is drawn first, so the *later* one is on top —
    // which is the order the reference's one array holds them in.
    expect(target.pixels[0]).toBe(5);
  });
});

/**
 * The variables are the game's, and the two bytecodes talk through them.
 *
 * One `_variableArray` in the reference: `vcReadVar` and `readVariable` index
 * the same array. Simon's own sprite is the clearest case — `SET_SPRITE_X 15`
 * takes his x out of variable 15, and the *game* script is what puts it there.
 */
describe('variables shared with the game bytecode', () => {
  it('reads a sprite position out of the array the game writes', () => {
    const target = { width: 320, height: 200, pixels: new Uint8Array(320 * 200) };
    const shared = new Int16Array(256);
    // `v|SET_SPRITE_X` and `v|SET_SPRITE_Y`, which is opcodes 45 and 46.
    const setX = VGA_OPCODE_TABLES.simon1!.findIndex((entry) => entry === 'v|SET_SPRITE_X');
    const setY = VGA_OPCODE_TABLES.simon1!.findIndex((entry) => entry === 'v|SET_SPRITE_Y');
    const machine = new VgaMachine(
      // Simon 1 reads **16-bit** VGA opcodes — the opposite of its game
      // bytecode — so each opcode and each operand is a word.
      Uint8Array.from([0, setX, 0, 15, 0, setY, 0, 16, 0, 0]),
      new Uint8Array(64),
      'simon1',
      target,
    );
    machine.variables = shared;
    shared[15] = 17;
    shared[16] = 94;

    const sprite = {
      id: 1111,
      x: 0,
      y: 0,
      palette: 0,
      priority: 0,
      image: 0,
      flags: 0,
      scriptOffset: 0,
      halted: false,
      resumeOffset: null as number | null,
      wakeAtTick: null as number | null,
      waitingForSync: null as number | null,
      sequence: 0,
    };
    machine.sprites.push(sprite);
    machine.run(0, sprite);

    // A private array here read zeroes and drew Simon in the corner of the
    // screen however far the game had walked him.
    expect(sprite.x).toBe(17);
    expect(sprite.y).toBe(94);
  });
});
