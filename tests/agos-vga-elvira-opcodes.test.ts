/**
 * The VGA opcodes Elvira 1, Elvira 2, Waxworks and The Feeble Files add, and
 * the slots their reference leaves empty.
 *
 * Each test checks an opcode's *observable* effect — a pixel, a palette entry,
 * a variable, a wait that holds and then ends — because an opcode that merely
 * decoded and fell through would pass a test that only checked it ran.
 */
import { describe, expect, it } from 'vitest';
import { VgaMachine, type VgaSprite, type VgaTarget } from '../src/engine/agos/gfx/VgaMachine.js';
import { VGA_OPCODE_TABLES, vgaHasWideOpcodes } from '../src/engine/agos/gfx/vgaOpcodeTables.js';
import { RecordingVgaHost, type VgaHost } from '../src/engine/agos/gfx/vgaHost.js';
import { vgaReferenceHasHandler } from '../src/engine/agos/gfx/vgaReferenceSlots.js';

/** An opcode's bytes in a Version's script, at that Version's opcode width. */
function op(table: string, name: string): number[] {
  const index = VGA_OPCODE_TABLES[table]!.findIndex((entry) => entry?.endsWith(`|${name}`));
  if (index < 0) throw new Error(`no ${name} in the ${table} table`);
  return vgaHasWideOpcodes(table) ? word(index) : [index];
}

function word(value: number): number[] {
  return [(value >> 8) & 255, value & 255];
}

interface Rig {
  machine: VgaMachine;
  target: VgaTarget & {
    background: Uint8Array;
    windows: Map<number, [number, number, number, number]>;
  };
  palettes: { base: number; rgb: number[] }[];
}

function rig(
  table: string,
  script: number[],
  options: { pixels?: Uint8Array; host?: VgaHost; scriptsAt?: number; scripts?: Uint8Array } = {},
): Rig {
  const palettes: { base: number; rgb: number[] }[] = [];
  const target = {
    width: 320,
    height: 200,
    pixels: new Uint8Array(320 * 200),
    background: new Uint8Array(320 * 200),
    windows: new Map<number, [number, number, number, number]>(),
    setPalette: (base: number, rgb: Uint8Array) => palettes.push({ base, rgb: [...rgb] }),
  };
  const at = options.scriptsAt ?? 0;
  const scripts = options.scripts ?? new Uint8Array(at + script.length);
  scripts.set(script, at);
  const machine = new VgaMachine(
    scripts,
    options.pixels ?? new Uint8Array(64),
    table,
    target,
    options.host,
  );
  return { machine, target, palettes };
}

function spriteOf(id: number, scriptOffset: number): VgaSprite {
  return {
    id,
    x: 0,
    y: 0,
    palette: 0,
    priority: 0,
    image: 0,
    flags: 0,
    scriptOffset,
    halted: false,
    resumeOffset: null,
    wakeAtTick: null,
    waitingForSync: null,
    sequence: 0,
  };
}

describe('WAIT_END', () => {
  for (const table of ['elvira1', 'elvira2', 'waxworks']) {
    it(`${table}: sleeps until the named sprite halts, then carries on after the wait`, () => {
      const waiterScript = [
        ...op(table, 'WAIT_END'),
        ...word(7),
        ...op(table, 'SET_VAR'),
        ...word(3),
        ...word(42),
        ...op(table, 'RET'),
      ];
      const haltAt = waiterScript.length;
      const { machine } = rig(table, [...waiterScript, ...op(table, 'HALT_SPRITE')]);
      const waiter = spriteOf(5, 0);
      const awaited = spriteOf(7, haltAt);
      machine.sprites.push(waiter, awaited);

      machine.run(0, waiter);
      expect(machine.variables[3]).toBe(0);
      expect(machine.endWaitsSuspended).toBe(1);

      // Not woken by the clock: the wait is for an end, not for time.
      machine.step();
      expect(machine.variables[3]).toBe(0);

      machine.run(haltAt, awaited);
      machine.runFrame();
      expect(machine.variables[3]).toBe(42);
    });
  }

  it('runs straight on when the named sprite is not loaded', () => {
    const table = 'elvira2';
    const { machine } = rig(table, [
      ...op(table, 'WAIT_END'),
      ...word(7),
      ...op(table, 'SET_VAR'),
      ...word(3),
      ...word(42),
      ...op(table, 'RET'),
    ]);
    const waiter = spriteOf(5, 0);
    machine.sprites.push(waiter);
    machine.run(0, waiter);
    expect(machine.variables[3]).toBe(42);
  });

  it('is also ended by another script stopping the sprite', () => {
    const table = 'waxworks';
    const { machine } = rig(table, [
      ...op(table, 'WAIT_END'),
      ...word(7),
      ...op(table, 'SET_VAR'),
      ...word(3),
      ...word(1),
      ...op(table, 'RET'),
    ]);
    const waiter = spriteOf(5, 0);
    machine.sprites.push(waiter, spriteOf(7, 0));
    machine.run(0, waiter);
    machine.stopSprite(7);
    machine.runFrame();
    expect(machine.variables[3]).toBe(1);
  });
});

