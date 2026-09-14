/**
 * `kDoSound`'s sub-function tables, and the slot table behind them.
 *
 * **Why this is a file and not six lines in the Kernel.** `DoSound` was
 * `() => int(0)`, and unlike most constants that is not a silence — it is an
 * answer the game acts on. King's Quest VII's own `Sound` class, script 64989,
 * reads as:
 *
 * ```
 * (method (check)
 *     (if handle                              ; property offset 22
 *         (DoSound sndUPDATE_CUES self)
 *         (if signal                          ; property offset 34
 *             (= prevSignal signal) (= signal 0)
 *             (if client (client cue: self)))))
 * ```
 *
 * `handle` is written by `kDoSoundPlay` and by nothing else. With `DoSound`
 * answering a constant it stayed nought, so `check` never reached
 * `UpdateCues`, `signal` was never raised, and `client cue: self` was never
 * sent. Measured on this install before the change: `DoSound(8)`, *Play*,
 * called 44 times in a boot; `DoSound(17)`, *UpdateCues*, called **nought**
 * times. Every script that starts a sound and waits for it to finish waits for
 * a cue that cannot arrive.
 *
 * ## The sub-function number means different things at different Versions
 *
 * This is the reason a file of numbered handlers is the wrong shape. Sierra
 * renumbered `kDoSound` three times, and the same integer is a different call
 * either side of each seam — sub-function 8 is `MasterVolume` at SCI0, `Stop`
 * at SCI1 early, and `Play` from SCI1 late on. An engine that picks one
 * numbering runs every other Version's games with the calls shuffled, which is
 * SCI's characteristic failure: a game that runs and does the wrong things.
 *
 * So the tables are transcribed whole from `kDoSound_subops` in
 * `engines/sci/engine/kernel_tables.h`, and the handlers from
 * `engines/sci/sound/soundcmd.cpp` (both fetched 2026-09-13). Nothing here is
 * inferred from one game.
 *
 * ## What this does not do: there is no synthesiser
 *
 * No note is sounded. Arrangement selection and synthesis are #219 and are not
 * this file, which is why `SciSound.ts` — the shell's audio-context half —
 * is untouched.
 *
 * That leaves one question that cannot be dodged: when does a sound *finish*?
 * Inventing a duration would be a constant wearing a clock. The answer is
 * taken from ScummVM's own handling of exactly this case — a slot with no
 * data for the selected device, which is every slot here, because the selected
 * device synthesises nothing:
 *
 * > The sound slot has no data for the currently selected sound card. […] We
 * > also need to stop the sound at this point, otherwise KQ6 Mac breaks
 * > because the rest of the object needs to be reset to avoid a continuous
 * > stream of sound cues.
 * > — `soundcmd.cpp`, `processUpdateCues`, third branch
 *
 * Its answer there is `processStopSound(obj, true)`, which sets `signal` to
 * `SIGNAL_OFFSET` and lets the waiting script go on. So a sound started here
 * completes at the script's first `check` rather than never. That is a scene
 * that plays without its music, and it is the reference implementation's own
 * behaviour for a device it cannot render — not a shortcut invented here.
 * When #219 lands, `ticker` becomes a real clock and this branch stops being
 * the one every sound takes.
 */

import type { SciVersion } from '../sciVersion.js';

/**
 * `signal`'s value for "this sound has finished", which is `SIGNAL_OFFSET` in
 * ScummVM's `engine/vm_types.h`. Sierra's scripts test it as -1 and store it
 * in an unsigned property word, so it is written as 0xffff.
 */
export const SCI_SOUND_SIGNAL_FINISHED = 0xffff;

/** `MUSIC_VOLUME_MAX` and `MUSIC_MASTERVOLUME_MAX` from `sound/music.h`. */
export const SCI_SOUND_VOLUME_MAX = 127;
export const SCI_SOUND_MASTER_VOLUME_MAX = 15;

/** The `state` property's three values, for SCI0, which has no `signal`. */
export const SCI_SOUND_STATE = { stopped: 0, initialised: 1, paused: 2, playing: 3 } as const;

/**
 * Every operation `kDoSound` has at any Version, by ScummVM's own name.
 *
 * Named rather than numbered for the reason this module exists: the number is
 * Version-dependent and the name is not.
 */
export type SciSoundOp =
  | 'Init'
  | 'Play'
  | 'Restore'
  | 'Dispose'
  | 'Mute'
  | 'Stop'
  | 'Pause'
  | 'ResumeAfterRestore'
  | 'MasterVolume'
  | 'Update'
  | 'Fade'
  | 'GetPolyphony'
  | 'StopAll'
  | 'UpdateCues'
  | 'SendMidi'
  | 'GlobalReverb'
  | 'SetHold'
  | 'Dummy'
  | 'GetAudioCapability'
  | 'Suspend'
  | 'SetVolume'
  | 'SetPriority'
  | 'SetLoop';

/** Which of the four numberings a game uses. ScummVM's `_soundVersion`. */
export type SciSoundVersion = 'sci0' | 'sci1-early' | 'sci1-late' | 'sci32';

/** `SIG_SOUNDSCI0`. Thirteen calls, and `Init` is nought. */
const SOUND_SCI0: readonly SciSoundOp[] = [
  'Init',
  'Play',
  'Restore',
  'Dispose',
  'Mute',
  'Stop',
  'Pause',
  'ResumeAfterRestore',
  'MasterVolume',
  'Update',
  'Fade',
  'GetPolyphony',
  'StopAll',
];

