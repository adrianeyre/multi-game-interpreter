/**
 * Kernel calls that left the constant and missing columns in one run.
 *
 * Each `describe` is one surface: the parser's `Said` and `SetSynonyms`, the
 * save menu's `GetSaveFiles` and `CheckSaveGame`, `DirLoop`, SCI2's separate
 * spellings of the `List` sub-functions, SCI32's lines, and the handful of
 * SCI32 calls that answer a question about the machine the game runs on.
 *
 * `Said` is tested hardest, and against a source outside this project: the
 * worked examples at the foot of ScummVM's `engines/sci/parser/said.cpp`,
 * recorded against Codename: ICEMAN's vocabulary. The groups below are that
 * file's where it gives them and invented where it names only a word; what is
 * being checked is the *matching*, which a vocabulary does not change.
 */

import { describe, expect, it } from 'vitest';

import {
  NULL_REG,
  PMachine,
  reg,
  type Reg,
  type SciObject,
} from '../src/engine/sci/script/PMachine.js';
import { SCI_KERNEL, type SciKernelWorld } from '../src/engine/sci/script/SciKernel.js';
import { SciHeap } from '../src/engine/sci/script/segments.js';
import {
  buildSentence,
  matchSaid,
  readSaidSpec,
  SAID_ANY,
  SAID_NONE,
  SAID_OP,
} from '../src/engine/sci/script/sciSaid.js';
import {
  parseSciLine,
  SCI_WORD_CLASS,
  vocabularyIndex,
  type SciWord,
} from '../src/engine/sci/resource/sciVocabulary.js';
import type { SciVersion } from '../src/engine/sci/sciVersion.js';

const { verb, noun, adjective, preposition, adverb, article } = SCI_WORD_CLASS;

const WORDS: SciWord[] = [
  { word: 'look', wordClass: verb, group: 0x3f8 },
  { word: 'get', wordClass: verb, group: 0x3f9 },
  { word: 'put', wordClass: verb, group: 0x3fa },
  { word: 'climb', wordClass: verb, group: 0x426 },
  { word: 'eat', wordClass: verb, group: 0x429 },
  { word: 'use', wordClass: verb, group: 0x1a5 },
  { word: 'up', wordClass: preposition, group: 0x142 },
  { word: 'down', wordClass: preposition, group: 0x143 },
  { word: 'at', wordClass: preposition, group: 0x100 },
  { word: 'for', wordClass: preposition, group: 0x101 },
  { word: 'on', wordClass: preposition, group: 0xcb },
  { word: 'left', wordClass: adverb, group: 0x300 },
  { word: 'ladder', wordClass: noun, group: 0x81e },
  { word: 'tree', wordClass: noun, group: 0x500 },
  { word: 'board', wordClass: noun, group: 0x8af },
  { word: 'device', wordClass: noun, group: 0x8c1 },
  { word: 'book', wordClass: noun, group: 0x7f6 },
  { word: 'washer', wordClass: noun, group: 0x8c6 },
  { word: 'shaft', wordClass: noun, group: 0x8c7 },
  { word: 'rock', wordClass: noun, group: 0x600 },
  { word: 'boulder', wordClass: noun, group: 0x601 },
  { word: 'green', wordClass: adjective, group: 0x1f6 },
  { word: 'blue', wordClass: adjective, group: 0x1f7 },
  { word: 'electronic', wordClass: adjective, group: 0x21d },
  { word: 'the', wordClass: article, group: 0x001 },
  { word: 'a', wordClass: article, group: 0x002 },
];
const INDEX = vocabularyIndex(WORDS);

type SpecToken = number | '/' | ',' | '<' | '>' | '[' | ']' | '(' | ')';
const OPERATOR: Record<Exclude<SpecToken, number>, number> = {
  '/': SAID_OP.slash,
  ',': SAID_OP.comma,
  '<': SAID_OP.lt,
  '>': SAID_OP.gt,
  '[': SAID_OP.bracketOpen,
  ']': SAID_OP.bracketClose,
  '(': SAID_OP.open,
  ')': SAID_OP.close,
};

