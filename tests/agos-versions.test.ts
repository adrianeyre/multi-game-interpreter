import { describe, expect, it } from 'vitest';
import { readGamePc, writeGamePc } from '../src/engine/agos/resource/gamePc.js';
import { checkStructuralAgreement } from '../src/engine/agos/script/structuralAgreement.js';
import { writeSubroutineBlock } from '../src/engine/agos/script/subroutines.js';
import {
  AGOS_VERSIONS,
  pollsSecondSubroutineChannel,
  type AgosTarget,
} from '../src/engine/agos/agosVersion.js';
import { editString } from '../src/authoring/agos/edits.js';
import { buildArchive, buildGamePc, buildGamePcFor } from './fixtureAgos.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { AgosEngine } from '../src/engine/agos/AgosEngine.js';
import { detectAgosGame } from '../src/engine/agos/resource/agosDetect.js';

/**
 * Every Version gets read, not just the one the other fixtures use.
 *
 * Seven Versions differ in item record layout, in header arithmetic and in
 * opcode width, and until this existed only Simon 1 exercised any of it. The
 * fixture is built from each Version's own tables rather than from a hardcoded
 * opcode, so a Version whose table disagrees with our reader fails here rather
 * than agreeing with a fixture that shares the mistake.
 */
describe.each(AGOS_VERSIONS)('AGOS %s', (version) => {
  const target: AgosTarget = {
    family: 'AGOS',
    version,
    releaseKind: version === 'Feeble' || version === 'PuzzlePack' ? 'talkie' : 'floppy',
    platform: 'dos',
  };

  it('reads its own GAMEPC layout', () => {
    const game = readGamePc(buildGamePcFor(target), target);

    expect(game.header.version).toBe(0x80);
    expect(game.strings).toEqual(['lamp', 'brass']);
    expect(game.items).toHaveLength(1);
    expect(game.subroutines.subroutines[0]!.lines[0]!.instructions).toHaveLength(1);
  });

  it('writes it back byte for byte', () => {
    const bytes = buildGamePcFor(target);

    expect(writeGamePc(readGamePc(bytes, target), target)).toEqual(bytes);
  });

  it('agrees with its own opcode table', () => {
    const game = readGamePc(buildGamePcFor(target), target);
    const bytecode = writeSubroutineBlock(game.subroutines, target);
    const report = checkStructuralAgreement([{ source: version, data: bytecode }], target);

    expect(report.findings).toEqual([]);
    expect(report.agrees).toBe(true);
  });
});

describe('the second queued-Subroutine channel', () => {
  /**
   * `hitarea_stuff_helper` (`input.cpp:375`) drains variable 249 in addition to
   * 254 only for Simon 2, The Feeble Files and the Puzzle Pack. It is the whole
   * of how a click leaves a room in Simon 2 — the walk queues its junction-cross
   * Subroutine into 249 — so which families poll it is a decoding fact worth
   * pinning, not a convenience. Gating it matters both ways: a family that polls
   * 249 without a queued walk stalls on the junction, and a family that treats
   * 249 as an ordinary variable would run whatever it held as a Subroutine.
   */
  it('is polled by exactly Simon 2, Feeble and the Puzzle Pack', () => {
    const polling = AGOS_VERSIONS.filter(pollsSecondSubroutineChannel);
    expect(polling).toEqual(['Simon2', 'Feeble', 'PuzzlePack']);
  });

  it('is not polled by Simon 1, for which 249 is an ordinary variable', () => {
    expect(pollsSecondSubroutineChannel('Simon1')).toBe(false);
  });
});

describe('a Version reading another Version’s file', () => {
  it('does not silently succeed where the layouts differ', () => {
    const elvira: AgosTarget = {
      family: 'AGOS',
      version: 'Elvira1',
      releaseKind: 'floppy',
      platform: 'dos',
    };
    const simon: AgosTarget = { ...elvira, version: 'Simon1' };
    const bytes = buildGamePcFor(elvira);

    // Elvira 1 writes a 32-bit name and an extra word that Simon 1 does not
    // expect, so every field after the first is read from the wrong place.
    let read: unknown;
    try {
      read = writeGamePc(readGamePc(bytes, simon), simon);
    } catch {
      read = null;
    }
    expect(read).not.toEqual(bytes);
  });
});

