import { describe, expect, it } from 'vitest';

import { buildSludgeFixture } from './fixtureSludge.js';
import {
  looksLikeSludgeFile,
  sludgeCandidates,
} from '../src/engine/sludge/resource/sludgeDetect.js';
import {
  SludgeFormatError,
  locateObject,
  locateResource,
  locateSubroutine,
  readResource,
  readSludgeFile,
  resourceName,
} from '../src/engine/sludge/resource/sludgeFile.js';

describe('recognising a SLUDGE data file', () => {
  it('claims a file that opens with the signature', () => {
    expect(looksLikeSludgeFile(buildSludgeFixture().subarray(0, 8))).toBe(true);
  });

  it('refuses a file that does not, however it is named', () => {
    expect(looksLikeSludgeFile(new Uint8Array([0x53, 0x4c, 0x55, 0x44, 0x47, 0x00]))).toBe(false);
    expect(looksLikeSludgeFile(new Uint8Array([]))).toBe(false);
  });

  it('shortlists by extension but never claims on one', () => {
    const names = ['game.slg', 'ATLANTIS.000', 'data', 'sky.dsk', 'other.SLG'];
    expect(sludgeCandidates(names)).toEqual(['data', 'game.slg', 'other.SLG']);
  });
});

describe('the header', () => {
  it('reads every field a 2.2 game carries', () => {
    const bytes = buildSludgeFixture({
      version: 0x0202,
      builtinNames: ['say', 'pause', 'wait'],
      userFunctionNames: ['init'],
      resourceNames: ['a.duc', 'b.png', 'c.flo'],
      windowWidth: 1280,
      windowHeight: 720,
      fpsDivisor: 20,
      dataFolder: 'save',
      globalCount: 120,
    });
    const file = readSludgeFile(bytes);

    expect([file.versionMajor, file.versionMinor]).toEqual([2, 2]);
    expect(file.version).toBe(0x0202);
    expect(file.builtinNames).toEqual(['say', 'pause', 'wait']);
    expect(file.userFunctionNames).toEqual(['init']);
    expect(file.resourceNames).toEqual(['a.duc', 'b.png', 'c.flo']);
    expect([file.windowWidth, file.windowHeight]).toEqual([1280, 720]);
    expect(file.desiredFps).toBe(50);
    expect(file.dataFolder).toBe('save');
    expect(file.globalCount).toBe(120);
  });

  it('skips the three fields a pre-1.3 game does not have', () => {
    const file = readSludgeFile(buildSludgeFixture({ version: 0x0102 }));

    expect(file.version).toBe(0x0102);
    // No resource-name table, no data folder, no language count in the file.
    expect(file.resourceNames).toEqual([]);
    expect(file.dataFolder).toBe('');
    expect(file.languageTable).toEqual([0]);
    // And its resources are still readable, which is the point of the gating.
    expect(file.resourceCount).toBe(3);
  });

  it('names the language table from 2.0 and leaves it unnamed before', () => {
    const languages = [
      { id: 1, name: 'francais' },
      { id: 2, name: 'deutsch' },
    ];
    const named = readSludgeFile(buildSludgeFixture({ version: 0x0200, languages }));
    expect(named.languageTable).toEqual([0, 1, 2]);
    expect(named.languageNames).toEqual(['original', 'francais', 'deutsch']);

    const unnamed = readSludgeFile(buildSludgeFixture({ version: 0x0105, languages }));
    expect(unnamed.languageTable).toEqual([0, 1, 2]);
    expect(unnamed.languageNames).toEqual([]);
  });

  it('refuses a file whose checkpoint is not there, and says why', () => {
    const bytes = buildSludgeFixture({ checkpoint: 'notOk' });
    expect(() => readSludgeFile(bytes)).toThrow(SludgeFormatError);
    expect(() => readSludgeFile(bytes)).toThrow(/checkpoint reads "notOk"/);
  });

  it('refuses a file that is not SLUDGE at all', () => {
    expect(() => readSludgeFile(new Uint8Array(32))).toThrow(/not a SLUDGE data file/);
  });

  it('refuses an embedded icon or logo by name rather than guessing past it', () => {
    expect(() => readSludgeFile(buildSludgeFixture({ iconLogoFlags: 1 }))).toThrow(/an icon/);
    expect(() => readSludgeFile(buildSludgeFixture({ iconLogoFlags: 2 }))).toThrow(/a logo/);
    expect(() => readSludgeFile(buildSludgeFixture({ iconLogoFlags: 3 }))).toThrow(
      /both an icon and a logo/,
    );
  });
});