/** A said block, as a script's `said` table stores it. */
function saidBlock(...tokens: SpecToken[]): number[] {
  const bytes: number[] = [];
  for (const token of tokens) {
    if (typeof token === 'number') bytes.push(token >> 8, token & 0xff);
    else bytes.push(OPERATOR[token]);
  }
  bytes.push(SAID_OP.end);
  return bytes;
}

function said(line: string, ...tokens: SpecToken[]): string {
  const block = saidBlock(...tokens);
  const spec = readSaidSpec((index) => block[index] ?? 0, block.length);
  if (!spec) throw new Error(`spec did not parse: ${tokens.join(' ')}`);
  return matchSaid(buildSentence(parseSciLine(line, INDEX).words), spec);
}

describe('Said, against the worked examples in ScummVM’s said.cpp', () => {
  it('reads !* as "this part must be absent" and [ ] as "or say nothing"', () => {
    expect(said('green board', '[', SAID_NONE, ']', '/', 0x8af, '<', 0x1f6)).toBe('full');
    expect(said('get green board', '[', SAID_NONE, ']', '/', 0x8af, '<', 0x1f6)).toBe('no');
    expect(said('green board', '[', SAID_NONE, ']', '/', 0x8af, '[', '<', 0x1f6, ']')).toBe('full');
    expect(said('eat', 0x429, '[', '/', SAID_NONE, ']')).toBe('full');
    expect(said('eat ladder', 0x429, '[', '/', SAID_NONE, ']')).toBe('no');
  });

  it('matches a verb from a list, qualified by the preposition after it', () => {
    const climbUp = [0x19b, ',', 0x426, '[', '<', 0x142, ']', '[', '/', 0x81e, ']'] as const;
    expect(said('climb up', ...climbUp)).toBe('full');
    expect(said('climb up ladder', ...climbUp)).toBe('full');
    expect(said('climb down', ...climbUp)).toBe('no');
    expect(said('climb up tree', ...climbUp)).toBe('no');

    const climbDown = [0x19b, ',', 0x446, ',', 0x426, '[', '<', 0x143, ']', '[', '/', 0x81e, ']'];
    expect(said('climb up', ...(climbDown as SpecToken[]))).toBe('no');
    expect(said('climb down', ...(climbDown as SpecToken[]))).toBe('full');
  });

  it('treats a missing qualifier as silence and a different one as refusal', () => {
    const useDevice = [0x1a5, '/', 0x8c1, '[', '<', 0x21d, ']'] as const;
    expect(said('use green device', ...useDevice)).toBe('no');
    expect(said('use electronic device', ...useDevice)).toBe('full');
    expect(said('use device', ...useDevice)).toBe('full');

    expect(said('look at the ladder', 0x3f8, '/', 0x81e, '[', '<', SAID_NONE, ']')).toBe('full');
    expect(said('look at the green ladder', 0x3f8, '/', 0x81e, '[', '<', SAID_NONE, ']')).toBe(
      'no',
    );
    expect(said('look green book', '/', 0x7f6, '[', '<', 0x1f7, ']')).toBe('no');
    expect(said('look green book', 0x3f8, '[', '<', 0x1f6, ']')).toBe('full');
  });

  it('reads the third part as the indirect object', () => {
    const spec = [0x3f9, '/', 0x8af, '[', '<', 0x1f6, ']', '/', 0x81e, '<', 0x1f6] as const;
    expect(said('get a blue board for the green ladder', ...spec)).toBe('no');
    expect(said('get a board for the green ladder', ...spec)).toBe('full');
    expect(said('get a blue board', 0x3f9, '/', 0x8af, '[', '<', 0x1f6, ']')).toBe('no');
  });

  it('groups alternatives with parentheses', () => {
    const spec = ['(', 0x3f8, ',', 0x3f9, ')', '[', '<', '(', 0x142, ',', 0x143, ')', ']'] as const;
    expect(said('get up', ...spec)).toBe('full');
    expect(said('get left', ...spec)).toBe('no');
    expect(said('look down', ...spec)).toBe('full');
    expect(said('get', ...spec)).toBe('full');
    expect(said('put washer on shaft', 0x455, ',', '(', 0x3fa, '<', 0xcb, ')', '/', 0x8c6)).toBe(
      'full',
    );
  });

  it('matches * against anything and marks a trailing > as partial', () => {
    expect(said('look tree', 0x3f8, '/', SAID_ANY)).toBe('full');
    expect(said('look', 0x3f8, '/', SAID_ANY)).toBe('no');
    expect(said('look tree', 0x3f8, '>')).toBe('partial');
    expect(said('get tree', 0x3f8, '>')).toBe('no');
  });

  it('refuses a block with no terminator rather than reading on', () => {
    const block = [0x03, 0xf8, 0x03, 0xf8];
    expect(readSaidSpec((index) => block[index] ?? 0, block.length)).toBeNull();
  });
});

