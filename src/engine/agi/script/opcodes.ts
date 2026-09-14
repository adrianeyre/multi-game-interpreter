/**
 * AGI's instruction set, and where an instruction's length comes from.
 *
 * The important fact about AGI bytecode, and the one that shapes every file
 * that reads it: **an instruction's argument count is not in the bytecode.** It
 * comes from a table Sierra shipped in `AGIDATA.OVL`, and that table changed
 * between interpreter builds, between platforms, and for three titles by game.
 * `quit` takes no argument under 2.089 and one under everything later — both
 * AGI v2. `hide.mouse` takes one under 3.002.086 and none later — both AGI v3.
 * On Apple IIgs, `discard.sound` is not even the same opcode number.
 *
 * So there is no such thing as "the AGI opcode table". There is a table per
 * Target (`CONTEXT.md`), and this module builds one from a Target. Everything
 * that reads or writes Logic bytecode takes its table from here rather than
 * hardcoding a set, which is what makes `CONTEXT.md`'s **Disassembly** rule
 * honest for AGI: length is never measurable from the bytes, so the reader
 * stops when the Target does not name an interpreter rather than decoding on a
 * default.
 *
 * v2 and v3 share this encoding outright — ScummVM selects one 183-entry table
 * for every interpreter at or above 2.0 — so one script engine covers every
 * Target between them, with no delta (ADR 0012).
 */

import { agiMajor, type Target } from '../../../authoring/target.js';

/** What an operand means, which decides how a listing prints it. */
export type AgiOperandKind =
  /** A literal number: a resource id, a coordinate, an item. */
  | 'number'
  /** A variable index, printed `v12`. */
  | 'variable'
  /** A flag index, printed `f12`. */
  | 'flag'
  /** A message number within this Logic's own table. */
  | 'message'
  /** A string slot index, printed `s3`. */
  | 'string'
  /** A screen-object number, printed `o3`. */
  | 'object'
  /** An inventory item number. */
  | 'item'
  /** A controller (menu/key binding) number. */
  | 'controller'
  /** A word group number from `WORDS.TOK`. */
  | 'word';

export interface AgiOpcode {
  readonly code: number;
  readonly name: string;
  readonly operands: readonly AgiOperandKind[];
}

/**
 * A compact spelling of an operand list, so the tables below stay readable.
 *
 * ScummVM's own table uses `v` and `n` and warns in a comment that the letters
 * are unreliable — only the *count* matters for parsing. That warning is about
 * ScummVM's table, which was transcribed for length rather than for meaning,
 * and it applies to the counts here too: a wrong letter prints a listing
 * oddly, and a wrong count misreads every boundary after it. The counts are
 * transcribed from ScummVM; the letters are the best reading available and are
 * cosmetic.
 */
const KINDS: Record<string, AgiOperandKind> = {
  n: 'number',
  v: 'variable',
  f: 'flag',
  m: 'message',
  s: 'string',
  o: 'object',
  i: 'item',
  c: 'controller',
  w: 'word',
};

function operands(spec: string): AgiOperandKind[] {
  return [...spec].map((letter) => {
    const kind = KINDS[letter];
    if (!kind) throw new Error(`Unknown operand letter "${letter}" in "${spec}"`);
    return kind;
  });
}

/**
 * The test commands: the `if` condition set.
 *
 * Twenty entries, decoded separately from the action commands because they live
 * in a different space — opcode 0x07 is `isset` inside a condition and
 * `subn` outside one.
 */
const TEST_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['', ''], // 0x00 — not an instruction; a 0 here is a malformed condition.
  ['equaln', 'vn'],
  ['equalv', 'vv'],
  ['lessn', 'vn'],
  ['lessv', 'vv'],
  ['greatern', 'vn'],
  ['greaterv', 'vv'],
  ['isset', 'f'],
  ['issetv', 'v'],
  ['has', 'i'],
  ['obj.in.room', 'iv'], // 0x0A
  ['posn', 'onnnn'],
  ['controller', 'c'],
  ['have.key', ''],
  // 0x0E — the one self-describing instruction in AGI. Its length is a count
  // byte in the stream: one byte of word count, then that many 16-bit word
  // group numbers. Recorded with no operands because its arity cannot be
  // written down, and every reader special-cases it.
  ['said', ''],
  ['compare.strings', 'ss'],
  ['obj.in.box', 'onnnn'], // 0x10
  ['center.posn', 'onnnn'],
  ['right.posn', 'onnnn'],
  ['in.motion.using.mouse', ''],
];

/** `said`, the only instruction whose length is written in the stream. */
export const SAID_OPCODE = 0x0e;

