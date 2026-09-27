import {
  MIDI_CONTROL_CHANGE,
  MIDI_META,
  MIDI_NOTE_OFF,
  MIDI_NOTE_ON,
  MIDI_PROGRAM_CHANGE,
  type MidiEvent,
  type MidiFile,
} from './midi.js';
import { mt32ProgramToGm, mt32VelocityToGm } from './mt32.js';
import { jumpTargetTick } from './renderMusic.js';
import { decodeNibbles, GlobalInstruments, InstrumentRouter } from './imuseInstruments.js';
import { createSynth, type MidiSynth, type ScoreKind } from './synth.js';

/**
 * One iMUSE player: a score being sequenced, live, with a position that moves.
 *
 * This is the thing v6's music was missing. The engine used to render a whole
 * score to samples and play the buffer, which serves "start this piece" and
 * nothing else iMUSE does: a jump, a loop, a hook the composer placed, a
 * transpose or a tempo change all need a *sequencer* whose state can be changed
 * while it plays. So this is one — a port of ScummVM's `Player`
 * (engines/scumm/imuse/imuse_player.cpp) — and it produces audio a few
 * milliseconds at a time, from its own state, so that a command lands in the
 * music at the moment it is given rather than after a re-render.
 *
 * Structure follows the original closely because the original's *timing* is
 * the behaviour: the sequencer runs on a fixed timer (`onTimer`), and on each
 * tick it first advances the parameter fades, then checks the loop, then lets
 * the MIDI parser play everything that has come due. Doing those in another
 * order is audible — a loop checked after the parser plays one event past its
 * end point.
 *
 * Positions are in the score's own ticks, and a *beat* is `division` of them.
 * ScummVM uses a fixed 480 (`TICKS_PER_BEAT`), which is what every iMUSE score's
 * division is; using the file's own keeps a hand-built score honest too.
 */

/** Microseconds between sequencer ticks: the AdLib driver's base tempo (250 Hz). */
const TIMER_MICROSECONDS = 4000;

/** Faders step at sixty hertz, whatever the timer runs at (`transitionParameters`). */
const FADER_MICROSECONDS = 16667;

/** 120 bpm, until the score says otherwise. */
const DEFAULT_TEMPO = 500_000;

/** iMUSE's own manufacturer id. */
const IMUSE_SYSEX_ID = 0x7d;

/** `ParameterFader`'s parameter numbers. */
export const FADE_VOLUME = 1;
export const FADE_DETUNE = 3;
export const FADE_SPEED = 4;
const FADE_CLEAR_ALL = 127;

/** What a player tells the iMUSE system above it. */
export interface ImusePlayerHost {
  /** A score marker (sysex 64) was reached — one call per marker byte. */
  marker?(sound: number, marker: number): void;
  /** Sam & Max's trigger event (sysex 0 in the new system). */
  triggerEvent?(sound: number, marker: number): void;
  /** The player stopped: its score ended, it faded to silence, or it was cleared. */
  ended?(sound: number): void;
}

export interface ImusePlayerOptions {
  /**
   * Sam & Max's iMUSE, which ScummVM calls the "new system": speed centres on
   * 64 rather than 128, detune is per player rather than per part, and sysex 0
   * is a trigger rather than a part set-up.
   */
  newSystem?: boolean;
  /** Which card the score was arranged for. */
  kind?: ScoreKind;
  /**
   * How far a transpose may reach, in semitones: 12 for Day of the Tentacle,
   * 24 for the rest (`Player::setTranspose`).
   */
  transposeLimit?: number;
  /** The `MDhd` start parameters, when the resource has them. */
  start?: StartParameters | null;
  host?: ImusePlayerHost;
  /**
   * The card to play on: a port of a shared chip in the sound engine, a
   * recording fake in tests, or — left out — a card of the score's own.
   */
  synth?: MidiSynth;
  /** The global instrument slots every player shares (sysex 17). */
  globals?: GlobalInstruments;
}

/** Everything a save needs to put a player back where it was. */
export interface SavedImusePlayer {
  id: number;
  tick: number;
  tempo: number;
  speed: number;
  priority: number;
  volume: number;
  pan: number;
  transpose: number;
  detune: number;
  channelVolume: number;
  loop: [number, number, number, number, number];
  hooks: {
    jump: [number, number];
    transpose: number;
    partOnOff: number[];
    partVolume: number[];
    partProgram: number[];
    partTranspose: number[];
  };
  parts: { on: boolean; volume: number; transpose: number; detune: number; priority: number }[];
  faders: {
    param: number;
    state: number;
    ttime: number;
    countdown: number;
    dir: number;
    incr: number;
    ifrac: number;
    irem: number;
  }[];
  faderTimer: number;
  playedMicroseconds: number;
}

