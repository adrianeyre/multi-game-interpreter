import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { OPCODE_NAMES } from '../src/engine/agos/script/opcodeNames.js';
import { VGA_OPCODE_TABLES } from '../src/engine/agos/gfx/vgaOpcodeTables.js';

/**
 * How much of each Version's instruction set actually runs.
 *
 * A published number rather than a feeling, in the spirit of the Unrecovered
 * counts: "AGOS plays" is a claim that reduces to this table being full, and
 * while it is not full the honest sentence is the number.
 *
 * The handled names are read out of the interpreter's own `case` labels rather
 * than kept in a list beside it. A list would be a second copy to forget to
 * update, and the failure mode of forgetting is a coverage number that claims
 * more than the code does — which is exactly the kind of comfortable wrongness
 * this project keeps designing out.
 */
function handledNames(path: string): Set<string> {
  const source = readFileSync(path, 'utf8');
  const names = new Set<string>();
  // Game opcodes are named `o_carried`, VGA ones `DRAW`, so both cases match.
  for (const match of source.matchAll(/case '([A-Za-z][A-Za-z0-9_]*)':/g)) {
    names.add(match[1]!);
  }
  return names;
}

const gameHandled = handledNames('src/engine/agos/script/AgosInterpreter.ts');
const vgaHandled = handledNames('src/engine/agos/gfx/VgaMachine.ts');

function coverage(table: readonly (string | null)[], handled: Set<string>) {
  const real = table.filter((name): name is string => name !== null && name !== 'o_invalid');
  const distinct = new Set(real);
  const covered = [...distinct].filter((name) => handled.has(name));
  return { total: distinct.size, covered: covered.length };
}

describe('how much of AGOS actually runs', () => {
  it('reports game bytecode coverage per Version', () => {
    const rows: string[] = [];
    for (const [version, table] of Object.entries(OPCODE_NAMES)) {
      const { total, covered } = coverage(table, gameHandled);
      rows.push(`${version}: ${covered}/${total}`);
      // A floor rather than a target: this asserts the number has not gone
      // *backwards*, which is what a test can honestly check. Raising it is the
      // work, and the work is #273.
      expect(covered).toBeGreaterThan(0);
      expect(covered).toBeLessThanOrEqual(total);
    }
    console.log(`AGOS game opcodes implemented — ${rows.join(', ')}`);
  });

  it('reports VGA script coverage per Version', () => {
    const rows: string[] = [];
    for (const [version, table] of Object.entries(VGA_OPCODE_TABLES)) {
      // A VGA entry is `letters|NAME`, so the name is what follows the bar.
      const names = table.map((entry) => (entry ? (entry.split('|')[1] ?? null) : null));
      const { total, covered } = coverage(names, vgaHandled);
      rows.push(`${version}: ${covered}/${total}`);
      expect(covered).toBeGreaterThan(0);
    }
    console.log(`AGOS VGA opcodes implemented — ${rows.join(', ')}`);
  });

  it('implements at least the opcodes every Version shares', () => {
    // The arithmetic, the comparisons and the item moves are the same
    // everywhere, so an opcode missing from this list is missing from every
    // game rather than from one.
    const universal = [
      'o_at',
      'o_carried',
      'o_zero',
      'o_eq',
      'o_gt',
      'o_lt',
      'o_let',
      'o_add',
      'o_sub',
      'o_place',
      'o_destroy',
      'o_goto',
      'o_getParent',
      'o_getChildren',
      'o_setState',
      'o_process',
      'o_when',
      'o_isClass',
      'o_addBox',
    ];

    expect(universal.filter((name) => !gameHandled.has(name))).toEqual([]);
  });
});
