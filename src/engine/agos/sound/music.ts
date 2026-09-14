/**
 * AGOS music.
 *
 * Kept in the resource archive like everything else, in a format of Adventure
 * Soft's own: **GMF**, which is MIDI track data with the file format taken off.
 * No `MThd`, no `MTrk`, no end-of-track events — a seven-byte header and then
 * the event stream, because a game that only ever plays its own music has no
 * use for the parts of a MIDI file that exist so other programs can read it.
 *
 * ## Three shapes, and the third is not GMF at all
 *
 * The Windows releases of Simon 1 and Simon 2 dropped GMF and shipped
 * **standard MIDI files** instead, bundled: a single count byte, then that many
 * complete `MThd`/`MTrk` files end to end. So a resource from those releases
 * begins `01 4D 54 68 64` and a reader that only knows GMF rejects every track
 * the game owns — which is what happened, and the report said "music: not GMF"
 * while sitting on thirty-four playable pieces.
 *
 * `readAgosMusic` is the entry point that tells the two apart by their own
 * bytes. The count byte is what makes that safe rather than a guess: a GMF
 * resource starts with `GMF`, and a bundle's second byte begins `MThd`.
 *
 * The other two shapes:
 *
 * - **A single track**, which is a piece of music. `GMF` then version, tempo
 *   and a loop flag, then events.
 * - **Several tracks**, which is a bank of sound effects. It opens with a list
 *   of 16-bit offsets — *little*-endian, alone among AGOS's big-endian
 *   everything — and each track begins with its own seven-byte header. The
 *   number of tracks is derived from the first offset rather than stored, since
 *   the list runs up to the first track it points at.
 */

import { readMidi, readMidiTrack, type MidiEvent, type MidiFile } from '../../sound/midi.js';
import { looksLikeXmidi, readXmidi } from './xmidi.js';

export interface AgosMusic extends MidiFile {
  /** Whether the piece loops, as the header says. */
  readonly loop: boolean;
  /** The header's tempo byte, which is not microseconds and not a division. */
  readonly headerTempo: number;
  /** How many tracks the file held: one for music, several for an effects bank. */
  readonly trackCount: number;
}

const HEADER_LENGTH = 7;

function isGmf(data: Uint8Array, at = 0): boolean {
  return data[at] === 0x47 && data[at + 1] === 0x4d && data[at + 2] === 0x46;
}

function readU16LE(data: Uint8Array, at: number): number {
  return (data[at] ?? 0) | ((data[at + 1] ?? 0) << 8);
}

/**
 * Reads a GMF resource into the same shape a MIDI file reads into.
 *
 * The division is not in the file. AGOS's own player runs these at a fixed
 * rate, so a value has to be supplied rather than read, and the one here is the
 * common MIDI default — stated as an assumption rather than presented as a
 * reading, in the way the tick-to-seconds ratio in the Engine is.
 */
export function readGmf(data: Uint8Array, division = 192): AgosMusic {
  if (data.length <= HEADER_LENGTH) throw new Error('GMF resource is too short to hold a header');

  const events: MidiEvent[] = [];

  if (isGmf(data)) {
    const headerTempo = data[5] ?? 0;
    const loop = data[6] === 1;
    readMidiTrack(data.subarray(HEADER_LENGTH), events);
    return finish(events, division, loop, headerTempo, 1);
  }

  // A bank: offsets first, then the tracks they point at. The count comes from
  // where the first track starts — the list fills exactly the space before it,
  // and one of its entries is the end of the last track rather than a start.
  const firstTrack = readU16LE(data, 0);
  if (firstTrack < 4 || firstTrack > data.length) {
    throw new Error('not a GMF resource: no header and no usable offset list');
  }
  const trackCount = Math.floor(firstTrack / 2) - 1;

  for (let track = 0; track < trackCount; track += 1) {
    const start = readU16LE(data, track * 2);
    const end = readU16LE(data, (track + 1) * 2);
    if (start >= end || end > data.length) continue;
    if (!isGmf(data, start)) continue;
    readMidiTrack(data.subarray(start + HEADER_LENGTH, end), events);
  }

  // A bank's tempo and loop are the same for every track, and the reference
  // hardcodes them rather than reading each track's header.
  return finish(events, division, false, 2, trackCount);
}

function finish(
  events: MidiEvent[],
  division: number,
  loop: boolean,
  headerTempo: number,
  trackCount: number,
): AgosMusic {
  events.sort((a, b) => a.tick - b.tick);
  const duration = events.length === 0 ? 0 : events[events.length - 1]!.tick;
  return { division, events, duration, loop, headerTempo, trackCount };
}

/** Whether a resource looks like music this reader understands. */
export function looksLikeGmf(data: Uint8Array): boolean {
  if (isGmf(data)) return true;
  if (data.length < 4) return false;
  const first = readU16LE(data, 0);
  return first >= 4 && first <= data.length && isGmf(data, first);
}

/** Whether a resource is a Windows release's bundle of standard MIDI files. */
export function looksLikeMidiBundle(data: Uint8Array): boolean {
  // A count, then a complete MIDI file. The count is at least one, and `MThd`
  // immediately after it is what makes this unambiguous against GMF.
  const count = data[0] ?? 0;
  if (count === 0) return false;
  return (
    data[1] === 0x4d && data[2] === 0x54 && data[3] === 0x68 && data[4] === 0x64 // "MThd"
  );
}

/**
 * Reads whichever music format this resource is in.
 *
 * One entry point over two formats, chosen by the bytes rather than by the
 * Target: the Windows releases changed the format without changing the Version,
 * so a reader keyed on `Simon1` would be wrong for half of them.
 *
 * A bundle's **first** file is the piece to play. The later ones are the
 * alternative arrangements a Windows release carried for other devices, and
 * choosing between them is a device selection this project does not make yet —
 * so the first is taken and the rest are ignored rather than concatenated,
 * which would play a piece and then two more over the top of it.
 */
export function readAgosMusic(data: Uint8Array, division = 192): AgosMusic {
  // **Simon 2's shape, and neither of the two above.** Its tracks are XMIDI in
  // an IFF container — `FORM XDIR` then a `CAT ` of `FORM XMID` — which this
  // reader rejected outright, so a game with thirty-four playable pieces
  // reported no music at all. See `xmidi.ts` for what differs.
  if (looksLikeXmidi(data)) {
    const midi = readXmidi(data);
    return {
      ...midi,
      // XMIDI carries no loop flag of its own; the games loop their music, and
      // the one place a track says otherwise is `os2_playTune`'s own operand.
      loop: true,
      headerTempo: 0,
      trackCount: 1,
    };
  }
  if (looksLikeMidiBundle(data)) {
    const midi = readMidi(data.subarray(1));
    return {
      ...midi,
      // A bundle carries no loop flag and no header tempo of its own: the
      // tempo is a meta event inside the file, which `readMidi` has already
      // read, and the games loop their music.
      loop: true,
      headerTempo: 0,
      trackCount: data[0] ?? 1,
    };
  }
  return readGmf(data, division);
}