/** The defaults a score's `MDhd` header carries (`loadStartParameters`). */
export interface StartParameters {
  priority: number;
  volume: number;
  pan: number;
  transpose: number;
  detune: number;
  speed: number;
}

/**
 * Reads the `MDhd` header that precedes a SCUMM score.
 *
 * MI1's are all zeros, which ScummVM reads as "no parameters" rather than as
 * silence at priority zero — hence the check on volume, priority and speed.
 */
export function readStartParameters(resource: Uint8Array): StartParameters | null {
  for (let at = 0; at + 16 <= resource.length; at++) {
    if (
      resource[at] !== 0x4d ||
      resource[at + 1] !== 0x44 ||
      resource[at + 2] !== 0x68 ||
      resource[at + 3] !== 0x64
    ) {
      continue;
    }
    const size =
      ((resource[at + 4] << 24) |
        (resource[at + 5] << 16) |
        (resource[at + 6] << 8) |
        resource[at + 7]) >>>
      0;
    const p = resource.subarray(at + 8);
    if (!size || !(p[2] | p[3] | p[7])) return null;
    return {
      priority: p[2],
      volume: p[3],
      pan: (p[4] << 24) >> 24,
      transpose: (p[5] << 24) >> 24,
      detune: (p[6] << 24) >> 24,
      speed: p[7],
    };
  }
  return null;
}

/** iMUSE's octave-folding clamp: out-of-range transposes move by whole octaves. */
export function transposeClamp(value: number, low: number, high: number): number {
  let a = value;
  if (low > a) a += Math.trunc((low - a + 11) / 12) * 12;
  if (high < a) a -= Math.trunc((a - high + 11) / 12) * 12;
  return a;
}

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const int8 = (value: number) => (value << 24) >> 24;
const be16 = (bytes: Uint8Array, at: number) => ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);

/** One MIDI channel's iMUSE part. */
interface Part {
  on: boolean;
  volume: number;
  /** The part's own transpose; -128 means "none", as the original has it. */
  transpose: number;
  detune: number;
  priority: number;
}

interface Fader {
  param: number;
  state: number;
  ttime: number;
  countdown: number;
  dir: number;
  incr: number;
  ifrac: number;
  irem: number;
}

const idleFader = (): Fader => ({
  param: 0,
  state: 0,
  ttime: 0,
  countdown: 0,
  dir: 0,
  incr: 0,
  ifrac: 0,
  irem: 0,
});

/** The hooks a script has armed (`HookDatas`). Zero means none. */
interface Hooks {
  jump: [number, number];
  transpose: number;
  partOnOff: Uint8Array;
  partVolume: Uint8Array;
  partProgram: Uint8Array;
  partTranspose: Uint8Array;
}

export class ImusePlayer {
  readonly synth: MidiSynth;
  readonly kind: ScoreKind;
  private readonly instruments: InstrumentRouter;
  /** A multiplier on the output, 0-1, for the music sequencer's crossfades. */
  private outputLevel = 1;

  /** False once the player has stopped; the synth may still be ringing out. */
  active = true;

  priority: number;
  volume: number;
  pan: number;
  transpose: number;
  detune: number;
  speed: number;

  /** A volume channel's level, 0-127, which scales this player (`_vol_chan`). */
  private channelVolume = 127;
  private effectiveVolume = 127;

  private readonly newSystem: boolean;
  private readonly transposeLimit: number;
  private readonly host: ImusePlayerHost;

  /** Position, in ticks; fractional between events. */
  private tick = 0;
  /** Index of the next event to play. */
  private next = 0;
  private tempo = DEFAULT_TEMPO;
  /** Set by a jump, so the parser stops for this timer tick as `_abortParse` does. */
  private jumped = false;
  private scanning = false;
  private readonly scanNotes = new Map<number, number>();

  private loopCounter = 0;
  private loopToBeat = 1;
  private loopToTick = 0;
  private loopFromBeat = 1;
  private loopFromTick = 0;

  private readonly hooks: Hooks = {
    jump: [0, 0],
    transpose: 0,
    partOnOff: new Uint8Array(16),
    partVolume: new Uint8Array(16),
    partProgram: new Uint8Array(16),
    partTranspose: new Uint8Array(16),
  };

  private readonly parts: Part[] = Array.from({ length: 16 }, () => ({
    on: true,
    volume: 127,
    transpose: 0,
    detune: 0,
    priority: 0,
  }));

  private readonly faders: Fader[] = [idleFader(), idleFader(), idleFader(), idleFader()];
  private faderTimer = 0;

  /** Samples until the next sequencer tick, carried across `render` calls. */
  private untilTimer = 0;
  /** Microseconds of music played, for a playing position in seconds. */
  private playedMicroseconds = 0;

