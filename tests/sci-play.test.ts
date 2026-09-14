/**
 * SCI0 play: the parser, sound and a graph-shaped save (#219).
 *
 * Each of the three is checked against real data as well: the Space Quest III
 * demo's `vocab.000` reads 16,884 words and parses "look at the door" to four
 * groups with nothing unknown, and its sound resources carry MT-32, AdLib, CMS
 * and General MIDI arrangements in the same resource.
 */

import { describe, expect, it } from 'vitest';

import {
  parseSciLine,
  readSciVocabulary,
  vocabularyIndex,
  SCI_WORD_CLASS,
} from '../src/engine/sci/resource/sciVocabulary.js';
import {
  arrangementFor,
  describeSound,
  readSci0Sound,
} from '../src/engine/sci/sound/sciSoundResource.js';
import { captureSciState, restoreSciState } from '../src/engine/sci/save/SciSaveState.js';
import { PMachine, reg } from '../src/engine/sci/script/PMachine.js';
import { SciHeap } from '../src/engine/sci/script/segments.js';

/** A vocabulary with two words under one letter, prefix-compressed. */
function vocabulary(): Uint8Array {
  const out = new Uint8Array(64);
  // Letter 'l' is index 11; its words start at 52.
  out[11 * 2] = 52;
  let at = 52;
  // "look": nothing shared, four characters with the high bit on the last.
  out[at++] = 0;
  for (const character of 'loo') out[at++] = character.charCodeAt(0);
  out[at++] = 'k'.charCodeAt(0) | 0x80;
  // Class 2 (verb) in the top twelve bits, group 100 in the bottom twelve.
  const packed = (SCI_WORD_CLASS.verb << 12) | 100;
  out[at++] = (packed >> 16) & 0xff;
  out[at++] = (packed >> 8) & 0xff;
  out[at++] = packed & 0xff;
  out[at] = 0xff;
  return out;
}

describe('the parser vocabulary', () => {
  /**
   * Words are prefix-compressed, and a reader that ignores that field produces
   * a vocabulary of *suffixes* — `ook` for `look` — after which every parse
   * fails without anything erroring.
   */
  it('reads a word and its group', () => {
    const words = readSciVocabulary(vocabulary());
    expect(words).toHaveLength(1);
    expect(words[0]).toMatchObject({ word: 'look', group: 100 });
  });

  it('reduces a line to the groups a said matches, and names what it did not know', () => {
    const index = vocabularyIndex(readSciVocabulary(vocabulary()));
    const parsed = parseSciLine('look at wibble', index);

    expect(parsed.groups).toEqual([100]);
    // Reported rather than dropped: a parser that silently discards an unknown
    // word answers "I don't understand" to a sentence it half-understood.
    expect(parsed.unknown).toEqual(['at', 'wibble']);
  });
});

describe('a sound resource, which is not a track', () => {
  /**
   * #219's own wording, and the mistake it exists to prevent: a sound resource
   * carries several **Device arrangements** and the interpreter picks one at
   * play time. There is deliberately no `body` field to reach for.
   */
  it('carries an arrangement per device rather than a body', () => {
    const resource = new Uint8Array(64);
    resource[0] = 0;
    // Channel 0 for MT-32 and AdLib; channel 1 for AdLib only.
    resource[1] = 0x01 | 0x08;
    resource[3] = 0x08;

    const sound = readSci0Sound(resource);
    expect(sound.arrangements.map((a) => a.device).sort()).toEqual(['adlib', 'mt32']);
    expect(arrangementFor(sound, ['adlib'])?.channels).toEqual([0, 1]);
    expect(arrangementFor(sound, ['mt32'])?.channels).toEqual([0]);
    expect(describeSound(sound)).toMatch(/adlib \(2 channels\)/);
  });

  /**
   * Selected rather than assumed. A resource with no arrangement for the wanted
   * device answers nothing rather than falling back to whichever is first —
   * MT-32 data through an AdLib synthesiser is noise at the right length, which
   * passes every check except listening.
   */
  it('answers nothing rather than the wrong arrangement', () => {
    const resource = new Uint8Array(64);
    resource[1] = 0x01;
    expect(arrangementFor(readSci0Sound(resource), ['amiga'])).toBeNull();
  });
});