/** A machine with a few objects and Selectors, and a world around it. */
function kernelWorld(
  version: SciVersion,
  selectors: Record<string, number>,
  extra: Partial<SciKernelWorld> = {},
  scripts = new Map<number, Uint8Array>(),
) {
  const logged: string[] = [];
  const machine = new PMachine(version, {
    scriptCode: (script) => scripts.get(script) ?? null,
    callKernel: () => null,
    exportOffset: () => null,
    heapStart: () => 0,
    log: () => undefined,
  });
  machine.selectorNumbers = new Map(Object.entries(selectors));
  const heap = new SciHeap();
  const world = {
    machine,
    heap,
    input: { next: () => null },
    scriptExport: () => null,
    ticks: () => 0,
    random: () => 0,
    log: (line: string) => void logged.push(line),
    ...extra,
  } as unknown as SciKernelWorld;

  let next = 200;
  const object = (values: Record<string, number | Reg>): SciObject => {
    const names = Object.keys(values);
    const made: SciObject = {
      id: reg(1, next++),
      species: 1,
      superClass: 0,
      info: 0,
      propertyBias: 0,
      variables: names.map((name) => {
        const value = values[name];
        return typeof value === 'number' ? reg(0, value) : value;
      }),
      methods: new Map<number, number>(),
      variableSelectors: names.map((name) => selectors[name] ?? -1),
      script: 1,
      clone: false,
      name: `object${next}`,
    };
    machine.addObject(made);
    return made;
  };
  const text = (value: string): Reg => {
    const ref = heap.allocate(value.length + 1);
    const bytes = heap.bytes(ref)!;
    for (let i = 0; i < value.length; i++) bytes[i] = value.charCodeAt(i);
    return ref;
  };
  const property = (holder: SciObject, name: string): number =>
    holder.variables[holder.variableSelectors.indexOf(selectors[name] ?? -2)]?.offset ?? -1;
  return { world, machine, heap, object, text, property, logged, scripts };
}

