import { describe, expect, it } from 'vitest';
import { readGamePc, writeGamePc } from '../src/engine/agos/resource/gamePc.js';
import {
  addString,
  deleteInstruction,
  editInstructionOperand,
  insertInstruction,
  editItemChildValue,
  editString,
  renameItem,
  reparentItem,
  setItemState,
} from '../src/authoring/agos/edits.js';
import { itemIdOf } from '../src/engine/agos/world/itemTree.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import { buildGamePc } from './fixtureAgos.js';

const SIMON1: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};

function load() {
  return readGamePc(buildGamePc({ withSpeech: true }), SIMON1);
}

/** Read an edited game back, which is the only proof the edit survives export. */
function roundTrip(game: ReturnType<typeof load>) {
  return readGamePc(writeGamePc(game, SIMON1), SIMON1);
}

describe('editing a pooled string', () => {
  it('changes it for every user, because that is what a pool means', () => {
    const edited = editString(load(), 1, 'a much longer replacement');

    expect(edited.strings[1]).toBe('a much longer replacement');
    expect(roundTrip(edited).strings).toEqual(['one', 'a much longer replacement', 'three']);
  });

  it('grows the header count when a string is added, or the reload loses it', () => {
    const { game, index } = addString(load(), 'new line');

    expect(index).toBe(3);
    expect(game.header.stringTableNum).toBe(4);
    expect(roundTrip(game).strings[3]).toBe('new line');
  });

  it('refuses an index the game does not have', () => {
    expect(() => editString(load(), 99, 'x')).toThrow(/no string 99/);
  });
});

describe('editing the item tree', () => {
  it('moves an item, and the move survives being written and read back', () => {
    const moved = reparentItem(load(), 3, 0);

    expect(itemIdOf(roundTrip(moved).items[1]!.parent)).toBe(0);
  });

  it('changes an item state', () => {
    expect(roundTrip(setItemState(load(), 2, 9)).items[0]!.state).toBe(9);
  });

  it('renames an item by pointing it at a new string, leaving the old one alone', () => {
    const before = load();
    const renamed = renameItem(before, 2, 'brass lamp');
    const after = roundTrip(renamed);

    expect(after.strings[after.items[0]!.noun]).toBe('brass lamp');
    // The string the item used to name is untouched, so anything else that
    // pointed at it still says what it said.
    expect(after.strings.slice(0, 3)).toEqual(before.strings.slice(0, 3));
  });

  it('refuses an item the game does not have', () => {
    expect(() => reparentItem(load(), 99, 0)).toThrow(/no item 99/);
  });
});

describe('an unedited game still writes back byte for byte', () => {
  it('leaves ADR 0029 gate intact after the edit functions exist', () => {
    const bytes = buildGamePc({ withSpeech: true });

    expect(writeGamePc(readGamePc(bytes, SIMON1), SIMON1)).toEqual(bytes);
  });
});

describe('editing an item’s typed sub-structure', () => {
  it('changes a value without changing the count that sized it', () => {
    const before = load();
    // Item 2 carries a room whose single exit was sized by counting two-bit
    // fields in its mask.
    const edited = editItemChildValue(before, 2, 1, 0, 7);
    const after = roundTrip(edited);

    expect(after.items[0]!.children[0]!.values).toEqual([7]);
    // The mask is untouched, because changing the count is a different
    // operation with different consequences for the file.
    expect(after.items[0]!.children[0]!.header).toEqual(before.items[0]!.children[0]!.header);
  });

  it('refuses a value index the sub-structure does not have', () => {
    expect(() => editItemChildValue(load(), 2, 1, 9, 0)).toThrow(/values, not 10/);
  });

  it('refuses a sub-structure the item does not carry', () => {
    expect(() => editItemChildValue(load(), 2, 8, 0, 0)).toThrow(/no sub-structure of type 8/);
  });
});

