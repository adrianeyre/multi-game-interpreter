/**
 * Reading one of Broken Sword II's own recordings back out of its folder.
 *
 * Two routes, because this family keeps its recordings in two places.
 *
 * An **effect** is a `WAV_FILE` resource and the payload behind its id is
 * already a RIFF WAVE, so a read is a range read and nothing else.
 * `loadStreamed` is what does it: it reads a cluster's offset table from the
 * file's tail and then the resource by range. Asking `fetch` instead would
 * answer only for a cluster something else had already made resident, which in
 * an editor is none of them.
 *
 * A **line of speech or a tune** is not a resource at all. It is an entry in
 * `SPEECH1.CLU` or `MUSIC1.CLU` — files `resource.inf` never names — holding
 * one byte per sample of Revolution's own delta compression, so reading one
 * means reading that container's index, reading the payload by range, decoding
 * it and wrapping the samples in a WAVE header the editor's player understands.
 * `AudioResource.file` is which of the two it is, and its absence is what says
 * "this one is a resource".
 *
 * Neither demo ships a container, so the second route answers nothing on the
 * data reachable here; `docs/editor-parity.md` §27a is where that is stated on
 * the surface rather than only in a comment.
 */

import type { AudioResource } from '../../authoring/audio.js';
import type { AudioResourceReader } from '../audioBytes.js';
import { decodeSword2Clu, SWORD2_CLU_RATE } from '../../engine/sword2/sound/sword2Clu.js';
import { writeWavePcm } from '../../engine/sound/wave.js';
import type { Sword2GameFolder } from './resupply.js';

/** The bytes a resource entry addresses, or null when this folder has none. */
export function sword2AudioReader(folder: Sword2GameFolder): AudioResourceReader {
  return async (resource: AudioResource) => {
    if (resource.engine !== 'sword2') return null;
    if (resource.file !== undefined) {
      const index = await folder.resources.readSoundIndex(resource.file);
      const entry = index?.locate(resource.number);
      if (!entry) return null;
      const payload = await folder.resources.readSoundPayload(resource.file, entry);
      if (!payload || payload.length < entry.length) return null;
      return writeWavePcm(decodeSword2Clu(payload), SWORD2_CLU_RATE);
    }
    // The payload rather than the whole resource: the header in front of it is
    // this game's bookkeeping — a name, a type and a version — and a file
    // saved with it on the front is a WAVE nothing will open.
    const loaded = await folder.resources.loadStreamed(resource.number);
    return loaded?.payload ?? null;
  };
}
