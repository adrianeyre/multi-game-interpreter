/**
 * Reading and rebuilding `GAMEPC`, the file an AGOS game is.
 *
 * One file holds the item tree, the pooled strings and the Subroutines, one
 * after another, with **nothing to address them through**. There is no index,
 * so there is no resource to substitute: ADR 0030 rebuilds the file whole from
 * the model, and the model therefore has to be complete enough to produce every
 * byte back. That is why `readGamePc` returns the header words it was given
 * rather than only what they mean, and why nothing here is skipped over.
 *
 * The consequence is stated in ADR 0030 and is worth repeating where it bites:
 * a region of this file that cannot be parsed makes the **whole game**
 * uneditable, not one resource read-only. Every other family in this repo can
 * mark a single script Unrecovered and carry on. AGOS cannot, because the file
 * is the granularity the format offers.
 *
 * Layout, in order:
 *
 * 1. four big-endian 32-bit words — item array size, a version that must be
 *    0x80, the number of items initialised, the number of strings
 * 2. a 32-bit text size, then that many bytes of NUL-separated strings
 * 3. one record per initialised item, from item 2 upward
 * 4. a Subroutine block (`../script/subroutines.ts`)
 */

import { hasWideOpcodes, type AgosTarget } from '../agosVersion.js';
import {
  readSubroutineBlock,
  writeSubroutineBlock,
  type AgosSubroutineBlock,
} from '../script/subroutines.js';
import { ITEM_CHILD_TYPES, type AgosItem, type AgosItemChild } from '../world/itemTree.js';

/** The version word every `GAMEPC` carries. Anything else is not a runtime database. */
export const GAMEPC_VERSION = 0x80;

export interface AgosGamePc {
  /** The four header words, as read. */
  readonly header: {
    readonly itemArraySize: number;
    readonly version: number;
    readonly itemArrayInited: number;
    readonly stringTableNum: number;
  };
  /** The string pool, split on its NULs. Many Subroutines index into this one table. */
  readonly strings: readonly string[];
  /** The raw pool, kept because splitting and rejoining is not always the identity. */
  readonly textBytes: Uint8Array;
  /** Items from index 2 upward; the first two are predefined and not in the file. */
  readonly items: readonly AgosItem[];
  readonly subroutines: AgosSubroutineBlock;
  /**
   * Whatever a release appended after the runtime database.
   *
   * `CONTEXT.md`'s **Preserved bytes**, and the only region of `GAMEPC` that
   * is. Empty for most releases; for the ones that have it, it is a development
   * build's **symbol table** — runs of `name`, a number, and a `;END 0 0.`
   * marker at the end. The retail Windows release of Simon 1 carries 7,909
   * bytes of it, and so do the Elvira 1 and Waxworks demos (#291).
   *
   * The interpreter never reads a byte of it: `readGamePcFile` stops at the end
   * of the Subroutine block and the file handle is closed. So it is neither
   * bytecode this project failed to decode nor data the game needs — it is a
   * region with no runtime meaning, which is exactly the case Preserved bytes
   * exists for, and carrying it verbatim is what makes those releases re-emit
   * byte for byte and therefore editable at all (ADR 0035).
   */
  readonly trailing: Uint8Array;
}

class Reader {
  offset = 0;
  constructor(readonly data: Uint8Array) {}

  byte(): number {
    if (this.offset >= this.data.length) {
      throw new Error(`GAMEPC ended at ${this.offset} with more expected`);
    }
    return this.data[this.offset++]!;
  }

  word(): number {
    return (this.byte() << 8) | this.byte();
  }

  long(): number {
    return this.word() * 0x10000 + this.word();
  }

  bytes(count: number): Uint8Array {
    const end = this.offset + count;
    if (end > this.data.length) throw new Error(`GAMEPC ended inside a ${count}-byte block`);
    const slice = this.data.subarray(this.offset, end);
    this.offset = end;
    return slice;
  }
}

class Builder {
  private readonly out: number[] = [];

  byte(value: number): void {
    this.out.push(value & 0xff);
  }

  word(value: number): void {
    this.byte(value >> 8);
    this.byte(value);
  }

  long(value: number): void {
    this.word(Math.floor(value / 0x10000) & 0xffff);
    this.word(value & 0xffff);
  }

  raw(bytes: Uint8Array): void {
    for (const value of bytes) this.out.push(value);
  }

  finish(): Uint8Array {
    return Uint8Array.from(this.out);
  }
}

/**
 * How many items the file actually wrote records for.
 *
 * Elvira 1 and 2 write one per slot in the array; every later Version writes
 * only the initialised ones. Both add two for the predefined pair. Getting this
 * wrong reads item records as bytecode, or bytecode as item records, and both
 * fail loudly rather than quietly — which is the only good thing about it.
 */
function initedCount(target: AgosTarget, header: AgosGamePc['header']): number {
  const early = target.version === 'Elvira1' || target.version === 'Elvira2';
  return early ? header.itemArraySize + 2 : header.itemArrayInited + 2;
}

