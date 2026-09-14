/**
 * Selectors and the class table, which a SCI game ships inside itself.
 *
 * `CONTEXT.md`: a **Selector** is the name a script sends to an object to reach
 * a method or a property, held as an index into the game's own table rather
 * than as an address. It is what makes SCI object-oriented in a way neither
 * sibling is — nothing in the bytecode says which code will run, because the
 * object's class decides at the moment of the send — and it is why both a call
 * and a field read are the same word.
 *
 * The tables are `vocab.997` for Selector names and `vocab.996` for classes,
 * and their being *in the game* is the whole reason ADR 0016 could give SCI a
 * smaller Target than AGI's: there is no external arity table, no per-build
 * drift and no per-title correction list.
 */

/** The Selector names a game ships, indexed by Selector number. */
export interface SciSelectorTable {
  names: string[];
  /** Name to number, for the Kernel and the editor. */
  numbers: Map<string, number>;
}

/**
 * Reads `vocab.997`.
 *
 * A count, then that many 16-bit offsets, each pointing at a length-prefixed
 * string. The count is **one less than the number of entries** — ScummVM's own
 * comment is "Counter is slightly off" — and a reader that takes it at face
 * value loses the last Selector in the game, which is silent until something
 * sends it.
 *
 * `lsbToggle` doubles the numbering, which is what SCI0 early's read/write bit
 * in the low bit of a Selector ID amounts to — see
 * `selectorIdCarriesReadWriteBit`. Every name lands at an even number and again
 * at the odd one above it, so a script's `444` and a script's `445` both find
 * the name Sierra filed at 222.
 */
export function readSelectorTable(
  vocab997: Uint8Array,
  options: { lsbToggle?: boolean } = {},
): SciSelectorTable {
  const u16 = (at: number): number => vocab997[at] | (vocab997[at + 1] << 8);
  const names: string[] = [];
  const numbers = new Map<string, number>();
  if (vocab997.length < 2) return { names, numbers };

  const count = u16(0) + 1;
  for (let i = 0; i < count; i++) {
    const pointer = 2 + i * 2;
    if (pointer + 1 >= vocab997.length) break;
    const offset = u16(pointer);
    if (offset + 2 > vocab997.length) break;
    const length = u16(offset);
    if (offset + 2 + length > vocab997.length) break;

    let name = '';
    for (let c = 0; c < length; c++) name += String.fromCharCode(vocab997[offset + 2 + c]);
    // The even slot first, so `numbers` answers with the number a script that
    // only reads a property would send.
    if (!numbers.has(name)) numbers.set(name, names.length);
    names.push(name);
    if (options.lsbToggle) names.push(name);
  }
  return { names, numbers };
}

/**
 * The Selectors the interpreter itself has to know by name.
 *
 * Everything else is the game's business, but these are the ones the engine
 * sends or reads on its own account — `doit` every cycle, `y`/`x` to place an
 * actor, `cel` and `loop` to draw one. Held as names looked up in the game's
 * own table rather than as numbers, because the numbering is per-game: script
 * 0 of one release and script 0 of another do not agree about which Selector is
 * 42, and hardcoding a number is how an engine draws the wrong property.
 */
export const WELL_KNOWN_SELECTORS = [
  'y',
  'x',
  'view',
  'loop',
  'cel',
  'underBits',
  'nsTop',
  'nsLeft',
  'nsBottom',
  'nsRight',
  'lsTop',
  'lsLeft',
  'lsBottom',
  'lsRight',
  'signal',
  'illegalBits',
  'brTop',
  'brLeft',
  'brBottom',
  'brRight',
  'name',
  'key',
  'time',
  'text',
  'elements',
  'color',
  'back',
  'mode',
  'style',
  'state',
  'font',
  'type',
  'window',
  'cursor',
  'max',
  'mask',
  'moveDone',
  'doit',
  'init',
  'dispose',
  'play',
  'number',
  'handle',
  'priority',
  'client',
  'dx',
  'dy',
  'b-moveCnt',
  'canBeHere',
  'heading',
  'mover',
  'looper',
  'cycler',
  'nodePtr',
  'flags',
  'points',
  'syncTime',
  'syncCue',
  'scaleX',
  'scaleY',
  'plane',
  'top',
  'left',
  'bottom',
  'right',
] as const;

/** One class, and the Script resource that defines it. */
export interface SciClassEntry {
  /** The Script resource number holding this class's definition. */
  script: number;
  /** Offset of the class within that script, once it is loaded. */
  offset: number;
}

