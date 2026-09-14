import { describe, expect, it } from 'vitest';
import {
  looksLikeGmf,
  looksLikeMidiBundle,
  readAgosMusic,
  readGmf,
} from '../src/engine/agos/sound/music.js';
import { AgosSound } from '../src/engine/agos/sound/AgosSound.js';
import { looksLikeXmidi, readXmidi } from '../src/engine/agos/sound/xmidi.js';

const GMF = [0x47, 0x4d, 0x46];

/** A note on, a note off, with delta times, as MIDI track data. */
function trackBytes(): number[] {
  return [0x00, 0x90, 0x3c, 0x64, 0x60, 0x80, 0x3c, 0x00];
}

function singleTrack(tempo = 2, loop = 1): Uint8Array {
  return Uint8Array.from([...GMF, 1, 0, tempo, loop, ...trackBytes()]);
}

describe('GMF is MIDI with the file format taken off', () => {
  /**
   * No MThd, no MTrk, no end-of-track event: a game that only ever plays its
   * own music has no use for the parts of a MIDI file that exist so other
   * programs can read it.
   */
  it('reads a single track, its tempo byte and its loop flag', () => {
    const music = readGmf(singleTrack(3, 1));

    expect(music.trackCount).toBe(1);
    expect(music.headerTempo).toBe(3);
    expect(music.loop).toBe(true);
    expect(music.events).toHaveLength(2);
    expect(music.events[0]).toMatchObject({ command: 0x90, channel: 0, data1: 0x3c });
    expect(music.events[1]!.tick).toBe(0x60);
  });

  it('reads an effects bank, whose offset list is little-endian alone among AGOS', () => {
    const track = [...GMF, 1, 0, 2, 0, ...trackBytes()];
    const listBytes = 6; // three offsets: two track starts and one end
    const first = listBytes;
    const second = first + track.length;
    const end = second + track.length;
    const bytes = Uint8Array.from([
      first & 0xff,
      first >> 8,
      second & 0xff,
      second >> 8,
      end & 0xff,
      end >> 8,
      ...track,
      ...track,
    ]);

    const music = readGmf(bytes);

    // Two tracks, four events: the count comes from where the first track
    // starts rather than from a field.
    expect(music.trackCount).toBe(2);
    expect(music.events).toHaveLength(4);
    expect(music.loop).toBe(false);
  });

  it('refuses something that is neither shape rather than reading noise as notes', () => {
    expect(() => readGmf(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))).toThrow(/not a GMF resource/);
    expect(() => readGmf(Uint8Array.of(1, 2))).toThrow(/too short/);
  });

  it('recognises both shapes without parsing them', () => {
    expect(looksLikeGmf(singleTrack())).toBe(true);
    expect(looksLikeGmf(Uint8Array.of(1, 2, 3, 4))).toBe(false);
  });
});

describe('playing what the reader read', () => {
  /**
   * Rendering is separable from playing on purpose. There is no `AudioContext`
   * in a test runner, so a sound engine that decodes inside `play` can only be
   * checked by a person listening — a Tier 2 claim, and Tier 2 cannot be
   * automated. These are the parts that can.
   */
  const sound = new AgosSound();

  function gmf(): Uint8Array {
    return Uint8Array.from([
      0x47, 0x4d, 0x46, 1, 0, 2, 1, 0x00, 0x90, 0x3c, 0x64, 0x60, 0x80, 0x3c, 0x00,
    ]);
  }

  it('renders a music resource to samples through the OPL2 core', () => {
    const rendered = sound.renderMusic(gmf(), 22_050);

    expect(rendered).not.toBeNull();
    expect(rendered!.sampleRate).toBe(22_050);
    expect(rendered!.samples.length).toBeGreaterThan(0);
    // The header's loop flag reaches playback rather than stopping at the
    // reader, because a piece of music that should loop and does not is a bug
    // nobody reports as one.
    expect(rendered!.loop).toBe(true);
  });

  it('falls silent and counts a track it cannot read, rather than stopping the game', () => {
    expect(sound.renderMusic(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))).toBeNull();
    // Named for both formats now, because a resource that is neither is what
    // this reports rather than a resource that is not the one AGOS 1 uses.
    expect([...sound.unsupported]).toContain('music: neither GMF, a MIDI bundle, nor XMIDI');
  });

  it('decodes the speech formats it can and leaves the rest to the browser', () => {
    const header = [...new TextEncoder().encode('Creative Voice File')];
    while (header.length < 20) header.push(0);
    const voc = Uint8Array.from([
      ...header,
      26,
      0,
      0x0a,
      0x01,
      0x29,
      0x11,
      1,
      3,
      0,
      0,
      0xa5,
      0,
      200,
    ]);

    expect(sound.decodeSpeech(voc)?.samples.length).toBe(1);
    // Ogg goes to the browser, which is why ADR 0028 admitting repackaged data
    // cost almost nothing.
    expect(sound.decodeSpeech(new TextEncoder().encode('OggS'))).toBeNull();
  });

  it('does not need an audio context to exist', async () => {
    await expect(sound.resume()).resolves.toBeUndefined();
    sound.setEnabled(false);
    expect(sound.playMusic(gmf())).toBe(false);
  });
});

/**
 * The format the Windows releases replaced GMF with.
 *
 * A count byte, then that many complete standard MIDI files. A reader that only
 * knew GMF rejected every track those releases own and said "not GMF" while
 * sitting on the whole soundtrack.
 */
