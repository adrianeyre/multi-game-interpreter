/**
 * Recognising SCI game data, and working out which Target it is.
 *
 * A sibling of `src/engine/agi/resource/agiDetect.ts` and of
 * `src/engine/resource/GameDetector.ts`, not an extension of either. SCUMM
 * opens with a chunk tag, AGI has index files beside numbered volumes, and SCI
 * has a map addressing N volumes by offset — the third of the three shapes #194
 * widened `DetectedGame` for.
 *
 * **A SCI game is a set of files.** One map and as many volumes as the release
 * shipped on, which for Phantasmagoria is seven discs' worth. Nothing here
 * assumes an index-and-data pair.
 */

import type { DataSource } from '../../resource/DataSource.js';
import type { SciIdentification, SciPlatform, SciVersion } from '../sciVersion.js';
import { detectMapVersion, isDirectoryMap, type SciMapVersion } from './resourceMap.js';

function baseName(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toLowerCase();
}

/**
 * How a release names its files.
 *
 * Two schemes, and they do not line up with the Version the way one would
 * hope. `RESOURCE.MAP` with `RESOURCE.000` is SCI0 through SCI1.1 and also
 * Space Quest 6, which is SCI2.1; `RESMAP.000` with `RESSCI.000` is the rest of
 * SCI32. So the names say which files to open and nothing about the Version,
 * and the Version comes from the map's own structure (ADR 0020).
 */
export interface SciLayout {
  /** The map file, in its original case. */
  mapFile: string;
  /** Volume number to file name. */
  volumes: Map<number, string>;
  /** True when the map is one of the numbered `RESMAP.0nn` set. */
  numberedMaps: boolean;
  /** Every map file, for a release that ships one per disc. */
  mapFiles: string[];
  /**
   * The alternate pack, when the release ships one, under `ALTERNATE_VOLUME`.
   *
   * Sierra's own `resource.cpp` opens three pairs by name, and this project had
   * only ever opened the first: King's Quest VII's `SIERRA.EXE` holds
   * `RESOURCE.MAP`, `RESSCI.`, **`ALTRES.MAP`, `ALTRES.000`** and
   * `RESFLMAP.%s` in that order. `ALTRES` is a whole second map and volume, in
   * the same shapes as the first, and what King's Quest VII keeps in it is
   * every one of its 76 MESSAGE resources — so a reader that opens only
   * `RESOURCE.MAP` finds a game with no words in it at all and reports, truly
   * and uselessly, that it "ships no MESSAGE resources".
   *
   * Null for every release that does not ship the pair, which is all of them
   * so far except this one.
   */
  alternate: { mapFile: string; volume: number } | null;
}

/**
 * The volume number the alternate pack's entries are given.
 *
 * An entry's volume is a number a map wrote, and the two maps number their
 * volumes independently — `ALTRES.000` is volume 0 of its own pair and
 * `RESOURCE.000` is volume 0 of the main one. Rather than teach every reader
 * which map an entry came from, the alternate's entries are renumbered into a
 * range no map can produce: SCI1 late holds the volume in four bits, a SCI32
 * map carries none at all, and the per-disc offset added to a numbered map is
 * that map's own three-digit number. So nothing below 1000 is free and
 * everything at or above it is.
 */
export const ALTERNATE_VOLUME = 1000;

/**
 * The layout these files are in, or null when they are not SCI data.
 *
 * Both halves are required — a map *and* at least one volume — because a lone
 * `RESOURCE.MAP` is not evidence. Half an extracted archive is the common case
 * and "found a map, found no volumes" is a better message than a parse error
 * from inside the map reader.
 */
