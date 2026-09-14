import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import {
  agiLayout,
  detectAgiGame,
  detectPlatform,
  looksLikeAgi,
  parseInterpreterString,
  readCombinedDirHeader,
} from '../src/engine/agi/resource/agiDetect.js';
import {
  AgiResources,
  readDirEntry,
  readDirTable,
} from '../src/engine/agi/resource/AgiResources.js';
import {
  agiMajor,
  DEFAULT_AGI_INTERPRETER,
  describeUneditableTarget,
} from '../src/authoring/target.js';
import {
  buildAgiV2Fixture,
  buildAgiV3Fixture,
  buildLogic,
  buildPicture,
  defaultResources,
  lzwCompress,
  packPictureNibbles,
  samplePicture,
} from './fixtureAgi.js';
import { lzwDecompress, unpackPicture } from '../src/engine/agi/resource/lzw.js';

function sourceFrom(files: Map<string, Uint8Array>, label = 'agi-fixture'): MemoryDataSource {
  const source = new MemoryDataSource(label);
  for (const [name, bytes] of files) source.set(name, bytes);
  return source;
}

describe('recognising AGI data', () => {
  it('claims a v2 game from its four index files', () => {
    expect(looksLikeAgi(['LOGDIR', 'PICDIR', 'VIEWDIR', 'SNDDIR', 'VOL.0'])).toBe(true);
  });

  it('claims a v3 game from its combined index and matching volume', () => {
    expect(looksLikeAgi(['KQ4DIR', 'KQ4VOL.0', 'KQ4VOL.1'])).toBe(true);
  });

  /**
   * `logdir` matches the v3 pattern `<prefix>dir` with a prefix of "log", so
   * asking about v3 first would read a v2 game as a v3 one with a game id of
   * "log" and then look for `LOGVOL.0`, which is not there.
   */
  it('reads a v2 game as v2 rather than as v3 with a game id of "log"', () => {
    const layout = agiLayout(['LOGDIR', 'PICDIR', 'VIEWDIR', 'SNDDIR', 'VOL.0']);
    expect(layout?.major).toBe(2);
    expect(layout?.prefix).toBe('');
  });

  /**
   * A lone `*DIR` is not evidence. A badly extracted archive can leave an
   * `AUTOEXEC.DIR` behind, and reading that as a game index would take the
   * failure a long way from its cause.
   */
  it('refuses a *DIR with no volume beside it', () => {
    expect(looksLikeAgi(['AUTOEXEC.DIR', 'README.TXT'])).toBe(false);
  });

  it('does not claim SCUMM data', () => {
    expect(looksLikeAgi(['MONKEY2.000', 'MONKEY2.001', 'MONSTER.SOU'])).toBe(false);
  });

  it('finds the volumes belonging to one prefix and not another game', () => {
    const layout = agiLayout(['KQ4DIR', 'KQ4VOL.0', 'KQ4VOL.2', 'SQ2VOL.0']);
    expect([...(layout?.volumes.keys() ?? [])].sort((a, b) => a - b)).toEqual([0, 2]);
  });
});

