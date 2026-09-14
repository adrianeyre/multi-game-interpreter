/**
 * Broken Sword II's streamed sound container: the codec, and a rebuild.
 *
 * Written against a format no install reachable from this repository ships.
 * Both Broken Sword II builds here are the DOS demo, whose `resource.inf`
 * names fourteen clusters and no container, so every container in this file is
 * one this project's own writer built. That is a real limit and it is stated
 * rather than papered over: these tests prove the reader and the writer agree
 * with each other and with ScummVM's description of the layout, and they prove
 * nothing about a retail `SPEECH1.CLU`.
 *
 * What _is_ measured against shipped data is the codec. `encodeSword2Clu` and
 * `decodeSword2Clu` are run over real recordings out of the two demos in
 * `npm run reexport:sword`, reported as a sample difference — because a delta
 * codec with eight amplitudes is lossy by construction and comparing bytes
 * would be measuring the wrong thing.
 */
import { describe, expect, it } from 'vitest';
import {
  decodeSword2Clu,
  encodeSword2Clu,
  parseSword2CluIndex,
  Sword2CluError,
  SWORD2_CLU_RATE,
} from '../src/engine/sword2/sound/sword2Clu.js';
import {
  rebuildSword2Sound,
  readSword2Sound,
  Sword2SoundError,
} from '../src/authoring/sword2/soundContainer.js';
import { writeWavePcm } from '../src/engine/sound/wave.js';

/** A container, built the way the format describes one. */
function container(payloads: ReadonlyArray<Uint8Array | null>, gap = 0): Uint8Array {
  const head = 8 + payloads.length * 8;
  const total =
    head + payloads.reduce<number>((sum, payload) => sum + (payload ? payload.length + gap : 0), 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, payloads.length, true);
  let at = head;
  payloads.forEach((payload, index) => {
    if (!payload) return;
    at += gap;
    view.setUint32(8 + index * 8, at, true);
    view.setUint32(8 + index * 8 + 4, payload.length, true);
    out.set(payload, at);
    at += payload.length;
  });
  return out;
}

/** A PCM WAVE an author might drop on a row. */
function wav(samples: readonly number[]): Uint8Array {
  return writeWavePcm(Int16Array.from(samples), SWORD2_CLU_RATE);
}

