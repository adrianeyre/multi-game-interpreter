import { describe, expect, it } from 'vitest';
import { AdLibDriver } from '../src/engine/sound/AdLibDriver.js';
import { gmInstrument, gmPercussion } from '../src/engine/sound/gmAdLibBank.js';
import {
  MIDI_CONTROL_CHANGE,
  MIDI_NOTE_ON,
  MIDI_PROGRAM_CHANGE,
  readMidi,
} from '../src/engine/sound/midi.js';
import {
  identifyMt32Rom,
  MT32_TO_GM,
  mt32ProgramToGm,
  mt32VelocityToGm,
} from '../src/engine/sound/mt32.js';
import { Opl2 } from '../src/engine/sound/opl2/Opl2.js';
import {
  findSpeakerBlock,
  PcSpeakerDriver,
  SpeakerSoundPlayer,
} from '../src/engine/sound/pcSpeaker.js';
import { renderMidiToOpl2, renderScummMusic } from '../src/engine/sound/renderMusic.js';
import { findArrangement } from '../src/engine/sound/scummAdl.js';
import { describeRom, whyUnplayable } from '../src/authoring/audio.js';

/**
 * The two sound cards that are not the OPL2.
 *
 * The PC speaker is synthesised: v5/v6 `SPK ` scores through an iMUSE speaker
 * driver, v1-v4 speaker bytecode through a port of ScummVM's `Player_V2`. The
 * MT-32 is not — its ROMs are Roland's — so its scores are mapped onto a
 * General MIDI bank on the OPL2, and its ROMs are recognised and named.
 */

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
const be32 = (n: number): number[] => [
  (n >>> 24) & 255,
  (n >>> 16) & 255,
  (n >>> 8) & 255,
  n & 255,
];
const le32 = (n: number): number[] => [
  n & 255,
  (n >>> 8) & 255,
  (n >>> 16) & 255,
  (n >>> 24) & 255,
];
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];

function smf(events: number[], division = 96): Uint8Array {
  const track = [...events, 0x00, 0xff, 0x2f, 0x00];
  return new Uint8Array([
    ...ascii('MThd'),
    ...be32(6),
    0,
    0,
    0,
    1,
    (division >> 8) & 255,
    division & 255,
    ...ascii('MTrk'),
    ...be32(track.length),
    ...track,
  ]);
}

const soun = (blocks: number[]): Uint8Array => {
  const sou = [...ascii('SOU '), ...be32(blocks.length), ...blocks];
  return new Uint8Array([...ascii('SOUN'), ...be32(sou.length), ...sou]);
};
const souBlock = (tag: string, payload: number[]) => [
  ...ascii(tag),
  ...be32(payload.length),
  ...payload,
];

const ONE_NOTE = [0x00, 0x90, 60, 100, 0x60, 0x80, 60, 0];
const peak = (samples: Float32Array): number => Math.max(...Array.from(samples, Math.abs));

/** The dominant frequency of a square-ish signal, by counting upward zero crossings. */
function frequencyOf(samples: Float32Array, rate: number): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) if (samples[i - 1] < 0 && samples[i] >= 0) crossings++;
  return (crossings * rate) / samples.length;
}

describe('which arrangement is played, and on what', () => {
  it('names the card each block was written for', () => {
    expect(findArrangement(soun(souBlock('ADL ', [...smf(ONE_NOTE)])))?.kind).toBe('adlib');
    expect(findArrangement(soun(souBlock('ROL ', [...smf(ONE_NOTE)])))?.kind).toBe('mt32');
    expect(findArrangement(soun(souBlock('GMD ', [...smf(ONE_NOTE)])))?.kind).toBe('gm');
    expect(findArrangement(soun(souBlock('SPK ', [...smf(ONE_NOTE)])))?.kind).toBe('speaker');
  });

  it('prefers the Roland score to the speaker one, and plays the speaker one when it is all there is', () => {
    const both = soun([
      ...souBlock('SPK ', [...smf(ONE_NOTE)]),
      ...souBlock('ROL ', [...smf(ONE_NOTE)]),
    ]);
    expect(findArrangement(both)?.kind).toBe('mt32');

    const speakerOnly = soun(souBlock('SPK ', [...smf(ONE_NOTE)]));
    const rendered = renderScummMusic(speakerOnly, 48000);
    expect(rendered).not.toBeNull();
    expect(peak(rendered!.samples)).toBeGreaterThan(0.1);
  });
});

