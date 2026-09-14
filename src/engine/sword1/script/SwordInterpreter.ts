/**
 * Broken Sword's script machine — the token loop and nothing else.
 *
 * Separated from `SwordLogic` deliberately. What this file does is decide what a
 * word means; what the mcodes do is the *game*, and mixing the two is how the
 * SCUMM side ended up with a script engine that could not be tested without a
 * room. Here the machine takes a host interface, so a test can run a
 * hand-written script against a stub and check the stack arithmetic with no
 * resources present at all.
 *
 * ## The stack is nine deep and that is not a simplification
 *
 * `MAX_STACK_SIZE` is 10 in Revolution's interpreter and the scripts are
 * compiled against it. Growing it would not make a shipped script work that
 * does not already; overflowing it is a decoding fault, and reporting it as one
 * is more useful than silently allowing a deeper expression than the compiler
 * could ever have emitted.
 *
 * ## Where a cycle ends
 *
 * An mcode returns 0 to mean "stop here, resume at the next instruction next
 * cycle" and non-zero to mean "keep going". That return is the only thing that
 * ends a cycle other than `IT_SCRIPTEND`, and it is why `interpretScript`
 * answers a **program counter**: the caller writes it back into the compact's
 * tree, and next cycle starts there. Zero means the script finished and the
 * logic tree should pop a level.
 */

import type { SwordCompact } from '../resource/swordCompact.js';
import {
  IT,
  SWORD1_SCRIPT_VERSION,
  Sword1ScriptError,
  type Sword1ScriptModule,
} from './swordTokens.js';
import { SWORD1_ITM_ID } from '../resource/swordDefs.js';

/** Applies the host's numbering, if it has one of its own. */
function scriptVar(host: SwordScriptHost, number: number): number {
  return host.scriptVarIndex ? host.scriptVarIndex(number) : number;
}

/** Revolution's stack depth. The scripts are compiled against exactly this. */
export const SWORD1_MAX_STACK = 10;

/**
 * What the machine needs from the game to run a script.
 *
 * Four things, which is the whole coupling: the globals, the mcodes, and a way
 * to say something went wrong. Everything else a script can reach it reaches
 * through the compact, which it is handed.
 */
export interface SwordScriptHost {
  getVar(number: number): number;
  setVar(number: number, value: number): void;
  /**
   * Calls mcode `number` with `args` (already popped, in script order).
   *
   * Returns 0 to end the cycle at the *next* instruction, non-zero to continue.
   * ScummVM's `mCodeReturn` exactly. An mcode this project does not implement
   * is the host's problem to report, not the machine's — which is why there is
   * no "unknown mcode" branch here.
   */
  callMcode(number: number, args: number[], compact: SwordCompact, id: number): number;
  /**
   * Translates a variable number in the bytecode into the host's own numbering.
   *
   * Optional, and absent means the identity — which is what a test with a stub
   * host wants and what every retail Release is. The demo's scripts were
   * compiled against a shorter enum, so for that Release this is the map in
   * `swordVarLayout.ts`. See that file for how it was measured.
   */
  scriptVarIndex?(number: number): number;
  /** Told about a fault, so the engine's status line can say what stopped it. */
  onFault?(message: string): void;
}

/** What a run of the machine did, for the caller and for a stall report. */
export interface SwordScriptResult {
  /**
   * Where to resume, as a word index, or 0 when the script ended.
   *
   * Zero is `IT_SCRIPTEND`'s answer and is what pops a logic level. Anything
   * else is written straight into `o_script_pc`.
   */
  readonly pc: number;
  /** Instructions executed, for the stall report. */
  readonly steps: number;
  /** Set when the machine refused; the script is then left where it was. */
  readonly fault?: string;
}

/**
 * How many instructions one call may run before it is called a runaway.
 *
 * Not in Revolution's interpreter, which would simply hang. A browser tab that
 * hangs is indistinguishable from a crash, so a ceiling turns an infinite script
 * loop into a sentence on the status line. Generous enough that no shipped
 * script reaches it: the longest single-cycle script run observed in Broken
 * Sword is in the low thousands.
 */
export const SWORD1_MAX_STEPS_PER_CYCLE = 500000;

/**
 * Runs one compact's script until an mcode stops it or the script ends.
 *
 * `scriptBase` is the script id the tree holds — its low 16 bits select which
 * script's start `IT_RESTARTSCRIPT` returns to. `scriptNum` is either a script
 * *number* (resolved through the module's offset table) or a raw program
 * counter, and which it is follows from whether it is below `scriptCount`. That
 * dual meaning is Revolution's, and it is what lets a resumed script carry only
 * a pc in the field a script id was written into.
 */