describe('slots the reference never assigns', () => {
  it('reports them by name, as a disagreement rather than a gap', () => {
    for (const [table, name] of [
      ['elvira1', 'ON_STOP'],
      ['elvira1', 'VC_45'],
      ['elvira2', 'ON_STOP'],
      ['elvira2', 'INTRO'],
      ['feeblefiles', 'PAN_SFX'],
    ] as const) {
      const operands = VGA_OPCODE_TABLES[table]!.find((entry) => entry?.endsWith(`|${name}`))!;
      const count = operands.split('|')[0]!.replace(/[jx]/g, '').length;
      const { machine } = rig(table, [
        ...op(table, name),
        ...Array.from({ length: count }, () => word(1)).flat(),
        ...op(table, 'RET'),
      ]);
      machine.run(0);
      expect(machine.report.unimplemented).toEqual([
        `${name}: no handler in the reference for ${table}`,
      ]);
    }
  });

  it('knows ON_STOP is unassigned in every Version this family runs', () => {
    for (const table of ['elvira1', 'elvira2', 'waxworks']) {
      const slot = VGA_OPCODE_TABLES[table]!.findIndex((entry) => entry?.endsWith('|ON_STOP'));
      expect(vgaReferenceHasHandler(table, slot)).toBe(false);
    }
  });
});