describe('reading the interpreter version out of the game', () => {
  it('reads a v2 build number as the digits Sierra wrote', () => {
    // `2.917` is compared as `0x2917` by every implementation since, because
    // that reads back as the version. So the digits carry across as digits.
    expect(parseInterpreterString('AGI version 2.917 (c) Sierra')).toBe(0x2917);
    expect(parseInterpreterString('2.089')).toBe(0x2089);
  });

  it('reads a v3 build number, skipping the middle group', () => {
    expect(parseInterpreterString('3.002.149')).toBe(0x3149);
    expect(agiMajor(parseInterpreterString('3.002.086')!)).toBe(3);
  });

  it('finds nothing in text with no version in it', () => {
    expect(parseInterpreterString('no version here')).toBeNull();
  });

  it('reads AGIDATA.OVL in preference to guessing, and records that it did', async () => {
    const fixture = buildAgiV2Fixture();
    fixture.files.set('AGIDATA.OVL', new TextEncoder().encode('  AGI version 2.440 blah'));
    const game = await detectAgiGame(sourceFrom(fixture.files));

    expect(game.target).toMatchObject({
      engine: 'agi',
      interpreter: 0x2440,
      identification: 'agidata',
    });
    expect(game.interpreterNote).toMatch(/AGIDATA\.OVL/);
  });

  /**
   * ADR 0013: a game whose interpreter version fell back **plays** on the
   * guess and is **refused for editing**. So the fallback has to be reported as
   * a fallback rather than presented as a reading.
   */
  it('says so when it had to guess', async () => {
    const game = await detectAgiGame(sourceFrom(buildAgiV2Fixture().files));
    expect(game.target).toMatchObject({ identification: 'fallback' });
    expect(game.interpreterNote).toMatch(/assumed/);
  });

  /**
   * Sierra shipped the v2 interpreter as an extensionless `AGI`, loaded by
   * `SIERRA.COM` — the Amiga releases do the same, which `detectPlatform`
   * already relies on. A pattern that insisted on an extension therefore walked
   * straight past the interpreter in a great many DOS releases and reported
   * that none was found, which costs the game its editability (ADR 0013).
   */
  it('reads the extensionless AGI interpreter Sierra actually shipped', async () => {
    const fixture = buildAgiV2Fixture();
    fixture.files.set('AGI', new TextEncoder().encode('Sierra On-Line AGI 2.272 interpreter'));
    const game = await detectAgiGame(sourceFrom(fixture.files));

    expect(game.target).toMatchObject({ interpreter: 0x2272, identification: 'interpreter-hash' });
    expect(game.interpreterNote).toMatch(/AGI/);
  });

  it('prefers AGIDATA.OVL over the interpreter when both are there', async () => {
    const fixture = buildAgiV2Fixture();
    // Disagreeing on purpose: the arity table the interpreter *reads* is the
    // authority, not the string in the binary that reads it (ADR 0013).
    fixture.files.set('AGI', new TextEncoder().encode('AGI 2.272'));
    fixture.files.set('AGIDATA.OVL', new TextEncoder().encode('AGI 2.440'));
    const game = await detectAgiGame(sourceFrom(fixture.files));

    expect(game.target).toMatchObject({ interpreter: 0x2440, identification: 'agidata' });
  });

  /**
   * A version read off the wrong binary is a guess wearing the word
   * "identified", and ADR 0013's whole point is that those are not the same
   * thing. An installer or an unpacker left in the folder must not name a
   * version.
   */
  it('will not take a version from a binary that is not the interpreter', async () => {
    const fixture = buildAgiV2Fixture();
    fixture.files.set('INSTALL.EXE', new TextEncoder().encode('Installer version 2.089'));
    fixture.files.set('DOSBOX.EXE', new TextEncoder().encode('DOSBox 3.002.149'));
    const game = await detectAgiGame(sourceFrom(fixture.files));

    expect(game.target).toMatchObject({
      interpreter: DEFAULT_AGI_INTERPRETER,
      identification: 'fallback',
    });
  });

  /**
   * "No AGIDATA.OVL was found" sends the reader looking for a file that is
   * already in the folder. Present-but-silent and absent have different fixes,
   * so they get different sentences.
   */
  it('says the interpreter carried no version, rather than that none was there', async () => {
    const fixture = buildAgiV2Fixture();
    fixture.files.set('AGIDATA.OVL', new TextEncoder().encode('no version in here at all'));
    const game = await detectAgiGame(sourceFrom(fixture.files));

    expect(game.target).toMatchObject({ identification: 'fallback' });
    expect(game.interpreterNote).toMatch(/AGIDATA\.OVL carried no version string/);
    expect(game.interpreterNote).not.toMatch(/was found/);
  });

  /**
   * ADR 0013's amendment. A dump of resources and nothing else has no evidence
   * to read and never will, so the version can be stated instead — and is
   * recorded as stated, which is what keeps it apart from a guess.
   */
  it('takes a declared version, and records that it was declared', async () => {
    const game = await detectAgiGame(sourceFrom(buildAgiV2Fixture().files), {
      interpreter: 0x2272,
      platform: 'dos',
    });

    expect(game.target).toMatchObject({ interpreter: 0x2272, identification: 'declared' });
    expect(describeUneditableTarget(game.target)).toBeNull();
  });

  it('declares over a version the game does carry, and says both in the note', async () => {
    const fixture = buildAgiV2Fixture();
    fixture.files.set('AGIDATA.OVL', new TextEncoder().encode('AGI 2.917'));
    const game = await detectAgiGame(sourceFrom(fixture.files), {
      interpreter: 0x2089,
      platform: 'amiga',
    });

    expect(game.target).toMatchObject({
      interpreter: 0x2089,
      platform: 'amiga',
      identification: 'declared',
    });
    // Both, because a declaration that contradicts a readable AGIDATA.OVL is
    // worth seeing rather than silently overriding.
    expect(game.interpreterNote).toMatch(/declared/);
    expect(game.interpreterNote).toMatch(/AGIDATA\.OVL/);
  });

  it('narrows a v3 game to a v3 build even when guessing', async () => {
    const game = await detectAgiGame(sourceFrom(buildAgiV3Fixture().files));
    expect(game.target.engine).toBe('agi');
    if (game.target.engine !== 'agi') throw new Error('unreachable');
    expect(agiMajor(game.target.interpreter)).toBe(3);
  });
});

