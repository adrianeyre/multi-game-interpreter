/**
 * SCI0 editing: the class graph, the linker and the Source view (#220, ADR 0018).
 *
 * The round trip is checked against real data as well as here: seven freely
 * distributed Sierra demos import to 1,061 objects and 2,598 methods and export
 * **byte-identical for every script**, with `Unrecovered` = 0 and no script
 * needing the linker it does not have.
 */

import { describe, expect, it } from 'vitest';

import type { SciProject } from '../src/authoring/project.js';

import { fromBase64, toBase64 } from '../src/authoring/base64.js';
import {
  emitSciMethod,
  emitSelectorTable,
  exportSciGame,
  extendSelectors,
  isUntouched,
} from '../src/authoring/sci/exportSciGame.js';
import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import {
  describeTextSurface,
  parseSciSource,
  renderSciSource,
} from '../src/authoring/sci/sciSource.js';
import { readSelectorTable } from '../src/engine/sci/script/selectors.js';
import { decodeSciBlock } from '../src/engine/sci/script/opcodes.js';
import {
  readSci0Blocks,
  readSci0Methods,
  readSci0Object,
} from '../src/engine/sci/script/scriptResource.js';
import type { SciProjectMethod } from '../src/authoring/project.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { buildSci0Fixture } from './fixtureSci.js';

function method(instructions: SciProjectMethod['instructions']): SciProjectMethod {
  return { selector: 'doit', selectorNumber: 1, offset: 0, instructions };
}

describe('re-emitting a method', () => {
  /**
   * The property `Unrecovered = 0` depends on: an instruction whose operands
   * still fit comes back at the width it arrived at, so an untouched method's
   * bytes match without anything having to remember that it was untouched.
   */
  it('keeps the width an instruction arrived at', () => {
    const narrow = method([{ offset: 0, name: 'pushi', operands: [5], raw: 0x39 }]);
    const wide = method([{ offset: 0, name: 'pushi', operands: [5], raw: 0x38 }]);

    expect([...emitSciMethod(narrow)]).toEqual([0x39, 0x05]);
    expect([...emitSciMethod(wide)]).toEqual([0x38, 0x05, 0x00]);
  });

  it('widens an instruction whose operand no longer fits', () => {
    const grown = method([{ offset: 0, name: 'pushi', operands: [0x1234], raw: 0x39 }]);
    expect([...emitSciMethod(grown)]).toEqual([0x38, 0x34, 0x12]);
  });

  /**
   * A send's parameter-byte count is one byte whichever way the low bit goes.
   * Treating it as sized made every `send` in every game look like an
   * instruction that had grown, and every script containing one was reported as
   * needing a linker it did not need.
   */
  it('writes a parameter-byte count as one byte, whatever the width', () => {
    expect([
      ...emitSciMethod(method([{ offset: 0, name: 'send', operands: [4], raw: 0x4a }])),
    ]).toEqual([0x4a, 0x04]);
    expect([
      ...emitSciMethod(method([{ offset: 0, name: 'send', operands: [4], raw: 0x4b }])),
    ]).toEqual([0x4b, 0x04]);
  });

  it('sees an untouched method as untouched', () => {
    expect(
      isUntouched({
        number: 0,
        objects: [
          {
            name: 'Rm',
            isClass: false,
            species: 1,
            superClass: 0,
            variables: [],
            variableSelectors: [],
            methods: [method([{ offset: 0, name: 'ret', operands: [], raw: 0x48 }])],
          },
        ],
        exports: [],
        locals: [],
        bytes: toBase64(new Uint8Array([0x48])),
      }),
    ).toBe(true);
  });

  /**
   * **The edit that was silently dropped.**
   *
   * `isUntouched` compared only whether a method re-emitted to the same *size*,
   * so an edit that kept an instruction's width — changing a constant, an
   * opcode, a Selector number, which is most edits — was invisible. The script
   * took the untouched arm, its original bytes were written back, and the edit
   * vanished with `Unrecovered` at zero and no problem reported.
   *
   * Found by editing one operand in Police Quest 3, Conquests of the Longbow
   * and Castle of Dr. Brain and diffing the export: zero bytes changed in all
   * three. It is one byte in all three now.
   */
  it('sees a same-length edit as an edit, which is most edits', () => {
    const script = {
      number: 0,
      objects: [
        {
          name: 'Rm',
          isClass: false,
          species: 1,
          superClass: 0,
          variables: [],
          variableSelectors: [],
          methods: [method([{ offset: 0, name: 'pushi', operands: [4], raw: 0x39 }])],
        },
      ],
      exports: [],
      locals: [],
      bytes: toBase64(new Uint8Array([0x39, 0x04])),
    };

    expect(isUntouched(script)).toBe(true);

    // One operand, same width. The old test — "does it re-emit to the same
    // length" — answers yes to this and calls the script untouched.
    script.objects[0].methods[0].instructions[0].operands[0] = 5;
    expect(isUntouched(script)).toBe(false);
  });
});

