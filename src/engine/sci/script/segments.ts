/**
 * Where a SCI value points, when it does not point at a Script resource.
 *
 * ADR 0019 makes this the shape of a save: "a SCI save is a heap, not a
 * schema", with segments of declared types — script, clone, list, node, hunk —
 * and references written as segment-plus-offset pairs. So the segments exist
 * here rather than being invented by the save code later, and a reference is a
 * pair from the moment it is made.
 *
 * The kinds are not decoration. A Clone has to be recreated whole on load and a
 * script's object does not; a list is a pair of node references and a node is a
 * key, a value and two more references. Restoring one as the other loads a
 * world that looks entirely right and whose actors are not the ones the running
 * scripts hold pointers to.
 */

import { NULL_REG, reg, type Reg } from './PMachine.js';

/** The segment numbers the interpreter owns, above any Script resource's. */
export const SEGMENT = {
  /** Objects `kClone` made, which have no backing in any resource. */
  clone: 0x8000,
  /** Lists and nodes, which are SCI's own linked list and are everywhere. */
  list: 0x8001,
  node: 0x8002,
  /** Strings and arrays a script asked for at runtime. */
  memory: 0x8003,
} as const;

/** One of SCI's doubly linked lists, which its scripts use for everything. */
export interface SciList {
  first: Reg;
  last: Reg;
}

/** One node of one. */
export interface SciNode {
  key: Reg;
  value: Reg;
  previous: Reg;
  next: Reg;
}

/**
 * The interpreter's own heap.
 *
 * Kept apart from the PMachine's object table on purpose: an object is
 * something a send can reach and these are not, and folding them together
 * would make "is this an object" a question about which segment a reference is
 * in rather than about what it is.
 */
export class SciHeap {
  private readonly lists = new Map<number, SciList>();
  private readonly nodes = new Map<number, SciNode>();
  private readonly memory = new Map<number, Uint8Array>();
  private next = 1;

  newList(): Reg {
    const id = this.next++;
    this.lists.set(id, { first: NULL_REG, last: NULL_REG });
    return reg(SEGMENT.list, id);
  }

  list(value: Reg): SciList | null {
    return value.segment === SEGMENT.list ? (this.lists.get(value.offset) ?? null) : null;
  }

  disposeList(value: Reg): void {
    if (value.segment === SEGMENT.list) this.lists.delete(value.offset);
  }

  newNode(value: Reg, key: Reg): Reg {
    const id = this.next++;
    this.nodes.set(id, { key, value, previous: NULL_REG, next: NULL_REG });
    return reg(SEGMENT.node, id);
  }

  node(value: Reg): SciNode | null {
    return value.segment === SEGMENT.node ? (this.nodes.get(value.offset) ?? null) : null;
  }

  /**
   * Appends a node, keeping both ends of the list right.
   *
   * Written out rather than left to the caller because a list whose `last` is
   * stale still walks forwards correctly and fails only when something walks it
   * backwards — which is a bug that surfaces rooms later than it is made.
   */
  addToEnd(listRef: Reg, nodeRef: Reg): void {
    const list = this.list(listRef);
    const node = this.node(nodeRef);
    if (!list || !node) return;

    node.previous = list.last;
    node.next = NULL_REG;
    const previous = this.node(list.last);
    if (previous) previous.next = nodeRef;
    else list.first = nodeRef;
    list.last = nodeRef;
  }

  /**
   * Sets a node's key, which is what `FindKey` and `DeleteKey` match on.
   *
   * Separate from linking because Sierra sets it separately: `AddToFront` and
   * `AddToEnd` take an optional third argument and write it here *after* the
   * node is on the list.
   */
  setNodeKey(nodeRef: Reg, key: Reg): void {
    const node = this.node(nodeRef);
    if (node) node.key = key;
  }

  /** Takes a node out of its list, leaving both ends and its neighbours right. */
  private unlink(list: SciList, nodeRef: Reg, node: SciNode): void {
    const previous = this.node(node.previous);
    const next = this.node(node.next);
    if (previous) previous.next = node.next;
    else if (list.first.segment === nodeRef.segment && list.first.offset === nodeRef.offset)
      list.first = node.next;
    if (next) next.previous = node.previous;
    else if (list.last.segment === nodeRef.segment && list.last.offset === nodeRef.offset)
      list.last = node.previous;
    node.previous = NULL_REG;
    node.next = NULL_REG;
  }

