import type { ScummEngine } from '../../ScummEngine.js';
import { ClassicScriptEngine, PARAM_1 } from '../ClassicScriptEngine.js';
import type { ScriptState } from '../ScriptState.js';

/**
 * The SCUMM v3 bytecode interpreter — Indiana Jones and the Last Crusade,
 * Loom on floppy, Zak McKracken.
 *
 * A delta on the Classic base, not on v4. ADR 0006 refused v7-over-v6 for the
 * reason that applies here too: v3 is not v4 with things removed, and a
 * subclass would make every later correction to v4 arrive in v3 whether it
 * belonged there or not. What the two share is in the base — that is what
 * `installPreV5Opcodes` is — and what differs is here.
 *
 * Three numbers, and the pattern is the one the whole widening keeps meeting:
 * each is an instruction v4 and v5 use for something else, so inheriting their
 * table would not fail, it would run the wrong instruction and consume the
 * wrong number of bytes.
 *
 *   0x30  setBoxFlags    where v4 and v5 run the box matrix operations
 *   0x3b  waitForActor   where v4 and v5 read an actor's scale
 *   0x4c  waitForSentence  which v4 does not have and v5 spends on soundKludge
 */
export class ScriptEngine extends ClassicScriptEngine {
  /** The title, for the two instructions whose operands depend on it. */
  private readonly title: string;

  constructor(engine: ScummEngine, state: ScriptState) {
    super(engine, state);
    this.title = engine.gameId.toLowerCase();
    this.installOpcodes();
  }

  protected override get classicVersion(): number {
    return 3;
  }

  /**
   * v3 numbers its `actorOps` sub-opcodes as v4 does.
   *
   * The table is ScummVM's `convertTable`, applied for every Version with a
   * small header rather than for v4 alone, which is why it is duplicated here
   * as a value rather than inherited from a sibling — a version folder must not
   * import another version's (ADR 0003), and a shared constant for two entries
   * that happen to agree would hide the day they stop agreeing.
   */
  private static readonly ACTOR_OPS = [
    1, 0, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20,
  ] as const;

  protected override actorOpFor(sub: number): number {
    return ScriptEngine.ACTOR_OPS[sub - 1] ?? sub;
  }

  protected installOpcodes(): void {
    this.installClassicSharedOpcodes();
    this.installPreV5Opcodes();

    const bind = (handler: (this: this) => void, ...codes: number[]): void => {
      for (const code of codes) this.dispatch[code] = handler;
    };

    bind(this.o_setBoxFlags, 0x30, 0xb0);
    bind(this.o_waitForActor, 0x3b, 0xbb);
    bind(this.o_waitForSentence, 0x4c);
  }

  /**
   * Sets a walk box's flags: a box number, then a *literal* byte.
   *
   * The second operand has no mode bit of its own — it is read with a plain
   * fetch — which is what makes this a different instruction from v4's
   * `matrixOps` rather than a narrowing of it.
   */
  protected o_setBoxFlags(): void {
    const box = this.getVarOrDirectByte(PARAM_1);
    const flags = this.fetchByte();
    this.engine.setBoxFlags(box, flags);
  }

  /**
   * Waits for an actor to stop moving — in Indy 3, and nowhere else.
   *
   * The instruction is a no-op in Loom and Zak *and reads no operand there*,
   * so this is not a behaviour difference that can be papered over: reading a
   * byte for a title that does not write one takes the next instruction's
   * first byte. ScummVM keeps the same branch for the same reason.
   */
  protected o_waitForActor(): void {
    if (!this.title.includes('indy') && !this.title.includes('atlantis')) return;

    const start = this.pc - 1;
    const actor = this.engine.getActor(this.getVarOrDirectByte(PARAM_1));
    if (actor && actor.moving) {
      this.pc = start;
      this.breakHere();
    }
  }

  /** Waits for the sentence script to finish. No operands. */
  protected o_waitForSentence(): void {
    if (!this.engine.isSentencePending()) return;
    this.pc -= 1;
    this.breakHere();
  }
}
