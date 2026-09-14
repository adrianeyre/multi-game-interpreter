/**
 * Just enough of a Standard MIDI File reader to play one.
 *
 * SCUMM keeps its AdLib scores as MIDI: an `ADL ` resource is a small header
 * followed by `MThd` and one or more `MTrk` chunks. Reading them needs the
 * file's oddities — variable-length numbers, running status, tempo hidden in
 * a meta event — but none of the parts of the specification that exist for
 * editors rather than players.
 *
 * Tracks are merged into one time-ordered list, because a player wants the
 * next event, not the next event on each of several tracks.
 */

export interface MidiEvent {
  /** Ticks from the start of the file. */
  tick: number;
  /** Status byte with the channel stripped: 0x80, 0x90, 0xb0, 0xc0, 0xe0. */
  command: number;
  channel: number;
  data1: number;
  data2: number;
  /** Payload of a system-exclusive message, which is where SCUMM hides a lot. */
  sysex?: Uint8Array;
  /** Microseconds per quarter note, on a tempo meta event. */
  tempo?: number;
}

export interface MidiFile {
  /** Ticks per quarter note. */
  division: number;
  events: MidiEvent[];
  /** Total length in ticks. */
  duration: number;
}

export const MIDI_NOTE_OFF = 0x80;
export const MIDI_NOTE_ON = 0x90;
export const MIDI_CONTROL_CHANGE = 0xb0;
export const MIDI_PROGRAM_CHANGE = 0xc0;
export const MIDI_PITCH_BEND = 0xe0;
/** Not a MIDI status byte; used to carry meta and system-exclusive events. */
export const MIDI_META = 0xff;

class Reader {
  offset = 0;
  constructor(readonly data: Uint8Array) {}

  get atEnd(): boolean {
    return this.offset >= this.data.length;
  }

  byte(): number {
    if (this.offset >= this.data.length) throw new Error('MIDI data ended early');
    return this.data[this.offset++];
  }

  bytes(count: number): Uint8Array {
    if (this.offset + count > this.data.length) throw new Error('MIDI data ended early');
    const slice = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  u16(): number {
    return (this.byte() << 8) | this.byte();
  }

  u32(): number {
    return ((this.byte() << 24) | (this.byte() << 16) | (this.byte() << 8) | this.byte()) >>> 0;
  }

  /**
   * A variable-length quantity: seven bits per byte, top bit meaning "more".
   *
   * Capped at five bytes so corrupt data cannot spin here forever.
   */
  variable(): number {
    let value = 0;
    for (let i = 0; i < 5; i++) {
      const byte = this.byte();
      value = (value << 7) | (byte & 0x7f);
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error('Malformed variable-length value');
  }
}

function tag(data: Uint8Array, offset: number): string {
  if (offset + 4 > data.length) return '';
  return String.fromCharCode(data[offset], data[offset + 1], data[offset + 2], data[offset + 3]);
}

/**
 * Reads a Standard MIDI File.
 *
 * Throws only when the data is not a MIDI file at all. A track that runs out
 * part way is kept up to where it stopped, because half a piece of music is
 * worth more than an exception.
 */
export function readMidi(data: Uint8Array): MidiFile {
  if (tag(data, 0) !== 'MThd') throw new Error('Not a MIDI file');

  const header = new Reader(data);
  header.offset = 4;
  const headerLength = header.u32();
  header.u16(); // format: 0, 1 and 2 all merge to the same event list here
  const trackCount = header.u16();
  const rawDivision = header.u16();
  header.offset = 8 + headerLength;

  // A negative division is SMPTE timing, which SCUMM does not use; falling
  // back to a common value keeps such a file playing at a plausible speed
  // rather than dividing by a negative number.
  const division = rawDivision & 0x8000 ? 192 : rawDivision || 192;

  const events: MidiEvent[] = [];

  for (let track = 0; track < trackCount && header.offset < data.length; track++) {
    if (tag(data, header.offset) !== 'MTrk') break;
    header.offset += 4;
    const length = header.u32();
    const end = Math.min(data.length, header.offset + length);

    readTrack(new Reader(data.subarray(header.offset, end)), events);
    header.offset = end;
  }

  // A stable sort keeps events written at the same tick in the order the file
  // gave them, which matters when a program change shares a tick with the note
  // it is meant to apply to.
  events.sort((a, b) => a.tick - b.tick);

  return {
    division,
    events,
    duration: events.length > 0 ? events[events.length - 1].tick : 0,
  };
}

/**
 * Reads one track's event stream into `events`.
 *
 * Exported for AGOS, whose music is track data with **no MIDI header at all**:
 * a GMF file is a seven-byte header of its own followed by exactly this stream.
 * Wrapping it in a synthetic `MThd` to get it through `readMidi` would work and
 * would put a fake file format between the reader and the bytes, so the track
 * reader is shared instead.
 */
export function readMidiTrack(data: Uint8Array, events: MidiEvent[]): void {
  readTrack(new Reader(data), events);
}

function readTrack(reader: Reader, events: MidiEvent[]): void {
  let tick = 0;
  let status = 0;

  try {
    while (!reader.atEnd) {
      tick += reader.variable();

      const next = reader.byte();
      if (next < 0x80) {
        // Running status: a message with no status byte repeats the last one.
        // Its first data byte has already been read.
        reader.offset--;
        if (status === 0) throw new Error('Running status with no status');
      } else {
        status = next;
      }

      if (status === 0xff) {
        const type = reader.byte();
        const length = reader.variable();
        const payload = reader.bytes(length);

        if (type === 0x2f) return; // end of track
        if (type === 0x51 && payload.length >= 3) {
          events.push({
            tick,
            command: MIDI_META,
            channel: 0,
            data1: type,
            data2: 0,
            tempo: (payload[0] << 16) | (payload[1] << 8) | payload[2],
          });
        }
        continue;
      }

      if (status === 0xf0 || status === 0xf7) {
        const length = reader.variable();
        events.push({
          tick,
          command: MIDI_META,
          channel: 0,
          data1: status,
          data2: 0,
          sysex: reader.bytes(length).slice(),
        });
        continue;
      }

      const command = status & 0xf0;
      const channel = status & 0x0f;
      const data1 = reader.byte();
      // Program change and channel pressure carry one data byte; the rest two.
      const data2 = command === 0xc0 || command === 0xd0 ? 0 : reader.byte();

      events.push({ tick, command, channel, data1, data2 });
    }
  } catch {
    // Truncated or malformed from here on. Everything read so far stands.
  }
}
