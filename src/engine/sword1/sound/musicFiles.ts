/**
 * Which file in an install holds a tune, and which holds a line of speech.
 *
 * The counterpart of AGOS's `sound/audioFiles.ts`, and here for the same
 * reason: the engine and the editor's audio list both have to answer "where do
 * the bytes for tune 8 live", and two answers would be two chances to pick a
 * different file out of the same folder.
 *
 * ## A tune is addressed by name, not by number
 *
 * `fnPlayMusic 8` and `MUSIC/1M10.WAV` are joined only by `SWORD1_TUNE_NAMES`,
 * which is generated from the table that lived in Revolution's interpreter
 * (ADR 0029). Matching by name rather than building a path is what reads every
 * release: the demo keeps its tunes in `MUSIC/`, a retail install keeps them in
 * `MUSIC/` too but ScummVM's re-encoders leave `.ogg`, `.mp3`, `.flac` or
 * `.fla` beside them, and the folder's case differs between the two.
 */

import { sword1TuneName } from './tuneNames.js';

/** Extensions a tune can arrive in: the original, and the re-encodings. */
const MUSIC_EXTENSIONS = ['wav', 'fla', 'flac', 'ogg', 'mp3', 'aif'] as const;

/**
 * The file holding a tune, or null when this install has none.
 *
 * Case-insensitive on both the folder and the stem, because a folder copied
 * off the disc by one tool spells it `MUSIC/1M2.WAV` and by another
 * `music/1m2.wav`, and a case-sensitive filesystem then has only one of them.
 */
export function sword1MusicFileIn(names: readonly string[], tune: number): string | null {
  const stem = sword1TuneName(tune);
  if (!stem) return null;
  const wanted = new RegExp(
    `(?:^|[/\\\\])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(?:${MUSIC_EXTENSIONS.join('|')})$`,
    'i',
  );
  return names.find((name) => wanted.test(name)) ?? null;
}

/**
 * The speech container this install ships, or null when it ships none.
 *
 * Four spellings and they are not interchangeable. A retail install holds
 * `SPEECH1.CLU` and `SPEECH2.CLU`, one per disc, each with its own index; a
 * disc-layout copy holds `SPEECH/SPEECH.CLU`; the demo holds
 * `SPEECH/COWS.MAD`, whose entries are the same RLE in a file that never
 * carried the retail name. ScummVM tries them in this order
 * (`sound.cpp:761-786`) and so does this.
 */
export function sword1SpeechFileIn(names: readonly string[], disc = 1): string | null {
  const candidates = [`speech${disc}.clu`, 'speech.clu', 'cows.mad'];
  for (const candidate of candidates) {
    const wanted = new RegExp(`(?:^|[/\\\\])${candidate}$`, 'i');
    const found = names.find((name) => wanted.test(name));
    if (found) return found;
  }
  return null;
}