  constructor(
    readonly id: number,
    readonly midi: MidiFile,
    options: ImusePlayerOptions = {},
  ) {
    this.newSystem = options.newSystem ?? false;
    this.kind = options.kind ?? 'adlib';
    this.transposeLimit = options.transposeLimit ?? 24;
    this.host = options.host ?? {};
    this.synth = options.synth ?? createSynth(this.kind);
    this.instruments = new InstrumentRouter(
      this.synth,
      this.kind,
      options.globals ?? new GlobalInstruments(),
    );

    const start = options.start ?? null;
    this.priority = start?.priority ?? (this.newSystem ? 0x40 : 0x80);
    this.volume = start?.volume ?? 127;
    this.pan = start?.pan ?? 0;
    this.transpose = start?.transpose ?? 0;
    this.detune = start?.detune ?? 0;
    this.speed = start?.speed || (this.newSystem ? 64 : 128);

    this.effectiveVolume = this.computeEffectiveVolume();
    // Every part's volume goes out at the start, as `Part::sendAll` does: the
    // speaker driver keeps a part silent until it has been told one.
    this.sendAllVolumes();
    if (this.transpose || this.detune) this.refreshAllPitch();
  }

  // --- rendering ------------------------------------------------------------

  /** The rate `render` produces, which is the card's. */
  get sampleRate(): number {
    return this.synth.sampleRate;
  }

  /**
   * Fills `out` with the next stretch of music, at the synth's rate.
   *
   * The sequencer ticks every four milliseconds of *audio*, not of wall-clock
   * time, which is what keeps it exactly in step with what is heard however far
   * ahead the output is being prepared.
   */
  render(out: Float32Array): void {
    const perTimer = (this.synth.sampleRate * TIMER_MICROSECONDS) / 1_000_000;
    let written = 0;
    while (written < out.length) {
      if (this.untilTimer < 1) {
        this.untilTimer += perTimer;
        this.onTimer();
      }
      const span = Math.min(out.length - written, Math.floor(this.untilTimer));
      this.synth.render(out.subarray(written, written + span));
      written += span;
      this.untilTimer -= span;
    }
  }

  /** `Player::onTimer`: fades, then the loop, then the parser. */
  onTimer(): void {
    this.transitionParameters(TIMER_MICROSECONDS);
    if (!this.active) return;

    if (this.loopCounter) {
      const whole = Math.floor(this.tick);
      const beat = Math.floor(whole / this.midi.division) + 1;
      const inBeat = whole % this.midi.division;
      if (beat > this.loopFromBeat || (beat === this.loopFromBeat && inBeat >= this.loopFromTick)) {
        this.loopCounter--;
        this.jump(0, this.loopToBeat, this.loopToTick);
      }
    }

    const shift = this.newSystem ? 64 : 128;
    this.advance((TIMER_MICROSECONDS * this.speed) / shift);
    this.playedMicroseconds += TIMER_MICROSECONDS;
  }

  /** Plays every event that falls within the next `microseconds` of score. */
  private advance(microseconds: number): void {
    let budget = microseconds;
    this.jumped = false;
    const events = this.midi.events;

    while (this.active) {
      const event = events[this.next];
      if (!event) {
        // `metaEvent(0x2F)`: the end of the track clears the player.
        this.clear();
        return;
      }
      const perTick = this.tempo / this.midi.division;
      const cost = Math.max(0, event.tick - this.tick) * perTick;
      if (cost > budget) {
        this.tick += budget / perTick;
        return;
      }
      budget -= cost;
      this.tick = Math.max(this.tick, event.tick);
      this.next++;
      this.dispatch(event);
      if (this.jumped) return;
    }
  }

  // --- events ---------------------------------------------------------------

  /** `Player::send` and the sysex handler, for one event. */
  private dispatch(event: MidiEvent): void {
    if (event.command === MIDI_META) {
      if (event.tempo) this.tempo = event.tempo;
      else if (event.sysex) this.sysex(event);
      return;
    }

    const channel = event.channel & 0x0f;
    const part = this.parts[channel];

    switch (event.command) {
      case MIDI_NOTE_ON: {
        if (event.data2 === 0) {
          this.noteOff(channel, event.data1);
          return;
        }
        if (this.scanning) {
          this.scanNotes.set(channel * 128 + event.data1, 1);
          return;
        }
        if (!part.on) return;
        const velocity = this.kind === 'mt32' ? mt32VelocityToGm(event.data2) : event.data2;
        this.synth.handle({ ...event, data2: velocity });
        return;
      }
      case MIDI_NOTE_OFF:
        this.noteOff(channel, event.data1);
        return;
      case MIDI_CONTROL_CHANGE:
        this.controlChange(channel, event);
        return;
      default:
        if (this.instruments.handle(event)) return;
        this.synth.handle(event);
    }
  }

  private noteOff(channel: number, note: number): void {
    if (this.scanning) {
      this.scanNotes.delete(channel * 128 + note);
      return;
    }
    this.synth.handle({ tick: 0, command: MIDI_NOTE_OFF, channel, data1: note, data2: 0 });
  }

