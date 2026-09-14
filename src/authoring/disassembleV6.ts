/**
 * Reads SCUMM v6 bytecode back into something a person can follow — and edit.
 *
 * The v5 reader stops at any instruction whose length it cannot measure, and
 * its own header explains why: guessing desynchronises everything after it. In
 * v5 that caution costs real coverage, because operand widths depend on mode
 * bits in the opcode and several instructions carry sub-opcode streams whose
 * extent has to be known individually.
 *
 * **v6 is the easier case.** It is a stack machine: operands are pushed by
 * their own instructions, so an instruction's length depends on its opcode
 * alone. That is why ScummVM's `descumm` produces readable v6 output and gives
 * up on v5, and it is what lets a v6 script be decoded exactly, edited, and
 * re-emitted byte-for-byte (ADR 0005).
 *
 * Two readings come out of one pass:
 *
 * - **Instructions**, one per opcode, with offset, length and operands. This is
 *   the editable form: 1:1 with the bytes, so re-emitting an untouched script
 *   reproduces it exactly.
 * - **A folded listing**, where the pushes are collapsed back into expressions
 *   (`var250 = getObjectX(var12)` rather than three separate stack
 *   operations), because nobody can edit what they cannot read.
 *
 * The honest-stop behaviour is kept. An opcode not in the table below stops the
 * reading, and the bytes from there are preserved rather than guessed at — v6
 * being more regular is a reason to decode more of it, not a reason to invent
 * the parts still unestablished. The instructions that carry inline strings or
 * sub-opcode streams are the ones absent, and they are absent deliberately.
 *
 * Opcode numbering and operand shapes follow ScummVM's `script_v6.cpp`; the
 * numbering is a fact about the bytecode, and none of its code is reproduced.
 */

import { measureV6Message } from '../engine/script/v6/message.js';
import { measureV7Message } from '../engine/script/v7/message.js';

/** How an instruction's operands are laid out in the code stream. */
type StreamOperands =
  /** No bytes beyond the opcode. */
  | ''
  /** One byte. */
  | 'b'
  /** One 16-bit word. */
  | 'w'
  /** One signed 16-bit jump displacement. */
  | 'j'
  /** A sub-opcode byte and then a word — v8's array instructions. */
  | 'bw'
  /** A sub-opcode byte and nothing else — v8's dispatchers. */
  | 'bx';

interface Shape {
  name: string;
  /** Bytes this instruction reads from the code stream after its opcode. */
  stream: StreamOperands;
  /** Values it takes off the stack, when that number is fixed. */
  pops: number;
  /** True when it leaves a value on the stack. */
  pushes: boolean;
  /**
   * True when it takes a counted list off the stack instead of a fixed number.
   *
   * The count is itself the top of the stack, so the depth consumed is only
   * known at runtime — the folded listing says `(…)` rather than pretending.
   */
  list?: boolean;
  /** True when an inline NUL-terminated message follows the operands. */
  string?: boolean;
  /**
   * True when the fixed operands come off the stack *before* the counted list.
   *
   * The usual order is the other way round, and only `setBoxFlags` differs. It
   * changes nothing about the instruction's length — only which expression the
   * folded listing pairs with which operand.
   */
  popsBeforeList?: boolean;
  /** Renders the folded form. Operands arrive innermost-first. */
  fold?: (operands: string[], stream: string) => string;
}

const call =
  (name: string) =>
  (operands: string[]): string =>
    `${name}(${operands.join(', ')})`;

const infix =
  (operator: string) =>
  (operands: string[]): string =>
    `${operands[0]} ${operator} ${operands[1]}`;

/**
 * Every v6 opcode this reader knows, with its layout.
 *
 * An opcode absent here is one whose layout is not established, and reading
 * stops at it rather than guessing a length.
 */
