import { describe, expect, it } from 'vitest';

import { buildSludgeFixture } from './fixtureSludge.js';
import { SludgeFormatError, readSludgeFile } from '../src/engine/sludge/resource/sludgeFile.js';
import {
  commandHistogram,
  disassemble,
  readAllSludgeFunctions,
  readSludgeFunction,
  unnamedCommands,
} from '../src/engine/sludge/script/sludgeFunction.js';
import {
  SLUDGE_COMMAND_COUNT,
  SLUDGE_COMMAND_NAMES,
  sludgeCommandName,
} from '../src/engine/sludge/script/commandNames.js';

const THREE_FUNCTIONS = {
  userFunctionNames: ['_globalInitFunction', 'init', 'onLeftClick'],
  functions: [
    {
      unfreezable: true,
      argumentCount: 0,
      localCount: 2,
      instructions: [
        { command: 41, parameter: 0 },
        { command: 17, parameter: 300 },
        { command: 41, parameter: 1 },
      ],
    },
    {
      argumentCount: 2,
      localCount: 5,
      instructions: [{ command: 20, parameter: 65535 }],
    },
    { instructions: [] },
  ],
};

describe('reading a compiled function', () => {
  it('reads the header and every instruction', () => {
    const bytes = buildSludgeFixture(THREE_FUNCTIONS);
    const file = readSludgeFile(bytes);
    const first = readSludgeFunction(bytes, file, 0);

    expect(first.name).toBe('_globalInitFunction');
    expect(first.unfreezable).toBe(true);
    expect(first.argumentCount).toBe(0);
    expect(first.localCount).toBe(2);
    expect(first.instructions).toEqual([
      { command: 41, parameter: 0 },
      { command: 17, parameter: 300 },
      { command: 41, parameter: 1 },
    ]);
    // Seven bytes of header, three per instruction.
    expect(first.byteLength).toBe(7 + 3 * 3);
  });

  it('reads a parameter at the top of its range', () => {
    const bytes = buildSludgeFixture(THREE_FUNCTIONS);
    const file = readSludgeFile(bytes);
    const second = readSludgeFunction(bytes, file, 1);

    expect([second.argumentCount, second.localCount]).toEqual([2, 5]);
    expect(second.instructions).toEqual([{ command: 20, parameter: 65535 }]);
  });

  it('reads a function with no instructions as empty rather than failing', () => {
    const bytes = buildSludgeFixture(THREE_FUNCTIONS);
    const file = readSludgeFile(bytes);
    const third = readSludgeFunction(bytes, file, 2);

    expect(third.instructions).toEqual([]);
    expect(third.byteLength).toBe(7);
  });

  it('reads every function the name table bounds, without overlapping', () => {
    const bytes = buildSludgeFixture(THREE_FUNCTIONS);
    const file = readSludgeFile(bytes);
    const functions = readAllSludgeFunctions(bytes, file);

    expect(functions.map((fn) => fn.name)).toEqual(['_globalInitFunction', 'init', 'onLeftClick']);
    const sorted = [...functions].sort((a, b) => a.offset - b.offset);
    for (let index = 1; index < sorted.length; index += 1) {
      const previous = sorted[index - 1] as { offset: number; byteLength: number };
      expect(previous.offset + previous.byteLength).toBeLessThanOrEqual(
        (sorted[index] as { offset: number }).offset,
      );
    }
  });
});