  private controlChange(channel: number, event: MidiEvent): void {
    const part = this.parts[channel];
    switch (event.data1) {
      case 7:
        part.volume = event.data2;
        this.sendVolume(channel);
        return;
      case 17:
        // GP slider 2: part detune in the old system, polyphony in the new.
        if (!this.newSystem) {
          part.detune = event.data2 - 0x40;
          this.refreshPitch(channel);
        }
        return;
      case 18:
        part.priority = this.newSystem ? event.data2 : event.data2 - 0x40;
        this.sendPriority(channel);
        return;
      default:
        this.synth.handle(event);
    }
  }

  /** `sysexHandler_Scumm`, and Sam & Max's two overrides of it. */
  private sysex(event: MidiEvent): void {
    let payload = event.sysex as Uint8Array;
    if (payload[0] !== IMUSE_SYSEX_ID) {
      // Another manufacturer: Roland patch data, for the card to judge.
      this.synth.handle(event);
      return;
    }
    // The terminating 0xF7 is part of the SMF event but not of the message.
    if (payload[payload.length - 1] === 0xf7) payload = payload.subarray(0, payload.length - 1);
    const code = payload[1];
    const p = payload.subarray(2);

    switch (code) {
      case 0:
        if (this.newSystem) {
          // Sam & Max: a trigger event, which `ImSetTrigger` commands wait on.
          if (!this.scanning) this.host.triggerEvent?.(this.id, p[0]);
          return;
        }
        this.setUpPart(p);
        return;
      case 1:
        if (this.newSystem) {
          // Sam & Max's maybe_jump, with raw bytes and its own beat encoding.
          if (this.scanning) return;
          this.maybeJump(
            p[0],
            p[1] - 1,
            (be16(p, 2) - 1) * 4 + p[4],
            ((p[5] * this.midi.division) >> 2) + p[6],
          );
          return;
        }
        // Shut a part down.
        this.parts[p[0] & 0x0f].on = false;
        this.allNotesOff(p[0] & 0x0f);
        return;
      case 48: {
        if (this.scanning) return;
        const d = decodeNibbles(p.subarray(1));
        this.maybeJump(d[0], be16(d, 1), be16(d, 3), be16(d, 5));
        return;
      }
      case 49: {
        const d = decodeNibbles(p.subarray(1));
        if (this.takeHook('transpose', d[0])) this.setTranspose(d[1], int8(d[2]));
        return;
      }
      case 50:
      case 51:
      case 52:
      case 53: {
        const channel = p[0] & 0x0f;
        const d = decodeNibbles(p.subarray(1));
        this.partHook(code, channel, d);
        return;
      }
      case 64:
        // Raw bytes, unlike the rest: every one is a marker id.
        if (this.scanning) return;
        for (const marker of p.subarray(1)) this.host.marker?.(this.id, marker);
        return;
      case 80: {
        const d = decodeNibbles(p.subarray(1));
        this.setLoop(be16(d, 0), be16(d, 2), be16(d, 4), be16(d, 6), be16(d, 8));
        return;
      }
      case 81:
        this.clearLoop();
        return;
      case 16:
      case 17:
        this.instruments.handle(event);
        return;
      case 96: {
        // Set instrument: a part, then a bank and programme in four nibbles.
        // The bank only matters on the Macintosh; the programme is a General
        // MIDI one, run through the MT-32 map first for a Roland score, as
        // `Instrument_Program::send` does for a card that is not an MT-32.
        const channel = p[0] & 0x0f;
        const value =
          ((p[1] & 0x0f) << 12) | ((p[2] & 0x0f) << 8) | ((p[3] & 0x0f) << 4) | (p[4] & 0x0f);
        const program = value & 0xff;
        // `AdLibPart::programChange` ignores anything past the GM range.
        if (program > 127) return;
        this.synth.selectBankInstrument?.(
          channel,
          this.kind === 'mt32' ? mt32ProgramToGm(program) : program,
        );
        return;
      }
      default:
        // Parameter adjustments and the rest: the card's business.
        this.synth.handle(event);
    }
  }

  /** Sysex 0's part set-up, as far as a part here has the fields for it. */
  private setUpPart(p: Uint8Array): void {
    const channel = p[0] & 0x0f;
    const d = decodeNibbles(p.subarray(1));
    if (d.length < 6) return;
    const part = this.parts[channel];
    part.on = (d[0] & 1) !== 0;
    part.priority = d[1];
    part.volume = d[2];
    part.transpose = int8(d[4]);
    part.detune = int8(d[5]);
    this.sendVolume(channel);
    this.sendPriority(channel);
    this.refreshPitch(channel);
    if (!part.on) this.allNotesOff(channel);
    // The part's programme, from the global slots (`copyGlobalInstrument`).
    if (this.instruments.definesInstruments && d.length > 7) {
      this.instruments.loadGlobal(channel, d[7]);
    }
  }

