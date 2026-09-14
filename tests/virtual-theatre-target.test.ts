import { describe, expect, it } from 'vitest';
import { looksLikeSky } from '../src/engine/sky/resource/skyDetect.js';
import { looksLikeLure } from '../src/engine/lure/resource/lureDetect.js';
import {
  describeTarget,
  hasAssembler,
  parseTarget,
  sameTarget,
  type Target,
} from '../src/authoring/target.js';

const SKY: Target = { engine: 'sky', release: 'cd', platform: 'dos' };
const LURE: Target = { engine: 'lure', release: 'floppy', platform: 'dos' };

describe('looksLikeSky', () => {
  it('claims a folder with both halves', () => {
    expect(looksLikeSky(['sky.dsk', 'sky.dnr'])).toBe(true);
  });

  // The rule `loadEngine.ts` states for SCI, applied here: a lone marker from
  // half an extracted archive is not evidence of a game, and claiming it takes
  // SCUMM's good failure message away from a dump that has one.
  it('refuses either half alone', () => {
    expect(looksLikeSky(['sky.dsk'])).toBe(false);
    expect(looksLikeSky(['sky.dnr'])).toBe(false);
  });

  it('ignores case and leading paths', () => {
    expect(looksLikeSky(['BASS/SKY.DSK', 'BASS\\Sky.Dnr'])).toBe(true);
  });

  // ADR 0024 reads the Compacts from the executable, so a dump without it
  // cannot boot — but that refusal belongs to Sky, in a message naming the
  // missing file. Detecting on it would hand such a dump to SCUMM's catch-all.
  it('claims a dump with no executable, so Sky can refuse it by name', () => {
    expect(looksLikeSky(['sky.dsk', 'sky.dnr'])).toBe(true);
  });

  it('never claims another family, and never claims ScummVM artefacts alone', () => {
    expect(looksLikeSky(['MONKEY2.000', 'MONKEY2.001'])).toBe(false);
    expect(looksLikeSky(['LOGDIR', 'VOL.0'])).toBe(false);
    expect(looksLikeSky(['RESOURCE.MAP', 'RESOURCE.000'])).toBe(false);
    expect(looksLikeSky(['sky.cpt'])).toBe(false);
  });
});

describe('looksLikeLure', () => {
  it('claims disk1 with at least one further numbered disk', () => {
    expect(looksLikeLure(['disk1.vga', 'disk2.vga'])).toBe(true);
  });

  it('refuses disk1 alone', () => {
    expect(looksLikeLure(['disk1.vga'])).toBe(false);
  });

  // ADR 0024 refuses to read ScummVM's generated support file, so it must not
  // be the thing that makes a folder look like a game either.
  it('does not treat lure.dat as evidence', () => {
    expect(looksLikeLure(['lure.dat'])).toBe(false);
    expect(looksLikeLure(['disk1.vga', 'lure.dat'])).toBe(false);
  });

  it('does not claim Sky', () => {
    expect(looksLikeLure(['sky.dsk', 'sky.dnr'])).toBe(false);
  });
});

describe('the Sky and Lure Target arms', () => {
  // `CONTEXT.md`: never bare, because a bare Release names either family.
  it('always names the family alongside the Release', () => {
    expect(describeTarget(SKY)).toBe('Sky (cd)');
    expect(describeTarget(LURE)).toBe('Lure (floppy)');
  });

  it('round-trips through parseTarget', () => {
    expect(parseTarget(JSON.parse(JSON.stringify(SKY)))).toEqual(SKY);
    expect(parseTarget(JSON.parse(JSON.stringify(LURE)))).toEqual(LURE);
  });

  // Refuses rather than defaulting — the mis-tag this module exists to prevent.
  it('refuses a Release the family never shipped, and a non-DOS platform', () => {
    expect(parseTarget({ engine: 'sky', release: 'floppy', platform: 'amiga' })).toBeNull();
    expect(parseTarget({ engine: 'lure', release: 'cd', platform: 'dos' })).toBeNull();
    expect(parseTarget({ engine: 'sky', version: 2, platform: 'dos' })).toBeNull();
  });

  // ADR 0012: a save is Target-tagged so families are refused for each other
  // rather than half-applied. Sky and Lure are two families (ADR 0026).
  it('never matches the other Virtual Theatre family, or any other', () => {
    expect(sameTarget(SKY, LURE)).toBe(false);
    expect(sameTarget(SKY, { engine: 'scumm', version: 5 })).toBe(false);
    expect(
      sameTarget(LURE, { engine: 'sci', version: 'sci0-late', platform: 'dos' } as Target),
    ).toBe(false);
    expect(sameTarget(SKY, { engine: 'sky', release: 'floppy', platform: 'dos' })).toBe(false);
    expect(sameTarget(SKY, SKY)).toBe(true);
  });

  // Neither extractor exists yet (#253, #262). A Target claiming an assembler
  // it does not have is exactly the mis-tag `target.ts` was written to prevent,
  // so this asserts the absence deliberately rather than by omission.
  it('claims no assembler until the object-table extractors land', () => {
    expect(hasAssembler(SKY)).toBe(false);
    expect(hasAssembler(LURE)).toBe(false);
  });
});