export function sciLayout(fileNames: string[]): SciLayout | null {
  const byBase = new Map<string, string>();
  for (const name of fileNames) byBase.set(baseName(name), name);

  const volumes = new Map<number, string>();
  const mapFiles: string[] = [];

  // `RESOURCE.000`/`RESSCI.000` and, for a release that shipped its audio
  // separately, `RESSCI.PAT`. A volume is only claimed when its number parses,
  // so `RESOURCE.CFG` and `RESOURCE.MT` are not read as volume data.
  for (const [base, original] of byBase) {
    const volume = /^(?:resource|ressci)\.(\d{3})$/.exec(base);
    if (volume) volumes.set(Number(volume[1]), original);
    if (/^resmap\.(\d{3})$/.test(base)) mapFiles.push(original);
  }

  const numberedMaps = mapFiles.length > 0;
  if (!numberedMaps) {
    const plain = byBase.get('resource.map');
    if (plain) mapFiles.push(plain);
  }

  if (mapFiles.length === 0 || volumes.size === 0) return null;

  // Only once a main pair is established, so a stray `ALTRES` pair on its own
  // is still "not a SCI install" rather than half of one.
  const alternateMap = byBase.get('altres.map');
  const alternateVolume = byBase.get('altres.000');
  const alternate =
    alternateMap && alternateVolume ? { mapFile: alternateMap, volume: ALTERNATE_VOLUME } : null;
  if (alternate && alternateVolume) volumes.set(ALTERNATE_VOLUME, alternateVolume);

  mapFiles.sort((a, b) => baseName(a).localeCompare(baseName(b)));
  return { mapFile: mapFiles[0], volumes, numberedMaps, mapFiles, alternate };
}

/**
 * Positive evidence that these files are SCI data.
 *
 * Mirrors `looksLikeAgi`: asked before any file is read past its name, and it
 * answers on a marker this family owns rather than on the absence of another's.
 * `GameDetector` learned that lesson from a King's Quest IV dump named
 * `KQ4SG.000` — "not SCUMM" is not evidence of anything.
 */
export function looksLikeSci(fileNames: string[]): boolean {
  return sciLayout(fileNames) !== null;
}

/** Everything read from a SCI install before a resource is asked for. */
export interface DetectedSciGame {
  layout: SciLayout;
  mapVersion: SciMapVersion;
  /** The Version, after the probes have narrowed the map's bucket. */
  version: SciVersion;
  platform: SciPlatform;
  identification: SciIdentification;
  /** The game's own short id, from the folder or the map file. */
  id: string;
  /** What each probe concluded, for the log and for the editor's refusal. */
  notes: string[];
}

/**
 * The Versions a map structure alone can narrow a game to.
 *
 * This is the honest half of detection: the map's own bytes get a game to one
 * of these buckets and no further. The probes in `sciProbes.ts` do the rest,
 * and where they cannot, ADR 0013's rule applies — the game plays and is
 * refused for editing.
 */
export const VERSIONS_FOR_MAP: Record<SciMapVersion, readonly SciVersion[]> = {
  'sci0-sci1-early': ['sci0-early', 'sci0-late', 'sci01', 'sci1-ega-only', 'sci1-early'],
  'sci1-middle': ['sci1-middle'],
  'kq5-fm-towns': ['sci1-middle'],
  'sci1-late': ['sci1-late'],
  sci11: ['sci1-1'],
  sci2: ['sci2', 'sci2-1-early', 'sci2-1-middle', 'sci2-1-late', 'sci3'],
  sci3: ['sci3'],
};

/**
 * Reads the map and works out which structure it is in.
 *
 * The map is the one file read whole, and it is small — under four kilobytes
 * for every release checked, including RAMA's. Everything else goes through
 * `VolumeReader` by offset (ADR 0021).
 */
export async function detectSciMap(
  source: DataSource,
  layout: SciLayout,
): Promise<{ map: Uint8Array; mapVersion: SciMapVersion }> {
  const map = await source.read(layout.mapFile);
  if (!map) {
    throw new Error(
      `${layout.mapFile} could not be read. Make sure the whole game directory was selected.`,
    );
  }

  const mapVersion = detectMapVersion(map, (volume) => layout.volumes.has(volume));
  if (!mapVersion) {
    throw new Error(
      `${layout.mapFile} is not a SCI resource map. A SCI map is either a flat list of ` +
        `six-byte entries ending in six 0xff bytes, or a directory of three-byte records ` +
        `whose last record points at the end of the file, and this is neither.`,
    );
  }

  return { map, mapVersion };
}

/** Whether this map's entries carry their own volume number. */
export function mapCarriesVolume(mapVersion: SciMapVersion): boolean {
  return mapVersion !== 'sci11' && mapVersion !== 'sci2' && mapVersion !== 'sci3';
}

export { isDirectoryMap };