  /** Hooks 50-53: part on/off, volume, programme and transpose, each gated. */
  private partHook(code: number, channel: number, d: Uint8Array): void {
    const hook = d[0];
    const table =
      code === 50
        ? this.hooks.partOnOff
        : code === 51
          ? this.hooks.partVolume
          : code === 52
            ? this.hooks.partProgram
            : this.hooks.partTranspose;
    if (hook && table[channel] !== hook) return;
    if (hook && hook < 0x80) table[channel] = 0;

    switch (code) {
      case 50:
        this.setPartOn(channel, d[1] !== 0);
        return;
      case 51:
        this.setPartVolume(channel, d[1]);
        return;
      case 52:
        this.synth.handle({
          tick: 0,
          command: MIDI_PROGRAM_CHANGE,
          channel,
          data1: d[1],
          data2: 0,
        });
        return;
      default:
        this.setPartTranspose(channel, d[1], int8(d[2]));
    }
  }

  /** Whether a player-wide hook allows an event, consuming a one-shot one. */
  private takeHook(which: 'transpose', hook: number): boolean {
    if (hook && this.hooks[which] !== hook) return false;
    if (hook && hook < 0x80) this.hooks[which] = 0;
    return true;
  }

  /**
   * `Player::maybe_jump`: a jump the score carries, gated on the jump hook.
   *
   * A hook of zero in the score is unconditional. Otherwise the jump waits for
   * a script to arm that number; hooks below 0x80 are one-shot, and taking one
   * brings the previously armed hook back — `_jump` is a two-deep stack.
   */
  private maybeJump(hook: number, track: number, beat: number, tick: number): void {
    if (hook && this.hooks.jump[0] !== hook) return;
    if (hook && hook < 0x80) {
      this.hooks.jump[0] = this.hooks.jump[1];
      this.hooks.jump[1] = 0;
    }
    this.jump(track, beat, tick);
  }

  // --- commands ---------------------------------------------------------------

  /**
   * Moves the playing position (`Player::jump`).
   *
   * Nothing between here and there is played — only the tempo is chased, as
   * `MidiParser::jumpToTick` does — and notes left hanging are released.
   * Returns false for a position past the end of the score.
   */
  jump(track: number, beat: number, tick: number): boolean {
    void track; // The tracks are merged into one list; there is one to be in.
    const target = jumpTargetTick(this.midi.division, beat, tick);
    if (target > this.midi.duration) return false;
    this.synth.releaseAll();
    this.seek(target, false);
    this.jumped = true;
    return true;
  }

  /**
   * Jumps while *chasing* the state on the way (`Player::scan`).
   *
   * Instrument, controller and part changes before the destination are
   * applied, and notes that would be held at the destination are sounded,
   * which is what distinguishes a scan from a jump: the music resumes as if it
   * had played there rather than as if it had cut there.
   */
  scan(track: number, beat: number, tick: number): number {
    void track;
    if (!this.active) return -1;
    const target = jumpTargetTick(this.midi.division, beat || 1, tick);
    if (target > this.midi.duration) return -1;

    this.synth.releaseAll();
    this.seek(target, true);
    for (const key of this.scanNotes.keys()) {
      const channel = key >> 7;
      if (!this.parts[channel].on) continue;
      this.synth.handle({
        tick: target,
        command: MIDI_NOTE_ON,
        channel,
        data1: key & 0x7f,
        data2: 80,
      });
    }
    this.scanNotes.clear();
    this.jumped = true;
    return 0;
  }

  private seek(target: number, chase: boolean): void {
    this.tempo = DEFAULT_TEMPO;
    this.scanning = chase;
    this.scanNotes.clear();
    let index = 0;
    const events = this.midi.events;
    while (index < events.length && events[index].tick < target) {
      const event = events[index++];
      if (event.command === MIDI_META && event.tempo) this.tempo = event.tempo;
      else if (chase) this.dispatch(event);
    }
    this.scanning = false;
    this.next = index;
    this.tick = target;
  }

  /**
   * Loops between two points, `count` times (`Player::setLoop`).
   *
   * `to` is where the loop goes back to and `from` is where it leaves. A count
   * of zero is *no* loop — the original's `_loop_counter` of zero means
   * "done" — and an end not at least a beat after its start is refused.
   */
  setLoop(
    count: number,
    toBeat: number,
    toTick: number,
    fromBeat: number,
    fromTick: number,
  ): boolean {
    if (toBeat + 1 >= fromBeat) return false;
    this.loopCounter = 0;
    this.loopToBeat = toBeat === 0 ? 1 : toBeat;
    this.loopToTick = toTick;
    this.loopFromBeat = fromBeat;
    this.loopFromTick = fromTick;
    this.loopCounter = count;
    return true;
  }

