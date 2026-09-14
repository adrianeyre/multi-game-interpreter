/**
 * Reading a SCI1.1-and-later Script pair as something editable, not just as
 * bytes that round-trip.
 *
 * ADR 0017's claim is that a new *layout* costs a reader and not a decoder, and
 * the importer had only paid half of it: it found the objects in the heap and
 * then emitted `methods: []` for every one of them. A Project like that
 * exports byte-identically and shows nothing to edit, which is the failure mode
 * ADR 0013 is about — the same capability in the family's own terms, or a
 * recorded gap, and not a surface that quietly holds less.
 *
 * Every SCI game from SCI1.1 on is in this layout, so "objects with no methods"
 * was every SCI1.1, SCI2, SCI2.1 and SCI3 release. These are Tier 1: a
 * synthetic pair built in `fixtureSci.ts`, so the reader is checked against
 * bytes whose intent is written down rather than against a shipped game no
 * test run has.
 */

import { describe, expect, it } from 'vitest';

import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import { exportSciGame } from '../src/authoring/sci/exportSciGame.js';
import { fromBase64 } from '../src/authoring/base64.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import type { SciProject, SciProjectScript } from '../src/authoring/project.js';
import {
  buildSci32Fixture,
  sci32Resources,
  sci11ClassTable,
  sci11ScriptPair,
} from './fixtureSci.js';

async function importPair(): Promise<SciProject> {
  const { code, heap } = sci11ScriptPair();
  const fixture = buildSci32Fixture([
    ...sci32Resources().filter(
      (resource) => !(resource.type === 'script' || resource.type === 'heap'),
    ),
    { type: 'script', number: 0, body: code },
    { type: 'heap', number: 0, body: heap },
    { type: 'vocab', number: 996, body: sci11ClassTable() },
  ]);
  const { game, resources } = await detectSciGame(new MemoryDataSource('t', fixture.files), {
    onLog: () => undefined,
  });
  return importSciGame(game, resources);
}

function scriptZero(project: SciProject): SciProjectScript {
  const script = project.scripts.find((candidate) => candidate.number === 0);
  if (!script) throw new Error('the fixture ships script 0 and the import lost it');
  return script;
}

describe('a heap script has method bodies, not just objects', () => {
  it('follows the object into its method dictionary and disassembles what it finds', async () => {
    const object = scriptZero(await importPair()).objects[0];

    expect(object.name).toBe('Thing');
    expect(object.isClass).toBe(true);
    // The dictionary is `(Selector, offset)` pairs at SCI1.1, not SCI0's two
    // runs with a zero word between them — reading it SCI0's way finds a method
    // at an offset that is really another Selector number.
    expect(object.methods.map((method) => method.selector)).toEqual(['CD', 'AB']);
    expect(object.methods[0].instructions.map((instruction) => instruction.name)).toEqual([
      'pushi',
      'ret',
    ]);
    expect(object.methods[0].unrecovered).toBeUndefined();
  });

  /**
   * **A body has to end somewhere, and where is a property of the script.**
   *
   * The fixture puts a procedure three bytes past the method, so a reader that
   * runs a body to the end of the code resource swallows it — correct to read,
   * because the instructions decode either way, and useless to write, because
   * the linker cannot place two bodies claiming the same bytes.
   */
  it('ends a body at the next entry point rather than at the end of the code', async () => {
    const method = scriptZero(await importPair()).objects[0].methods[0];

    expect(method.offset).toBe(22);
    // `pushi 1` at 22 and `ret` at 24; the procedure at 25 is not in the body.
    expect(method.instructions.map((instruction) => instruction.offset)).toEqual([22, 24]);
  });

  /**
   * **An export that names an object is measured from the heap.** SCI1.1 keeps
   * code offsets and heap offsets in one undistinguished export list, and a
   * heap offset is a small number that lands inside the code resource as
   * readily as a real entry point does.
   *
   * Taking one for a code offset is not a cosmetic error: over King's Quest VII
   * it started 27 disassemblies inside the heap's property words, which decoded
   * as unused opcodes, ran 108 bodies past their bounds, and produced six
   * Kernel call numbers past the end of SCI2.1 middle's table — all of which
   * read as faults in the decoder and none of which were.
   */
  it('does not treat an object export as a place where code starts', async () => {
    const script = scriptZero(await importPair());

    // Export 0 is the object at heap offset 6; export 1 is the procedure at 25.
    expect(script.exports).toEqual([6, 25]);
    // Had 6 been taken for a code offset it would bound the method at 22 — the
    // export table's own count field is what lives at 6 — and the body would be
    // reported as running past the end of its block.
    expect(script.objects[0].methods[0].unrecovered).toBeUndefined();
  });

  /**
   * **The last thing in a SCI1.1 code resource is not code.** Word 0 of the
   * header names a relocation table — a count and one entry per `lofs` operand
   * in the resource — and a body bounded at `code.length` walks into it and
   * decodes a run of ascending pointers as instructions, because half of those
   * pointers are valid opcodes.
   *
   * It is not a cosmetic error. Over King's Quest VII it left 85 of 3,929
   * method bodies carrying an `unrecovered` note, which is an ADR 0013 defect
   * with a target of zero *and* what kept 85 scripts from exporting as
   * untouched: the exporter re-emits a script that holds an unrecovered method
   * rather than leaving its bytes alone.
   */
  it('stops a body at the relocation table rather than at the end of the resource', async () => {
    const methods = scriptZero(await importPair()).objects[0].methods;
    const last = methods[methods.length - 1];

    // `pushi 3` at 46 and `ret` at 48. The table starts at 49.
    expect(last.instructions.map((instruction) => instruction.offset)).toEqual([46, 48]);
    expect(last.unrecovered).toBeUndefined();
  });

  /**
   * **From SCI1.1 on only a class carries a property-name table**, so an
   * instance's properties are named by reaching its class through `vocab.996`
   * — and a reader that stops at the instance's own record leaves every one of
   * them a bare number. Over King's Quest VII that was 2,663 of 2,821 objects
   * and 91,395 of 96,384 properties, which is most of what an author would
   * want to look at.
   *
   * Found through `-super-` and not `-species-`: on disk an instance's species
   * is `0xffff` until the engine links the script.
   */
  it("names an instance's properties from the class it is an instance of", async () => {
    const script = scriptZero(await importPair());
    const instance = script.objects[1];

    expect(instance.name).toBe('Widget');
    expect(instance.isClass).toBe(false);
    expect(instance.species).toBe(0xffff);
    expect(instance.superClass).toBe(0);
    expect(instance.variableSelectors).toEqual(script.objects[0].variableSelectors);
  });

  /**
   * The property-name table has an entry for every property *including* the
   * two in the object's header, and the properties a reader sees start past
   * them — so a reader that lines the two lists up from the front names every
   * property two slots early and leaves the last two with no name at all.
   */
  it('names a class property from the table in the code resource', async () => {
    const object = scriptZero(await importPair()).objects[0];

    expect(object.variables).toHaveLength(7);
    expect(object.variableSelectors).toHaveLength(7);
    expect(object.variableSelectors).toEqual([0, 1, 0, 1, 0, 1, 0]);
  });
});