const SHAPES: Record<number, Shape> = {
  // --- the stack machine ---------------------------------------------------
  0x00: { name: 'pushByte', stream: 'b', pops: 0, pushes: true, fold: (_, s) => s },
  0x01: { name: 'pushWord', stream: 'w', pops: 0, pushes: true, fold: (_, s) => s },
  0x02: { name: 'pushByteVar', stream: 'b', pops: 0, pushes: true, fold: (_, s) => `var${s}` },
  0x03: { name: 'pushWordVar', stream: 'w', pops: 0, pushes: true, fold: (_, s) => `var${s}` },
  0x0c: { name: 'dup', stream: '', pops: 1, pushes: true, fold: (o) => o[0] },
  0x0d: { name: 'not', stream: '', pops: 1, pushes: true, fold: (o) => `!${o[0]}` },
  0x1a: { name: 'pop', stream: '', pops: 1, pushes: false },
  0xa7: { name: 'pop', stream: '', pops: 1, pushes: false },
  0xbd: { name: 'dummy', stream: '', pops: 0, pushes: false },

  0x0e: { name: 'eq', stream: '', pops: 2, pushes: true, fold: infix('==') },
  0x0f: { name: 'neq', stream: '', pops: 2, pushes: true, fold: infix('!=') },
  0x10: { name: 'gt', stream: '', pops: 2, pushes: true, fold: infix('>') },
  0x11: { name: 'lt', stream: '', pops: 2, pushes: true, fold: infix('<') },
  0x12: { name: 'le', stream: '', pops: 2, pushes: true, fold: infix('<=') },
  0x13: { name: 'ge', stream: '', pops: 2, pushes: true, fold: infix('>=') },
  0x14: { name: 'add', stream: '', pops: 2, pushes: true, fold: infix('+') },
  0x15: { name: 'sub', stream: '', pops: 2, pushes: true, fold: infix('-') },
  0x16: { name: 'mul', stream: '', pops: 2, pushes: true, fold: infix('*') },
  0x17: { name: 'div', stream: '', pops: 2, pushes: true, fold: infix('/') },
  0x18: { name: 'land', stream: '', pops: 2, pushes: true, fold: infix('&&') },
  0x19: { name: 'lor', stream: '', pops: 2, pushes: true, fold: infix('||') },
  0xd6: { name: 'band', stream: '', pops: 2, pushes: true, fold: infix('&') },
  0xd7: { name: 'bor', stream: '', pops: 2, pushes: true, fold: infix('|') },
  0xc4: { name: 'abs', stream: '', pops: 1, pushes: true, fold: call('abs') },

  // --- variables -----------------------------------------------------------
  0x42: {
    name: 'writeByteVar',
    stream: 'b',
    pops: 1,
    pushes: false,
    fold: (o, s) => `var${s} = ${o[0]}`,
  },
  0x43: {
    name: 'writeWordVar',
    stream: 'w',
    pops: 1,
    pushes: false,
    fold: (o, s) => `var${s} = ${o[0]}`,
  },
  0x4e: { name: 'byteVarInc', stream: 'b', pops: 0, pushes: false, fold: (_, s) => `var${s}++` },
  0x4f: { name: 'wordVarInc', stream: 'w', pops: 0, pushes: false, fold: (_, s) => `var${s}++` },
  0x56: { name: 'byteVarDec', stream: 'b', pops: 0, pushes: false, fold: (_, s) => `var${s}--` },
  0x57: { name: 'wordVarDec', stream: 'w', pops: 0, pushes: false, fold: (_, s) => `var${s}--` },

  // --- arrays --------------------------------------------------------------
  0x06: {
    name: 'byteArrayRead',
    stream: 'b',
    pops: 1,
    pushes: true,
    fold: (o, s) => `arr${s}[${o[0]}]`,
  },
  0x07: {
    name: 'wordArrayRead',
    stream: 'w',
    pops: 1,
    pushes: true,
    fold: (o, s) => `arr${s}[${o[0]}]`,
  },
  0x46: {
    name: 'byteArrayWrite',
    stream: 'b',
    pops: 2,
    pushes: false,
    fold: (o, s) => `arr${s}[${o[0]}] = ${o[1]}`,
  },
  0x47: {
    name: 'wordArrayWrite',
    stream: 'w',
    pops: 2,
    pushes: false,
    fold: (o, s) => `arr${s}[${o[0]}] = ${o[1]}`,
  },

  // --- flow ----------------------------------------------------------------
  0x73: { name: 'jump', stream: 'j', pops: 0, pushes: false },
  0x5c: { name: 'if', stream: 'j', pops: 1, pushes: false },
  0x5d: { name: 'ifNot', stream: 'j', pops: 1, pushes: false },
  0x65: { name: 'stopObjectCode', stream: '', pops: 0, pushes: false },
  0x66: { name: 'stopObjectCode', stream: '', pops: 0, pushes: false },
  0x6c: { name: 'breakHere', stream: '', pops: 0, pushes: false },
  0x5e: { name: 'startScript', stream: '', pops: 2, pushes: false, list: true },
  0x5f: { name: 'startScriptQuick', stream: '', pops: 1, pushes: false, list: true },
  0xbf: { name: 'startScriptQuick2', stream: '', pops: 1, pushes: false, list: true },
  0x7c: { name: 'stopScript', stream: '', pops: 1, pushes: false, fold: call('stopScript') },
  0x8b: {
    name: 'isScriptRunning',
    stream: '',
    pops: 1,
    pushes: true,
    fold: call('isScriptRunning'),
  },

  // --- delays --------------------------------------------------------------
  0xb0: { name: 'delay', stream: '', pops: 1, pushes: false, fold: call('delay') },
  0xb1: { name: 'delaySeconds', stream: '', pops: 1, pushes: false, fold: call('delaySeconds') },
  0xb2: { name: 'delayMinutes', stream: '', pops: 1, pushes: false, fold: call('delayMinutes') },
  0xca: { name: 'delayFrames', stream: '', pops: 1, pushes: false, fold: call('delayFrames') },

  // --- objects and actors --------------------------------------------------
  0x6f: { name: 'getState', stream: '', pops: 1, pushes: true, fold: call('getState') },
  0x70: { name: 'setState', stream: '', pops: 2, pushes: false, fold: call('setState') },
  0x71: { name: 'setOwner', stream: '', pops: 2, pushes: false, fold: call('setOwner') },
  0x72: { name: 'getOwner', stream: '', pops: 1, pushes: true, fold: call('getOwner') },
  0x84: { name: 'pickupObject', stream: '', pops: 2, pushes: false, fold: call('pickupObject') },
  0x8d: { name: 'getObjectX', stream: '', pops: 1, pushes: true, fold: call('getObjectX') },
  0x8e: { name: 'getObjectY', stream: '', pops: 1, pushes: true, fold: call('getObjectY') },
  0x92: { name: 'findInventory', stream: '', pops: 2, pushes: true, fold: call('findInventory') },
  0x93: {
    name: 'getInventoryCount',
    stream: '',
    pops: 1,
    pushes: true,
    fold: call('getInventoryCount'),
  },
  0x7e: { name: 'walkActorTo', stream: '', pops: 3, pushes: false, fold: call('walkActorTo') },
  // Four operands: v6 added the room, and 0xFF in it means "leave it".
  0x7f: { name: 'putActorAtXY', stream: '', pops: 4, pushes: false, fold: call('putActorAtXY') },
  0x81: { name: 'faceActor', stream: '', pops: 2, pushes: false, fold: call('faceActor') },
  0x82: { name: 'animateActor', stream: '', pops: 2, pushes: false, fold: call('animateActor') },
  0x8c: { name: 'getActorRoom', stream: '', pops: 1, pushes: true, fold: call('getActorRoom') },

  // --- rooms, camera, cutscenes -------------------------------------------
  0x7b: { name: 'loadRoom', stream: '', pops: 1, pushes: false, fold: call('loadRoom') },
  0x85: {
    name: 'loadRoomWithEgo',
    stream: '',
    pops: 4,
    pushes: false,
    fold: call('loadRoomWithEgo'),
  },
  0x78: { name: 'panCameraTo', stream: '', pops: 1, pushes: false, fold: call('panCameraTo') },
  0x79: {
    name: 'actorFollowCamera',
    stream: '',
    pops: 1,
    pushes: false,
    fold: call('actorFollowCamera'),
  },
  0x7a: { name: 'setCameraAt', stream: '', pops: 1, pushes: false, fold: call('setCameraAt') },
  0x68: { name: 'cutscene', stream: '', pops: 0, pushes: false, list: true },
  0x67: { name: 'endCutscene', stream: '', pops: 0, pushes: false },
  0x95: { name: 'beginOverride', stream: '', pops: 0, pushes: false },
  0x96: { name: 'endOverride', stream: '', pops: 0, pushes: false },
  0x6a: {
    name: 'freezeUnfreeze',
    stream: '',
    pops: 1,
    pushes: false,
    fold: call('freezeUnfreeze'),
  },

  // --- sound ---------------------------------------------------------------
  0x74: { name: 'startSound', stream: '', pops: 1, pushes: false, fold: call('startSound') },
  0x75: { name: 'stopSound', stream: '', pops: 1, pushes: false, fold: call('stopSound') },
  0x76: { name: 'startMusic', stream: '', pops: 1, pushes: false, fold: call('startMusic') },
  0x69: { name: 'stopMusic', stream: '', pops: 0, pushes: false },
  0x98: { name: 'isSoundRunning', stream: '', pops: 1, pushes: true, fold: call('isSoundRunning') },
  0xac: { name: 'soundKludge', stream: '', pops: 0, pushes: false, list: true },

  // --- numbers -------------------------------------------------------------
  0x87: {
    name: 'getRandomNumber',
    stream: '',
    pops: 1,
    pushes: true,
    fold: call('getRandomNumber'),
  },
  0x88: {
    name: 'getRandomNumberRange',
    stream: '',
    pops: 2,
    pushes: true,
    fold: call('getRandomNumberRange'),
  },
  0xad: { name: 'isAnyOf', stream: '', pops: 1, pushes: true, list: true },

  // --- sentence ------------------------------------------------------------
  // Four operands, the third of which is unused — but pushed, so it counts.
  0x83: { name: 'doSentence', stream: '', pops: 4, pushes: false, fold: call('doSentence') },
  0xb3: { name: 'stopSentence', stream: '', pops: 0, pushes: false },

  // --- the rest of the fixed-shape instructions ----------------------------
  0x52: { name: 'byteArrayInc', stream: 'b', pops: 1, pushes: false },
  0x53: { name: 'wordArrayInc', stream: 'w', pops: 1, pushes: false },
  0x5a: { name: 'byteArrayDec', stream: 'b', pops: 1, pushes: false },
  0x5b: { name: 'wordArrayDec', stream: 'w', pops: 1, pushes: false },
  0x0a: {
    name: 'byteArrayIndexedRead',
    stream: 'b',
    pops: 2,
    pushes: true,
    fold: (o, s) => `arr${s}[${o[0]}][${o[1]}]`,
  },
  0x0b: {
    name: 'wordArrayIndexedRead',
    stream: 'w',
    pops: 2,
    pushes: true,
    fold: (o, s) => `arr${s}[${o[0]}][${o[1]}]`,
  },
  0x4a: {
    name: 'byteArrayIndexedWrite',
    stream: 'b',
    pops: 3,
    pushes: false,
    fold: (o, s) => `arr${s}[${o[0]}][${o[1]}] = ${o[2]}`,
  },
  0x4b: {
    name: 'wordArrayIndexedWrite',
    stream: 'w',
    pops: 3,
    pushes: false,
    fold: (o, s) => `arr${s}[${o[0]}][${o[1]}] = ${o[2]}`,
  },
  0xd4: { name: 'shuffle', stream: 'w', pops: 2, pushes: false },
  0xe3: { name: 'pickVarRandom', stream: 'w', pops: 0, pushes: true, list: true },
  0xdd: { name: 'findAllObjects', stream: '', pops: 1, pushes: true },

  // Classes select on bit 7 of each entry, not on a sign.
  0x6d: { name: 'ifClassOfIs', stream: '', pops: 1, pushes: true, list: true },
  0x6e: { name: 'setClass', stream: '', pops: 1, pushes: false, list: true },

  // Objects.
  0x60: { name: 'startObject', stream: '', pops: 3, pushes: false, list: true },
  0xbe: { name: 'startObjectQuick', stream: '', pops: 2, pushes: false, list: true },
  0x77: { name: 'stopObjectScript', stream: '', pops: 1, pushes: false },
  0x61: { name: 'drawObject', stream: '', pops: 2, pushes: false, fold: call('drawObject') },
  0x62: { name: 'drawObjectAt', stream: '', pops: 3, pushes: false, fold: call('drawObjectAt') },
  0xcd: { name: 'stampObject', stream: '', pops: 4, pushes: false },
  0x63: { name: 'drawBlastObject', stream: '', pops: 5, pushes: false, list: true },
  0x64: { name: 'setBlastObjectWindow', stream: '', pops: 4, pushes: false },
  0x97: { name: 'setObjectName', stream: '', pops: 1, pushes: false, string: true },
  0xa0: { name: 'findObject', stream: '', pops: 2, pushes: true, fold: call('findObject') },
  0x8f: {
    name: 'getObjectOldDir',
    stream: '',
    pops: 1,
    pushes: true,
    fold: call('getObjectOldDir'),
  },
  0xed: {
    name: 'getObjectNewDir',
    stream: '',
    pops: 1,
    pushes: true,
    fold: call('getObjectNewDir'),
  },

  // Actors.
  0x7d: { name: 'walkActorToObj', stream: '', pops: 3, pushes: false },
  0x80: { name: 'putActorAtObject', stream: '', pops: 3, pushes: false },
  0x8a: { name: 'getActorMoving', stream: '', pops: 1, pushes: true, fold: call('getActorMoving') },
  0x90: {
    name: 'getActorWalkBox',
    stream: '',
    pops: 1,
    pushes: true,
    fold: call('getActorWalkBox'),
  },
  0x91: {
    name: 'getActorCostume',
    stream: '',
    pops: 1,
    pushes: true,
    fold: call('getActorCostume'),
  },
  0xa2: {
    name: 'getActorElevation',
    stream: '',
    pops: 1,
    pushes: true,
    fold: call('getActorElevation'),
  },
  0xa8: { name: 'getActorWidth', stream: '', pops: 1, pushes: true, fold: call('getActorWidth') },
  0xaa: { name: 'getActorScaleX', stream: '', pops: 1, pushes: true, fold: call('getActorScaleX') },
  0xab: {
    name: 'getActorAnimCounter',
    stream: '',
    pops: 1,
    pushes: true,
    fold: call('getActorAnimCounter'),
  },
  0xec: { name: 'getActorLayer', stream: '', pops: 1, pushes: true, fold: call('getActorLayer') },
  0x9f: { name: 'getActorFromXY', stream: '', pops: 2, pushes: true, fold: call('getActorFromXY') },
  0xaf: { name: 'isActorInBox', stream: '', pops: 2, pushes: true, fold: call('isActorInBox') },
  0xd2: {
    name: 'getAnimateVariable',
    stream: '',
    pops: 2,
    pushes: true,
    fold: call('getAnimateVariable'),
  },
  0xd1: { name: 'stopTalking', stream: '', pops: 0, pushes: false },

  // Verbs.
  0x94: { name: 'getVerbFromXY', stream: '', pops: 2, pushes: true, fold: call('getVerbFromXY') },
  0xa3: {
    name: 'getVerbEntrypoint',
    stream: '',
    pops: 2,
    pushes: true,
    fold: call('getVerbEntrypoint'),
  },
  // The range and the save id come off the stack before the sub-opcode byte is
  // read, so from the stream's side this is one byte and three pops.
  0xa5: { name: 'saveRestoreVerbs', stream: 'b', pops: 3, pushes: false },

  // Boxes and rooms.
  // The flag value is popped before the list, which is the other way round
  // from every other list-taking instruction here.
  0x99: {
    name: 'setBoxFlags',
    stream: '',
    pops: 1,
    pushes: false,
    list: true,
    popsBeforeList: true,
  },
  0x9a: { name: 'createBoxMatrix', stream: '', pops: 0, pushes: false },
  0xe4: { name: 'setBoxSet', stream: '', pops: 1, pushes: false },
  0xa1: { name: 'pseudoRoom', stream: '', pops: 1, pushes: false, list: true },
  0xa6: { name: 'drawBox', stream: '', pops: 5, pushes: false, fold: call('drawBox') },

  // Talking, which carries its line in the code stream.
  0xba: { name: 'talkActor', stream: '', pops: 1, pushes: false, string: true },
  0xbb: { name: 'talkEgo', stream: '', pops: 0, pushes: false, string: true },

  // Distances, the clock, and the kernel hatch.
  0xc5: {
    name: 'distObjectObject',
    stream: '',
    pops: 2,
    pushes: true,
    fold: call('distObjectObject'),
  },
  0xc6: { name: 'distObjectPt', stream: '', pops: 3, pushes: true, fold: call('distObjectPt') },
  0xc7: { name: 'distPtPt', stream: '', pops: 4, pushes: true, fold: call('distPtPt') },
  0xd0: { name: 'getDateTime', stream: '', pops: 0, pushes: false },
  0xc8: { name: 'kernelGetFunctions', stream: '', pops: 0, pushes: true, list: true },
  0xc9: { name: 'kernelSetFunctions', stream: '', pops: 0, pushes: false, list: true },
  0xe1: { name: 'getPixel', stream: '', pops: 2, pushes: true, fold: call('getPixel') },

  // Scripts.
  0xd5: { name: 'jumpToScript', stream: '', pops: 2, pushes: false, list: true },
  0xd8: {
    name: 'isRoomScriptRunning',
    stream: '',
    pops: 1,
    pushes: true,
    fold: call('isRoomScriptRunning'),
  },
};

