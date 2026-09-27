/**
 * The last constants, each made to do what ScummVM's does — and the one
 * mechanism several of them needed: a Kernel call that can wait.
 *
 * Sierra's interpreter could block inside a Kernel call; `KERNEL_RETRY` is how
 * this one does the same across cycles, and `InputText`, `Portrait` and
 * `DoAudio(Play)` are written on it. The rest are ordinary calls that had been
 * answering nought: collision, jumping, audio, restarting, a control's
 * highlight, memory, the platform, and Hoyle 5's poker opponents.
 */

import { describe, expect, it } from 'vitest';

import { SCI32_GAMMA_TABLES, applySci32Gamma } from '../src/engine/sci/gfx/sci32Gamma.js';
import {
  readSciPortrait,
  readSciRave,
  sciPortraitSchedule,
  type SciPortrait,
} from '../src/engine/sci/gfx/SciPortrait.js';
import { SciInput, SCI_EVENT } from '../src/engine/sci/SciInput.js';
import {
  KERNEL_RETRY,
  NULL_REG,
  PMachine,
  reg,
  type Reg,
} from '../src/engine/sci/script/PMachine.js';
import { SCI_KERNEL, type SciKernelWorld } from '../src/engine/sci/script/SciKernel.js';
import {
  classifySciPokerHand,
  sciHoyle5Poker,
  SCI_POKER_ACTION,
  SCI_POKER_HAND,
} from '../src/engine/sci/script/sciHoyle5Poker.js';
import { SciHeap } from '../src/engine/sci/script/segments.js';
import {
  decodeSciAudio,
  readSciAudio36Index,
  SciAudioChannels,
  sciAudioTicks,
  type SciPcm,
} from '../src/engine/sci/sound/sciAudioPlayer.js';
import type { SciVersion } from '../src/engine/sci/sciVersion.js';

const int = (value: number): Reg => reg(0, value & 0xffff);

const SELECTORS = [
  'x',
  'y',
  'xStep',
  'yStep',
  'signal',
  'illegalBits',
  'brLeft',
  'brTop',
  'brRight',
  'brBottom',
  'nsLeft',
  'nsTop',
  'nsRight',
  'nsBottom',
];

function makeWorld(version: SciVersion, extra: Partial<SciKernelWorld> = {}) {
  const heap = new SciHeap();
  const input = new SciInput();
  const objects = new Map<string, Reg[]>();
  let now = 0;
  let nextObject = 1;
  const world = {
    machine: {
      version,
      acc: NULL_REG,
      object: (value: Reg) => {
        const variables = objects.get(`${value.segment}:${value.offset}`);
        return variables ? { id: value, variables } : null;
      },
      selectorNumbers: new Map(SELECTORS.map((name, index) => [name, index])),
      resolveProperty: (_object: unknown, selector: number) => selector,
      byteViewAt: () => null,
    },
    heap,
    input,
    log: () => undefined,
    ticks: () => now,
    random: () => 0.5,
    ...extra,
  } as unknown as SciKernelWorld;
  const object = (values: Record<string, number>): Reg => {
    const id = reg(7, nextObject++);
    objects.set(
      `${id.segment}:${id.offset}`,
      SELECTORS.map((name) => int(values[name] ?? 0)),
    );
    return id;
  };
  const read = (id: Reg, name: string): number => {
    const value = objects.get(`${id.segment}:${id.offset}`)?.[SELECTORS.indexOf(name)]?.offset ?? 0;
    return value >= 0x8000 ? value - 0x10000 : value;
  };
  const string = (text: string): Reg => {
    const ref = heap.allocate(text.length + 1);
    heap.bytes(ref)?.set([...text].map((c) => c.charCodeAt(0)));
    return ref;
  };
  const list = (...members: Reg[]): Reg => {
    const ref = heap.newList();
    for (const member of members) heap.addToEnd(ref, heap.newNode(member, member));
    return ref;
  };
  return { world, heap, input, object, read, string, list, tick: (to: number) => (now = to) };
}

