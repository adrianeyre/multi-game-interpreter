/**
 * Relinking a SCI1.1 code-and-heap script, where a body may change length.
 *
 * **This was the gap `docs/editor-parity.md` row 22 named**, and it is the one
 * that mattered most: every SCI release from 1992 on ships this layout — King's
 * Quest VII's 218 scripts included — so "a body may be changed but not
 * lengthened or shortened" was the answer for almost the whole family.
 *
 * The linker is held to two gates, because they prove different halves and the
 * first one alone proves less than it looks:
 *
 * 1. **A no-edit relink is byte-identical.** This exercises `emitSciMethod`
 *    round-tripping every body and nothing else, because with no length change
 *    the linker writes bodies where they already are. On King's Quest VII it is
 *    218 of 218 scripts and 3,929 of 3,929 methods.
 * 2. **A relayout keeps every other body intact.** One body is lengthened, so
 *    every byte after it moves, and every *untouched* method must still decode
 *    to exactly the instructions it did before. That is the gate that says the
 *    method dictionaries, the export table and the relocation table were all
 *    followed.
 *
 * Both were measured against the retail game; these hold them against a fixture
 * so they fail on a machine that owns nothing.
 */

import { describe, expect, it } from 'vitest';

import {
  describeSciRelinking,
  linkSci11Script,
  sciScriptIsHeapPair,
} from '../src/authoring/sci/sciLinker.js';
import { toBase64 } from '../src/authoring/base64.js';
import type { SciProjectScript } from '../src/authoring/project.js';

const u16 = (value: number): number[] => [value & 0xff, (value >> 8) & 0xff];

/**
 * A faithful SCI1.1 code resource, built rather than borrowed.
 *
 * The shared `buildSci11Fixture` puts a **SCI0 block chain** in its script and
 * a heap resource beside it, which is enough for the probes that read it and is
 * not a code-and-heap pair — so a linker test against it would be testing the
 * wrong layout. This is the real shape:
 *
 *     u16 relocation offset · u16 · u16 · u16 export count · exports
 *     … method bodies and the dictionaries between them …
 *     u16 relocation count · that many positions
 *
 * One object, one method, one dictionary entry pointing at the body, and a
 * relocation table naming a position inside the body — which is what has to
 * move when the body grows.
 */
function heapPair(): { script: SciProjectScript; codeEnd: number } {
  const header = [...u16(0), ...u16(0), ...u16(0), ...u16(1), ...u16(0)];
  const bodyAt = header.length;
  // `pushi 1; push0; ret` — three instructions, so one can be duplicated.
  const body = [0x39, 0x01, 0x76, 0x48];
  const dictionaryAt = bodyAt + body.length;
  const dictionary = [...u16(1), ...u16(42), ...u16(bodyAt)];
  const relocationAt = dictionaryAt + dictionary.length;
  const relocation = [...u16(1), ...u16(bodyAt + 1)];

  const code = [...header, ...body, ...dictionary, ...relocation];
  // The first word says where the relocation table begins.
  code[0] = relocationAt & 0xff;
  code[1] = (relocationAt >> 8) & 0xff;
  // Export 0 names the procedure at the body, so it must move with it.
  code[8] = bodyAt & 0xff;
  code[9] = (bodyAt >> 8) & 0xff;

  // The heap: a relocation pointer, no locals, then one object whose second
  // property word is its method dictionary.
  const heap = [
    ...u16(0),
    ...u16(0),
    ...u16(0x1234),
    ...u16(6),
    ...u16(0),
    ...u16(dictionaryAt),
    ...u16(0),
  ];

  const script: SciProjectScript = {
    number: 0,
    objects: [
      {
        name: 'anObject',
        isClass: false,
        species: 1,
        superClass: 0,
        variables: [0, dictionaryAt, 0],
        variableSelectors: [],
        variableOffsets: [],
        methods: [
          {
            selector: 'doit',
            selectorNumber: 42,
            offset: bodyAt,
            // `raw` carries the operand width — its low bit is what decides
            // whether `pushi` is two bytes or three — so an instruction list
            // without it re-emits at a different length and moves everything
            // after it. `0x39` is `pushi` narrow, `0x76` `push0`, `0x48` `ret`.
            instructions: [
              { offset: bodyAt, name: 'pushi', operands: [1], raw: 0x39 },
              { offset: bodyAt + 2, name: 'push0', operands: [], raw: 0x76 },
              { offset: bodyAt + 3, name: 'ret', operands: [], raw: 0x48 },
            ],
          },
        ],
      },
    ],
    exports: [bodyAt],
    locals: [],
    bytes: toBase64(new Uint8Array(code)),
    heapBytes: toBase64(new Uint8Array(heap)),
  } as unknown as SciProjectScript;

  return { script, codeEnd: relocationAt };
}

