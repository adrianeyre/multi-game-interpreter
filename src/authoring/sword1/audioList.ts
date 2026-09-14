/**
 * What Broken Sword has to listen to, listed rather than copied.
 *
 * The third of these after `agos/audioList.ts` and for the same reason, so
 * only what differs is worth saying here. ADR 0030's line is unchanged: a
 * Project records intent, not a copy of the game — the demo's speech container
 * alone is 43.9 MB and a retail disc's is 45.5 MB, so what a project holds is
 * an **index**, one entry per recording carrying the numbers the game itself
 * uses. `sword1AudioReader` turns one of those back into bytes at the moment
 * an author presses play or save, out of the folder re-supplied for the
 * session (ADR 0034).
 *
 * ## Three kinds, three different ways of being addressed
 *
 * **Effects** are the only kind that is a resource: `fnPlayFx <n>` indexes the
 * generated fx table, and the entry there holds the cluster and the index that
 * make a RIF id. Two effect numbers can name the same sample — the demo's
 * fifty-nine samples are reached by fifty-nine effect numbers but only
 * fifty-eight distinct ids — so the listing is per *effect*, which is what a
 * script says and what an author reads.
 *
 * **Music** is not a resource at all. It is a file beside the install, and
 * `fnPlayMusic 8` reaches `MUSIC/1M10.WAV` only through `SWORD1_TUNE_NAMES`,
 * the table this project generates from the one that lived in Revolution's
 * interpreter (ADR 0029). An entry is written only for a tune whose file is
 * actually present, because a listing of 269 tunes against 46 files would be
 * 223 rows that cannot play.
 *
 * **Speech** is a file too, with an index of its own that the RIF knows
 * nothing about, and it is addressed by room and then by line within the room.
 * That is why a speech entry carries two numbers where a music entry carries
 * one — `bank` holds the room, which is the field's other use.
 *
 * ## Smallest first
 *
 * Music, then effects, then speech, exactly as AGOS orders it: a release has
 * tens of tunes and thousands of lines, and opening with the lines would bury
 * the tunes an author is most likely to want.
 */

import type { ProjectAudio } from '../audio.js';
import { SWORD1_FX, sword1SampleId } from '../../engine/sword1/sound/fxTable.js';
import { sword1TuneName, SWORD1_TUNE_NAMES } from '../../engine/sword1/sound/tuneNames.js';
import { sword1MusicFileIn } from '../../engine/sword1/sound/musicFiles.js';
import type { Sword1SpeechEntry } from '../../engine/sword1/sound/speechIndex.js';

/** Everything a Broken Sword install has that makes a noise, opened. */
export interface Sword1AudioSources {
  /** The install's file names, for finding the tunes. */
  readonly names: readonly string[];
  /** Whether this is the Windows demo, whose fx table uses the other column. */
  readonly windowsDemo: boolean;
  /** Whether a sample resource is reachable — resident cluster, present id. */
  readonly hasSample: (id: number) => boolean;
  /** The speech container's lines and the file holding them; absent where none. */
  readonly speech?: { readonly file: string; readonly entries: readonly Sword1SpeechEntry[] };
}

/**
 * Every recording, as numbered rows with no bytes in them.
 *
 * The ids are positional and allocated here rather than taken from the game,
 * for AGOS's reason: the three kinds number independently, so there is a tune
 * 12, an effect 12 and a speech line 12 and using the game's numbers as project
 * ids would collide. The game's own numbers are on each entry's `resource`,
 * which is what an author reads and what resolves back to bytes.
 */
export function listSword1Audio(sources: Sword1AudioSources): ProjectAudio[] {
  const tracks: ProjectAudio[] = [];
  const nextId = (): number => tracks.length + 1;

  for (let tune = 1; tune < SWORD1_TUNE_NAMES.length; tune++) {
    const file = sword1MusicFileIn(sources.names, tune);
    if (!file) continue;
    tracks.push({
      id: nextId(),
      name: `Music ${tune} — ${sword1TuneName(tune) ?? ''}`,
      // Stated rather than sniffed. Sniffing would mean reading every tune in
      // the folder at import — 28 MB in the demo — to learn what the extension
      // already says, and `sword1MusicFileIn` only ever matches extensions
      // this knows.
      format: formatOfExtension(file),
      filename: file,
      resource: { engine: 'sword1', kind: 'music', number: tune, file },
    });
  }

  for (let fx = 0; fx < SWORD1_FX.length; fx++) {
    const id = sword1SampleId(fx, sources.windowsDemo);
    if (id === null || !sources.hasSample(id)) continue;
    tracks.push({
      id: nextId(),
      name: `Effect ${fx}`,
      format: 'wav',
      filename: `fx${fx}.wav`,
      resource: { engine: 'sword1', kind: 'effects', number: fx },
    });
  }

  const speech = sources.speech;
  if (speech) {
    for (const entry of speech.entries) {
      tracks.push({
        id: nextId(),
        // Both numbers in the name, because a line number restarts in every
        // screen: "line 3" names three thousand recordings and "screen 12,
        // line 3" names one.
        name: `Speech, screen ${entry.room} line ${entry.line}`,
        // `wav` because that is what anything downstream is handed. The
        // container's entries are a WAVE header wrapping Revolution's own
        // 16-bit RLE, which no browser decodes — so `sword1AudioReader`
        // expands one and writes a real WAVE around it, and by the time a
        // player or a save sees the bytes they are one.
        format: 'wav',
        filename: speech.file,
        bytes: entry.length,
        resource: {
          engine: 'sword1',
          kind: 'speech',
          number: entry.line,
          bank: entry.room,
          file: speech.file,
        },
      });
    }
  }

  return tracks;
}

/** What a tune's extension says it is. Never `unknown`: the matcher's list. */
function formatOfExtension(file: string): ProjectAudio['format'] {
  const extension = /\.([^.]+)$/.exec(file)?.[1]?.toLowerCase();
  switch (extension) {
    case 'mp3':
      return 'mp3';
    case 'ogg':
      return 'ogg';
    case 'fla':
    case 'flac':
      return 'flac';
    case 'aif':
      return 'aiff';
    default:
      return 'wav';
  }
}
