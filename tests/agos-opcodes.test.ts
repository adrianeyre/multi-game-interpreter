import { describe, expect, it } from 'vitest';
import {
  AgosInterpreter,
  AgosState,
  type AgosGraphicsHooks,
} from '../src/engine/agos/script/AgosInterpreter.js';
import { readGamePc } from '../src/engine/agos/resource/gamePc.js';
import { Pathfinder } from '../src/engine/agos/world/pathfinder.js';
import { OPCODE_NAMES } from '../src/engine/agos/script/opcodeNames.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import type {
  AgosInstruction,
  AgosSubroutine,
  AgosSubroutineBlock,
} from '../src/engine/agos/script/subroutines.js';
import { buildGamePc, buildGamePcFor } from './fixtureAgos.js';

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

/** `op('o_goto', item(4))` reads the way the listing does. */
function op(name: string, ...operands: AgosInstruction['operands']): AgosInstruction {
  return { opcode: opcodeFor(name), operands };
}

function item(id: number): AgosInstruction['operands'][number] {
  return { kind: 'item', lead: 0, id: id - 2 };
}

function byte(value: number): AgosInstruction['operands'][number] {
  return { kind: 'byte', value };
}

function word(value: number): AgosInstruction['operands'][number] {
  return { kind: 'word', value };
}

function blockOf(...subroutines: AgosSubroutine[]): AgosSubroutineBlock {
  return { subroutines, endMarker: 0xffff };
}

function subroutine(id: number, instructions: AgosInstruction[]): AgosSubroutine {
  return { id, lines: [{ instructions }], endMarker: 0xffff };
}

function run(
  instructions: AgosInstruction[],
  graphicsOrExtra: AgosGraphicsHooks | AgosSubroutine[] = [],
  extra: AgosSubroutine[] = [],
) {
  // Two shapes because most of these opcodes need no screen and a few need one
  // hook off it: an array is the extra Subroutines, an object is the hooks.
  const graphics = Array.isArray(graphicsOrExtra) ? undefined : graphicsOrExtra;
  const others = Array.isArray(graphicsOrExtra) ? graphicsOrExtra : extra;
  const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
  const state = new AgosState(game.items);
  const interpreter = new AgosInterpreter(
    blockOf(subroutine(1, instructions), ...others),
    state,
    SIMON1,
    graphics,
    game.strings,
  );
  interpreter.run(1);
  return { state, report: interpreter.report };
}

describe('walking the tree', () => {
  /**
   * AGOS has no expressions. A script walks the tree by *setting* one of two
   * registers and then acting on whichever it set; the byte operand chooses
   * which, and 1 means the subject. Nothing else in the family is
   * register-shaped.
   */
  it('reads a parent into the subject register', () => {
    const { state } = run([op('o_getParent', item(3), byte(1))]);

    expect(state.subjectItem).toBe(2);
    expect(state.objectItem).toBe(0);
  });

  it('reads a child into the object register when the operand is not 1', () => {
    const { state } = run([op('o_getChildren', item(2), byte(0))]);

    expect(state.objectItem).toBe(3);
  });

  it('reads a sibling, and answers nothing where the chain ends', () => {
    const { state } = run([op('o_getNext', item(3), byte(1))]);

    expect(state.subjectItem).toBe(0);
  });
});

describe('moving the player and the world', () => {
  it('sends the player to an item, which is what a game does most', () => {
    const { state } = run([op('o_goto', item(3))]);

    expect(state.parentOf(state.me)).toBe(3);
  });

  it('puts one item where another one is', () => {
    const { state } = run([op('o_goto', item(3)), op('o_putBy', item(2), item(3))]);

    expect(state.parentOf(2)).toBe(state.parentOf(3));
  });

  it('asks whether the player is where an item is', () => {
    const { state } = run([
      op('o_goto', item(3)),
      op('o_here', item(2)),
      op('o_let', byte(9), word(1)),
    ]);

    // The condition failed — item 2's parent is not the player's — so the line
    // stopped before the assignment.
    expect(state.read(9)).toBe(0);
  });
});

describe('an item’s state', () => {
  it('clamps rather than wraps, so a counter that overran does not look reset', () => {
    const { state } = run([op('o_setState', item(2), word(40_000))]);

    expect(state.items[2]!.state).toBe(30_000);
  });

  it('counts up and down', () => {
    const { state } = run([op('o_inc', item(2)), op('o_inc', item(2)), op('o_dec', item(2))]);

    expect(state.items[2]!.state).toBe(1);
  });
});