describe('the four indices', () => {
  it('finds all four, in file order', () => {
    const file = readSludgeFile(buildSludgeFixture());
    const { text, sub, object, data } = file.indexStarts;
    expect(text).toBeLessThan(sub);
    expect(sub).toBeLessThan(object);
    expect(object).toBeLessThan(data);
  });

  it('moves only the Text start when a different language is asked for', () => {
    const bytes = buildSludgeFixture({
      version: 0x0200,
      languages: [
        { id: 1, name: 'francais' },
        { id: 2, name: 'deutsch' },
      ],
    });
    const original = readSludgeFile(bytes, 0).indexStarts;
    const french = readSludgeFile(bytes, 1).indexStarts;
    const german = readSludgeFile(bytes, 2).indexStarts;

    expect(french.text).not.toBe(original.text);
    expect(german.text).not.toBe(french.text);
    // The walk past the language chain is what locates the other three, so
    // they are the same whichever language was asked for.
    for (const other of [french, german]) {
      expect(other.sub).toBe(original.sub);
      expect(other.object).toBe(original.object);
      expect(other.data).toBe(original.data);
    }
  });

  it('falls back to the original for a language the game does not have', () => {
    const bytes = buildSludgeFixture({ version: 0x0200, languages: [{ id: 1, name: 'fr' }] });
    expect(readSludgeFile(bytes, 9).indexStarts).toEqual(readSludgeFile(bytes, 0).indexStarts);
  });

  it('reads Sub and Object entries as absolute offsets', () => {
    const file = readSludgeFile(
      buildSludgeFixture({ subroutines: [0x1111, 0x2222, 0x3333], objects: [0x4444] }),
    );
    const bytes = buildSludgeFixture({ subroutines: [0x1111, 0x2222, 0x3333], objects: [0x4444] });

    expect([0, 1, 2].map((n) => locateSubroutine(bytes, file, n))).toEqual([
      0x1111, 0x2222, 0x3333,
    ]);
    expect(locateObject(bytes, file, 0)).toBe(0x4444);
  });
});

describe('the Data index', () => {
  it('reads each resource back as the bytes it was given', () => {
    const resources = [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
      new Uint8Array(0),
      new Uint8Array([255, 0, 128, 64, 32]),
    ];
    const bytes = buildSludgeFixture({ resources });
    const file = readSludgeFile(bytes);

    expect(file.resourceCount).toBe(resources.length);
    for (let number = 0; number < resources.length; number += 1) {
      expect(Array.from(readResource(bytes, file, number))).toEqual(
        Array.from(resources[number] as Uint8Array),
      );
    }
  });

  it('lays its resources out without overlapping, and inside the file', () => {
    const bytes = buildSludgeFixture({
      resources: [new Uint8Array(11), new Uint8Array(7), new Uint8Array(23)],
    });
    const file = readSludgeFile(bytes);
    const slices = [0, 1, 2]
      .map((number) => locateResource(bytes, file, number))
      .sort((a, b) => a.offset - b.offset);

    for (const slice of slices) {
      expect(slice.offset + slice.length).toBeLessThanOrEqual(bytes.length);
    }
    for (let index = 1; index < slices.length; index += 1) {
      const previous = slices[index - 1] as { offset: number; length: number };
      expect(previous.offset + previous.length).toBeLessThanOrEqual(
        (slices[index] as { offset: number }).offset,
      );
    }
  });

  it('refuses a resource number the game does not have', () => {
    const bytes = buildSludgeFixture();
    const file = readSludgeFile(bytes);
    expect(() => locateResource(bytes, file, file.resourceCount)).toThrow(/outside this game/);
    expect(() => locateResource(bytes, file, -1)).toThrow(/outside this game/);
  });

  it('counts resources from the index table, not by walking until one breaks', () => {
    // The fault this encodes was found on Above The Waves and on nothing else,
    // and the first fixture written for it modelled the wrong thing.
    //
    // A real game's Data index table is followed immediately by the first
    // resource's four-byte length field. So the slot *one past* the last entry
    // is that length field, and reading it as a displacement resolves — on
    // Above The Waves it landed on an earlier resource. A count that walks the
    // index until an entry fails to resolve therefore reported 125 resources
    // for a game with 124, the extra being resource 1 under a second number,
    // and the only outward sign was that the lengths summed to more than the
    // file.
    //
    // The assertion below is in two halves and needs both: that the count is
    // right, and that the slot past it *would* have resolved — because if it
    // would not, this fixture is not reproducing the fault and the first half
    // passes for the wrong reason.
    const resources = [new Uint8Array([1, 2, 3, 4]), new Uint8Array([5, 6])];
    const bytes = buildSludgeFixture({ resources });
    const file = readSludgeFile(bytes);

    expect(file.resourceCount).toBe(resources.length);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const pastTheEnd = file.indexStarts.data + file.resourceCount * 4;
    const displacement = view.getUint32(pastTheEnd, true);
    const wouldBeAt = pastTheEnd + 4 + displacement;
    expect(wouldBeAt + 4).toBeLessThanOrEqual(bytes.length);
    const wouldBeLength = view.getUint32(wouldBeAt, true);
    expect(wouldBeAt + 4 + wouldBeLength).toBeLessThanOrEqual(bytes.length);
  });

  it('has a name for a resource where the game carries one, and no name where not', () => {
    const withNames = readSludgeFile(
      buildSludgeFixture({ resourceNames: ['first.duc', 'second.png', 'third.flo'] }),
    );
    expect(resourceName(withNames, 1)).toBe('second.png');
    expect(resourceName(withNames, 99)).toBe('');

    const withoutNames = readSludgeFile(buildSludgeFixture({ version: 0x0102 }));
    expect(withoutNames.resourceCount).toBe(3);
    expect(resourceName(withoutNames, 0)).toBe('');
  });
});
