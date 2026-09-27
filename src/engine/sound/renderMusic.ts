import {
  MIDI_CONTROL_CHANGE,
  MIDI_META,
  MIDI_NOTE_OFF,
  MIDI_NOTE_ON,
  type MidiEvent,
  type MidiFile,
} from './midi.js';
import { GlobalInstruments, InstrumentRouter } from './imuseInstruments.js';
import { mt32VelocityToGm } from './mt32.js';
import { OPL2_RATE } from './opl2/Opl2.js';
import { readScummScore } from './scummAdl.js';
import { createSynth, type ScoreKind } from './synth.js';

/**
 * Renders a score to samples, all at once.
 *
 * Rendering ahead rather than synthesising as it plays is what lets music go
 * down exactly the same path as a recorded sound effect: it becomes an
 * ordinary buffer, so the editor's play button and the engine's `startSound`
 * both work without either knowing a synthesiser exists. It also makes the
 * synthesiser testable without a browser, because the output is just numbers.
 *
 * The cost is that the render has to end somewhere, and game music loops
 * forever. The buffer is capped and played looping, so a long piece repeats
 * from its beginning rather than from wherever the cap fell.
 */

/** How much music one render will produce. */
export const MAX_MUSIC_SECONDS = 120;

/** Microseconds per quarter note before the score says otherwise: 120 bpm. */
const DEFAULT_TEMPO = 500_000;

/** Silence after the last event, so a final note is not cut off mid-decay. */
const TAIL_SECONDS = 1.5;

export interface RenderedMusic {
  samples: Float32Array;
  sampleRate: number;
  /** True when the score was longer than the cap and had to be cut. */
  truncated: boolean;
  /** Instrument definitions the driver could not read, for diagnostics. */
  unreadableSysex: number;
  instrumentsLoaded: number;
}

/**
 * Plays a parsed MIDI file through an OPL2 and returns the audio — or, for a
 * speaker arrangement, through the emulated PC speaker.
 *
 * The loop is a sequencer: advance to the next event's tick, rendering the
 * samples that fall in between, then apply the event. Tempo changes only alter
 * how many samples a tick is worth from that point on, which is why they can
 * be handled in the same pass rather than needing a second one.
 */
/**
 * Renders a score, optionally starting part way in.
 *
 * `fromTick` is what makes dynamic music possible at all here. This engine
 * renders a whole score to samples and plays the buffer, so there is no playing
 * position for an iMUSE jump to move — but re-rendering from the destination
 * and restarting playback produces the same musical result, at the cost of a
 * seam where the two buffers meet.
 *
 * Seeking is not the same as skipping. Everything before the destination that
 * *sets state* — instrument loads, programme and controller changes, tempo —
 * still has to happen, or the music resumes with the wrong instruments on every
 * channel. Only the waiting is skipped.
 */
export function renderMidiToOpl2(
  midi: MidiFile,
  sampleRate: number,
  fromTick = 0,
  kind: ScoreKind = 'adlib',
): RenderedMusic {
  const synth = createSynth(kind);
  // The score's own instruments — sysex 16 and 17, programme changes into the
  // global slots — are read the way iMUSE reads them.
  const instruments = new InstrumentRouter(synth, kind, new GlobalInstruments());
  const driver = {
    handle: (event: MidiEvent) => {
      // The sequencer's own sysex — hooks, markers, loops — is instructions
      // to iMUSE rather than to the sound card.
      if (isSequencerSysex(event)) return;
      if (instruments.handle(event)) return;
      synth.handle(kind === 'mt32' ? mt32Velocity(event) : event);
    },
  };
  // Every channel's volume first, as iMUSE's part set-up sends it: the
  // speaker keeps a channel silent until it has been told one.
  for (let channel = 0; channel < 16; channel++) {
    synth.handle({ tick: 0, command: MIDI_CONTROL_CHANGE, channel, data1: 7, data2: 127 });
  }
  const chip = synth;

  const limit = Math.floor(OPL2_RATE * MAX_MUSIC_SECONDS);
  const chunks: Float32Array[] = [];
  let written = 0;
  let truncated = false;

  let tempo = DEFAULT_TEMPO;
  // Time starts at the destination, not at zero. Left at zero, a score whose
  // first event is *after* the seek point renders the whole gap before it as
  // silence — the jump would appear to work and simply take too long.
  let tick = fromTick;
  // Fractional samples are carried between gaps: dropping them would make
  // every event land slightly early, and the error would accumulate into
  // audible drift over a few minutes.
  let carry = 0;

  const samplesPerTick = (): number => (tempo / 1_000_000 / midi.division) * OPL2_RATE;

  const advance = (ticks: number): void => {
    if (ticks <= 0) return;
    const exact = ticks * samplesPerTick() + carry;
    let count = Math.floor(exact);
    carry = exact - count;

    if (written + count > limit) {
      count = Math.max(0, limit - written);
      truncated = true;
    }
    if (count === 0) return;

    const chunk = new Float32Array(count);
    chip.render(chunk);
    chunks.push(chunk);
    written += count;
  };

  for (const event of midi.events) {
    if (written >= limit) {
      truncated = true;
      break;
    }

    if (event.tick < fromTick) {
      // Before the destination: apply anything that sets state, and let no
      // time pass. A note-on here would sound an instant chord of everything
      // the score played on the way, so notes are the one thing skipped.
      if (event.command === MIDI_META && event.tempo) tempo = event.tempo;
      else if (event.command !== MIDI_NOTE_ON && event.command !== MIDI_NOTE_OFF) {
        driver.handle(event);
      }
      continue;
    }

    advance(event.tick - tick);
    tick = event.tick;

    if (event.command === MIDI_META && event.tempo) {
      tempo = event.tempo;
      continue;
    }
    driver.handle(event);
  }

  // Let the last notes ring rather than stopping the instant the score does.
  if (written < limit) {
    const tail = new Float32Array(Math.min(limit - written, Math.floor(OPL2_RATE * TAIL_SECONDS)));
    chip.render(tail);
    chunks.push(tail);
    written += tail.length;
  }

  const native = new Float32Array(written);
  let offset = 0;
  for (const chunk of chunks) {
    native.set(chunk, offset);
    offset += chunk.length;
  }

  return {
    samples: resample(native, OPL2_RATE, sampleRate),
    sampleRate,
    truncated,
    unreadableSysex: synth.unreadableSysex,
    instrumentsLoaded: synth.instrumentsLoaded,
  };
}