describe('one Subroutine calling another', () => {
  it('runs it, and the caller carries on', () => {
    const { state } = run(
      [op('o_process', word(7)), op('o_let', byte(4), word(2))],
      [subroutine(7, [op('o_let', byte(3), word(1))])],
    );

    expect(state.read(3)).toBe(1);
    expect(state.read(4)).toBe(2);
  });

  it('stops a script that calls itself rather than exhausting the stack', () => {
    const { report } = run([op('o_process', word(1))]);

    expect(report.unimplemented.join(' ')).toContain('recursion past 40');
  });
});

describe('bits, which Elvira 2 onwards uses where Simon uses variables', () => {
  it('sets, clears and tests one', () => {
    const { state } = run([
      op('oe2_bSet', byte(5)),
      op('oe2_bNotZero', byte(5)),
      op('o_let', byte(1), word(8)),
    ]);

    expect(state.bits.has(5)).toBe(true);
    expect(state.read(1)).toBe(8);
  });

  it('stops a line where the bit it tests is clear', () => {
    const { state } = run([op('oe2_bNotZero', byte(6)), op('o_let', byte(1), word(8))]);

    expect(state.read(1)).toBe(0);
  });
});

describe('ending the game', () => {
  it('records that a script asked to quit rather than throwing', () => {
    const { state } = run([op('o_end', { kind: 'string', lead: 0 })]);

    expect(state.quit).toBe(true);
  });
});

describe('an object’s flags', () => {
  /**
   * They live on the item's object sub-structure rather than beside its class
   * flags, and the mask doubles as the flags: its low sixteen bits say which
   * values the record holds, its high bits are ordinary flags a script sets.
   * That is why only bits 16 and up may be written — writing a low one would
   * change how many values the record has without moving any of them.
   */
  it('sets and reads a flag above the sizing bits', () => {
    const { state } = run([
      op('o_oset', item(3), byte(20)),
      op('o_oflag', item(3), byte(20)),
      op('o_let', byte(2), word(5)),
    ]);

    expect(state.objectFlag(3, 20)).toBe(true);
    expect(state.read(2)).toBe(5);
  });

  it('refuses to write a sizing bit', () => {
    const { state } = run([op('o_oset', item(3), byte(3))]);

    // Bit 3 is part of the mask that says how long the record is. Setting it
    // would claim a value the record does not hold.
    expect(state.objectFlag(3, 3)).toBe(false);
  });

  it('clears one', () => {
    const { state } = run([op('o_oset', item(3), byte(18)), op('o_oclear', item(3), byte(18))]);

    expect(state.objectFlag(3, 18)).toBe(false);
  });
});

describe('the two registers, written directly', () => {
  it('sets the subject and answers whether it is set', () => {
    const { state } = run([
      op('o_setDollar', byte(1), item(3)),
      op('o_if1'),
      op('o_let', byte(7), word(3)),
    ]);

    expect(state.subjectItem).toBe(3);
    expect(state.read(7)).toBe(3);
  });

  it('stops a line asking for an object that was never set', () => {
    const { state } = run([op('o_if2'), op('o_let', byte(7), word(3))]);

    expect(state.read(7)).toBe(0);
  });

  it('copies an item’s state into a variable', () => {
    const { state } = run([op('o_setState', item(2), word(6)), op('o_copysf', item(2), byte(11))]);

    expect(state.read(11)).toBe(6);
  });
});

describe('text windows', () => {
  it('records a window a script defines and the one it selects', () => {
    const { state } = run([
      op('o_defWindow', byte(2), word(10), word(20), word(30), word(40), word(25), word(236)),
      op('o_window', byte(2)),
    ]);

    // Nothing draws them yet. Recorded rather than ignored, because a script
    // that opens a window and gets no error is telling the truth about what it
    // asked for — including the last two operands, the flags and the fill
    // colour, which the icon bar paints its panel with.
    expect(state.windows.get(2)).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      flags: 25,
      fillColour: 236,
    });
    expect(state.currentWindow).toBe(2);
  });

  it('clears the screen’s text and keeps the transcript', () => {
    const { state } = run([op('o_msg', { kind: 'string', lead: 1, id: 1 }), op('o_cls')]);

    // Two lists on purpose. `o_cls` is a game clearing its display, not a game
    // unsaying what it said — and a stall report wants the second. Drawing the
    // transcript is what stacked four scenes' dialogue on Simon 1's intro.
    expect(state.onScreen).toEqual([]);
    expect(state.messages).toHaveLength(1);
  });
});

