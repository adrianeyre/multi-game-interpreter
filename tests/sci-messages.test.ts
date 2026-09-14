/**
 * SCI1.1's `MESSAGE` resources, and the heap split (#221).
 *
 * Against real data as well: King's Quest VI, Freddy Pharkas, Gabriel Knight
 * and Space Quest 6 read 2,121 Messages between them, 2,049 of them plain
 * readable English, in format versions 4 and 5. And their Script resources read
 * as code and heap pairs — 256, 483 and 842 objects.
 */

import { describe, expect, it } from 'vitest';

import { SCI_KERNEL, type SciKernelWorld } from '../src/engine/sci/script/SciKernel.js';
import { reg } from '../src/engine/sci/script/PMachine.js';

import {
  audio36Number,
  messageKey,
  readSciMessages,
} from '../src/engine/sci/resource/sciMessage.js';
import { describeTextSurface } from '../src/authoring/sci/sciSource.js';

/** A version 4 resource: ten bytes of header, eleven-byte records. */
function messageResource(
  records: Array<{ key: number[]; talker: number; text: string }>,
): Uint8Array {
  const header = 10;
  const table = records.length * 11;
  const texts: number[] = [];
  const offsets: number[] = [];
  for (const record of records) {
    offsets.push(header + table + texts.length);
    for (const character of record.text) texts.push(character.charCodeAt(0));
    texts.push(0);
  }

  const out = new Uint8Array(header + table + texts.length);
  out[0] = 4000 & 0xff;
  out[1] = 4000 >> 8;
  out[8] = records.length & 0xff;
  out[9] = records.length >> 8;

  for (const [index, record] of records.entries()) {
    const at = header + index * 11;
    out.set(record.key, at);
    out[at + 4] = record.talker;
    out[at + 5] = offsets[index] & 0xff;
    out[at + 6] = offsets[index] >> 8;
  }
  out.set(texts, header + table);
  return out;
}

/**
 * `kMessage` is what a SCI1.1 game asks for its own dialogue.
 *
 * ADR 0009's move, made by Sierra two Versions after LucasArts: displayable
 * text leaves the Script resource for a resource of its own, keyed by tuple. A
 * game whose `Message` reports itself rather than answering never closes the
 * window it opened, so it never advances — which is what Freddy Pharkas and
 * Island of Dr. Brain were doing.
 */
describe('the Message Kernel call', () => {
  const world = (found: { text: string; talker: number } | null) => {
    const bytes = new Uint8Array(64);
    return {
      log: () => undefined,
      message: () => found,
      heap: {
        bytes: () => bytes,
        allocate: () => reg(1, 0),
      },
      buffer: bytes,
    } as unknown as SciKernelWorld & { buffer: Uint8Array };
  };

  it('writes the line into the buffer it was given and answers with the talker', () => {
    const w = world({ text: 'Hello.', talker: 9 });
    const result = SCI_KERNEL.Message(w, [
      reg(0, 0),
      reg(0, 210),
      reg(0, 1),
      reg(0, 2),
      reg(0, 0),
      reg(0, 1),
      reg(1, 0),
    ]);
    expect(result.offset).toBe(9);
    expect(String.fromCharCode(...w.buffer.slice(0, 6))).toBe('Hello.');
  });

  it('answers the size a script asks for before it allocates, terminator included', () => {
    const w = world({ text: 'Hello.', talker: 9 });
    const size = SCI_KERNEL.Message(w, [reg(0, 2), reg(0, 210)]);
    expect(size.offset).toBe(7);
  });

  /**
   * Reported rather than answered with an empty line, because a Kernel call
   * that quietly answers is a game that runs and does the wrong things.
   */
  it('reports a Message it does not have rather than returning an empty line', () => {
    const messages: string[] = [];
    const w = {
      log: (m: string) => messages.push(m),
      message: () => null,
      heap: { bytes: () => new Uint8Array(8) },
    } as unknown as SciKernelWorld;
    const result = SCI_KERNEL.Message(w, [reg(0, 0), reg(0, 210), reg(0, 1)]);
    expect(result.offset).toBe(0);
    expect(messages.join(' ')).toMatch(/No Message 210:1,0,0,0/);
  });

  it('reports a sub-function it does not implement, by number', () => {
    const messages: string[] = [];
    const w = {
      log: (m: string) => messages.push(m),
    } as unknown as SciKernelWorld;
    // Sierra's own list ends at the last-message query, so twenty is past the
    // end of it. Six used to be the number here and is now `push`.
    SCI_KERNEL.Message(w, [reg(0, 20)]);
    expect(messages.join(' ')).toMatch(/sub-function 20 is not implemented/);
  });
});