/**
 * One form of an instruction that carries a sub-opcode byte.
 *
 * `actorOps`, `verbOps`, `roomOps` and the rest are really families of
 * instructions sharing an opcode: the byte after it selects which member is
 * being run, and each member takes its own operands. So the *length* of one of
 * these depends on the sub-opcode, and so does how many stack values it
 * consumes — which is what the folded listing needs to pair expressions up
 * correctly.
 */
interface SubForm {
  name: string;
  /** Values taken off the stack. */
  pops?: number;
  /** A counted list off the stack, on top of `pops`. */
  list?: boolean;
  /**
   * What it takes off the stack, in order from the top, when `pops` and `list`
   * cannot say it.
   *
   * Two of `arrayOps`'s forms need this: they take a fixed operand, *then* a
   * counted list, *then* another fixed operand, which no combination of the two
   * fields above describes. Getting the order wrong pairs the wrong expression
   * with the wrong operand in the listing.
   */
  stack?: Array<number | 'list'>;
  /** An extra operand in the code stream after the sub-opcode byte. */
  stream?: 'w' | 'j';
  /** True when an inline NUL-terminated message follows. */
  string?: boolean;
  /** True when it leaves a value on the stack. */
  pushes?: boolean;
}

interface SubOpcodeShape {
  name: string;
  forms: Record<number, SubForm>;
}