describe('Parse and Said, through the Kernel', () => {
  const SELECTORS = { claimed: 10, elements: 11, number: 12 };

  function parserWorld() {
    const scripts = new Map<number, Uint8Array>();
    const made = kernelWorld(
      'sci0-late',
      SELECTORS,
      { parseInput: (line) => parseSciLine(line, INDEX), gameObject: () => null },
      scripts,
    );
    // Script 5's said table, addressed the way `lofsa` addresses one.
    const block = [
      ...saidBlock(0x3f8, '/', 0x81e),
      ...saidBlock(0x3f8, '>'),
      ...saidBlock(0x3f9, '/', 0x600),
    ];
    scripts.set(5, new Uint8Array(block));
    const lookLadder = reg(5, 0);
    const anyLook = reg(5, 6);
    const getRock = reg(5, 10);
    const event = made.object({ claimed: 0 });
    const parse = (line: string): Reg => SCI_KERNEL.Parse!(made.world, [made.text(line), event.id]);
    return { ...made, event, parse, lookLadder, anyLook, getRock };
  }

  it('claims the event on a full match, so the next handler is refused', () => {
    const w = parserWorld();
    expect(w.parse('look at the ladder').offset).toBe(1);
    expect(w.property(w.event, 'claimed')).toBe(0);

    expect(SCI_KERNEL.Said!(w.world, [w.lookLadder]).offset).toBe(1);
    expect(w.property(w.event, 'claimed')).toBe(1);
    // Sierra's rule: a claimed event is not matched again.
    expect(SCI_KERNEL.Said!(w.world, [w.anyLook]).offset).toBe(0);
  });

  it('matches a > spec without claiming, so the event travels on', () => {
    const w = parserWorld();
    w.parse('look at the ladder');
    expect(SCI_KERNEL.Said!(w.world, [w.anyLook]).offset).toBe(1);
    expect(w.property(w.event, 'claimed')).toBe(0);
    expect(SCI_KERNEL.Said!(w.world, [w.lookLadder]).offset).toBe(1);
  });

  it('answers no after a failed parse, and to a spec that is a number', () => {
    const w = parserWorld();
    w.parse('look at the ladder');
    expect(SCI_KERNEL.Said!(w.world, [reg(0, 5)]).offset).toBe(0);
    w.parse('look at the wibble');
    expect(SCI_KERNEL.Said!(w.world, [w.anyLook]).offset).toBe(0);
  });

  it('applies the synonyms SetSynonyms read from each region’s script', () => {
    const w = parserWorld();
    // Script 7: a SCI0 block chain of one synonyms block, "boulder" -> "rock".
    w.scripts.set(7, new Uint8Array([0x03, 0x00, 0x08, 0x00, 0x01, 0x06, 0x00, 0x06, 0, 0]));
    const room = w.object({ number: 7 });
    const list = w.heap.newList();
    w.heap.addToEnd(list, w.heap.newNode(room.id, room.id));
    const regions = w.object({ elements: list });

    w.parse('get boulder');
    expect(SCI_KERNEL.Said!(w.world, [w.getRock]).offset).toBe(0);

    SCI_KERNEL.SetSynonyms!(w.world, [regions.id]);
    w.parse('get boulder');
    expect(SCI_KERNEL.Said!(w.world, [w.getRock]).offset).toBe(1);
  });
});

describe('the save menu’s own listing', () => {
  it('lists descriptions at a 36-byte stride, slots as words, and a count', () => {
    const saves = [
      { slot: 3, description: 'By the well' },
      { slot: 1, description: 'Start' },
    ];
    const w = kernelWorld('sci0-late', {}, { savedGames: () => saves });
    const names = w.heap.allocate(36 * 3);
    const slots = w.heap.allocate(8);
    const count = SCI_KERNEL.GetSaveFiles!(w.world, [w.text('kq4'), names, slots]);
    expect(count.offset).toBe(2);

    const bytes = w.heap.bytes(names)!;
    const at = (from: number): string =>
      String.fromCharCode(...bytes.slice(from, bytes.indexOf(0, from)));
    expect(at(0)).toBe('By the well');
    expect(at(36)).toBe('Start');
    expect(bytes[72]).toBe(0);
    expect([...w.heap.bytes(slots)!.slice(0, 4)]).toEqual([3, 0, 1, 0]);

    expect(SCI_KERNEL.CheckSaveGame!(w.world, [w.text('kq4'), reg(0, 3)]).offset).toBe(1);
    expect(SCI_KERNEL.CheckSaveGame!(w.world, [w.text('kq4'), reg(0, 2)]).offset).toBe(0);
  });

  it('answers none when the host keeps no saves', () => {
    const w = kernelWorld('sci0-late', {});
    const names = w.heap.allocate(36);
    expect(SCI_KERNEL.GetSaveFiles!(w.world, [NULL_REG, names, w.heap.allocate(2)]).offset).toBe(0);
    expect(SCI_KERNEL.CheckSaveGame!(w.world, [NULL_REG, reg(0, 1)]).offset).toBe(0);
  });
});

