/**
 * Broken Sword's event system: how one object interrupts another's script.
 *
 * A small file for a mechanism that is easy to mistake for something bigger.
 * There is no queue of messages and no dispatch table — there is a fixed array
 * of **pending event numbers with countdowns**, and every object carries five
 * slots saying "if event `n` is pending, push script `s`".
 *
 * That shape has two consequences worth stating before reading the code:
 *
 * - An event is **consumed by the first object that matches it**, because
 *   matching sets its delay to zero. So two objects subscribed to one event do
 *   not both wake; the one the logic engine reaches first does. That is not a
 *   bug in the original and scripts rely on it.
 * - A delay is a *cycle count*, not a timestamp, and it counts down whether or
 *   not anybody is listening. An event nobody claims simply expires, which is
 *   what `logicStartTalk` tests for when it decides a conversation partner has
 *   gone away.
 */

import { CPT, type SwordCompact } from '../resource/swordCompact.js';
import { SWORD1_TOTAL_EVENTS, SwordLogicMode } from '../resource/swordDefs.js';

/** Revolution's slot count. Running out of them is an error in the original. */
export const SWORD1_TOTAL_EVENT_SLOTS = 20;

/** `SCRIPT_CONT` / `SCRIPT_STOP`, in this project's words. */
export const SCRIPT_CONT = 1;
export const SCRIPT_STOP = 0;

interface PendingEvent {
  eventNumber: number;
  delay: number;
}

export class SwordEvents {
  private readonly pending: PendingEvent[] = Array.from(
    { length: SWORD1_TOTAL_EVENT_SLOTS },
    () => ({ eventNumber: 0, delay: 0 }),
  );

  /** Whether a slot ran out, which the original treats as fatal. */
  private overflowed = false;

  /** One tick of every countdown. Runs at the top of each logic cycle. */
  serviceGlobalEventList(): void {
    for (const slot of this.pending) {
      if (slot.delay) slot.delay--;
    }
  }

  /** True while an event is still pending, which is how a wait knows to keep waiting. */
  eventValid(event: number): boolean {
    return this.pending.some((slot) => slot.eventNumber === event && slot.delay > 0);
  }

  /**
   * Wakes a compact if one of its five subscriptions is pending.
   *
   * Pushes a script level rather than replacing the current script, so the
   * interrupted one resumes when the event script ends. That is the whole of
   * how Broken Sword does interruption — there is no separate continuation.
   */
  checkForEvent(compact: SwordCompact): boolean {
    for (let slot = 0; slot < SWORD1_TOTAL_EVENTS; slot++) {
      const event = compact.get(CPT.EVENT_LIST + slot * 8);
      if (!event) continue;
      for (const global of this.pending) {
        if (global.delay && global.eventNumber === event) {
          const script = compact.get(CPT.EVENT_LIST + slot * 8 + 4);
          compact.logic = SwordLogicMode.SCRIPT;
          global.delay = 0;
          const level = compact.scriptLevel + 1;
          compact.scriptLevel = level;
          compact.setScriptId(level, script);
          compact.setScriptPc(level, script);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * `fnCheckForEvent`: with a pause, wait; without, test and maybe branch.
   *
   * The two behaviours in one mcode is Revolution's, and the pause path does
   * not test at all — it parks the compact in `LOGIC_pause_for_event`, which
   * the logic engine then services through `checkForEvent` on each cycle.
   */
  fnCheckForEvent(compact: SwordCompact, pause: number): number {
    if (pause) {
      compact.pause = pause;
      compact.logic = SwordLogicMode.PAUSE_FOR_EVENT;
      return SCRIPT_STOP;
    }
    return this.checkForEvent(compact) ? SCRIPT_STOP : SCRIPT_CONT;
  }

  /**
   * Queues an event for `delay` cycles.
   *
   * The original errors when the twenty slots are full. Here it is recorded and
   * dropped: losing an event costs a missed interaction, and stopping the game
   * costs the game. `describe` is what puts it on the status line, so it is
   * visible rather than silent.
   */
  fnIssueEvent(event: number, delay: number): void {
    const slot = this.pending.find((candidate) => candidate.delay === 0);
    if (!slot) {
      this.overflowed = true;
      return;
    }
    slot.delay = delay;
    slot.eventNumber = event;
  }

  /** For a save: the pending list as plain numbers. */
  snapshot(): number[] {
    return this.pending.flatMap((slot) => [slot.eventNumber, slot.delay]);
  }

  /** Restores from a save. Refuses a list of the wrong length. */
  restore(values: readonly number[]): void {
    if (values.length !== SWORD1_TOTAL_EVENT_SLOTS * 2) {
      throw new Error(
        `This save holds ${values.length} event words and Broken Sword has ` +
          `${SWORD1_TOTAL_EVENT_SLOTS} slots of two. It is refused rather than half-applied.`,
      );
    }
    this.pending.forEach((slot, at) => {
      slot.eventNumber = values[at * 2];
      slot.delay = values[at * 2 + 1];
    });
  }

  /** A line for the stall report, or undefined when nothing is pending. */
  describe(): string | undefined {
    const live = this.pending.filter((slot) => slot.delay > 0);
    const overflow = this.overflowed
      ? '; the twenty event slots overflowed at least once and an event was dropped'
      : '';
    if (live.length === 0) return overflow ? `no events pending${overflow}` : undefined;
    return (
      `events pending: ${live.map((slot) => `${slot.eventNumber} in ${slot.delay}`).join(', ')}` +
      overflow
    );
  }
}