describe('the Selector table, which may only grow', () => {
  /**
   * #220 calls this the hard part, and it is: a Selector's number is not a name
   * in the file, it is an index, and every script in the game holds those
   * indexes. Renumbering one rewrites the meaning of every send in every script
   * that was not touched.
   */
  it('appends a new Selector without moving any existing one', () => {
    const { selectors, added } = extendSelectors(
      ['species', 'superClass', '-info-', 'y'],
      ['y', 'newThing'],
    );
    expect(selectors).toEqual(['species', 'superClass', '-info-', 'y', 'newThing']);
    expect(added).toEqual(['newThing']);
    expect(selectors.indexOf('y')).toBe(3);
  });

  it('keeps a Selector nothing uses, because a script this did not read may index past it', () => {
    const { selectors, refused } = extendSelectors(['a', 'b', 'c'], ['a']);
    expect(selectors).toEqual(['a', 'b', 'c']);
    expect(refused).toEqual(['b', 'c']);
  });

  /** Round trips through `vocab.997`'s own format, short count and all. */
  it('writes a table the reader reads back unchanged', () => {
    const names = ['species', 'superClass', '-info-', 'y', 'x'];
    expect(readSelectorTable(emitSelectorTable(names)).names).toEqual(names);
  });
});

describe('the Source view, which is a view', () => {
  /**
   * ADR 0018: where control flow cannot be reconstructed with certainty it
   * degrades to the instruction list rather than guessing at an `if` — and the
   * degradation is visible, because a view that silently guessed would be a
   * view an author trusts to mean what it says.
   */
  it('folds a forward branch that lands on an instruction into an if', () => {
    const body = method([
      { offset: 0, name: 'ldi', operands: [1], raw: 0x35 },
      // The branch lands on `ret` at 5: 2 (its own offset) + 2 (its length) + 1.
      { offset: 2, name: 'bnt', operands: [1], raw: 0x31 },
      { offset: 4, name: 'push', operands: [], raw: 0x36 },
      { offset: 5, name: 'ret', operands: [], raw: 0x48 },
    ]);
    const view = renderSciSource(body);
    expect(view.lines.map((line) => line.text.trim())).toEqual([
      'ldi 1',
      'if (',
      'push',
      ')',
      'ret',
    ]);
    expect(view.degradedCount).toBe(0);
  });

  it('degrades a backward branch to the instruction, and says it did', () => {
    const body = method([
      { offset: 0, name: 'push', operands: [], raw: 0x36 },
      { offset: 1, name: 'jmp', operands: [-3], raw: 0x33 },
    ]);
    const view = renderSciSource(body);
    expect(view.degradedCount).toBe(1);
    expect(view.lines[1].degraded).toBe(true);
    expect(view.lines[1].text.trim()).toBe('jmp -3');
  });

  it('parses back to the instructions it rendered from', () => {
    const body = method([
      { offset: 0, name: 'ldi', operands: [1], raw: 0x35 },
      { offset: 2, name: 'bnt', operands: [1], raw: 0x31 },
      { offset: 4, name: 'push', operands: [], raw: 0x36 },
      { offset: 5, name: 'ret', operands: [], raw: 0x48 },
    ]);
    const text = renderSciSource(body)
      .lines.map((line) => line.text)
      .join('\n');
    const parsed = parseSciSource(text, body);
    expect(parsed.problems).toEqual([]);
    expect(parsed.instructions.map((one) => one.name)).toEqual(['ldi', 'bnt', 'push', 'ret']);
  });

  it('refuses a deletion rather than silently shortening the method', () => {
    const body = method([
      { offset: 0, name: 'push', operands: [], raw: 0x36 },
      { offset: 1, name: 'ret', operands: [], raw: 0x48 },
    ]);
    expect(parseSciSource('push', body).problems[0]).toMatch(/needs the linker/);
  });

  /**
   * #222 asks the editor to say which text surface applies, and it applies from
   * SCI0 onwards: "edit this game's words" names two different places depending
   * on Version.
   */
  it('says where this game keeps its words', () => {
    expect(describeTextSurface(false)).toMatch(/inline in its Script resources/);
    expect(describeTextSurface(true)).toMatch(/MESSAGE resources/);
  });
});

