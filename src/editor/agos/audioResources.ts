/**
 * Reading one of a game's own recordings back out of its folder.
 *
 * The other end of `authoring/agos/audioList.ts`. That side lists what a game
 * has, by number and without keeping a byte; this side turns one of those
 * numbers back into bytes at the moment an author presses play or save. ADR
 * 0034's gesture is what makes both halves possible — the folder is open for
 * the session, so nothing has to be copied into the project to be reachable.
 *
 * ## One reader per folder, so a cache cannot outlive what it caches
 *
 * A talkie's speech file is 47.7 MB (Simon 1) or 69.2 MB (Simon 2), and every
 * recording in it is addressed through the same offset table. Reading the file
 * again per click would be tens of megabytes for a two-second line, so the
 * index — which holds the bytes — is kept. Keeping it on a module-level
 * variable would mean a second folder opened later serving the first one's
 * recordings, which is exactly the plausible-nonsense failure `resupply.ts`
 * exists to prevent, so the cache belongs to the reader and the reader belongs
 * to one accepted folder.
 */

import { readEffectsIndex, type EffectsIndex } from '../../engine/agos/sound/effects.js';
import { readSpeechIndex, type SpeechIndex } from '../../engine/agos/sound/speech.js';
import { speechFileIn } from '../../engine/agos/sound/audioFiles.js';
import type { AudioResource } from '../../authoring/audio.js';
import type { AudioResourceReader } from '../audioBytes.js';
import type { AgosGameFolder } from './resupply.js';

/** The bytes a resource entry addresses, or null when this folder has none. */
export function agosAudioReader(folder: AgosGameFolder): AudioResourceReader {
  let speech: { file: string; index: SpeechIndex } | null = null;
  const banks = new Map<number, EffectsIndex | null>();

  const speechIndex = async (resource: AudioResource): Promise<SpeechIndex | null> => {
    // The entry's own file first. The listing is the fallback for an entry
    // written before one was recorded, and it uses the engine's own rule so
    // the two cannot pick different files out of the same folder.
    const file = resource.file ?? speechFileIn(folder.speechNames);
    if (!file) return null;
    if (speech?.file === file) return speech.index;
    const bytes = await folder.read(file);
    if (!bytes || bytes.length <= 8) return null;
    speech = { file, index: readSpeechIndex(bytes) };
    return speech.index;
  };

  const effectsIndex = async (resource: AudioResource): Promise<EffectsIndex | null> => {
    const bank = resource.bank;
    if (bank === undefined) return null;
    const cached = banks.get(bank);
    if (cached !== undefined) return cached;
    // Both of AGOS's packagings, chosen by whether the entry named a file:
    // loose `SFXXXX02` … `SFXXXX29` beside Simon 1, an archive entry at the
    // sound base for Simon 2. The archive is indexed from the table file's own
    // number less one, the way `subroutine.cpp:379` does it.
    const bytes = resource.file ? await folder.read(resource.file) : folder.sound(bank - 1);
    const index = bytes && bytes.length > 8 ? readEffectsIndex(bytes) : null;
    banks.set(bank, index);
    return index;
  };

  return async (resource) => {
    if (resource.engine !== 'agos') return null;
    switch (resource.kind) {
      case 'speech':
        return (await speechIndex(resource))?.read(resource.number) ?? null;
      case 'effects':
        return (await effectsIndex(resource))?.read(resource.number) ?? null;
      case 'music':
        return folder.music(resource.number) ?? null;
      default:
        return null;
    }
  };
}