describe('the Elvira 2 and Waxworks screen and palette opcodes', () => {
  const table = 'elvira2';

  it('SAVE_SCREEN copies window 4 from the screen into the background', () => {
    const { machine, target } = rig(table, [...op(table, 'SAVE_SCREEN'), ...op(table, 'RET')]);
    target.windows.set(4, [1, 2, 1, 2]);
    target.pixels.fill(9);
    machine.run(0);
    expect(target.background[2 * 320 + 16]).toBe(9);
    expect(target.background[3 * 320 + 31]).toBe(9);
    expect(target.background[3 * 320 + 32]).toBe(0);
    expect(target.background[4 * 320 + 16]).toBe(0);
    expect(target.background[2 * 320 + 15]).toBe(0);
  });

  it('POKE_PALETTE sets one entry from a 0RGB word, each nibble times 32', () => {
    const { machine, palettes } = rig('elvira1', [
      ...op('elvira1', 'POKE_PALETTE'),
      ...word(5),
      ...word(0x741),
      ...op('elvira1', 'RET'),
    ]);
    machine.run(0);
    expect(palettes).toEqual([{ base: 5, rgb: [224, 128, 32] }]);
  });

  it('SET_WINDOW_PALETTE rewrites each pixel pair as the reference word does', () => {
    const { machine, target } = rig(table, [
      ...op(table, 'SET_WINDOW_PALETTE'),
      ...word(1),
      ...word(2),
      ...op(table, 'RET'),
    ]);
    target.windows.set(1, [1, 0, 1, 1]);
    target.pixels.fill(0x3a);
    machine.run(0);
    expect(target.pixels[16]).toBe(0x2a);
    expect(target.pixels[17]).toBe(0x0a);
    expect(target.pixels[15]).toBe(0x3a);
    expect(target.pixels[32]).toBe(0x3a);
  });

  it('SET_PALETTE_SLOT2 loads an old-bundle bank into colours 32-47', () => {
    const scriptsAt = 128;
    const scripts = new Uint8Array(256);
    // The palette table's offset is the word at +6; bank 1 is 32 bytes on.
    scripts.set(word(8), 6);
    scripts.set(word(0x123), 8 + 32);
    const { machine, palettes } = rig(
      table,
      [...op(table, 'SET_PALETTE_SLOT2'), ...word(1), ...op(table, 'RET')],
      { scripts, scriptsAt },
    );
    machine.run(scriptsAt);
    expect(palettes).toHaveLength(1);
    expect(palettes[0]!.base).toBe(32);
    expect(palettes[0]!.rgb.slice(0, 3)).toEqual([32, 64, 96]);
    expect(palettes[0]!.rgb).toHaveLength(48);
  });

  it('DISSOLVE_OUT covers the window in its colour, keeping the first pixel bank', () => {
    const { machine, target } = rig(table, [
      ...op(table, 'DISSOLVE_OUT'),
      ...word(1),
      ...word(5),
      ...word(3),
      ...op(table, 'RET'),
    ]);
    target.windows.set(1, [1, 1, 1, 2]);
    target.pixels.fill(0x30);
    machine.run(0);
    expect(target.pixels[320 + 16]).toBe(0x35);
    expect(target.pixels[2 * 320 + 31]).toBe(0x35);
    expect(target.pixels[3 * 320 + 16]).toBe(0x30);
    expect(machine.dissolvesRequested).toBe(1);
  });

  it('DISSOLVE_IN is counted, and leaves the screen it would reveal', () => {
    const { machine, target } = rig(table, [
      ...op(table, 'DISSOLVE_IN'),
      ...word(4),
      ...word(1),
      ...op(table, 'RET'),
    ]);
    target.pixels.fill(7);
    machine.run(0);
    expect(machine.dissolvesRequested).toBe(1);
    expect(target.pixels.every((pixel) => pixel === 7)).toBe(true);
    expect(machine.report.unimplemented).toEqual([]);
  });

  it('FULL_SCREEN copies the picture at 800 and puts up the palette at 32', () => {
    const pixels = new Uint8Array(800 + 320 * 200);
    pixels[32] = 63;
    pixels[800 + 320 * 199 + 319] = 17;
    pixels[800 + 5] = 4;
    const { machine, target, palettes } = rig(
      table,
      [...op(table, 'FULL_SCREEN'), ...op(table, 'RET')],
      { pixels },
    );
    machine.run(0);
    expect(target.pixels[5]).toBe(4);
    expect(target.pixels[320 * 200 - 1]).toBe(17);
    expect(palettes[0]!.base).toBe(0);
    expect(palettes[0]!.rgb[0]).toBe(252);
    expect(palettes[0]!.rgb).toHaveLength(768);
  });

  it('CHECK_CODE_WHEEL passes the protection by zeroing variable 0', () => {
    const { machine } = rig(table, [...op(table, 'CHECK_CODE_WHEEL'), ...op(table, 'RET')]);
    machine.variables[0] = 9;
    machine.run(0);
    expect(machine.variables[0]).toBe(0);
  });

  it('IF_EGA always skips the instruction it guards', () => {
    const { machine } = rig(table, [
      ...op(table, 'IF_EGA'),
      ...op(table, 'SET_VAR'),
      ...word(3),
      ...word(1),
      ...op(table, 'SET_VAR'),
      ...word(4),
      ...word(1),
      ...op(table, 'RET'),
    ]);
    machine.run(0);
    expect(machine.variables[3]).toBe(0);
    expect(machine.variables[4]).toBe(1);
  });

  it("INTRO copies Waxworks' title part into its block", () => {
    const pixels = new Uint8Array(64800 + 800 + 144 * 177);
    pixels[64800 + 800] = 11;
    pixels[64800 + 800 + 144 * 176 + 143] = 12;
    const { machine, target } = rig(
      'waxworks',
      [...op('waxworks', 'INTRO'), ...word(1), ...op('waxworks', 'RET')],
      { pixels },
    );
    machine.run(0);
    expect(target.pixels[23 * 320 + 88]).toBe(11);
    expect(target.pixels[(23 + 176) * 320 + 88 + 143]).toBe(12);
    expect(machine.report.unimplemented).toEqual([]);
  });
});