describe('the platform, which changes how bytecode decodes', () => {
  it('reads DOS when nothing says otherwise', () => {
    expect(detectPlatform(['LOGDIR', 'VOL.0', 'AGI.EXE'])).toBe('dos');
  });

  it('reads Amiga from its icon files', () => {
    expect(detectPlatform(['LOGDIR', 'VOL.0', 'kq2.info'])).toBe('amiga');
  });

  it('reads Atari ST from its executable', () => {
    expect(detectPlatform(['LOGDIR', 'VOL.0', 'AGI.PRG'])).toBe('atari-st');
  });
});

describe('the directory tables', () => {
  /**
   * Three bytes per entry: `VVVVPPPP PPPPPPPP PPPPPPPP`. Four bits of volume
   * and twenty of offset, which is where AGI's one-megabyte volume limit comes
   * from.
   */
  it('unpacks a volume number from the high nibble and twenty bits of offset', () => {
    expect(readDirEntry(new Uint8Array([0x30, 0x12, 0x34]), 0)).toEqual({
      volume: 3,
      offset: 0x01234,
    });
    expect(readDirEntry(new Uint8Array([0xa0, 0x00, 0x00]), 0)).toEqual({
      volume: 10,
      offset: 0,
    });
    expect(readDirEntry(new Uint8Array([0x0f, 0xff, 0xfe]), 0)).toEqual({
      volume: 0,
      offset: 0xffffe,
    });
  });

  /** Every AGI game's tables are sparse, so absence is the normal case. */
  it('reads three 0xFF bytes as an absent resource, not as offset 0xFFFFF', () => {
    expect(readDirEntry(new Uint8Array([0xff, 0xff, 0xff]), 0)).toBeNull();
  });

  it('keys entries by resource number, holes included', () => {
    const table = readDirTable(
      new Uint8Array([0x00, 0x00, 0x10, 0xff, 0xff, 0xff, 0x00, 0x00, 0x20]),
    );
    expect(table).toHaveLength(3);
    expect(table[0]).toEqual({ volume: 0, offset: 0x10 });
    expect(table[1]).toBeNull();
    expect(table[2]).toEqual({ volume: 0, offset: 0x20 });
  });
});

describe('the AGI v3 combined index header', () => {
  it('reads four little-endian offsets', () => {
    const bytes = new Uint8Array([8, 0, 20, 0, 40, 0, 60, 0]);
    expect(readCombinedDirHeader(bytes)).toEqual([8, 20, 40, 60]);
  });

  /**
   * The header is a fixed eight bytes, so the first table always starts at 8.
   * A file that says otherwise is not the index it is named as, and saying so
   * is better than reading four tables out of the wrong places.
   */
  it('refuses a header whose first offset is not 8', () => {
    expect(() => readCombinedDirHeader(new Uint8Array([12, 0, 20, 0, 40, 0, 60, 0]))).toThrow(
      /fixed eight bytes/,
    );
  });

  it('refuses a file shorter than its own header', () => {
    expect(() => readCombinedDirHeader(new Uint8Array([8, 0, 20]))).toThrow(/shorter/);
  });
});

