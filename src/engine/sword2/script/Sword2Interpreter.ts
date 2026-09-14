/**
 * Broken Sword II's script machine — the token loop and nothing else.
 *
 * Split from the logic for the reason `SwordInterpreter` is: what a byte means
 * is separable from what the game does, and a test can drive this against a
 * stub with no resources present.
 *
 * ## The object layout the machine has to know about
 *
 * A `GAME_OBJECT` resource is, in order:
 *
 * ```text
 * ResHeader        44 bytes
 * ObjectHub        44 bytes
 * uint32           size of the variable block, in bytes
 * …                the variable block (the script's locals)
 * uint32           numberOfScripts
 * uint32[]         one offset per script, from the code block's start
 * uint32           12345678  — an identifier
 * uint32           code length
 * uint32           checksum: the sum of the code bytes
 * …                the code
 * ```
 *
 * Three details in that layout are load-bearing and easy to get wrong:
 *
 * - The **locals are part of the resource**, so a script's variables persist in
 *   the object between calls. `CP_PUSH_LOCAL_ADDR` hands their *address* to an
 *   mcode, which is how a script passes a structure to the engine.
 * - The **offsets are from the start of the code block**, not from the
 *   resource, and the code block begins after the checksum triple.
 * - The **identifier is 12345678 decimal**, and ScummVM errors when it differs.
 *   Here it is refused with a message, because a wrong identifier means the
 *   resource is not a script and decoding on would produce nonsense.
 *
 * ## `offset` is both a script number and a program counter
 *
 * Under `numberOfScripts` it is a script *number*, resolved through the offset
 * table; at or above it, it is a raw byte offset into the code, and the script
 * number is recovered by finding the last entry at or below it. Revolution's,
 * and it is what lets a resumed script carry only an offset.
 */

import { CP, IR, isSword2Token, sword2TokenName, Sword2ScriptError } from './sword2Tokens.js';
import {
  OBJECT_HUB_SIZE,
  RES_HEADER_SIZE,
  readSword2ResHeader,
} from '../resource/sword2Headers.js';

/** Revolution's stack depth. The scripts are compiled against exactly this. */
export const SWORD2_STACK_SIZE = 10;

/** The identifier that says a resource's script block really is one. */
export const SWORD2_SCRIPT_ID = 12345678;

/** How many instructions one call may run before it is called a runaway. */
export const SWORD2_MAX_STEPS_PER_CYCLE = 500000;

/** A parsed object: where its parts are, so nothing recomputes the offsets. */
export interface Sword2ObjectLayout {
  /** The resource's own bytes. Mutated in place: the locals are game state. */
  readonly bytes: Uint8Array;
  /** Byte offset of the variable block's first variable. */
  readonly localsAt: number;
  readonly localsBytes: number;
  /** Byte offset of the code block's first byte. */
  readonly codeAt: number;
  readonly codeBytes: number;
  readonly scriptCount: number;
  /** Byte offset of each script's first instruction, from `codeAt`. */
  readonly offsets: readonly number[];
  /** The object's name, which the game's own bug workarounds key on. */
  readonly name: string;
  /** Whether the code's checksum matched. A mismatch is a note, not a refusal. */
  readonly checksumOk: boolean;
}

/**
 * Reads a `GAME_OBJECT` resource's layout.
 *
 * Refuses on the identifier and on anything that does not fit; a checksum
 * mismatch is recorded rather than refused, because ScummVM has a report of a
 * German release whose checksums are simply wrong and which plays fine.
 */