/**
 * Reads `vocab.996`, the class table.
 *
 * Four bytes an entry: a segment word the interpreter fills in at load time,
 * and the Script resource number the class is defined in. So a `class N`
 * instruction is a lookup here followed by a load of that script — which is
 * the mechanism that lets a SCI game name every class in the game by number
 * without any script knowing where the others live.
 */
export function readClassTable(vocab996: Uint8Array): SciClassEntry[] {
  const u16 = (at: number): number => vocab996[at] | (vocab996[at + 1] << 8);
  const classes: SciClassEntry[] = [];
  for (let at = 0; at + 4 <= vocab996.length; at += 4) {
    classes.push({ offset: u16(at), script: u16(at + 2) });
  }
  return classes;
}

/**
 * The Selector numbering a SCI16 game uses when it ships no `vocab.997`.
 *
 * Several demos ship none — King's Quest IV, Leisure Suit Larry 1 and Torin
 * among the ones this project has — and without a table nothing can find
 * `play`, which is the Selector SCI's own boot sends to start the game. So the
 * engine has no entry point at all, and the symptom is a game that loads
 * everything and then does nothing.
 *
 * **Read off real games rather than transcribed from anywhere.** Ten of the
 * demos ship a table, spanning SCI0 early, SCI0 late, SCI01, SCI1 early, SCI1
 * middle and SCI1 late, and this is every index where all ten agree — eighty-two
 * entries up to index 83. That unanimity across six Versions and ten games is
 * the evidence: it is Sierra's own numbering rather than one game's.
 *
 * **Two holes, at 44 and 57, and they are holes on purpose.** The ten tables
 * disagree there, so nothing is claimed. A `undefined` in this list means "no
 * game here agreed", which is a different thing from "no Selector has that
 * number" and is why the list is not simply truncated at the first
 * disagreement — `doit` is 60 in all ten, and stopping at 44 lost it. Losing it
 * is what left EcoQuest, Quest for Glory III, Island of Dr. Brain and Torin's
 * Passage unable to resolve the Selector their main loop is built on.
 *
 * **A game on this fallback is on a guess in the same sense ADR 0013 means.**
 * The numbering is Sierra's, but nothing in *this* game confirms it — so the
 * engine records that it used the fallback, and a reader of a report can see
 * that every Selector name it mentions came from here rather than from the
 * game in front of it.
 */
/**
 * The three SCI1.1 dropped from the front: `species`, `superClass`, `-info-`.
 *
 * They stopped being Selectors and became fixed fields of an object's header,
 * which is the same change that moved `-info-` from property index 2 to 5.
 * Everything after them shifts down by three.
 */
export const SCI11_DROPPED_SELECTORS = 3;

/**
 * Sierra's numbering from SCI2 on, for a game that ships no table.
 *
 * A third numbering, and it is not a shift of SCI16's: the compositor's own
 * Selectors arrive at the front — `plane`, `scaleX`, `fixPriority`,
 * `useInsetRect`, `bitmap` — and push everything down unevenly. `play` lands at
 * 51 and `doit` at 69, against SCI1.1's 39 and 57 and SCI16's 42 and 60.
 *
 * Derived the same way as the SCI16 list: every index where Space Quest 6,
 * King's Quest VII, RAMA and Leisure Suit Larry 7 all agree, which is 79
 * entries with no holes in them. Torin's Passage ships no table and its game
 * object's chain answers 51, 69, 73, 82 and 83 — this numbering exactly, which
 * is the check that it is Sierra's and not one game's.
 */
export const SCI32_STATIC_SELECTORS: ReadonlyArray<string | undefined> = [
  'plane',
  'x',
  'y',
  'z',
  'scaleX',
  'scaleY',
  'maxScale',
  'priority',
  'fixPriority',
  'inLeft',
  'inTop',
  'inRight',
  'inBottom',
  'useInsetRect',
  'view',
  'loop',
  'cel',
  'bitmap',
  'nsLeft',
  'nsTop',
  'nsRight',
  'nsBottom',
  'lsLeft',
  'lsTop',
  'lsRight',
  'lsBottom',
  'signal',
  'illegalBits',
  'brLeft',
  'brTop',
  'brRight',
  'brBottom',
  'name',
  'key',
  'time',
  'text',
  'elements',
  'fore',
  'back',
  'mode',
  'style',
  'state',
  'font',
  'type',
  'window',
  'cursor',
  'max',
  'mark',
  'who',
  'message',
  'edit',
  'play',
  'number',
  'nodePtr',
  'client',
  'dx',
  'dy',
  'b-moveCnt',
  'b-i1',
  'b-i2',
  'b-di',
  'b-xAxis',
  'b-incr',
  'xStep',
  'yStep',
  'moveSpeed',
  'cantBeHere',
  'heading',
  'mover',
  'doit',
  'isBlocked',
  'looper',
  'modifiers',
  'replay',
  'setPri',
  'at',
  'next',
  'done',
  'width',
];

