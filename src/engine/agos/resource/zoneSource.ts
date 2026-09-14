/**
 * Where a graphics zone's two resources come from.
 *
 * ADR 0030 splits packaging from encoding: **a reader per layout**, and one
 * decoder told what it is looking at. This is that split at its narrowest —
 * every AGOS Version wants the same two things for a zone, its scripts and its
 * pixels, and they differ only in where those two things are kept.
 *
 * - **Packed.** Simon 1 and Simon 2 keep them in one archive addressed by an
 *   offset table, at entries `zone * 2` and `zone * 2 + 1`. Arithmetic rather
 *   than a lookup.
 * - **Old bundle.** Elvira 1, Elvira 2 and Waxworks keep them as loose numbered
 *   files beside the game — `%.2d%d.VGA`, so zone 3's scripts are `031.VGA`
 *   and its pixels `032.VGA`. Simon's demo uses the same layout with a
 *   three-digit number.
 * - **AGOS 2.** The Feeble Files and the Puzzle Pack keep everything in one
 *   `graphics.vga`, zlib-deflated, addressed through an index file
 *   (`agos2Zones.ts`).
 *
 * Both are read ahead of time rather than on demand, which is a deliberate
 * narrowing rather than an oversight: rendering happens inside a frame, and a
 * frame cannot wait on a file read. The cost is bounded because the games that
 * use the loose layout are the small ones.
 */

import type { DataSource } from '../../resource/DataSource.js';
import { readAgosArchive, type AgosArchive } from './gameArchive.js';
import { readAgos2Zones } from './agos2Zones.js';
import { archiveBasesFor, type AgosArchiveBases, type AgosVersion } from '../agosVersion.js';

/**
 * The last zone a packed archive holds graphics for.
 *
 * The graphics occupy entries `0` upward; the music, text, tables and effects
 * sit at bases further up the same offset table (`archiveBasesFor`). So the
 * lowest of those bases is the first entry that is *not* graphics, and a zone is
 * two entries — its scripts and its pixels — so the last whole zone is
 * `floor(lowest / 2) − 1`. This is a fact about where a Version's graphics stop,
 * not a maximum picked to make a number small: bounding at it makes the zones a
 * game reports as "present but unreadable" go to zero, because the entries that
 * used to answer past the end were its music and text.
 *
 * A base of zero means the Version keeps that kind of resource beside the game
 * rather than in the archive (Simon 1's effects), so it is not a bound and is
 * dropped before the minimum.
 */
function highestGraphicsZone(bases: AgosArchiveBases): number {
  const firstNonGraphics = Math.min(
    ...[bases.tables, bases.text, bases.music, bases.sound].filter((entry) => entry > 0),
  );
  return Math.floor(firstNonGraphics / 2) - 1;
}

/** A zone's two resources, or nothing when the game does not ship that zone. */
export interface ZoneResources {
  readonly scripts: Uint8Array;
  readonly pixels: Uint8Array;
}

export interface ZoneSource {
  /** How the zones are packaged, for a status line to name. */
  readonly layout: 'packed' | 'old-bundle' | 'agos2' | 'none';
  zone(number: number): ZoneResources | undefined;
  /**
   * The highest zone number this packaging holds graphics for, where it can be
   * said at all.
   *
   * A packed archive answers `zone(n)` by arithmetic — entries `n * 2` and
   * `n * 2 + 1` — and keeps its music, text, tables and effects in the *same*
   * table further up, so `zone(n)` for a large `n` hands back a music track or a
   * sound bank as though it were a zone. Nothing in the arithmetic says where
   * the graphics stop; `packedZones` works it out from `archiveBasesFor` and
   * records it here, so a walk over the zones can stop rather than reading a
   * game's whole non-graphics half as art.
   *
   * The knowledge belongs to the packaging rather than to a caller: a
   * `ZoneSource` is where "how the zones are laid out" already lives, and
   * `readAgosArt` is handed one of these and not a Version. Undefined for the
   * layouts that need no bound — the loose-bundle and AGOS 2 sources only answer
   * `zone(n)` for zones that are actually present, so they cannot walk off the
   * end the way the packed arithmetic can.
   */
  readonly highestGraphicsZone?: number;
  /**
   * A music track, where the packaging holds one.
   *
   * Music sits in the same archive as the graphics, at an entry a track number
   * indexes directly — so it is the same reader, not a second one. The
   * old-bundle games keep their music in separate files and this returns
   * nothing for them, which is a gap rather than a wrong answer.
   */
  music?(track: number): Uint8Array | undefined;
  /**
   * A numbered bank of sound effects, where the packaging holds one.
   *
   * Simon 2 keeps its effects in the archive at a base of their own. Simon 1
   * does not — its `sound` base is zero and its effects arrive as separate
   * files — so this answering nothing is the normal case for one of the two
   * games that has the field at all.
   */
  sound?(bank: number): Uint8Array | undefined;
  /**
   * The archive these zones came out of, where the packaging has one.
   *
   * Exposed because the archive is not the graphics' private property: the
   * table Subroutines, the local strings and the music are all in the same
   * offset table, and re-reading a seven-megabyte file to reach them would be
   * a second copy of it in memory to answer the same questions.
   */
  readonly archive?: AgosArchive;
}