describe('item slots and object values', () => {
  it('stores an item in a slot and reads it back into a register', () => {
    const { state } = run([
      op('oe2_storeItem', byte(4), item(3)),
      op('oe2_getItem', byte(4), byte(1)),
    ]);

    expect(state.itemSlots.get(4)).toBe(3);
    expect(state.subjectItem).toBe(3);
  });

  it('counts bits to find an object value, not indexes', () => {
    // The fixture's object has one value, and its mask has bit 1 set — so
    // "value 1" is that one, and value 0 is nothing. Indexing directly would
    // return the wrong field on any object with a gap in its mask.
    const { state } = run([op('oe2_setOValue', item(3), byte(1), word(77))]);

    expect(state.objectValue(3, 1)).toBe(77);
    expect(state.objectValue(3, 0)).toBe(0);
  });

  it('reads an object value into a variable', () => {
    const { state } = run([
      op('oe2_setOValue', item(3), byte(1), word(12)),
      op('oe2_getOValue', item(3), byte(1), byte(6)),
    ]);

    expect(state.read(6)).toBe(12);
  });
});

describe('the words a click was made of', () => {
  it('sets the adjective and noun the verb table will match against', () => {
    const { state } = run([op('o_setAdjNoun', byte(1), word(30), word(40))]);

    expect(state.adjective1).toBe(30);
    expect(state.noun1).toBe(40);
  });

  it('sets the second pair when the operand is not 1', () => {
    const { state } = run([op('o_setAdjNoun', byte(0), word(5), word(6))]);

    expect(state.noun2).toBe(6);
    expect(state.noun1).toBe(0);
  });
});

describe('what a script says it is doing', () => {
  it('records that animation was halted and restarted', () => {
    const halted = run([op('o_haltAnimation')]);
    expect(halted.state.animationHalted).toBe(true);

    const restarted = run([op('o_haltAnimation'), op('o_restartAnimation')]);
    expect(restarted.state.animationHalted).toBe(false);
  });

  it('drops a comment rather than showing it', () => {
    // The reference consumes the operand and drops it. A comment that reached
    // the screen would be a change in what the game says, not a fix.
    const { state } = run([op('o_comment', { kind: 'string', lead: 1, id: 0 })]);

    expect(state.messages).toEqual([]);
  });
});

describe('arithmetic whose second operand is a variable', () => {
  /**
   * Missing these made a game divide by the *index* of a divisor rather than
   * by the divisor — a wrong answer that looks like arithmetic working.
   */
  it('multiplies and divides by a variable’s contents', () => {
    const { state } = run([
      op('o_let', byte(1), word(20)),
      op('o_let', byte(2), word(4)),
      op('o_divf', byte(1), byte(2)),
    ]);

    expect(state.read(1)).toBe(5);
  });

  it('refuses to divide by zero rather than producing an infinity', () => {
    expect(() => run([op('o_let', byte(1), word(9)), op('o_divf', byte(1), byte(2))])).toThrow(
      /division by zero/,
    );
  });
});

describe('Elvira 2’s second bank of bits', () => {
  it('is a separate set rather than a higher range of the first', () => {
    const { state } = run([op('oe2_bSet', byte(3)), op('oe2_b2Set', byte(3))]);

    // A game using both would collide if the second were an offset into the
    // first.
    expect(state.bits.has(3)).toBe(true);
    expect(state.bits2.has(3)).toBe(true);
    expect(state.bits.size).toBe(1);
    expect(state.bits2.size).toBe(1);
  });
});

describe('zones and the pointer', () => {
  it('records a zone a script unloads and a freeze around it', () => {
    const { state } = run([op('os1_unloadZone', word(4)), op('o_freezeZones')]);

    expect(state.unloadedZones.has(4)).toBe(true);
    expect(state.zonesFrozen).toBe(true);
  });

  it('hides the pointer while a script draws, and shows it again', () => {
    const hidden = run([op('os1_mouseOff')]);
    expect(hidden.state.pointerVisible).toBe(false);

    const shown = run([op('os1_mouseOff'), op('os1_mouseOn')]);
    expect(shown.state.pointerVisible).toBe(true);
  });
});

