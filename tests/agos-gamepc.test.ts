import { describe, expect, it } from 'vitest';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { readGamePc, writeGamePc } from '../src/engine/agos/resource/gamePc.js';
import { readAgosArchive } from '../src/engine/agos/resource/gameArchive.js';
import {
  agosFileEvidence,
  detectAgosGame,
  looksLikeAgos,
  readsWholeGame,
} from '../src/engine/agos/resource/agosDetect.js';
import { itemIdOf } from '../src/engine/agos/world/itemTree.js';
import type { AgosTarget } from '../src/engine/agos/agosVersion.js';
import { buildArchive, buildGamePc } from './fixtureAgos.js';

const SIMON1_TALKIE: AgosTarget = {
  family: 'AGOS',
  version: 'Simon1',
  releaseKind: 'talkie',
  platform: 'dos',
};
const ELVIRA1: AgosTarget = { ...SIMON1_TALKIE, version: 'Elvira1' };

function sourceOf(files: Record<string, Uint8Array>): MemoryDataSource {
  const source = new MemoryDataSource('agos-fixture');
  for (const [name, bytes] of Object.entries(files)) source.set(name, bytes);
  return source;
}

describe('reading GAMEPC', () => {
  it('reads the header, the string pool and the items', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1_TALKIE);

    expect(game.header.version).toBe(0x80);
    expect(game.strings).toEqual(['one', 'two', 'three']);
    expect(game.items).toHaveLength(2);
    expect(game.items[0]!.adjective).toBe(11);
    expect(game.subroutines.subroutines.map((sub) => sub.id)).toEqual([0, 42]);
  });

  it('keeps item links as they sit on disk, and maps them on request', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1_TALKIE);
    const room = game.items[0]!;

    // 0xFFFFFFFF is "nothing"; anything else is two less than the item it names.
    expect(itemIdOf(room.next)).toBe(0);
    expect(itemIdOf(room.child)).toBe(3);
  });

  it('sizes a room sub-structure by its exit mask rather than by a fixed length', () => {
    const game = readGamePc(buildGamePc({ withSpeech: true }), SIMON1_TALKIE);
    const room = game.items[0]!.children[0]!;

    expect(room.type).toBe(1);
    expect(room.header).toEqual([42, 0x0001]);
    expect(room.values).toHaveLength(1);
  });

  it('refuses a file whose version word is not 0x80', () => {
    const bytes = buildGamePc({ withSpeech: true });
    bytes[7] = 0x81;

    expect(() => readGamePc(bytes, SIMON1_TALKIE)).toThrow(/not a runtime database/);
  });
});

describe('rebuilding GAMEPC whole', () => {
  /**
   * ADR 0030: the file has no index, so it is re-emitted from the model rather
   * than patched, and byte-identity on an untouched import is the gate. ADR
   * 0029 makes that one of the three conditions for offering editing at all.
   */
  it('writes back byte for byte what it read', () => {
    const bytes = buildGamePc({ withSpeech: true });
    const game = readGamePc(bytes, SIMON1_TALKIE);

    expect(writeGamePc(game, SIMON1_TALKIE)).toEqual(bytes);
  });

  it('does not read as a Version whose item records are laid out differently', () => {
    const bytes = buildGamePc({ withSpeech: true });

    expect(readsWholeGame(bytes, SIMON1_TALKIE)).toBe(true);
    // Elvira 1 puts a 32-bit name ahead of the adjective and an extra word after
    // the state, so every field after the first is read from the wrong place.
    expect(readsWholeGame(bytes, ELVIRA1)).toBe(false);
  });
});

describe('recognising AGOS data', () => {
  it('claims a game on positive evidence rather than on absence', () => {
    expect(looksLikeAgos(['GAMEPC', 'SIMON.GME'])).toBe(true);
    expect(looksLikeAgos(['MONKEY.000', 'MONKEY.001'])).toBe(false);
    // `demo` alone is too weak to claim: it needs something else AGOS ships.
    expect(looksLikeAgos(['demo'])).toBe(false);
    expect(looksLikeAgos(['demo', 'TBLLIST'])).toBe(true);
  });

  it('reads the release kind off the speech files, because decoding depends on it', () => {
    expect(agosFileEvidence(['GAMEPC', 'SIMON.GME']).releaseKind).toBe('floppy');
    expect(agosFileEvidence(['GAMEPC', 'SIMON.GME', 'SIMON.VOC']).releaseKind).toBe('talkie');
    // ADR 0028 admits repackaged data, whose speech ScummVM's tools re-encoded.
    expect(agosFileEvidence(['GAMEPC', 'SIMON.GME', 'simon.ogg']).releaseKind).toBe('talkie');
  });

  it('lets an archive name the Version outright', async () => {
    const detection = await detectAgosGame(
      sourceOf({
        GAMEPC: buildGamePc({ withSpeech: true }),
        'SIMON.GME': buildArchive(),
        'SIMON.VOC': Uint8Array.of(0),
      }),
    );

    expect(detection.target.version).toBe('Simon1');
    expect(detection.target.releaseKind).toBe('talkie');
    expect(detection.identification).toBe('file-names');
  });

  it('finishes the job structurally when four Versions share a file name', async () => {
    const detection = await detectAgosGame(
      sourceOf({ GAMEPC: buildGamePc({ withSpeech: false }) }),
    );

    // Elvira 1 and Elvira 2 lay their item records out differently and cannot
    // survive the read, so they are gone on evidence rather than on preference.
    expect(detection.candidates).not.toContain('Elvira1');
    expect(detection.candidates).not.toContain('Elvira2');
    // What remains is either settled or honestly narrowed — never guessed.
    expect(['structural', 'narrowed']).toContain(detection.identification);
  });
});

describe('the resource archive', () => {
  it('reads its offset table little-endian, unlike everything else in AGOS', () => {
    const archive = readAgosArchive(buildArchive());

    // Entry 0 is the table's own size and doubles as the first resource's
    // offset, which is the format being frugal rather than the reader being
    // confused: ScummVM reads it as an offset too.
    expect(archive.entries.map((entry) => entry.number)).toEqual([0, 1, 2]);
    expect(archive.read(1)).toEqual(Uint8Array.of(0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7));
    expect(archive.read(2)).toHaveLength(4);
    expect(archive.read(9)).toBeUndefined();
  });

  it('refuses a table whose size cannot be right', () => {
    expect(() => readAgosArchive(Uint8Array.of(0xff, 0xff, 0xff, 0xff))).toThrow(/cannot be right/);
  });
});