/** The layout a Version ships its graphics in. */
export function zoneLayoutFor(version: AgosVersion): 'packed' | 'old-bundle' | 'agos2' {
  if (version === 'Elvira1' || version === 'Elvira2' || version === 'Waxworks') {
    return 'old-bundle';
  }
  return version === 'Feeble' || version === 'PuzzlePack' ? 'agos2' : 'packed';
}

/**
 * Zones out of one archive, addressed by arithmetic.
 *
 * **Music and effects are not addressed the same way**, and used to be. A
 * zone's two resources start at entry zero, so `zone * 2` is right; music sits
 * at a base of its own further up the same table (`archiveBasesFor`), and
 * reading track *n* as entry *n* returned a zone's pixels. It failed silently
 * because a zone resource is bytes and so is a music track: something played,
 * and what played was a picture.
 */
export function packedZones(archive: AgosArchive, version: AgosVersion): ZoneSource {
  const bases = archiveBasesFor(version);
  return {
    layout: 'packed',
    archive,
    highestGraphicsZone: bases ? highestGraphicsZone(bases) : undefined,
    zone(number) {
      const scripts = archive.read(number * 2);
      const pixels = archive.read(number * 2 + 1);
      if (!scripts || !pixels) return undefined;
      return { scripts, pixels };
    },
    music: (track) => (bases ? archive.read(bases.music + track) : undefined),
    // A base of zero means this Version keeps its effects somewhere else, which
    // is not the same as effect bank zero being at the front of the archive.
    sound: (bank) => (bases?.sound ? archive.read(bases.sound + bank) : undefined),
  };
}

/** Zones as loose numbered files, read ahead of time. */
export function looseZones(files: Map<number, ZoneResources>): ZoneSource {
  return {
    layout: 'old-bundle',
    zone: (number) => files.get(number),
  };
}

/** A game with no graphics at all, which is what a bare `GAMEPC` dump is. */
export const noZones: ZoneSource = { layout: 'none', zone: () => undefined };

function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/**
 * Reads whichever layout these files are in.
 *
 * The Version chooses, rather than the file names, because "no `.VGA` files
 * present" is not evidence of a packed layout — it is equally evidence of a
 * dump missing its graphics, and those two want different messages.
 */
export async function readZoneSource(
  source: DataSource,
  version: AgosVersion,
): Promise<ZoneSource> {
  const layout = zoneLayoutFor(version);

  if (layout === 'agos2') {
    return (await readAgos2Zones(source)) ?? noZones;
  }

  if (layout === 'packed') {
    const name = source.list().find((each) => /\.gme$/i.test(baseName(each)));
    if (!name) return noZones;
    const bytes = await source.read(name);
    return bytes ? packedZones(readAgosArchive(bytes), version) : noZones;
  }

  // `NN1.VGA` is zone NN's scripts and `NN2.VGA` its pixels. Two or three
  // digits depending on the release, so the number is whatever precedes the
  // type digit rather than a fixed width.
  const byZone = new Map<number, { scripts?: Uint8Array; pixels?: Uint8Array }>();
  for (const name of source.list()) {
    const match = /^(\d+)([12])\.vga$/.exec(baseName(name));
    if (!match) continue;
    const bytes = await source.read(name);
    if (!bytes) continue;
    const zone = Number(match[1]);
    const entry = byZone.get(zone) ?? {};
    if (match[2] === '1') entry.scripts = bytes;
    else entry.pixels = bytes;
    byZone.set(zone, entry);
  }

  const complete = new Map<number, ZoneResources>();
  for (const [zone, entry] of byZone) {
    // A zone with only one of its two files is not a zone. Dropping it here
    // means the engine sees "no such zone" rather than a half-loaded one.
    if (entry.scripts && entry.pixels)
      complete.set(zone, { scripts: entry.scripts, pixels: entry.pixels });
  }
  return complete.size > 0 ? looseZones(complete) : noZones;
}
