/**
 * The VGA scheduler, and the opcodes that only exist because of it.
 *
 * A VGA script does not run to its end and stop. `DELAY` and `WAIT_SYNC` put it
 * to sleep and something re-enters it later at its own program counter, and
 * before that was true both opcodes were deliberately left unimplemented —
 * recording a wait lets a script straight through the pause it names, which is
 * worse than reporting it.
 *
 * What is asserted here is therefore mostly about *not* running: that a sleeping
 * script stays asleep until the thing it is waiting for happens, and that the
 * thing which wakes it is the right one. A test that only checked a script
 * eventually carried on would pass against a machine that ignored waits
 * entirely.
 */
import { describe, expect, it } from 'vitest';
import { VgaMachine, type VgaSprite } from '../src/engine/agos/gfx/VgaMachine.js';
import { VGA_OPCODE_TABLES, vgaHasWideOpcodes } from '../src/engine/agos/gfx/vgaOpcodeTables.js';
import { RecordingVgaHost, type VgaHost } from '../src/engine/agos/gfx/vgaHost.js';

const TABLE = 'simon1';
const entries = VGA_OPCODE_TABLES[TABLE]!;

/**
 * An opcode as the bytes a script carries it in.
 *
 * Simon 1's opcodes are **two bytes wide** (`vgaHasWideOpcodes`), unlike Simon
 * 2's and The Feeble Files'. Emitting one byte here decodes the opcode and the
 * byte after it as a single word, which fails with a number in the thousands
 * rather than with anything that points at the cause — so the width comes from
 * the same function the decoder uses.
 */
function op(name: string): number[] {
  const index = entries.findIndex((entry) => entry?.endsWith(`|${name}`));
  if (index < 0) throw new Error(`no ${name} in the ${TABLE} table`);
  return vgaHasWideOpcodes(TABLE) ? word(index) : [index];
}

/** A signed word, big-endian, which is how every `d`/`w`/`i` operand arrives. */
function word(value: number): number[] {
  return [(value >> 8) & 255, value & 255];
}

const RET = op('RET');

function machineOf(script: number[], host?: VgaHost) {
  const target = { width: 320, height: 200, pixels: new Uint8Array(320 * 200) };
  return new VgaMachine(new Uint8Array(script), new Uint8Array(64), TABLE, target, host);
}