/** `{name, pops}` for the many forms that take operands and nothing else. */
const f = (name: string, pops = 0, extra: Omit<SubForm, 'name' | 'pops'> = {}): SubForm => ({
  name,
  pops,
  ...extra,
});

/**
 * The sub-opcode instructions, by opcode.
 *
 * A sub-opcode absent from a family is one whose layout is not established, and
 * reading stops at it — the same rule as an unknown opcode, for the same
 * reason. `roomOps`'s string forms (184 and 185) are the notable absences: they
 * are unimplemented in the original too, and their operand counts have never
 * been established.
 */
const SUB_SHAPES: Record<number, SubOpcodeShape> = {
  0x9d: {
    name: 'actorOps',
    forms: {
      76: f('costume', 1),
      77: f('stepDist', 2),
      78: f('sound', 0, { list: true }),
      79: f('walkAnimation', 1),
      80: f('talkAnimation', 2),
      81: f('standAnimation', 1),
      82: f('animation', 3),
      83: f('default'),
      84: f('elevation', 1),
      85: f('animationDefault'),
      86: f('palette', 2),
      87: f('talkColor', 1),
      88: f('name', 0, { string: true }),
      89: f('initAnimation', 1),
      91: f('width', 1),
      92: f('scale', 1),
      93: f('neverZClip'),
      94: f('alwaysZClip', 1),
      95: f('ignoreBoxes'),
      96: f('followBoxes'),
      97: f('animationSpeed', 1),
      98: f('shadow', 1),
      99: f('textOffset', 2),
      197: f('setCurrentActor', 1),
      198: f('setVariable', 2),
      215: f('ignoreTurnsOn'),
      216: f('ignoreTurnsOff'),
      217: f('new'),
      227: f('depth', 1),
      228: f('walkScript', 1),
      229: f('stop'),
      230: f('face', 1),
      231: f('turn', 1),
      233: f('walkPause'),
      234: f('walkResume'),
      235: f('talkScript', 1),
    },
  },
  0x9e: {
    name: 'verbOps',
    forms: {
      124: f('image', 1),
      125: f('name', 0, { string: true }),
      126: f('color', 1),
      127: f('hiColor', 1),
      128: f('at', 2),
      129: f('on'),
      130: f('off'),
      131: f('delete'),
      132: f('new'),
      133: f('dimColor', 1),
      134: f('dim'),
      135: f('key', 1),
      136: f('center'),
      137: f('nameFromString', 1),
      139: f('imageInRoom', 2),
      140: f('backColor', 1),
      196: f('setCurrentVerb', 1),
      255: f('end'),
    },
  },
  0x9c: {
    name: 'roomOps',
    forms: {
      172: f('scroll', 2),
      174: f('screen', 2),
      175: f('palette', 4),
      176: f('shakeOn'),
      177: f('shakeOff'),
      179: f('intensity', 3),
      180: f('saveGame', 2),
      181: f('fade', 1),
      182: f('rgbIntensity', 5),
      183: f('shadow', 5),
      186: f('transform', 4),
      187: f('cycleSpeed', 2),
      213: f('newPalette', 1),
    },
  },
  0x9b: {
    name: 'resourceRoutines',
    forms: {
      100: f('loadScript', 1),
      101: f('loadSound', 1),
      102: f('loadCostume', 1),
      103: f('loadRoom', 1),
      104: f('nukeScript', 1),
      105: f('nukeSound', 1),
      106: f('nukeCostume', 1),
      107: f('nukeRoom', 1),
      108: f('lockScript', 1),
      109: f('lockSound', 1),
      110: f('lockCostume', 1),
      111: f('lockRoom', 1),
      112: f('unlockScript', 1),
      113: f('unlockSound', 1),
      114: f('unlockCostume', 1),
      115: f('unlockRoom', 1),
      116: f('clearHeap'),
      117: f('loadCharset', 1),
      118: f('nukeCharset', 1),
      119: f('loadObject', 2),
    },
  },
  0x6b: {
    name: 'cursorCommand',
    forms: {
      144: f('cursorOn'),
      145: f('cursorOff'),
      146: f('userPutOn'),
      147: f('userPutOff'),
      148: f('cursorSoftOn'),
      149: f('cursorSoftOff'),
      150: f('userPutSoftOn'),
      151: f('userPutSoftOff'),
      153: f('image', 2),
      154: f('hotspot', 2),
      156: f('charset', 1),
      157: f('charsetColor', 0, { list: true }),
      214: f('transparent', 1),
    },
  },
  0xae: {
    name: 'systemOps',
    forms: { 158: f('restart'), 159: f('pause'), 160: f('quit') },
  },
  0xa9: {
    name: 'wait',
    forms: {
      // The three actor forms carry the offset to resume at; the rest rewind to
      // the instruction itself and so need no operand in the stream.
      168: f('forActor', 1, { stream: 'j' }),
      169: f('forMessage'),
      170: f('forCamera'),
      171: f('forSentence'),
      226: f('forAnimation', 1, { stream: 'j' }),
      232: f('forTurn', 1, { stream: 'j' }),
    },
  },
  0xa4: {
    name: 'arrayOps',
    forms: {
      205: f('assignString', 1, { stream: 'w', string: true }),
      // The index to start at is on top, and the values are below the count
      // that says how many of them there are — so the list is not on top, the
      // way it is in every other list-taking instruction.
      208: f('assignIntList', 0, { stream: 'w', stack: [1, 'list'] }),
      // And here the row is below the list as well.
      212: f('assign2DimList', 0, { stream: 'w', stack: [1, 'list', 1] }),
    },
  },
  0xbc: {
    name: 'dimArray',
    forms: {
      199: f('int', 1, { stream: 'w' }),
      200: f('bit', 1, { stream: 'w' }),
      201: f('nibble', 1, { stream: 'w' }),
      202: f('byte', 1, { stream: 'w' }),
      203: f('string', 1, { stream: 'w' }),
      204: f('undim', 0, { stream: 'w' }),
    },
  },
  0xc0: {
    name: 'dim2dimArray',
    forms: {
      199: f('int', 2, { stream: 'w' }),
      200: f('bit', 2, { stream: 'w' }),
      201: f('nibble', 2, { stream: 'w' }),
      202: f('byte', 2, { stream: 'w' }),
      203: f('string', 2, { stream: 'w' }),
    },
  },
};