/**
 * Editing an instruction's operands.
 *
 * ADR 0029 stores instructions rather than source, so this is a change to a
 * value in a tree. What the tests are really about is **width**: an AGOS
 * operand's encoded size depends on what it carried on disk, and an edit that
 * changed the size would move every instruction after it while every jump
 * target stayed where it was. So each case here checks the value changed *and*
 * that reading the exported file back gives the same shape.
 */
describe('editing an instruction operand', () => {
  /** Subroutine 42, line 0: a plain byte, a variable byte, then a B and a T. */
  function instructionsOf(game: ReturnType<typeof load>, id: number) {
    const subroutine = game.subroutines.subroutines.find((each) => each.id === id);
    if (!subroutine) throw new Error(`no subroutine ${id} in the fixture`);
    return subroutine.lines[0]!.instructions;
  }

  it('changes a byte operand and survives the round trip', () => {
    const edited = editInstructionOperand(load(), 42, 0, 0, 0, 0x21);

    expect(instructionsOf(edited, 42)[0]!.operands[0]).toEqual({ kind: 'byte', value: 0x21 });
    expect(instructionsOf(roundTrip(edited), 42)[0]!.operands[0]).toEqual({
      kind: 'byte',
      value: 0x21,
    });
  });

  it('keeps a byte operand a variable reference rather than flattening it', () => {
    // The second instruction's operand arrived as 0xFF followed by a variable
    // number, which is two bytes where a plain byte is one. An edit that
    // dropped the `variable` field would shorten the instruction.
    const before = instructionsOf(load(), 42)[1]!.operands[0];
    expect(before).toMatchObject({ kind: 'byte', variable: 3 });

    const edited = editInstructionOperand(load(), 42, 0, 1, 0, 0xff);

    expect(instructionsOf(edited, 42)[1]!.operands[0]).toMatchObject({ variable: 3 });
    expect(instructionsOf(roundTrip(edited), 42)[1]!.operands[0]).toMatchObject({ variable: 3 });
  });

  it('edits the 32-bit id of a string operand that carried one', () => {
    // A `T` operand is one word alone and three with an id behind it. This one
    // arrived with an id, so the id is the field an edit changes — writing the
    // lead instead would change the width and strand the id.
    const edited = editInstructionOperand(load(), 42, 0, 2, 1, 0x0000_0200);

    expect(instructionsOf(edited, 42)[2]!.operands[1]).toEqual({
      kind: 'string',
      lead: 0x0001,
      id: 0x0000_0200,
    });
    expect(instructionsOf(roundTrip(edited), 42)[2]!.operands[1]).toEqual({
      kind: 'string',
      lead: 0x0001,
      id: 0x0000_0200,
    });
  });

  it('edits an item operand in the verb table, guard and all left alone', () => {
    const edited = editInstructionOperand(load(), 0, 0, 0, 0, 0x0000_0099);

    expect(instructionsOf(edited, 0)[0]!.operands[0]).toMatchObject({ id: 0x0000_0099 });
    // The guard is what makes a verb-table line reachable, and an operand edit
    // has no business touching it.
    const reread = roundTrip(edited).subroutines.subroutines.find((each) => each.id === 0)!;
    expect(reread.lines[0]!.guard).toEqual({ verb: 101, noun1: 202, noun2: 303 });
  });

  it('refuses a value too wide for the field, rather than truncating it', () => {
    // Truncation is the dangerous failure: it writes a value that fits, so
    // nothing downstream complains and the game quietly means something else.
    expect(() => editInstructionOperand(load(), 42, 0, 0, 0, 0x1_0000)).toThrow(
      /does not fit an 8-bit operand/,
    );
  });

  it('names what is missing when an index does not exist', () => {
    expect(() => editInstructionOperand(load(), 999, 0, 0, 0, 1)).toThrow(/no subroutine 999/);
    expect(() => editInstructionOperand(load(), 42, 9, 0, 0, 1)).toThrow(/not 10/);
    expect(() => editInstructionOperand(load(), 42, 0, 99, 0, 1)).toThrow(/not 100/);
    expect(() => editInstructionOperand(load(), 42, 0, 0, 9, 1)).toThrow(/not 10/);
  });
});