describe('asking whether an item is the thing that was clicked', () => {
  it('compares an item’s own adjective and noun against the click', () => {
    const { state } = run([
      // The fixture's item 2 has adjective 11 and noun 12.
      op('oe2_isAdjNoun', item(2), word(11), word(12)),
      op('o_let', byte(5), word(1)),
    ]);

    expect(state.read(5)).toBe(1);
  });

  it('stops the line when they do not match', () => {
    const { state } = run([
      op('oe2_isAdjNoun', item(2), word(99), word(99)),
      op('o_let', byte(5), word(1)),
    ]);

    expect(state.read(5)).toBe(0);
  });
});

describe('the inventory is a list before it is a picture', () => {
  /**
   * `o_doIcons` names a container and a window; the icons are the items in
   * that container, optionally filtered by class. Building the list is data
   * work and belongs in the interpreter — drawing it is the renderer's, and
   * the list is what the renderer needs either way.
   */
  it('records the container and window a script asked to show', () => {
    const { state } = run([op('o_doIcons', item(2), byte(3))]);

    expect(state.icons).toEqual({ container: 2, window: 3, classMask: 0 });
  });

  it('turns a class *bit* into a mask for everything after Elvira 1', () => {
    const { state } = run([op('o_doClassIcons', item(2), byte(1), byte(4))]);

    // Elvira 1 passes the mask itself; Simon passes the bit number.
    expect(state.icons?.classMask).toBe(1 << 4);
  });
});

describe('text boxes, colour and the pause', () => {
  it('records where a line of dialogue was placed', () => {
    const { state } = run([op('os1_screenTextBox', byte(1), word(20), byte(30), word(100))]);

    expect(state.textBoxes).toEqual([{ x: 20, y: 30, width: 100 }]);
  });

  it('records the ink colour and a pause', () => {
    const { state } = run([op('oe2_ink', byte(7)), op('os1_pauseGame')]);

    expect(state.textColour).toBe(7);
    expect(state.paused).toBe(true);
  });
});

describe('Simon’s beard, and which voices are loaded', () => {
  it('is a flag here and a graphics swap there', () => {
    const worn = run([op('os1_loadBeard')]);
    expect(worn.state.beardLoaded).toBe(true);

    const removed = run([op('os1_loadBeard'), op('os1_unloadBeard')]);
    expect(removed.state.beardLoaded).toBe(false);
  });

  it('selects which speech and effects files the game reads from', () => {
    const { state } = run([op('os1_loadStrings', word(3))]);

    expect(state.soundFileId).toBe(3);
  });
});

describe('walking, which is a lookup over authored routes', () => {
  it('answers which route and which point on it, not where the player clicked', () => {
    // Two routes, so "which one" is a real question. The nearest point to
    // (40, 60) is the second route's second point, once the reference's twelve
    // pixel offset and its horizontal weighting are applied.
    const pathfinder = new Pathfinder();
    pathfinder.set(1, [
      [200, 100],
      [210, 100],
    ]);
    pathfinder.set(2, [
      [10, 72],
      [42, 72],
    ]);

    const { state, report } = run([op('os1_getPathPosn', word(40), word(60), byte(8), byte(9))], {
      // The two required hooks, which this opcode never reaches.
      loadZone: () => false,
      animate: () => false,
      nearestRoutePoint: (x, y, previous) => pathfinder.nearest(x, y, previous),
    });

    // A route number and an index into it. The script walks from there itself,
    // which is why handing it a pair of screen coordinates — as this used to —
    // sent Simon to point 60 of route 40.
    expect(state.read(8)).toBe(2);
    expect(state.read(9)).toBe(1);
    expect(report.unimplemented).toEqual([]);
  });

  it('says so by name when no script has drawn a route yet', () => {
    const { report } = run([op('os1_getPathPosn', word(40), word(60), byte(8), byte(9))]);

    expect(report.unimplemented.join(' ')).toContain('no routes have been drawn yet');
  });
});

describe('asking the shell to save', () => {
  it('reports a save nobody can perform rather than pretending it happened', () => {
    const { report } = run([op('o_saveUserGame')]);

    expect(report.unimplemented.join(' ')).toContain('no save store attached');
  });
});