describe('the round trip', () => {
  it('imports a game to a class graph and exports every script byte-identically', async () => {
    const fixture = buildSci0Fixture();
    const { game, resources } = await detectSciGame(new MemoryDataSource('t', fixture.files));
    const project = await importSciGame(game, resources);

    expect(project.unrecoveredCount).toBe(0);
    expect(project.selectors.length).toBeGreaterThan(0);

    const exported = exportSciGame(project);
    expect(exported.problems).toEqual([]);
    for (const script of project.scripts) {
      const written = exported.resources.get(`script:${script.number}`);
      expect([...(written ?? [])]).toEqual([...fromBase64(script.bytes)]);
    }
  });

  /**
   * ADR 0013's rule, asked before the work rather than discovered by attempting
   * it — a shell that only finds out by calling this can report the refusal
   * after a spinner has been up and taken down, which is indistinguishable from
   * a button that does nothing.
   */
  it('refuses a game whose Version was only guessed, with the same string it advertises', async () => {
    const engine = await loadAdventureEngine(new MemoryDataSource('t', buildSci0Fixture().files));
    const refusal = engine.describeEditRefusal();
    expect(refusal).toMatch(/could not be narrowed past a guess/);
    await expect(engine.toEditableGame({ progress: undefined as never })).rejects.toThrow(
      /could not be narrowed past a guess/,
    );
  });
});

/**
 * The same property edit, in the layout where the objects are in the Script
 * resource rather than in a heap beside it.
 *
 * Two resources, two answers, one writer — and `isUntouched` has to know about
 * it, because a script whose only edit is a property has every method byte for
 * byte identical and would otherwise export as the bytes it arrived as.
 */
describe('a SCI0 property is written back into the Script resource', () => {
  async function sci0Project(): Promise<SciProject> {
    const fixture = buildSci0Fixture();
    const { game, resources } = await detectSciGame(new MemoryDataSource('t', fixture.files));
    return importSciGame(game, resources);
  }

  it('records where each object’s words are, in the code resource', async () => {
    const project = await sci0Project();
    const object = project.scripts.flatMap((script) => script.objects)[0];

    expect(object.variablesAt?.resource).toBe('code');
    expect(object.variables.length).toBeGreaterThan(0);
  });

  it('stops calling a script untouched once a property has changed', async () => {
    const project = await sci0Project();
    const script = project.scripts.find((one) => one.objects.length > 0)!;

    expect(isUntouched(script, project.version)).toBe(true);
    script.objects[0].variables[2] = (script.objects[0].variables[2] ?? 0) ^ 0x0f0f;
    expect(isUntouched(script, project.version)).toBe(false);
  });

  it('writes the word in place and moves nothing else', async () => {
    const project = await sci0Project();
    const script = project.scripts.find((one) => one.objects.length > 0)!;
    const before = fromBase64(script.bytes);
    const at = script.objects[0].variablesAt!.offset;

    script.objects[0].variables[2] = 0x2222;
    const written = exportSciGame(project).resources.get(`script:${script.number}`)!;

    expect(written).toHaveLength(before.length);
    expect(written[at + 4] | (written[at + 5] << 8)).toBe(0x2222);
    expect([...written].filter((byte, index) => byte !== before[index])).toHaveLength(2);
  });
});

