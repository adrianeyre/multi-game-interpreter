import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectAgiGame } from '../src/engine/agi/resource/agiDetect.js';
import { AgiResources } from '../src/engine/agi/resource/AgiResources.js';
import { AgiEngine } from '../src/engine/agi/AgiEngine.js';
import { importAgiGame } from '../src/authoring/agi/importAgiGame.js';
import { exportAgiGame } from '../src/authoring/agi/exportAgiGame.js';
import { readVocabulary } from '../src/engine/agi/resource/words.js';
import { readObjectFile } from '../src/engine/agi/resource/objects.js';
import { emitLogic, type AgiLogicTree } from '../src/authoring/agi/decompileLogic.js';
import { createProject } from '../src/authoring/project.js';
import type { Target } from '../src/authoring/target.js';
import { buildAgiV2Fixture, buildAgiV3Fixture } from './fixtureAgi.js';

const TARGET: Target = {
  engine: 'agi',
  interpreter: 0x2917,
  platform: 'dos',
  identification: 'agidata',
};

function sourceFrom(files: Map<string, Uint8Array>): MemoryDataSource {
  const source = new MemoryDataSource('agi-fixture');
  for (const [name, bytes] of files) source.set(name, bytes);
  return source;
}

async function importFixture(which: 'v2' | 'v3' = 'v2') {
  const fixture = which === 'v3' ? buildAgiV3Fixture() : buildAgiV2Fixture();
  const source = sourceFrom(fixture.files);
  const game = await detectAgiGame(source);
  const resources = await AgiResources.load(source, game);

  return importAgiGame(
    resources,
    { ...game, target: TARGET },
    {
      objectFile: {
        items: [
          { name: 'a rusty key', startRoom: 1 },
          { name: '?', startRoom: 0 },
        ],
        maxAnimatedObjects: 4,
        encrypted: true,
      },
      vocabulary: {
        words: new Map([
          ['look', 1],
          ['at', 0],
          ['key', 20],
        ]),
        groups: new Map([
          [1, ['look']],
          [0, ['at']],
          [20, ['key']],
        ]),
      },
    },
  );
}

describe('exporting an AGI project', () => {
  it('writes the four index files, a volume, the vocabulary and the objects', async () => {
    const { project } = await importFixture();
    const result = exportAgiGame(project);

    expect(result.errors).toEqual([]);
    expect(result.files.map((file) => file.name).sort()).toEqual([
      'LOGDIR',
      'OBJECT',
      'PICDIR',
      'SNDDIR',
      'VIEWDIR',
      'VOL.0',
      'WORDS.TOK',
    ]);
  });

  /**
   * The bar #134 sets: "Export produces game files the AGI interpreter from
   * #129 runs." Loading the exported files back through the real loader and
   * booting them is the only way to know that, and it is the check the whole
   * round trip exists for.
   */
  it('produces files that load and boot in the interpreter', async () => {
    const { project } = await importFixture();
    const result = exportAgiGame(project);

    const source = new MemoryDataSource('exported');
    for (const file of result.files) source.set(file.name, file.data);

    const engine = await AgiEngine.create(source);
    engine.boot();

    expect(engine.currentRoom).toBe(1);
    expect(engine.state.pictureShown).toBe(true);
  });

  it('exports a v3 game as v2 packaging, which is the same game', async () => {
    // v3 changes packaging only: the resources are identical either way, and
    // the AGI Specification says a v3 game converts to v2 format and back.
    const { project } = await importFixture('v3');
    const result = exportAgiGame(project);

    const source = new MemoryDataSource('exported-from-v3');
    for (const file of result.files) source.set(file.name, file.data);

    const engine = await AgiEngine.create(source);
    engine.boot();
    expect(engine.currentRoom).toBe(1);
  });

  it('re-emits every untouched resource byte for byte', async () => {
    const { project } = await importFixture();
    const result = exportAgiGame(project);

    const source = new MemoryDataSource('exported');
    for (const file of result.files) source.set(file.name, file.data);
    const resources = await AgiResources.load(source, await detectAgiGame(source));

    const original = sourceFrom(buildAgiV2Fixture().files);
    const before = await AgiResources.load(original, await detectAgiGame(original));

    for (const type of ['logic', 'picture', 'view', 'sound'] as const) {
      expect(resources.list(type)).toEqual(before.list(type));
      for (const number of before.list(type)) {
        expect([...resources.read(type, number)], `${type} ${number}`).toEqual([
          ...before.read(type, number),
        ]);
      }
    }
  });

  it('round-trips the vocabulary group numbers, which is what said matches on', async () => {
    const { project } = await importFixture();
    const result = exportAgiGame(project);
    const words = result.files.find((file) => file.name === 'WORDS.TOK')!;

    const vocabulary = readVocabulary(words.data);
    expect(vocabulary.words.get('look')).toBe(1);
    expect(vocabulary.words.get('key')).toBe(20);
    // Group 0 is a noise word, and it has to survive too or the parser stops
    // dropping it.
    expect(vocabulary.words.get('at')).toBe(0);
  });

  it('round-trips the inventory, including its obfuscation', async () => {
    const { project } = await importFixture();
    const result = exportAgiGame(project);
    const object = result.files.find((file) => file.name === 'OBJECT')!;

    const read = readObjectFile(object.data);
    expect(read.encrypted).toBe(true);
    expect(read.maxAnimatedObjects).toBe(4);
    expect(read.items).toEqual([
      { name: 'a rusty key', startRoom: 1 },
      { name: '?', startRoom: 0 },
    ]);
  });
});