describe('getting bytes out of an AGI v2 game', () => {
  async function loadV2() {
    const fixture = buildAgiV2Fixture();
    const source = sourceFrom(fixture.files);
    const game = await detectAgiGame(source);
    return { fixture, resources: await AgiResources.load(source, game) };
  }

  it('resolves every resource in the fixture to the right bytes', async () => {
    const { fixture, resources } = await loadV2();
    for (const spec of fixture.resources) {
      expect([...resources.read(spec.type, spec.number)]).toEqual(spec.bytes);
    }
  });

  it('counts resources per type', async () => {
    const { resources } = await loadV2();
    expect(resources.count('logic')).toBe(2);
    expect(resources.count('picture')).toBe(1);
    expect(resources.count('view')).toBe(1);
    expect(resources.count('sound')).toBe(1);
  });

  it('lists the numbers a sparse table actually holds', async () => {
    const { resources } = await loadV2();
    expect(resources.list('logic')).toEqual([0, 1]);
    // Picture 0 is a hole; the fixture's only picture is number 1.
    expect(resources.list('picture')).toEqual([1]);
    expect(resources.has('picture', 0)).toBe(false);
    expect(resources.has('picture', 1)).toBe(true);
  });

  it('names the resource when it is asked for one the game has not got', async () => {
    const { resources } = await loadV2();
    expect(() => resources.read('logic', 99)).toThrow(/logic 99 is not in this game/);
  });

  /**
   * A wrong offset lands in the middle of the previous resource, where the
   * length field is whatever byte happened to be there. So an unchecked read
   * produces a resource of an arbitrary size that parses to nonsense — which is
   * why the five-byte header is validated rather than skipped (#124).
   */
  it('refuses a resource whose signature is not 0x12 0x34, naming it', async () => {
    const fixture = buildAgiV2Fixture();
    // Point logic 0 one byte past where it really starts.
    const logdir = fixture.files.get('LOGDIR')!;
    logdir[2] = 1;
    const source = sourceFrom(fixture.files);
    const resources = await AgiResources.load(source, await detectAgiGame(source));

    expect(() => resources.read('logic', 0)).toThrow(/logic 0 should start with 0x12 0x34/);
  });

  it('refuses a resource whose header names a different volume', async () => {
    const fixture = buildAgiV2Fixture();
    const volume = fixture.files.get('VOL.0')!;
    volume[2] = 3;
    const source = sourceFrom(fixture.files);
    const resources = await AgiResources.load(source, await detectAgiGame(source));

    expect(() => resources.read('logic', 0)).toThrow(/belongs to volume 3/);
  });

  it('refuses a resource whose length runs past the end of the volume', async () => {
    const fixture = buildAgiV2Fixture();
    const volume = fixture.files.get('VOL.0')!;
    // The first resource's length field, at bytes 3..4 of its header.
    volume[3] = 0xff;
    volume[4] = 0xff;
    const source = sourceFrom(fixture.files);
    const resources = await AgiResources.load(source, await detectAgiGame(source));

    expect(() => resources.read('logic', 0)).toThrow(/runs past the end/);
  });

  it('refuses a game whose index names a volume it does not ship', async () => {
    const fixture = buildAgiV2Fixture();
    const logdir = fixture.files.get('LOGDIR')!;
    // Volume 7, in the high nibble of the first byte.
    logdir[0] = 0x70;
    const source = sourceFrom(fixture.files);

    await expect(AgiResources.load(source, await detectAgiGame(source))).rejects.toThrow(
      /volume 7/,
    );
  });

  it('reads a resource type the game ships no index for as empty, not as an error', async () => {
    const fixture = buildAgiV2Fixture();
    fixture.files.delete('SNDDIR');
    const source = sourceFrom(fixture.files);
    const resources = await AgiResources.load(source, await detectAgiGame(source));

    expect(resources.count('sound')).toBe(0);
    expect(resources.count('logic')).toBe(2);
  });

  it('reports resource counts per type in the log', async () => {
    const fixture = buildAgiV2Fixture();
    const source = sourceFrom(fixture.files);
    const lines: string[] = [];
    await AgiResources.load(source, await detectAgiGame(source), { onLog: (m) => lines.push(m) });

    const joined = lines.join('\n');
    expect(joined).toMatch(/2 logics/);
    expect(joined).toMatch(/1 picture/);
    expect(joined).toMatch(/1 view/);
    expect(joined).toMatch(/1 sound/);
  });
});

describe('AGI v3 compression', () => {
  /**
   * A real round trip, not a tautology: the fixture's compressor follows the
   * format description and the decoder is a separate implementation, so a bug
   * in either shows up here rather than cancelling out.
   */
  it('round-trips bytes through adaptive LZW', () => {
    const cases = [
      [1, 2, 3, 4, 5],
      new Array(300).fill(0x41),
      [...new Array(120).keys()].flatMap((n) => [n & 0xff, 0, n & 0xff]),
      [0xff, 0x00, 0xff, 0x00, 0xff, 0x00, 0xff],
    ];
    for (const original of cases) {
      const packed = lzwCompress(original);
      expect([...lzwDecompress(new Uint8Array(packed), original.length)]).toEqual(original);
    }
  });

  it('never writes more than the header said, however malformed the stream', () => {
    // A stream of noise decodes to something; the point is that it is bounded
    // by the declared length rather than growing until the tab runs out of
    // memory.
    const noise = new Uint8Array(new Array(200).fill(0xa5));
    expect(lzwDecompress(noise, 32).length).toBeLessThanOrEqual(32);
  });

  /**
   * The Picture variant, which #132 calls the part most likely to be got wrong
   * — and it is, because getting it wrong produces a picture rather than an
   * error: the stream stays a valid-looking sequence of commands and draws
   * something else.
   */
  it('round-trips a Picture through the nibble packing', () => {
    const original = buildPicture(samplePicture());
    const packed = packPictureNibbles(original);
    expect([...unpackPicture(new Uint8Array(packed), original.length)]).toEqual(original);
  });

  it('matches the specification own worked example', () => {
    const plain = [0xf0, 0x06, 0xf8, 0x12, 0x45, 0xf0, 0x07, 0xf2, 0x05, 0xf8, 0x14, 0x67];
    expect(packPictureNibbles(plain)).toEqual([
      0xf0, 0x6f, 0x81, 0x24, 0x5f, 0x07, 0xf2, 0x5f, 0x81, 0x46, 0x70,
    ]);
    // The last nibble is padding, so the unpacked stream is the original.
    expect([...unpackPicture(new Uint8Array(packPictureNibbles(plain)), plain.length)]).toEqual(
      plain,
    );
  });
});