/**
 * The `print` family's sub-opcodes, shared by all six instructions.
 *
 * One difference between them, and it is in the stack: `printActor` pops the
 * actor to speak for at `begin`, and the others do not. `printEgo` looks like
 * it should too, but pushes the actor itself, so from the script's side its
 * `begin` takes nothing.
 */
const PRINT_FORMS: Record<number, SubForm> = {
  65: f('at', 2),
  66: f('color', 1),
  67: f('clipped', 1),
  69: f('center'),
  71: f('left'),
  72: f('overhead'),
  74: f('mumble'),
  75: f('text', 0, { string: true }),
  254: f('begin'),
  255: f('end'),
};

const PRINT_INSTRUCTIONS: Record<number, string> = {
  0xb4: 'printLine',
  0xb5: 'printText',
  0xb6: 'printDebug',
  0xb7: 'printSystem',
  0xb8: 'printActor',
  0xb9: 'printEgo',
};

for (const [opcode, name] of Object.entries(PRINT_INSTRUCTIONS)) {
  const forms: Record<number, SubForm> = { ...PRINT_FORMS };
  if (Number(opcode) === 0xb8) forms[254] = f('begin', 1);
  SUB_SHAPES[Number(opcode)] = { name, forms };
}

/**
 * An inline message as something readable, without pretending to decode it.
 *
 * The engine substitutes variables, actor names and speech offsets into a
 * message at the moment it says it; a listing cannot, and should not guess. So
 * printable runs are shown as text and everything else as the control code it
 * is — enough to recognise the line, never enough to mistake for the text the
 * player will see.
 */
function renderMessage(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    const byte = bytes[i];
    if (byte === 0xff || byte === 0xfe) {
      const control = bytes[i + 1];
      out += `\\x${control?.toString(16).padStart(2, '0') ?? '??'}`;
      i += control === 1 || control === 2 || control === 3 || control === 8 ? 1 : 3;
      continue;
    }
    out += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.';
  }
  return `"${out}"`;
}

/**
 * What a form takes off the stack, from the top.
 *
 * The list comes off before the fixed operands unless the form says otherwise,
 * which is the order every family but `arrayOps` uses.
 */
function stackOrder(form: SubForm): Array<number | 'list'> {
  if (form.stack) return form.stack;
  const order: Array<number | 'list'> = [];
  if (form.list) order.push('list');
  if (form.pops) order.push(form.pops);
  return order;
}

/** One sub-opcode form, flattened, for cross-checking against the interpreter. */
export interface V6SubOpcodeForm {
  opcode: number;
  subOpcode: number;
  /** `actorOps.elevation`, as the listing shows it. */
  name: string;
  /** What it takes off the stack, in order from the top. */
  stack: Array<number | 'list'>;
  /** An operand in the code stream after the sub-opcode byte, if any. */
  stream?: 'w' | 'j';
  /** True when an inline message follows. */
  string: boolean;
}

/**
 * Every sub-opcode form this reader knows, flattened.
 *
 * Exported so a test can drive the *interpreter* from the reader's table and
 * catch the two disagreeing. They were written from the same reference but
 * separately, and the way they can drift is the way that hurts most: one of
 * them consuming an operand the other leaves on the stack, which shows up as a
 * fault in whatever instruction comes next.
 */
export function v6SubOpcodeForms(): V6SubOpcodeForm[] {
  const forms: V6SubOpcodeForm[] = [];
  for (const [opcode, family] of Object.entries(SUB_SHAPES)) {
    for (const [subOpcode, form] of Object.entries(family.forms)) {
      forms.push({
        opcode: Number(opcode),
        subOpcode: Number(subOpcode),
        name: `${family.name}.${form.name}`,
        stack: stackOrder(form),
        ...(form.stream ? { stream: form.stream } : {}),
        string: form.string ?? false,
      });
    }
  }
  return forms;
}

export interface V6Instruction {
  /** Offset within the script. */
  offset: number;
  /** Total bytes, so a caller can walk or re-emit without re-decoding. */
  length: number;
  opcode: number;
  name: string;
  /** The operand read from the code stream, if the instruction has one. */
  streamOperand?: number;
  /** Jump destination, for `jump`, `if` and `ifNot`. */
  target?: number;
  /**
   * Bytes of this instruction that are carried through verbatim.
   *
   * A sub-opcode byte, an inline message, or the operand a sub-opcode form
   * carries — everything past the fixed operand `streamOperand` holds. Kept as
   * raw bytes rather than decoded fields because that is what makes re-emission
   * exact: an instruction nobody edited comes back out as the bytes it went in
   * as, whatever it is.
   */
  tail?: number[];
  /** `var250 = 7`, with the pushes folded in. Ready to show. */
  text: string;
}

export interface V6Listing {
  instructions: V6Instruction[];
  /** Where reading stopped, if it did. */
  undecodedFrom: number | null;
  /** Why it stopped, for the note beside the preserved bytes. */
  reason: string | null;
}

/**
 * Decodes a v6 script.
 *
 * One pass produces both readings. The folded text comes from running a stack
 * of *strings* alongside the decode: a push contributes its own text, and an
 * instruction that consumes operands takes their text back off. When the stack
 * does not hold what an instruction wants — the script pushed it before an
 * instruction this reader stopped at, or the count of a list is not a constant
 * — the operand is rendered as `…` rather than invented.
 */
/**
 * How an inline message is measured, which is the only thing v6 and v7 disagree
 * about here.
 *
 * v7 shares v6's opcode numbering entirely — ScummVM gives it no table of its
 * own — so a second disassembler would be a second copy of eleven hundred lines
 * whose every folding fix would have to be found twice. The seam is the one
 * place the two encodings differ.
 */
type MeasureMessage = (code: Uint8Array, at: number) => number | null;