export function parseSword2Object(bytes: Uint8Array): Sword2ObjectLayout {
  if (bytes.length < RES_HEADER_SIZE + OBJECT_HUB_SIZE + 4) {
    throw new Sword2ScriptError(
      `A game object is ${bytes.length} bytes, too short for its header, its hub and its ` +
        `variable block's size.`,
    );
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = readSword2ResHeader(bytes);

  const scriptBase = RES_HEADER_SIZE + OBJECT_HUB_SIZE;
  const localsBytes = view.getUint32(scriptBase, true);
  const localsAt = scriptBase + 4;
  let at = scriptBase + localsBytes + 4;
  if (at + 4 > bytes.length) {
    throw new Sword2ScriptError(
      `Object "${header.name}" declares a ${localsBytes}-byte variable block, which does not ` +
        `fit in its ${bytes.length} bytes.`,
    );
  }

  const scriptCount = view.getUint32(at, true);
  at += 4;
  if (scriptCount > 0xffff || at + scriptCount * 4 + 12 > bytes.length) {
    throw new Sword2ScriptError(
      `Object "${header.name}" declares ${scriptCount} scripts, whose offset table does not fit ` +
        `in its ${bytes.length} bytes.`,
    );
  }
  const offsets: number[] = [];
  for (let script = 0; script < scriptCount; script++) {
    offsets.push(view.getUint32(at + script * 4, true));
  }
  at += scriptCount * 4;

  const identifier = view.getUint32(at, true);
  if (identifier !== SWORD2_SCRIPT_ID) {
    throw new Sword2ScriptError(
      `Object "${header.name}" has ${identifier} where its script block's identifier should be ` +
        `${SWORD2_SCRIPT_ID}. This resource is not a game object, so decoding it as one would ` +
        `produce nonsense.`,
    );
  }
  const codeBytes = view.getUint32(at + 4, true);
  const declaredChecksum = view.getUint32(at + 8, true);
  const codeAt = at + 12;
  if (codeAt + codeBytes > bytes.length) {
    throw new Sword2ScriptError(
      `Object "${header.name}" declares ${codeBytes} bytes of code and its resource holds ` +
        `${bytes.length - codeAt} after the header.`,
    );
  }

  let checksum = 0;
  for (let byte = 0; byte < codeBytes; byte++) checksum = (checksum + bytes[codeAt + byte]) >>> 0;

  return {
    bytes,
    localsAt,
    localsBytes,
    codeAt,
    codeBytes,
    scriptCount,
    offsets,
    name: header.name,
    checksumOk: checksum === declaredChecksum,
  };
}

/** What the machine needs from the game to run a script. */
export interface Sword2ScriptHost {
  getVar(number: number): number;
  setVar(number: number, value: number): void;
  /**
   * Calls mcode `number` with `params`.
   *
   * The return is Revolution's packed pair: the low three bits are an `IR_*`
   * code and the rest is a value the next `CP_JUMP_ON_RETURNED` indexes by.
   * Returning them packed rather than as two fields is what keeps the mcode
   * signature identical to the original's, which matters when transcribing a
   * hundred and eighteen of them.
   */
  callMcode(number: number, params: Int32Array, object: Sword2ObjectLayout): number;
  /**
   * Turns a byte offset inside the object into a token an mcode can use.
   *
   * `CP_PUSH_LOCAL_ADDR` and `CP_PUSH_DEREFERENCED_STRUCTURE` push *pointers*
   * in the original. A pointer is not a thing this project can put on a stack
   * of numbers, so the host encodes an offset and decodes it again when an
   * mcode dereferences one — which is exactly what ScummVM's own
   * `_memory->encodePtr` does, for the same reason (it has to survive a save).
   */
  encodeOffset(object: Sword2ObjectLayout, at: number): number;
  onFault?(message: string): void;
}

/** What a run of the machine did. */
export interface Sword2ScriptResult {
  /** `IR_STOP`, `IR_CONT` or `IR_TERMINATE`, as the caller's loop expects. */
  readonly result: number;
  /** Where to resume, as a byte offset into the code. */
  readonly offset: number;
  readonly steps: number;
  readonly fault?: string;
  /**
   * Set when the caller must leave the object's program counter alone.
   *
   * ScummVM passes `runScript` a *pointer* into the hub —
   * `_curObjectHub.getScriptPcPtr(level)` (`logic.cpp:127`) — and the two
   * `IR_TERMINATE` returns are the ones that never write through it
   * (`interpreter.cpp`: `case CP_TERMINATE: return 2;` and the mcode's
   * `case IR_TERMINATE: // Return without updating the offset`). That omission
   * is load-bearing, because `fnNewScript`, `fnGosub` and an event all reach
   * the hub *first*, through `logicReplace`/`logicUp`/`logicOne`, and then
   * return `IR_TERMINATE`: the pc the caller holds is the old script's, and
   * storing it would undo the new one. It is how Broken Sword II's demo ends —
   * the fence's `fnNewScript(ScreenManager21 script 3)` otherwise resumes the
   * screen manager at the fence's own program counter, which is past the end of
   * the manager's code.
   *
   * `IR_GOSUB` is the deliberate exception and leaves this unset: its offset is
   * the return address, and it belongs to the level the gosub came *from*.
   */
  readonly holdOffset?: true;
}

/**
 * Runs one object's script from `offset` until it stops.
 *
 * `offset` is read and written by the caller — it lives in the object's hub —
 * and is both a script number and a program counter (see the file header).
 */
export function runSword2Script(
  object: Sword2ObjectLayout,
  host: Sword2ScriptHost,
  offset: number,
  /**
   * The object whose *structures* a dereference reads, when it is not this one.
   *
   * An object can run another object's script — `processSession` does it
   * whenever a script id names a different object — and the two halves come
   * from different resources: the code and its **locals** from the script's
   * resource, the typed structures from the running object's. Getting that
   * backwards is silent: a script reads its own mouse box instead of the one it
   * is acting on.
   */
  dataObject: Sword2ObjectLayout = object,
): Sword2ScriptResult {
  const { bytes, codeAt, codeBytes, scriptCount, offsets, localsAt } = object;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  let ip: number;
  let scriptNumber: number;
  if (offset < scriptCount) {
    ip = offsets[offset] ?? 0;
    scriptNumber = offset;
  } else {
    ip = offset;
    let found = 0;
    for (let script = 1; script < scriptCount; script++) {
      if ((offsets[script] ?? 0) >= ip) break;
      found = script;
    }
    scriptNumber = found;
  }

  const stack = new Int32Array(SWORD2_STACK_SIZE);
  let sp = 0;
  const params = new Int32Array(SWORD2_STACK_SIZE);

  let steps = 0;
  let savedStartOfMcode = 0;
  let returnedValue = 0;

  const fail = (message: string): Sword2ScriptResult => {
    host.onFault?.(message);
    return { result: IR.TERMINATE, offset: ip, steps, fault: message };
  };

  const u8 = (): number => bytes[codeAt + ip++];
  const i16 = (): number => {
    const value = view.getInt16(codeAt + ip, true);
    ip += 2;
    return value;
  };
  const i32 = (): number => {
    const value = view.getInt32(codeAt + ip, true);
    ip += 4;
    return value;
  };
  const peek32 = (): number => view.getInt32(codeAt + ip, true);

  for (;;) {
    if (++steps > SWORD2_MAX_STEPS_PER_CYCLE) {
      return fail(
        `object "${object.name}" script ${scriptNumber} ran ${SWORD2_MAX_STEPS_PER_CYCLE} ` +
          `instructions in one cycle without stopping, so it is being treated as a runaway ` +
          `rather than hanging the page`,
      );
    }
    if (ip < 0 || ip >= codeBytes) {
      return fail(`object "${object.name}" script ${scriptNumber} ran off the end of its code`);
    }

    const token = u8();
    switch (token) {
      case CP.END_SCRIPT:
        return { result: IR.CONT, offset: ip, steps };

      case CP.QUIT:
        return { result: IR.STOP, offset: ip, steps };

      case CP.TERMINATE:
        // Deliberately does *not* update the offset, which is what makes a
        // terminated script restart from where it was rather than continue.
        return { result: IR.TERMINATE, offset, steps, holdOffset: true };

      case CP.RESTART_SCRIPT:
        ip = offsets[scriptNumber] ?? 0;
        break;

      case CP.PUSH_INT32:
        if (sp >= SWORD2_STACK_SIZE) return fail(overflow(object.name));
        stack[sp++] = i32();
        break;

      case CP.PUSH_LOCAL_VAR32: {
        const at = i16();
        if (sp >= SWORD2_STACK_SIZE) return fail(overflow(object.name));
        stack[sp++] = view.getInt32(localsAt + at, true);
        break;
      }

      case CP.PUSH_GLOBAL_VAR32: {
        const number = i16();
        if (sp >= SWORD2_STACK_SIZE) return fail(overflow(object.name));
        stack[sp++] = host.getVar(number);
        break;
      }

      case CP.PUSH_LOCAL_ADDR: {
        const at = i16();
        if (sp >= SWORD2_STACK_SIZE) return fail(overflow(object.name));
        stack[sp++] = host.encodeOffset(object, localsAt + at);
        break;
      }

      case CP.PUSH_STRING: {
        // A length byte, then the string. The *address* is pushed, so a
        // caller's `encodeOffset` has to be able to read it back.
        const length = u8();
        if (sp >= SWORD2_STACK_SIZE) return fail(overflow(object.name));
        stack[sp++] = host.encodeOffset(object, codeAt + ip);
        ip += length + 1;
        break;
      }

      case CP.PUSH_DEREFERENCED_STRUCTURE: {
        const at = i32();
        if (sp >= SWORD2_STACK_SIZE) return fail(overflow(object.name));
        // Past the header, the hub and the variable-block size word — which is
        // where the object's typed structures begin.
        stack[sp++] = host.encodeOffset(dataObject, RES_HEADER_SIZE + OBJECT_HUB_SIZE + 4 + at);
        break;
      }

      case CP.POP_LOCAL_VAR32: {
        const at = i16();
        if (sp < 1) return fail(underflow(object.name));
        view.setInt32(localsAt + at, stack[--sp], true);
        break;
      }

      case CP.POP_GLOBAL_VAR32: {
        const number = i16();
        if (sp < 1) return fail(underflow(object.name));
        host.setVar(number, stack[--sp]);
        break;
      }

      case CP.ADDNPOP_LOCAL_VAR32: {
        const at = i16();
        if (sp < 1) return fail(underflow(object.name));
        view.setInt32(localsAt + at, view.getInt32(localsAt + at, true) + stack[--sp], true);
        break;
      }

      case CP.SUBNPOP_LOCAL_VAR32: {
        const at = i16();
        if (sp < 1) return fail(underflow(object.name));
        view.setInt32(localsAt + at, view.getInt32(localsAt + at, true) - stack[--sp], true);
        break;
      }

      case CP.ADDNPOP_GLOBAL_VAR32: {
        const number = i16();
        if (sp < 1) return fail(underflow(object.name));
        host.setVar(number, host.getVar(number) + stack[--sp]);
        break;
      }

      case CP.SUBNPOP_GLOBAL_VAR32: {
        const number = i16();
        if (sp < 1) return fail(underflow(object.name));
        host.setVar(number, host.getVar(number) - stack[--sp]);
        break;
      }

      case CP.SKIPONTRUE: {
        // The operand is *peeked* rather than consumed, because the jump is
        // relative to the operand's own position: not taking it advances four
        // bytes, taking it adds the operand. Consuming first and then adding
        // would double-count.
        const delta = peek32();
        if (sp < 1) return fail(underflow(object.name));
        if (stack[--sp]) ip += delta;
        else ip += 4;
        break;
      }

      case CP.SKIPONFALSE: {
        const delta = peek32();
        if (sp < 1) return fail(underflow(object.name));
        if (stack[--sp]) ip += 4;
        else ip += delta;
        break;
      }

      case CP.SKIPALWAYS:
        ip += peek32();
        break;

      case CP.SWITCH: {
        if (sp < 1) return fail(underflow(object.name));
        const value = stack[--sp];
        const cases = i32();
        let matched = false;
        for (let index = 0; index < cases && !matched; index++) {
          if (value === view.getInt32(codeAt + ip, true)) {
            matched = true;
            ip += view.getInt32(codeAt + ip + 4, true);
          } else {
            ip += 8;
          }
        }
        if (!matched) ip += view.getInt32(codeAt + ip, true);
        break;
      }

      case CP.SAVE_MCODE_START:
        // Where `IR_REPEAT` returns to: the instruction *before* the mcode call
        // it is saving for, which is this one.
        savedStartOfMcode = ip - 1;
        break;

      case CP.CALL_MCODE: {
        const number = i16();
        const count = u8();
        if (count > SWORD2_STACK_SIZE) {
          return fail(
            `object "${object.name}" called mcode ${number} with ${count} parameters and the ` +
              `stack holds ${SWORD2_STACK_SIZE}`,
          );
        }
        if (count > sp) {
          return fail(
            `object "${object.name}" called mcode ${number} wanting ${count} parameters with ` +
              `${sp} on the stack`,
          );
        }
        // The remaining slots are cleared rather than left: the scripts do not
        // always pass as many parameters as an mcode accepts, and ScummVM zeroes
        // the rest "to keep things predictable". A stale value there is a
        // non-deterministic bug.
        params.fill(0);
        for (let index = count - 1; index >= 0; index--) params[index] = stack[--sp];

        const packed = host.callMcode(number, params, dataObject);
        const code = packed & 7;
        returnedValue = packed >> 3;
        if (code === IR.STOP) return { result: IR.STOP, offset: ip, steps };
        if (code === IR.TERMINATE) {
          // The mcode may have moved the object to another script or another
          // level already, so the offset this run started at is not a resume
          // point — see `holdOffset`.
          return { result: IR.TERMINATE, offset, steps, holdOffset: true };
        }
        if (code === IR.REPEAT) return { result: IR.STOP, offset: savedStartOfMcode, steps };
        if (code === IR.GOSUB) return { result: IR.TERMINATE, offset: ip, steps };
        // IR_CONT falls through.
        break;
      }

      case CP.JUMP_ON_RETURNED: {
        // A jump table indexed by the last mcode's returned value. The count
        // byte bounds it; a value past the table would read a jump out of the
        // code, so it is clamped rather than trusted.
        const entries = u8();
        const index = returnedValue >= 0 && returnedValue < entries ? returnedValue : 0;
        ip += view.getInt32(codeAt + ip + index * 4, true);
        break;
      }

      // The operators. All binary except none: `OP_*` pops two and pushes one,
      // and the pop order is `b` then `a`, so `a` is the left operand.
      case CP.OP_ISEQUAL:
      case CP.OP_NOTEQUAL:
      case CP.OP_PLUS:
      case CP.OP_MINUS:
      case CP.OP_TIMES:
      case CP.OP_DIVIDE:
      case CP.OP_ANDAND:
      case CP.OP_OROR:
      case CP.OP_GTTHAN:
      case CP.OP_LSTHAN:
      case CP.OP_GTTHANE:
      case CP.OP_LSTHANE: {
        if (sp < 2) return fail(underflow(object.name));
        const b = stack[--sp];
        const a = stack[--sp];
        let value: number;
        switch (token) {
          case CP.OP_ISEQUAL:
            value = a === b ? 1 : 0;
            break;
          case CP.OP_NOTEQUAL:
            value = a !== b ? 1 : 0;
            break;
          case CP.OP_PLUS:
            value = a + b;
            break;
          case CP.OP_MINUS:
            value = a - b;
            break;
          case CP.OP_TIMES:
            value = a * b;
            break;
          case CP.OP_DIVIDE:
            if (b === 0) {
              host.onFault?.(
                `object "${object.name}" divided by zero; the original's behaviour here is ` +
                  `undefined, so this reads as zero`,
              );
              value = 0;
            } else {
              value = Math.trunc(a / b);
            }
            break;
          case CP.OP_ANDAND:
            value = a && b ? 1 : 0;
            break;
          case CP.OP_OROR:
            value = a || b ? 1 : 0;
            break;
          case CP.OP_GTTHAN:
            value = a > b ? 1 : 0;
            break;
          case CP.OP_LSTHAN:
            value = a < b ? 1 : 0;
            break;
          case CP.OP_GTTHANE:
            value = a >= b ? 1 : 0;
            break;
          default:
            value = a <= b ? 1 : 0;
            break;
        }
        stack[sp++] = value | 0;
        break;
      }

      // Debugging instructions in Revolution's own build. Shipped scripts
      // contain them; they do nothing here, exactly as in ScummVM.
      case CP.DEBUGON:
      case CP.DEBUGOFF:
        break;
      case CP.TEMP_TEXT_PROCESS:
        i32();
        break;

      default:
        return fail(
          `byte ${token} at ${ip - 1} of object "${object.name}" script ${scriptNumber} is not a ` +
            `Broken Sword II token${isSword2Token(token) ? '' : ''}. Either the resource is not ` +
            `bytecode or the offset is not on an instruction boundary`,
        );
    }
  }
}

function overflow(name: string): string {
  return (
    `object "${name}" pushed past Broken Sword II's ${SWORD2_STACK_SIZE}-deep stack, which no ` +
    `script Revolution compiled can do — so this is a decoding fault rather than a deep ` +
    `expression`
  );
}

function underflow(name: string): string {
  return (
    `object "${name}" popped an empty stack, which means the script offset is not on an ` +
    `instruction boundary`
  );
}

/** For a fault message: what a token is called. */
export { sword2TokenName };
