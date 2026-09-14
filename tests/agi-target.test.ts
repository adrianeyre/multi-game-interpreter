import { describe, expect, it } from 'vitest';
import {
  agiMajor,
  DEFAULT_AGI_INTERPRETER,
  describeTarget,
  describeUneditableTarget,
  formatInterpreterVersion,
  parseTarget,
  sameTarget,
  type Target,
} from '../src/authoring/target.js';

/**
 * The Target, which is `CONTEXT.md`'s "everything that must be known before a
 * byte can be read", held as one value.
 *
 * The tests worth having here are the ones about the *asymmetry* between the
 * arms. A SCUMM Version fixes the instruction encoding; an AGI major version
 * does not, and the whole reason the AGI arm carries an interpreter version and
 * a platform instead is that the encoding axis cuts across the major.
 */
describe('the AGI major version is derived, never stored', () => {
  it('reads v3 from the interpreter version and nothing else', () => {
    expect(agiMajor(0x3149)).toBe(3);
    expect(agiMajor(0x3086)).toBe(3);
    expect(agiMajor(0x3000)).toBe(3);
  });

  it('reads v2 below 0x3000', () => {
    expect(agiMajor(0x2089)).toBe(2);
    expect(agiMajor(0x2917)).toBe(2);
    expect(agiMajor(0x2fff)).toBe(2);
  });
});

describe('naming a Target', () => {
  /**
   * `CONTEXT.md` is firm that "v3" names two unrelated engines, so nothing here
   * ever writes a bare version.
   */
  it('always writes the family with the version', () => {
    expect(describeTarget({ engine: 'scumm', version: 6 })).toBe('SCUMM v6');
    expect(describeTarget({ engine: 'agi', interpreter: 0x2917, platform: 'dos' })).toBe(
      'AGI v2 (2.917)',
    );
  });

  it('names the platform when it is not DOS, because it changes the encoding', () => {
    expect(
      describeTarget({ engine: 'agi', interpreter: 0x3149, platform: 'apple-ii-gs' }),
    ).toContain('apple-ii-gs');
  });

  it('writes v3 builds the way Sierra numbered them', () => {
    expect(formatInterpreterVersion(0x3149)).toBe('3.002.149');
    expect(formatInterpreterVersion(0x2089)).toBe('2.089');
  });
});

describe('an illegal pair cannot be read back', () => {
  /**
   * `{engine: 'agi', version: 6}` is the pair ADR 0012 exists to make
   * impossible: it typechecks under an `engine` field beside a plain
   * `version: number`, which is one of the rejected alternatives.
   */
  it('refuses an AGI arm carrying a major version instead of an interpreter', () => {
    expect(parseTarget({ engine: 'agi', version: 6 })).toBeNull();
  });

  it('refuses an AGI interpreter below the DOS band this engine reads', () => {
    // Below 0x2000 is the booter and Apple II band, which is out of scope
    // (`.out-of-scope/agi-booter-and-apple-ii.md`). Refused rather than clamped
    // up into v2, which would decode a 99-entry opcode set with a 183-entry
    // table.
    expect(parseTarget({ engine: 'agi', interpreter: 0x1000, platform: 'dos' })).toBeNull();
  });

  it('reads back every SCUMM version there is an engine for', () => {
    // All seven now, which is the point rather than a widening for its own
    // sake: a Version that plays and cannot be tagged is a Version whose
    // projects take a neighbour's number (ADR 0012).
    for (const version of [2, 3, 4, 5, 6, 7, 8] as const) {
      expect(parseTarget({ engine: 'scumm', version })).toEqual({ engine: 'scumm', version });
    }
  });

  it('refuses a SCUMM version outside the family this engine implements', () => {
    // v1 and v0 are disk images and a cartridge ROM rather than files, and are
    // out of scope (`.out-of-scope/scumm-non-dos-releases.md`).
    expect(parseTarget({ engine: 'scumm', version: 1 })).toBeNull();
    expect(parseTarget({ engine: 'scumm', version: 9 })).toBeNull();
  });

  it('refuses an unknown platform rather than assuming DOS', () => {
    expect(parseTarget({ engine: 'agi', interpreter: 0x2917, platform: 'spectrum' })).toBeNull();
  });

  it('reads a well-formed pair of either family back unchanged', () => {
    expect(parseTarget({ engine: 'scumm', version: 7 })).toEqual({
      engine: 'scumm',
      version: 7,
    });
    expect(
      parseTarget({
        engine: 'agi',
        interpreter: 0x3149,
        platform: 'dos',
        identification: 'agidata',
        gameId: 'goldrush',
      }),
    ).toEqual({
      engine: 'agi',
      interpreter: 0x3149,
      platform: 'dos',
      identification: 'agidata',
      gameId: 'goldrush',
    });
  });
});

describe('two Targets are the same only when the encoding is', () => {
  it('separates the families', () => {
    const scumm: Target = { engine: 'scumm', version: 5 };
    const agi: Target = { engine: 'agi', interpreter: 0x2917, platform: 'dos' };
    expect(sameTarget(scumm, agi)).toBe(false);
  });

  it('separates two AGI interpreters inside one major version', () => {
    // Both AGI v2, and they disagree about how many arguments `quit` takes —
    // which is the whole reason the interpreter version is in the Target.
    expect(
      sameTarget(
        { engine: 'agi', interpreter: 0x2089, platform: 'dos' },
        { engine: 'agi', interpreter: 0x2917, platform: 'dos' },
      ),
    ).toBe(false);
  });

  it('separates two platforms at one interpreter version', () => {
    expect(
      sameTarget(
        { engine: 'agi', interpreter: 0x3149, platform: 'dos' },
        { engine: 'agi', interpreter: 0x3149, platform: 'apple-ii-gs' },
      ),
    ).toBe(false);
  });
});

describe('editing is refused where the interpreter version was guessed', () => {
  /**
   * ADR 0013's sharpest consequence. Byte-identity is not enough on its own:
   * decode with the wrong arity table and re-emit with the same wrong table and
   * the round trip passes while the tree is nonsense.
   */
  it('refuses an AGI target whose version fell back, and says why', () => {
    const refusal = describeUneditableTarget({
      engine: 'agi',
      interpreter: DEFAULT_AGI_INTERPRETER,
      platform: 'dos',
      identification: 'fallback',
    });
    expect(refusal).toMatch(/could not be identified/);
    expect(refusal).toMatch(/AGIDATA\.OVL/);
  });

  it('treats a missing identification as a fallback, which is the cautious reading', () => {
    expect(
      describeUneditableTarget({ engine: 'agi', interpreter: 0x2917, platform: 'dos' }),
    ).not.toBeNull();
  });

  it('allows editing where the version was read from the game itself', () => {
    expect(
      describeUneditableTarget({
        engine: 'agi',
        interpreter: 0x2917,
        platform: 'dos',
        identification: 'agidata',
      }),
    ).toBeNull();
  });

  it('never refuses a SCUMM target on these grounds', () => {
    expect(describeUneditableTarget({ engine: 'scumm', version: 6 })).toBeNull();
  });
});