function readItemChild(reader: Reader, target: AgosTarget, type: number): AgosItemChild {
  const values: number[] = [];
  const links: number[] = [];
  const long = (): number => reader.long();
  const word = (): number => reader.word();
  const link = (): number => {
    links.push(values.length);
    return reader.long();
  };

  // Elvira 1 has fixed-size sub-structures. Every later Version sizes rooms and
  // objects from a mask, which is why the mask is kept as `header` rather than
  // being consumed into the values.
  if (target.version === 'Elvira1') {
    switch (type) {
      case ITEM_CHILD_TYPES.room:
        values.push(long(), long(), word());
        return { type, values };
      case ITEM_CHILD_TYPES.object:
        values.push(long(), long(), long(), long(), word(), word(), word());
        return { type, values };
      case ITEM_CHILD_TYPES.genExit:
        for (let index = 0; index < 12; index += 1) values.push(link());
        return { type, values, links };
      case ITEM_CHILD_TYPES.container:
        values.push(word(), word());
        return { type, values };
      case ITEM_CHILD_TYPES.chain:
        values.push(link());
        return { type, values, links };
      case ITEM_CHILD_TYPES.userFlag:
        for (let index = 0; index < 8; index += 1) values.push(word());
        for (let index = 0; index < 4; index += 1) values.push(link());
        return { type, values, links };
      case ITEM_CHILD_TYPES.inherit:
        values.push(link());
        return { type, values, links };
      default:
        throw new Error(`item sub-structure type ${type} is not one Elvira 1 has`);
    }
  }

  switch (type) {
    case ITEM_CHILD_TYPES.room: {
      const subroutineId = reader.word();
      const exitStates = reader.word();
      // Two bits per exit, six exits: a set pair means that exit is present and
      // its destination follows. Counting them is how the record's length is
      // known, so the mask is data the writer needs as much as the reader.
      for (let index = 0, bits = exitStates; index !== 6; index += 1, bits >>= 2) {
        if (bits & 3) values.push(link());
      }
      return { type, header: [subroutineId, exitStates], values, links };
    }
    case ITEM_CHILD_TYPES.superRoom: {
      if (target.version !== 'Elvira2') {
        throw new Error(`item sub-structure type ${type} is Elvira 2's alone`);
      }
      const id = reader.word();
      const x = reader.word();
      const y = reader.word();
      const z = reader.word();
      for (let index = 0; index !== x * y * z; index += 1) values.push(word());
      return { type, header: [id, x, y, z], values };
    }
    case ITEM_CHILD_TYPES.object: {
      const flags = reader.long();
      // Bit 0's value is 32 bits wide and the other fifteen are 16: a detail
      // that costs one wrong record if missed and every record after it.
      if (flags & 1) values.push(long());
      for (let bit = 1; bit !== 16; bit += 1) {
        if (flags & (1 << bit)) values.push(word());
      }
      if (target.version !== 'Elvira2') values.push(long());
      return { type, header: [flags], values };
    }
    case ITEM_CHILD_TYPES.container:
      values.push(word(), word());
      return { type, values };
    case ITEM_CHILD_TYPES.chain:
      values.push(link());
      return { type, values, links };
    case ITEM_CHILD_TYPES.userFlag:
      for (let index = 0; index < 4; index += 1) values.push(word());
      return { type, values };
    case ITEM_CHILD_TYPES.inherit:
      values.push(link());
      return { type, values, links };
    default:
      throw new Error(`item sub-structure type ${type} is not one this Version has`);
  }
}

function writeItemChild(builder: Builder, target: AgosTarget, child: AgosItemChild): void {
  const isLink = new Set(child.links ?? []);
  const writeValue = (value: number, index: number, wide: boolean): void => {
    if (wide || isLink.has(index)) builder.long(value);
    else builder.word(value);
  };

  if (target.version === 'Elvira1') {
    switch (child.type) {
      case ITEM_CHILD_TYPES.room:
        builder.long(child.values[0]!);
        builder.long(child.values[1]!);
        builder.word(child.values[2]!);
        return;
      case ITEM_CHILD_TYPES.object:
        for (let index = 0; index < 4; index += 1) builder.long(child.values[index]!);
        for (let index = 4; index < 7; index += 1) builder.word(child.values[index]!);
        return;
      default:
        for (const [index, value] of child.values.entries()) {
          writeValue(value, index, false);
        }
        return;
    }
  }

  switch (child.type) {
    case ITEM_CHILD_TYPES.room:
      builder.word(child.header![0]!);
      builder.word(child.header![1]!);
      for (const value of child.values) builder.long(value);
      return;
    case ITEM_CHILD_TYPES.superRoom:
      for (const value of child.header!) builder.word(value);
      for (const value of child.values) builder.word(value);
      return;
    case ITEM_CHILD_TYPES.object: {
      const flags = child.header![0]!;
      builder.long(flags);
      let index = 0;
      if (flags & 1) builder.long(child.values[index++]!);
      for (let bit = 1; bit !== 16; bit += 1) {
        if (flags & (1 << bit)) builder.word(child.values[index++]!);
      }
      if (target.version !== 'Elvira2') builder.long(child.values[index]!);
      return;
    }
    default:
      for (const [index, value] of child.values.entries()) writeValue(value, index, false);
  }
}