describe('the iMUSE PC speaker driver', () => {
  it('stays silent on a part it has been given no volume for', () => {
    // `MidiChannel_PcSpk::_tl` starts at zero; iMUSE's part set-up sends one.
    const speaker = new PcSpeakerDriver(48000);
    speaker.handle({ tick: 0, command: MIDI_NOTE_ON, channel: 0, data1: 69, data2: 100 });
    const out = new Float32Array(4800);
    speaker.render(out);
    expect(peak(out)).toBeLessThan(0.001);
  });

  it('plays a note as a square wave at its pitch', () => {
    const speaker = new PcSpeakerDriver(48000);
    speaker.handle({ tick: 0, command: MIDI_CONTROL_CHANGE, channel: 0, data1: 7, data2: 127 });
    speaker.handle({ tick: 0, command: MIDI_NOTE_ON, channel: 0, data1: 69, data2: 100 });
    const out = new Float32Array(48000);
    speaker.render(out);
    expect(frequencyOf(out, 48000)).toBeGreaterThan(430);
    expect(frequencyOf(out, 48000)).toBeLessThan(450);
  });

  it('sounds one part at a time: the highest priority wins', () => {
    const speaker = new PcSpeakerDriver(48000);
    for (const channel of [0, 1]) {
      speaker.handle({ tick: 0, command: MIDI_CONTROL_CHANGE, channel, data1: 7, data2: 127 });
    }
    // Priorities first: the original re-chooses at a note event, not when a
    // priority changes.
    speaker.setPriority(0, 100);
    speaker.setPriority(1, 10);
    speaker.handle({ tick: 0, command: MIDI_NOTE_ON, channel: 0, data1: 69, data2: 100 });
    speaker.handle({ tick: 0, command: MIDI_NOTE_ON, channel: 1, data1: 81, data2: 100 });
    const out = new Float32Array(48000);
    speaker.render(out);
    expect(frequencyOf(out, 48000)).toBeLessThan(450);
  });

  it('falls silent when the note ends', () => {
    const speaker = new PcSpeakerDriver(48000);
    speaker.handle({ tick: 0, command: MIDI_CONTROL_CHANGE, channel: 0, data1: 7, data2: 127 });
    speaker.handle({ tick: 0, command: MIDI_NOTE_ON, channel: 0, data1: 69, data2: 100 });
    speaker.handle({ tick: 0, command: MIDI_NOTE_ON, channel: 0, data1: 69, data2: 0 });
    const out = new Float32Array(4800);
    speaker.render(out);
    expect(peak(out.subarray(2400))).toBeLessThan(0.001);
  });
});