describe('an edited Logic reaches the exported game', () => {
  it('writes the edit, and the interpreter runs it', async () => {
    const { project } = await importFixture();

    // Change a message in the room Logic. A Logic's messages live inside it, so
    // this changes one resource and nothing else — which is the property that
    // lets the editor not have to explain the reach of an edit (ADR 0013).
    const logic = project.agi!.logics.find((entry) => entry.number === 1)!;
    const tree = logic.tree as AgiLogicTree;
    const edited: AgiLogicTree = {
      ...tree,
      messages: tree.messages.map((text, number) => (number === 1 ? 'A changed room.' : text)),
    };
    logic.tree = edited;
    logic.bytes = Buffer.from(emitLogic(edited)).toString('base64');

    const result = exportAgiGame(project);
    const source = new MemoryDataSource('edited');
    for (const file of result.files) source.set(file.name, file.data);

    const resources = await AgiResources.load(source, await detectAgiGame(source));
    const bytes = resources.read('logic', 1);
    // The obfuscated text is in there, which is what the interpreter will read.
    expect([...bytes]).toEqual([...emitLogic(edited)]);

    const engine = await AgiEngine.create(source);
    engine.boot();
    expect(engine.currentRoom).toBe(1);
  });
});

describe('Unrecovered resources still ship', () => {
  /**
   * The whole of what Unrecovered costs an author: the resource is written back
   * exactly as it arrived, so the game still works — it is just not editable
   * (`CONTEXT.md`).
   */
  it('writes an Unrecovered Logic back from its original bytes, and warns', async () => {
    const { project } = await importFixture();
    const logic = project.agi!.logics[0];
    const original = logic.bytes;
    delete logic.tree;
    logic.unrecovered = 'A construct the decompiler does not understand.';

    const result = exportAgiGame(project);
    expect(result.errors).toEqual([]);
    expect(result.warnings.join(' ')).toMatch(/Unrecovered/);

    const source = new MemoryDataSource('with-unrecovered');
    for (const file of result.files) source.set(file.name, file.data);
    const resources = await AgiResources.load(source, await detectAgiGame(source));

    expect(Buffer.from(resources.read('logic', logic.number)).toString('base64')).toBe(original);
  });
});

describe('exporting the wrong kind of project', () => {
  it('refuses a SCUMM project, naming what it is', () => {
    const result = exportAgiGame(createProject('a scumm game'));
    expect(result.files).toEqual([]);
    expect(result.errors.join(' ')).toMatch(/not an AGI project/);
  });
});