/** A second of silence at 60 samples a second: sixty-one ticks, rounded up. */
const clip = (loud = false): SciPcm => ({
  rate: 60,
  samples: new Int16Array(60).fill(loud ? 4000 : 0),
});

// ------------------------------------------------------- a call that waits ---

describe('KERNEL_RETRY', () => {
  it('puts the call back and runs it again next cycle with the same arguments', () => {
    const seen: Reg[][] = [];
    const answers: Reg[] = [KERNEL_RETRY, reg(0, 42)];
    // pushi 1; pushi 7; callk 5, 2; ret
    const code = new Uint8Array([0x39, 0x01, 0x39, 0x07, 0x43, 0x05, 0x02, 0x48]);
    const machine = new PMachine('sci1-late', {
      scriptCode: () => code,
      callKernel: (_n, args) => (seen.push([...args]), answers.shift() ?? NULL_REG),
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    machine.enter(0, 0, reg(1, 1));
    machine.run(100);
    expect(seen).toHaveLength(1);
    expect(machine.acc).toEqual(NULL_REG);
    machine.run(100);
    expect(seen).toEqual([[int(7)], [int(7)]]);
    expect(machine.acc).toEqual(reg(0, 42));
  });
});

// ----------------------------------------------------------- collision ---

describe('CanBeHere, CantBeHere and SetJump', () => {
  it('refuses a base on an illegal control colour, and then an actor in the way', () => {
    let control = 0;
    const setup = makeWorld('sci1-early', {
      graph16: { onControl: () => control } as unknown as SciKernelWorld['graph16'],
    });
    const ego = setup.object({
      brLeft: 10,
      brTop: 10,
      brRight: 20,
      brBottom: 12,
      illegalBits: 0x8000,
    });
    const rock = setup.object({ brLeft: 15, brTop: 11, brRight: 25, brBottom: 13 });
    const cast = setup.list(ego, rock);
    control = 0x8000;
    expect(SCI_KERNEL.CanBeHere(setup.world, [ego, cast]).offset).toBe(0);
    expect(SCI_KERNEL.CantBeHere(setup.world, [ego, cast]).offset).toBe(0x8000);
    control = 0x0001;
    // The control is fine, and the rock's base overlaps.
    expect(SCI_KERNEL.CantBeHere(setup.world, [ego, cast])).toEqual(rock);
    expect(SCI_KERNEL.CanBeHere(setup.world, [ego, cast]).offset).toBe(0);
    // An ignored actor walks through it.
    const ghost = setup.object({
      brLeft: 10,
      brTop: 10,
      brRight: 20,
      brBottom: 12,
      signal: 0x4000,
    });
    expect(SCI_KERNEL.CanBeHere(setup.world, [ghost, cast]).offset).toBe(1);
  });

  it('asks SCI32 only about other actors', () => {
    const setup = makeWorld('sci2');
    const ego = setup.object({ brLeft: 10, brTop: 10, brRight: 20, brBottom: 12 });
    const rock = setup.object({ brLeft: 30, brTop: 11, brRight: 40, brBottom: 13 });
    expect(SCI_KERNEL.CantBeHere(setup.world, [ego, setup.list(ego, rock)]).offset).toBe(0);
  });

  it('works out a jump’s steps the way kSetJump does', () => {
    const setup = makeWorld('sci1-early');
    const jumper = setup.object({});
    SCI_KERNEL.SetJump(setup.world, [jumper, int(30), int(0), int(3)]);
    expect(setup.read(jumper, 'xStep')).toBe(6);
    expect(setup.read(jumper, 'yStep')).toBe(-6);
    SCI_KERNEL.SetJump(setup.world, [jumper, int(0), int(-20), int(3)]);
    // Straight up: vy from the height alone, sqrt(3 * 40) + 1.
    expect(setup.read(jumper, 'xStep')).toBe(0);
    expect(setup.read(jumper, 'yStep')).toBe(-11);
  });
});

// --------------------------------------------------------------- audio ---

describe('DoAudio', () => {
  it('decodes SOL DPCM and measures in ticks', () => {
    const pcm = decodeSciAudio(
      { sampleRate: 11025, length: 3, sixteenBit: true, compressed: true, dataOffset: 0 },
      new Uint8Array([0x01, 0x01, 0x81]),
    );
    expect([...pcm.samples]).toEqual([8, 16, 8]);
    const raw = decodeSciAudio(
      { sampleRate: 11025, length: 2, sixteenBit: false, compressed: false, dataOffset: 0 },
      new Uint8Array([128, 255]),
    );
    expect([...raw.samples]).toEqual([0, 127 << 8]);
    expect(sciAudioTicks(clip())).toBe(61);
  });

  it('reads a late audio36 map, with a sync and King’s Quest VI’s rave before the speech', () => {
    const map = new Uint8Array([
      // base offset 1000
      0xe8,
      0x03,
      0x00,
      0x00,
      // noun 1 verb 2 cond 3 seq 4, sync and rave flags; +0; sync 10; rave 6
      1,
      2,
      3,
      4 | 0xc0,
      0,
      0,
      0,
      10,
      0,
      6,
      0,
      // noun 1 verb 2 cond 3 seq 5, no flags; +500
      1,
      2,
      3,
      5,
      0xf4,
      0x01,
      0,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
      0xff,
    ]);
    // Not SCI32: King's Quest VI is SCI1.1, and ScummVM reads the rave flag
    // for that game and never from SCI2 on. The eleven trailing 0xff bytes
    // are what select the late form here, as its heuristic reads them.
    const entries = readSciAudio36Index(map, false);
    expect(entries[0]).toMatchObject({
      seq: 4,
      sync: { offset: 1000, size: 10 },
      rave: { offset: 1010, size: 6 },
      offset: 1016,
    });
    expect(entries[1]).toMatchObject({ seq: 5, offset: 1500 });
  });

  it('plays one SCI16 sample: its length, its clock, and the play counter', () => {
    const audio = new SciAudioChannels({ capacity: 1, now: () => now });
    let now = 0;
    let loaded = false;
    const { world } = makeWorld('sci1-1', {
      audio,
      audioClip: () => (loaded ? clip() : undefined),
    });
    world.ticks = () => now;
    // Not read yet: the call waits for it.
    expect(SCI_KERNEL.DoAudio(world, [int(2), int(7)])).toBe(KERNEL_RETRY);
    loaded = true;
    expect(SCI_KERNEL.DoAudio(world, [int(2), int(7)]).offset).toBe(61);
    expect(SCI_KERNEL.DoAudio(world, [int(13)]).offset).toBe(1);
    now = 30;
    expect(SCI_KERNEL.DoAudio(world, [int(6)]).offset).toBe(30);
    SCI_KERNEL.DoAudio(world, [int(4)]);
    now = 50;
    expect(SCI_KERNEL.DoAudio(world, [int(6)]).offset).toBe(30);
    SCI_KERNEL.DoAudio(world, [int(5)]);
    now = 200;
    expect(SCI_KERNEL.DoAudio(world, [int(6)]).offset).toBe(0xffff);
    // SCI1.1 answers its capability check with one.
    expect(SCI_KERNEL.DoAudio(world, [int(9)]).offset).toBe(1);
  });

  it('mixes SCI32 channels, pauses one, fades one, and hears the monitored one', () => {
    let now = 0;
    const audio = new SciAudioChannels({ capacity: 5, now: () => now });
    const { world } = makeWorld('sci2-1-middle', {
      audio,
      audioClip: (id) => clip(id.endsWith(':2')),
    });
    expect(SCI_KERNEL.DoAudio(world, [int(2), int(1)]).offset).toBe(61);
    // A tuple, with loop 0 and a volume out of range, which means "monitor".
    SCI_KERNEL.DoAudio(world, [int(2), int(10), int(1), int(1), int(1), int(2), int(0), int(-1)]);
    expect(SCI_KERNEL.DoAudio(world, [int(2)]).offset).toBe(2);
    expect(SCI_KERNEL.DoAudio(world, [int(17)]).offset).toBe(1);
    now = 5;
    expect(SCI_KERNEL.DoAudio(world, [int(4), int(1)]).offset).toBe(1);
    now = 20;
    // Paused at 5, so the clock stopped there.
    expect(SCI_KERNEL.DoAudio(world, [int(6), int(1)]).offset).toBe(5);
    expect(
      SCI_KERNEL.DoAudio(world, [int(15), int(1), int(0), int(1), int(10), int(1)]).offset,
    ).toBe(1);
    SCI_KERNEL.DoAudio(world, [int(5), int(1)]);
    now = 40;
    // Faded to nought and stopped, as asked.
    expect(SCI_KERNEL.DoAudio(world, [int(6), int(1)]).offset).toBe(0xffff);
    expect(SCI_KERNEL.DoAudio(world, [int(3)]).offset).toBe(1);
  });
});

// ------------------------------------------------------------ Portrait ---

describe('Portrait lip-sync', () => {
  const portrait: SciPortrait = {
    width: 2,
    height: 2,
    palette: [],
    bitmaps: [0, 1, 2].map(() => ({
      width: 2,
      height: 2,
      displaceX: 0,
      displaceY: 0,
      pixels: new Uint8Array(4),
    })),
    lipSync: new Map([
      [
        ('A'.charCodeAt(0) << 8) | 'B'.charCodeAt(0),
        [
          { ticks: 1, bitmap: 2 },
          { ticks: 4, bitmap: 3 },
        ],
      ],
    ]),
  };

  it('reads a rave script and times its mouth frames', () => {
    const rave = readSciRave(new Uint8Array([...'10 AB 5 AB'].map((c) => c.charCodeAt(0))));
    expect(rave).toEqual([
      { ticks: 10, id: 0x4142 },
      { ticks: 5, id: 0x4142 },
    ]);
    expect(sciPortraitSchedule(portrait, rave)).toEqual([
      { at: 10, bitmap: 1 },
      { at: 13, bitmap: 2 },
      { at: 15, bitmap: 1 },
      { at: 18, bitmap: 2 },
    ]);
    expect(readSciPortrait(new Uint8Array(3))).toBeNull();
  });

  it('holds the game while the line plays, moving the mouth to the audio clock', () => {
    let now = 0;
    const frames: Array<number | null> = [];
    const audio = new SciAudioChannels({ capacity: 1, now: () => now });
    const setup = makeWorld('sci1-1', {
      audio,
      audioClip: () => clip(),
      portraitShow: () => true,
      portraitSchedule: () => [
        { at: 10, bitmap: 1 },
        { at: 20, bitmap: 2 },
      ],
      portraitFrame: (_name: string, bitmap: number | null) => frames.push(bitmap),
    } as Partial<SciKernelWorld>);
    const show = () =>
      SCI_KERNEL.Portrait(setup.world, [
        int(1),
        setup.string('alex'),
        int(0),
        int(0),
        int(899),
        int(1),
        int(2),
        int(3),
        int(4),
        int(0),
      ]);
    expect(show()).toBe(KERNEL_RETRY);
    now = 12;
    expect(show()).toBe(KERNEL_RETRY);
    expect(frames).toEqual([1]);
    now = 25;
    // The schedule is spent: the closed mouth, and SIGNAL_REG.
    expect(show().offset).toBe(0xffff);
    expect(frames).toEqual([1, 2, null]);
  });
});

// ------------------------------------------------------------ InputText ---

describe('InputText, held open', () => {
  it('draws its box, takes keys as they arrive, and finishes on Enter', () => {
    const boxes: unknown[] = [];
    const setup = makeWorld('sci2', {
      measureText: (text: string) => ({ width: text.length * 4, height: 8 }),
      showTextEditor: (box: unknown) => boxes.push(box),
    } as Partial<SciKernelWorld>);
    const target = setup.heap.newArray(3, 8);
    const call = () => SCI_KERNEL.InputText(setup.world, [target, setup.string('Name?'), int(10)]);
    expect(call()).toBe(KERNEL_RETRY);
    expect(boxes.at(-1)).toMatchObject({
      title: 'Name?',
      text: '',
      rect: { width: 44, height: 23 },
    });
    setup.input.post({
      type: SCI_EVENT.keyDown,
      message: 'o'.charCodeAt(0),
      modifiers: 0,
      x: 0,
      y: 0,
    });
    expect(call()).toBe(KERNEL_RETRY);
    expect(boxes.at(-1)).toMatchObject({ text: 'o', cursor: 1 });
    setup.input.post({ type: SCI_EVENT.keyDown, message: 13, modifiers: 0, x: 0, y: 0 });
    expect(call().offset).toBe(1);
    expect(boxes.at(-1)).toBeNull();
    expect(setup.heap.arrayAt(target, 0)).toBe('o'.charCodeAt(0));
  });
});

// ------------------------------------------------------------- the rest ---

describe('the calls that were constants', () => {
  it('keeps a memory segment across a restart, and answers memory as ScummVM does', () => {
    const { world, string, heap } = makeWorld('sci1-early');
    const source = string('keep me');
    expect(SCI_KERNEL.MemorySegment(world, [int(0), source, int(0)])).toEqual(source);
    const into = heap.allocate(16);
    SCI_KERNEL.MemorySegment(world, [int(1), into]);
    expect(String.fromCharCode(...(heap.bytes(into) ?? []).slice(0, 7))).toBe('keep me');
    expect(SCI_KERNEL.MemoryInfo(world, [int(0)]).offset).toBe(0x7fe8);
    expect(SCI_KERNEL.MemoryInfo(world, [int(1)]).offset).toBe(0x7fea);
  });

  it('answers the restarting flag and clears it on nought', () => {
    let flag = 1;
    const { world } = makeWorld('sci1-early', {
      restarting: { flag: () => flag, clear: () => (flag = 0) },
    });
    expect(SCI_KERNEL.GameIsRestarting(world, []).offset).toBe(1);
    expect(SCI_KERNEL.GameIsRestarting(world, [int(0)]).offset).toBe(1);
    expect(SCI_KERNEL.GameIsRestarting(world, []).offset).toBe(0);
    let restarted = false;
    (world as { restartGame?: () => void }).restartGame = () => (restarted = true);
    SCI_KERNEL.RestartGame(world, []);
    expect(restarted).toBe(true);
  });

  it('answers the platform, the device and a path comparison', () => {
    const { world, string, heap } = makeWorld('sci1-early');
    expect(SCI_KERNEL.Platform(world, [int(4)]).offset).toBe(1);
    expect(SCI_KERNEL.Platform(world, [int(5)]).offset).toBe(1);
    expect(SCI_KERNEL.Platform(world, [])).toEqual(NULL_REG);
    const out = heap.allocate(8);
    SCI_KERNEL.DeviceInfo(world, [int(1), out]);
    expect(heap.bytes(out)?.[0]).toBe('/'.charCodeAt(0));
    expect(SCI_KERNEL.DeviceInfo(world, [int(2), string('*.sav'), string('GAME.SAV')]).offset).toBe(
      1,
    );
    expect(SCI_KERNEL.DisposeScript(world, [int(5), int(9)]).offset).toBe(9);
    const block = heap.allocate(4);
    SCI_KERNEL.UnLoad(world, [int(0x85), block]);
    expect(heap.bytes(block)).toBeNull();
  });

  it('inverts a control’s rectangle to highlight it, and shows a debug map', () => {
    const inverted: unknown[] = [];
    let shown = '';
    const setup = makeWorld('sci0-late', {
      graph16: {
        invertRect: (rect: unknown) => inverted.push(rect),
      } as unknown as SciKernelWorld['graph16'],
      showMap: (map: string) => (shown = map),
    } as Partial<SciKernelWorld>);
    const button = setup.object({ nsLeft: 5, nsTop: 6, nsRight: 30, nsBottom: 16 });
    SCI_KERNEL.HiliteControl(setup.world, [button]);
    expect(inverted).toEqual([{ left: 5, top: 6, right: 30, bottom: 16 }]);
    SCI_KERNEL.Show(setup.world, [int(3)]);
    expect(shown).toBe('control');
  });

  it('presents SCI32 colours through the gamma table and leaves 255 white', () => {
    const rgba = new Uint8ClampedArray(1024).fill(100);
    const out = new Uint8ClampedArray(1024);
    expect(applySci32Gamma(rgba, out, 0)).toBe(true);
    expect(out[0]).toBe(SCI32_GAMMA_TABLES[0][100]);
    expect(out[0]).toBeGreaterThan(100);
    expect([out[1020], out[1021], out[1022]]).toEqual([255, 255, 255]);
    expect(applySci32Gamma(rgba, out, 9)).toBe(false);
  });
});

// ---------------------------------------------------------------- poker ---

describe('Hoyle 5’s poker engine', () => {
  function table(hands: Array<Array<[number, number]>>, extra: Record<number, number> = {}) {
    const data = new Map<number, number>(Object.entries(extra).map(([k, v]) => [Number(k), v]));
    hands.forEach((hand, player) =>
      hand.forEach(([rank, suit], card) => {
        data.set(19 + player * 10 + card * 2, rank);
        data.set(20 + player * 10 + card * 2, suit);
      }),
    );
    return {
      get: (i: number) => data.get(i) ?? 0,
      set: (i: number, v: number) => data.set(i, v),
      data,
    };
  }
  const royal: Array<[number, number]> = [
    [1, 3],
    [13, 3],
    [12, 3],
    [11, 3],
    [10, 3],
  ];
  const pairs: Array<[number, number]> = [
    [9, 0],
    [9, 1],
    [4, 2],
    [4, 3],
    [2, 0],
  ];
  const junk: Array<[number, number]> = [
    [2, 0],
    [5, 1],
    [8, 2],
    [11, 3],
    [13, 0],
  ];

  it('classifies hands and picks the winner, ignoring a folded player', () => {
    expect(
      classifySciPokerHand(royal.map(([rank, suit]) => ({ rank: rank === 1 ? 14 : rank, suit })))
        .handType,
    ).toBe(SCI_POKER_HAND.royalFlush);
    const showdown = table([pairs, royal, junk, junk], { 0: 2, 9: -1 });
    sciHoyle5Poker(showdown, () => 0);
    expect(showdown.data.get(62)).toBe(0b0001);
    expect(showdown.data.get(61)).toBe(SCI_POKER_HAND.twoPairs);
  });

  it('keeps two pairs and throws the odd card', () => {
    const think = table([pairs], { 0: 3 });
    sciHoyle5Poker(think, () => 0);
    expect([63, 64, 65, 66, 67].map((i) => think.data.get(i))).toEqual([0, 0, 0, 0, 1]);
  });

  it('raises a made hand when betting is free', () => {
    const bet = table([royal], { 0: 1, 4: 500 });
    sciHoyle5Poker(bet, () => 99);
    expect(bet.data.get(60)).toBe(SCI_POKER_ACTION.raise);
  });

  it('is reached through WinDLL with the game’s array', () => {
    const { world, heap, string } = makeWorld('sci2-1-middle');
    const data = heap.newArray(0, 90);
    heap.arrayPut(data, 0, 4);
    royal.forEach(([rank, suit], card) => {
      heap.arrayPut(data, 19 + card * 2, rank);
      heap.arrayPut(data, 20 + card * 2, suit);
    });
    expect(SCI_KERNEL.WinDLL(world, [int(2), string('PENGIN16.DLL'), data]).offset).toBe(1);
    expect(heap.arrayAt(data, 61)).toBe(SCI_POKER_HAND.royalFlush);
  });
});