/**
 * The action commands, 183 of them, for every interpreter at or above 2.0.
 *
 * Transcribed from ScummVM's `opCodesV2`. The counts are the load-bearing part;
 * see `KINDS` on why the letters are not.
 */
const ACTION_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['return', ''], // 0x00
  ['increment', 'v'],
  ['decrement', 'v'],
  ['assignn', 'vn'],
  ['assignv', 'vv'],
  ['addn', 'vn'],
  ['addv', 'vv'],
  ['subn', 'vn'],
  ['subv', 'vv'],
  ['lindirectv', 'vv'],
  ['lindirect', 'vv'], // 0x0A
  ['lindirectn', 'vn'],
  ['set', 'f'],
  ['reset', 'f'],
  ['toggle', 'f'],
  ['set.v', 'v'],
  ['reset.v', 'v'], // 0x10
  ['toggle.v', 'v'],
  ['new.room', 'n'],
  ['new.room.v', 'v'],
  ['load.logics', 'n'],
  ['load.logics.v', 'v'],
  ['call', 'n'],
  ['call.v', 'v'],
  ['load.pic', 'v'],
  ['draw.pic', 'v'],
  ['show.pic', ''], // 0x1A
  ['discard.pic', 'v'],
  ['overlay.pic', 'v'],
  ['show.pri.screen', ''],
  ['load.view', 'n'],
  ['load.view.v', 'v'],
  ['discard.view', 'n'], // 0x20
  ['animate.obj', 'o'],
  ['unanimate.all', ''],
  ['draw', 'o'],
  ['erase', 'o'],
  ['position', 'onn'],
  ['position.v', 'ovv'],
  ['get.posn', 'ovv'],
  ['reposition', 'ovv'],
  ['set.view', 'on'],
  ['set.view.v', 'ov'], // 0x2A
  ['set.loop', 'on'],
  ['set.loop.v', 'ov'],
  ['fix.loop', 'o'],
  ['release.loop', 'o'],
  ['set.cel', 'on'],
  ['set.cel.v', 'ov'], // 0x30
  ['last.cel', 'ov'],
  ['current.cel', 'ov'],
  ['current.loop', 'ov'],
  ['current.view', 'ov'],
  ['number.of.loops', 'ov'],
  ['set.priority', 'on'],
  ['set.priority.v', 'ov'],
  ['release.priority', 'o'],
  ['get.priority', 'on'],
  ['stop.update', 'o'], // 0x3A
  ['start.update', 'o'],
  ['force.update', 'o'],
  ['ignore.horizon', 'o'],
  ['observe.horizon', 'o'],
  ['set.horizon', 'n'],
  ['object.on.water', 'o'], // 0x40
  ['object.on.land', 'o'],
  ['object.on.anything', 'o'],
  ['ignore.objs', 'o'],
  ['observe.objs', 'o'],
  ['distance', 'oov'],
  ['stop.cycling', 'o'],
  ['start.cycling', 'o'],
  ['normal.cycle', 'o'],
  ['end.of.loop', 'of'],
  ['reverse.cycle', 'o'], // 0x4A
  ['reverse.loop', 'of'],
  ['cycle.time', 'ov'],
  ['stop.motion', 'o'],
  ['start.motion', 'o'],
  ['step.size', 'ov'],
  ['step.time', 'ov'], // 0x50
  ['move.obj', 'onnnf'],
  ['move.obj.v', 'ovvvf'],
  ['follow.ego', 'onf'],
  ['wander', 'o'],
  ['normal.motion', 'o'],
  ['set.dir', 'ov'],
  ['get.dir', 'ov'],
  ['ignore.blocks', 'o'],
  ['observe.blocks', 'o'],
  ['block', 'nnnn'], // 0x5A
  ['unblock', ''],
  ['get', 'i'],
  ['get.v', 'v'],
  ['drop', 'i'],
  ['put', 'io'],
  ['put.v', 'iv'], // 0x60
  ['get.room.v', 'iv'],
  ['load.sound', 'n'],
  ['sound', 'nf'],
  ['stop.sound', ''],
  ['print', 'm'],
  ['print.v', 'v'],
  ['display', 'nnm'],
  ['display.v', 'vvv'],
  ['clear.lines', 'nnn'],
  ['text.screen', ''], // 0x6A
  ['graphics', ''],
  ['set.cursor.char', 'm'],
  ['set.text.attribute', 'nn'],
  ['shake.screen', 'n'],
  ['configure.screen', 'nnn'],
  ['status.line.on', ''], // 0x70
  ['status.line.off', ''],
  ['set.string', 'sm'],
  ['get.string', 'smnnn'],
  ['word.to.string', 'sw'],
  ['parse', 's'],
  ['get.num', 'mv'],
  ['prevent.input', ''],
  ['accept.input', ''],
  ['set.key', 'nnc'],
  ['add.to.pic', 'nnnnnnn'], // 0x7A
  ['add.to.pic.v', 'vvvvvvv'],
  ['status', ''],
  ['save.game', ''],
  ['restore.game', ''],
  ['init.disk', ''],
  ['restart.game', ''], // 0x80
  ['show.obj', 'i'],
  ['random', 'nnv'],
  ['program.control', ''],
  ['player.control', ''],
  ['obj.status.v', 'v'],
  // 0x86 — one argument under every build except exactly 2.089, which takes
  // none. Both are AGI v2 (ADR 0012).
  ['quit', 'n'],
  ['show.mem', ''],
  ['pause', ''],
  ['echo.line', ''],
  ['cancel.line', ''], // 0x8A
  ['init.joy', ''],
  ['toggle.monitor', ''],
  ['version', ''],
  ['script.size', 'n'],
  ['set.game.id', 'm'],
  ['log', 'm'], // 0x90
  ['set.scan.start', ''],
  ['reset.scan.start', ''],
  ['reposition.to', 'onn'],
  ['reposition.to.v', 'ovv'],
  ['trace.on', ''],
  ['trace.info', 'nnn'],
  // 0x97, 0x98 — four arguments, except below 2.089 where they take three.
  ['print.at', 'mnnn'],
  ['print.at.v', 'vnnn'],
  ['discard.view.v', 'v'],
  ['clear.text.rect', 'nnnnn'], // 0x9A
  ['set.upper.left', 'nn'],
  ['set.menu', 'm'],
  ['set.menu.item', 'mc'],
  ['submit.menu', ''],
  ['enable.item', 'c'],
  ['disable.item', 'c'], // 0xA0
  ['menu.input', ''],
  ['show.obj.v', 'v'],
  ['open.dialogue', ''],
  ['close.dialogue', ''],
  ['mul.n', 'vn'],
  ['mul.v', 'vv'],
  ['div.n', 'vn'],
  ['div.v', 'vv'],
  ['close.window', ''],
  ['set.simple', 'n'], // 0xAA
  ['push.script', ''],
  ['pop.script', ''],
  // 0xAD — none, except exactly 3.002.086 where it takes one.
  ['hold.key', ''],
  ['set.pri.base', 'n'],
  // 0xAF — `discard.sound`, whose *opcode number* moves on Apple IIgs.
  ['discard.sound', 'n'],
  // 0xB0 — none on DOS, one at 3.002.086, one on Apple IIgs.
  ['hide.mouse', ''],
  ['allow.menu', 'n'],
  ['show.mouse', ''],
  ['fence.mouse', 'nnnn'],
  ['get.mse.posn', 'vv'],
  ['release.key', ''],
  // 0xB6 — none, except Gold Rush and both Manhunters on Amiga or Atari ST,
  // where it takes two. The game id is in the Target for this one entry.
  ['adj.ego.move.to.x.y', ''],
];