function readItem(reader: Reader, target: AgosTarget): AgosItem {
  const wide = target.version === 'Elvira1';
  const early = wide || target.version === 'Elvira2';

  const itemName = early ? reader.long() : undefined;
  const adjective = reader.word();
  const noun = reader.word();
  const state = reader.word();
  const statePadding = wide ? reader.word() : undefined;
  const next = { raw: reader.long() };
  const child = { raw: reader.long() };
  const parent = { raw: reader.long() };
  const trailing = wide ? [reader.word(), reader.word(), reader.word()] : [reader.word()];
  const classFlags = reader.word();

  const childrenLead = reader.long();
  const children: AgosItemChild[] = [];
  if (childrenLead !== 0) {
    for (;;) {
      const type = reader.word();
      if (type === 0) break;
      children.push(readItemChild(reader, target, type));
    }
  }

  return {
    ...(itemName !== undefined ? { itemName } : {}),
    adjective,
    noun,
    state,
    ...(statePadding !== undefined ? { statePadding } : {}),
    next,
    child,
    parent,
    trailing,
    classFlags,
    childrenLead,
    children,
  };
}

function writeItem(builder: Builder, target: AgosTarget, item: AgosItem): void {
  if (item.itemName !== undefined) builder.long(item.itemName);
  builder.word(item.adjective);
  builder.word(item.noun);
  builder.word(item.state);
  if (item.statePadding !== undefined) builder.word(item.statePadding);
  builder.long(item.next.raw);
  builder.long(item.child.raw);
  builder.long(item.parent.raw);
  for (const value of item.trailing) builder.word(value);
  builder.word(item.classFlags);
  builder.long(item.childrenLead);
  if (item.childrenLead !== 0) {
    for (const child of item.children) {
      builder.word(child.type);
      writeItemChild(builder, target, child);
    }
    builder.word(0);
  }
}

/** Splits the pool into the strings a Subroutine's operands index. */
function splitStrings(pool: Uint8Array, count: number): string[] {
  const strings: string[] = [];
  let start = 0;
  for (let index = 0; index < count; index += 1) {
    let end = start;
    while (end < pool.length && pool[end] !== 0) end += 1;
    strings.push(new TextDecoder('latin1').decode(pool.subarray(start, end)));
    start = end + 1;
  }
  return strings;
}

/** Reads a whole `GAMEPC`. Throws rather than skipping anything it cannot explain. */
export function readGamePc(data: Uint8Array, target: AgosTarget): AgosGamePc {
  const reader = new Reader(data);
  const header = {
    itemArraySize: reader.long(),
    version: reader.long(),
    itemArrayInited: reader.long(),
    stringTableNum: reader.long(),
  };
  if (header.version !== GAMEPC_VERSION) {
    throw new Error(
      `GAMEPC version word is 0x${header.version.toString(16)}, not 0x80: not a runtime database`,
    );
  }

  const textSize = reader.long();
  const textBytes = reader.bytes(textSize);
  const strings = splitStrings(textBytes, header.stringTableNum);

  const items: AgosItem[] = [];
  const count = initedCount(target, header);
  for (let index = 2; index < count; index += 1) items.push(readItem(reader, target));

  const { block, endOffset } = readSubroutineBlock(data, target, reader.offset);
  return {
    header,
    strings,
    textBytes,
    items,
    subroutines: block,
    trailing: data.subarray(endOffset),
  };
}

/**
 * Rebuilds a whole `GAMEPC` from the model.
 *
 * Whole, because there is no index to write a changed piece into (ADR 0030).
 * The test that this is right is byte-identity on a file that was read and not
 * edited, which is one of ADR 0029's three conditions for offering the game for
 * editing at all.
 */
export function writeGamePc(game: AgosGamePc, target: AgosTarget): Uint8Array {
  const builder = new Builder();
  builder.long(game.header.itemArraySize);
  builder.long(game.header.version);
  builder.long(game.header.itemArrayInited);
  builder.long(game.header.stringTableNum);
  builder.long(game.textBytes.length);
  builder.raw(game.textBytes);
  for (const item of game.items) writeItem(builder, target, item);
  builder.raw(writeSubroutineBlock(game.subroutines, target));
  // The appended region last, unchanged. A release without one contributes
  // nothing here, so this is not a branch: the empty case is the common case.
  builder.raw(game.trailing);
  return builder.finish();
}

/** Whether this Version reads 16-bit opcodes, re-exported for readers of this file. */
export { hasWideOpcodes };
