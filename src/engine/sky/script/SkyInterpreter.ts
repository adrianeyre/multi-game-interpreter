/**
 * The Sky script engine: the stack machine that runs a Compact's logic.
 *
 * One per Engine rather than one per script. A Sky script is a coroutine — it
 * runs until an mcode says "not yet", and the word offset it stopped at is
 * stored back into the Compact so the next tick resumes there. So the machine
 * itself holds no per-script state beyond its stack, and the *world* holds
 * where everything is up to. That is why `run` returns an offset rather than
 * keeping one.
 *
 * ## What this does and does not do
 *
 * It executes the encoding: the stack, the arithmetic, the branches, the
 * switch, the reads and writes of script variables and Compact fields. Those
 * are complete, and they are what the encoding is.
 *
 * **It does not implement the 115 mcodes**, which are the calls out into the
 * interpreter — drawing, sound, routing, speech. Those arrive with the renderer
 * (#256) and the sound (#257). What happens to one that is not implemented is
 * the part worth being careful about, and it is the rule `CONTEXT.md` asks for
 * everywhere: **reported by name and by script offset, never silently skipped.**
 * A script that calls one stops, and the stall is visible rather than looking
 * like a rendering fault.
 *
 * ## The two unit changes
 *
 * A script variable's operand is a **byte** offset into an array of 32-bit
 * variables, so it is divided by four. A branch's operand is a **byte**
 * distance added to a word pointer, so it is divided by two. Both are spelled
 * out at their one line each, because a decoder that forgets either produces
 * output that looks entirely reasonable and is wrong everywhere.
 */

import { decodeSkyInstruction, SkyScriptError, type SkyInstruction } from './skyOpcodes.js';
import { skyMcodeName, SKY_MCODE_STRIDE } from './skyMcodes.js';

/** How a script's run ended. */
export type SkyRunOutcome =
  /** Reached `script_exit`. Nothing is owed. */
  | { readonly kind: 'finished' }
  /** An mcode said "not yet". Resume from `offset` next tick. */
  | { readonly kind: 'paused'; readonly offset: number; readonly waitingFor: string }
  /** Something the interpreter could not do. The script does not resume. */
  | { readonly kind: 'stopped'; readonly reason: string; readonly offset: number };

/**
 * What a script can reach outside itself.
 *
 * Deliberately four operations rather than a reference to an Engine: the
 * machine is testable against a fixture that implements this, and nothing about
 * it depends on there being a screen.
 */
export interface SkyScriptWorld {
  /** A 32-bit script variable, indexed by number rather than byte offset. */
  readVariable(index: number): number;
  writeVariable(index: number, value: number): void;
  /** A field of the Compact currently running, by its word offset. */
  readCompact(offset: number): number;
  writeCompact(offset: number, value: number): void;
  /**
   * Calls out of the machine.
   *
   * Returns false to pause the script — which is a normal thing for a Sky
   * mcode to do, not an error: `fnSpeakWait` pauses until the line is over.
   * Throws `SkyMcodeUnimplemented` when there is nothing to call.
   */
  callMcode(mcode: number, a: number, b: number, c: number): boolean;
}

/** Thrown by a world that has no implementation for an mcode. */
export class SkyMcodeUnimplemented extends Error {
  constructor(readonly mcode: number) {
    super(`${skyMcodeName(mcode)} is not implemented.`);
  }
}

/** A script variable is 32 bits and the operand counts bytes. */
const VARIABLE_STRIDE = 4;

/** Deep enough for anything the shipped scripts do; a runaway is a fault. */
const MAX_STACK = 64;

/** Instructions one call may run before it is treated as a runaway. */
const MAX_STEPS = 200_000;

export interface SkyRunReport {
  readonly outcome: SkyRunOutcome;
  readonly instructions: number;
}

/** A script variable's traffic: how often it was read and how often written. */
export interface SkyVariableTraffic {
  readonly index: number;
  readonly reads: number;
  readonly writes: number;
}

export class SkyInterpreter {
  private readonly stack: number[] = [];
  /** Every mcode a run has asked for and could not have, by name. */
  readonly unimplemented = new Map<string, number>();
  /** The last few instructions, for `describeStall` to quote. */
  private readonly recent: SkyInstruction[] = [];

