/**
 * Adding an instance to a SCI script and deleting one this editor added
 * (row 12, `sciObjects.ts`).
 *
 * Tier 1 over `fixtureSci.ts`'s block-chain script and one written here with a
 * relocation block, from the layout `readSci0Blocks` and `readSci0Object` read.
 * What is held: the copy reads back as an object dispatching into the same
 * code, nothing already in the script moved, the export carries it, and
 * deleting it restores the script byte for byte.
 */

import { describe, expect, it } from 'vitest';

import type { SciProject, SciProjectScript } from '../src/authoring/project.js';
import { fromBase64 } from '../src/authoring/base64.js';
import { exportSciGame } from '../src/authoring/sci/exportSciGame.js';
import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import {
  addSciInstance,
  deleteSciInstance,
  describeSciObjectAdding,
  isLastAddedSciInstance,
} from '../src/authoring/sci/sciObjects.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import {
  readSci0Blocks,
  readSci0Methods,
  readSci0Object,
  readSci0Relocations,
} from '../src/engine/sci/script/scriptResource.js';
import { buildSci0Fixture, u16le, type SciResourceSpec } from './fixtureSci.js';

async function importOf(resources?: SciResourceSpec[]): Promise<SciProject> {
  const fixture = buildSci0Fixture(resources);
  const { game, resources: read } = await detectSciGame(new MemoryDataSource('t', fixture.files));
  return importSciGame(game, read);
}

function block(type: number, body: number[]): number[] {
  return [...u16le(type), ...u16le(body.length + 4), ...body];
}

/**
 * Exports, code, a string, an object whose `name` is a pointer to it, and a
 * relocation block that names that word — last, as Sierra's compiler leaves it.
 */
function relocatedScript(): number[] {
  const exportsBlock = block(7, [...u16le(0)]);
  const codeAt = exportsBlock.length + 4;
  const codeBlock = block(2, [0x39, 0x01, 0x48]);
  const stringAt = exportsBlock.length + codeBlock.length + 4;
  const stringsBlock = block(5, [0x4f, 0x62, 0x00, 0x00]);
  const variables = [...u16le(1), ...u16le(0), ...u16le(0), ...u16le(stringAt)];
  const objectBody = [
    ...u16le(0x1234),
    ...u16le(0),
    ...u16le(variables.length + 2),
    ...u16le(variables.length / 2),
    ...variables,
    ...u16le(1),
    ...u16le(1),
    ...u16le(0),
    ...u16le(codeAt),
  ];
  const objectAt = exportsBlock.length + codeBlock.length + stringsBlock.length;
  const nameWordAt = objectAt + 4 + 8 + 3 * 2;
  const objectBlock = block(1, objectBody);
  const pointersBlock = block(8, [...u16le(1), ...u16le(nameWordAt)]);
  return [
    ...exportsBlock,
    ...codeBlock,
    ...stringsBlock,
    ...objectBlock,
    ...pointersBlock,
    ...u16le(0),
    ...u16le(0),
  ];
}

function withScript(body: number[]): SciResourceSpec[] {
  const defaults = buildSci0Fixture().resources.filter((one) => one.type !== 'script');
  return [{ type: 'script', number: 0, body }, ...defaults];
}

function added(script: SciProjectScript, index = 0): SciProjectScript {
  const next = addSciInstance(script, index);
  if (typeof next === 'string') throw new Error(next);
  return next;
}