describe('import, edit, export, re-import — for every Version', () => {
  /**
   * ADR 0029's gate is per game and ADR 0030 rebuilds the file whole, so the
   * only proof an edit survives is reading the written file back. Doing it for
   * every Version is what stops this being a claim about Simon 1 with six
   * Versions riding on it.
   */
  it.each(AGOS_VERSIONS)('round-trips an edit in AGOS %s', (version) => {
    const target: AgosTarget = {
      family: 'AGOS',
      version,
      releaseKind: version === 'Feeble' || version === 'PuzzlePack' ? 'talkie' : 'floppy',
      platform: 'dos',
    };
    const imported = readGamePc(buildGamePcFor(target), target);

    const edited = editString(imported, 0, 'a rather longer lamp');
    const exported = writeGamePc(edited, target);
    const reimported = readGamePc(exported, target);

    expect(reimported.strings[0]).toBe('a rather longer lamp');
    // Everything else came back unchanged, which is what says the rebuild
    // understood the whole file rather than the part that was edited.
    expect(reimported.items).toEqual(imported.items);
    expect(reimported.subroutines).toEqual(imported.subroutines);
  });
});
/**
 * What the demos turned out to be, found by sweeping them (#291).
 *
 * The only obtainable Elvira 1 and Waxworks data is a `GAMEPC` with a
 * development build's **table of opcode names appended** — `Abort`, `AddVerb`,
 * `AddNoun`. Every byte of the runtime database decodes; the symbols after it
 * are not modelled, so the file does not re-emit whole.
 *
 * Refusing to *load* that was this project being stricter than its own ADRs.
 * ADR 0013 settled that a game whose Version can only be guessed "**plays** on
 * that guess and is **refused for editing**", and ADR 0030 already refuses the
 * edit for exactly this reason — so refusing the load as well bought nothing
 * and cost the only Elvira 1 and Waxworks data anybody can obtain.
 */
describe('a GAMEPC with something appended to it', () => {
  /** A game with a trailing region the model does not hold. */
  function appended(game: Uint8Array, tail: string): Uint8Array {
    const symbols = new TextEncoder().encode(tail);
    const together = new Uint8Array(game.length + symbols.length);
    together.set(game);
    together.set(symbols, game.length);
    return together;
  }

  it('loads and plays rather than refusing the folder outright', async () => {
    const source = new MemoryDataSource('simon-demo');
    source.set('GAMEPC', appended(buildGamePc({ withSpeech: false }), ' Abort  AddVerb '));
    source.set('SIMON.GME', buildArchive());

    const engine = await AgosEngine.create(source);

    expect(engine.targetName).toBe('AGOS Simon1 (floppy)');
    expect(() => engine.boot()).not.toThrow();
  });

  it('carries the appended region back out unchanged, and stays editable', async () => {
    const source = new MemoryDataSource('waxworks-demo');
    const target = {
      family: 'AGOS',
      version: 'Waxworks',
      releaseKind: 'floppy',
      platform: 'dos',
    } as const;
    const game = buildGamePcFor(target);
    const withTail = appended(game, ' Abort ');
    source.set('DEMO', withTail);
    source.set('TBLLIST', Uint8Array.of(0));

    const detection = await detectAgosGame(source);
    const engine = await AgosEngine.create(source);

    // ADR 0035. The appended region is a development build's symbol table,
    // which the shipped interpreter never reads either — so it is
    // `CONTEXT.md`'s Preserved bytes rather than a re-emission failure, and a
    // game whose whole runtime database decoded is not made read-only by it.
    expect(engine.describeEditRefusal()).toBeNull();

    // Byte-identity over the *whole* file, which is the claim the decision
    // rests on: the region went back where it came from.
    const rebuilt = writeGamePc(readGamePc(withTail, detection.target), detection.target);
    expect(rebuilt).toEqual(withTail);
    expect(readGamePc(withTail, detection.target).trailing).toHaveLength(' Abort '.length);
  });

  it('still refuses a file no Version can read at all', async () => {
    // Through the probe rather than around it: a named archive settles the
    // Version by file name and never reads a byte, so the weaker fallback has
    // to be tested where the probe actually runs.
    const source = new MemoryDataSource('nonsense');
    source.set(
      'DEMO',
      Uint8Array.from({ length: 64 }, (_, index) => index),
    );
    source.set('TBLLIST', Uint8Array.of(0));

    await expect(detectAgosGame(source)).rejects.toThrow(/whole/);
  });
});