  /**
   * Inserts `nodeRef` directly after `afterRef`, which is where the call says.
   *
   * A list SCI32 draws from is drawn in its own order, so "after" is a position
   * and not a hint — appending instead puts a cast member in front of whatever
   * it should have been behind.
   */
  addAfter(listRef: Reg, afterRef: Reg, nodeRef: Reg): void {
    const list = this.list(listRef);
    const node = this.node(nodeRef);
    const after = this.node(afterRef);
    if (!list || !node) return;
    if (!after) {
      this.addToEnd(listRef, nodeRef);
      return;
    }

    node.previous = afterRef;
    node.next = after.next;
    const following = this.node(after.next);
    if (following) following.previous = nodeRef;
    else list.last = nodeRef;
    after.next = nodeRef;
  }

  moveToFront(listRef: Reg, nodeRef: Reg): void {
    const list = this.list(listRef);
    const node = this.node(nodeRef);
    if (!list || !node) return;
    this.unlink(list, nodeRef, node);
    this.addToFront(listRef, nodeRef);
  }

  moveToEnd(listRef: Reg, nodeRef: Reg): void {
    const list = this.list(listRef);
    const node = this.node(nodeRef);
    if (!list || !node) return;
    this.unlink(list, nodeRef, node);
    this.addToEnd(listRef, nodeRef);
  }

  addToFront(listRef: Reg, nodeRef: Reg): void {
    const list = this.list(listRef);
    const node = this.node(nodeRef);
    if (!list || !node) return;

    node.next = list.first;
    node.previous = NULL_REG;
    const following = this.node(list.first);
    if (following) following.previous = nodeRef;
    else list.last = nodeRef;
    list.first = nodeRef;
  }

  /** The node whose key matches, or null. Keys compare by value, not identity. */
  findKey(listRef: Reg, key: Reg): Reg {
    const list = this.list(listRef);
    if (!list) return NULL_REG;
    let at = list.first;
    while (at.segment !== 0 || at.offset !== 0) {
      const node = this.node(at);
      if (!node) break;
      if (node.key.segment === key.segment && node.key.offset === key.offset) return at;
      at = node.next;
    }
    return NULL_REG;
  }

  deleteKey(listRef: Reg, key: Reg): boolean {
    const found = this.findKey(listRef, key);
    const node = this.node(found);
    const list = this.list(listRef);
    if (!node || !list) return false;

    this.unlink(list, found, node);
    this.nodes.delete(found.offset);
    return true;
  }

  /** A block of bytes a script asked for: a string, a table, a saved area. */
  allocate(size: number): Reg {
    const id = this.next++;
    this.memory.set(id, new Uint8Array(size));
    return reg(SEGMENT.memory, id);
  }

  /**
   * SCI32's typed arrays, which its `Array` and `String` Kernel calls make.
   *
   * The **element width is the type's**, and holding it here rather than
   * guessing it per call is what stops a string being read two bytes at a time:
   * type 2 and 3 are bytes, everything else is a word. A SCI32 game builds its
   * strings this way — script 64918 is `String(new)` in every release from SCI2
   * to SCI2.1 middle — so an array whose width is wrong is a game whose text is
   * every other character.
   */
  private readonly arrayTypes = new Map<number, number>();

  newArray(type: number, size: number): Reg {
    const width = type === 2 || type === 3 ? 1 : 2;
    const ref = this.allocate(Math.max(0, size) * width);
    this.arrayTypes.set(ref.offset, type);
    return ref;
  }

  /** An array's declared type, or null when this reference is not one. */
  arrayType(value: Reg): number | null {
    if (value.segment !== SEGMENT.memory) return null;
    return this.arrayTypes.get(value.offset) ?? null;
  }

  /** How many bytes one element of this array takes: one or two. */
  elementWidth(value: Reg): number {
    const type = this.arrayType(value);
    return type === 2 || type === 3 ? 1 : 2;
  }