describe('SCI1.1 editing (#222)', () => {
  /**
   * ADR 0018's split, and it is decided from the resource's own bytes rather
   * than from the Version — which matters because SCI1.1 ships both kinds, and
   * a game bucketed at the wrong Version would otherwise get the wrong editor
   * for every Picture in it.
   */
  it('splits Pictures into two kinds by what they are, not by Version', async () => {
    const { sciPictureKind, describePictureKind } =
      await import('../src/engine/sci/gfx/pictureKind.js');

    expect(sciPictureKind(new Uint8Array([0xf0, 0x04]))).toBe('vector');
    expect(sciPictureKind(new Uint8Array([0x26, 0x00, 0x10]))).toBe('cel');
    expect(sciPictureKind(new Uint8Array([0x12, 0x34]))).toBe('unknown');

    // The editor names the kind rather than offering one surface with half its
    // buttons disabled — "the drawing tools do not apply to this" is a fact
    // about the resource, and "these buttons are greyed out" is not.
    expect(describePictureKind('cel')).toMatch(/separate surface/);
    expect(describePictureKind('unknown')).toMatch(/read-only/);
  });

  /**
   * Silent data loss by this project's own definition: a release that ships
   * four languages and imports one has three resources that did not come back
   * as they arrived.
   */
  it('sees every language a release ships, from its own resource numbering', async () => {
    const { detectLanguagesFrom } = await import('../src/authoring/sci/importSciGame.js');
    const languages = detectLanguagesFrom([300, 301, 1300, 1301, 4300]);

    expect(languages.map((language) => language.name)).toEqual([
      'the release language',
      'French',
      'German',
    ]);
    expect(languages.map((language) => language.resourceCount)).toEqual([2, 2, 1]);
  });
});