describe('adding an instance to a block-chain script', () => {
  it('appends a copy that dispatches into the same code, and moves nothing', async () => {
    const project = await importOf();
    const script = project.scripts[0];
    const before = fromBase64(script.bytes);
    const next = added(script);
    const after = fromBase64(next.bytes);

    const oldBlocks = readSci0Blocks(before);
    const newBlocks = readSci0Blocks(after);
    expect(newBlocks.map((one) => one.type)).toEqual([
      ...oldBlocks.map((one) => one.type),
      'object',
    ]);
    // Every byte of the old chain is where it was.
    const chainEnd = oldBlocks[oldBlocks.length - 1].offset + oldBlocks[oldBlocks.length - 1].size;
    expect(after.subarray(0, chainEnd)).toEqual(before.subarray(0, chainEnd));

    const [original, copy] = newBlocks
      .filter((one) => one.type === 'object')
      .map((one) => readSci0Object(after, one)!);
    expect(readSci0Methods(after, copy.methodsAt)).toEqual(
      readSci0Methods(after, original.methodsAt),
    );

    expect(next.objects).toHaveLength(2);
    expect(next.objects[1].methods).toEqual([]);
    expect(next.objects[1].variablesAt).toEqual({ resource: 'code', offset: copy.at });
    expect(isLastAddedSciInstance(next, 1)).toBe(true);
    expect(isLastAddedSciInstance(next, 0)).toBe(false);
  });

  it('is carried by the export, and a property edited on the copy lands on the copy', async () => {
    const project = await importOf();
    const next = added(project.scripts[0]);
    next.objects[1].variables[2] = 0x55;
    const exported = exportSciGame({ ...project, scripts: [next] });
    expect(exported.problems).toEqual([]);

    const bytes = exported.resources.get('script:0')!;
    const reread = await importOf(withScript([...bytes]));
    expect(reread.scripts[0].objects.map((one) => one.variables[2])).toEqual([0, 0x55]);
    // Both still dispatch the method the original had.
    expect(reread.scripts[0].objects.map((one) => one.methods.map((m) => m.offset))).toEqual([
      reread.scripts[0].objects[0].methods.map((m) => m.offset),
      reread.scripts[0].objects[0].methods.map((m) => m.offset),
    ]);
  });

  it('gives the copy relocation entries of its own when the relocation block is last', async () => {
    const project = await importOf(withScript(relocatedScript()));
    const script = project.scripts[0];
    expect(describeSciObjectAdding(script)).toBeNull();
    const next = added(script);
    const after = fromBase64(next.bytes);
    const blocks = readSci0Blocks(after);
    const relocations = [...readSci0Relocations(after, blocks)].sort((a, b) => a - b);
    const [original, copy] = blocks
      .filter((one) => one.type === 'object')
      .map((one) => readSci0Object(after, one)!);
    // The name word of each, and each still holds the same string's offset.
    expect(relocations).toEqual([original.at + 6, copy.at + 6]);
    expect(after[copy.at + 6]).toBe(after[original.at + 6]);

    const reread = await importOf(withScript([...after]));
    expect(reread.scripts[0].objects.map((one) => one.name)).toEqual(['Ob', 'Ob']);
  });
});

describe('naming an added instance', () => {
  it('writes the name as a strings block after the copy, and deletes back to the original', async () => {
    const project = await importOf(withScript(relocatedScript()));
    const script = project.scripts[0];
    const next = addSciInstance(script, 0, 'Copy');
    if (typeof next === 'string') throw new Error(next);
    const after = fromBase64(next.bytes);
    expect(
      readSci0Blocks(after)
        .map((one) => one.type)
        .slice(-2),
    ).toEqual(['object', 'strings']);
    const reread = await importOf(withScript([...after]));
    expect(reread.scripts[0].objects.map((one) => one.name)).toEqual(['Ob', 'Copy']);

    const back = deleteSciInstance(next, 1);
    if (typeof back === 'string') throw new Error(back);
    expect(back.bytes).toBe(script.bytes);
  });

  it('refuses a name where the name word is not relocated', async () => {
    const project = await importOf();
    expect(addSciInstance(project.scripts[0], 0, 'Copy')).toMatch(/not in the relocation block/);
  });
});

describe('deleting an instance this editor added', () => {
  it('restores the script byte for byte, relocation block included', async () => {
    for (const body of [undefined, relocatedScript()]) {
      const project = await importOf(body ? withScript(body) : undefined);
      const script = project.scripts[0];
      const twice = body ? added(script) : added(added(script), 0);
      const once = deleteSciInstance(twice, twice.objects.length - 1);
      if (typeof once === 'string') throw new Error(once);
      const none = body ? once : deleteSciInstance(once, once.objects.length - 1);
      if (typeof none === 'string') throw new Error(none);
      expect(none.bytes).toBe(script.bytes);
      expect(none.objects).toHaveLength(script.objects.length);
      expect(none.addedObjects).toEqual([]);
    }
  });

  it('refuses an object the game shipped, and one added before the last', async () => {
    const project = await importOf();
    const twice = added(added(project.scripts[0]));
    expect(deleteSciInstance(twice, 0)).toMatch(
      /was not added by this editor, or was not added last/,
    );
    expect(deleteSciInstance(twice, 1)).toMatch(/not added last/);
  });
});

describe('what adding refuses, by name', () => {
  it('a second relocated copy once an added instance follows the relocation block', async () => {
    const project = await importOf(withScript(relocatedScript()));
    expect(addSciInstance(added(project.scripts[0]), 0)).toMatch(/Delete that one first/);
  });

  it('a SCI3 script too short to hold its own header', () => {
    const tiny: SciProjectScript = {
      number: 1,
      objects: [
        {
          ...{ name: 'x', isClass: false, species: 0, superClass: 0 },
          variables: [],
          variableSelectors: [],
          variablesAt: { resource: 'code', offset: 4 },
          methods: [],
        },
      ],
      exports: [],
      locals: [],
      bytes: 'AAAAAA==',
    };
    expect(addSciInstance(tiny, 0)).toMatch(/shorter than its own 22-byte header/);
  });
});