describe('DirLoop', () => {
  const SELECTORS = { loop: 20, signal: 21, view: 22 };

  function turn(heading: number, loops = 4, signal = 0, version: SciVersion = 'sci1-late') {
    const w = kernelWorld(version, SELECTORS, { viewLoopCount: () => loops });
    const actor = w.object({ loop: 9, signal, view: 1 });
    SCI_KERNEL.DirLoop!(w.world, [actor.id, reg(0, heading)]);
    return w.property(actor, 'loop');
  }

  it('faces right, left, toward and away by the heading', () => {
    expect(turn(90)).toBe(0);
    expect(turn(270)).toBe(1);
    expect(turn(180)).toBe(2);
    expect(turn(0)).toBe(3);
    expect(turn(350)).toBe(3);
    // 45 exactly is outside the north window at SCI1, and inside it nowhere.
    expect(turn(45)).toBe(0);
  });

  it('uses SCI0 early’s narrower windows', () => {
    expect(turn(40, 4, 0, 'sci0-early')).toBe(0);
    expect(turn(20, 4, 0, 'sci0-early')).toBe(3);
  });

  it('leaves the loop alone for a View without four loops, or an actor that does not turn', () => {
    expect(turn(0, 2)).toBe(9);
    expect(turn(90, 2)).toBe(0);
    expect(turn(90, 4, 0x0800)).toBe(9);
  });
});

describe('SCI2’s own spellings of the List sub-functions', () => {
  it('answers ListAt and ListIndexOf the way List’s subs 17 and 18 do', () => {
    const w = kernelWorld('sci2', {});
    const list = w.heap.newList();
    for (const value of [5, 6, 7])
      w.heap.addToEnd(list, w.heap.newNode(reg(0, value), reg(0, value)));
    expect(SCI_KERNEL.ListAt!(w.world, [list, reg(0, 2)]).offset).toBe(7);
    expect(SCI_KERNEL.ListAt!(w.world, [list, reg(0, 9)]).offset).toBe(0);
    expect(SCI_KERNEL.ListIndexOf!(w.world, [list, reg(0, 6)]).offset).toBe(1);
    expect(SCI_KERNEL.ListIndexOf!(w.world, [list, reg(0, 8)]).offset).toBe(0xffff);
  });

  it('walks every element for EachElementDo, FirstTrue and AllTrue', () => {
    const w = kernelWorld('sci2', { flag: 30 });
    const list = w.heap.newList();
    const elements = [0, 4, 0].map((flag) => w.object({ flag }));
    for (const element of elements) w.heap.addToEnd(list, w.heap.newNode(element.id, element.id));

    expect(SCI_KERNEL.ListFirstTrue!(w.world, [list, reg(0, 30)]).offset).toBe(
      elements[1].id.offset,
    );
    expect(SCI_KERNEL.ListAllTrue!(w.world, [list, reg(0, 30)]).offset).toBe(0);
    SCI_KERNEL.ListEachElementDo!(w.world, [list, reg(0, 30), reg(0, 1)]);
    expect(elements.map((element) => w.property(element, 'flag'))).toEqual([1, 1, 1]);
    expect(SCI_KERNEL.ListAllTrue!(w.world, [list, reg(0, 30)]).offset).toBe(1);
  });
});