  /**
   * Which script variables the running scripts read and write, and how often.
   *
   * A spin loop names its own cause once this is visible: a variable read
   * thousands of times and written zero times is one nothing on this side ever
   * sets, so the loop reading it can never end. Kept cumulatively across every
   * run rather than per run, because the loop is spread over many Compacts and
   * many ticks and the histogram is what makes that one shape (#268).
   */
  private readonly varReads = new Map<number, number>();
  private readonly varWrites = new Map<number, number>();
  /** Which mcodes the scripts called, by number, and how often. */
  private readonly mcodeCalls = new Map<number, number>();

  constructor(private readonly world: SkyScriptWorld) {}

  /** The last sixteen instructions, oldest first. A stall is read from these. */
  recentInstructions(): readonly SkyInstruction[] {
    return this.recent;
  }

  /**
   * Script variables the scripts touched, busiest first.
   *
   * The one a poll loop spins on rises to the top with `writes` of zero, which
   * is what turns "waiting for something" into "waiting on variable N".
   */
  variableTraffic(): SkyVariableTraffic[] {
    const indices = new Set<number>([...this.varReads.keys(), ...this.varWrites.keys()]);
    const out: SkyVariableTraffic[] = [];
    for (const index of indices) {
      out.push({
        index,
        reads: this.varReads.get(index) ?? 0,
        writes: this.varWrites.get(index) ?? 0,
      });
    }
    return out.sort((left, right) => right.reads - left.reads);
  }

  /** How often each mcode was called, by number, most-called first. */
  mcodeCallCounts(): { mcode: number; count: number }[] {
    return [...this.mcodeCalls.entries()]
      .map(([mcode, count]) => ({ mcode, count }))
      .sort((left, right) => right.count - left.count);
  }

