import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectAgiGame } from '../src/engine/agi/resource/agiDetect.js';
import { AgiResources } from '../src/engine/agi/resource/AgiResources.js';
import {
  decompileLogic,
  emitLogic,
  formatLogicTree,
  treeHasUnstructuredJumps,
  type AgiLogicTree,
} from '../src/authoring/agi/decompileLogic.js';
import { importAgiGame } from '../src/authoring/agi/importAgiGame.js';
import { readVocabulary, parseInput } from '../src/engine/agi/resource/words.js';
import { readObjectFile, writeObjectFile } from '../src/engine/agi/resource/objects.js';
import { migrate } from '../src/authoring/project.js';
import type { Target } from '../src/authoring/target.js';
import { buildAgiV2Fixture, buildAgiV3Fixture, buildLogic, u16le } from './fixtureAgi.js';

const TARGET: Target = {
  engine: 'agi',
  interpreter: 0x2917,
  platform: 'dos',
  identification: 'agidata',
};

const GUESSED: Target = { ...TARGET, identification: 'fallback' };

function sourceFrom(files: Map<string, Uint8Array>): MemoryDataSource {
  const source = new MemoryDataSource('agi-fixture');
  for (const [name, bytes] of files) source.set(name, bytes);
  return source;
}

function roundTrip(code: number[], messages: string[] = []) {
  const bytes = new Uint8Array(buildLogic({ code, messages }));
  return { bytes, result: decompileLogic(bytes, TARGET) };
}

describe('decompiling to a tree', () => {
  it('turns a flat run of commands into statements', () => {
    const { result } = roundTrip([0x0c, 5, 0x12, 3, 0x00]);
    expect(result.unrecovered).toBeNull();
    expect(result.tree?.statements.map((s) => (s.kind === 'command' ? s.name : s.kind))).toEqual([
      'set',
      'new.room',
      'return',
    ]);
  });

  it('nests an if block rather than leaving it as a jump', () => {
    const { result } = roundTrip([0xff, 0x07, 1, 0xff, ...u16le(2), 0x0c, 100, 0x00]);
    const [first] = result.tree!.statements;

    expect(first.kind).toBe('if');
    if (first.kind !== 'if') throw new Error('unreachable');
    expect(first.then.map((s) => (s.kind === 'command' ? s.name : s.kind))).toEqual(['set']);
    expect(first.otherwise).toEqual([]);
  });

  /**
   * #133 asks for `if`/`else` reconstructed rather than left as jumps, and
   * "verified by round-trip" — so the round trip decides, not the reader's
   * optimism.
   */
  it('reconstructs an else from the goto that ends the then block', () => {
    const { result } = roundTrip([
      0xff,
      0x07,
      1,
      0xff,
      ...u16le(5),
      0x0c,
      100,
      0xfe,
      ...u16le(2),
      0x0c,
      101,
      0x00,
    ]);

    const [first] = result.tree!.statements;
    expect(first.kind).toBe('if');
    if (first.kind !== 'if') throw new Error('unreachable');
    expect(first.then).toHaveLength(1);
    expect(first.otherwise).toHaveLength(1);
    // And the goto that carried the else is not left in the tree as well.
    expect(treeHasUnstructuredJumps(result.tree!)).toBe(false);
  });

  it('nests an if inside an if', () => {
    // The outer block is the inner if (6 bytes) plus both sets (2 each), so it
    // skips 10 — a skip that landed mid-instruction would not be a block
    // boundary and the structuring pass would refuse it.
    const { result } = roundTrip([
      0xff,
      0x07,
      1,
      0xff,
      ...u16le(10),
      0xff,
      0x07,
      2,
      0xff,
      ...u16le(2),
      0x0c,
      100,
      0x0c,
      101,
      0x00,
    ]);

    const [outer] = result.tree!.statements;
    expect(outer.kind).toBe('if');
    if (outer.kind !== 'if') throw new Error('unreachable');
    expect(outer.then[0].kind).toBe('if');
  });

  it('keeps a said condition with its word groups', () => {
    const { result } = roundTrip([
      0xff,
      0x0e,
      2,
      ...u16le(4),
      ...u16le(9999),
      0xff,
      ...u16le(2),
      0x0c,
      100,
      0x00,
    ]);
    const [first] = result.tree!.statements;
    if (first.kind !== 'if') throw new Error('unreachable');
    expect(first.conditions[0].words).toEqual([4, 9999]);
  });
});