/**
 * An MT-32 score's note-on, with its velocity as iMUSE plays it elsewhere.
 *
 * `Player::send` compresses it when the score is Roland's and the device is
 * not, and the OPL2 is not.
 */
export function mt32Velocity(event: MidiEvent): MidiEvent {
  if (event.command !== MIDI_NOTE_ON || event.data2 === 0) return event;
  return { ...event, data2: mt32VelocityToGm(event.data2) };
}

/**
 * The iMUSE sysex codes addressed to the sequencer rather than the synthesiser.
 *
 * From `sysexHandler_Scumm`: 48-53 are hooks (jump, transpose, part on/off,
 * volume, programme, part transpose), 64 is a marker, 80 and 81 set and clear
 * a loop. Everything else — part setup, instrument definitions — is the card's.
 */
export function isSequencerSysex(event: MidiEvent): boolean {
  const code = imuseCode(event);
  return code !== null && ((code >= 48 && code <= 53) || code === 64 || code === 80 || code === 81);
}

/**
 * Reads a SCUMM sound resource and renders its AdLib score.
 *
 * Returns null when the resource holds no score — a digitised effect. Whichever
 * card's arrangement is found is played the way that card would: see
 * `findArrangement` for the preference and `createSynth` for the cards.
 */
export function renderScummMusic(
  resource: Uint8Array,
  sampleRate: number,
  fromTick = 0,
): RenderedMusic | null {
  const score = readScummScore(resource);
  if (!score || score.midi.events.length === 0) return null;
  return renderMidiToOpl2(score.midi, sampleRate, fromTick, score.kind);
}

/**
 * Where an iMUSE jump lands, in ticks.
 *
 * The command names a position musically — a beat, and a subdivision of it —
 * because a sequencer thinks in beats. This renderer thinks in the file's own
 * ticks, and `division` is how many of those make a quarter note.
 *
 * Beats are numbered from one in the command and from zero here, which is the
 * off-by-one worth stating rather than discovering: a jump to "beat 1" is a
 * jump to the start.
 */
/**
 * How long a stretch of ticks lasts, in seconds.
 *
 * Uses the score's last tempo before that point, which is right for the common
 * case of a piece with one tempo and approximate for one that changes tempo
 * mid-way — good enough to position a loop, and not good enough to trust for
 * anything sample-accurate.
 */
/** A named point in a score, which a trigger can be hung on. */
export interface MusicMarker {
  id: number;
  tick: number;
}

/** A jump the score itself carries, taken only when a matching hook is armed. */
export interface MusicHookJump {
  /** The hook number this jump waits for. */
  hook: number;
  track: number;
  beat: number;
  tickInBeat: number;
  /** Where in the score the jump sits, so it can be timed. */
  tick: number;
}

/** iMUSE claims manufacturer id 0x7D for its own sysex. */
const IMUSE_SYSEX_ID = 0x7d;
const SYSEX_HOOK_JUMP = 48;
const SYSEX_MARKER = 64;

/**
 * Where an iMUSE sysex block's payload begins.
 *
 * Byte 0 is the manufacturer id and byte 1 the sub-command. Byte 2 is skipped
 * by every branch of the original's handler, marker and jump alike, so the
 * payload proper starts at 3.
 */
const PAYLOAD_AT = 3;