describe('getting bytes out of an AGI v3 game', () => {
  async function loadV3() {
    const fixture = buildAgiV3Fixture();
    const source = sourceFrom(fixture.files);
    const game = await detectAgiGame(source);
    return { fixture, resources: await AgiResources.load(source, game) };
  }

  it('resolves the four embedded tables to the same numbering v2 produces', async () => {
    const { resources } = await loadV3();
    expect(resources.list('logic')).toEqual([0, 1]);
    expect(resources.list('picture')).toEqual([1]);
    expect(resources.list('view')).toEqual([0]);
    expect(resources.list('sound')).toEqual([1]);
  });

  it('decompresses every compressed resource back to its original bytes', async () => {
    const { fixture, resources } = await loadV3();
    for (const spec of fixture.resources) {
      expect([...resources.read(spec.type, spec.number)]).toEqual(spec.bytes);
    }
  });

  /** The flag is per resource, not per game, so both paths are live. */
  it('loads an uncompressed resource sitting in a v3 volume', async () => {
    const { fixture, resources } = await loadV3();
    const plain = fixture.resources.find((r) => r.compress === undefined)!;
    expect([...resources.read(plain.type, plain.number)]).toEqual(plain.bytes);
  });

  it('takes the game id from the combined index own name', async () => {
    const fixture = buildAgiV3Fixture(undefined, 'kq4');
    const game = await detectAgiGame(sourceFrom(fixture.files));
    expect(game.id).toBe('kq4');
  });

  it('derives v3-ness from the interpreter version rather than storing it', async () => {
    const { resources } = await loadV3();
    expect(resources.major).toBe(3);
  });
});

describe('the v2 path is unchanged by v3 arriving', () => {
  /**
   * #132's own acceptance criterion. The two majors share one class because v3
   * changes packaging and only packaging — so the check worth having is that a
   * v2 game reads identically whichever code path grew around it.
   */
  it('reads the same bytes for the same game built either way', async () => {
    const shared = defaultResources();
    const v2 = buildAgiV2Fixture(shared);
    const v3 = buildAgiV3Fixture(shared.map((spec) => ({ ...spec })));

    const v2Source = sourceFrom(v2.files, 'as-v2');
    const v3Source = sourceFrom(v3.files, 'as-v3');
    const v2Resources = await AgiResources.load(v2Source, await detectAgiGame(v2Source));
    const v3Resources = await AgiResources.load(v3Source, await detectAgiGame(v3Source));

    for (const spec of shared) {
      expect([...v3Resources.read(spec.type, spec.number)]).toEqual([
        ...v2Resources.read(spec.type, spec.number),
      ]);
    }
  });
});

describe('a Logic resource carries its own messages', () => {
  /**
   * The detail no prose source states outright, and the one that puts every
   * string one byte out if it is guessed: a message offset is relative to the
   * message section's start **plus one**.
   *
   * Asserted here on the fixture's own bytes rather than through a reader, so
   * this test is about the format rather than about our reading of it.
   */
  it('puts the first message offset at 2 + 2 * count from the section start plus one', () => {
    const logic = buildLogic({ code: [0x00], messages: ['hi', 'there'] });
    // Two bytes of size, then one byte of code.
    expect(logic[0]).toBe(1);
    expect(logic[1]).toBe(0);
    const sectionAt = 2 + 1;
    expect(logic[sectionAt]).toBe(2);
    // The offset table starts three bytes into the section.
    const firstOffset = logic[sectionAt + 3] | (logic[sectionAt + 4] << 8);
    expect(firstOffset).toBe(2 + 2 * 2);
    // And that offset, rebased on `section + 1`, lands on the text.
    expect(sectionAt + 1 + firstOffset).toBe(sectionAt + 3 + 2 * 2);
  });
});
