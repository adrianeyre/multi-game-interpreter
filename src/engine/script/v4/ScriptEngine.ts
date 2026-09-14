import type { ScummEngine } from '../../ScummEngine.js';
import { ClassicScriptEngine } from '../ClassicScriptEngine.js';
import type { ScriptState } from '../ScriptState.js';

/**
 * The SCUMM v4 bytecode interpreter — Monkey Island 1, Loom CD.
 *
 * The thinnest delta in the whole widening, which is why v4 was chosen as the
 * first Version on the Classic side: everything it has that v5 does not is
 * shared with v3 and v2 and lives in the base, and everything v5 has that it
 * does not is cleared there too. What is left here is the two answers only the
 * Version knows — which numbering its `actorOps` sub-opcodes use, and how many
 * operands the handful of Version-sensitive instructions read.
 */
export class ScriptEngine extends ClassicScriptEngine {
  constructor(engine: ScummEngine, state: ScriptState) {
    super(engine, state);
    this.installOpcodes();
  }

  protected override get classicVersion(): number {
    return 4;
  }

  /**
   * v3 and v4 number their `actorOps` sub-opcodes differently from v5.
   *
   * ScummVM's `convertTable`, indexed by the sub-opcode minus one. The two
   * that map to zero are forms v5 dropped; 20 maps to itself because it is the
   * one number above the run that the two agree on.
   */
  protected static readonly ACTOR_OPS = [
    1, 0, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 20,
  ] as const;

  protected override actorOpFor(sub: number): number {
    const converted = ScriptEngine.ACTOR_OPS[sub - 1];
    // Outside the table is not a sub-opcode any release emits; leaving it
    // alone reports it as unimplemented rather than running an unrelated one.
    return converted ?? sub;
  }

  protected installOpcodes(): void {
    this.installClassicSharedOpcodes();
    this.installPreV5Opcodes();

    // v4 keeps v5's `matrixOps` and `getActorScale`, which v3 spends on
    // `setBoxFlags` and `waitForActor`. Re-bound here because
    // `installClassicSharedOpcodes` leaves both out: they are shared by v4 and
    // v5 and *not* by every Classic Version, which is the whole distinction
    // the two installers draw.
    const bind = (handler: (this: this) => void, ...codes: number[]): void => {
      for (const code of codes) this.dispatch[code] = handler;
    };
    bind(this.o_matrixOps, 0x30, 0xb0);
    bind(this.o_getActorScale, 0x3b, 0xbb);
  }
}