describe('SCI32’s lines', () => {
  function lineWorld() {
    const bitmaps = new Map<number, { width: number; height: number; pixels: Uint8Array }>();
    const items = new Map<
      string,
      { plane: string; x: number; y: number; priority: number; bitmap?: number }
    >();
    let nextBitmap = 1;
    const w = kernelWorld(
      'sci2-1-middle',
      {},
      {
        bitmapCreate: (width, height, _skip, back) => {
          const handle = nextBitmap++;
          bitmaps.set(handle, { width, height, pixels: new Uint8Array(width * height).fill(back) });
          return handle;
        },
        bitmapDestroy: (handle) => void bitmaps.delete(handle),
        bitmapFill: (handle, left, top, right, bottom, colour) => {
          const held = bitmaps.get(handle)!;
          for (let y = Math.max(0, top); y < Math.min(bottom, held.height); y++) {
            for (let x = Math.max(0, left); x < Math.min(right, held.width); x++) {
              held.pixels[y * held.width + x] = colour;
            }
          }
        },
        addScreenItem: (id, plane, item) => void items.set(id, { plane, ...item }),
        deleteScreenItem: (id) => void items.delete(id),
      },
    );
    return { ...w, bitmaps, items };
  }

  const at = (bitmap: { width: number; pixels: Uint8Array }, x: number, y: number): number =>
    bitmap.pixels[y * bitmap.width + x] ?? -1;

  it('draws a line into a bitmap its own size and hangs it on the Plane', () => {
    const w = lineWorld();
    const plane = reg(1, 50);
    const line = SCI_KERNEL.AddLine!(w.world, [
      plane,
      reg(0, 10),
      reg(0, 20),
      reg(0, 13),
      reg(0, 20),
    ]);
    const [id, item] = [...w.items][0];
    expect(id).toBe(`${line.segment}:${line.offset}`);
    expect(item).toMatchObject({ plane: '1:50', x: 10, y: 20, priority: 1000 });

    const bitmap = w.bitmaps.get(item.bitmap!)!;
    expect([bitmap.width, bitmap.height]).toEqual([4, 1]);
    // Colour 255 by default, on the skip colour 250 everywhere else.
    expect([0, 1, 2, 3].map((x) => at(bitmap, x, 0))).toEqual([255, 255, 255, 255]);
  });

  it('dashes along the major axis, eight on and eight off', () => {
    const w = lineWorld();
    const args = [reg(1, 50), reg(0, 0), reg(0, 0), reg(0, 19), reg(0, 0)];
    SCI_KERNEL.AddLine!(w.world, [...args, reg(0, 5), reg(0, 7), reg(0, 1), reg(0, 0), reg(0, 1)]);
    const item = [...w.items.values()][0];
    const bitmap = w.bitmaps.get(item.bitmap!)!;
    const drawn = Array.from({ length: 20 }, (_, x) => (at(bitmap, x, 0) === 7 ? 1 : 0)).join('');
    expect(drawn).toBe('11111111000000001111');
    expect(item.priority).toBe(5);
  });

  it('grows the box by half the thickness, which is always odd', () => {
    const w = lineWorld();
    SCI_KERNEL.AddLine!(w.world, [
      reg(1, 50),
      reg(0, 10),
      reg(0, 10),
      reg(0, 10),
      reg(0, 12),
      reg(0, 1),
      reg(0, 3),
      reg(0, 0),
      reg(0, 0),
      reg(0, 4),
    ]);
    const item = [...w.items.values()][0];
    const bitmap = w.bitmaps.get(item.bitmap!)!;
    // Thickness 4 is drawn as 3, so the box grows by one on every side.
    expect([item.x, item.y, bitmap.width, bitmap.height]).toEqual([9, 9, 3, 5]);
  });

  it('keeps colour and priority through UpdateLine and frees both on DeleteLine', () => {
    const w = lineWorld();
    const plane = reg(1, 50);
    const line = SCI_KERNEL.AddLine!(w.world, [
      plane,
      reg(0, 0),
      reg(0, 0),
      reg(0, 2),
      reg(0, 0),
      reg(0, 9),
      reg(0, 4),
      reg(0, 0),
      reg(0, 0),
      reg(0, 1),
    ]);
    SCI_KERNEL.UpdateLine!(w.world, [line, plane, reg(0, 5), reg(0, 5), reg(0, 5), reg(0, 8)]);
    expect(w.bitmaps.size).toBe(1);
    const item = [...w.items.values()][0];
    expect(item).toMatchObject({ x: 5, y: 5, priority: 9 });
    expect(at(w.bitmaps.get(item.bitmap!)!, 0, 3)).toBe(4);

    SCI_KERNEL.DeleteLine!(w.world, [line, plane]);
    expect(w.items.size).toBe(0);
    expect(w.bitmaps.size).toBe(0);
  });
});

