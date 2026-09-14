import { describe, expect, it } from 'vitest';
import { MemoryDataSource, type ByteProgress } from '../src/engine/resource/DataSource.js';
import { detectGame } from '../src/engine/resource/GameDetector.js';
import { LoadProgressTracker, type LoadStage } from '../src/engine/resource/progress.js';
import { ResourceManager } from '../src/engine/resource/ResourceManager.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { identifyForeignEngine } from '../src/engine/resource/engineSignatures.js';
import { looksLikeSci } from '../src/engine/sci/resource/sciDetect.js';
import { looksLikeAgi } from '../src/engine/agi/resource/agiDetect.js';
import { buildFixture, chunk, XOR_KEY } from './fixture.js';

/**
 * What the loader says about files that are not SCUMM game data.
 *
 * All of this came out of one dump: King's Quest IV, zipped as `kings4.zip`
 * with its data files named `KQ4SG.000` and `KQ4SG.001`. Those two names form
 * a valid SCUMM index/data pair, and on the strength of the names alone the
 * loader announced a SCUMM v5 game, read and decrypted the data file, mapped
 * the rooms, and only then failed — on a container tag, blaming an XOR key it
 * had never actually identified and printing the mojibake it decoded.
 *
 * Three separate mistakes, each fixed here: recognising a foreign engine only
 * as a fallback, guessing a key when the trial found none, and a container
 * message that pointed at the wrong cause.
 */

/** Bytes that are not SCUMM data under any candidate key. */
function notScummBytes(): Uint8Array {
  // Two properties matter and both are checked by the assertions below: the
  // first four bytes must not XOR to a block tag under 0x69, 0x00 or 0xff, and
  // bytes four and five must not read as a pre-v5 two character tag.
  return new Uint8Array([
    0x11, 0x22, 0x33, 0x44, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc,
  ]);
}

/** The King's Quest IV dump: a SCUMM-shaped pair holding no SCUMM data. */
function kingsQuestDump(): MemoryDataSource {
  const source = new MemoryDataSource('kings4.zip');
  source.set('KQ4SG.000', notScummBytes());
  source.set('KQ4SG.001', notScummBytes());
  return source;
}

/** Records which files were actually read, to pin down how far a load got. */
class RecordingSource extends MemoryDataSource {
  readonly reads: string[] = [];

  override async read(name: string, onBytes?: ByteProgress): Promise<Uint8Array | null> {
    const data = await super.read(name, onBytes);
    if (data) this.reads.push(name.toLowerCase());
    return data;
  }
}

function encrypt(bytes: number[]): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = (bytes[i] ^ XOR_KEY) & 0xff;
  return out;
}

describe('a foreign engine hiding behind SCUMM file names (#59)', () => {
  /**
   * AGI is no longer a foreign engine, and this is the test that used to say
   * otherwise.
   *
   * It asserted that a `LOGDIR` beside a SCUMM-shaped pair was refused with
   * "AGI (Sierra) ... This project implements SCUMM only". Retiring that line
   * is a structural change rather than a string edit (#125): AGI stopped being
   * foreign when it gained an interpreter, so it routes to the AGI detector and
   * never reaches the signature table at all.
   */
  it('no longer treats AGI as a foreign engine, because it has an interpreter now', () => {
    expect(identifyForeignEngine(['LOGDIR', 'PICDIR', 'VIEWDIR', 'SNDDIR', 'VOL.0'])).toBeNull();
  });

  it('routes AGI data to the AGI detector instead', () => {
    expect(looksLikeAgi(['LOGDIR', 'PICDIR', 'VIEWDIR', 'SNDDIR', 'VOL.0'])).toBe(true);
    // And the loader picks it up before SCUMM's catch-all does.
    expect(looksLikeAgi(['KQ4DIR', 'KQ4VOL.0'])).toBe(true);
  });

  it('says which file it recognised a foreign engine from', async () => {
    // The check can now override a pair that looks like a SCUMM index, so the
    // evidence for that verdict belongs on screen rather than implied. Drascula
    // rather than SCI, Sky or Lure, because all three stopped being foreign —
    // SCI at #216 (see below), Sky at #255 and Lure at #263 once it gained an
    // engine (ADR 0026).
    const source = kingsQuestDump();
    source.set('packet.001', new Uint8Array([1, 2, 3]));

    await expect(detectGame(source)).rejects.toThrow(/Recognised from packet\.001/);
  });

  /**
   * SCI is no longer a foreign engine either, and this is the test that used to
   * say otherwise.
   *
   * It asserted that a `RESOURCE.MAP` beside a SCUMM-shaped pair was refused as
   * "SCI (Sierra)". #115 deferred that decision — "a separate decision, not a
   * follow-on" — and #211 took it, so SCI followed AGI out of the signature
   * table for exactly the reason AGI left it: it has an interpreter now (#216).
   */
  it('no longer treats SCI as a foreign engine, because it has an interpreter now', () => {
    expect(identifyForeignEngine(['resource.map', 'resource.001'])).toBeNull();
  });

  it('routes SCI data to the SCI detector instead', () => {
    expect(looksLikeSci(['RESOURCE.MAP', 'RESOURCE.001'])).toBe(true);
    expect(looksLikeSci(['RESMAP.000', 'RESSCI.000'])).toBe(true);
  });

  it('refuses before reading either file, so no pipeline runs first', async () => {
    const source = new RecordingSource('kings4.zip');
    source.set('KQ4SG.000', notScummBytes());
    source.set('KQ4SG.001', notScummBytes());
    // Drascula rather than Lure: a foreign engine still in the table, since Lure
    // left it once it gained an engine (ADR 0026, #263).
    source.set('packet.001', new Uint8Array([1, 2, 3]));

    await expect(detectGame(source)).rejects.toThrow(/Dráscula/);
    expect(source.reads).toEqual([]);
  });

  it('does not mistake a real v5 game for a foreign engine', async () => {
    // The check moved ahead of index detection, so this is the case that keeps
    // it honest: a genuine game must still load.
    const fixture = buildFixture();
    const source = new MemoryDataSource('v5');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    await expect(ScummEngine.create(source)).resolves.toBeDefined();
  });
});