/**
 * Decodes a v7 script.
 *
 * The same walk, table and folding as v6, with v7's message measurement. ADR
 * 0005's load-bearing property carries over unchanged: v7 is a stack machine,
 * so every instruction boundary is measurable, and decode-then-re-emit gives
 * back the same bytes.
 *
 * What a v7 listing *shows* still differs, because a v7 string is a `/TAG/`
 * reference into a language bundle rather than the words. Resolving those for
 * display is #112's; this reads the bytes.
 */
export function disassembleV7(code: Uint8Array): V6Listing {
  return disassembleStack(code, measureV7Message);
}

export function disassembleV6(code: Uint8Array): V6Listing {
  return disassembleStack(code, measureV6Message);
}

/**
 * How wide a code-stream word is.
 *
 * Two for v6 and v7 and four for v8, whose `fetchScriptWord` returns
 * `fetchScriptDWord`. It reaches every pushed constant, variable number, array
 * handle and jump displacement in the encoding, which is why it is a parameter
 * of the walk rather than a constant inside it.
 */
type WordBytes = 2 | 4;

function disassembleStack(
  code: Uint8Array,
  measureMessage: MeasureMessage,
  wordBytes: WordBytes = 2,
  shapes: Record<number, Shape> = SHAPES,
  subShapes: Record<number, SubOpcodeShape> = SUB_SHAPES,
): V6Listing {
  /** A word at this Version's width, and its signed reading. */
  const readWord = (at: number): number => {
    let value = 0;
    for (let i = 0; i < wordBytes; i++) value |= code[at + i] << (8 * i);
    return wordBytes === 2 ? value & 0xffff : value >>> 0;
  };
  const signWord = (raw: number): number =>
    wordBytes === 2 ? (raw & 0x8000 ? raw - 0x10000 : raw) : raw | 0;

  const instructions: V6Instruction[] = [];
  const expressions: string[] = [];
  let at = 0;

  const takeOperands = (count: number): string[] => {
    const operands: string[] = [];
    for (let i = 0; i < count; i++) operands.unshift(expressions.pop() ?? '…');
    return operands;
  };

  /** The counted list on top of the stack, or `[…]` when its depth is not known. */
  const takeList = (): string => {
    const countText = expressions.pop() ?? '…';
    const count = Number(countText);
    if (Number.isInteger(count) && count >= 0 && count <= expressions.length) {
      return `[${takeOperands(count).join(', ')}]`;
    }
    return '[…]';
  };

  const stop = (from: number, reason: string): V6Listing => ({
    instructions,
    undecodedFrom: from,
    reason,
  });

  while (at < code.length) {
    const opcode = code[at];
    const shape = shapes[opcode];
    const family = subShapes[opcode];

    if (!shape && !family) {
      return stop(
        at,
        `opcode 0x${opcode.toString(16).padStart(2, '0')} has no known layout, so the ` +
          `length of this instruction is unknown and everything after it would be a guess`,
      );
    }

    if (family) {
      if (at + 1 >= code.length) break;
      const subOpcode = code[at + 1];
      const form = family.forms[subOpcode];

      if (!form) {
        return stop(
          at,
          `${family.name} sub-opcode ${subOpcode} has no known layout, so this ` +
            `instruction's length is unknown and everything after it would be a guess`,
        );
      }

      let length = 2;
      let streamText = '';
      let target: number | undefined;

      if (form.stream === 'w' || form.stream === 'j') {
        if (at + length + wordBytes - 1 >= code.length) break;
        const raw = readWord(at + length);
        length += wordBytes;
        if (form.stream === 'j') {
          const displacement = signWord(raw);
          target = at + length + displacement;
          streamText = `-> ${target}`;
        } else {
          streamText = String(raw);
        }
      }

      let messageText = '';
      if (form.string) {
        const measured = measureMessage(code, at + length);
        if (measured === null) {
          return stop(
            at,
            `the message inside this ${family.name} instruction has no terminator before ` +
              `the end of the script, so where it ends cannot be established`,
          );
        }
        messageText = renderMessage(code.subarray(at + length, at + length + measured - 1));
        length += measured;
      }

      // Consumed from the top down, then reversed, so the listing shows the
      // operands in the order the script pushed them.
      const consumed: string[] = [];
      for (const step of stackOrder(form)) {
        if (step === 'list') consumed.push(takeList());
        else consumed.push(...takeOperands(step).reverse());
      }
      consumed.reverse();

      const parts = [...consumed];
      if (messageText) parts.push(messageText);
      if (streamText) parts.push(streamText);
      const text = `${family.name}.${form.name}(${parts.join(', ')})`;

      if (form.pushes) expressions.push(text);

      instructions.push({
        offset: at,
        length,
        opcode,
        name: `${family.name}.${form.name}`,
        ...(target !== undefined ? { target } : {}),
        tail: Array.from(code.subarray(at + 1, at + length)),
        text,
      });

      at += length;
      continue;
    }

    const operandAt = at + 1;
    let length = 1;
    let streamOperand: number | undefined;
    let target: number | undefined;
    let arrayTail: number[] | undefined;

    if (shape.stream === 'b' || shape.stream === 'bx') {
      if (operandAt >= code.length) break;
      streamOperand = code[operandAt];
      length = 2;
    } else if (shape.stream === 'bw') {
      // A sub-opcode byte and then a word: v8's array instructions, which name
      // their array in the code stream rather than taking it off the stack.
      // The word rides in the tail rather than being offered as an operand,
      // because changing which array an instruction writes to is not an edit
      // to *this* instruction — it is an edit to the array declaration.
      if (operandAt + wordBytes >= code.length) break;
      streamOperand = code[operandAt];
      length = 2 + wordBytes;
      arrayTail = Array.from(code.subarray(operandAt + 1, operandAt + 1 + wordBytes));
    } else if (shape.stream === 'w' || shape.stream === 'j') {
      if (operandAt + wordBytes - 1 >= code.length) break;
      const raw = readWord(operandAt);
      length = 1 + wordBytes;
      if (shape.stream === 'j') {
        const displacement = signWord(raw);
        streamOperand = displacement;
        target = at + length + displacement;
      } else {
        streamOperand = raw;
      }
    }

    let messageText = '';
    let tail: number[] | undefined;
    if (shape.string) {
      const measured = measureMessage(code, at + length);
      if (measured === null) {
        return stop(
          at,
          `the message inside this ${shape.name} instruction has no terminator before the ` +
            `end of the script, so where it ends cannot be established`,
        );
      }
      messageText = renderMessage(code.subarray(at + length, at + length + measured - 1));
      tail = Array.from(code.subarray(at + length, at + length + measured));
      length += measured;
    }

    // A counted list's depth is the top of the stack, which is only a constant
    // when the script pushed a literal — which it usually did.
    let listText: string | null;
    let operands: string[];
    if (shape.popsBeforeList) {
      operands = takeOperands(shape.pops);
      listText = shape.list ? takeList() : null;
    } else {
      listText = shape.list ? takeList() : null;
      operands = takeOperands(shape.pops);
    }

    const streamText = streamOperand === undefined ? '' : String(streamOperand);

    let text: string;
    if (shape.fold) {
      text = shape.fold(operands, streamText);
    } else {
      const parts = [...operands];
      if (listText) parts.push(listText);
      if (messageText) parts.push(messageText);
      if (target !== undefined) parts.push(`-> ${target}`);
      else if (streamText) parts.push(streamText);
      text = parts.length > 0 ? `${shape.name} ${parts.join(', ')}` : shape.name;
    }

    if (shape.pushes) expressions.push(text.length > 0 ? text : shape.name);

    instructions.push({
      offset: at,
      length,
      opcode,
      name: shape.name,
      ...(streamOperand !== undefined ? { streamOperand } : {}),
      ...(target !== undefined ? { target } : {}),
      ...((tail ?? arrayTail) ? { tail: tail ?? arrayTail } : {}),
      text,
    });

    at += length;
  }

  return { instructions, undecodedFrom: null, reason: null };
}