describe('what a fixed-width listing can and cannot get wrong', () => {
  it('refuses a header whose instruction count runs past the file', () => {
    // The one fault the encoding still allows. A variable-length encoding can
    // desynchronise on a wrong arity and SLUDGE cannot — every instruction is
    // three bytes — so an overstated count is what a header read at the wrong
    // offset looks like here.
    const bytes = buildSludgeFixture({
      userFunctionNames: ['runsOff'],
      functions: [
        { instructions: [{ command: 1, parameter: 2 }], overstateInstructionCount: 9999 },
      ],
    });
    const file = readSludgeFile(bytes);

    expect(() => readSludgeFunction(bytes, file, 0)).toThrow(SludgeFormatError);
    expect(() => readSludgeFunction(bytes, file, 0)).toThrow(/read at the wrong offset/);
  });

  it('refuses a function number the name table does not reach', () => {
    const bytes = buildSludgeFixture(THREE_FUNCTIONS);
    const file = readSludgeFile(bytes);

    expect(() => readSludgeFunction(bytes, file, 3)).toThrow(/outside this game's 3 functions/);
    expect(() => readSludgeFunction(bytes, file, -1)).toThrow(/outside this game's 3 functions/);
  });

  it('refuses every function in a game with no name table, and says why', () => {
    // Without names the Sub index has no stated extent, so a number past the
    // end would be read from wherever the arithmetic landed.
    const bytes = buildSludgeFixture({ userFunctionNames: [], functions: [] });
    const file = readSludgeFile(bytes);

    expect(file.userFunctionNames).toEqual([]);
    expect(() => readSludgeFunction(bytes, file, 0)).toThrow(/no function name table/);
    expect(readAllSludgeFunctions(bytes, file)).toEqual([]);
  });
});

describe('the command histogram', () => {
  it('counts every command across every function, commonest first', () => {
    const bytes = buildSludgeFixture(THREE_FUNCTIONS);
    const file = readSludgeFile(bytes);

    expect(commandHistogram(readAllSludgeFunctions(bytes, file))).toEqual([
      { command: 41, count: 2 },
      { command: 17, count: 1 },
      { command: 20, count: 1 },
    ]);
  });

  it('is empty for a game whose functions are all empty', () => {
    const bytes = buildSludgeFixture({
      userFunctionNames: ['a', 'b'],
      functions: [{ instructions: [] }, { instructions: [] }],
    });
    const file = readSludgeFile(bytes);
    expect(commandHistogram(readAllSludgeFunctions(bytes, file))).toEqual([]);
  });
});

describe('naming the commands', () => {
  it('names every number the generated table covers', () => {
    expect(SLUDGE_COMMAND_COUNT).toBe(SLUDGE_COMMAND_NAMES.length);
    for (let command = 0; command < SLUDGE_COMMAND_COUNT; command += 1) {
      expect(sludgeCommandName(command)).toMatch(/^[a-z][A-Za-z0-9]*$/);
    }
  });

  it('keeps the numbering the generator derived from declaration order', () => {
    // Spot-checks rather than a copy of the table: if these four move, the
    // generator read an enum whose order changed and every listing is wrong.
    // `return` at 1 is the load-bearing one — Above The Waves has 288 of them
    // across 217 functions, which is the check that validated the whole table.
    expect(sludgeCommandName(1)).toBe('return');
    expect(sludgeCommandName(2)).toBe('branch');
    expect(sludgeCommandName(20)).toBe('callit');
    expect(sludgeCommandName(41)).toBe('quickPush');
  });

  it('prints a number it has no name for rather than nothing', () => {
    expect(sludgeCommandName(SLUDGE_COMMAND_COUNT)).toBe(`<command ${SLUDGE_COMMAND_COUNT}>`);
    expect(sludgeCommandName(200)).toBe('<command 200>');
  });

  it('lists a function with an address and a name per line', () => {
    const bytes = buildSludgeFixture(THREE_FUNCTIONS);
    const file = readSludgeFile(bytes);
    const first = readSludgeFunction(bytes, file, 0);
    const lines = disassemble(first);

    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\s+\d+ {2}quickPush 0$/);
    expect(lines[1]).toMatch(/^\s+\d+ {2}loadValue 300$/);
    // Consecutive lines are three bytes apart, because every instruction is.
    const addresses = lines.map((line) => Number(line.trim().split(/\s+/)[0]));
    expect(addresses[1]! - addresses[0]!).toBe(3);
    expect(addresses[2]! - addresses[1]!).toBe(3);
  });

  it('reports no unnamed commands for a game inside the table', () => {
    const bytes = buildSludgeFixture(THREE_FUNCTIONS);
    const file = readSludgeFile(bytes);
    expect(unnamedCommands(readAllSludgeFunctions(bytes, file))).toEqual([]);
  });

  it('reports a command past the table as a finding, with its number', () => {
    const bytes = buildSludgeFixture({
      userFunctionNames: ['fromTheFuture'],
      functions: [
        {
          instructions: [
            { command: 1, parameter: 0 },
            { command: 200, parameter: 7 },
            { command: 201, parameter: 8 },
          ],
        },
      ],
    });
    const file = readSludgeFile(bytes);
    expect(unnamedCommands(readAllSludgeFunctions(bytes, file))).toEqual([200, 201]);
  });
});
