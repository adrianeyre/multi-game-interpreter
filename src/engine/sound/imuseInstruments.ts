import { MIDI_META, MIDI_PROGRAM_CHANGE, type MidiEvent } from './midi.js';
import type { MidiSynth, ScoreKind } from './synth.js';

/**
 * iMUSE's instruments for the AdLib and the speaker, as the score defines them.
 *
 * An `ADL ` or `SPK ` arrangement names no bank: it carries its own sounds in
 * sysex, and ScummVM's `sysexHandler_Scumm` and `instrument.cpp` say how.
 *
 * - Sysex **16** defines a part's instrument: the part's channel, a hardware
 *   byte, then the instrument nibble-encoded — 30 bytes for the AdLib
 *   (`Instrument_AdLib`, message length 62) or 23 for the speaker
 *   (`Instrument_PcSpk`, length 48). Any other length makes the part's
 *   instrument invalid.
 * - Sysex **17** defines one of 32 *global* instruments, shared by every
 *   player (length 63 or 49), which a programme change below 32 or a part
 *   set-up then copies onto a part (`load_global_instrument`).
 *
 * This replaces a reader that guessed at "a channel and eleven register
 * bytes", which matched nothing a real score sends.
 */

/** Size of a decoded AdLib instrument: ScummVM's `AdLibInstrument` struct. */
export const ADLIB_INSTRUMENT_SIZE = 30;
/** Size of a decoded PC speaker instrument. */
export const SPEAKER_INSTRUMENT_SIZE = 23;

/** The 32 global instrument slots (`IMuseInternal::_global_instruments`). */
export class GlobalInstruments {
  private readonly slots: (Uint8Array | null)[] = new Array(32).fill(null);

  set(slot: number, data: Uint8Array): void {
    if (slot >= 0 && slot < 32) this.slots[slot] = data.slice();
  }

  get(slot: number): Uint8Array | null {
    return this.slots[slot] ?? null;
  }

  /** For a save: which slots are set, and their bytes. */
  save(): (number[] | null)[] {
    return this.slots.map((slot) => (slot ? Array.from(slot) : null));
  }

  restore(saved: readonly (readonly number[] | null)[] | undefined): void {
    for (let i = 0; i < 32; i++) {
      const slot = saved?.[i];
      this.slots[i] = slot ? Uint8Array.from(slot) : null;
    }
  }
}

/** `decode_sysex_bytes`: two source bytes, high nibble first, carry one. */
export function decodeNibbles(source: Uint8Array): Uint8Array {
  const out = new Uint8Array(source.length >> 1);
  for (let i = 0; i < out.length; i++) {
    out[i] = ((source[i * 2] << 4) & 0xff) | (source[i * 2 + 1] & 0x0f);
  }
  return out;
}

/** The iMUSE sysex payload after manufacturer and code, without its 0xF7. */
function imusePayload(event: MidiEvent): { code: number; body: Uint8Array } | null {
  let payload = event.sysex;
  if (!payload || payload.length < 2 || payload[0] !== 0x7d) return null;
  if (payload[payload.length - 1] === 0xf7) payload = payload.subarray(0, payload.length - 1);
  return { code: payload[1], body: payload.subarray(2) };
}

/**
 * Routes a score's instrument events to a card, the way iMUSE does.
 *
 * Only for the arrangements that define their own instruments (`adlib` and
 * `speaker`); a Roland or General MIDI score's programme changes name a bank
 * and go to the card untouched.
 */
export class InstrumentRouter {
  constructor(
    private readonly synth: MidiSynth,
    private readonly kind: ScoreKind,
    private readonly globals: GlobalInstruments,
  ) {}

  /** Whether this score's instruments are iMUSE's own. */
  get definesInstruments(): boolean {
    return this.kind === 'adlib' || this.kind === 'speaker';
  }

  private get size(): number {
    return this.kind === 'speaker' ? SPEAKER_INSTRUMENT_SIZE : ADLIB_INSTRUMENT_SIZE;
  }

  /**
   * Takes an event if it is an instrument event, returning true when it was.
   *
   * `channel` maps a score channel to the card's — identity for a player with
   * a card of its own, an offset for one sharing the chip.
   */
  handle(event: MidiEvent, channel: (score: number) => number = (c) => c): boolean {
    if (!this.definesInstruments) return false;

    if (event.command === MIDI_PROGRAM_CHANGE) {
      // `Player::send`: below 32 is a global instrument; above, nothing.
      if (event.data1 < 32) this.loadGlobal(channel(event.channel & 0x0f), event.data1);
      return true;
    }
    if (event.command !== MIDI_META) return false;

    const message = imusePayload(event);
    if (!message) return false;
    const { code, body } = message;
    // The original checks lengths counted from after the code byte.
    const length = body.length;

    if (code === 16) {
      const target = channel(body[0] & 0x0f);
      const wanted = this.kind === 'speaker' ? 48 : 62;
      if (length !== wanted) {
        this.synth.unreadableSysex++;
        return true;
      }
      this.synth.setInstrument?.(target, decodeNibbles(body.subarray(2)).subarray(0, this.size));
      return true;
    }
    if (code === 17) {
      const wanted = this.kind === 'speaker' ? 49 : 63;
      if (length !== wanted) {
        this.synth.unreadableSysex++;
        return true;
      }
      this.globals.set(body[2], decodeNibbles(body.subarray(3)).subarray(0, this.size));
      return true;
    }
    return false;
  }

  /**
   * Copies a global instrument onto a channel (`copyGlobalInstrument`).
   *
   * A slot the score never filled loads an all-zero instrument, as the
   * original does for both the AdLib and the speaker — which on the OPL2 is
   * close to silence, and is what the composer's score produced on the real
   * card when it named an empty slot.
   */
  loadGlobal(channel: number, slot: number): void {
    if (slot < 0 || slot >= 32) return;
    const data = this.globals.get(slot) ?? new Uint8Array(this.size);
    this.synth.setInstrument?.(channel, data);
  }
}