describe('the questions Elvira asks in fewer words', () => {
  /**
   * The same questions Simon asks, spelled differently and numbered
   * differently — `oe1_isIn` is not in Simon 1's table at all. Sharing the
   * implementations rather than the numbers is the whole point of dispatching
   * by name, and this is the test that proves it across two Versions.
   */
  const ELVIRA1: AgosTarget = {
    family: 'AGOS',
    version: 'Elvira1',
    releaseKind: 'floppy',
    platform: 'dos',
  };

  function elviraOpcode(name: string): number {
    const index = OPCODE_NAMES.elvira1!.indexOf(name);
    if (index < 0) throw new Error(`Elvira 1 has no opcode called ${name}`);
    return index;
  }

  it('dispatches an Elvira-only opcode by name', () => {
    const game = readGamePc(buildGamePcFor(ELVIRA1), ELVIRA1);
    const state = new AgosState(game.items);
    const interpreter = new AgosInterpreter(
      blockOf(
        subroutine(1, [
          { opcode: elviraOpcode('oe1_isPlayer'), operands: [{ kind: 'item', lead: 0, id: 0 }] },
        ]),
      ),
      state,
      ELVIRA1,
    );

    interpreter.run(1);

    // Item 2 is not the player, so the condition failed and nothing was
    // reported as unimplemented — the opcode ran.
    expect(interpreter.report.unimplemented).toEqual([]);
    expect(interpreter.report.linesStopped).toBe(1);
  });
});

describe('what the tree questions are made of', () => {
  it('asks whether one item is inside another at any depth', () => {
    const { state } = run([]);

    // Item 3's parent is item 2 in the fixture.
    expect(state.contains(2, 3)).toBe(true);
    expect(state.contains(3, 2)).toBe(false);
  });

  it('stops walking a tree with a cycle rather than looping for ever', () => {
    const { state } = run([op('o_place', item(2), item(3))]);

    // 2 inside 3 and 3 inside 2 is a corrupt game, and the question still
    // answers rather than hanging.
    expect(state.contains(2, 3)).toBe(true);
    expect(state.contains(99, 3)).toBe(false);
  });

  it('answers zero for a user flag on an item that has no such record', () => {
    const { state } = run([]);

    // The honest answer rather than an invented one: the fixture's items carry
    // no user-flag sub-structure.
    expect(state.userFlag(2, 1)).toBe(0);
  });

  it('finds the item a pair of clicked words names', () => {
    const { state } = run([]);

    // The fixture's item 2 carries adjective 11 and noun 12.
    expect(state.findByWords(11, 12)).toBe(2);
    expect(state.findByWords(99, 99)).toBe(0);
  });
});

describe('doors, which live in the mask that sized the exits', () => {
  /**
   * The same word does both jobs: which exits a room has, and what state each
   * one is in, two bits apiece. That is why a script cannot *add* a door — the
   * mask would have to grow and the record with it.
   */
  it('sets and reads the three states', () => {
    const { state } = run([]);

    state.setDoorState(2, 0, 1);
    expect(state.doorState(2, 0)).toBe(1);

    state.setDoorState(2, 0, 3);
    expect(state.doorState(2, 0)).toBe(3);
  });

  it('leaves the other directions alone', () => {
    const { state } = run([]);

    state.setDoorState(2, 0, 1);
    state.setDoorState(2, 2, 2);

    expect(state.doorState(2, 0)).toBe(1);
    expect(state.doorState(2, 2)).toBe(2);
    expect(state.doorState(2, 1)).toBe(0);
  });

  it('counts set exits to find where one leads, rather than indexing', () => {
    const { state } = run([]);

    // The fixture's room has exit 0 set, and its destination is the first
    // value. A room with a gap in its mask would return the wrong destination
    // if this indexed directly.
    expect(state.exitOf(2, 0)).toBe(3);
    expect(state.exitOf(2, 4)).toBe(0);
  });
});

describe('Elvira’s clock', () => {
  it('measures against a mark a script sets', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
    const state = new AgosState(game.items);
    state.clock = 10;
    state.timeMark = state.clock;
    state.clock = 25;

    // "Has fifteen seconds passed since the mark?" — yes at 25, no at 20.
    expect(state.clock - 15 >= state.timeMark).toBe(true);
    expect(state.clock - 20 >= state.timeMark).toBe(false);
  });
});