  clearLoop(): void {
    this.loopCounter = 0;
  }

  /** Arms a hook (`HookDatas::set`). Channel 16 means every part. */
  setHook(kind: number, value: number, channel: number): number {
    const perPart = (table: Uint8Array): number => {
      if (channel < 16) table[channel] = value;
      else if (channel === 16) table.fill(value);
      return 0;
    };
    switch (kind) {
      case 0:
        if (value !== this.hooks.jump[0]) {
          this.hooks.jump[1] = this.hooks.jump[0];
          this.hooks.jump[0] = value;
        }
        return 0;
      case 1:
        this.hooks.transpose = value;
        return 0;
      case 2:
        return perPart(this.hooks.partOnOff);
      case 3:
        return perPart(this.hooks.partVolume);
      case 4:
        return perPart(this.hooks.partProgram);
      case 5:
        return perPart(this.hooks.partTranspose);
      default:
        return -1;
    }
  }

  /** `Player::setTranspose`: relative moves fold into ±7, absolute ones reach ±24. */
  setTranspose(relative: number, semitones: number): number {
    if (semitones > 24 || semitones < -24 || relative > 1) return -1;
    this.transpose = relative ? transposeClamp(this.transpose + semitones, -7, 7) : semitones;
    this.refreshAllPitch();
    return 0;
  }

  setPartTranspose(channel: number, relative: number, semitones: number): void {
    if (semitones > 24 || semitones < -24) return;
    const part = this.parts[channel];
    part.transpose = relative ? transposeClamp(semitones + part.transpose, -7, 7) : semitones;
    this.refreshPitch(channel);
  }

  /** Detune in 1/128ths of a semitone, the unit the drivers' pitch sums use. */
  setDetune(detune: number): void {
    this.detune = detune;
    this.refreshAllPitch();
  }

  setVolume(volume: number): number {
    if (volume > 127 || volume < 0) return -1;
    this.volume = volume;
    this.effectiveVolume = this.computeEffectiveVolume();
    this.sendAllVolumes();
    return 0;
  }

  /** A volume channel's level (`set_channel_volume`), which scales this player. */
  setChannelVolume(level: number): void {
    this.channelVolume = clamp(level, 0, 127);
    this.setVolume(this.volume);
  }

  /** -64 (left) to 63 (right). The output is mono, so this pans the whole player. */
  setPan(pan: number): void {
    this.pan = clamp(pan, -64, 63);
  }

  /**
   * `Player::setSpeed`: the sequencer's rate against the score's tempo.
   *
   * 128 is normal in the old system and 64 in Sam & Max's, which also refuses
   * anything above 127.
   */
  setSpeed(speed: number): void {
    if (this.newSystem && speed > 127) return;
    this.speed = speed & 0xff;
  }

  setPriority(priority: number): void {
    this.priority = priority;
    for (let channel = 0; channel < 16; channel++) this.sendPriority(channel);
  }

  setPartOn(channel: number, on: boolean): void {
    this.parts[channel].on = on;
    if (!on) this.allNotesOff(channel);
  }

  setPartVolume(channel: number, volume: number): void {
    this.parts[channel].volume = volume;
    this.sendVolume(channel);
  }

  /**
   * Fades a parameter to a target over `time` sixtieths of a second
   * (`Player::addParameterFader`), or at once for a time of zero.
   */
  addParameterFader(param: number, target: number, time: number): number {
    let start: number;
    switch (param) {
      case FADE_VOLUME:
        if (!time) {
          this.setVolume(target);
          return 0;
        }
        start = this.volume;
        break;
      case FADE_DETUNE:
        if (!time) {
          this.setDetune(target);
          return 0;
        }
        start = this.detune;
        break;
      case FADE_SPEED:
        start = this.speed;
        break;
      case FADE_CLEAR_ALL:
        for (const fader of this.faders) fader.param = 0;
        return 0;
      default:
        // The original lets the script think it worked.
        return 0;
    }
    if (!time) return 0;

    const slot =
      this.faders.find((fader) => fader.param === param) ??
      [...this.faders].reverse().find((fader) => !fader.param);
    if (!slot) return -1;

    const diff = target - start;
    slot.param = param;
    slot.state = start;
    slot.ttime = time;
    slot.countdown = time;
    slot.dir = diff >= 0 ? 1 : -1;
    slot.incr = Math.trunc(diff / time);
    slot.ifrac = Math.abs(diff) % time;
    slot.irem = 0;
    return 0;
  }

