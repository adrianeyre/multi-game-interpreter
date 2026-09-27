/**
 * Adding a room by copying one, and deleting one this editor added (row 12,
 * `sciRoomAdd.ts`). Graph-level, over the same shape `sci-rooms.test.ts`
 * derives rooms from, with heap bytes behind the room so the export has
 * somewhere to write its `picture` word.
 */

import { describe, expect, it } from 'vitest';

import type { SciProject, SciProjectObject } from '../src/authoring/project.js';
import { toBase64 } from '../src/authoring/base64.js';
import { exportSciGame } from '../src/authoring/sci/exportSciGame.js';
import {
  addSciRoom,
  deleteSciRoom,
  describeSciRoomAdding,
} from '../src/authoring/sci/sciRoomAdd.js';
import { sciRooms } from '../src/authoring/sci/sciRooms.js';
import { kernelNamesFor } from '../src/engine/sci/script/kernel.js';
import type { SciProjectInstruction } from '../src/authoring/project.js';

const SELECTORS = ['-objID-', 'x', 'y', 'view', 'loop', 'cel', 'priority', 'picture'];

function object(over: Partial<SciProjectObject> & { name: string }): SciProjectObject {
  return {
    isClass: false,
    species: 100,
    superClass: 100,
    variables: [],
    variableSelectors: [],
    methods: [],
    ...over,
  };
}

function project(): SciProject {
  const heap = new Uint8Array(32);
  heap[10 + 14] = 95; // the room's picture word
  return {
    identification: { how: 'probe', evidence: [] },
    version: 'sci1-1',
    selectors: SELECTORS,
    classes: [],
    scripts: [
      {
        number: 0,
        objects: [object({ name: 'Room', isClass: true, species: 82, superClass: 0xffff })],
        exports: [],
        locals: [],
        bytes: toBase64(new Uint8Array([1, 2, 3, 4])),
      },
      {
        number: 30,
        objects: [
          object({
            name: 'rm30',
            superClass: 82,
            variables: [0, 0, 0, 0, 0, 0, 0, 95],
            variableSelectors: [0, 1, 2, 3, 4, 5, 6, 7],
            variablesAt: { resource: 'heap', offset: 10 },
          }),
        ],
        exports: [],
        locals: [],
        bytes: toBase64(new Uint8Array([9, 9, 9, 9])),
        heapBytes: toBase64(heap),
      },
    ],
    resources: [],
    messages: [],
    vectorPictures: [{ type: 'pic', number: 95, bytes: toBase64(new Uint8Array([0xf0, 1, 0xff])) }],
    celPictures: [],
    languages: [],
    unrecoveredCount: 0,
  };
}

describe('adding a room', () => {
  it('copies the room script under a new number, which the export writes', () => {
    const next = addSciRoom(project(), 30, 31);
    if (typeof next === 'string') throw new Error(next);
    expect(sciRooms(next).map((room) => [room.script, room.picture])).toEqual([
      [30, 95],
      [31, 95],
    ]);
    const exported = exportSciGame(next);
    expect(exported.problems).toEqual([]);
    expect(exported.resources.get('script:31')).toEqual(exported.resources.get('script:30'));
    expect(exported.resources.get('heap:31')).toEqual(exported.resources.get('heap:30'));
  });

  it('copies its Picture to a number of its own and points the room at it', () => {
    const next = addSciRoom(project(), 30, 31, { picture: 96 });
    if (typeof next === 'string') throw new Error(next);
    expect(sciRooms(next).find((room) => room.script === 31)?.picture).toBe(96);
    const exported = exportSciGame(next);
    expect(exported.resources.get('pic:96')).toEqual(exported.resources.get('pic:95'));
    expect(exported.resources.get('heap:31')![24]).toBe(96);
    // The source is untouched.
    expect(exported.resources.get('heap:30')![24]).toBe(95);
  });

  it('deletes only what it added, Picture included', () => {
    const original = project();
    const next = addSciRoom(original, 30, 31, { picture: 96 });
    if (typeof next === 'string') throw new Error(next);
    const back = deleteSciRoom(next, 31);
    if (typeof back === 'string') throw new Error(back);
    expect(back).toEqual(original);
    expect(deleteSciRoom(original, 30)).toMatch(/one the game shipped/);
  });

  it('refuses by name', () => {
    expect(addSciRoom(project(), 30, 0)).toMatch(/already exists/);
    expect(addSciRoom(project(), 30, 31, { picture: 95 })).toMatch(/Picture 95 already exists/);
    expect(describeSciRoomAdding(project(), 0)).toMatch(/defines no instance of Room/);
    const withClass = project();
    withClass.scripts[1].objects.push(object({ name: 'Door', isClass: true, species: 7 }));
    expect(describeSciRoomAdding(withClass, 30)).toMatch(/defines Door/);
  });
});

/** `Message(0, module, …)` with the module pushed as `module`. */
function messageCall(module: SciProjectInstruction): SciProjectInstruction[] {
  const MESSAGE = kernelNamesFor('sci1-1').indexOf('Message');
  return [
    { offset: 0, name: 'pushi', operands: [2], raw: 0x39 },
    { offset: 2, name: 'pushi', operands: [0], raw: 0x39 },
    { ...module, offset: 4 },
    { offset: 6, name: 'callk', operands: [MESSAGE, 4], raw: 0x43 },
  ];
}

