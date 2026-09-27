import { describe, expect, it, vi } from 'vitest';
import { AdLibDriver, DEFAULT_INSTRUMENT } from '../src/engine/sound/AdLibDriver.js';
import { lookupVolume } from '../src/engine/sound/adlibModulation.js';
import { fromScummVmBank } from '../src/engine/sound/gmAdLibBank.js';
import { ImusePlayer } from '../src/engine/sound/ImusePlayer.js';
import {
  MIDI_META,
  MIDI_NOTE_ON,
  type MidiEvent,
  type MidiFile,
} from '../src/engine/sound/midi.js';
import { Opl2 } from '../src/engine/sound/opl2/Opl2.js';
import { createSynth, type MidiSynth } from '../src/engine/sound/synth.js';

/**
 * The rest of an iMUSE AdLib instrument: its two modulation envelopes and its
 * note duration (ScummVM's `Struct10`/`Struct11` and `AdLibInstrument::duration`),
 * and sysex 96, which selects a bank instrument by number.
 */

const note: MidiEvent = { tick: 0, command: MIDI_NOTE_ON, channel: 0, data1: 60, data2: 127 };
const PIANO = [0xc2, 0xc5, 0x2b, 0x99, 0x58, 0xc2, 0x1f, 0x1e, 0xc8, 0x7c, 0x0a];

/** A 30-byte instrument: the eleven bytes, two effects, a duration. */
function instrument(effectA: number[] = [0, ...new Array(8).fill(0)], duration = 0): Uint8Array {
  return Uint8Array.from([...PIANO, ...effectA, 0, ...new Array(8).fill(0), duration]);
}

function render(data: Uint8Array, seconds = 1): Float32Array {
  const synth = createSynth('adlib');
  synth.setInstrument?.(0, data);
  synth.handle(note);
  const out = new Float32Array(Math.round(synth.sampleRate * seconds));
  synth.render(out);
  return out;
}

const differs = (a: Float32Array, b: Float32Array) =>
  a.some((value, i) => Math.abs(value - b[i]) > 1e-4);

describe('the volume lookup the envelopes scale by', () => {
  it('is the original’s signed 32nds', () => {
    expect(lookupVolume(40, 0)).toBe(0);
    expect(lookupVolume(40, 31)).toBe(40);
    expect(lookupVolume(40, 15)).toBe(20);
    expect(lookupVolume(-40, 15)).toBe(-20);
    expect(lookupVolume(40, -16)).toBe(-21);
  });
});

describe('an instrument’s modulation envelopes', () => {
  it('reads the effects and duration out of the 30-byte struct', () => {
    const decoded = fromScummVmBank(Array.from(instrument([0x80, 1, 2, 3, 4, 5, 6, 7, 8], 9)));
    expect(decoded.effectA).toEqual({ flags: 0x80, extra: [1, 2, 3, 4, 5, 6, 7, 8] });
    expect(decoded.effectB?.flags).toBe(0);
    expect(decoded.duration).toBe(9);
  });

  it('sweeps the pitch with a type-0 effect', () => {
    // Type 0 drives parameter 29, pitch; the stages rise then fall.
    const vibrato = instrument([0x80, 0, 12, 60, 12, 10, 12, 12, 31]);
    expect(differs(render(vibrato), render(instrument()))).toBe(true);
  });

  it('sweeps the carrier level with a type-3 effect', () => {
    const swell = instrument([0x83, 0, 14, 10, 14, 50, 14, 14, 31]);
    expect(differs(render(swell), render(instrument()))).toBe(true);
  });

  it('leaves a voice alone when the effect is not enabled', () => {
    const disabled = instrument([0x00, 0, 12, 60, 12, 10, 12, 12, 31]);
    expect(differs(render(disabled), render(instrument()))).toBe(false);
  });
});

describe('an instrument’s own note length', () => {
  it('ends the note after its duration, with no note-off', () => {
    const driver = new AdLibDriver(new Opl2());
    driver.setInstrument(0, { ...DEFAULT_INSTRUMENT, duration: 2 });
    driver.handle(note);
    // 2 × 63 = 126, less 17 a step: eight envelope steps, at a step roughly
    // every five timer ticks.
    for (let i = 0; i < 10; i++) driver.onTimer();
    expect(driver.voiceOwners).toContain(0);
    for (let i = 0; i < 60; i++) driver.onTimer();
    expect(driver.voiceOwners).not.toContain(0);
  });

  it('holds a note with no duration until it is released', () => {
    const driver = new AdLibDriver(new Opl2());
    driver.setInstrument(0, { ...DEFAULT_INSTRUMENT, duration: 0 });
    driver.handle(note);
    for (let i = 0; i < 500; i++) driver.onTimer();
    expect(driver.voiceOwners).toContain(0);
  });
});

describe('sysex 96, a bank instrument by number', () => {
  function playerWith(kind: 'adlib' | 'mt32') {
    const select = vi.fn();
    const synth: MidiSynth = {
      sampleRate: 1000,
      handle: () => undefined,
      render: (out) => out.fill(0),
      releaseAll: () => undefined,
      setDetune: () => undefined,
      selectBankInstrument: select,
      unreadableSysex: 0,
      instrumentsLoaded: 0,
    };
    // Part 2, value 0x0040: bank 0, programme 64.
    const set: MidiEvent = {
      tick: 0,
      command: MIDI_META,
      channel: 0,
      data1: 0xf0,
      data2: 0,
      sysex: Uint8Array.from([0x7d, 96, 2, 0, 0, 4, 0, 0xf7]),
    };
    const midi: MidiFile = { division: 480, events: [set, note], duration: 10 };
    const player = new ImusePlayer(1, midi, { synth, kind });
    player.onTimer();
    return select;
  }

  it('asks the card for that General MIDI programme', () => {
    expect(playerWith('adlib')).toHaveBeenCalledWith(2, 64);
  });

  it('maps a Roland score’s programme to General MIDI first', () => {
    // MT-32 64 is "Acou Bass 1", General MIDI 32.
    expect(playerWith('mt32')).toHaveBeenCalledWith(2, 32);
  });
});