/**
 * **A property is state, and state is the half of a SCI game that is not code.**
 *
 * The importer held every property value and no record of where it read one,
 * so an author could look at `view` or `y` or `signal` on any of King's Quest
 * VII's 2,821 objects and change none of them — and the linker they would
 * otherwise have to wait for is not needed here at all. An object's size is a
 * word in its own header, a property is two bytes in a fixed place, and
 * nothing an author does to a value moves anything.
 *
 * Where it is written is the part that has to be right. From SCI1.1 the
 * objects are in the **heap** resource and the code resource beside it must
 * come back untouched, which is the assertion below that would have caught a
 * writer aimed at the combined buffer the reader walks.
 */
describe('editing a heap script’s properties and locals', () => {
  it('exports both halves byte-identically when nothing was changed', async () => {
    const project = await importPair();
    const script = scriptZero(project);
    const exported = exportSciGame(project);

    expect(exported.problems).toEqual([]);
    expect(exported.rebuilt).toEqual([]);
    expect([...exported.resources.get('heap:0')!]).toEqual([...fromBase64(script.heapBytes!)]);
    expect([...exported.resources.get('script:0')!]).toEqual([...fromBase64(script.bytes)]);
  });

  it('writes a changed property into the heap, and leaves the code alone', async () => {
    const project = await importPair();
    const script = scriptZero(project);
    const object = script.objects[0];
    const before = fromBase64(script.heapBytes!);
    const at = object.variablesAt!;

    expect(at.resource).toBe('heap');
    object.variables[2] = 0x4321;

    const exported = exportSciGame(project);
    const heap = exported.resources.get('heap:0')!;
    expect(heap[at.offset + 4]).toBe(0x21);
    expect(heap[at.offset + 5]).toBe(0x43);
    // Every other byte of the heap, and the whole code resource.
    const moved = [...heap].filter((byte, index) => byte !== before[index]);
    expect(moved).toHaveLength(2);
    expect([...exported.resources.get('script:0')!]).toEqual([...fromBase64(script.bytes)]);
    // Named as changed, once, rather than twice for a script whose heap and
    // code both moved or not at all for one whose code did not.
    expect(exported.rebuilt).toEqual([0]);
  });

  it('writes a changed local into the heap', async () => {
    const project = await importPair();
    const script = scriptZero(project);

    expect(script.localsAt).toEqual({ resource: 'heap', offset: 4 });
    expect(script.locals.length).toBeGreaterThan(0);
    script.locals[0] = 0x1111;

    const heap = exportSciGame(project).resources.get('heap:0')!;
    expect(heap[4] | (heap[5] << 8)).toBe(0x1111);
  });

  it('reads a property back as the value that was written', async () => {
    const project = await importPair();
    scriptZero(project).objects[0].variables[2] = 0x0777;
    const heap = exportSciGame(project).resources.get('heap:0')!;

    // Through the reader rather than out of the writer's own buffer: the
    // round trip is the claim, and a writer checked against itself makes it
    // by construction.
    const again = await importPair();
    const offset = scriptZero(again).objects[0].variablesAt!.offset;
    expect(heap[offset + 4] | (heap[offset + 5] << 8)).toBe(0x0777);
  });
});
