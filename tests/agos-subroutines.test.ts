import { describe, expect, it } from 'vitest';
import {
  AgosDecodeError,
  readSubroutineBlock,
  writeSubroutineBlock,
} from '../src/engine/agos/script/subroutines.js';
import { checkStructuralAgreement } from '../src/engine/agos/script/structuralAgreement.js';
import { opcodeTableFor, type AgosTarget } from '../src/engine/agos/agosVersion.js';
import { OPCODE_ARG_TABLES } from '../src/engine/agos/script/opcodeArgTables.js';
import { buildElviraSubroutineBlock, buildSimonSubroutineBlock } from './fixtureAgos.js';

const SIMON1_FLOPPY: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'floppy',
  platform: 'dos',
};
const SIMON1_TALKIE: AgosTarget = { ...SIMON1_FLOPPY, releaseKind: 'talkie' };
const ELVIRA1: AgosTarget = {
  family: 'AGOS',
  version: 'Elvira1',
  releaseKind: 'floppy',
  platform: 'dos',
};

describe('the release kind is part of the Target because it changes decoding', () => {
  /**
   * ADR 0027 decided that an AGOS Version is a title, and wrote down the
   * tripwire that would falsify it: two releases of the same game disagreeing
   * about an opcode's length. They do, and this is the disagreement.
   */
  it('gives Simon 1 a different argument table per release kind', () => {
    expect(opcodeTableFor(SIMON1_FLOPPY)).toBe('simon1dos');
    expect(opcodeTableFor(SIMON1_TALKIE)).toBe('simon1talkie');
    expect(OPCODE_ARG_TABLES.simon1dos[67]).toBe('BT ');
    expect(OPCODE_ARG_TABLES.simon1talkie[67]).toBe('BTS ');
    expect(OPCODE_ARG_TABLES.simon1dos[162]).toBe('BBT ');
    expect(OPCODE_ARG_TABLES.simon1talkie[162]).toBe('BBTS ');
    // Two opcodes, and nothing else: the tables are otherwise identical.
    const differing = OPCODE_ARG_TABLES.simon1dos.filter(
      (entry, index) => entry !== OPCODE_ARG_TABLES.simon1talkie[index],
    );
    expect(differing).toHaveLength(2);
  });

  it('gives every Version a table, so no Target decodes with nothing', () => {
    const versions = [
      'Elvira1',
      'Elvira2',
      'Waxworks',
      'Simon1',
      'Simon2',
      'Feeble',
      'PuzzlePack',
    ] as const;
    for (const version of versions) {
      for (const releaseKind of ['floppy', 'talkie'] as const) {
        const table = OPCODE_ARG_TABLES[opcodeTableFor({ ...SIMON1_FLOPPY, version, releaseKind })];
        expect(table.length).toBeGreaterThan(255);
      }
    }
  });
});

describe('reading a Subroutine block', () => {
  it('reads the verb table, its guards, and a Subroutine called by number', () => {
    const { block } = readSubroutineBlock(
      buildSimonSubroutineBlock({ withSpeech: true }),
      SIMON1_TALKIE,
    );

    expect(block.subroutines.map((sub) => sub.id)).toEqual([0, 42]);
    expect(block.subroutines[0]!.lines[0]!.guard).toEqual({ verb: 101, noun1: 202, noun2: 303 });
    // A Subroutine called by number has no guard: its lines start at the code.
    expect(block.subroutines[1]!.lines[0]!.guard).toBeUndefined();
  });

  it('reads 0xFF in a byte operand as a variable reference rather than a value', () => {
    const { block } = readSubroutineBlock(
      buildSimonSubroutineBlock({ withSpeech: true }),
      SIMON1_TALKIE,
    );
    const instructions = block.subroutines[1]!.lines[0]!.instructions;

    expect(instructions[0]!.operands[0]).toEqual({ kind: 'byte', value: 0x07 });
    expect(instructions[1]!.operands[0]).toEqual({ kind: 'byte', value: 0xff, variable: 0x03 });
  });

  it('reads the talkie speech operand that the floppy release does not have', () => {
    const { block } = readSubroutineBlock(
      buildSimonSubroutineBlock({ withSpeech: true }),
      SIMON1_TALKIE,
    );
    const speaking = block.subroutines[1]!.lines[0]!.instructions[2]!;

    expect(speaking.opcode).toBe(67);
    expect(speaking.operands).toHaveLength(3);
    expect(speaking.operands[2]).toEqual({ kind: 'word', value: 0x1234 });
  });

  it('reads Elvira 1 with 16-bit opcodes and its own line terminator', () => {
    const { block } = readSubroutineBlock(buildElviraSubroutineBlock(), ELVIRA1);
    const line = block.subroutines[0]!.lines[0]!;

    expect(block.subroutines[0]!.id).toBe(7);
    expect(line.padding).toEqual([0, 0, 0]);
    expect(line.instructions[0]).toEqual({ opcode: 12, operands: [{ kind: 'word', value: 7 }] });
  });
});

describe('re-emission is the exact inverse of reading', () => {
  /**
   * ADR 0029 makes byte-identity one of the three conditions for editing an
   * AGOS game, and ADR 0030 rebuilds GAMEPC whole rather than patching it. Both
   * need the operands to keep what was on disk, including the bytes the
   * interpreter throws away.
   */
  it.each([
    ['Simon 1 talkie', buildSimonSubroutineBlock({ withSpeech: true }), SIMON1_TALKIE],
    ['Simon 1 floppy', buildSimonSubroutineBlock({ withSpeech: false }), SIMON1_FLOPPY],
    ['Elvira 1', buildElviraSubroutineBlock(), ELVIRA1],
  ] as const)('round-trips %s byte for byte', (_name, bytes, target) => {
    const { block, endOffset } = readSubroutineBlock(bytes, target);

    expect(writeSubroutineBlock(block, target)).toEqual(bytes.subarray(0, endOffset));
    expect(endOffset).toBe(bytes.length);
  });
});

describe('Structural agreement finds a wrong argument table', () => {
  /**
   * The claim ADR 0029 rests on: AGOS misdecodes *loudly* where AGI misdecodes
   * silently. Decoding a talkie release with the floppy table loses one operand
   * and every boundary after it, and the check says so rather than producing a
   * plausible listing.
   */
  it('agrees when the Target matches the data', () => {
    const report = checkStructuralAgreement(
      [{ source: 'fixture', data: buildSimonSubroutineBlock({ withSpeech: true }) }],
      SIMON1_TALKIE,
    );

    expect(report.agrees).toBe(true);
    expect(report.subroutinesDecoded).toBe(2);
    expect(report.instructionsDecoded).toBe(4);
  });

  it('disagrees when a talkie release is decoded as a floppy one', () => {
    const report = checkStructuralAgreement(
      [{ source: 'fixture', data: buildSimonSubroutineBlock({ withSpeech: true }) }],
      SIMON1_FLOPPY,
    );

    expect(report.agrees).toBe(false);
    expect(report.findings).toHaveLength(1);
  });

  it('stops rather than guessing at an opcode with no table entry', () => {
    // Opcode 250 has no entry in Simon 1's table: the game never uses it, so
    // there is no length for it and no way to find the next instruction.
    const data = Uint8Array.from([
      0x00, 0x00, 0x00, 0x2a, 0x00, 0x00, 250, 0xff, 0xff, 0xff, 0xff, 0xff,
    ]);

    expect(() => readSubroutineBlock(data, SIMON1_FLOPPY)).toThrow(AgosDecodeError);
  });
});
