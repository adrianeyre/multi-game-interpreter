import { AdLibDriver, type InstrumentBank } from './AdLibDriver.js';
import type { MidiEvent } from './midi.js';
import { Opl2, OPL2_RATE } from './opl2/Opl2.js';
import { fromScummVmBank } from './gmAdLibBank.js';
import { PcSpeakerDriver } from './pcSpeakerImuse.js';

/**
 * Which sound card a score was arranged for.
 *
 * A SCUMM sound carries the same piece several times over, once per card, and
 * the arrangement decides how its MIDI is to be heard: an AdLib score defines
 * its own instruments, a Roland one names MT-32 presets, a General MIDI one
 * names GM programmes, and a speaker one is a single line of melody.
 */
export type ScoreKind = 'adlib' | 'gm' | 'mt32' | 'speaker';

/**
 * What the sequencer needs of whatever turns MIDI into samples.
 *
 * Everything renders at the OPL2's own rate so that one resampler serves every
 * card: the speaker has no native rate to prefer, and the chip does.
 */
export interface MidiSynth {
  readonly sampleRate: number;
  handle(event: MidiEvent): void;
  render(out: Float32Array): void;
  /** Releases every sounding note, which a jump needs. */
  releaseAll(): void;
  /** Fine-tunes one channel, in semitones. */
  setDetune(channel: number, semitones: number): void;
  /**
   * A part's iMUSE priority, for a card that can only sound some parts. The
   * OPL2 has nine voices and steals the oldest, so only the speaker uses it.
   */
  setPriority?(channel: number, priority: number): void;
  /**
   * Loads an iMUSE instrument onto a channel: the decoded bytes of sysex 16 or
   * a global slot from sysex 17 — 30 bytes for the AdLib, 23 for the speaker.
   */
  setInstrument?(channel: number, data: Uint8Array): void;
  /**
   * iMUSE sysex 96: a part takes a General MIDI bank instrument by number
   * (`Part::set_instrument(uint)`), which the AdLib driver serves from its GM
   * bank whatever the arrangement.
   */
  selectBankInstrument?(channel: number, program: number): void;
  /** Instrument definitions that could not be used, for diagnostics. */
  unreadableSysex: number;
  readonly instrumentsLoaded: number;
}

/**
 * A card that can serve channels numbered beyond sixteen.
 *
 * Both drivers key their state by channel number, so one card can carry
 * several players at once — each given its own block of sixteen — which is
 * how ScummVM's iMUSE shares its single AdLib driver between players.
 */
interface ChannelCard {
  readonly sampleRate: number;
  handle(event: MidiEvent): void;
  render(out: Float32Array): void;
  setDetune(channel: number, semitones: number): void;
  setPriority?(channel: number, priority: number): void;
  setInstrument?(channel: number, data: Uint8Array): void;
  /**
   * iMUSE sysex 96: a part takes a General MIDI bank instrument by number
   * (`Part::set_instrument(uint)`), which the AdLib driver serves from its GM
   * bank whatever the arrangement.
   */
  selectBankInstrument?(channel: number, program: number): void;
  setChannelBank?(channel: number, bank: InstrumentBank): void;
  selectBankInstrument?(channel: number, program: number): void;
  releaseChannel(channel: number): void;
  releaseAll(): void;
  unreadableSysex: number;
  readonly instrumentsLoaded: number;
}

/** The OPL2 and its driver, as one synthesiser. */
class AdLibSynth implements MidiSynth, ChannelCard {
  readonly sampleRate = OPL2_RATE;
  private readonly chip = new Opl2();
  private readonly driver: AdLibDriver;
  unreadableSysex = 0;

  constructor(bank: InstrumentBank) {
    this.driver = new AdLibDriver(this.chip, bank);
  }

  handle(event: MidiEvent): void {
    this.driver.handle(event);
  }

  /** Samples until the driver's next 250 Hz tick, carried across renders. */
  private untilTimer = 0;

  /**
   * Renders the chip, running the driver's timer as the audio advances — note
   * durations and modulation envelopes keep time with what is heard.
   */
  render(out: Float32Array): void {
    const perTimer = this.sampleRate / 250;
    let written = 0;
    while (written < out.length) {
      if (this.untilTimer < 1) {
        this.untilTimer += perTimer;
        this.driver.onTimer();
      }
      const span = Math.min(out.length - written, Math.floor(this.untilTimer));
      this.chip.render(out.subarray(written, written + span));
      written += span;
      this.untilTimer -= span;
    }
  }