describe('the compression Broken Sword II streams its speech with', () => {
  it('reads a payload the way the original’s own reader does', () => {
    // Transcribed from ScummVM `CLUInputStream::refill`: two bytes of first
    // sample, then `(amplitude << shift)` added or subtracted per byte.
    //   0x01 -> amplitude 1, shift 0, add      -> +1
    //   0x11 -> amplitude 1, shift 1, add      -> +2
    //   0x09 -> amplitude 1, shift 0, subtract -> -1
    const samples = decodeSword2Clu(Uint8Array.from([0x00, 0x00, 0x01, 0x11, 0x09]));
    expect([...samples]).toEqual([0, 1, 3, 2]);
  });

  it('takes the first sample little-endian and signed', () => {
    expect(decodeSword2Clu(Uint8Array.from([0x00, 0x80, 0x00]))[0]).toBe(-32768);
    expect(decodeSword2Clu(Uint8Array.from([0xff, 0x7f, 0x00]))[0]).toBe(32767);
  });

  it('wraps at sixteen bits, as the original’s uint16 running sample does', () => {
    // 32767 + 1 is -32768 here, and an encoder that reasoned in wider
    // arithmetic would write a byte this disagrees with.
    expect([...decodeSword2Clu(Uint8Array.from([0xff, 0x7f, 0x01]))]).toEqual([32767, -32768]);
  });

  it('truncates the step to sixteen bits too, so 7 << 15 is nothing', () => {
    // `uint16 delta = GetCompressedAmplitude(*in) << GetCompressedShift(*in)`.
    // 0xf4 is amplitude 4 shifted 15, which is 131,072 and therefore 0 in
    // sixteen bits; 0xf7 is amplitude 7 shifted 15, which keeps its 0x8000.
    expect([...decodeSword2Clu(Uint8Array.from([0x64, 0x00, 0xf4]))]).toEqual([100, 100]);
    expect([...decodeSword2Clu(Uint8Array.from([0x64, 0x00, 0xf7]))]).toEqual([100, -32668]);
  });

  it('writes one byte per sample after a two-byte first sample', () => {
    const payload = encodeSword2Clu(Int16Array.from([5, 6, 7, 8]));
    expect(payload.length).toBe(5);
    // Which is what the index's length word means: the engine plays one sample
    // fewer than the payload has bytes.
    expect(payload.length - 1).toBe(4);
  });

  it('round-trips exactly where every step is one the format can say', () => {
    const samples = Int16Array.from([0, 7, 14, 7, 0, -7, -14, -7, 0]);
    expect([...decodeSword2Clu(encodeSword2Clu(samples))]).toEqual([...samples]);
  });

  it('encodes against what the decoder will hold, so error does not accumulate', () => {
    // A ramp of 9 per sample is not a step this format has: 8 and 16 are, 9 is
    // not. A greedy encoder that measured its error against the sample it
    // wanted rather than the one it wrote would drift further every sample.
    const samples = new Int16Array(2000);
    for (let at = 0; at < samples.length; at++) samples[at] = at * 9 - 9000;
    const back = decodeSword2Clu(encodeSword2Clu(samples));
    let worst = 0;
    for (let at = 0; at < samples.length; at++) {
      worst = Math.max(worst, Math.abs(back[at]! - samples[at]!));
    }
    expect(worst).toBeLessThanOrEqual(4);
  });

  it('refuses a payload too short to be one, and samples that are not there', () => {
    expect(() => decodeSword2Clu(Uint8Array.from([1, 2]))).toThrow(Sword2CluError);
    expect(() => encodeSword2Clu(new Int16Array(0))).toThrow(Sword2CluError);
  });
});

describe('reading a Broken Sword II sound container’s index', () => {
  it('takes the count from the front and the table from byte eight', () => {
    const bytes = container([encodeSword2Clu(Int16Array.from([1, 2, 3]))]);
    const index = parseSword2CluIndex('speech1.clu', bytes)!;
    expect(index.count).toBe(1);
    expect(index.indexBytes).toBe(16);
    expect(index.locate(0)).toEqual({ index: 0, at: 16, length: 4 });
  });

  it('reads a slot with no offset or length as a recording the release never made', () => {
    const bytes = container([null, encodeSword2Clu(Int16Array.from([1, 2, 3]))]);
    const index = parseSword2CluIndex('speech1.clu', bytes)!;
    expect(index.count).toBe(2);
    expect(index.locate(0)).toBeNull();
    expect(index.entries()).toHaveLength(1);
  });

  it('answers null for a resource cluster, which is the other .clu in this family', () => {
    // A cluster's first word is the byte offset of its own tail table; a
    // container's is the number of entries in its index. Reading one as the
    // other is the mistake this check exists for.
    const cluster = new Uint8Array(64);
    new DataView(cluster.buffer).setUint32(0, 40, true);
    expect(parseSword2CluIndex('General.clu', cluster)).toBeNull();
  });

  it('answers null when a payload would start inside the index', () => {
    const bytes = container([encodeSword2Clu(Int16Array.from([1, 2, 3]))]);
    new DataView(bytes.buffer).setUint32(8, 4, true);
    expect(parseSword2CluIndex('speech1.clu', bytes)).toBeNull();
  });

  it('keeps the payload bound when a prefix is all that was read', () => {
    // How an editor lists a half-gigabyte container: the header and the table
    // by range, and nothing else. Passing `bytes.length` as the file's length
    // would reject every payload in it.
    const bytes = container([encodeSword2Clu(Int16Array.from([1, 2, 3]))]);
    const prefix = bytes.subarray(0, 16);
    expect(parseSword2CluIndex('speech1.clu', prefix)).toBeNull();
    expect(parseSword2CluIndex('speech1.clu', prefix, null)?.locate(0)?.at).toBe(16);
  });
});