/** A sprite parked at the start of the script, ready to be stepped. */
function spriteAt(scriptOffset = 0): VgaSprite {
  return {
    id: 1,
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

describe('a sprite sleeping on DELAY', () => {
  it('stops at the delay and carries on only once its ticks have passed', () => {
    // SET_VAR is the observable side of "did it get past the delay", chosen
    // because it needs nothing outside the machine to check.
    const machine = machineOf([
      ...op('DELAY'),
      ...word(3),
      ...op('SET_VAR'),
      ...word(7),
      ...word(42),
      ...RET,
    ]);
    const sprite = spriteAt();
    machine.sprites.push(sprite);

    machine.run(0, sprite);
    // Suspended, and the instruction after the delay has *not* run.
    expect(machine.variables[7]).toBe(0);
    expect(sprite.wakeAtTick).toBe(3);
    expect(sprite.resumeOffset).not.toBeNull();

    machine.tick();
    machine.tick();
    expect(machine.variables[7]).toBe(0); // still asleep on tick 2 of 3

    machine.tick();
    expect(machine.variables[7]).toBe(42);
  });

  it('resumes after the delay rather than back on it, so a sleep is not forever', () => {
    // The bug this guards: a resume that re-entered the DELAY would compute a
    // fresh wake tick every time and the script would never advance.
    const machine = machineOf([...op('DELAY'), ...word(1), ...RET]);
    const sprite = spriteAt();
    machine.sprites.push(sprite);

    machine.run(0, sprite);
    machine.tick();

    expect(sprite.wakeAtTick).toBeNull();
    expect(sprite.resumeOffset).toBeNull();
  });

  it('scales the delay by the release frame count', () => {
    const machine = machineOf([...op('DELAY'), ...word(2), ...RET]);
    machine.frameCount = 5;
    const sprite = spriteAt();
    machine.sprites.push(sprite);

    machine.run(0, sprite);

    expect(sprite.wakeAtTick).toBe(10);
  });
});

describe('DELAY_IF_NOT_EQ waits for a value rather than testing once', () => {
  it('re-tests the same instruction each tick until the variable matches', () => {
    const machine = machineOf([
      ...op('DELAY_IF_NOT_EQ'),
      ...word(4),
      ...word(9),
      ...op('SET_VAR'),
      ...word(1),
      ...word(1),
      ...RET,
    ]);
    const sprite = spriteAt();
    machine.sprites.push(sprite);

    machine.run(0, sprite);
    // var 4 is 0, not 9, so it waits — and the wait resumes *on* the test.
    expect(sprite.resumeOffset).toBe(0);
    expect(machine.variables[1]).toBe(0);

    machine.tick();
    expect(machine.variables[1]).toBe(0); // still not 9

    machine.variables[4] = 9;
    machine.tick();
    expect(machine.variables[1]).toBe(1);
  });
});

describe('the item-tree conditions ask the host and skip on no', () => {
  /** A host that says yes to one item and no to everything else. */
  function hostSaying(present: number): VgaHost {
    const base = new RecordingVgaHost();
    return Object.assign(Object.create(Object.getPrototypeOf(base) as object) as VgaHost, base, {
      objectHere: (item: number) => item === present,
    });
  }

  it('runs the next instruction when the object is here', () => {
    const machine = machineOf(
      [...op('IF_OBJECT_HERE'), ...word(12), ...op('SET_VAR'), ...word(2), ...word(1), ...RET],
      hostSaying(12),
    );

    machine.run(0);

    expect(machine.variables[2]).toBe(1);
    expect(machine.report.unimplemented).not.toContain('IF_OBJECT_HERE');
  });

  it('skips the next instruction when it is not', () => {
    const machine = machineOf(
      [...op('IF_OBJECT_HERE'), ...word(12), ...op('SET_VAR'), ...word(2), ...word(1), ...RET],
      hostSaying(99),
    );

    machine.run(0);

    expect(machine.variables[2]).toBe(0);
  });

  it('inverts for IF_OBJECT_NOT_HERE', () => {
    const machine = machineOf(
      [...op('IF_OBJECT_NOT_HERE'), ...word(12), ...op('SET_VAR'), ...word(2), ...word(1), ...RET],
      hostSaying(12),
    );

    machine.run(0);

    // The object *is* here, so "not here" fails and the next line is skipped.
    expect(machine.variables[2]).toBe(0);
  });
});

describe('sound, boxes and window images reach the host', () => {
  it('passes a PLAY_EFFECT through and does not report it unimplemented', () => {
    const host = new RecordingVgaHost();
    const machine = machineOf([...op('PLAY_EFFECT'), ...word(6), ...RET], host);

    machine.run(0);

    expect(host.record.effectsPlayed).toBe(1);
    expect(machine.report.unimplemented).not.toContain('PLAY_EFFECT');
  });

  it('enables and moves hit areas by number', () => {
    const host = new RecordingVgaHost();
    const machine = machineOf(
      [
        ...op('ENABLE_BOX'),
        ...word(4),
        ...op('MOVE_BOX'),
        ...word(4),
        ...word(10),
        ...word(20),
        ...RET,
      ],
      host,
    );

    machine.run(0);

    expect(host.record.boxesEnabled).toEqual([4]);
    expect(host.record.boxesMoved).toEqual([4]);
  });

  it('reads SET_WINDOW_IMAGE image-then-window, in the order the operands arrive', () => {
    // The operands are image first and window second, and getting them the
    // wrong way round puts a room's backdrop in the inventory panel — which is
    // wrong in a way that still draws something, so it needs a test.
    const seen: [number, number][] = [];
    const host = new RecordingVgaHost();
    const machine = machineOf(
      [...op('SET_WINDOW_IMAGE'), ...word(77), ...word(3), ...RET],
      Object.assign(host, {
        setWindowImage: (windowNumber: number, image: number) => seen.push([windowNumber, image]),
      }),
    );

    machine.run(0);

    expect(seen).toEqual([[3, 77]]);
  });
});

describe('NEW_SPRITE in Simon 1 derives its zone from the id', () => {
  /**
   * The falsifier for Fault 2's fix. Simon 1's `NEW_SPRITE` is `ddddd` and
   * carries no zone — its sprite ids are global, so the zone is the id's own
   * hundreds column. Sprite 13402 lives in zone 134, and that must survive the
   * change that gave Simon 2 an explicit zone operand.
   */
  it('passes the id hundreds column as the zone where the shape has none', () => {
    const started: { zone: number; id: number }[] = [];
    const host = Object.assign(new RecordingVgaHost(), {
      startSpriteInZone: (zone: number, id: number) => {
        started.push({ zone, id });
        return true;
      },
    });
    // ddddd: an unused word, id, x, y, palette.
    const machine = machineOf(
      [
        ...op('NEW_SPRITE'),
        ...word(0),
        ...word(13402),
        ...word(10),
        ...word(20),
        ...word(2),
        ...RET,
      ],
      host,
    );

    machine.run(0);

    expect(started).toEqual([{ zone: 134, id: 13402 }]);
  });
});

describe('the fades that are dummies, and the ones that are not', () => {
  it('counts FADEIN and FADEOUT as dummies rather than as work outstanding', () => {
    // These consume six bytes and do nothing in every Version this family
    // runs — a real fade exists only in Personal Nightmare's day/night mode,
    // which is a different engine. So they belong with the DUMMY_* slots, and
    // leaving them in `unimplemented` would read as a gap nobody can ever
    // close.
    const machine = machineOf([
      ...op('FADEOUT'),
      ...word(0),
      ...word(0),
      ...word(0),
      ...op('FADEIN'),
      ...word(0),
      ...word(0),
      ...word(0),
      ...RET,
    ]);

    machine.run(0);

    expect(machine.report.unimplemented).not.toContain('FADEIN');
    expect(machine.report.unimplemented).not.toContain('FADEOUT');
    expect(machine.dummiesRun).toBe(2);
    // And the fades that really do fade are still counted, not performed.
    expect(machine.fadesRequested).toBe(0);
  });
});

describe('RESET abandons everything currently animating', () => {
  it('clears the sprite table, because a departed script raises no sync', () => {
    const machine = machineOf([...op('RESET'), ...RET]);
    machine.sprites.push(spriteAt(), spriteAt());

    machine.run(0);

    expect(machine.sprites).toHaveLength(0);
    expect(machine.resetsRun).toBe(1);
  });
});

describe('STOP_ANIMATE halts the sprite it names, not the one running', () => {
  it('leaves other sprites running', () => {
    const machine = machineOf([...op('STOP_ANIMATE'), ...word(2), ...RET]);
    const one = spriteAt();
    const two = { ...spriteAt(), id: 2 };
    machine.sprites.push(one, two);

    machine.run(0, one);

    expect(two.halted).toBe(true);
    expect(one.halted).toBe(false);
  });
});

describe('SET_PRIORITY reads its one operand', () => {
  // The bug this guards: `vc23` is a one-operand opcode (`d`), and reading
  // `operand(1)` — the second operand that does not exist — resolved to zero,
  // so every sprite ended at priority zero and z-ordering never happened.
  it('writes the priority the script gave, not zero', () => {
    const machine = machineOf([...op('SET_PRIORITY'), ...word(5), ...RET]);
    const sprite = spriteAt();
    machine.sprites.push(sprite);

    machine.run(0, sprite);

    expect(sprite.priority).toBe(5);
  });

  it('gives two sprites distinct priorities so the sort can order them', () => {
    // With the old bug both would end at zero and never sort apart.
    const first = { ...spriteAt(), id: 1, priority: 2 };
    const second = { ...spriteAt(), id: 2 };
    const machine = machineOf([...op('SET_PRIORITY'), ...word(7), ...RET]);
    machine.sprites.push(first, second);

    machine.run(0, second);

    expect(second.priority).toBe(7);
    expect(first.priority).toBe(2);
  });
});

/**
 * The order sprites run in, which is the order they *fell due* and not the
 * order they sit in the display list.
 *
 * Simon's walk is the case that cares. The turn animation creates the standing
 * figure and then raises the sync the walk controller is parked on; the
 * controller's next instruction raises the sync that takes the standing figure
 * away again. The reference appends both to one event list, so the figure
 * reaches its `WAIT_SYNC` before the controller's sync is raised and the sync
 * finds it. Running the display list in index order instead ran the controller
 * first — its sync fell on a sprite that had not waited yet, and a second Simon
 * stood at the start of the walk for the rest of the room.
 */
describe('a frame runs its sprites in the order they fell due', () => {
  /** A host whose animation table maps one sprite id to one script offset. */
  function hostWithAnimation(id: number, scriptOffset: number): VgaHost {
    const base = new RecordingVgaHost();
    return Object.assign(Object.create(Object.getPrototypeOf(base) as object) as VgaHost, base, {
      animationScriptOffset: (asked: number) => (asked === id ? scriptOffset : null),
    });
  }

  it('runs a sprite a script created before a sprite the same script woke', () => {
    // Three scripts in one resource, at the offsets the sprites below name.
    const controller = [...op('WAIT_SYNC'), ...word(20), ...op('SYNC'), ...word(10), ...RET];
    const turn = [
      ...op('NEW_SPRITE'),
      ...word(4),
      ...word(200),
      ...word(0),
      ...word(0),
      ...word(0),
      ...op('SYNC'),
      ...word(20),
      ...RET,
    ];
    // The created sprite: it waits for 10, and setting the variable is how the
    // test sees that the wait ended rather than hung.
    const stand = [
      ...op('WAIT_SYNC'),
      ...word(10),
      ...op('SET_VAR'),
      ...word(3),
      ...word(1),
      ...RET,
    ];
    const standAt = controller.length + turn.length;
    const machine = machineOf([...controller, ...turn, ...stand], hostWithAnimation(200, standAt));

    // The controller is *first* in the display list, which is what used to
    // decide the order, and the turn is second.
    const first = { ...spriteAt(0), id: 1 };
    const second = { ...spriteAt(controller.length), id: 2 };
    machine.sprites.push(first, second);
    machine.run(0, first);
    machine.run(controller.length, second);

    // One frame is enough: the turn's sync wakes the controller, the sprite it
    // created runs first because it was created first, and the controller's own
    // sync then finds it waiting.
    machine.tick();

    expect(machine.variables[3]).toBe(1);
  });
});