function imuseCode(event: { sysex?: Uint8Array }): number | null {
  const payload = event.sysex;
  if (!payload || payload.length < 2 || payload[0] !== IMUSE_SYSEX_ID) return null;
  return payload[1];
}

/**
 * Most iMUSE payloads are nibble-encoded: two bytes carry one.
 *
 * The marker block is the exception, which is worth knowing before reading one
 * the wrong way — a nibble-decoded marker id is a different, plausible number.
 */
function decodeNibbles(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = ((source[i * 2] << 4) & 0xff) | (source[i * 2 + 1] & 0x0f);
  }
  return out;
}

/**
 * The markers a score carries.
 *
 * Markers matter because they are the only positions in a score the *game*
 * knows about. A jump to a beat is the engine's idea of where to go; a jump to
 * a marker is the composer's.
 *
 * Sub-command 64, and its bytes are raw where most of iMUSE's are nibble
 * encoded. Every byte of the payload is a marker id, so one block can name
 * several.
 */
export function findMarkers(midi: MidiFile): MusicMarker[] {
  const markers: MusicMarker[] = [];

  for (const event of midi.events) {
    if (imuseCode(event) !== SYSEX_MARKER) continue;
    const payload = event.sysex as Uint8Array;
    for (let at = PAYLOAD_AT; at < payload.length; at++) {
      markers.push({ id: payload[at], tick: event.tick });
    }
  }

  return markers;
}

/**
 * The jumps a score carries, each waiting on a hook.
 *
 * This is how iMUSE really branches. The score says "at this point, if hook 3
 * is armed, go to bar 17" — the composer places the exits and the game chooses
 * between them by arming a hook. A jump to a beat, which is all this engine
 * could do before, is the crude version of the same idea.
 *
 * Sub-command 48, nibble-encoded: hook number, then track, beat and tick as
 * big-endian pairs.
 */
export function findHookJumps(midi: MidiFile): MusicHookJump[] {
  const jumps: MusicHookJump[] = [];

  for (const event of midi.events) {
    if (imuseCode(event) !== SYSEX_HOOK_JUMP) continue;
    const decoded = decodeNibbles((event.sysex as Uint8Array).subarray(PAYLOAD_AT));
    if (decoded.length < 7) continue;

    jumps.push({
      hook: decoded[0],
      track: (decoded[1] << 8) | decoded[2],
      beat: (decoded[3] << 8) | decoded[4],
      tickInBeat: (decoded[5] << 8) | decoded[6],
      tick: event.tick,
    });
  }

  return jumps;
}

export function ticksToSeconds(tick: number, midi: MidiFile): number {
  let tempo = DEFAULT_TEMPO;
  for (const event of midi.events) {
    if (event.tick > tick) break;
    if (event.command === MIDI_META && event.tempo) tempo = event.tempo;
  }
  return (tick * tempo) / 1_000_000 / midi.division;
}

/**
 * Where a piece has reached, in its own ticks, given how long it has played.
 *
 * The inverse of `ticksToSeconds`, and it has to walk the tempo map for the
 * same reason: the answer is not a ratio when the score changes tempo. Each
 * stretch between tempo changes is consumed at its own rate until the seconds
 * run out, and what is left over is converted at the tempo in force there.
 *
 * Exists for `VAR_MUSIC_TIMER`, which a game reads as a position in the music
 * rather than as a clock.
 */
export function secondsToTicks(seconds: number, midi: MidiFile): number {
  if (!(seconds > 0)) return 0;

  let tempo = DEFAULT_TEMPO;
  let tick = 0;
  let remaining = seconds;

  const secondsPerTick = (): number => tempo / 1_000_000 / midi.division;

  for (const event of midi.events) {
    if (event.command !== MIDI_META || !event.tempo) continue;
    if (event.tick <= tick) {
      tempo = event.tempo;
      continue;
    }
    const span = (event.tick - tick) * secondsPerTick();
    if (span >= remaining) return tick + remaining / secondsPerTick();
    remaining -= span;
    tick = event.tick;
    tempo = event.tempo;
  }

  return tick + remaining / secondsPerTick();
}

export function jumpTargetTick(division: number, beat: number, tickInBeat = 0): number {
  return Math.max(0, (beat - 1) * division + tickInBeat);
}

/**
 * Linear resampling from the chip's rate to the output's.
 *
 * Linear rather than anything better because the chip's 49716 Hz is already
 * close to every rate a browser uses, so the resampling ratio is near one and
 * the interpolation error stays far below the chip's own quantisation.
 */
export function resample(input: Float32Array, from: number, to: number): Float32Array {
  if (Math.abs(from - to) < 1 || input.length === 0) return input;

  const ratio = from / to;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(length);

  for (let i = 0; i < length; i++) {
    const position = i * ratio;
    const index = Math.floor(position);
    const fraction = position - index;
    const a = input[index];
    const b = index + 1 < input.length ? input[index + 1] : a;
    output[i] = a + (b - a) * fraction;
  }

  return output;
}