  /**
   * Runs a script's words from an offset until it exits, pauses or stops.
   *
   * The stack is cleared per run rather than carried: a Sky script's stack does
   * not survive a pause — the offset does — and carrying it would make a
   * resumed script see values a fresh one does not.
   */
  run(words: Uint16Array, from: number): SkyRunReport {
    this.stack.length = 0;
    let at = from;
    let instructions = 0;

    for (;;) {
      if (instructions >= MAX_STEPS) {
        return {
          outcome: {
            kind: 'stopped',
            offset: at,
            reason:
              `This script ran ${MAX_STEPS} instructions without exiting or pausing, so it is ` +
              `looping. Reported rather than run forever: a game that stops responding is ` +
              `indistinguishable from a slow one until somebody says which.`,
          },
          instructions,
        };
      }

      let instruction: SkyInstruction;
      try {
        instruction = decodeSkyInstruction(words, at);
      } catch (error) {
        return {
          outcome: {
            kind: 'stopped',
            offset: at,
            reason: error instanceof SkyScriptError ? error.message : String(error),
          },
          instructions,
        };
      }

      this.remember(instruction);
      instructions += 1;
      const next = at + instruction.words;

      switch (instruction.opcode) {
        case 0: {
          // push_variable — the operand counts bytes, not variables.
          const index = instruction.operands[0] / VARIABLE_STRIDE;
          this.varReads.set(index, (this.varReads.get(index) ?? 0) + 1);
          this.push(this.world.readVariable(index));
          break;
        }
        case 1: {
          // less_than, as the game computes it: the second popped is the left.
          const a = this.pop();
          const b = this.pop();
          this.push(a > b ? 1 : 0);
          break;
        }
        case 2:
          this.push(instruction.operands[0]);
          break;
        case 3: {
          const a = this.pop();
          const b = this.pop();
          this.push(a !== b ? 1 : 0);
          break;
        }
        case 4: {
          const a = this.pop();
          const b = this.pop();
          this.push(a && b ? 1 : 0);
          break;
        }
        case 5: // skip_zero
          if (this.pop() === 0) {
            at = instruction.target ?? next;
            continue;
          }
          break;
        case 6: {
          const index = instruction.operands[0] / VARIABLE_STRIDE;
          this.varWrites.set(index, (this.varWrites.get(index) ?? 0) + 1);
          this.world.writeVariable(index, this.pop());
          break;
        }
        case 7: {
          const a = this.pop();
          const b = this.pop();
          this.push((b - a) >>> 0);
          break;
        }
        case 8: {
          const a = this.pop();
          const b = this.pop();
          this.push((b + a) >>> 0);
          break;
        }
        case 9: // skip_always
          at = instruction.target ?? next;
          continue;
        case 10: {
          const a = this.pop();
          const b = this.pop();
          this.push(a || b ? 1 : 0);
          break;
        }
        case 11: {
          // call_mcode: the first operand is how many arguments to pop, and
          // they come off in reverse — c, then b, then a.
          const argumentCount = instruction.operands[0];
          let a = 0;
          let b = 0;
          let c = 0;
          if (argumentCount >= 3) c = this.pop();
          if (argumentCount >= 2) b = this.pop();
          if (argumentCount >= 1) a = this.pop();

          const mcode = instruction.operands[1] / SKY_MCODE_STRIDE;
          this.mcodeCalls.set(mcode, (this.mcodeCalls.get(mcode) ?? 0) + 1);
          try {
            if (!this.world.callMcode(mcode, a, b, c)) {
              // A pause is normal: the script resumes here next tick, which is
              // why the offset returned is the one *after* the call.
              return {
                outcome: { kind: 'paused', offset: next, waitingFor: skyMcodeName(mcode) },
                instructions,
              };
            }
          } catch (error) {
            if (error instanceof SkyMcodeUnimplemented) {
              const name = skyMcodeName(mcode);
              this.unimplemented.set(name, (this.unimplemented.get(name) ?? 0) + 1);
              return {
                outcome: {
                  kind: 'stopped',
                  offset: at,
                  reason:
                    `${name} is not implemented, and this script calls it at word ${at}. ` +
                    `Stopped rather than skipped: an mcode that is passed over leaves the ` +
                    `world in a state the script did not ask for, which shows up later and ` +
                    `somewhere else.`,
                },
                instructions,
              };
            }
            throw error;
          }
          break;
        }
        case 12: {
          const a = this.pop();
          const b = this.pop();
          this.push(a < b ? 1 : 0);
          break;
        }
        case 14: {
          // switch: pairs of (value, byte distance), then a default distance.
          const cases = instruction.operands[0];
          const value = this.pop();
          let taken: number | null = null;
          for (let i = 0; i < cases; i += 1) {
            const caseValue = instruction.operands[1 + i * 2];
            const distance = instruction.operands[2 + i * 2];
            if (caseValue === value) {
              // The distance is measured from the word holding it.
              taken = at + 1 + 1 + i * 2 + 1 + distance / 2;
              break;
            }
          }
          if (taken === null) {
            const fallback = instruction.operands[instruction.operands.length - 1];
            taken = at + instruction.words - 1 + fallback / 2;
          }
          at = taken;
          continue;
        }
        case 15:
          this.push(this.world.readCompact(instruction.operands[0]));
          break;
        case 16:
          this.world.writeCompact(instruction.operands[0], this.pop() & 0xffff);
          break;
        case 17: {
          const a = this.pop();
          const b = this.pop();
          this.push(a === b ? 1 : 0);
          break;
        }
        case 18: // skip_not_zero
          if (this.pop() !== 0) {
            at = instruction.target ?? next;
            continue;
          }
          break;
        case 13:
        case 19:
          return { outcome: { kind: 'finished' }, instructions };
        case 20:
          at = from;
          this.stack.length = 0;
          continue;
        default:
          // Unreachable: the decoder refuses an undefined opcode before this.
          return {
            outcome: {
              kind: 'stopped',
              offset: at,
              reason: `Opcode ${instruction.opcode} decoded and has no case here.`,
            },
            instructions,
          };
      }

      at = next;
    }
  }

  private push(value: number): void {
    if (this.stack.length >= MAX_STACK) {
      throw new SkyScriptError(
        `This script pushed more than ${MAX_STACK} values without popping them, which no ` +
          `shipped script does. Something upstream is consuming the wrong number of operands.`,
      );
    }
    this.stack.push(value >>> 0);
  }

  private pop(): number {
    const value = this.stack.pop();
    if (value === undefined) {
      throw new SkyScriptError(
        `This script popped a value it never pushed. The stack is per-run and a resumed ` +
          `script starts with an empty one, so a pause in the wrong place looks like this.`,
      );
    }
    return value;
  }

  private remember(instruction: SkyInstruction): void {
    this.recent.push(instruction);
    if (this.recent.length > 16) this.recent.shift();
  }
}