export function interpretSword1Script(
  module: Sword1ScriptModule,
  host: SwordScriptHost,
  compact: SwordCompact,
  id: number,
  scriptBase: number,
  scriptNum: number,
): SwordScriptResult {
  const { code, scriptCount } = module;

  if (scriptNum < 0) {
    return fail(host, `script number ${scriptNum} is negative`, 0);
  }

  let pc = scriptNum < scriptCount ? (code[scriptNum + 1] ?? -1) : scriptNum;
  if (pc < 0 || pc >= code.length) {
    return fail(
      host,
      `script ${scriptNum} of ${scriptCount} resolves to word ${pc}, outside the ` +
        `${code.length}-word module`,
      0,
    );
  }

  // Where `IT_RESTARTSCRIPT` goes. Read once, from the *base* rather than from
  // the resumed pc, because a script that restarts after being resumed must go
  // to its own beginning and not to wherever it was interrupted.
  const startOfScript = code[(scriptBase & SWORD1_ITM_ID) + 1] ?? pc;

  const stack = new Int32Array(SWORD1_MAX_STACK);
  let sp = 0;
  let steps = 0;

  const push = (value: number): boolean => {
    if (sp >= SWORD1_MAX_STACK) return false;
    stack[sp++] = value | 0;
    return true;
  };

  for (;;) {
    if (++steps > SWORD1_MAX_STEPS_PER_CYCLE) {
      return fail(
        host,
        `script ${scriptNum} of compact ${id} ran ${SWORD1_MAX_STEPS_PER_CYCLE} instructions in ` +
          `one cycle without stopping, so it is being treated as a runaway rather than hanging ` +
          `the page`,
        steps,
      );
    }
    if (pc < 0 || pc >= code.length) {
      return fail(
        host,
        `script ${scriptNum} of compact ${id} ran off the end of its module`,
        steps,
      );
    }

    const token = code[pc++];
    switch (token) {
      case IT.MCODE: {
        const number = code[pc++];
        const count = code[pc++];
        if (count < 0 || count > 6) {
          return fail(
            host,
            `mcode ${number} was called with ${count} arguments; Broken Sword's encoding allows ` +
              `at most six`,
            steps,
          );
        }
        if (count > sp) {
          return fail(
            host,
            `mcode ${number} wants ${count} arguments and the stack holds ${sp}`,
            steps,
          );
        }
        // Popped in reverse and handed over in script order, which is what the
        // fall-through ladder in ScummVM's `IT_MCODE` amounts to: `a` is the
        // deepest of the arguments, not the top of the stack.
        const args: number[] = [];
        for (let at = 0; at < count; at++) args.push(stack[sp - count + at]);
        sp -= count;
        const keepGoing = host.callMcode(number, args, compact, id);
        if (keepGoing === 0) return { pc, steps };
        break;
      }

      case IT.PUSHNUMBER:
        if (!push(code[pc++])) return overflow(host, id, steps);
        break;

      // Through `scriptVarIndex`, because the number in the bytecode is the
      // Release's own and the host keeps its globals in retail numbering.
      case IT.PUSHVARIABLE:
        if (!push(host.getVar(scriptVar(host, code[pc++])))) return overflow(host, id, steps);
        break;

      case IT.PUSHLONGOFFSET:
        if (!push(compact.get(code[pc++]))) return overflow(host, id, steps);
        break;

      // The low 16 bits only. Revolution's own `& 0xffff`, and it is not
      // cosmetic: the field is read as an unsigned word by whatever consumes it,
      // so sign-extending a negative here gives a different number.
      case IT.PUSHWORDOFFSET:
        if (!push(compact.get(code[pc++]) & 0xffff)) return overflow(host, id, steps);
        break;

      case IT.POPVAR:
        if (sp < 1) return underflow(host, id, steps);
        host.setVar(scriptVar(host, code[pc++]), stack[--sp]);
        break;

      case IT.POPLONGOFFSET:
        if (sp < 1) return underflow(host, id, steps);
        compact.set(code[pc++], stack[--sp]);
        break;

      case IT.POPWORDOFFSET:
        if (sp < 1) return underflow(host, id, steps);
        compact.set(code[pc++], stack[--sp] & 0xffff);
        break;

      // The binary operators. All of them pop two and push one, so the stack
      // pointer moves once and the result is written where the left operand was.
      case IT.NOTEQUAL:
      case IT.ISEQUAL:
      case IT.PLUS:
      case IT.TIMES:
      case IT.ANDAND:
      case IT.OROR:
      case IT.LESSTHAN:
      case IT.MINUS:
      case IT.AND:
      case IT.OR:
      case IT.GTE:
      case IT.LTE:
      case IT.DEVIDE:
      case IT.GT: {
        if (sp < 2) return underflow(host, id, steps);
        sp--;
        const left = stack[sp - 1];
        const right = stack[sp];
        let value: number;
        switch (token) {
          case IT.NOTEQUAL:
            value = left !== right ? 1 : 0;
            break;
          case IT.ISEQUAL:
            value = left === right ? 1 : 0;
            break;
          case IT.PLUS:
            value = left + right;
            break;
          case IT.TIMES:
            value = left * right;
            break;
          case IT.ANDAND:
            value = left && right ? 1 : 0;
            break;
          case IT.OROR:
            value = left || right ? 1 : 0;
            break;
          case IT.LESSTHAN:
            value = left < right ? 1 : 0;
            break;
          case IT.MINUS:
            value = left - right;
            break;
          case IT.AND:
            value = left & right;
            break;
          case IT.OR:
            value = left | right;
            break;
          case IT.GTE:
            value = left >= right ? 1 : 0;
            break;
          case IT.LTE:
            value = left <= right ? 1 : 0;
            break;
          case IT.DEVIDE:
            // Integer division truncating toward zero, and a guard C does not
            // have: dividing by zero here is undefined in the original and
            // `Infinity` in JavaScript, which would then be written into a
            // compact as a NaN-ish word. Zero is the answer that keeps the
            // game running, and the fault is reported rather than hidden.
            if (right === 0) {
              host.onFault?.(
                `a script divided by zero (compact ${id}); the original's behaviour here is ` +
                  `undefined, so this reads as zero`,
              );
              value = 0;
            } else {
              value = Math.trunc(left / right);
            }
            break;
          default:
            value = left > right ? 1 : 0;
            break;
        }
        stack[sp - 1] = value | 0;
        break;
      }

      case IT.NOT:
        if (sp < 1) return underflow(host, id, steps);
        stack[sp - 1] = stack[sp - 1] ? 0 : 1;
        break;

      case IT.SCRIPTEND:
        return { pc: 0, steps };

      case IT.SKIPONFALSE:
        if (sp < 1) return underflow(host, id, steps);
        if (stack[--sp]) pc++;
        else pc += code[pc];
        break;

      case IT.SKIPONTRUE:
        if (sp < 1) return underflow(host, id, steps);
        if (stack[--sp]) pc += code[pc];
        else pc++;
        break;

      case IT.SKIP:
        pc += code[pc];
        break;

      case IT.SWITCH: {
        if (sp < 1) return underflow(host, id, steps);
        const value = stack[--sp];
        const cases = code[pc++];
        let matched = false;
        for (let at = 0; at < cases && !matched; at++) {
          if (value === code[pc]) {
            pc += code[pc + 1];
            matched = true;
          } else {
            pc += 2;
          }
        }
        // The jump is relative to where the walk stopped, which for a match is
        // the matching case's own pair and for a miss is the default that
        // follows the last pair. Both are `pc += code[pc]`-shaped and the
        // difference is only where `pc` got to, which is why the loop leaves it
        // alone on a match.
        if (!matched) pc += code[pc];
        break;
      }

      // A debugging instruction in Revolution's own build. Shipped scripts
      // contain them; it prints nothing here, exactly as it prints nothing in
      // ScummVM, and consumes no operand.
      case IT.PRINTF:
        break;

      case IT.RESTARTSCRIPT:
        pc = startOfScript;
        break;

      default:
        return fail(
          host,
          `word ${token} at ${pc - 1} of compact ${id}'s script ${scriptNum} is not a Broken ` +
            `Sword token. Either the script resource is not bytecode or the program counter is ` +
            `not on an instruction boundary`,
          steps,
        );
    }
  }
}

