import { findChunkDeep, readChunkHeader } from '../resource/Chunk.js';
import { readMidi, type MidiFile } from './midi.js';
import { findSoundBlock } from './soundChunks.js';

/**
 * Finds the music inside a SCUMM sound resource.
 *
 * A `SOU ` resource holds the same piece rendered for each sound card the game
 * supported — `ADL ` for AdLib, `ROL ` for a Roland MT-32, `SPK ` for the PC
 * speaker — and which of them are present varies per sound. Only the AdLib
 * version is playable here, because only that one targets a chip this engine
 * has.
 *
 * Inside `ADL ` the data is a Standard MIDI File, usually preceded by a small
 * `MDhd` header that carries priority and volume defaults. Rather than trust a
 * fixed offset, the `MThd` is searched for: extraction tools slice these
 * resources at different points and a file may begin at the MIDI, at the
 * `MDhd`, or at the outer container.
 */

/**
 * Sound-card blocks in the order they are worth trying.
 *
 * AdLib first, because that is the chip this renderer actually is. `ROL ` is
 * last and is a compromise: it is the Roland MT-32 arrangement, written for
 * patches an OPL2 does not have, so it comes out recognisable rather than
 * right. It is here because some releases ship nothing else — every sound in
 * Day of the Tentacle's talkie is `ROL ` alone — and the alternative for those
 * is not a better arrangement but silence.
 */
const PLAYABLE_TAGS = ['ADL ', 'ADL', 'GMD ', 'MIDI', 'ROL ', 'ROL'];

/** Locates the Standard MIDI File within a resource, wherever it begins. */
export function findMidiData(resource: Uint8Array): Uint8Array | null {
  if (resource.length < 4) return null;

  const head = String.fromCharCode(...resource.subarray(0, 4));
  if (head === 'MThd') return resource;

  // The container is searched before the raw bytes are, and the AdLib block
  // before any other. A `SOU ` resource often carries the same piece for
  // several sound cards, and a plain scan for `MThd` would return whichever
  // happened to be stored first — playing the Roland arrangement through a
  // chip it was never written for, which is exactly what Atlantis got: its
  // blocks are stored `ROL `, `ADL `, `SPK `.
  //
  // `SOU ` blocks are walked by their own rule (`listSoundBlocks`), because
  // their sizes exclude the eight bytes of their headers and the ordinary
  // walker stops after the first one.
  const preferred = findSoundBlock(resource, PLAYABLE_TAGS);
  if (preferred) {
    const inner = indexOfTag(resource, 'MThd', preferred.offset);
    if (inner >= 0 && inner < preferred.offset + preferred.size) return resource.subarray(inner);
  }

  try {
    const root = readChunkHeader(resource, 0);
    const end = Math.min(resource.length, root.dataOffset + Math.max(0, root.dataSize));
    for (const tag of PLAYABLE_TAGS) {
      const block = findChunkDeep(resource, root.dataOffset, tag, end, 3);
      if (!block) continue;
      const inner = indexOfTag(resource, 'MThd', block.dataOffset);
      if (inner >= 0) return resource.subarray(inner);
    }
  } catch {
    // Not a chunk tree, or a truncated one. Fall through to the raw scan.
  }

  // A bare `ADL ` or `MDhd` block, sliced out by an extraction tool: there is
  // no container to walk, so the MIDI has to be found by looking for it.
  const direct = indexOfTag(resource, 'MThd', 0);
  return direct >= 0 ? resource.subarray(direct) : null;
}

/** True when the resource carries a score this engine's chip can play. */
export function hasAdLibScore(resource: Uint8Array): boolean {
  return findMidiData(resource) !== null;
}

/**
 * Reads the AdLib score from a SCUMM sound resource.
 *
 * Returns null when the resource holds no MIDI at all — a digitised effect, or
 * a Roland-only piece — which the caller reports rather than treating as a
 * failure.
 */
export function readScummMusic(resource: Uint8Array): MidiFile | null {
  const midi = findMidiData(resource);
  if (!midi) return null;
  try {
    return readMidi(midi);
  } catch {
    return null;
  }
}

function indexOfTag(data: Uint8Array, tag: string, from: number): number {
  const a = tag.charCodeAt(0);
  const b = tag.charCodeAt(1);
  const c = tag.charCodeAt(2);
  const d = tag.charCodeAt(3);

  for (let i = Math.max(0, from); i + 3 < data.length; i++) {
    if (data[i] === a && data[i + 1] === b && data[i + 2] === c && data[i + 3] === d) return i;
  }
  return -1;
}