describe('byte-identical re-emission', () => {
  /**
   * The property ADR 0013 turns on, and the reason it can be a property of one
   * resource: the tree is the truth, so re-emission is deterministic — every
   * statement has exactly one encoding and there is no choice to make.
   */
  it.each([
    ['a flat run', [0x0c, 5, 0x03, 1, 200, 0x12, 3, 0x00]],
    ['an if block', [0xff, 0x07, 1, 0xff, ...u16le(2), 0x0c, 100, 0x00]],
    [
      'an if/else',
      [0xff, 0x07, 1, 0xff, ...u16le(5), 0x0c, 100, 0xfe, ...u16le(2), 0x0c, 101, 0x00],
    ],
    [
      'nested ifs',
      [
        0xff,
        0x07,
        1,
        0xff,
        ...u16le(10),
        0xff,
        0x07,
        2,
        0xff,
        ...u16le(2),
        0x0c,
        100,
        0x0c,
        101,
        0x00,
      ],
    ],
    ['an or group', [0xff, 0xfc, 0x07, 1, 0x07, 2, 0xfc, 0xff, ...u16le(2), 0x0c, 100, 0x00]],
    ['a negated condition', [0xff, 0xfd, 0x07, 1, 0xff, ...u16le(2), 0x0c, 100, 0x00]],
    ['a said', [0xff, 0x0e, 1, ...u16le(7), 0xff, ...u16le(2), 0x0c, 100, 0x00]],
  ])('re-emits %s exactly', (_name, code) => {
    const { bytes, result } = roundTrip(code, ['a message', 'another']);
    expect(result.unrecovered).toBeNull();
    expect([...emitLogic(result.tree!)]).toEqual([...bytes]);
  });

  it('re-emits the message table with its obfuscation intact', () => {
    for (const encrypt of [true, false]) {
      const bytes = new Uint8Array(
        buildLogic({ code: [0x65, 1, 0x00], messages: ['hello there'], encrypt }),
      );
      const result = decompileLogic(bytes, TARGET, { encryptedMessages: encrypt });
      expect(result.unrecovered).toBeNull();
      expect([...emitLogic(result.tree!)]).toEqual([...bytes]);
    }
  });

  it('re-emits every Logic in both fixtures exactly, with a zero count', async () => {
    for (const build of [buildAgiV2Fixture, buildAgiV3Fixture]) {
      const source = sourceFrom(build().files);
      const resources = await AgiResources.load(source, await detectAgiGame(source));

      for (const number of resources.list('logic')) {
        const bytes = resources.read('logic', number);
        const result = decompileLogic(bytes, TARGET, {
          encryptedMessages: !resources.wasCompressed('logic', number),
        });
        expect(result.unrecovered, `logic ${number}`).toBeNull();
        expect([...emitLogic(result.tree!)], `logic ${number}`).toEqual([...bytes]);
      }
    }
  });
});