describe('a save, which is a heap and not a schema (ADR 0019)', () => {
  function world(): { machine: PMachine; heap: SciHeap } {
    const machine = new PMachine('sci0-late', {
      scriptCode: () => new Uint8Array([0x48]),
      callKernel: () => null,
      exportOffset: () => null,
      heapStart: () => 0,
      log: () => undefined,
    });
    const heap = new SciHeap();
    return { machine, heap };
  }

  const template = {
    species: 3,
    superClass: 0,
    info: 0,
    propertyBias: 0,
    script: 1,
    methods: new Map<number, number>(),
    variableSelectors: [0, 1, 2],
    clone: false,
  };

  /**
   * The distinction that decides correctness: a static object is restored by
   * reloading its script and re-applying what changed, and a Clone has to be
   * recreated whole because nothing has any record of it. Confuse the two and a
   * save loads a world that looks right and whose actors are not the ones the
   * scripts hold pointers to.
   */
  it('writes a static object as its changes and a Clone whole', () => {
    const { machine, heap } = world();
    const statik = {
      ...template,
      id: reg(1, 100),
      variables: [reg(0, 3), reg(0, 0), reg(0, 7)],
    };
    machine.addObject(statik);
    const clone = machine.clone(statik.id)!;
    machine.object(clone)!.variables[2] = reg(0, 42);

    const saved = captureSciState(machine, heap, () => [reg(0, 3), reg(0, 0), reg(0, 0)]);

    expect(saved.statics).toHaveLength(1);
    // A property is written as a reference, segment and all (save format 2).
    expect(saved.statics[0].changed).toEqual([[2, [0, 7]]]);
    expect(saved.clones).toHaveLength(1);
    // Whole, and as references — a Clone's property may hold a pointer, and
    // format 1 wrote only the offset.
    expect(saved.clones[0].variables).toEqual([
      [0, 3],
      [0, 0],
      [0, 42],
    ]);
  });

  it('restores Clones before the statics that may refer to them', () => {
    const { machine, heap } = world();
    const statik = { ...template, id: reg(1, 100), variables: [reg(0, 3), reg(0, 0), reg(0, 0)] };
    machine.addObject(statik);
    const clone = machine.clone(statik.id)!;
    machine.object(clone)!.variables[2] = reg(0, 42);
    // A static object holding a pointer to a Clone — the case ADR 0019 says
    // decides correctness, and the one a bare number could not express.
    statik.variables[1] = clone;

    const saved = captureSciState(machine, heap, () => [reg(0, 3), reg(0, 0), reg(0, 0)]);

    // A fresh machine with only the script's objects, as a reload would give.
    const fresh = world();
    fresh.machine.addObject({
      ...template,
      id: reg(1, 100),
      variables: [reg(0, 3), reg(0, 0), reg(0, 0)],
    });
    restoreSciState(fresh.machine, fresh.heap, saved);

    expect(fresh.machine.clones.size).toBe(1);
    expect(fresh.machine.object(clone)?.variables[2]).toEqual(reg(0, 42));
    // The segment survives now, so the restored property points at the Clone
    // rather than at whatever lives at that offset in segment zero.
    expect(fresh.machine.object(reg(1, 100))?.variables[1]).toEqual(clone);
  });

  /**
   * A Clone from the previous run has no backing anywhere, so leaving one
   * behind leaves an object the restored graph does not know about and
   * something may still reach.
   */
  it('discards the Clones of the run it is replacing', () => {
    const { machine, heap } = world();
    machine.addObject({
      ...template,
      id: reg(1, 100),
      variables: [reg(0, 3), reg(0, 0), reg(0, 0)],
    });
    machine.clone(reg(1, 100));
    expect(machine.clones.size).toBe(1);

    restoreSciState(machine, heap, {
      globals: [],
      locals: [],
      statics: [],
      clones: [],
      lists: [],
      nodes: [],
    });
    expect(machine.clones.size).toBe(0);
  });

  it('round-trips the interpreter lists as references, not as numbers', () => {
    const { machine, heap } = world();
    const list = heap.newList();
    const node = heap.newNode(reg(1, 100), reg(0, 5));
    heap.addToEnd(list, node);

    const saved = captureSciState(machine, heap, () => null);
    const fresh = world();
    restoreSciState(fresh.machine, fresh.heap, saved);

    expect(fresh.heap.list(list)?.first).toEqual(node);
    expect(fresh.heap.node(node)?.value).toEqual(reg(1, 100));
  });
});

