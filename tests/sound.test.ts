import { describe, expect, it } from 'vitest';
import { decodeSoundResource, decodeVoc } from '../src/engine/sound/SoundEngine.js';
import { buildVocPayload, chunk } from './fixture.js';

describe('VOC decoding', () => {
  it('decodes an 8 bit PCM block and centres it on zero', () => {
    const decoded = decodeVoc(new Uint8Array(buildVocPayload()));
    expect(decoded).not.toBeNull();
    expect(decoded!.samples.length).toBe(8);
    expect(decoded!.samples[0]).toBe(0); // 128 is silence
    expect(decoded!.samples[1]).toBeGreaterThan(0);
    expect(decoded!.samples[3]).toBeLessThan(0);
  });

  it('derives the sample rate from the divisor byte', () => {
    const decoded = decodeVoc(new Uint8Array(buildVocPayload()));
    expect(decoded!.sampleRate).toBeGreaterThan(10000);
    expect(decoded!.sampleRate).toBeLessThan(12500);
  });

  it('returns null for data that is not a VOC', () => {
    expect(decodeVoc(new Uint8Array(4))).toBeNull();
  });

  it('extracts audio from a SOUN resource wrapping SBL/AUdt', () => {
    const resource = new Uint8Array(chunk('SOUN', chunk('SBL ', chunk('AUdt', buildVocPayload()))));
    const decoded = decodeSoundResource(resource);
    expect(decoded).not.toBeNull();
    expect(decoded!.samples.length).toBe(8);
  });

  it('returns null for a sequenced-music resource', () => {
    const resource = new Uint8Array(chunk('SOUN', chunk('ADL ', [1, 2, 3, 4])));
    expect(decodeSoundResource(resource)).toBeNull();
  });
});