describe('the linker (#220)', () => {
  /**
   * ADR 0018's hard part, and the reason the assembler is a *linker* rather
   * than an emitter: a method that grows by one byte moves every offset after
   * it and invalidates four tables at once — the dispatch tables that point
   * into the code, the export table, the relocation list, and every block's own
   * size word.
   *
   * Checked against real data as well: a method grown in **162 scripts across
   * six demos**, zero refused, zero methods landing outside a code block, zero
   * code blocks left undecodable, and no export made invalid that was not
   * already.
   */
  function scriptWith(
    instructions: SciProjectMethod['instructions'],
    code: number[] = [0x39, 0x01, 0x48], // pushi 1; ret
  ): {
    project: import('../src/authoring/project.js').SciProjectScript;
    original: Uint8Array;
  } {
    // One code block holding the method, then one object dispatching to it.
    const codeBlock = [2, 0, 4 + code.length, 0, ...code];
    const codeAt = 4;

    const variables = [1, 0, 0, 0].flatMap((v) => [v & 0xff, v >> 8]);
    const dictionary = [1, 0, 1, 0, 0, 0, codeAt & 0xff, codeAt >> 8];
    const objectBody = [
      0x34,
      0x12, // magic
      0,
      0, // locals
      variables.length + 2,
      0, // function area, from the selector counter
      variables.length / 2,
      0,
      ...variables,
      ...dictionary,
    ];
    const objectBlock = [1, 0, 4 + objectBody.length, 0, ...objectBody];
    const original = new Uint8Array([...codeBlock, ...objectBlock, 0, 0, 0, 0]);

    return {
      original,
      project: {
        number: 0,
        objects: [
          {
            name: 'Rm',
            isClass: false,
            species: 1,
            superClass: 0,
            variables: [1, 0, 0, 0],
            variableSelectors: [0, 1, 2, 3],
            methods: [{ selector: 'doit', selectorNumber: 1, offset: codeAt, instructions }],
          },
        ],
        exports: [],
        locals: [],
        bytes: toBase64(original),
      },
    };
  }

  it('writes an unchanged method back byte-identically, without rebuilding', async () => {
    const { linkSciScript } = await import('../src/authoring/sci/sciLinker.js');
    const { project, original } = scriptWith([
      { offset: 4, name: 'pushi', operands: [1], raw: 0x39 },
      { offset: 6, name: 'ret', operands: [], raw: 0x48 },
    ]);

    const linked = linkSciScript(project);
    expect(linked.refused).toBeUndefined();
    expect(linked.moved).toBe(0);
    expect([...linked.bytes]).toEqual([...original]);
  });

  /**
   * The case the linker exists for. Widening one instruction grows the method
   * by a byte, which moves the object block, its dispatch table's target and
   * the code block's own size word — and the whole point is that the reader
   * finds the method exactly where the table now says it is.
   */
  it('relays out the code block, its size word and the dispatch table', async () => {
    const { linkSciScript } = await import('../src/authoring/sci/sciLinker.js');
    const { project, original } = scriptWith([
      // The same instruction, widened: a two-byte operand where there was one.
      { offset: 4, name: 'pushi', operands: [0x1234], raw: 0x38 },
      { offset: 6, name: 'ret', operands: [], raw: 0x48 },
    ]);

    const linked = linkSciScript(project);
    expect(linked.refused).toBeUndefined();
    expect(linked.bytes.length).toBe(original.length + 1);

    // The reader has to find the same structure in the rebuilt bytes.
    const blocks = readSci0Blocks(linked.bytes, 0);
    expect(blocks.map((block) => block.type)).toEqual(['code', 'object']);

    const object = readSci0Object(linked.bytes, blocks[1])!;
    const [method] = readSci0Methods(linked.bytes, object.methodsAt);
    const codeBlock = blocks[0];

    // And the dispatch table has to point *inside* the code block, which is the
    // one thing that would still be true of a table nobody patched only by
    // coincidence.
    expect(method.offset).toBeGreaterThanOrEqual(codeBlock.offset);
    expect(method.offset).toBeLessThan(codeBlock.offset + codeBlock.size);
    expect(
      decodeSciBlock(linked.bytes, method.offset, codeBlock.offset + codeBlock.size),
    ).toHaveLength(2);
  });

  /**
   * A branch is a *distance*, so it survives everything the offset map does
   * except a size change **inside its own span**. That is the one case a linker
   * patching only tables gets wrong, and the script would load, dispatch
   * correctly, and jump two bytes into the middle of an instruction.
   */
  it('corrects a branch whose span grew', async () => {
    const { linkSciScript } = await import('../src/authoring/sci/sciLinker.js');
    // `jmp +2` over a narrow `pushi`, then `ret`. The operand no longer fits
    // in a byte, so the `pushi` widens and the jump's target moves by one.
    const { project } = scriptWith(
      [
        { offset: 4, name: 'jmp', operands: [2], raw: 0x33 },
        { offset: 6, name: 'pushi', operands: [0x1234], raw: 0x39 },
        { offset: 8, name: 'ret', operands: [], raw: 0x48 },
      ],
      [0x33, 0x02, 0x39, 0x01, 0x48],
    );

    const linked = linkSciScript(project);
    expect(linked.refused).toBeUndefined();

    const blocks = readSci0Blocks(linked.bytes, 0);
    const decoded = decodeSciBlock(
      linked.bytes,
      blocks[0].offset,
      blocks[0].offset + blocks[0].size,
    );
    const jump = decoded.find((instruction) => instruction.name === 'jmp')!;
    const target = jump.offset + jump.length + jump.operands[0];

    // It still lands on an instruction boundary, which is the whole assertion:
    // an uncorrected branch would land one byte inside the widened `pushi`.
    expect(decoded.some((instruction) => instruction.offset === target)).toBe(true);
  });

  it('refuses a heap or SCI3 layout rather than linking one wrongly', async () => {
    const { linkSciScript } = await import('../src/authoring/sci/sciLinker.js');
    const linked = linkSciScript({
      number: 0,
      objects: [],
      exports: [],
      locals: [],
      bytes: toBase64(new Uint8Array([0, 0, 0, 0])),
    });
    expect(linked.refused).toMatch(/heap pair or a SCI3 layout/);
  });
});

/**
 * Cel Pictures as their own resource kind, edited as a composition (#222, #227).
 *
 * ADR 0018 says two resource kinds rather than one editor with a Version mode,
 * and the argument is that a vector drawing tool and a bitmap composition tool
 * share no editing operation. This is that argument as code: the operations
 * here are *move an item* and *change what occludes what*, and there is not a
 * drawing operation among them.
 */
