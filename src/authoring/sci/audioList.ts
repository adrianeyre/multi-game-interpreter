/**
 * What a SCI release has to listen to, listed rather than copied.
 *
 * The fourth of these files (ADR 0036's rule about sharing widgets and never
 * records applies here too), and the family it describes is the one that
 * labels its recordings least. Sword II's sounds carry their own names, AGOS
 * numbers its effects per bank, Sword 1's speech is keyed by room and line —
 * and a SCI recording is a **number and an offset**, with nothing beside it
 * saying what it is.
 *
 * ## Two places a digital recording lives
 *
 * - In `RESOURCE.AUD` (or `RESOURCE.SFX`), addressed by the **base audio map**
 *   — the `map` resource numbered 65535, six bytes an entry (a resource number
 *   and a 32-bit offset) in a SCI1.1 talkie and five from SCI2 on (a number and
 *   a cumulative 24-bit step; `readSciAudioMap`). This is the talkie case and
 *   it is where the volume is.
 * - As an `audio` resource in the ordinary resource map, read out of a Volume
 *   like any View. Smaller releases do this and the reader does not care.
 *
 * A row records which of the two by the `file` field `AudioResource` already
 * has: named for the first, absent for the second, which is exactly the "in
 * the archive" meaning AGOS gave it.
 *
 * ## What `kind` can honestly say
 *
 * Very little, so it says the one thing the container states. `RESOURCE.SFX`
 * is a release separating its effects out, so entries read from it are
 * `effects`; everything else is `speech`, because that is what `RESOURCE.AUD`
 * holds in every talkie. A release with no speech that keeps digital effects in
 * `RESOURCE.AUD` will have them listed as speech, and that is an imprecision
 * worth naming rather than a fact: SCI stamps no kind on a sample, and reading
 * one to guess would be reading hundreds of megabytes to label a row.
 *
 * ## What is not here
 *
 * **Per-room speech (`audio36`).** Those recordings are keyed by the four-part
 * Message tuple — noun, verb, condition, sequence — which is the join between a
 * line's text, its recording and its mouth timing (#222). `AudioResource`'s
 * address is `{kind, number, bank}`: two numbers, where this needs four and
 * needs them to stay the *same* four the Messages carry. Squeezing a tuple into
 * one of those numbers would make an address that cannot be read back to the
 * Message it belongs to, so the rows are left out and counted instead.
 *
 * **`sound` resources.** SCI's music is Sierra's own multi-device SND format,
 * played by the interpreter's driver rather than handed to a decoder. It is not
 * a file an author saves or replaces, so it is not a recording in this sense
 * and no row pretends otherwise.
 */

import type { ProjectAudio } from '../audio.js';
import type { SciResourceType } from '../../engine/sci/resource/sciResourceTypes.js';
import {
  readSciAudioMap,
  SCI_BASE_AUDIO_MAP,
  sciDiscAudioVolume,
} from '../../engine/sci/sound/sciAudio.js';

function baseOf(name: string): string {
  return (name.replace(/\\/g, '/').split('/').pop() ?? name).toUpperCase();
}

/** Where one recording is, as the listing needs to describe it. */
export interface SciAudioEntryInfo {
  /** The number the game's own scripts and maps use. */
  readonly number: number;
  /**
   * Which container the bytes are in.
   *
   * `aud` and `sfx` are the two bulk files, addressed through the base map;
   * `volume` is an `audio` resource read through the resource map like any
   * other.
   */
  readonly where: 'aud' | 'sfx' | 'volume';
  /** The recording's length, where it is known without reading the sample. */
  readonly bytes?: number;
  /**
   * The bulk file by name, where it is not `RESOURCE.AUD` or `RESOURCE.SFX` —
   * a numbered-disc install's `RESAUD.00n` or `RESSFX.00n`.
   */
  readonly file?: string;
}

export interface SciAudioSources {
  readonly entries: readonly SciAudioEntryInfo[];
}

/** The file a `where` names, or nothing for a resource in a Volume. */
function containerOf(where: SciAudioEntryInfo['where']): string | undefined {
  if (where === 'aud') return 'RESOURCE.AUD';
  if (where === 'sfx') return 'RESOURCE.SFX';
  return undefined;
}

/**
 * Every digital recording, as numbered rows with no bytes in them.
 *
 * Project ids are positional, as they are in the other three families, and for
 * the reason Sword II states: a resource number could be the project id, and
 * letting the two number spaces meet is how an imported file silently shadows
 * audio 42.
 *
 * A number reached twice — once through the base map and once as an `audio`
 * resource — is one recording listed once. The base map wins, because a
 * release that has one is addressing its bulk file through it.
 */