describe('digital audio, read by offset (#221)', () => {
  /**
   * Straight Talkie precedent: one file a script indexes into by byte offset,
   * with a table in front of it. Read through `VolumeReader` a sample at a time
   * rather than buffered (ADR 0021), which matters more here than for SCUMM
   * because a SCI2.1 release's speech is hundreds of megabytes — Space Quest
   * 6's demo alone ships a 114 MB `RESOURCE.AUD`.
   */
  it('reads the base map as a number and an offset', async () => {
    const { readSciAudioMap } = await import('../src/engine/sci/sound/sciAudio.js');
    const map = new Uint8Array([
      0xe1,
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // 225 at 0
      0x0e,
      0x01,
      0x5a,
      0x0c,
      0x00,
      0x00, // 270 at 0xc5a
      0xff,
      0xff,
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    expect(readSciAudioMap(map)).toEqual([
      { number: 225, offset: 0, volume: 'aud' },
      { number: 270, offset: 0xc5a, volume: 'aud' },
    ]);
  });

  /**
   * The size byte in the middle of the signature is the thing to get right.
   * Reading it as five contiguous bytes from zero fails on every sample in
   * every game, and that is how it was found: Space Quest 6's `RESOURCE.AUD`
   * opens `8d 0c 53 4f 4c 00`, and the check was looking for `8d 53 4f 4c 00`.
   */
  it('reads a SOL header past its own size byte', async () => {
    const { readSciAudioHeader } = await import('../src/engine/sci/sound/sciAudio.js');
    const head = new Uint8Array(64);
    head.set([0x8d, 0x0c, 0x53, 0x4f, 0x4c, 0x00], 0);
    head[6] = 0x22;
    head[7] = 0x56; // 22050
    head[8] = 0x0d;
    head[9] = 0xe4;
    head[10] = 0x72;
    head[11] = 0x01;

    const sample = readSciAudioHeader(head)!;
    expect(sample.sampleRate).toBe(22050);
    expect(sample.length).toBe(0x000172e4);
    expect(sample.sixteenBit).toBe(true);
    expect(sample.compressed).toBe(true);
    expect(sample.dataOffset).toBe(14);
  });

  /**
   * Freddy Pharkas's demo ships plain RIFF WAVE where Space Quest 6 ships SOL.
   * Recognised rather than refused: a release choosing the other container is
   * not a fault, and no Version predicts which.
   */
  it('recognises a RIFF WAVE, which some releases ship instead', async () => {
    const { readSciAudioHeader } = await import('../src/engine/sci/sound/sciAudio.js');
    const head = new Uint8Array(64);
    head.set([0x52, 0x49, 0x46, 0x46], 0);
    head[24] = 0x22;
    head[25] = 0x56;
    head[34] = 16;

    const sample = readSciAudioHeader(head)!;
    expect(sample.sampleRate).toBe(22050);
    expect(sample.sixteenBit).toBe(true);
    expect(sample.dataOffset).toBe(44);
  });

  /**
   * A wrong offset announces itself rather than playing whatever is there.
   * Audio decoded from the wrong place is noise at some length — the one fault
   * class that cannot be seen in a report and can only be heard.
   */
  it('answers nothing for bytes that are not a sample', async () => {
    const { readSciAudioHeader } = await import('../src/engine/sci/sound/sciAudio.js');
    expect(readSciAudioHeader(new Uint8Array(64))).toBeNull();
  });
});