  releaseAll(): void {
    this.driver.releaseAll();
  }

  /** A General MIDI programme from the bank, whatever the channel's own bank. */
  selectBankInstrument(channel: number, program: number): void {
    this.driver.selectBankInstrument(channel, program);
  }

  releaseChannel(channel: number): void {
    this.driver.releaseChannel(channel);
  }

  setDetune(channel: number, semitones: number): void {
    this.driver.setDetune(channel, semitones);
  }

  setPriority(channel: number, priority: number): void {
    this.driver.setPriority(channel, priority);
  }

  setChannelBank(channel: number, bank: InstrumentBank): void {
    this.driver.setChannelBank(channel, bank);
  }

  /** An iMUSE AdLib instrument: ScummVM's 30-byte struct, decoded. */
  setInstrument(channel: number, data: Uint8Array): void {
    if (data.length < 11) {
      this.unreadableSysex++;
      return;
    }
    this.driver.setInstrument(channel, fromScummVmBank(Array.from(data)));
  }

  get instrumentsLoaded(): number {
    return this.driver.instrumentsLoaded;
  }
}

/** The synthesiser a score of the given kind is played on, on its own. */
export function createSynth(kind: ScoreKind): MidiSynth {
  switch (kind) {
    case 'speaker':
      return new PcSpeakerDriver(OPL2_RATE);
    case 'gm':
      return new AdLibSynth('gm');
    case 'mt32':
      return new AdLibSynth('mt32');
    default:
      return new AdLibSynth('score');
  }
}

/** The instrument bank an arrangement's programme numbers index. */
export function bankFor(kind: ScoreKind): InstrumentBank {
  return kind === 'gm' ? 'gm' : kind === 'mt32' ? 'mt32' : 'score';
}

/** One player's view of a shared card: sixteen channels at an offset. */
export interface SynthPort extends MidiSynth {
  /** Frees the channels for another player, releasing their notes. */
  close(): void;
}

/**
 * One card shared by every player, as the original has one sound card.
 *
 * Sharing is the point: nine OPL2 voices divided between the music and a
 * sound-effect score *by priority* (`MidiDriver_ADLIB::allocateVoice`), where
 * a chip per player gave each piece nine voices and let a jingle play on top
 * of the music with no contest at all. Likewise the speaker can sound one
 * part, whichever piece it belongs to.
 */
export class SynthHub {
  private readonly used = new Set<number>();

  constructor(private readonly card: ChannelCard) {}

  get sampleRate(): number {
    return this.card.sampleRate;
  }

  render(out: Float32Array): void {
    this.card.render(out);
  }

  /** Gives a player sixteen channels of its own on the card. */
  port(kind: ScoreKind): SynthPort {
    let block = 0;
    while (this.used.has(block)) block++;
    this.used.add(block);
    const base = block * 16;
    const card = this.card;
    const map = (channel: number) => base + (channel & 0x0f);
    for (let channel = 0; channel < 16; channel++) {
      card.setChannelBank?.(map(channel), bankFor(kind));
    }
    let closed = false;

    return {
      sampleRate: card.sampleRate,
      handle: (event) => card.handle({ ...event, channel: map(event.channel) }),
      // The hub renders the card once for everyone; a port has nothing to add.
      render: (out) => out.fill(0),
      releaseAll: () => {
        for (let channel = 0; channel < 16; channel++) card.releaseChannel(map(channel));
      },
      setDetune: (channel, semitones) => card.setDetune(map(channel), semitones),
      setPriority: (channel, priority) => card.setPriority?.(map(channel), priority),
      setInstrument: (channel, data) => card.setInstrument?.(map(channel), data),
      selectBankInstrument: (channel, program) =>
        card.selectBankInstrument?.(map(channel), program),
      get unreadableSysex() {
        return card.unreadableSysex;
      },
      set unreadableSysex(value: number) {
        card.unreadableSysex = value;
      },
      get instrumentsLoaded() {
        return card.instrumentsLoaded;
      },
      close: () => {
        if (closed) return;
        closed = true;
        for (let channel = 0; channel < 16; channel++) card.releaseChannel(map(channel));
        this.used.delete(block);
      },
    };
  }
}

/** A hub around the OPL2. */
export function createAdLibHub(): SynthHub {
  return new SynthHub(new AdLibSynth('score'));
}

/** A hub around the PC speaker. */
export function createSpeakerHub(): SynthHub {
  return new SynthHub(new PcSpeakerDriver(OPL2_RATE));
}