export function listSciAudio(sources: SciAudioSources): ProjectAudio[] {
  const seen = new Set<number>();
  const rows: ProjectAudio[] = [];

  for (const entry of sources.entries) {
    if (seen.has(entry.number)) continue;
    seen.add(entry.number);

    const file = entry.file ?? containerOf(entry.where);
    const kind = entry.where === 'sfx' ? 'effects' : 'speech';
    rows.push({
      id: rows.length + 1,
      name: `${kind === 'effects' ? 'Effect' : 'Audio'} ${entry.number}`,
      // What comes back from the reader is a WAVE either way: a release
      // shipping RIFF is passed through, and Sierra's own SOL is wrapped in
      // one. Sword 1's speech rows are labelled on the same argument.
      format: 'wav',
      filename: file ?? 'resource map',
      ...(entry.bytes === undefined ? {} : { bytes: entry.bytes }),
      resource: { engine: 'sci', kind, number: entry.number, ...(file ? { file } : {}) },
    });
  }

  return rows;
}

/** What the surface says about the speech these rows do not reach. */
export function describeSciAudio36(maps: number): string | null {
  if (maps <= 0) return null;
  return (
    `${maps} per-room speech map${maps === 1 ? '' : 's'} are held by this release and are not ` +
    `listed. Their recordings are keyed by the four-part Message tuple (noun, verb, condition, ` +
    `sequence) that ties a line's text, its speech and its mouth timing together (#222), and a ` +
    `track's address here is two numbers. Listing them would mean an address that cannot be ` +
    `read back to the Message it belongs to.`
  );
}

/** The little of `SciResources` this listing needs, so a test can stand in. */
export interface SciAudioResources {
  read(type: SciResourceType, number: number): Promise<Uint8Array | null>;
  list(type: SciResourceType): number[];
  /**
   * True from SCI2 on, where the base map is the five-byte cumulative form
   * (`readSciAudioMap`). Absent reads as false, the six-byte form.
   */
  readonly isSci32?: boolean;
  /**
   * A numbered-disc install's discs and the reads that reach each one's own
   * maps, which the base map of the whole-game table does not stand in for:
   * each disc's map 65535 addresses that disc's own Volume.
   */
  readonly discs?: number[];
  readOnDisc?(type: SciResourceType, number: number, disc: number): Promise<Uint8Array | null>;
  readonly layout?: {
    readonly multiDiscAudio: boolean;
    readonly discAudioFiles: ReadonlyMap<string, string>;
  };
}

/**
 * What a release holds, from two index reads and no sample.
 *
 * The base map is a few kilobytes and the `audio` list is an index the resource
 * map already has, so an import that lists ten thousand recordings still never
 * opens `RESOURCE.AUD` — which is ADR 0021's rule and #227's, and the reason a
 * SCI2.1 talkie can be imported in a browser at all.
 */
export async function readSciAudioEntries(
  resources: SciAudioResources,
): Promise<{ entries: SciAudioEntryInfo[]; audio36Maps: number }> {
  const entries: SciAudioEntryInfo[] = [];

  const multiDisc = resources.layout?.multiDiscAudio === true && resources.readOnDisc;
  if (multiDisc) {
    // Every disc's base map, lowest disc first, so the row for a number two
    // discs both list is the disc the game plays it from (`listSciAudio`
    // keeps the first; `findSciDiscRecording` says why that is the right one).
    for (const disc of resources.discs ?? []) {
      const base = await resources.readOnDisc!('map', SCI_BASE_AUDIO_MAP, disc);
      const file = sciDiscAudioVolume(resources.layout!.discAudioFiles, SCI_BASE_AUDIO_MAP, disc);
      if (!base || !file) continue;
      for (const entry of readSciAudioMap(base, { sci32: resources.isSci32 === true })) {
        if (entry.number === undefined) continue;
        entries.push({
          number: entry.number,
          where: /^RESSFX/i.test(baseOf(file)) ? 'sfx' : 'aud',
          file: baseOf(file),
        });
      }
    }
  }
  const base = multiDisc ? null : await resources.read('map', SCI_BASE_AUDIO_MAP);
  if (base) {
    for (const entry of readSciAudioMap(base, { sci32: resources.isSci32 === true })) {
      if (entry.number === undefined) continue;
      entries.push({ number: entry.number, where: entry.volume });
    }
  }

  for (const number of resources.list('audio')) entries.push({ number, where: 'volume' });

  // Every `map` resource that is not the base one keys a room's speech by
  // Message tuple. Counted rather than read: what is wanted is how much is not
  // listed, and that is the number of tables rather than their contents.
  const audio36Maps = resources
    .list('map')
    .filter((number) => number !== SCI_BASE_AUDIO_MAP).length;

  return { entries, audio36Maps };
}
