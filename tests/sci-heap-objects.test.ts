/**
 * Adding an instance to a SCI1.1 code-and-heap script (row 12,
 * `sciHeapObjects.ts`).
 *
 * Over `fixtureSci.ts`'s heap pair, given the two things a real heap has and
 * that fixture leaves empty: a heap relocation table naming both objects'
 * name words, and a `lofsa` whose operand — a string's heap address — the code
 * table lists. Those are exactly the references that have to move when the
 * strings do, so they are what the tests watch.
 */

import { describe, expect, it } from 'vitest';

import type { SciProject, SciProjectScript } from '../src/authoring/project.js';
import { fromBase64 } from '../src/authoring/base64.js';
import { exportSciGame } from '../src/authoring/sci/exportSciGame.js';
import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import { addSciInstance, deleteSciInstance } from '../src/authoring/sci/sciObjects.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import {
  buildSci32Fixture,
  sci11ClassTable,
  sci11ScriptPair,
  sci32Resources,
  u16le,
} from './fixtureSci.js';

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

/** The fixture pair with a relocated heap and a string-loading method. */
function pair(): { code: number[]; heap: number[]; stringAt: number } {
  const { code, heap } = sci11ScriptPair();
  // The class's name pointer is the string's address; the method loads it.
  const stringAt = u16(Uint8Array.from(heap), 6 + 4 + 12);
  // `lofsa stringAt`, wide, over the first method's `pushi 1; ret`.
  code.splice(22, 3, 0x72, ...u16le(stringAt));
  // The code table: the object export at 8 and the lofsa operand at 23.
  code.splice(code.length - 4, 4, ...u16le(2), ...u16le(8), ...u16le(23));
  // The heap table: both objects' name words.
  heap.splice(heap.length - 2, 2, ...u16le(2), ...u16le(22), ...u16le(40));
  return { code, heap, stringAt };
}

async function importOf(code: number[], heap: number[]): Promise<SciProject> {
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

function zero(project: SciProject): SciProjectScript {
  return project.scripts.find((one) => one.number === 0)!;
}

function added(script: SciProjectScript, index: number, name?: string): SciProjectScript {
  const next = addSciInstance(script, index, name);
  if (typeof next === 'string') throw new Error(next);
  return next;
}

describe('an instance added to a heap script', () => {
  it('joins the object list, and every heap address that moved is moved', async () => {
    const { code, heap, stringAt } = pair();
    const project = await importOf(code, heap);
    const script = zero(project);
    expect(script.objects.map((one) => one.name)).toEqual(['Thing', 'Widget']);

    const next = added(script, 1);
    const newHeap = fromBase64(next.heapBytes!);
    const newCode = fromBase64(next.bytes);
    const objectBytes = 9 * 2;

    // The lofsa's operand follows the string, in the bytes and in the graph.
    expect(u16(newCode, 23)).toBe(stringAt + objectBytes);
    expect(next.objects[0].methods[0].instructions[0].operands[0]).toBe(stringAt + objectBytes);
    // The object export did not move, because nothing before the insertion does.
    expect(u16(newCode, 8)).toBe(6);
    // The table is still last, with the copy's name word added.
    const tableAt = u16(newHeap, 0);
    expect(tableAt + 2 + u16(newHeap, tableAt) * 2).toBe(newHeap.length);
    expect(u16(newHeap, tableAt)).toBe(3);

    const reread = zero(await importOf([...newCode], [...newHeap]));
    expect(reread.objects.map((one) => one.name)).toEqual(['Thing', 'Widget', 'Widget']);
    expect(reread.objects[0].methods[0].instructions[0].operands[0]).toBe(stringAt + objectBytes);
  });

  it('takes a name of its own, as a string before the relocation table', async () => {
    const { code, heap } = pair();
    const next = added(zero(await importOf(code, heap)), 1, 'Gadget');
    const reread = zero(
      await importOf([...fromBase64(next.bytes)], [...fromBase64(next.heapBytes!)]),
    );
    expect(reread.objects.map((one) => one.name)).toEqual(['Thing', 'Widget', 'Gadget']);
  });

  it('is carried by the export as the bytes the linker wrote', async () => {
    const { code, heap } = pair();
    const project = await importOf(code, heap);
    const next = added(zero(project), 1);
    const exported = exportSciGame({
      ...project,
      scripts: project.scripts.map((one) => (one.number === 0 ? next : one)),
    });
    expect(exported.problems).toEqual([]);
    expect(exported.resources.get('heap:0')).toEqual(fromBase64(next.heapBytes!));
    expect(exported.resources.get('script:0')).toEqual(fromBase64(next.bytes));
  });

  it('deletes back to the script it was, byte for byte, named or not', async () => {
    const { code, heap } = pair();
    const script = zero(await importOf(code, heap));
    for (const name of [undefined, 'Gadget']) {
      const once = added(added(script, 1), 1, name);
      const back = deleteSciInstance(once, 3);
      if (typeof back === 'string') throw new Error(back);
      const none = deleteSciInstance(back, 2);
      if (typeof none === 'string') throw new Error(none);
      expect(none.heapBytes).toBe(script.heapBytes);
      expect(none.bytes).toBe(script.bytes);
      expect(none.objects).toEqual(script.objects);
    }
  });

  it('refuses a lofsa the code table does not list, by name', async () => {
    const { code, heap } = pair();
    // Drop the lofsa's entry from the code table.
    code.splice(code.length - 6, 6, ...u16le(1), ...u16le(8));
    expect(addSciInstance(zero(await importOf(code, heap)), 1)).toMatch(
      /lofsa at 22 .* does not list/,
    );
  });
});
