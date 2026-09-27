/**
 * Exported procedures are read, written back, and scanned by + Room.
 *
 * `fixtureSci.ts`'s heap pair exports a procedure at 25 (`pushi 2; ret`) that
 * no object's dictionary names — the body nothing used to hold.
 */

import { describe, expect, it } from 'vitest';

import type { SciProject } from '../src/authoring/project.js';
import { exportSciGame } from '../src/authoring/sci/exportSciGame.js';
import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import {
  buildSci32Fixture,
  sci11ClassTable,
  sci11ScriptPair,
  sci32Resources,
} from './fixtureSci.js';

async function importPair(): Promise<SciProject> {
  const { code, heap } = sci11ScriptPair();
  const fixture = buildSci32Fixture([
    ...sci32Resources().filter((one) => one.type !== 'script' && one.type !== 'heap'),
    { type: 'script', number: 0, body: code },
    { type: 'heap', number: 0, body: heap },
    { type: 'vocab', number: 996, body: sci11ClassTable() },
  ]);
  const { game, resources } = await detectSciGame(new MemoryDataSource('t', fixture.files), {
    onLog: () => undefined,
  });
  return importSciGame(game, resources);
}

describe('an exported procedure', () => {
  it('is read as a body of its own', async () => {
    const script = (await importPair()).scripts[0];
    expect(script.procedures?.map((one) => one.offset)).toEqual([25]);
    expect(script.procedures![0].instructions.map((one) => [one.name, ...one.operands])).toEqual([
      ['pushi', 2],
      ['ret'],
    ]);
    expect(script.unreadProcedures).toBeUndefined();
  });

  it('exports byte-identically untouched, and carries an edit', async () => {
    const project = await importPair();
    const untouched = exportSciGame(project).resources.get('script:0')!;
    expect(untouched).toEqual(Uint8Array.from(sci11ScriptPair().code));

    project.scripts[0].procedures![0].instructions[0].operands[0] = 5;
    const edited = exportSciGame(project).resources.get('script:0')!;
    expect(edited[26]).toBe(5);
    expect([...edited.subarray(0, 26)]).toEqual([...untouched.subarray(0, 26)]);
  });
});