describe('the Feeble Files route, random and sound-loop opcodes', () => {
  const table = 'feeblefiles';

  class RouteHost extends RecordingVgaHost {
    override pathRoute(route: number): readonly (readonly [number, number])[] | null {
      super.pathRoute(route);
      return route === 2
        ? [
            [10, 20],
            [30, 40],
            [50, 60],
          ]
        : null;
    }

    override nextPathValue(): number | null {
      super.nextPathValue();
      return 7;
    }
  }

  it('COMPUTEXY puts the sprite on the route point variables 12 and 13 name', () => {
    const { machine } = rig(table, [...op(table, 'COMPUTEXY'), ...op(table, 'RET')], {
      host: new RouteHost(),
    });
    const sprite = spriteOf(1, 0);
    machine.sprites.push(sprite);
    machine.variables[12] = 2;
    machine.variables[13] = 1;
    machine.bits.add(85);
    machine.run(0, sprite);
    expect([sprite.x, sprite.y]).toEqual([30, 40]);
    expect([machine.variables[15], machine.variables[16]]).toEqual([30, 40]);
    expect(machine.bits.has(85)).toBe(false);
  });

  it('COMPUTEXY names a route it cannot read rather than reading zeroes', () => {
    const { machine } = rig(table, [...op(table, 'COMPUTEXY'), ...op(table, 'RET')]);
    machine.variables[12] = 4;
    machine.run(0);
    expect(machine.report.unimplemented).toEqual(['COMPUTEXY: no point 0 on route 4']);
  });

  it('COMPUTEPOSNUM counts the route points at or above the row in variable 16', () => {
    const { machine } = rig(table, [...op(table, 'COMPUTEPOSNUM'), ...op(table, 'RET')], {
      host: new RouteHost(),
    });
    machine.variables[12] = 2;
    machine.variables[16] = 45;
    machine.run(0);
    expect(machine.variables[13]).toBe(2);
  });

  it('SETOVERLAYIMAGE sets the cel, moves the sprite and names the overlay flag', () => {
    const { machine } = rig(table, [
      ...op(table, 'SETOVERLAYIMAGE'),
      ...word(9),
      ...word(3),
      ...word(-2),
      ...op(table, 'RET'),
    ]);
    const sprite = spriteOf(1, 0);
    sprite.x = 10;
    sprite.y = 10;
    machine.run(0, sprite);
    expect([sprite.image, sprite.x, sprite.y, sprite.flags]).toEqual([9, 13, 8, 0x10]);
    expect(machine.report.unimplementedFlags).toContain('overlayed (AGOS 2 kDFOverlayed)');
  });

  it('SETRANDOM draws below its bound', () => {
    const { machine } = rig(table, [
      ...op(table, 'SETRANDOM'),
      ...word(5),
      ...word(10),
      ...op(table, 'RET'),
    ]);
    machine.random = () => 0.999;
    machine.run(0);
    expect(machine.variables[5]).toBe(9);
  });

  it('GETPATHVALUE writes the next path value, and names its absence', () => {
    const script = [...op(table, 'GETPATHVALUE'), ...word(6), ...op(table, 'RET')];
    const withValues = rig(table, script, { host: new RouteHost() }).machine;
    withValues.run(0);
    expect(withValues.variables[6]).toBe(7);

    const without = rig(table, script).machine;
    without.run(0);
    expect(without.report.unimplemented).toEqual(['GETPATHVALUE: no path value to read']);
  });

  it('PLAYSOUNDLOOP and STOPSOUNDLOOP go to the host', () => {
    const host = new RecordingVgaHost();
    const { machine } = rig(
      table,
      [
        ...op(table, 'PLAYSOUNDLOOP'),
        ...word(12),
        ...word(100),
        ...word(0),
        ...op(table, 'STOPSOUNDLOOP'),
        ...op(table, 'RET'),
      ],
      { host },
    );
    machine.run(0);
    expect(host.record.soundLoopsStarted).toEqual([12]);
    expect(host.record.soundLoopStops).toBe(1);
  });
});
