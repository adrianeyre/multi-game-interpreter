/**
 * XMIDI, which is how Simon 2 ships its music.
 *
 * `music.ts` knows two shapes — Adventure Soft's own **GMF**, and the bundle of
 * standard MIDI files their Windows releases moved to — and Simon 2 is neither.
 * Its tracks open
 *
 * ```
 * FORM....XDIR INFO...... CAT ....XMID FORM....XMID TIMB......EVNT
 * ```
 *
 * which is **XMIDI**: Origin's IFF-wrapped format, the one AIL/Miles played.
 * `zoneSource.music(t)` has been returning these bytes correctly all along and
 * the reader rejected every one of them, so a game with thirty-four playable
 * pieces reported no music at all.
 *
 * ## What differs from a standard MIDI track
 *
 * Three things, and the second is the one that makes a naive reader produce a
 * held chord rather than a tune.
 *
 * - **The delay before an event is a run of bytes below 0x80, summed** — not a
 *   variable-length quantity. `7F 7F 10` is 255 ticks, where a standard track
 *   would read the same three bytes as one value and then an event.
 * - **A note-on carries its duration and there are no note-offs.** After the
 *   velocity comes a variable-length quantity saying how long the note lasts,
 *   and the player is expected to end it itself. So this reader emits the
 *   note-off, which is why it holds a pending list rather than streaming.
 * - **There is no `MThd`, so there is no division.** XMIDI is played at a fixed
 *   120 ticks a second, which is 60 ticks a beat at the default 500,000
 *   microseconds a beat — stated here as the assumption it is, because nothing
 *   in the file says it.
 *
 * ## What it does not do
 *
 * `XDIR`'s `INFO` gives a sequence count and `CAT ` may hold several `FORM
 * XMID`s. Only the **first** is read, for the reason `music.ts` gives for a
 * bundle's first file: the rest are arrangements for other devices, and
 * choosing between them is a device selection this project does not make yet.
 * `TIMB` is a timbre list for a synthesiser this project does not drive, and
 * `RBRN` is a branch-point index for a sequencer feature no AGOS game uses;
 * both are skipped rather than read.
 */

import {
  MIDI_META,
  MIDI_NOTE_OFF,
  MIDI_NOTE_ON,
  type MidiEvent,
  type MidiFile,
} from '../../sound/midi.js';

/** Ticks a beat, at the tempo below. Together these are XMIDI's fixed 120Hz. */
const XMIDI_DIVISION = 60;
/** Microseconds a beat: the MIDI default, which with the division gives 120Hz. */
const XMIDI_TEMPO = 500_000;

/** How many data bytes a channel message carries, by its high nibble. */
function dataBytesFor(status: number): number {
  const kind = status & 0xf0;
  return kind === 0xc0 || kind === 0xd0 ? 1 : 2;
}

function readU32BE(data: Uint8Array, at: number): number {
  return (
    (data[at] ?? 0) * 0x1000000 +
    ((data[at + 1] ?? 0) << 16) +
    ((data[at + 2] ?? 0) << 8) +
    (data[at + 3] ?? 0)
  );
}

function tagAt(data: Uint8Array, at: number): string {
  return String.fromCharCode(
    data[at] ?? 0,
    data[at + 1] ?? 0,
    data[at + 2] ?? 0,
    data[at + 3] ?? 0,
  );
}

/** Whether these bytes are an XMIDI file, by their own header rather than by name. */
export function looksLikeXmidi(data: Uint8Array): boolean {
  if (data.length < 12) return false;
  if (tagAt(data, 0) !== 'FORM') return false;
  const type = tagAt(data, 8);
  return type === 'XDIR' || type === 'XMID';
}

/**
 * The first `EVNT` chunk in the file, or null.
 *
 * A flat scan rather than a recursive descent through `FORM`, `CAT ` and their
 * types. The nesting is fixed and shallow, the chunk ids are four bytes that do
 * not occur in event data at a chunk boundary, and a scan cannot be fooled into
 * running off the end of a container whose length is wrong — which is the
 * failure a descent would turn into an exception on a game's real bytes.
 */