function fail(host: SwordScriptHost, message: string, steps: number): SwordScriptResult {
  host.onFault?.(message);
  return { pc: 0, steps, fault: message };
}

function overflow(host: SwordScriptHost, id: number, steps: number): SwordScriptResult {
  return fail(
    host,
    `compact ${id}'s script pushed past Broken Sword's ${SWORD1_MAX_STACK}-deep stack, which no ` +
      `script Revolution compiled can do — so this is a decoding fault rather than a deep ` +
      `expression`,
    steps,
  );
}

function underflow(host: SwordScriptHost, id: number, steps: number): SwordScriptResult {
  return fail(
    host,
    `compact ${id}'s script popped an empty stack, which means the program counter is not on an ` +
      `instruction boundary`,
    steps,
  );
}

/** Checks a script module's header, so a wrong resource is refused by name. */
export function checkSword1ScriptModule(type: string, version: number): void {
  if (!type.startsWith('Script')) {
    throw new Sword1ScriptError(
      `A script resource's header says its type is "${type}" rather than "Script". This is not ` +
        `bytecode — the resource id is probably addressing the wrong cluster.`,
    );
  }
  if (version !== SWORD1_SCRIPT_VERSION) {
    throw new Sword1ScriptError(
      `A script resource declares version ${version} and this interpreter reads ` +
        `${SWORD1_SCRIPT_VERSION}, which every shipped Broken Sword release carries. Refusing ` +
        `rather than decoding it as though the encoding had not changed.`,
    );
  }
}