export const SCI16_STATIC_SELECTORS: ReadonlyArray<string | undefined> = [
  'species',
  'superClass',
  '-info-',
  'y',
  'x',
  'view',
  'loop',
  'cel',
  'underBits',
  'nsTop',
  'nsLeft',
  'nsBottom',
  'nsRight',
  'lsTop',
  'lsLeft',
  'lsBottom',
  'lsRight',
  'signal',
  'illegalBits',
  'brTop',
  'brLeft',
  'brBottom',
  'brRight',
  'name',
  'key',
  'time',
  'text',
  'elements',
  'color',
  'back',
  'mode',
  'style',
  'state',
  'font',
  'type',
  'window',
  'cursor',
  'max',
  'mark',
  'who',
  'message',
  'edit',
  'play',
  'number',
  undefined,
  'client',
  'dx',
  'dy',
  'b-moveCnt',
  'b-i1',
  'b-i2',
  'b-di',
  'b-xAxis',
  'b-incr',
  'xStep',
  'yStep',
  'moveSpeed',
  undefined,
  'heading',
  'mover',
  'doit',
  'isBlocked',
  'looper',
  'priority',
  'modifiers',
  'replay',
  'setPri',
  'at',
  'next',
  'done',
  'width',
  'wordFail',
  'syntaxFail',
  'semanticFail',
  'pragmaFail',
  'said',
  'claimed',
  'value',
  'save',
  'restore',
  'title',
  'button',
  'icon',
  'draw',
];

/**
 * The table to use, and whether it came from the game.
 *
 * Returned as a pair rather than as a table, because "which Selector is 42"
 * and "did this game tell us" are different facts and only the first is useful
 * on its own.
 */
export function selectorTableFor(
  vocab997: Uint8Array | null,
  options: { heapSplit?: boolean; sci32?: boolean; lsbToggle?: boolean } = {},
): {
  table: SciSelectorTable;
  fromGame: boolean;
} {
  if (vocab997) {
    const table = readSelectorTable(vocab997, { lsbToggle: options.lsbToggle });
    if (table.names.length > 0) return { table, fromGame: true };
  }

  // **A heap-split game numbers its Selectors three lower.** SCI1.1 dropped
  // `species`, `superClass` and `-info-` from the front of the table, so every
  // Selector after them moves down by three: King's Quest VI's own table puts
  // `play` at 39 where every SCI16 game puts it at 42, and `doit` at 57 where
  // they put it at 60.
  //
  // That is why four demos with no `vocab.997` found no `play` at all. EcoQuest
  // and Quest for Glory III are bucketed SCI1 late and Island of Dr. Brain and
  // Torin's Passage later still, but all four ship heap resources — and their
  // game objects answer 39, 57, 62, 71, 75 and 76, which is King's Quest VI's
  // numbering exactly. The engine was asking for 42.
  //
  // Decided by the heap again rather than by the Version, for the same reason
  // the loader decides that way: the games that need it are bucketed on the
  // wrong side of the seam.
  // Three numberings, not two, and SCI32's is its own list rather than another
  // shift — the compositor's Selectors arrive at the front and displace the
  // rest unevenly.
  const base = options.sci32
    ? SCI32_STATIC_SELECTORS
    : options.heapSplit
      ? SCI16_STATIC_SELECTORS.slice(SCI11_DROPPED_SELECTORS)
      : SCI16_STATIC_SELECTORS;

  // **The fallback is doubled too, for SCI0 early.** ScummVM duplicates the
  // static table on the same condition it duplicates a shipped one, and a
  // game with no `vocab.997` sends the same doubled IDs as one with it.
  const numbering = options.lsbToggle ? base.flatMap((name) => [name, name]) : base;

  const numbers = new Map<string, number>();
  numbering.forEach((name, index) => {
    // A hole is an index the ten games disagreed about, so it names nothing.
    if (name && !numbers.has(name)) numbers.set(name, index);
  });
  return {
    // The holes become empty strings in the names list, so a report that prints
    // a Selector by number says nothing rather than the wrong thing.
    table: { names: numbering.map((name) => name ?? ''), numbers },
    fromGame: false,
  };
}