/**
 * `SIG_SOUNDSCI1EARLY`. The whole table is renumbered, not extended:
 * `MasterVolume` moves from 8 to 0 and `Init` from 0 to 5.
 */
const SOUND_SCI1_EARLY: readonly SciSoundOp[] = [
  'MasterVolume',
  'Mute',
  'Restore',
  'GetPolyphony',
  'Update',
  'Init',
  'Dispose',
  'Play',
  'Stop',
  'Pause',
  'Fade',
  'UpdateCues',
  'SendMidi',
  'GlobalReverb',
  'SetHold',
  'Dummy',
];

/**
 * `SIG_SOUNDSCI1LATE`, twenty-one calls.
 *
 * **`SIG_SCI32` is this same table at the same numbers**, checked entry by
 * entry against `kDoSound_subops`: SCI32 changes the argument signatures and
 * where the work is done — a digital sample goes to Audio32 rather than to the
 * MIDI parser — and renumbers nothing. It is aliased rather than copied,
 * because two literal copies of one table are two things to keep in step and
 * this file exists because Sierra's renumberings are easy to get wrong.
 */
const SOUND_SCI1_LATE: readonly SciSoundOp[] = [
  'MasterVolume',
  'Mute',
  'Restore',
  'GetPolyphony',
  'GetAudioCapability',
  'Suspend',
  'Init',
  'Dispose',
  'Play',
  'Stop',
  'Pause',
  'Fade',
  'SetHold',
  'Dummy',
  'SetVolume',
  'SetPriority',
  'SetLoop',
  'UpdateCues',
  'SendMidi',
  'GlobalReverb',
  'Update',
];

const SOUND_TABLES: Readonly<Record<SciSoundVersion, readonly SciSoundOp[]>> = {
  sci0: SOUND_SCI0,
  'sci1-early': SOUND_SCI1_EARLY,
  'sci1-late': SOUND_SCI1_LATE,
  sci32: SOUND_SCI1_LATE,
};

/**
 * Which numbering a Version uses.
 *
 * From `GameFeatures::detectDoSoundType` (`engine/features.cpp`), with its two
 * runtime probes replaced by the bucket each probe decides between:
 *
 * - SCI0 early is probed by `detectEarlySound`, which reads the *resources*
 *   rather than the scripts. Both of its answers use `SOUND_SCI0`, so the
 *   probe does not change the table and is not needed here.
 * - The SCI1 early/late seam is probed by `autoDetectSoundType`, and its
 *   educated guess when the probe fails is exactly the split written below:
 *   SCI1 middle and later take the late table, earlier takes the early one.
 *
 * **The caveat, stated rather than hidden:** `autoDetectSoundType` exists
 * because a handful of SCI1 middle releases shipped the other scheme. This is
 * a static mapping, so such a release would be run with SCI1 early's
 * numbering. No SCI1 middle game is mounted here, so the mapping is what the
 * reference implementation guesses and not what a game was seen to do.
 */
export function soundVersionFor(version: SciVersion): SciSoundVersion {
  switch (version) {
    case 'sci0-early':
    case 'sci0-late':
    case 'sci01':
      return 'sci0';
    case 'sci1-ega-only':
    case 'sci1-early':
      return 'sci1-early';
    case 'sci1-middle':
    case 'sci1-late':
    case 'sci1-1':
      return 'sci1-late';
    default:
      return 'sci32';
  }
}

/** The operation a sub-function number names at this Version, or nothing. */
export function soundOpFor(version: SciVersion, sub: number): SciSoundOp | undefined {
  return SOUND_TABLES[soundVersionFor(version)][sub];
}

/** Every operation this Version's table names, for the coverage probe. */
export function soundOpsFor(version: SciVersion): readonly SciSoundOp[] {
  return SOUND_TABLES[soundVersionFor(version)];
}

/**
 * One sound the game has initialised — ScummVM's `MusicEntry`, less the parts
 * that only a synthesiser fills in.
 *
 * The fields are the ones the *scripts* can observe through `kDoSound`, which
 * is what makes this a model of the game's state rather than of a sound card.
 */
export interface SciSoundSlot {
  /** The `number` property this slot was initialised for. */
  resourceId: number;
  loop: number;
  priority: number;
  volume: number;
  /** Where the game's own loop marker is, or -1. Set by `SetHold`. */
  hold: number;
  status: 'stopped' | 'playing' | 'paused';
  /** Sixtieths elapsed since `Play`, which is what `min`/`sec`/`frame` divide. */
  ticker: number;
  signal: number;
  /** True once `SetPriority` was given a value, which pins it against the resource's. */
  overridePriority: boolean;
}

/**
 * The playlist, keyed by the sound object.
 *
 * A `Reg` is a pair and not a value, so it is keyed by both halves. Held per
 * world, the same way `finding` and `parserBlock` are: two games open in two
 * tabs are two playlists.
 */
export class SciSoundSlots {
  private readonly slots = new Map<string, SciSoundSlot>();

  private static key(segment: number, offset: number): string {
    return `${segment}:${offset}`;
  }

  get(segment: number, offset: number): SciSoundSlot | undefined {
    return this.slots.get(SciSoundSlots.key(segment, offset));
  }

  set(segment: number, offset: number, slot: SciSoundSlot): void {
    this.slots.set(SciSoundSlots.key(segment, offset), slot);
  }

  delete(segment: number, offset: number): void {
    this.slots.delete(SciSoundSlots.key(segment, offset));
  }

  /** Every live slot, which `StopAll` and the diagnose harness both want. */
  all(): SciSoundSlot[] {
    return [...this.slots.values()];
  }

  get size(): number {
    return this.slots.size;
  }
}