describe('a cel Picture, edited as a composition', () => {
  /** A SCI32 container with two items at positions and priorities. */
  function celPicture(): Uint8Array {
    const resource = new Uint8Array(14 + 42 * 2 + 8);
    const view = new DataView(resource.buffer);
    view.setUint16(0, 0x0e, true);
    resource[2] = 2;
    view.setUint16(4, 42, true);
    view.setUint16(10, 640, true);
    view.setUint16(12, 480, true);

    for (const [index, place] of [
      { x: 0, y: 0, priority: 0, dataAt: 14 + 84 },
      { x: 40, y: 12, priority: 7, dataAt: 14 + 88 },
    ].entries()) {
      const at = 14 + 42 * index;
      view.setUint16(at, 2, true);
      view.setUint16(at + 2, 2, true);
      resource[at + 8] = 0xff;
      resource[at + 9] = 0;
      view.setUint32(at + 24, place.dataAt, true);
      view.setInt16(at + 36, place.priority, true);
      view.setInt16(at + 38, place.x, true);
      view.setInt16(at + 40, place.y, true);
    }
    resource.set([1, 2, 3, 4, 5, 6, 7, 8], 14 + 84);
    return resource;
  }

  async function project(): Promise<SciProject> {
    const { readSciCelPicture } = await import('../src/engine/sci/gfx/SciCelPicture.js');
    const { toBase64 } = await import('../src/authoring/base64.js');
    const bytes = celPicture();
    const composition = readSciCelPicture(bytes);

    return {
      identification: { how: 'probe', evidence: [] },
      selectors: [],
      classes: [],
      scripts: [],
      resources: [],
      vectorPictures: [],
      celPictures: [
        {
          type: 'pic',
          number: 100,
          bytes: toBase64(bytes),
          container: composition.container,
          resolution: composition.resolution,
          hasVectors: false,
          items: composition.cels.map((placed, index) => ({
            headerAt: 14 + 42 * index,
            width: placed.cel.width,
            height: placed.cel.height,
            x: placed.x,
            y: placed.y,
            priority: placed.priority,
          })),
        },
      ],
      messages: [],
      languages: [],
      unrecoveredCount: 0,
    };
  }

  it('exports an untouched Picture byte-identically', async () => {
    const { exportSciGame } = await import('../src/authoring/sci/exportSciGame.js');
    const before = celPicture();
    const result = exportSciGame(await project());

    expect(result.recomposed).toEqual([]);
    expect([...(result.resources.get('pic:100') ?? [])]).toEqual([...before]);
  });

  /**
   * **The property that means this editor needs no linker.** An item's position
   * and priority are fixed-width fields at fixed offsets, so moving one writes
   * six bytes and nothing else moves — unlike a Script resource, where adding a
   * Selector relays out every instance and every relocation entry (ADR 0018).
   */
  it('moves an item by writing its own header, and leaves the rest alone', async () => {
    const { exportSciGame } = await import('../src/authoring/sci/exportSciGame.js');
    const before = celPicture();
    const edited = await project();
    edited.celPictures[0].items[1].x = 100;
    edited.celPictures[0].items[1].priority = 3;

    const result = exportSciGame(edited);
    const after = result.resources.get('pic:100');

    expect(result.recomposed).toEqual([100]);
    expect(after).toBeDefined();
    expect(after?.length).toBe(before.length);

    const view = new DataView(after!.buffer, after!.byteOffset, after!.byteLength);
    expect(view.getInt16(14 + 42 + 38, true)).toBe(100);
    expect(view.getInt16(14 + 42 + 36, true)).toBe(3);
    // Everything outside those six bytes is what it was, including the pixels.
    expect([...after!.subarray(14 + 84)]).toEqual([...before.subarray(14 + 84)]);
    expect([...after!.subarray(0, 14 + 36)]).toEqual([...before.subarray(0, 14 + 36)]);
  });

  it('states which surface applies, rather than greying out half of one', async () => {
    const { describeCelPictureEditing } = await import('../src/authoring/sci/exportSciGame.js');
    const built = await project();

    expect(describeCelPictureEditing(built.celPictures[0])).toMatch(/composition of 2 items/);
    expect(describeCelPictureEditing(built.celPictures[0])).toMatch(/no drawing tools/);

    // A SCI1.1 cel Picture has one item and it is the background. There is
    // nowhere to move it, and the editor says that rather than offering a
    // composition surface with one immovable thing on it.
    const sci11 = { ...built.celPictures[0], container: 'sci11' as const, hasVectors: true };
    expect(describeCelPictureEditing(sci11)).toMatch(/no arrangement to edit/);
    expect(describeCelPictureEditing(sci11)).toMatch(/vector operations after it/);
  });

  /**
   * #227's size question, answered. ADR 0021 made a seven-disc game *playable*
   * by reading Volumes at offsets; editing is a different claim, and this is
   * where the honest answer is recorded rather than an editor that dies on
   * Phantasmagoria.
   */
  it('names the Volumes an export carries through rather than rebuilding', async () => {
    const { exportSciGame } = await import('../src/authoring/sci/exportSciGame.js');
    const result = exportSciGame(await project());

    expect(result.carriedVolumes).toContain('RESOURCE.AUD');
    expect(result.carriedVolumes).toContain('RESOURCE.SFX');
  });
});