describe('unstructured jumps, which real games are full of', () => {
  /**
   * The fixture had none of these and the emitter threw on them, which a real
   * fan game found immediately: 56 of its 86 Logic resources contain jumps.
   *
   * A `goto`'s displacement is measured from the byte after it and its target
   * is an absolute offset, so it cannot be written until every statement has
   * been placed — hence two passes, and hence statements carrying the offset
   * they came from.
   */
  it('re-emits a backwards jump exactly', () => {
    // set f1; goto back to the top; return
    const { bytes, result } = roundTrip([0x0c, 1, 0xfe, ...u16le(0x10000 - 5), 0x00]);
    expect(result.unrecovered).toBeNull();
    expect([...emitLogic(result.tree!)]).toEqual([...bytes]);
    expect(treeHasUnstructuredJumps(result.tree!)).toBe(true);
  });

  it('re-emits a forward jump to the end of the code exactly', () => {
    // A jump past the last statement has no statement of its own to land on,
    // so it resolves against where the code stops.
    const { bytes, result } = roundTrip([0xfe, ...u16le(2), 0x0c, 1, 0x00]);
    expect(result.unrecovered).toBeNull();
    expect([...emitLogic(result.tree!)]).toEqual([...bytes]);
  });

  it('re-emits a jump out of an if block exactly', () => {
    const { bytes, result } = roundTrip([
      0xff,
      0x07,
      1,
      0xff,
      ...u16le(5),
      0x0c,
      100,
      // Back to the if itself at offset 2. The displacement is measured from
      // the byte after it (offset 13), so -11 — a jump landing mid-instruction
      // is not a block boundary and the structurer refuses it.
      0xfe,
      ...u16le(0x10000 - 11),
      0x0c,
      101,
      0x00,
    ]);
    expect(result.unrecovered).toBeNull();
    expect([...emitLogic(result.tree!)]).toEqual([...bytes]);
  });

  /**
   * The honest failure. A jump whose target has been deleted has no correct
   * displacement, so it is refused rather than written as something plausible —
   * and refusing makes *this resource* Unrecovered rather than taking the game
   * down, which ADR 0013 rejects explicitly.
   */
  it('marks a Logic Unrecovered when a jump target has been removed', () => {
    const { result } = roundTrip([0x0c, 1, 0xfe, ...u16le(0x10000 - 5), 0x00]);
    const tree = result.tree!;
    // Delete the statement the jump lands on.
    const pruned = { ...tree, statements: tree.statements.slice(1) };
    expect(() => emitLogic(pruned)).toThrow(/not the start of any statement/);
  });
});

describe('Unrecovered, which is a defect and not an escape hatch', () => {
  /**
   * `CONTEXT.md`: a resource that could not be decompiled, or that re-emitted
   * as different bytes. Deliberately not Preserved bytes — those are
   * byte-identical by design and will always exist in SCUMM, whereas an
   * Unrecovered Logic is a bug with a target of zero.
   */
  it('marks a Logic the disassembler could not finish, and says where', () => {
    const { result } = roundTrip([0x0c, 5, 0xc0, 0x00]);
    expect(result.tree).toBeNull();
    expect(result.unrecovered).toMatch(/stopped at/);
  });

  it('keeps the listing so the resource can still be shown read-only', () => {
    const { result } = roundTrip([0xc0, 0x00]);
    expect(result.tree).toBeNull();
    expect(result.listing).toBeDefined();
  });

  it('marks a Logic whose if jumps outside its own block', () => {
    // A skip that lands past the end of the resource is not a block boundary.
    const { result } = roundTrip([0xff, 0x07, 1, 0xff, ...u16le(200), 0x0c, 100, 0x00]);
    expect(result.tree).toBeNull();
    expect(result.unrecovered).toMatch(/not an instruction boundary|past the end/);
  });
});

describe('byte-identity is necessary and not sufficient', () => {
  /**
   * ADR 0013's sharpest consequence, demonstrated rather than asserted.
   *
   * Decode with one arity table and re-emit with the *same* table and the round
   * trip passes — whichever table it was. So a Logic written for one
   * interpreter round-trips clean under another, while the tree it produced is
   * a different program.
   *
   * This is why editing turns on positive identification of the interpreter
   * (`describeUneditableTarget`) rather than on this check.
   */
  it('round-trips clean under two tables that disagree about the code', () => {
    // `quit` takes one operand at 2.917 and none at exactly 2.089, so the same
    // bytes are two different programs: one reads two instructions where the
    // other reads four, and every boundary after the first differs.
    const bytes = new Uint8Array(buildLogic({ code: [0x86, 0x0c, 5, 0x64, 0x00], messages: [] }));

    const later = decompileLogic(bytes, { ...TARGET, interpreter: 0x2917 });
    const at2089 = decompileLogic(bytes, { ...TARGET, interpreter: 0x2089 });

    // Both re-emit exactly. Neither is evidence the tree is right.
    expect(later.unrecovered).toBeNull();
    expect(at2089.unrecovered).toBeNull();
    expect([...emitLogic(later.tree!)]).toEqual([...bytes]);
    expect([...emitLogic(at2089.tree!)]).toEqual([...bytes]);

    // And the trees genuinely differ: one reads three instructions where the
    // other reads two.
    expect(at2089.tree!.statements.length).not.toBe(later.tree!.statements.length);
  });

  it('refuses to import a game whose interpreter version was guessed', async () => {
    const source = sourceFrom(buildAgiV2Fixture().files);
    const game = await detectAgiGame(source);
    const resources = await AgiResources.load(source, game);

    expect(() =>
      importAgiGame(
        resources,
        { ...game, target: GUESSED },
        {
          objectFile: { items: [], maxAnimatedObjects: 0, encrypted: false },
          vocabulary: { words: new Map(), groups: new Map() },
        },
      ),
    ).toThrow(/could not be identified/);
  });
});