/** The listing as text, offsets down the left, in the v5 reader's shape. */
export function formatV6Listing(listing: V6Listing, code: Uint8Array): string {
  const lines = listing.instructions
    // An instruction that leaves a value on the stack is an operand of a later
    // one, and its text is already folded into that one. Printing it again on
    // its own line would say the same thing twice.
    .filter((instruction) => !SHAPES[instruction.opcode]?.pushes)
    .map((instruction) => `${instruction.offset.toString().padStart(5)}  ${instruction.text}`);

  if (listing.undecodedFrom !== null) {
    const rest = code.subarray(listing.undecodedFrom);
    lines.push(`${listing.undecodedFrom.toString().padStart(5)}  ; ${listing.reason}`);
    lines.push(`${' '.repeat(5)}  ; ${rest.length} bytes follow, kept exactly as they were`);
    for (let i = 0; i < rest.length; i += 16) {
      const row = Array.from(rest.subarray(i, i + 16), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join(' ');
      lines.push(`${(listing.undecodedFrom + i).toString().padStart(5)}  ${row}`);
    }
  }

  return lines.join('\n');
}

/**
 * Re-emits a decoded script.
 *
 * The property that makes instruction-level editing safe: a script decoded and
 * re-emitted untouched is byte-identical, because every instruction carries its
 * own length and the decoder never guessed one.
 *
 * Shared by v6 and v7 rather than duplicated, and not because they happen to
 * agree: this walks the listing's own recorded opcodes, operands and tails, so
 * it does not know or need to know which encoding produced them. A v7 listing
 * re-emits through it unchanged — see `assembleV7`.
 */
export function assembleV6(listing: V6Listing, original: Uint8Array): Uint8Array {
  return assembleStack(listing, original, 2, SHAPES);
}

/**
 * The emitter both widths share.
 *
 * Walks the listing's own recorded opcodes, operands and tails, so it does not
 * know or need to know which encoding produced them — only how wide a stream
 * word is, which is the one thing v8 changed.
 */
function assembleStack(
  listing: V6Listing,
  original: Uint8Array,
  wordBytes: WordBytes,
  shapes: Record<number, Shape>,
): Uint8Array {
  const out: number[] = [];

  const pushWord = (value: number): void => {
    for (let i = 0; i < wordBytes; i++) out.push((value >> (8 * i)) & 0xff);
  };

  for (const instruction of listing.instructions) {
    out.push(instruction.opcode);

    const shape = shapes[instruction.opcode];
    if (!shape) {
      // A sub-opcode instruction: every byte past the opcode is in its tail,
      // which is exactly why it re-emits byte for byte.
      if (instruction.tail) out.push(...instruction.tail);
      continue;
    }

    if (shape.stream === 'b' || shape.stream === 'bx') {
      out.push((instruction.streamOperand ?? 0) & 0xff);
    } else if (shape.stream === 'bw') {
      // A sub-opcode byte and then a word. Only the byte is offered as the
      // stream operand; the word rides in the tail, untouched.
      out.push((instruction.streamOperand ?? 0) & 0xff);
    } else if (shape.stream === 'w' || shape.stream === 'j') {
      pushWord(instruction.streamOperand ?? 0);
    }

    if (instruction.tail) out.push(...instruction.tail);
  }

  // Anything the reader stopped at is carried through exactly as it arrived.
  if (listing.undecodedFrom !== null) {
    out.push(...original.subarray(listing.undecodedFrom));
  }

  return new Uint8Array(out);
}

/**
 * Re-emits a decoded v7 script.
 *
 * The same function under a name that says so, because a caller holding a v7
 * listing should not have to know that the emitter is version-agnostic to
 * believe it is correct.
 */
export const assembleV7 = assembleV6;

// ------------------------------------------------------------------- v8 ----

/**
 * v8 opcode -> the v6 opcode running the same instruction.
 *
 * The same correspondence `script/v8/ScriptEngine.ts` installs, and it is here
 * as a second copy on purpose: a reader and a runner that disagree about which
 * instruction a byte is would produce an edit that re-emits as something else,
 * which is the one failure the whole editing model exists to prevent. Two
 * copies of a table can be diffed; one copy shared between a reader and a
 * runner cannot be checked against anything.
 *
 * Derived from ScummVM's `ScummEngine_v6::setupOpcodes` and
 * `ScummEngine_v8::setupOpcodes` by matching handler names.
 */
const V8_FROM_V6: ReadonlyArray<readonly [v8: number, v6: number]> = [
  [0x01, 0x01],
  [0x02, 0x03],
  [0x03, 0x07],
  [0x04, 0x0b],
  [0x05, 0x0c],
  [0x06, 0x1a],
  [0x07, 0x0d],
  [0x08, 0x0e],
  [0x09, 0x0f],
  [0x0a, 0x10],
  [0x0b, 0x11],
  [0x0c, 0x12],
  [0x0d, 0x13],
  [0x0e, 0x14],
  [0x0f, 0x15],
  [0x10, 0x16],
  [0x11, 0x17],
  [0x12, 0x18],
  [0x13, 0x19],
  [0x14, 0xd6],
  [0x15, 0xd7],
  [0x64, 0x5c],
  [0x65, 0x5d],
  [0x66, 0x73],
  [0x67, 0x6c],
  [0x68, 0xca],
  [0x6a, 0xb0],
  [0x6b, 0xb1],
  [0x6c, 0xb2],
  [0x6d, 0x43],
  [0x6e, 0x4f],
  [0x6f, 0x57],
  [0x71, 0x47],
  [0x72, 0x53],
  [0x73, 0x5b],
  [0x75, 0x4b],
  [0x79, 0x5e],
  [0x7a, 0x5f],
  [0x7b, 0x65],
  [0x7c, 0x7c],
  [0x7d, 0xd5],
  [0x7e, 0xbd],
  [0x7f, 0x60],
  [0x80, 0x77],
  [0x81, 0x68],
  [0x82, 0x67],
  [0x83, 0x6a],
  [0x84, 0x95],
  [0x85, 0x96],
  [0x86, 0xb3],
  [0x89, 0x6e],
  [0x8a, 0x70],
  [0x8b, 0x71],
  [0x8c, 0x78],
  [0x8d, 0x79],
  [0x8e, 0x7a],
  [0x8f, 0xb8],
  [0x90, 0xb9],
  [0x91, 0xba],
  [0x92, 0xbb],
  [0x93, 0xb4],
  [0x94, 0xb5],
  [0x95, 0xb6],
  [0x96, 0xb7],
  [0x9d, 0x7b],
  [0x9e, 0x85],
  [0x9f, 0x7d],
  [0xa0, 0x7e],
  [0xa1, 0x7f],
  [0xa2, 0x80],
  [0xa3, 0x81],
  [0xa4, 0x82],
  [0xa5, 0x83],
  [0xa6, 0x84],
  [0xa7, 0x99],
  [0xa8, 0x9a],
  [0xaf, 0x74],
  [0xb0, 0x76],
  [0xb1, 0x75],
  [0xb2, 0xac],
  [0xb4, 0xa5],
  [0xb5, 0x97],
  [0xb6, 0xd0],
  [0xb7, 0xa6],
  [0xc8, 0xbf],
  [0xc9, 0xbe],
  [0xca, 0xcb],
  [0xcb, 0xcc],
  [0xcd, 0xad],
  [0xce, 0x87],
  [0xcf, 0x88],
  [0xd0, 0x6d],
  [0xd1, 0x6f],
  [0xd2, 0x72],
  [0xd3, 0x8b],
  [0xd5, 0x98],
  [0xd6, 0xc4],
  [0xd9, 0xaf],
  [0xda, 0xa3],
  [0xdb, 0x9f],
  [0xdc, 0xa0],
  [0xdd, 0x94],
  [0xdf, 0x92],
  [0xe0, 0x93],
  [0xe1, 0xd2],
  [0xe2, 0x8c],
  [0xe3, 0x90],
  [0xe4, 0x8a],
  [0xe5, 0x91],
  [0xe6, 0xaa],
  [0xe7, 0xec],
  [0xe8, 0xa2],
  [0xe9, 0xa8],
  [0xea, 0xed],
  [0xeb, 0x8d],
  [0xec, 0x8e],
  [0xee, 0xc5],
  [0xef, 0xc7],
];

/**
 * v8's own two dozen, measured but not folded.
 *
 * Fifteen are sub-opcode dispatchers whose sub-tables are v8's; they read a
 * sub-opcode byte and, for the three array forms, an array number as well.
 * That is enough to *measure* them, which is all a reader has to do to keep
 * every instruction after them in the right place — and a stack machine is
 * what makes that true, because an instruction's length follows from its
 * opcode alone.
 */
const V8_OWN_SHAPES: Record<number, Shape> = {
  0x16: { name: 'mod', stream: '', pops: 2, pushes: true },
  // `wait`'s three actor forms carry a jump displacement and the other three
  // do not, which is a length that depends on the sub-opcode — the one place
  // in the Stack encoding where that is true, and the reason it has a family
  // of its own below rather than a fixed shape here.
  0x69: { name: 'wait', stream: 'bx', pops: 0, pushes: false },
  0x70: { name: 'dimArray', stream: 'bw', pops: 1, pushes: false },
  0x74: { name: 'dim2dimArray', stream: 'bw', pops: 2, pushes: false },
  0x76: { name: 'arrayOps', stream: 'bw', pops: 1, pushes: false },
  0x97: { name: 'blastText', stream: 'bx', pops: 0, pushes: false },
  0x98: { name: 'drawObject', stream: '', pops: 2, pushes: false },
  0x9c: { name: 'cursorCommand', stream: 'bx', pops: 0, pushes: false },
  0xaa: { name: 'resourceRoutines', stream: 'bx', pops: 0, pushes: false },
  0xab: { name: 'roomOps', stream: 'bx', pops: 0, pushes: false },
  0xac: { name: 'actorOps', stream: 'bx', pops: 0, pushes: false },
  0xad: { name: 'cameraOps', stream: 'bx', pops: 0, pushes: false },
  0xae: { name: 'verbOps', stream: 'bx', pops: 0, pushes: false },
  0xb3: { name: 'systemOps', stream: 'bx', pops: 0, pushes: false },
  0xb9: { name: 'startVideo', stream: 'bx', pops: 0, pushes: false },
  0xba: { name: 'kernelSetFunctions', stream: 'bx', pops: 0, pushes: false },
  0xd8: { name: 'kernelGetFunctions', stream: 'bx', pops: 0, pushes: true },
  0xed: { name: 'getActorChore', stream: '', pops: 1, pushes: true },
  0xf0: { name: 'getObjectImageX', stream: '', pops: 1, pushes: true },
  0xf1: { name: 'getObjectImageY', stream: '', pops: 1, pushes: true },
  0xf2: { name: 'getObjectImageWidth', stream: '', pops: 1, pushes: true },
  0xf3: { name: 'getObjectImageHeight', stream: '', pops: 1, pushes: true },
  0xf6: { name: 'getStringWidth', stream: '', pops: 3, pushes: true },
  0xf7: { name: 'getActorZPlane', stream: '', pops: 1, pushes: true },
};

/** v6's shapes at v8's numbers, plus v8's own. Built once. */
const V8_SHAPES: Record<number, Shape> = (() => {
  const table: Record<number, Shape> = {};
  for (const [v8Code, v6Code] of V8_FROM_V6) {
    const shape = SHAPES[v6Code];
    if (shape) table[v8Code] = shape;
  }
  return { ...table, ...V8_OWN_SHAPES };
})();

/**
 * v6's sub-opcode families at v8's numbers.
 *
 * Almost empty, and that is the honest answer rather than an oversight: v8
 * renumbered the sub-tables of its dispatchers as thoroughly as it renumbered
 * the instructions, so a v6 family carried across by opcode number would name
 * forms v8 does not have. The dispatchers are in `V8_OWN_SHAPES` instead,
 * where they are measured and not interpreted.
 */
const V8_SUB_SHAPES: Record<number, SubOpcodeShape> = {};

/**
 * Decodes a v8 script.
 *
 * The same walk as v6 and v7, with two parameters changed: a code-stream word
 * is four bytes, and the opcode table is v6's at v8's numbers. ADR 0005's
 * load-bearing property carries over unchanged — v8 is a stack machine, so
 * every instruction boundary is measurable and decode-then-re-emit gives back
 * the same bytes.
 *
 * What a v8 listing does *not* show is the inside of its own dispatchers. They
 * are measured, so nothing after them is wrong; they are not folded, so a row
 * reads `actorOps 13` rather than naming the form. Editing one is refused by
 * the absence of a field rather than by a warning.
 */
export function disassembleV8(code: Uint8Array): V6Listing {
  return disassembleStack(code, measureV6Message, 4, V8_SHAPES, V8_SUB_SHAPES);
}

/**
 * Re-emits a decoded v8 script.
 *
 * A separate entry point rather than `assembleV6` under another name, because
 * unlike v7 the width genuinely differs: a stream operand is four bytes here.
 */
export function assembleV8(listing: V6Listing, original: Uint8Array): Uint8Array {
  return assembleStack(listing, original, 4, V8_SHAPES);
}