/**
 * `vocab.997` is carried through unless a Selector was added (#220's round trip).
 *
 * It was rebuilt on every export, which made it **the one resource that differed
 * in a round trip of every game that ships one** — 21 of the 25 Sierra demos —
 * while `Unrecovered` stayed at zero and nothing said so. The byte-identity
 * criterion is the headline of five editing issues, and it was failing quietly.
 *
 * Not cosmetic either: from SCI1.1 on Sierra ships a fixed 4,104-entry table
 * whose unused slots point at empty strings and at the literal `BAD SELECTOR`.
 * Re-emitting gives every slot a length prefix and a body, turning King's Quest
 * VI's 17KB `vocab.997` into 62KB.
 */
describe('the Selector table on export', () => {
  function table(names: readonly string[]): Uint8Array {
    const header = 2 + names.length * 2;
    const bodies = names.map((name) => {
      const bytes = new Uint8Array(2 + name.length);
      bytes[0] = name.length;
      for (let i = 0; i < name.length; i++) bytes[2 + i] = name.charCodeAt(i);
      return bytes;
    });
    const out = new Uint8Array(header + bodies.reduce((sum, b) => sum + b.length, 0));
    out[0] = (names.length - 1) & 0xff;
    out[1] = (names.length - 1) >> 8;
    let at = header;
    for (const [index, body] of bodies.entries()) {
      out[2 + index * 2] = at & 0xff;
      out[2 + index * 2 + 1] = at >> 8;
      out.set(body, at);
      at += body.length;
    }
    return out;
  }

  async function projectWith(selectors: string[], bytes: Uint8Array): Promise<SciProject> {
    const { toBase64 } = await import('../src/authoring/base64.js');
    return {
      identification: { how: 'probe', evidence: [] },
      selectors,
      classes: [],
      scripts: [],
      resources: [{ type: 'vocab', number: 997, bytes: toBase64(bytes) }],
      vectorPictures: [],
      celPictures: [],
      messages: [],
      languages: [],
      unrecoveredCount: 0,
    };
  }

  it('carries the original bytes through when nothing was added', async () => {
    const { exportSciGame } = await import('../src/authoring/sci/exportSciGame.js');
    const bytes = table(['y', 'x', 'view']);
    const result = exportSciGame(await projectWith(['y', 'x', 'view'], bytes));

    expect([...(result.resources.get('vocab:997') ?? [])]).toEqual([...bytes]);
  });

  it('rebuilds only when the table grew, and does not renumber what was there', async () => {
    const { exportSciGame } = await import('../src/authoring/sci/exportSciGame.js');
    const { readSelectorTable } = await import('../src/engine/sci/script/selectors.js');
    const bytes = table(['y', 'x', 'view']);
    const result = exportSciGame(await projectWith(['y', 'x', 'view', 'newThing'], bytes));

    const written = result.resources.get('vocab:997');
    expect(written).toBeDefined();
    const read = readSelectorTable(written!);
    // The constraint #220 calls the hard part: a new Selector extends the table
    // without moving the ones untouched Script resources index by number.
    expect(read.names).toEqual(['y', 'x', 'view', 'newThing']);
    expect(read.numbers.get('view')).toBe(2);
  });
});