/**
 * A conversation is one `get` and then `next` until it runs out.
 *
 * Sierra keeps a **cursor stack**, not a tuple: `get` initialises it, `next`
 * reads where it points and steps `seq` on by one, and a record carrying a
 * reference pushes that reference on top so a sequence continuing into another
 * returns to the first when the second ends. Without `next` a game says its
 * opening line and stops, which is what King's Quest VII was doing — its room
 * 960 walks nine sequences on one visit, the longest thirty lines.
 */
describe('walking a Message sequence', () => {
  /** A world whose Messages are a fixed table, keyed the way SCI keys them. */
  const talking = (
    records: Array<{
      key: [number, number, number, number];
      talker: number;
      text: string;
      reference?: [number, number, number, number];
    }>,
  ) => {
    const bytes = new Uint8Array(64);
    const logs: string[] = [];
    const find = (k: { noun: number; verb: number; cond: number; seq: number }) =>
      records.find(
        (r) =>
          r.key[0] === k.noun && r.key[1] === k.verb && r.key[2] === k.cond && r.key[3] === k.seq,
      );
    return {
      logs,
      buffer: bytes,
      world: {
        log: (m: string) => logs.push(m),
        messageModules: () => [210],
        messageRecord: (
          _m: number,
          k: { noun: number; verb: number; cond: number; seq: number },
        ) => {
          const r = find(k);
          if (!r) return null;
          return r.reference
            ? {
                text: r.text,
                talker: r.talker,
                reference: {
                  noun: r.reference[0],
                  verb: r.reference[1],
                  cond: r.reference[2],
                  seq: r.reference[3],
                },
              }
            : { text: r.text, talker: r.talker };
        },
        heap: { bytes: () => bytes },
      } as unknown as SciKernelWorld,
    };
  };

  const read = (bytes: Uint8Array) => {
    let out = '';
    for (const byte of bytes) {
      if (byte === 0) break;
      out += String.fromCharCode(byte);
    }
    return out;
  };

  it('reads a sequence line by line and stops when it runs out', () => {
    const { world, buffer, logs } = talking([
      { key: [1, 0, 0, 1], talker: 3, text: 'One.' },
      { key: [1, 0, 0, 2], talker: 3, text: 'Two.' },
      { key: [1, 0, 0, 3], talker: 4, text: 'Three.' },
    ]);
    const target = reg(1, 0);

    expect(
      SCI_KERNEL.Message(world, [
        reg(0, 0),
        reg(0, 210),
        reg(0, 1),
        reg(0, 0),
        reg(0, 0),
        reg(0, 1),
        target,
      ]).offset,
    ).toBe(3);
    expect(read(buffer)).toBe('One.');

    buffer.fill(0);
    expect(SCI_KERNEL.Message(world, [reg(0, 1), target]).offset).toBe(3);
    expect(read(buffer)).toBe('Two.');

    buffer.fill(0);
    expect(SCI_KERNEL.Message(world, [reg(0, 1), target]).offset).toBe(4);
    expect(read(buffer)).toBe('Three.');

    // The end of a sequence answers nought, and says so as an ending rather
    // than as a missing line.
    expect(SCI_KERNEL.Message(world, [reg(0, 1), target]).offset).toBe(0);
    expect(logs.join(' ')).toMatch(/ended after 3 lines/);
  });

  /**
   * A reference is a **continuation**, not a redirection: the cursor pushes it,
   * reads it out, and pops back to where it left off.
   */
  it('follows a reference and returns to the sequence that referred to it', () => {
    const { world, buffer } = talking([
      { key: [1, 0, 0, 1], talker: 3, text: 'Before.', reference: [2, 0, 0, 1] },
      { key: [2, 0, 0, 1], talker: 9, text: 'Aside.' },
      { key: [1, 0, 0, 2], talker: 3, text: 'After.' },
    ]);
    const target = reg(1, 0);

    SCI_KERNEL.Message(world, [
      reg(0, 0),
      reg(0, 210),
      reg(0, 1),
      reg(0, 0),
      reg(0, 0),
      reg(0, 1),
      target,
    ]);
    expect(read(buffer)).toBe('Aside.');

    buffer.fill(0);
    SCI_KERNEL.Message(world, [reg(0, 1), target]);
    expect(read(buffer)).toBe('After.');
  });

  /**
   * **SCI32 renumbers the sub-functions above three**, and stubs three off.
   * ScummVM's `kMessage` does `if (func > 3) func--`. Getting this wrong is
   * silent — every number still lands on a handler, just the one next door.
   */
  it('shifts the sub-functions above three down by one at SCI32', () => {
    const { world, logs } = talking([]);
    const sci32 = { ...world, machine: { version: 'sci2-1-middle' } } as unknown as SciKernelWorld;

    SCI_KERNEL.Message(sci32, [reg(0, 3)]);
    expect(logs.join(' ')).toMatch(/not a sub-function at SCI2 and later/);

    // Seven at SCI32 is the pop that SCI1.1 numbers six, so it reports an empty
    // stack rather than reporting itself unimplemented.
    logs.length = 0;
    SCI_KERNEL.Message(sci32, [reg(0, 8)]);
    expect(logs.join(' ')).toMatch(/pop was asked for with nothing pushed/);
  });
});