describe('a SCI1.1 script is relinked rather than refused', () => {
  it('is recognised as a code-and-heap pair, not a block chain', () => {
    expect(sciScriptIsHeapPair(heapPair().script)).toBe(true);
  });

  it('no longer says same-length-only about one', () => {
    expect(describeSciRelinking(heapPair().script)).toBeNull();
  });

  /**
   * Gate one. Nothing changed size, so nothing may move — and the linker takes
   * its in-place path rather than rebuilding, because rebuilding would risk a
   * difference where the whole point is that there is none. Against the retail
   * King's Quest VII this is 218 of 218 scripts and 3,929 of 3,929 methods.
   */
  it('relinks with no edit to the same bytes it was given', () => {
    const { script } = heapPair();
    const result = linkSci11Script(script);
    expect(result.refused).toBeUndefined();
    expect(result.moved).toBe(0);
    expect([...result.bytes]).toEqual([...Buffer.from(script.bytes, 'base64')]);
  });

  /**
   * Gate two, and the one that tests the relayout rather than the re-emission:
   * a longer body moves every byte after it, so a dictionary entry, an export
   * or a relocation position that was not followed now points into the middle
   * of something.
   */
  it('follows the dictionary, the export and the relocation table when a body grows', () => {
    const { script, codeEnd } = heapPair();
    const target = script.objects[0].methods[0];
    const grown: SciProjectScript = {
      ...script,
      objects: [
        {
          ...script.objects[0],
          methods: [{ ...target, instructions: [target.instructions[0], ...target.instructions] }],
        },
      ],
    };

    const before = linkSci11Script(script);
    const after = linkSci11Script(grown);
    expect(after.refused).toBeUndefined();
    expect(after.bytes.length).toBe(before.bytes.length + 2);
    expect(after.moved).toBeGreaterThan(0);

    const read = (at: number): number => after.bytes[at] | (after.bytes[at + 1] << 8);

    // The relocation table still ends the resource, which is `sci11CodeEnd`'s
    // own test and the cheapest proof the tail moved as a unit.
    const relocationAt = read(0);
    expect(relocationAt).toBe(codeEnd + 2);
    expect(relocationAt + 2 + read(relocationAt) * 2).toBe(after.bytes.length);

    // The body did not move — it grew in place — so the export and the
    // dictionary still name its start, and the relocation position inside it
    // is where it was.
    const bodyAt = script.objects[0].methods[0].offset;
    expect(read(8)).toBe(bodyAt);
    expect(read(relocationAt + 2)).toBe(bodyAt + 1);

    // **The dictionary moved, and the heap was told.** Its position is read
    // back out of the rewritten heap rather than from the project's copy —
    // reading it from the copy is what hid a real fault here, because the copy
    // is right whether or not the heap was written.
    expect(after.heapBytes).toBeDefined();
    const heap = after.heapBytes!;
    const heapRead = (at: number): number => heap[at] | (heap[at + 1] << 8);
    const objectAt = 4 + heapRead(2) * 2;
    const dictionaryAt = heapRead(objectAt + 4 + 2);
    expect(dictionaryAt).toBe(script.objects[0].variables[1] + 2);
    expect(read(dictionaryAt + 2 + 2)).toBe(bodyAt);
  });
});