/**
 * SCI2.1 and SCI3 editing, which is the criterion both issues actually state
 * (#228, #229).
 *
 * Not "the editor can rewrite a SCI3 method" — the linker refuses a heap pair
 * and a SCI3 layout by name, which is #222's and #227's work rather than these
 * issues'. What #228 and #229 ask for is narrower and is the property an export
 * has to have before any of that is safe: **a resource nobody touched comes
 * back as the bytes it arrived as, and `Unrecovered` is zero.**
 *
 * That is not a technicality. `Unrecovered` counts a resource that came back
 * different, and an export that quietly rebuilt a script it could not read
 * would corrupt every SCI32 game it touched while reporting success.
 */
describe('SCI2.1 and SCI3 export (#228, #229)', () => {
  it('reads a SCI32 map, whose types are not OR-ed with 0x80', async () => {
    const { buildSci32Fixture } = await import('./fixtureSci.js');
    const fixture = buildSci32Fixture();
    const { game, resources } = await detectSciGame(new MemoryDataSource('t', fixture.files));

    // The map's own structure is the whole of what separates SCI32 from SCI1
    // late, and it is what puts the game on the SCI32 half of the axis.
    expect(resources.isSci32).toBe(true);
    expect(game.version === 'sci2' || game.version.startsWith('sci2-1')).toBe(true);
  });

  it('exports every untouched SCI2.1 resource byte-identically, with Unrecovered at zero', async () => {
    const { buildSci32Fixture } = await import('./fixtureSci.js');
    const fixture = buildSci32Fixture();
    const { game, resources } = await detectSciGame(new MemoryDataSource('t', fixture.files));
    const project = await importSciGame(game, resources);

    expect(project.unrecoveredCount).toBe(0);

    const exported = exportSciGame(project);
    expect(exported.problems).toEqual([]);
    for (const script of project.scripts) {
      const written = exported.resources.get(`script:${script.number}`);
      expect([...(written ?? [])]).toEqual([...fromBase64(script.bytes)]);
    }
  });

  it('reads a SCI3 game, which has no heap resource at all', async () => {
    const { buildSci3Fixture } = await import('./fixtureSci.js');
    const fixture = buildSci3Fixture();
    const { resources } = await detectSciGame(new MemoryDataSource('t', fixture.files));

    // The heap is what `probeHeapSplit` reads, and SCI3 folded it back into
    // the Script resource — so a SCI3 fixture shipping one would be a SCI3
    // game the probes call SCI1.1.
    expect(resources.count('heap')).toBe(0);
    expect(resources.count('script')).toBe(1);
  });

  it('exports an untouched SCI3 script as the bytes it arrived as', async () => {
    const { buildSci3Fixture } = await import('./fixtureSci.js');
    const fixture = buildSci3Fixture();
    const { game, resources } = await detectSciGame(new MemoryDataSource('t', fixture.files));
    const project = await importSciGame(game, resources);

    expect(project.unrecoveredCount).toBe(0);

    const exported = exportSciGame(project);
    expect(exported.problems).toEqual([]);
    const original = fixture.resources.find((resource) => resource.type === 'script');
    const written = exported.resources.get('script:0');
    expect([...(written ?? [])]).toEqual(original?.body);
  });

  /**
   * And the refusal is stated rather than discovered. A SCI3 script has no
   * block chain, so the linker cannot relay one out — and the honest answer is
   * a refusal by name, not a rebuilt resource that happens to be wrong.
   */
  it('refuses to link a SCI3 layout rather than producing a plausible one', async () => {
    const { linkSciScript } = await import('../src/authoring/sci/sciLinker.js');
    const { buildSci3Fixture } = await import('./fixtureSci.js');
    const body = buildSci3Fixture().resources.find((resource) => resource.type === 'script')!.body;

    const linked = linkSciScript({
      number: 0,
      objects: [],
      exports: [],
      locals: [],
      bytes: toBase64(Uint8Array.from(body)),
    });
    expect(linked.refused).toMatch(/heap pair or a SCI3 layout/);
  });
});