function findEventChunk(data: Uint8Array): Uint8Array | null {
  let at = 0;
  while (at + 8 <= data.length) {
    const tag = tagAt(data, at);
    const length = readU32BE(data, at + 4);
    if (tag === 'EVNT') {
      const end = Math.min(data.length, at + 8 + length);
      return data.subarray(at + 8, end);
    }
    // `FORM` and `CAT ` hold other chunks, so step *into* them past their type
    // word rather than over their whole length.
    at += tag === 'FORM' || tag === 'CAT ' ? 12 : 8 + length + (length & 1);
  }
  return null;
}

/** A note waiting for the note-off this reader has to emit itself. */
interface PendingNote {
  readonly endsAt: number;
  readonly channel: number;
  readonly note: number;
}

/** A variable-length quantity, as a standard MIDI file writes one. */
function variable(data: Uint8Array, at: number): { value: number; next: number } {
  let value = 0;
  let offset = at;
  for (let read = 0; read < 4; read += 1) {
    const byte = data[offset];
    if (byte === undefined) break;
    offset += 1;
    value = (value << 7) | (byte & 0x7f);
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: offset };
}

/**
 * Reads an XMIDI resource into the shape a standard MIDI file reads into.
 *
 * Throws when the bytes are not XMIDI or carry no `EVNT`, so a caller can tell
 * "this is a format I do not know" from "this is a track that plays nothing".
 */
export function readXmidi(data: Uint8Array): MidiFile {
  const events = findEventChunk(data);
  if (!events) throw new Error('XMIDI resource has no EVNT chunk');

  const out: MidiEvent[] = [];
  const pending: PendingNote[] = [];
  let tick = 0;
  let at = 0;

  /** Every note whose duration has run out by `until`, as note-offs. */
  const flush = (until: number): void => {
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const note = pending[index]!;
      if (note.endsAt > until) continue;
      out.push({
        tick: note.endsAt,
        command: MIDI_NOTE_OFF,
        channel: note.channel,
        data1: note.note,
        data2: 0,
      });
      pending.splice(index, 1);
    }
  };

  while (at < events.length) {
    // The delay: a run of bytes below 0x80, summed. Not a variable-length
    // quantity, which is the difference that matters most here.
    let byte = events[at];
    while (byte !== undefined && byte < 0x80) {
      tick += byte;
      at += 1;
      byte = events[at];
    }
    if (byte === undefined) break;
    flush(tick);
    at += 1;

    if (byte === MIDI_META) {
      const type = events[at] ?? 0;
      const { value: length, next } = variable(events, at + 1);
      const payload = events.subarray(next, next + length);
      at = next + length;
      if (type === 0x2f) break;
      out.push({
        tick,
        command: MIDI_META,
        channel: 0,
        data1: type,
        data2: 0,
        sysex: payload,
        ...(type === 0x51 && payload.length >= 3
          ? { tempo: (payload[0]! << 16) | (payload[1]! << 8) | payload[2]! }
          : {}),
      });
      continue;
    }

    if (byte === 0xf0 || byte === 0xf7) {
      const { value: length, next } = variable(events, at);
      out.push({
        tick,
        command: MIDI_META,
        channel: 0,
        data1: byte,
        data2: 0,
        sysex: events.subarray(next, next + length),
      });
      at = next + length;
      continue;
    }

    const command = byte & 0xf0;
    const channel = byte & 0x0f;
    const data1 = events[at] ?? 0;
    const data2 = dataBytesFor(byte) === 2 ? (events[at + 1] ?? 0) : 0;
    at += dataBytesFor(byte);

    out.push({ tick, command, channel, data1, data2 });

    if (command === MIDI_NOTE_ON && data2 > 0) {
      // The duration only a note-on carries, and the note-off nobody else will
      // send.
      const { value: duration, next } = variable(events, at);
      at = next;
      pending.push({ endsAt: tick + Math.max(1, duration), channel, note: data1 });
    }
  }

  flush(Number.POSITIVE_INFINITY);
  out.sort((left, right) => left.tick - right.tick);

  return {
    division: XMIDI_DIVISION,
    events: out,
    duration: out.length === 0 ? 0 : out[out.length - 1]!.tick,
  };
}

/** The tempo XMIDI is played at, which is not in the file. See the note above. */
export const XMIDI_DEFAULT_TEMPO = XMIDI_TEMPO;