describe('v1-v4 speaker sounds', () => {
  /**
   * A one-channel `WA` block: six bytes of header, priority and restartable
   * bytes, four channel offsets, then a script — set the tempo, play one note,
   * stop.
   */
  function speakerBlock(): number[] {
    const script = [
      0xff,
      14,
      1,
      0, // tempo (word 7, byte offset 14) = 1
      0x14,
      0x80 | 48, // note length index 20 (96 ticks), last note: C
      0xff,
      0,
      0,
      0, // time_left = 0: done
    ];
    const body = [0, 0, ...le16(16), ...le16(0), ...le16(0), ...le16(0), ...script];
    return [...le32(6 + body.length), ...ascii('WA'), ...body];
  }

  it('finds the speaker block inside a v3 SO resource', () => {
    const wa = speakerBlock();
    const ad = [...le32(8), ...ascii('AD'), 1, 2];
    const inner = [...ad, ...wa];
    const resource = new Uint8Array([...le32(6 + inner.length), ...ascii('SO'), ...inner]);
    const block = findSpeakerBlock(resource);
    expect(block).not.toBeNull();
    expect(String.fromCharCode(block![4], block![5])).toBe('WA');
  });

  it('plays its note and then finishes', () => {
    const player = new SpeakerSoundPlayer(new Uint8Array(speakerBlock()), 48000, 6);
    expect(player.active).toBe(true);

    const out = new Float32Array(9600);
    player.render(out);
    expect(peak(out)).toBeGreaterThan(0.1);
    // Speaker table entry for C, shifted by octave 4: 36484 >> 4 = 2280, which
    // the 1.19 MHz timer turns into about 523 Hz.
    expect(frequencyOf(out, 48000)).toBeGreaterThan(500);
    expect(frequencyOf(out, 48000)).toBeLessThan(545);

    player.render(new Float32Array(48000));
    expect(player.active).toBe(false);
  });

  it('has nothing to play in a resource with no channels', () => {
    const empty = [...le32(16), ...ascii('WA'), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(new SpeakerSoundPlayer(new Uint8Array(empty), 48000, 6).active).toBe(false);
  });
});

describe('MT-32 programmes on the OPL2', () => {
  it('maps MT-32 presets to General MIDI with ScummVM’s table', () => {
    expect(MT32_TO_GM).toHaveLength(128);
    // MT-32 "Str Sect 1" (48) lands on GM's String Ensemble (48), and its
    // "Acou Bass 1" (64) on GM's Acoustic Bass (32): same sound, other number.
    expect(mt32ProgramToGm(48)).toBe(48);
    expect(mt32ProgramToGm(0x40)).toBe(32);
    expect(mt32ProgramToGm(127)).toBe(117);
  });

  it('compresses an MT-32 velocity into the upper range', () => {
    expect(mt32VelocityToGm(0)).toBe(32);
    expect(mt32VelocityToGm(127)).toBe(127);
  });

  it('gives a Roland score one timbre per programme rather than one for all', () => {
    const score = (program: number) => readMidi(smf([0x00, 0xc0, program, ...ONE_NOTE]));
    const piano = renderMidiToOpl2(score(0), 22050, 0, 'mt32');
    const strings = renderMidiToOpl2(score(48), 22050, 0, 'mt32');
    const differs = piano.samples.some((value, i) => Math.abs(value - strings.samples[i]) > 1e-4);
    expect(differs).toBe(true);

    // The AdLib arrangement's programme numbers are not a bank selection:
    // below 32 they pick a global instrument slot, and above it nothing.
    const plain = renderMidiToOpl2(readMidi(smf(ONE_NOTE)), 22050);
    const adlibHigh = renderMidiToOpl2(score(48), 22050);
    expect(Array.from(adlibHigh.samples)).toEqual(Array.from(plain.samples));
  });

  it('loads the all-zero instrument for an empty global slot, as the original does', () => {
    const score = readMidi(smf([0x00, 0xc0, 3, ...ONE_NOTE]));
    const plain = renderMidiToOpl2(readMidi(smf(ONE_NOTE)), 22050);
    const empty = renderMidiToOpl2(score, 22050);
    expect(Array.from(empty.samples)).not.toEqual(Array.from(plain.samples));
    expect(empty.instrumentsLoaded).toBe(1);
  });

  it('plays General MIDI drums from the percussion bank', () => {
    expect(gmPercussion(36)).not.toBeNull(); // bass drum
    expect(gmPercussion(10)).toBeNull();
    expect(gmInstrument(0).feedback).toBeLessThan(16);

    const chip = new Opl2();
    const driver = new AdLibDriver(chip, 'gm');
    driver.handle({ tick: 0, command: MIDI_PROGRAM_CHANGE, channel: 9, data1: 0, data2: 0 });
    driver.handle({ tick: 0, command: MIDI_CONTROL_CHANGE, channel: 9, data1: 7, data2: 127 });
    driver.handle({ tick: 0, command: MIDI_NOTE_ON, channel: 9, data1: 38, data2: 127 });
    const out = new Float32Array(4000);
    chip.render(out);
    expect(peak(out)).toBeGreaterThan(0.001);
  });

  it('does not read Roland patch sysex as an OPL2 instrument', () => {
    const roland = [0x41, 0x10, 0x16, 0x12, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xf7];
    const events = [0x00, 0xf0, roland.length, ...roland, ...ONE_NOTE];
    const rendered = renderMidiToOpl2(readMidi(smf(events)), 22050, 0, 'mt32');
    expect(rendered.instrumentsLoaded).toBe(0);
  });
});

describe('a Roland ROM an author imports', () => {
  it('names a control ROM, with its firmware version', () => {
    const rom = new Uint8Array(64 * 1024);
    rom.set(ascii(' ver1.07 '), 0x4000);
    rom.set(ascii('** Roland MT-32 **'), 0x4100);
    expect(identifyMt32Rom(rom, 'MT32_CONTROL.ROM')?.name).toBe('Roland MT-32 control ROM (v1.07)');
  });

  it('names a PCM ROM by its size and filename, since it has nothing else', () => {
    const pcm = new Uint8Array(1024 * 1024);
    const rom = identifyMt32Rom(pcm, 'CM32L_PCM.ROM');
    expect(rom?.role).toBe('pcm');
    expect(rom?.name).toBe('Roland CM-32L PCM ROM');
  });

  it('is not fooled by a file that is not a ROM', () => {
    expect(identifyMt32Rom(new Uint8Array(1000), 'music.wav')).toBeNull();
  });

  it('says in the import report that the ROM is recognised and why it is not used', () => {
    const rom = new Uint8Array(64 * 1024);
    rom.set(ascii('** Roland MT-32 **'), 0x4100);
    const line = describeRom(rom, 'MT32_CONTROL.ROM');
    expect(line).toMatch(/Roland MT-32 control ROM/);
    expect(line).toMatch(/Munt/);
    expect(whyUnplayable('mt32-rom')).toMatch(/both ROMs/);
  });
});
