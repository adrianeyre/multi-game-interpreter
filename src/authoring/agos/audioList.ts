/**
 * What a game has to listen to, listed rather than copied.
 *
 * The Audio section was empty for every AGOS game, because `toEditableGame`
 * wrote `audio: []` and nothing else ever filled it — so a talkie holding four
 * thousand recorded lines, three thousand sound effects and thirty-six pieces
 * of music offered an author none of them, to play or to save.
 *
 * ## Why this is a list and not an import
 *
 * The obvious fix is the one this must not do. Simon 1's speech file is
 * 47.7 MB and Simon 2's is 69.2 MB; each is on its own larger than the whole
 * 24 MB budget `importGame.ts` allows a SCUMM import's sound, and ADR 0010's
 * size threshold exists precisely to stop a project carrying that. ADR 0030
 * says the same thing from the other end: a Project records intent, not a copy
 * of the game.
 *
 * So what is built here is an **index**: one entry per recording, carrying the
 * number the game itself uses and nothing else. The bytes stay in the folder
 * and are read at the moment one is played or saved (ADR 0034), through
 * `readTrackBytes`.
 *
 * ## The three kinds are numbered independently
 *
 * Speech is numbered game-wide: an operand in a talkie's script says which
 * line to play. Music is numbered game-wide too, as an offset from the
 * archive's music base. **Effects are not** — AGOS swaps a whole bank of them
 * as the game moves between its parts, one bank per `TABLES` file, so "effect
 * 12" is only an address once the bank is named. That is why an effect entry
 * carries two numbers and the other two carry one.
 *
 * ## Smallest first
 *
 * Music, then effects, then speech. A game has tens of pieces of music and
 * thousands of lines of speech, and a list that opened with eleven thousand
 * numbered lines would bury the thirty-six an author is most likely to want.
 */

import { detectAudioFormat, type AudioFormat, type ProjectAudio } from '../audio.js';
import { speechKind, type SpeechEntry, type SpeechIndex } from '../../engine/agos/sound/speech.js';
import { readEffectsIndex } from '../../engine/agos/sound/effects.js';

/** One bank of numbered effects, and where it came from. */
export interface AgosEffectBank {
  /** The `TABLES` file this bank travels with, by its own number. */
  readonly number: number;
  /**
   * The file beside the game it was read from.
   *
   * Absent where the bank is an entry in the resource archive instead, which
   * is how Simon 2 ships them. Recorded as it is spelled on disk rather than
   * reconstructed: Simon 1's retail folder holds `SFXXXX13` and `sfxxxx15` in
   * different cases, and a name rebuilt from the number would miss one of them
   * on a case-sensitive filesystem.
   */
  readonly file?: string;
  readonly bytes: Uint8Array;
}

/** Everything a game has that makes a noise, opened. */
export interface AgosAudioSources {
  /** The talkie's recorded lines and the file holding them; absent on floppy. */
  readonly speech?: { readonly index: SpeechIndex; readonly file: string };
  readonly effects: readonly AgosEffectBank[];
  readonly music: readonly { readonly number: number; readonly bytes: Uint8Array }[];
  /** The archive, for the entries that have no file of their own to name. */
  readonly archiveFile: string;
}

/**
 * Sniffed once per container rather than once per entry.
 *
 * A speech file is one encoding throughout — the whole point of the offset
 * table is that the recordings are the same kind of thing — so asking the
 * first is asking all of them. Asking each would matter if that were free, and
 * it is not: `detectAudioFormat` scans the first 64 KB of anything it has not
 * already recognised, looking for a Roland ROM's name, and eleven thousand of
 * those is a visible pause at import for an answer that cannot vary.
 */
function formatOf(bytes: Uint8Array | undefined): AudioFormat {
  return bytes ? detectAudioFormat(bytes) : 'unknown';
}

/**
 * The speech entries that are really recordings.
 *
 * Entry zero's offset is zero, so the span it names is the offset table
 * itself — `effects.ts` says the same thing about its own container, and the
 * effects reader already drops it. The speech reader does not, because playing
 * a line the engine asked for by number is a different job from listing what
 * there is: the engine only ever asks for numbers its scripts hold.
 *
 * By signature rather than by index, for the reason the effects reader gives:
 * index zero is a fact about one layout, where a span that is not a sound is a
 * fact about the entry. But a container whose every entry is unrecognised is
 * listed whole — a release encoded in something this does not know is still a
 * release with speech in it, and reporting that it has none would be worse
 * than listing one entry too many.
 */
function spokenEntries(index: SpeechIndex): readonly SpeechEntry[] {
  const spoken = index.entries.filter((entry) => {
    const bytes = index.read(entry.index);
    return bytes !== undefined && speechKind(bytes) !== 'unknown';
  });
  return spoken.length > 0 ? spoken : index.entries;
}

export function listAgosAudio(sources: AgosAudioSources): ProjectAudio[] {
  const tracks: ProjectAudio[] = [];
  // Positional and allocated here rather than derived from the game's own
  // numbers, because the three kinds number independently and would collide:
  // there is a speech 12, an effect 12 and a music 12. The game's number is on
  // the entry itself, which is what an author reads and what resolves back to
  // bytes.
  const nextId = (): number => tracks.length + 1;

  for (const track of sources.music) {
    tracks.push({
      id: nextId(),
      name: `Music ${track.number}`,
      format: formatOf(track.bytes),
      filename: sources.archiveFile,
      bytes: track.bytes.length,
      resource: { engine: 'agos', kind: 'music', number: track.number },
    });
  }

  for (const bank of sources.effects) {
    const index = readEffectsIndex(bank.bytes);
    const format = formatOf(index.read(index.entries[0]?.index ?? 0));
    for (const entry of index.entries) {
      tracks.push({
        id: nextId(),
        name: `Effect ${entry.index}, bank ${bank.number}`,
        format,
        filename: bank.file ?? sources.archiveFile,
        bytes: entry.length,
        resource: {
          engine: 'agos',
          kind: 'effects',
          number: entry.index,
          bank: bank.number,
          ...(bank.file ? { file: bank.file } : {}),
        },
      });
    }
  }

  const speech = sources.speech;
  if (speech) {
    const spoken = spokenEntries(speech.index);
    const format = formatOf(speech.index.read(spoken[0]?.index ?? 0));
    for (const entry of spoken) {
      tracks.push({
        id: nextId(),
        name: `Speech ${entry.index}`,
        format,
        filename: speech.file,
        bytes: entry.length,
        resource: { engine: 'agos', kind: 'speech', number: entry.index, file: speech.file },
      });
    }
  }

  return tracks;
}