describe('a Windows release’s bundle of standard MIDI files', () => {
  /** A minimal Type 0 file: one track, one note on, one end-of-track. */
  function midiFile(): number[] {
    const track = [0x00, 0x90, 0x3c, 0x40, 0x60, 0x80, 0x3c, 0x00, 0x00, 0xff, 0x2f, 0x00];
    return [
      0x4d,
      0x54,
      0x68,
      0x64,
      0,
      0,
      0,
      6,
      0,
      0,
      0,
      1,
      0,
      0x60, // MThd, length 6, format 0, one track, 96 ticks a beat
      0x4d,
      0x54,
      0x72,
      0x6b,
      0,
      0,
      0,
      track.length,
      ...track,
    ];
  }

  it('is told apart from GMF by its own bytes', () => {
    expect(looksLikeMidiBundle(Uint8Array.from([1, ...midiFile()]))).toBe(true);
    // A GMF resource opens with its own tag, so the two cannot be confused.
    expect(looksLikeMidiBundle(Uint8Array.from([0x47, 0x4d, 0x46, 1, 0, 0, 0]))).toBe(false);
    // A count of zero is not a bundle of nothing, it is not a bundle.
    expect(looksLikeMidiBundle(Uint8Array.from([0, ...midiFile()]))).toBe(false);
  });

  it('reads the first file of the bundle and reports how many there were', () => {
    const music = readAgosMusic(Uint8Array.from([2, ...midiFile(), ...midiFile()]));

    // The later files are the alternative arrangements a Windows release
    // carried for other devices. Choosing between them is a device selection
    // this project does not make, so the first is played and the count is
    // reported rather than the files being concatenated.
    expect(music.trackCount).toBe(2);
    expect(music.events.length).toBeGreaterThan(0);
    expect(music.loop).toBe(true);
  });

  it('still reads GMF, which is what every DOS release ships', () => {
    const gmf = Uint8Array.from([0x47, 0x4d, 0x46, 1, 0x80, 0, 0, 0x00, 0xff, 0x2f, 0x00]);

    expect(looksLikeGmf(gmf)).toBe(true);
    expect(readAgosMusic(gmf).trackCount).toBe(1);
  });
});

/**
 * Simon 2's music is neither GMF nor a bundle: it is **XMIDI**, Origin's
 * IFF-wrapped format, and the reader rejected every track the game owns. Three
 * things differ from a standard MIDI track and the middle one is the one that
 * turns a tune into a held chord — see `sound/xmidi.ts`.
 */
describe('XMIDI, which is the third shape and the one Simon 2 ships', () => {
  /** An IFF chunk: four-byte id, big-endian length, then the data, padded even. */
  function chunk(id: string, body: number[]): number[] {
    const length = body.length;
    const header = [...id].map((each) => each.charCodeAt(0));
    const size = [
      (length >>> 24) & 0xff,
      (length >>> 16) & 0xff,
      (length >>> 8) & 0xff,
      length & 0xff,
    ];
    return [...header, ...size, ...body, ...(length & 1 ? [0] : [])];
  }

  /** A whole XMIDI file around one `EVNT` body, as the games nest it. */
  function xmidi(events: number[]): Uint8Array {
    const inner = [...[...'XMID'].map((c) => c.charCodeAt(0)), ...chunk('EVNT', events)];
    const cat = [...[...'XMID'].map((c) => c.charCodeAt(0)), ...chunk('FORM', inner)];
    return Uint8Array.from([
      ...chunk('FORM', [...[...'XDIR'].map((c) => c.charCodeAt(0)), ...chunk('INFO', [1, 0])]),
      ...chunk('CAT ', cat),
    ]);
  }

  it('recognises the container by its own bytes', () => {
    expect(looksLikeXmidi(xmidi([0xff, 0x2f, 0x00]))).toBe(true);
    expect(looksLikeXmidi(Uint8Array.of(0x47, 0x4d, 0x46, 0, 0, 0, 0, 0))).toBe(false);
  });

  /**
   * The delay is a **run of bytes below 0x80, summed** — not a variable-length
   * quantity. `7f 10` is 143 ticks here and 16,272 to a standard reader, which
   * is the difference between a tune and one note a minute.
   */
  it('sums a run of bytes for the delay rather than reading a variable-length quantity', () => {
    const music = readXmidi(xmidi([0x7f, 0x10, 0x90, 60, 100, 0x08, 0xff, 0x2f, 0x00]));

    expect(music.events[0]).toMatchObject({ tick: 143, command: 0x90, data1: 60 });
  });

  /**
   * A note-on carries a duration and there are no note-offs in the stream, so
   * the reader emits them. Without this every note in a piece is held for ever.
   */
  it('ends a note itself, from the duration the note-on carries', () => {
    const music = readXmidi(xmidi([0x00, 0x90, 60, 100, 0x20, 0xff, 0x2f, 0x00]));

    expect(music.events.map((each) => [each.command, each.tick])).toEqual([
      [0x90, 0],
      [0x80, 32],
    ]);
  });

  it('reads Simon 2 as a whole through the one entry point', () => {
    const music = readAgosMusic(xmidi([0x00, 0x90, 60, 100, 0x20, 0xff, 0x2f, 0x00]));

    // 60 ticks a beat at the MIDI default tempo is XMIDI's fixed 120Hz.
    expect(music.division).toBe(60);
    expect(music.loop).toBe(true);
  });
});