  /** `Player::transitionParameters`: one sixtieth-second step per 16,667 µs. */
  private transitionParameters(microseconds: number): void {
    this.faderTimer += microseconds;
    while (this.faderTimer >= FADER_MICROSECONDS) {
      this.faderTimer -= FADER_MICROSECONDS;
      for (const fader of this.faders) {
        if (!fader.param) continue;

        let mod = fader.incr;
        fader.irem += fader.ifrac;
        if (fader.irem >= fader.ttime) {
          fader.irem -= fader.ttime;
          mod += fader.dir;
        }
        if (!mod) {
          if (!fader.countdown || !--fader.countdown) fader.param = 0;
          continue;
        }
        fader.state += mod;

        switch (fader.param) {
          case FADE_VOLUME:
            if (fader.state >= 0 && fader.state <= 127) {
              this.setVolume(fader.state);
              if (fader.state === 0) {
                // A fade to nothing is how a piece is faded *out*: it stops.
                this.clear();
                return;
              }
            }
            break;
          case FADE_DETUNE:
            if (fader.state >= -9216 && fader.state <= 9216) this.setDetune(fader.state);
            break;
          case FADE_SPEED:
            if (fader.state >= 0 && fader.state <= 127) this.setSpeed(fader.state);
            break;
          default:
            fader.param = 0;
        }
        if (!fader.countdown || !--fader.countdown) fader.param = 0;
      }
    }
  }

  /** `Player::getParam`, which a script reads through `VAR_SOUNDRESULT`. */
  getParam(param: number, channel: number): number {
    const part = this.parts[channel & 0x0f];
    switch (param) {
      case 0:
        return this.priority & 0xff;
      case 1:
        return this.volume & 0xff;
      case 2:
        return this.pan & 0xff;
      case 3:
        return this.transpose & 0xff;
      case 4:
        return this.detune & 0xff;
      case 5:
        return this.speed;
      case 6:
        return 0;
      case 7:
        return this.beatIndex;
      case 8:
        return Math.floor(this.tick) % this.midi.division;
      case 9:
        return this.loopCounter;
      case 10:
        return this.loopToBeat;
      case 11:
        return this.loopToTick;
      case 12:
        return this.loopFromBeat;
      case 13:
        return this.loopFromTick;
      case 14:
        return part.on ? 1 : 0;
      case 15:
        return part.volume;
      case 17:
        return part.transpose;
      case 18:
        return this.hooks.jump[0];
      case 19:
        return this.hooks.transpose;
      case 20:
        return this.hooks.partOnOff[channel & 0x0f];
      case 21:
        return this.hooks.partVolume[channel & 0x0f];
      case 22:
        return this.hooks.partProgram[channel & 0x0f];
      case 23:
        return this.hooks.partTranspose[channel & 0x0f];
      default:
        return -1;
    }
  }

  /** Beats are counted from one (`getBeatIndex`). */
  get beatIndex(): number {
    return Math.floor(this.tick / this.midi.division) + 1;
  }

  /** Where the score has reached, in ticks. */
  get position(): number {
    return this.tick;
  }

  /** How long this player has been playing, in seconds of audio. */
  get playedSeconds(): number {
    return this.playedMicroseconds / 1_000_000;
  }

  /** `getMusicTimer`: half-beats, which is what `VAR_MUSIC_TIMER` holds. */
  musicTimer(): number {
    return Math.floor((this.tick * 2) / this.midi.division);
  }

  /**
   * Stops the player (`Player::clear`), once.
   *
   * The host hears about it, because stopping is when iMUSE fires any trigger
   * still hung on this sound — a script's "when this piece ends, do that".
   */
  clear(): void {
    if (!this.active) return;
    this.active = false;
    this.synth.releaseAll();
    this.host.ended?.(this.id);
  }

  /**
   * Stops the player *without* telling the host, for a save being loaded:
   * the triggers of the session being left must not run in the one restored.
   */
  halt(): void {
    if (!this.active) return;
    this.active = false;
    this.synth.releaseAll();
  }

  // --- output state -------------------------------------------------------------

  private computeEffectiveVolume(): number {
    return Math.round(((this.channelVolume * (this.volume + 1)) >> 7) * this.outputLevel);
  }

  /**
   * Scales what is heard without touching the volume a script set.
   *
   * The sound engine's crossfades use this: one chip carries every player, so
   * a piece's level has to be set inside it rather than on its own gain node.
   */
  setOutputLevel(level: number): void {
    this.outputLevel = clamp(level, 0, 1);
    this.effectiveVolume = this.computeEffectiveVolume();
    this.sendAllVolumes();
  }

  // --- saving ---------------------------------------------------------------------