  /** How many elements it holds, which is its bytes divided by that width. */
  arrayLength(value: Reg): number {
    const bytes = this.bytes(value);
    return bytes ? Math.floor(bytes.length / this.elementWidth(value)) : 0;
  }

  /**
   * Grow an array so `size` elements fit, which SCI's own arrays do themselves.
   *
   * `SciArray::resize` in ScummVM's `segment.h`, and the reason it matters here
   * is that a SCI32 script builds an array by making an **empty** one and then
   * copying into it: `(IntArray new:) copy: source` is how King's Quest VII
   * takes the path `AvoidPath` hands back. A put that silently dropped writes
   * past the end — which is what this did — left that array all zeroes, and the
   * ego walked to (0, 0) because (0, 0) is genuinely what the script read.
   *
   * Never shrinks, and new elements are zero, both as ScummVM has it.
   */
  arrayResize(value: Reg, size: number): void {
    const bytes = this.bytes(value);
    if (!bytes) return;
    const wanted = Math.max(0, size) * this.elementWidth(value);
    if (wanted <= bytes.length) return;
    const grown = new Uint8Array(wanted);
    grown.set(bytes);
    this.memory.set(value.offset, grown);
  }

  arrayAt(value: Reg, index: number): number {
    const bytes = this.bytes(value);
    if (!bytes) return 0;
    const width = this.elementWidth(value);
    const at = index * width;
    if (at < 0 || at + width > bytes.length) return 0;
    return width === 1 ? bytes[at] : bytes[at] | (bytes[at + 1] << 8);
  }

  arrayPut(value: Reg, index: number, element: number): void {
    const bytes = this.bytes(value);
    if (!bytes) return;
    const width = this.elementWidth(value);
    const at = index * width;
    if (at < 0 || at + width > bytes.length) return;
    bytes[at] = element & 0xff;
    if (width === 2) bytes[at + 1] = (element >> 8) & 0xff;
  }

  bytes(value: Reg): Uint8Array | null {
    return value.segment === SEGMENT.memory ? (this.memory.get(value.offset) ?? null) : null;
  }

  free(value: Reg): void {
    if (value.segment !== SEGMENT.memory) return;
    this.memory.delete(value.offset);
    this.arrayTypes.delete(value.offset);
  }

  /**
   * The lists and nodes, as a save writes them (ADR 0019).
   *
   * Every reference stays a segment-plus-offset pair. Flattening one to a
   * number would restore a list whose nodes point at integers, which walks
   * without erroring and finds nothing.
   */
  saveLists(): Array<[number, [number, number], [number, number]]> {
    return [...this.lists].map(([id, list]) => [
      id,
      [list.first.segment, list.first.offset],
      [list.last.segment, list.last.offset],
    ]);
  }

  saveNodes(): Array<
    [number, [number, number], [number, number], [number, number], [number, number]]
  > {
    return [...this.nodes].map(([id, node]) => [
      id,
      [node.key.segment, node.key.offset],
      [node.value.segment, node.value.offset],
      [node.previous.segment, node.previous.offset],
      [node.next.segment, node.next.offset],
    ]);
  }

  restoreLists(saved: ReadonlyArray<[number, [number, number], [number, number]]>): void {
    this.lists.clear();
    for (const [id, first, last] of saved) {
      this.lists.set(id, { first: reg(first[0], first[1]), last: reg(last[0], last[1]) });
      this.next = Math.max(this.next, id + 1);
    }
  }

  restoreNodes(
    saved: ReadonlyArray<
      [number, [number, number], [number, number], [number, number], [number, number]]
    >,
  ): void {
    this.nodes.clear();
    for (const [id, key, value, previous, next] of saved) {
      this.nodes.set(id, {
        key: reg(key[0], key[1]),
        value: reg(value[0], value[1]),
        previous: reg(previous[0], previous[1]),
        next: reg(next[0], next[1]),
      });
      this.next = Math.max(this.next, id + 1);
    }
  }

  /** What the heap holds, for the diagnostic and for a save's own accounting. */
  describe(): string {
    return `${this.lists.size} lists, ${this.nodes.size} nodes, ${this.memory.size} blocks`;
  }
}