describe('importing an AGI game into a project', () => {
  async function importFixture() {
    const source = sourceFrom(buildAgiV2Fixture().files);
    const game = await detectAgiGame(source);
    const resources = await AgiResources.load(source, game);
    return importAgiGame(
      resources,
      { ...game, target: TARGET },
      {
        objectFile: {
          items: [{ name: 'a key', startRoom: 1 }],
          maxAnimatedObjects: 4,
          encrypted: true,
        },
        vocabulary: { words: new Map([['look', 1]]), groups: new Map([[1, ['look']]]) },
      },
    );
  }

  it('produces an AGI-targeted project with every resource carried', async () => {
    const { project } = await importFixture();

    expect(project.target).toEqual(TARGET);
    expect(project.agi?.logics).toHaveLength(2);
    expect(project.agi?.pictures).toHaveLength(1);
    expect(project.agi?.views).toHaveLength(1);
    expect(project.agi?.sounds).toHaveLength(1);
    expect(project.agi?.words).toEqual([['look', 1]]);
    expect(project.agi?.inventory.items).toEqual([{ name: 'a key', startRoom: 1 }]);
  });

  /** #133: the count is zero over every Logic in the synthetic fixture. */
  it('reports an Unrecovered count of zero on the fixture', async () => {
    const { project } = await importFixture();
    expect(project.agi?.unrecoveredCount).toBe(0);
  });

  /**
   * ADR 0013: "the Unrecovered count is reported alongside how the interpreter
   * version was established, because the count is meaningless without it".
   */
  it('reports the count with the evidence for the interpreter version', async () => {
    const { project, notes } = await importFixture();
    expect(project.agi?.interpreter.identification).toBe('agidata');
    expect(project.agi?.interpreter.evidence).toBeTruthy();
    expect(notes.join(' ')).toMatch(/Unrecovered: 0/);
    expect(notes.join(' ')).toMatch(/Interpreter version agidata/);
  });

  it('keeps every Logic original bytes, tree or not', async () => {
    const { project } = await importFixture();
    for (const logic of project.agi!.logics) {
      expect(logic.bytes.length).toBeGreaterThan(0);
    }
  });

  it('survives a save and load through the project migration', async () => {
    const { project } = await importFixture();
    const reloaded = migrate(JSON.parse(JSON.stringify(project)));

    expect(reloaded.target).toEqual(TARGET);
    expect(reloaded.agi?.logics).toHaveLength(2);
    expect(reloaded.agi?.unrecoveredCount).toBe(0);
  });
});

