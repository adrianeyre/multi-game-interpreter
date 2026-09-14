import { describe, expect, it } from 'vitest';
import { HitAreaTable } from '../src/engine/agos/world/hitAreas.js';
import { AgosInterpreter, AgosState } from '../src/engine/agos/script/AgosInterpreter.js';
import { readGamePc } from '../src/engine/agos/resource/gamePc.js';
import { OPCODE_NAMES } from '../src/engine/agos/script/opcodeNames.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import type {
  AgosInstruction,
  AgosSubroutineBlock,
} from '../src/engine/agos/script/subroutines.js';
import { AgosInput } from '../src/engine/agos/AgosInput.js';
import { buildGamePc } from './fixtureAgos.js';

const SIMON1: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};

function opcodeFor(name: string): number {
  const index = OPCODE_NAMES.simon1!.indexOf(name);
  if (index < 0) throw new Error(`Simon 1 has no opcode called ${name}`);
  return index;
}

function blockOf(instructions: AgosInstruction[]): AgosSubroutineBlock {
  return {
    subroutines: [{ id: 1, lines: [{ instructions }], endMarker: 0xffff }],
    endMarker: 0xffff,
  };
}

describe('the interface is data, not layout', () => {
  /**
   * The finding that unblocked this: Simon's verb list, his inventory grid and
   * every clickable thing in a room are boxes the game's own Subroutines define
   * at runtime. Nothing in the engine knows where any of it is drawn.
   */
  it('lets a script define a box, and resolves a click to its verb and item', () => {
    const table = new HitAreaTable();
    table.add(101, 10, 20, 30, 40, 7, 55);

    expect(table.at(15, 25)).toMatchObject({ verb: 55, item: 7 });
    expect(table.at(9, 25)).toBeUndefined();
    expect(table.at(15, 61)).toBeUndefined();
  });

  it('reads the flags a box carries in the thousands digit of its id', () => {
    const table = new HitAreaTable();
    // 4101 is box 101 with the box-item flag set, which is how the games write it.
    const area = table.add(4101, 0, 0, 10, 10, 1, 2);

    expect(area.id).toBe(101);
    expect(area.flags).toBe(4);
  });

  it('skips a disabled box rather than forgetting it, because a script re-enables by id', () => {
    const table = new HitAreaTable();
    table.add(5, 0, 0, 10, 10, 1, 2);
    table.setEnabled(5, false);

    expect(table.at(5, 5)).toBeUndefined();
    expect(table.has(5)).toBe(true);

    table.setEnabled(5, true);
    expect(table.at(5, 5)).toBeDefined();
  });

  it('lets the highest-priority box win where two overlap, which is the greatest id', () => {
    const table = new HitAreaTable();
    table.add(1, 0, 0, 100, 100, 1, 10);
    table.add(2, 0, 0, 50, 50, 2, 20);

    // Box 2 sits inside box 1 and has the higher id, so a click in the overlap
    // is box 2; the part only box 1 covers is still box 1.
    expect(table.at(10, 10)?.verb).toBe(20);
    expect(table.at(70, 70)?.verb).toBe(10);
  });

  it('picks the higher-id box even when the lower one was defined later', () => {
    const table = new HitAreaTable();
    // The Simon 2 room: a scenery hotspot (id 10) and then the room-floor box
    // (id 0) that covers the whole screen, defined after it. Insertion order
    // would pick the floor and Simon would only ever walk; priority picks the
    // hotspot, which is the reference's `boxController`.
    table.add(10, 40, 40, 20, 20, 5, 208);
    table.add(0, 0, 0, 320, 135, 170, 201);

    expect(table.at(50, 50)?.id).toBe(10);
    expect(table.at(50, 50)?.verb).toBe(208);
    // Away from the hotspot, the floor is all there is.
    expect(table.at(200, 100)?.id).toBe(0);
  });
});

describe('the box opcodes', () => {
  function run(instructions: AgosInstruction[]): AgosState {
    const state = new AgosState(readGamePc(buildGamePc({ withSpeech: true }), SIMON1).items);
    new AgosInterpreter(blockOf(instructions), state, SIMON1).run(1);
    return state;
  }

  it('builds the interface from the running game rather than from the engine', () => {
    const state = run([
      {
        opcode: opcodeFor('o_addBox'),
        operands: [
          { kind: 'word', value: 12 },
          { kind: 'word', value: 4 },
          { kind: 'word', value: 8 },
          { kind: 'word', value: 20 },
          { kind: 'word', value: 10 },
          { kind: 'item', lead: 0, id: 1 },
          { kind: 'word', value: 33 },
        ],
      },
    ]);

    expect(state.hitAreas.size).toBe(1);
    expect(state.hitAreas.at(5, 9)).toMatchObject({ verb: 33 });
  });

  it('removes a box when the script deletes it', () => {
    const add: AgosInstruction = {
      opcode: opcodeFor('o_addBox'),
      operands: [
        { kind: 'word', value: 12 },
        { kind: 'word', value: 0 },
        { kind: 'word', value: 0 },
        { kind: 'word', value: 10 },
        { kind: 'word', value: 10 },
        { kind: 'item', lead: 0, id: 1 },
        { kind: 'word', value: 1 },
      ],
    };
    const state = run([
      add,
      { opcode: opcodeFor('o_delBox'), operands: [{ kind: 'word', value: 12 }] },
    ]);

    expect(state.hitAreas.size).toBe(0);
  });
});

describe('the interface works without a pointer', () => {
  /**
   * `docs/accessibility.md` treats a pointer-only interaction as a defect
   * rather than a limitation. AGOS makes the fix cheap for the same reason it
   * made hit-testing cheap: the interface is a list of boxes the game defined,
   * so "the next control" is well defined without anybody laying out a focus
   * order by hand.
   */
  function inputWith(boxes: { id: number; verb: number; item: number }[]) {
    const chosen: number[] = [];
    const input = new AgosInput({
      verb: (verb) => chosen.push(verb),
      click: () => {},
      key: () => {},
      rightClick: () => {},
    });
    return { input, chosen, cursor: { targets: boxes, index: 0 } };
  }

  it('moves through the boxes with the arrow keys and wraps around', () => {
    const { input, cursor } = inputWith([
      { id: 1, verb: 10, item: 0 },
      { id: 2, verb: 20, item: 0 },
    ]);

    expect(input.handleKey('ArrowDown', cursor)).toBe(true);
    expect(cursor.index).toBe(1);
    input.handleKey('ArrowDown', cursor);
    expect(cursor.index).toBe(0);
    input.handleKey('ArrowUp', cursor);
    expect(cursor.index).toBe(1);
  });

  it('activates the focused box with Enter, sending the verb the game gave it', () => {
    const { input, cursor, chosen } = inputWith([
      { id: 1, verb: 10, item: 0 },
      { id: 2, verb: 20, item: 0 },
    ]);
    input.handleKey('ArrowDown', cursor);

    expect(input.handleKey('Enter', cursor)).toBe(true);
    expect(chosen).toEqual([20]);
  });

  it('leaves keys it does not use to the game', () => {
    const { input, cursor } = inputWith([{ id: 1, verb: 10, item: 0 }]);

    expect(input.handleKey('q', cursor)).toBe(false);
  });
});