/**
 * One Target's instruction set: two tables and the arity adjustments applied.
 *
 * Built once per loaded game and passed to everything that reads bytecode, so
 * there is one answer to "how long is this instruction" per game rather than
 * one per reader.
 */
export interface AgiOpcodeSet {
  readonly target: Target;
  /** Action commands by opcode number; a hole is an opcode this build has not. */
  readonly actions: ReadonlyArray<AgiOpcode | undefined>;
  /** Test commands by opcode number. */
  readonly tests: ReadonlyArray<AgiOpcode | undefined>;
  /** What was adjusted away from the base table, for the log and the editor. */
  readonly adjustments: readonly string[];
}

/** The titles whose own id changes an arity, per ADR 0012's correction. */
const ADJ_EGO_GAMES = new Set(['goldrush', 'gr', 'mh1', 'mh2', 'manhunter', 'manhunter2']);

/**
 * Builds the instruction set for a Target.
 *
 * Every adjustment below is transcribed from ScummVM's `setupOpCodes`, and each
 * is recorded in `adjustments` rather than applied silently — because a
 * disassembly is only as trustworthy as the table behind it, and "which table"
 * is the question a wrong-looking listing turns on (ADR 0013).
 */
export function opcodeSetFor(target: Target): AgiOpcodeSet {
  if (target.engine !== 'agi') {
    throw new Error(
      `${target.engine} is not AGI, so it has no AGI instruction set. This is a ` +
        `programming error rather than a data one: the Target selects the ` +
        `decoder, so a SCUMM Target should never have reached here.`,
    );
  }

  const actions = ACTION_TABLE.map(([name, spec], code): AgiOpcode => ({
    code,
    name,
    operands: operands(spec),
  }));
  const tests = TEST_TABLE.map(([name, spec], code): AgiOpcode => ({
    code,
    name,
    operands: operands(spec),
  }));
  // Slot 0x00 of the test table is not an instruction. Left present but named
  // empty so a 0 in a condition list reports as unknown rather than decoding.
  const testSlots: Array<AgiOpcode | undefined> = [...tests];
  testSlots[0] = undefined;

  const adjustments: string[] = [];
  const { interpreter, platform } = target;
  const major = agiMajor(interpreter);

  const setArity = (code: number, spec: string, why: string): void => {
    actions[code] = { code, name: actions[code].name, operands: operands(spec) };
    adjustments.push(`${actions[code].name} (0x${code.toString(16)}) takes ${spec.length}: ${why}`);
  };

  if (major === 2) {
    if (interpreter === 0x2089) {
      // Exactly 2.089, not "below": later builds take the argument back.
      setArity(0x86, '', 'interpreter is exactly 2.089');
    }
    if (interpreter < 0x2089) {
      // ScummVM's own comment flags this as imperfect: Space Quest 1 1.0X and
      // King's Quest 3 are believed to take four here. Transcribed as ScummVM
      // has it rather than corrected, because the correction is a guess and a
      // guess in an arity table misreads every boundary after it.
      setArity(0x97, 'mnn', 'interpreter is below 2.089');
      setArity(0x98, 'vnn', 'interpreter is below 2.089');
    }
  } else {
    if (interpreter === 0x3086) {
      setArity(0xb0, 'n', 'interpreter is exactly 3.002.086');
      setArity(0xad, 'n', 'interpreter is exactly 3.002.086');
    }
  }

  if (platform === 'apple-ii-gs') {
    setArity(0xb0, 'n', 'Apple IIgs');
    setArity(0xb2, 'n', 'Apple IIgs');

    // `discard.sound` moves opcode number on Apple IIgs, and the band it moves
    // to depends on the version. Not an arity change but a *numbering* one,
    // which is the sharpest illustration of why a Target has to carry the
    // platform: at 0x2440 and below, opcode 0xAA is `discard.sound` and
    // `set.simple` is not reachable at all.
    const discard = actions[0xaf];
    if (interpreter <= 0x2440) {
      actions[0xaa] = { ...discard, code: 0xaa };
      adjustments.push('discard.sound is opcode 0xAA: Apple IIgs at or below 2.440');
    } else if (interpreter < 0x3000) {
      actions[0xae] = { ...discard, code: 0xae };
      adjustments.push('discard.sound is opcode 0xAE: Apple IIgs between 2.440 and 3.0');
      // 0xAF and 0xB0 become opcodes nobody has identified, which King's Quest
      // 3 and Space Quest 2 nonetheless call. Named as unknown with the arity
      // ScummVM found, so they consume the right number of bytes instead of
      // derailing the reader.
      actions[0xaf] = { code: 0xaf, name: 'unknown.iigs.af', operands: operands('n') };
      actions[0xb0] = { code: 0xb0, name: 'unknown.iigs.b0', operands: operands('v') };
      adjustments.push('opcodes 0xAF and 0xB0 are unidentified Apple IIgs commands');
    }
  }

  if (
    (platform === 'amiga' || platform === 'atari-st') &&
    target.gameId &&
    ADJ_EGO_GAMES.has(target.gameId.toLowerCase())
  ) {
    setArity(0xb6, 'vv', `${target.gameId} on ${platform}`);
  }

  return { target, actions, tests: testSlots, adjustments };
}

/** The action command at an opcode number, or undefined for a hole. */
export function actionAt(set: AgiOpcodeSet, code: number): AgiOpcode | undefined {
  return set.actions[code];
}

export function testAt(set: AgiOpcodeSet, code: number): AgiOpcode | undefined {
  return set.tests[code];
}

/** The control bytes that structure an `if`, which are not opcodes. */
export const IF_START = 0xff;
/** Closes a condition list; followed by a 16-bit forward jump. */
export const IF_END = 0xff;
/** Negates the next condition. */
export const NOT = 0xfd;
/** Joins conditions with `or` rather than `and`, and closes the group. */
export const OR = 0xfc;
/** An unconditional jump, followed by a signed 16-bit displacement. */
export const GOTO = 0xfe;