describe('a MESSAGE resource', () => {
  it('reads its records and their text', () => {
    const resource = messageResource([
      { key: [1, 2, 0, 1], talker: 7, text: 'Look at that.' },
      { key: [1, 2, 0, 2], talker: 7, text: 'Really look.' },
    ]);
    const read = readSciMessages(resource);

    expect(read.version).toBe(4);
    expect(read.messages).toHaveLength(2);
    expect(read.messages[0]).toMatchObject({
      noun: 1,
      verb: 2,
      cond: 0,
      seq: 1,
      talker: 7,
      text: 'Look at that.',
    });
    expect(read.messages[1].text).toBe('Really look.');
  });

  /**
   * A reference of four zeroes is "no reference", and a Message keyed by four
   * zeroes is a real Message — so the two have to be told apart rather than one
   * standing in for the other.
   */
  it('tells an absent reference from a reference to the zero key', () => {
    const resource = messageResource([{ key: [0, 0, 0, 0], talker: 1, text: 'hello' }]);
    expect(readSciMessages(resource).messages[0].reference).toBeUndefined();

    resource[10 + 7] = 3;
    expect(readSciMessages(resource).messages[0].reference).toEqual({
      noun: 3,
      verb: 0,
      cond: 0,
      seq: 0,
    });
  });

  it('answers nothing for a resource shorter than its own header', () => {
    expect(readSciMessages(new Uint8Array(4)).messages).toEqual([]);
  });
});

describe('the tuple that ties a Message to its three faces', () => {
  /**
   * The shape #221 and #222 insist on: text, recorded speech and `sync36` mouth
   * timing are one authored item with three faces under one key, not three
   * parallel tables that happen to share it. Modelling them as parallel tables
   * is how a translation gets the right words and the wrong lip sync.
   */
  it('keys all three faces the same way', () => {
    const key = { noun: 1, verb: 2, cond: 0, seq: 1 };
    expect(messageKey(key)).toBe('1,2,0,1');
    // The `audio36` and `sync36` resource numbers are the tuple packed into the
    // number itself, which is why no table has to join them.
    expect(audio36Number(key)).toBe(0x01020001);
  });
});

describe('what the editor says about a game s words', () => {
  it('names the surface that applies, rather than implying completeness', () => {
    expect(describeTextSurface(true)).toMatch(/noun, verb, condition and sequence/);
    expect(describeTextSurface(false)).toMatch(/no MESSAGE resources/);
  });
});

/**
 * `sync36`, which is the third face of a line of dialogue (#221).
 *
 * The issue's own phrasing is the assertion: mouth timing is "associated with
 * its Message by key, not by a parallel index". A `sync36` resource is numbered
 * by the packed tuple, so text, recording and timing are found by asking for
 * the same key — and nothing has to keep three lists in the same order.
 */
describe('mouth timing, found by the same key as the line', () => {
  it('reads pairs of a time and a cue', async () => {
    const { readSciSync } = await import('../src/engine/sci/resource/sciMessage.js');
    const resource = Uint8Array.from([10, 0, 1, 0, 20, 0, 2, 0, 0xff, 0xff]);

    expect(readSciSync(resource)).toEqual([
      { time: 10, cue: 1 },
      { time: 20, cue: 2 },
    ]);
  });

  it('keeps a last step whose cue the resource simply ends before', async () => {
    const { readSciSync } = await import('../src/engine/sci/resource/sciMessage.js');
    // A trailing time with no cue is legal and is what most lines end with, so
    // a reader that insists on pairs drops the final mouth movement of every
    // line in the game.
    expect(readSciSync(Uint8Array.from([10, 0, 1, 0, 20, 0]))).toEqual([
      { time: 10, cue: 1 },
      { time: 20, cue: -1 },
    ]);
  });

  it('stops at the terminator rather than reading whatever follows it', async () => {
    const { readSciSync } = await import('../src/engine/sci/resource/sciMessage.js');
    const resource = Uint8Array.from([5, 0, 1, 0, 0xff, 0xff, 99, 0, 99, 0]);
    expect(readSciSync(resource)).toEqual([{ time: 5, cue: 1 }]);
  });

  it('numbers a sync36 by its Message tuple, which is what joins the three', async () => {
    const { audio36Number } = await import('../src/engine/sci/resource/sciMessage.js');
    // The same function names the recording and the timing, because Sierra
    // packed the key into the resource number rather than into a table.
    expect(audio36Number({ noun: 1, verb: 2, cond: 3, seq: 4 })).toBe(
      (1 << 24) | (2 << 16) | (3 << 8) | 4,
    );
  });
});