describe('the source view', () => {
  /**
   * A **view** over the tree, not the stored form (ADR 0013). Nothing parses it
   * back: editing happens on the tree, and this is what an author reads while
   * doing it.
   */
  it('renders nested blocks and the messages beside them', () => {
    const { result } = roundTrip(
      [0xff, 0x07, 1, 0xff, ...u16le(5), 0x0c, 100, 0xfe, ...u16le(2), 0x0c, 101, 0x00],
      ['hello'],
    );
    const text = formatLogicTree(result.tree as AgiLogicTree);

    expect(text).toMatch(/if \(isset\(f1\)\) \{/);
    expect(text).toMatch(/\} else \{/);
    expect(text).toMatch(/#message 1 "hello"/);
  });
});

describe('WORDS.TOK and the parser', () => {
  /**
   * The letter index is big-endian where everything else in AGI is
   * little-endian, so this fixture is built the way the file is rather than the
   * way the rest of the format is.
   */
  function buildWords(entries: Array<[string, number]>): Uint8Array {
    const bySection = new Map<number, Array<[string, number]>>();
    for (const [word, group] of entries) {
      const letter = word.charCodeAt(0) - 'a'.charCodeAt(0);
      const list = bySection.get(letter) ?? [];
      list.push([word, group]);
      bySection.set(letter, list);
    }

    const body: number[] = [];
    const offsets = new Array(26).fill(0);

    for (const [letter, list] of [...bySection.entries()].sort((a, b) => a[0] - b[0])) {
      offsets[letter] = 52 + body.length;
      let previous = '';
      for (const [word, group] of list.sort((a, b) => a[0].localeCompare(b[0]))) {
        let reuse = 0;
        while (reuse < previous.length && previous[reuse] === word[reuse]) reuse++;
        body.push(reuse);
        const rest = word.slice(reuse);
        for (const [index, character] of [...rest].entries()) {
          const last = index === rest.length - 1;
          body.push((character.charCodeAt(0) ^ 0x7f) | (last ? 0x80 : 0));
        }
        body.push((group >> 8) & 0xff, group & 0xff);
        previous = word;
      }
      // A zero reuse-count byte terminates the section.
      body.push(0);
    }

    const header: number[] = [];
    for (const offset of offsets) header.push((offset >> 8) & 0xff, offset & 0xff);
    return new Uint8Array([...header, ...body]);
  }

  const vocabulary = readVocabulary(
    buildWords([
      ['look', 10],
      ['look at', 10],
      ['examine', 10],
      ['at', 0],
      ['the', 0],
      ['key', 20],
      ['anyword', 1],
    ]),
  );

  it('reads words and their synonym groups', () => {
    expect(vocabulary.words.get('look')).toBe(10);
    expect(vocabulary.words.get('examine')).toBe(10);
    expect(vocabulary.groups.get(10)).toContain('look');
    expect(vocabulary.groups.get(10)).toContain('examine');
  });

  it('drops noise words per the game own vocabulary, not a list of ours', () => {
    // "the" is group 0 in this vocabulary, so it never reaches a script.
    expect(parseInput(vocabulary, 'look the key').groups).toEqual([10, 20]);
  });

  it('matches the longest phrase first, so a multi-word entry is one word', () => {
    // "look at" is a single vocabulary entry; matching "look" first would leave
    // "at" behind as a separate word.
    expect(parseInput(vocabulary, 'look at key').spoken).toEqual(['look at', 'key']);
  });

  it('names the first word it did not know, and where in the line it was', () => {
    const parsed = parseInput(vocabulary, 'look banana');
    expect(parsed.unknownWord).toBe('banana');
    expect(parsed.unknownIndex).toBe(2);
  });

  it('treats punctuation as a break rather than as part of a word', () => {
    expect(parseInput(vocabulary, 'look, key!').groups).toEqual([10, 20]);
  });

  it('refuses a file shorter than its own letter index', () => {
    expect(() => readVocabulary(new Uint8Array(10))).toThrow(/52-byte letter index/);
  });
});

describe('the OBJECT file', () => {
  it('round-trips items and their starting rooms', () => {
    const items = [
      { name: 'a rusty key', startRoom: 3 },
      { name: 'a lantern', startRoom: 255 },
      { name: '?', startRoom: 0 },
    ];
    for (const encrypted of [true, false]) {
      const bytes = writeObjectFile(items, 5, encrypted);
      const read = readObjectFile(bytes);

      expect(read.items).toEqual(items);
      expect(read.maxAnimatedObjects).toBe(5);
      expect(read.encrypted).toBe(encrypted);
      expect([...writeObjectFile(read.items, read.maxAnimatedObjects, read.encrypted)]).toEqual([
        ...bytes,
      ]);
    }
  });

  /**
   * Nothing in the file says whether it is obfuscated — most releases are and
   * the early AGI v2 games are not — so both readings are tried and the one
   * that produces readable names wins.
   */
  it('detects obfuscation rather than assuming it', () => {
    const items = [{ name: 'a brass lantern', startRoom: 1 }];
    expect(readObjectFile(writeObjectFile(items, 1, true)).encrypted).toBe(true);
    expect(readObjectFile(writeObjectFile(items, 1, false)).encrypted).toBe(false);
  });

  it('shares one name between items that have the same one', () => {
    // AGI's own files point several "?" placeholders at one string, and
    // emitting a copy each would work and not be the same bytes.
    const items = [
      { name: '?', startRoom: 0 },
      { name: '?', startRoom: 0 },
    ];
    const bytes = writeObjectFile(items, 1, false);
    const read = readObjectFile(bytes);
    expect(read.items).toEqual(items);
    expect([...writeObjectFile(read.items, 1, false)]).toEqual([...bytes]);
  });
});