describe('rebuilding a Broken Sword II sound container', () => {
  const one = encodeSword2Clu(Int16Array.from([100, 107, 114]));
  const two = encodeSword2Clu(Int16Array.from([-8, -1, 6, 13]));

  it('copies it byte for byte when nothing was replaced', () => {
    const bytes = container([one, two]);
    const rebuilt = rebuildSword2Sound('speech1.clu', bytes);
    expect([...rebuilt.data]).toEqual([...bytes]);
    expect(rebuilt.copied).toBe(2);
    expect(rebuilt.replaced).toEqual([]);
  });

  it('carries the bytes between two recordings, so a padded container keeps its length', () => {
    const bytes = container([one, two], 3);
    expect([...rebuildSword2Sound('music1.clu', bytes).data]).toEqual([...bytes]);
  });

  it('writes a replacement and moves everything after it', () => {
    const bytes = container([one, two]);
    const samples = [0, 7, 14, 21, 28, 21, 14, 7];
    const rebuilt = rebuildSword2Sound('speech1.clu', bytes, [{ index: 0, wav: wav(samples) }]);
    expect(rebuilt.replaced).toEqual(['speech1.clu entry 0']);
    expect(rebuilt.copied).toBe(1);

    const index = parseSword2CluIndex('speech1.clu', rebuilt.data)!;
    // The one that was replaced reads back as what was written, through the
    // index the rebuild wrote rather than through the rebuild's own bookkeeping.
    expect([...readSword2Sound(rebuilt.data, index.locate(0)!)]).toEqual(samples);
    // And the one after it is unchanged, at the offset the rebuild gave it.
    expect([...readSword2Sound(rebuilt.data, index.locate(1)!)]).toEqual([-8, -1, 6, 13]);
    // Two entries is a 24-byte index, and the replacement is one byte per
    // sample after a two-byte first sample.
    expect(index.locate(1)!.at).toBe(24 + samples.length + 1);
  });

  it('shares a payload two entries point at, as the file does', () => {
    const bytes = container([one, two]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8 + 8, view.getUint32(8, true), true);
    view.setUint32(8 + 12, one.length, true);
    const rebuilt = rebuildSword2Sound('speech1.clu', bytes, [{ index: 0, wav: wav([0, 7, 14]) }]);
    const index = parseSword2CluIndex('speech1.clu', rebuilt.data)!;
    expect(index.locate(1)!.at).toBe(index.locate(0)!.at);
    expect(index.locate(1)!.length).toBe(index.locate(0)!.length);
  });

  it('refuses a replacement for an id the release never recorded', () => {
    const bytes = container([null, two]);
    expect(() =>
      rebuildSword2Sound('speech1.clu', bytes, [{ index: 0, wav: wav([1, 2]) }]),
    ).toThrow(/holds no recording under 0/);
  });

  it('refuses two entries at one offset with two different lengths', () => {
    const bytes = container([one, two]);
    const view = new DataView(bytes.buffer);
    view.setUint32(8 + 8, view.getUint32(8, true), true);
    view.setUint32(8 + 12, one.length - 1, true);
    expect(() => rebuildSword2Sound('speech1.clu', bytes)).toThrow(Sword2SoundError);
  });

  it('refuses anything that is not a PCM WAVE, rather than writing silence', () => {
    const bytes = container([one]);
    expect(() =>
      rebuildSword2Sound('speech1.clu', bytes, [
        { index: 0, wav: Uint8Array.from([0x49, 0x44, 0x33, 0x04]) },
      ]),
    ).toThrow(/not a PCM WAVE/);
  });

  it('refuses a file that is not one of these containers', () => {
    expect(() => rebuildSword2Sound('General.clu', new Uint8Array(64))).toThrow(
      /does not begin with a Broken Sword II sound index/,
    );
  });
});