describe('finding the next thing the words name', () => {
  /**
   * How "the red key" reaches the *second* red key: a script asks for the next
   * match rather than re-asking for the first and getting it again.
   */
  it('starts a search and steps past the item it already found', () => {
    const { state } = run([]);

    expect(state.findByWords(11, 12)).toBe(2);
    // Searching again from past that item finds nothing else in the fixture,
    // which is the honest answer rather than the same item twice.
    expect(state.findByWords(11, 12, 3)).toBe(0);
  });
});

describe('worn is carried and flagged, not flagged alone', () => {
  it('says an item on the floor is not worn even with the flag set', () => {
    const { state } = run([]);

    state.setObjectFlag(3, 24, true);
    state.place(3, 2);

    // The flag survives being dropped; being worn does not.
    expect(state.objectFlag(3, 24)).toBe(true);
    expect(state.parentOf(3)).not.toBe(state.item1);
  });
});

/**
 * A room's scenery is not in the item tree.
 *
 * Simon 1 and Waxworks describe what is in a room with three opcodes:
 * `oww_setShortText` names a slot, `oww_setLongText` describes it, and
 * `oww_addTextBox` puts a **hit area** on screen carrying that slot's number.
 * The reference's own comment on the third is `// 65: add hit area`.
 */
describe('the room’s clickable things', () => {
  it('adds a hit area rather than recording a text box', () => {
    const { state } = run([
      op('oww_addTextBox', word(11), word(117), word(88), word(26), word(5), byte(0)),
    ]);

    // Filed with the text-box recorders on the strength of its name, every
    // room's objects went into a list nothing read: the wizard's study has six
    // and not one could be pointed at.
    const area = state.hitAreas.all().find((each) => each.id === 11);
    expect(area).toMatchObject({ x: 117, y: 88, width: 26, height: 5, enabled: true });
    expect(state.textBoxes).toEqual([]);
  });

  it('records a slot’s name and description rather than saying them', () => {
    const { state } = run([
      op('oww_setShortText', byte(0), { kind: 'string', lead: 1, id: 1 }),
      op('oww_setLongText', byte(0), { kind: 'string', lead: 1, id: 2 }, word(811)),
    ]);

    expect(state.shortText.get(0)).toBe(1);
    expect(state.longText.get(0)).toEqual({ string: 2, speech: 811 });
    // Neither is a line the game has said. Showing them put a room's scenery
    // descriptions on its status line as if a character had spoken them.
    expect(state.onScreen).toEqual([]);
    expect(state.messages).toEqual([]);
  });
});

/**
 * The player item the file does not contain.
 *
 * Item 1 is built at load — `createPlayer` in the reference — and its two
 * identifying fields are matched against by the verb table, so their values
 * are not free.
 */
describe('the player', () => {
  it('carries the adjective and noun the reference gives it', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
    const state = new AgosState(game.items);

    // −1 and 10000, not zeroes. A guard naming the player names 10000, so a
    // player built with zeroes is one no verb-table line can be written about.
    expect(state.items[1]).toMatchObject({ adjective: -1, noun: 10_000 });
  });
});

/**
 * A variable is compared **unsigned**, and stored signed.
 *
 * The reference keeps variables in an `int16` array and reads them back through
 * `getNextVarContents`, which casts to `uint16` — so a variable holding −1
 * compares equal to 65535. The *drawing* bytecode reads the same array signed
 * (`vcReadVar` casts to `int16`), which is why `VgaMachine` has its own
 * accessor.
 */
describe('a variable holding minus one', () => {
  it('compares equal to 65535, which is how the games spell it', () => {
    // `o_let 60, 65535` then `o_eq 60, 65535` is the commonest test in Simon 1's
    // verb dispatch — its walk handler uses it to mean "no object is selected".
    // Read signed, an `Int16Array` gives −1 and the test comes out false.
    const { state } = run([op('o_let', byte(60), word(65_535))]);

    expect(state.read(60)).toBe(65_535);
  });

  it('still wraps on the way in, because that is how it is stored', () => {
    const { state } = run([op('o_let', byte(5), word(65_535)), op('o_add', byte(5), word(2))]);

    // 65535 + 2 wraps to 1: the store is sixteen bits wide and the arithmetic
    // happens in it, exactly as the reference's `int16` array does.
    expect(state.read(5)).toBe(1);
  });
});