describe('no XOR key found means this is not an index (#60)', () => {
  it('refuses instead of falling back to 0x69', async () => {
    await expect(detectGame(kingsQuestDump())).rejects.toThrow(/not SCUMM game data/);
  });

  it('does not report a key it has no evidence for', async () => {
    // The log used to read `XOR 0x69` as though the trial had identified it.
    await expect(detectGame(kingsQuestDump())).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringMatching(/XOR 0x69|key \(0x/) }),
    );
  });

  it('says the file name was the only thing that matched', async () => {
    await expect(detectGame(kingsQuestDump())).rejects.toThrow(/only named like it/);
  });

  it('lists the keys it tried, so the verdict is checkable', async () => {
    await expect(detectGame(kingsQuestDump())).rejects.toThrow(/0x69, 0x0, 0xff/);
  });

  it('stops before the data file is read or decrypted', async () => {
    const source = new RecordingSource('kings4.zip');
    source.set('KQ4SG.000', notScummBytes());
    source.set('KQ4SG.001', notScummBytes());

    await expect(detectGame(source)).rejects.toThrow(/not SCUMM game data/);
    expect(source.reads).toEqual(['kq4sg.000']);
  });

  it('still finds the key for a v5 index', async () => {
    const fixture = buildFixture();
    const source = new MemoryDataSource('v5');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, fixture.data);

    expect((await detectGame(source)).xorKey).toBe(XOR_KEY);
  });

  it('still finds the key for a pre-v5 index, which opens with a size not a tag', async () => {
    // Without this the refusal swallowed v4: a pre-v5 index puts its two
    // character tag at byte four, so the four byte tag trial never matches and
    // Monkey Island 1 was reported as not being SCUMM data at all.
    const source = new MemoryDataSource('v4');
    // Two pre-v5 blocks: a little-endian size that includes the six byte
    // header, then a two character tag. `RN` room names, then the `0R` room
    // directory.
    source.set(
      'MONKEY.000',
      encrypt([7, 0, 0, 0, 0x52, 0x4e, 0x00, 9, 0, 0, 0, 0x30, 0x52, 0x01, 0x00, 0x00]),
    );
    source.set('MONKEY.001', encrypt([...chunk('LECF', [])]));

    // v4 now has an interpreter, so finding the key ends in a detection rather
    // than a refusal. What is being asserted is unchanged: the key was found
    // through the pre-v5 index shape, which the four byte tag trial cannot see.
    const game = await detectGame(source);
    expect(game.version).toBe(4);
  });
});

describe('a data file that is not a SCUMM container (#61)', () => {
  /** A real v5 index, paired with a data file that is not one. */
  function mismatchedPair(dataBytes: number[]): MemoryDataSource {
    const fixture = buildFixture();
    const source = new MemoryDataSource('mismatched');
    source.set(fixture.indexName, fixture.index);
    source.set(fixture.dataName, encrypt(dataBytes));
    return source;
  }

  async function loadFailure(source: MemoryDataSource, stages: LoadStage[] = []): Promise<string> {
    const progress = new LoadProgressTracker((update) => stages.push(update.stage));
    try {
      await ResourceManager.load(source, await detectGame(source, progress), progress);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
    throw new Error('expected the load to fail');
  }

  it('says plainly that this is not SCUMM game data', async () => {
    const message = await loadFailure(mismatchedPair([...notScummBytes()]));
    expect(message.split('\n')[0]).toMatch(/is not SCUMM game data/);
  });

  it('does not blame the XOR key, which is the one thing that was proven', async () => {
    const message = await loadFailure(mismatchedPair([...notScummBytes()]));
    expect(message).not.toMatch(/may be wrong for this release/);
    expect(message).toMatch(/the key is not the problem/);
  });

  it('does not print raw decoded bytes at the player', async () => {
    // `got '%i½'` was mojibake: arbitrary bytes rendered as text, which tells
    // the reader nothing and reads as a crash.
    const message = await loadFailure(mismatchedPair([...notScummBytes()]));
    expect(message).not.toMatch(/[^\n\t\x20-\x7e—’“”…]/);
  });

  it('quotes a tag back only when it is four readable characters', async () => {
    const message = await loadFailure(mismatchedPair([...chunk('RIFF', [])]));
    expect(message).toMatch(/opens with 'RIFF'/);
  });

  it('fails before the data file is decrypted end to end', async () => {
    // The old check lived in parseContainer, after a full read and a full
    // decrypt — 148 MB of it for Full Throttle.
    const stages: LoadStage[] = [];
    await loadFailure(mismatchedPair([...notScummBytes()]), stages);

    expect(stages).toContain('reading-data');
    expect(stages).not.toContain('decrypting');
    expect(stages).not.toContain('parsing-container');
  });

  it('names both files, so it is clear which one disagrees', async () => {
    const fixture = buildFixture();
    const message = await loadFailure(mismatchedPair([...notScummBytes()]));

    expect(message).toContain(fixture.dataName);
    expect(message).toContain(fixture.indexName);
  });
});