/**
 * Inserting and deleting instructions.
 *
 * These exist because the reason they did not was **wrong**. The operand editor
 * said the wider edit had to wait for jump renumbering, since moving an
 * instruction would strand every jump target after it. That is true of AGOS's
 * *VGA* bytecode, which has byte-measured jumps. It is not true of the game
 * bytecode: a line runs until one of its conditions fails, and `o_goto` — the
 * one opcode that reads like a jump — moves the *player* rather than the
 * program counter.
 *
 * So nothing refers to an instruction by offset and nothing needs renumbering.
 * What the round trips below actually prove is that: an instruction is added in
 * the middle of a line, and everything after it still reads back.
 */
describe('inserting and deleting instructions', () => {
  function lineOf(game: ReturnType<typeof load>, id: number) {
    const subroutine = game.subroutines.subroutines.find((each) => each.id === id);
    if (!subroutine) throw new Error(`no subroutine ${id}`);
    return subroutine.lines[0]!.instructions;
  }

  // Opcode 11 takes a single `B`, so a blank one is a byte of zero.
  const BYTE_OPCODE = 11;

  it('inserts an instruction and everything after it still reads back', () => {
    const before = lineOf(load(), 42);
    const edited = insertInstruction(load(), SIMON1, 42, 0, 1, BYTE_OPCODE);

    const after = lineOf(roundTrip(edited), 42);

    expect(after).toHaveLength(before.length + 1);
    expect(after[1]).toEqual({ opcode: BYTE_OPCODE, operands: [{ kind: 'byte', value: 0 }] });
    // The instruction that used to be second is now third, intact — which is
    // the whole claim: nothing needed renumbering.
    expect(after[2]).toEqual(before[1]);
  });

  it('gives an inserted instruction operands of the shapes its opcode takes', () => {
    // Opcode 1 takes an `I`, which is an item operand rather than a word — an
    // instruction given the wrong shapes re-emits as bytes the reader cannot
    // walk, and the round trip is what would catch it.
    const edited = insertInstruction(load(), SIMON1, 42, 0, 0, 1);

    expect(lineOf(edited, 42)[0]!.operands[0]).toMatchObject({ kind: 'item' });
    expect(lineOf(roundTrip(edited), 42)[0]!.operands[0]).toMatchObject({ kind: 'item' });
  });

  it('appends at the end of a line', () => {
    const before = lineOf(load(), 42);
    const edited = insertInstruction(load(), SIMON1, 42, 0, before.length, BYTE_OPCODE);

    expect(lineOf(roundTrip(edited), 42)).toHaveLength(before.length + 1);
  });

  it('deletes an instruction and leaves the rest readable', () => {
    const before = lineOf(load(), 42);
    const edited = deleteInstruction(load(), 42, 0, 0);

    const after = lineOf(roundTrip(edited), 42);

    expect(after).toHaveLength(before.length - 1);
    expect(after[0]).toEqual(before[1]);
  });

  it('leaves an empty line rather than removing the line itself', () => {
    // A line is what a verb-table guard points at, so dropping one would
    // silently unhook a verb.
    let game = load();
    const count = lineOf(game, 42).length;
    for (let index = 0; index < count; index += 1) game = deleteInstruction(game, 42, 0, 0);

    const subroutine = roundTrip(game).subroutines.subroutines.find((each) => each.id === 42);

    expect(subroutine?.lines).toHaveLength(1);
    expect(subroutine?.lines[0]!.instructions).toHaveLength(0);
  });

  it('refuses an opcode the Version does not have', () => {
    expect(() => insertInstruction(load(), SIMON1, 42, 0, 0, 250)).toThrow(/not in Simon1/);
  });

  it('names an out-of-range position rather than silently clamping', () => {
    expect(() => insertInstruction(load(), SIMON1, 42, 0, 99, BYTE_OPCODE)).toThrow(
      /cannot insert/,
    );
    expect(() => deleteInstruction(load(), 42, 0, 99)).toThrow(/no instruction 99/);
  });
});
