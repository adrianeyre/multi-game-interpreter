/**
 * AGOS's numbered sound effects.
 *
 * The last subsystem the VGA host seam had nothing behind it for. The container
 * turns out to be the *speech* container, which is why this is a thin layer
 * rather than a second reader — and why the two resources had to be told apart
 * by name at the load site, a bug these tests are partly about.
 */
import { describe, expect, it } from 'vitest';
import { readEffectsIndex } from '../src/engine/agos/sound/effects.js';

/**
 * An offset-table container holding `clips` VOC entries.
 *
 * Built rather than fetched, so the shape under test is explicit. The table is
 * a 32-bit offset per entry and the second word is its size in bytes, which is
 * what gives the count.
 */
function containerOf(clips: readonly Uint8Array[]): Uint8Array {
  const tableBytes = (clips.length + 1) * 4;
  const total = tableBytes + clips.reduce((sum, clip) => sum + clip.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);

  // Entry 0's offset is 0, which is the real container's own quirk: the span it
  // names is the table itself.
  let at = tableBytes;
  view.setUint32(0, 0, true);
  for (const [index, clip] of clips.entries()) {
    view.setUint32((index + 1) * 4, at, true);
    out.set(clip, at);
    at += clip.length;
  }
  return out;
}

/** A minimal Creative Voice File: the signature, a header offset, and a block. */
function voc(sample = 0x80): Uint8Array {
  const out = new Uint8Array(0x20 + 8);
  out.set(new TextEncoder().encode('Creative Voice File\x1a'), 0);
  const view = new DataView(out.buffer);
  view.setUint16(0x14, 0x1a, true); // where the blocks start
  out[0x1a] = 1; // a sound-data block
  view.setUint32(0x1b, 4, true); // three length bytes, then the type byte
  out[0x1e] = 0xa6; // the rate divisor
  out[0x1f] = 0; // 8-bit unsigned PCM
  out[0x20] = sample;
  out[0x21] = sample;
  return out;
}

describe('reading an effects resource', () => {
  it('reads the clips and reports how many there are', () => {
    const index = readEffectsIndex(containerOf([voc(), voc(), voc()]));

    expect(index.entries).toHaveLength(3);
  });

  it('reports entry 0 as absent, because the span it names is the table', () => {
    // The failure this prevents: handing the offset table to the mixer and
    // playing it as audio. Filtered by what the bytes *are* rather than by
    // index, so a release with other holes is covered without knowing where.
    const index = readEffectsIndex(containerOf([voc()]));

    expect(index.read(0)).toBeUndefined();
    expect(index.entries.map((each) => each.index)).not.toContain(0);
  });

  it('decodes a clip to samples', () => {
    const index = readEffectsIndex(containerOf([voc(0xc0)]));
    const first = index.entries[0]!;

    const decoded = index.decode(first.index);

    expect(decoded?.samples.length).toBeGreaterThan(0);
    expect(decoded?.sampleRate).toBeGreaterThan(0);
  });

  it('reports an effect number it has nothing for, rather than guessing', () => {
    const index = readEffectsIndex(containerOf([voc()]));

    expect(index.read(99)).toBeUndefined();
    expect(index.decode(99)).toBeUndefined();
  });
});

describe('telling the effects resource apart from the speech one', () => {
  /**
   * The bug, as a test of the rule rather than of the engine.
   *
   * A CD release ships `effects.voc` beside `simon.voc`, the file list is
   * alphabetical, and the loader took the first `.voc` it found — so the
   * *effects* file was read as the speech index. It failed quietly because both
   * really are offset tables of VOC clips: the shape agreed and only the
   * contents were wrong, which is the hardest kind of wrong to notice.
   */
  const isEffects = (name: string): boolean =>
    /^effects\.(voc|wav)$/i.test(name.split(/[\\/]/).pop() ?? name);

  it('picks the speech file even when the effects file sorts before it', () => {
    const names = ['effects.voc', 'gamepc', 'simon.gme', 'simon.voc'];

    expect(names.find((name) => !isEffects(name) && /\.voc$/i.test(name))).toBe('simon.voc');
    expect(names.find(isEffects)).toBe('effects.voc');
  });

  it('does not mistake a game whose speech file merely contains the word', () => {
    // Anchored at the start and end, so a release naming its speech something
    // like `soundeffects.voc` is not silently treated as the effects resource.
    expect(isEffects('soundeffects.voc')).toBe(false);
    expect(isEffects('EFFECTS.VOC')).toBe(true);
  });
});