function withWords(
  extra: SciProjectInstruction[] = [],
  module?: SciProjectInstruction,
): SciProject {
  const base = project();
  base.resources.push({ type: 'message', number: 30, bytes: toBase64(new Uint8Array([1, 2])) });
  base.messages.push({
    resource: 30,
    noun: 1,
    verb: 2,
    cond: 0,
    seq: 1,
    talker: 0,
    text: 'Hello',
    audio: 99,
  });
  base.scripts[1].objects[0].methods.push({
    selector: 'init',
    selectorNumber: 1,
    offset: 0,
    instructions: [
      ...messageCall(module ?? { offset: 4, name: 'pushi', operands: [30], raw: 0x39 }),
      ...extra,
    ],
  });
  return base;
}

describe('a copied room reads its own words', () => {
  it('copies its Messages and points the module argument at them', () => {
    const original = withWords();
    const next = addSciRoom(original, 30, 31);
    if (typeof next === 'string') throw new Error(next);
    const copy = next.scripts.find((one) => one.number === 31)!;
    expect(copy.objects[0].methods[0].instructions[2].operands[0]).toBe(31);
    expect(original.scripts[1].objects[0].methods[0].instructions[2].operands[0]).toBe(30);
    expect(copy.addedRoom).toMatchObject({ words: ['message'], retargeted: 1 });
    expect(next.resources.find((one) => one.type === 'message' && one.number === 31)?.bytes).toBe(
      original.resources.find((one) => one.type === 'message' && one.number === 30)?.bytes,
    );
    // The line comes with it, without the recording keyed by the old room.
    expect(next.messages.filter((one) => one.resource === 31)).toEqual([
      { resource: 31, noun: 1, verb: 2, cond: 0, seq: 1, talker: 0, text: 'Hello' },
    ]);

    const back = deleteSciRoom(next, 31);
    expect(back).toEqual(original);
  });

  it('leaves a module taken from a variable, which is the new room at run time', () => {
    const next = addSciRoom(
      withWords([], { offset: 4, name: 'lsg', operands: [11], raw: 0x89 }),
      30,
      31,
    );
    if (typeof next === 'string') throw new Error(next);
    expect(next.scripts.find((one) => one.number === 31)?.addedRoom?.retargeted).toBe(0);
  });

  it('refuses, by place, a literal of the room number it cannot identify', () => {
    const stray = { offset: 8, name: 'pushi', operands: [30], raw: 0x39 };
    expect(addSciRoom(withWords([stray]), 30, 31)).toMatch(
      /rm30::init holds the number 30 at 8 where the disassembly cannot tell/,
    );
  });

  it('refuses a Message call whose arguments are not pushed straight before it', () => {
    const odd = { offset: 4, name: 'ldi', operands: [5], raw: 0x35 };
    expect(addSciRoom(withWords([], odd), 30, 31)).toMatch(/could not be identified/);
  });
});

describe('a copied room’s procedures are scanned too', () => {
  it('retargets a module passed to Message from an exported procedure', () => {
    const base = withWords([], { offset: 4, name: 'lsg', operands: [11], raw: 0x89 });
    base.scripts[1].procedures = [
      {
        selector: 'procedure0',
        selectorNumber: -1,
        offset: 40,
        instructions: messageCall({ offset: 4, name: 'pushi', operands: [30], raw: 0x39 }),
      },
    ];
    const next = addSciRoom(base, 30, 31);
    if (typeof next === 'string') throw new Error(next);
    const copy = next.scripts.find((one) => one.number === 31)!;
    expect(copy.procedures![0].instructions[2].operands[0]).toBe(31);
    expect(copy.addedRoom?.retargeted).toBe(1);
  });

  it('refuses where an exported procedure could not be read', () => {
    const base = withWords();
    base.scripts[1].unreadProcedures = [77];
    expect(addSciRoom(base, 30, 31)).toMatch(/procedure at 77 that did not disassemble/);
  });
});

describe('a copied room keeps its speech', () => {
  it('writes the room’s audio map under the new number, pointing at the same recordings', () => {
    const base = withWords();
    // A per-room map: one early-form entry — the tuple, a 32-bit offset into
    // RESOURCE.AUD and a sync size — then the terminator.
    const map = new Uint8Array([1, 2, 0, 1, 0x10, 0, 0, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]);
    base.resources.push({ type: 'map', number: 30, bytes: toBase64(map) });
    const next = addSciRoom(base, 30, 31);
    if (typeof next === 'string') throw new Error(next);

    const copied = next.resources.find((one) => one.type === 'map' && one.number === 31);
    expect(copied?.bytes).toBe(toBase64(map));
    // The line keeps its recording, because the map for its new room lists it.
    expect(next.messages.find((one) => one.resource === 31)?.audio).toBe(99);

    expect(deleteSciRoom(next, 31)).toEqual(base);
  });

  it('refuses when an audio map already has the new number', () => {
    const base = withWords();
    base.resources.push({ type: 'map', number: 30, bytes: toBase64(new Uint8Array([0xff])) });
    base.resources.push({ type: 'map', number: 31, bytes: toBase64(new Uint8Array([0xff])) });
    expect(addSciRoom(base, 30, 31)).toMatch(/audio map 31 already exists/);
  });
});