describe('SCI32’s questions about the machine', () => {
  it('names a save catalogue and a save file the way Sierra did', () => {
    const w = kernelWorld('sci2', {});
    const out = w.heap.newArray(3, 0);
    const read = (): string => {
      let text = '';
      for (let i = 0; w.heap.arrayAt(out, i) !== 0; i++)
        text += String.fromCharCode(w.heap.arrayAt(out, i));
      return text;
    };
    expect(SCI_KERNEL.MakeSaveCatName!(w.world, [out, w.text('kq7cd')])).toEqual(out);
    expect(read()).toBe('kq7cdsg.cat');
    SCI_KERNEL.MakeSaveFileName!(w.world, [out, w.text('kq7cd'), reg(0, 3)]);
    expect(read()).toBe('kq7cdsg.003');
  });

  it('believes whichever disc it was asked for is in, and remembers it', () => {
    const w = kernelWorld('sci2-1-early', {});
    expect(SCI_KERNEL.GetSaveCDisc!(w.world, []).offset).toBe(1);
    expect(SCI_KERNEL.CheckCDisc!(w.world, [reg(0, 2)]).offset).toBe(2);
    expect(SCI_KERNEL.CheckCDisc!(w.world, []).offset).toBe(2);
    expect(SCI_KERNEL.GetSaveCDisc!(w.world, []).offset).toBe(2);
  });

  it('answers RESOURCE.CFG’s benchmarks into the string object’s data', () => {
    const w = kernelWorld('sci2-1-early', { data: 40 });
    const data = w.heap.newArray(3, 1);
    const holder = w.object({ data });
    expect(SCI_KERNEL.GetConfig!(w.world, [w.text('VideoSpeed'), holder.id])).toEqual(holder.id);
    expect(String.fromCharCode(...[0, 1, 2].map((i) => w.heap.arrayAt(data, i)))).toBe('500');
    SCI_KERNEL.GetConfig!(w.world, [w.text('nonsense'), holder.id]);
    expect(w.heap.arrayAt(data, 0)).toBe(0);
    expect(w.logged.join('\n')).toContain('"nonsense"');
  });

  it('answers the profile’s benchmark, and the default for anything else', () => {
    const w = kernelWorld('sci2-1-early', {});
    const ask = (setting: string): number =>
      SCI_KERNEL.GetSierraProfileInt!(w.world, [w.text('Config'), w.text(setting), reg(0, 7)])
        .offset;
    expect(ask('videospeed')).toBe(500);
    expect(ask('volume')).toBe(7);
  });

  it('keeps the font resolution SetFontRes names', () => {
    const asked: number[][] = [];
    const w = kernelWorld(
      'sci2-1-early',
      {},
      {
        setTextResolution: (width, height) => void asked.push([width, height]),
      },
    );
    SCI_KERNEL.SetFontRes!(w.world, [reg(0, 640), reg(0, 480)]);
    expect(asked).toEqual([[640, 480]]);
  });

  it('prints PrintDebug formatted into the log', () => {
    const w = kernelWorld('sci3', {});
    SCI_KERNEL.PrintDebug!(w.world, [w.text('room %d: %s'), reg(0, 12), w.text('lab')]);
    expect(w.logged).toContain('PrintDebug: room 12: lab');
  });

  it('says no title bar, and says which options it was asked for otherwise', () => {
    const w = kernelWorld('sci2-1-middle', {});
    expect(SCI_KERNEL.GetWindowsOption!(w.world, [reg(0, 0)]).offset).toBe(0);
    expect(w.logged).toEqual([]);
    SCI_KERNEL.GetWindowsOption!(w.world, [reg(0, 4)]);
    expect(w.logged.join('\n')).toContain('option 4');
  });

  it('reports a language switch it cannot make, once', () => {
    const w = kernelWorld('sci2-1-middle', {});
    SCI_KERNEL.SetLanguage!(w.world, [w.text('SPANISH')]);
    SCI_KERNEL.SetLanguage!(w.world, [w.text('SPANISH')]);
    expect(w.logged.filter((line) => line.includes('"SPANISH"'))).toHaveLength(1);
  });
});