  /** The player's state, as plain data for a save (`Player::saveLoadWithSerializer`). */
  save(): SavedImusePlayer {
    return {
      id: this.id,
      tick: this.tick,
      tempo: this.tempo,
      speed: this.speed,
      priority: this.priority,
      volume: this.volume,
      pan: this.pan,
      transpose: this.transpose,
      detune: this.detune,
      channelVolume: this.channelVolume,
      loop: [
        this.loopCounter,
        this.loopToBeat,
        this.loopToTick,
        this.loopFromBeat,
        this.loopFromTick,
      ],
      hooks: {
        jump: [this.hooks.jump[0], this.hooks.jump[1]],
        transpose: this.hooks.transpose,
        partOnOff: Array.from(this.hooks.partOnOff),
        partVolume: Array.from(this.hooks.partVolume),
        partProgram: Array.from(this.hooks.partProgram),
        partTranspose: Array.from(this.hooks.partTranspose),
      },
      parts: this.parts.map((part) => ({ ...part })),
      faders: this.faders.map((fader) => ({ ...fader })),
      faderTimer: this.faderTimer,
      playedMicroseconds: this.playedMicroseconds,
    };
  }

  /**
   * Puts a saved state back.
   *
   * The score is *scanned* to the saved position first, so that every
   * instrument, controller and part set-up on the way is applied to the card —
   * what ScummVM's `fixAfterLoad` achieves by re-sending each part — and the
   * notes held there sound again. Then the saved parameters are laid over it,
   * since a script may have changed them since the score last did.
   */
  restore(saved: SavedImusePlayer): void {
    const target = clamp(saved.tick, 0, this.midi.duration);
    this.synth.releaseAll();
    this.seek(Math.floor(target), true);
    for (const key of this.scanNotes.keys()) {
      if (!this.parts[key >> 7].on) continue;
      this.synth.handle({
        tick: target,
        command: MIDI_NOTE_ON,
        channel: key >> 7,
        data1: key & 0x7f,
        data2: 80,
      });
    }
    this.scanNotes.clear();
    this.tick = target;
    this.tempo = saved.tempo || this.tempo;

    this.speed = saved.speed;
    this.priority = saved.priority;
    this.volume = saved.volume;
    this.pan = saved.pan;
    this.transpose = saved.transpose;
    this.detune = saved.detune;
    this.channelVolume = saved.channelVolume;
    [this.loopCounter, this.loopToBeat, this.loopToTick, this.loopFromBeat, this.loopFromTick] =
      saved.loop;
    this.hooks.jump = [saved.hooks.jump[0], saved.hooks.jump[1]];
    this.hooks.transpose = saved.hooks.transpose;
    this.hooks.partOnOff.set(saved.hooks.partOnOff);
    this.hooks.partVolume.set(saved.hooks.partVolume);
    this.hooks.partProgram.set(saved.hooks.partProgram);
    this.hooks.partTranspose.set(saved.hooks.partTranspose);
    saved.parts.forEach((part, channel) => Object.assign(this.parts[channel], part));
    saved.faders.forEach((fader, i) => Object.assign(this.faders[i], fader));
    this.faderTimer = saved.faderTimer;
    this.playedMicroseconds = saved.playedMicroseconds;

    this.effectiveVolume = this.computeEffectiveVolume();
    this.sendAllVolumes();
    this.refreshAllPitch();
    for (let channel = 0; channel < 16; channel++) {
      this.sendPriority(channel);
      if (!this.parts[channel].on) this.allNotesOff(channel);
    }
  }

  /** A part's heard volume: its own scaled by the player's (`Part::volume`). */
  private sendVolume(channel: number): void {
    const level = (this.parts[channel].volume * (this.effectiveVolume + 1)) >> 7;
    this.synth.handle({
      tick: 0,
      command: MIDI_CONTROL_CHANGE,
      channel,
      data1: 7,
      data2: clamp(level, 0, 127),
    });
  }

  private sendAllVolumes(): void {
    for (let channel = 0; channel < 16; channel++) this.sendVolume(channel);
  }

  private sendPriority(channel: number): void {
    const effective = clamp(this.priority + this.parts[channel].priority, 0, 255);
    this.synth.setPriority?.(channel, effective);
  }

  /**
   * A part's pitch offset: transpose in semitones, detune in 1/128ths.
   *
   * `Part::set_transpose` folds the part's and player's transposes together
   * within the game's limit; the old system adds part and player detune, and
   * Sam & Max uses the player's alone.
   */
  private refreshPitch(channel: number): void {
    const part = this.parts[channel];
    const limit = this.transposeLimit;
    const transpose =
      part.transpose === -128 ? 0 : transposeClamp(part.transpose + this.transpose, -limit, limit);
    const detune = this.newSystem ? this.detune : clamp(part.detune + this.detune, -128, 127);
    this.synth.setDetune(channel, transpose + detune / 128);
  }

  private refreshAllPitch(): void {
    for (let channel = 0; channel < 16; channel++) this.refreshPitch(channel);
  }

  private allNotesOff(channel: number): void {
    this.synth.handle({ tick: 0, command: MIDI_CONTROL_CHANGE, channel, data1: 123, data2: 0 });
  }
}
