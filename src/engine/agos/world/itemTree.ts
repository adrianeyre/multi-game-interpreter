/**
 * AGOS's world: one global tree of items.
 *
 * `CONTEXT.md` calls this the **Item tree**, and ADR 0029 makes it first-class
 * structure in a Project rather than data the editor shows and does not model.
 * The reason is short: an instruction names *item 217*, and only the tree says
 * what 217 is. Without it, AGOS bytecode is unreadable in the strict sense —
 * every operand is a number with no referent.
 *
 * It is not a room graph. Rooms, objects, the player and abstractions that are
 * none of those all sit in one tree linked by parent, child and sibling, and
 * what an item *is* comes from the typed sub-structures hanging off it rather
 * than from where it sits. An item with a room sub-structure is a room.
 *
 * ## Everything here keeps its bytes
 *
 * ADR 0030 rebuilds `GAMEPC` whole because it has no index to substitute
 * through, so the model has to be able to write back what it read — including
 * the fields the interpreter discards. Item links are therefore kept as the raw
 * 32-bit values on disk, with `itemIdOf` applying the mapping rather than the
 * reader baking it in. A model that stored only the meaning could not produce
 * the file again.
 */

/** The typed sub-structures an item can carry. Elvira 1 and later disagree about 4. */
export const ITEM_CHILD_TYPES = {
  room: 1,
  object: 2,
  /** Elvira 1 only. */
  genExit: 4,
  /** Elvira 2 only, and the same number as `genExit` — the Version tells them apart. */
  superRoom: 4,
  container: 7,
  chain: 8,
  userFlag: 9,
  inherit: 255,
} as const;

/**
 * A link to another item, as it sits on disk.
 *
 * 0xFFFFFFFF means "nothing"; anything else is two less than the item number it
 * names, because the first two items are predefined and the file's numbering
 * starts after them.
 */
export interface RawItemId {
  readonly raw: number;
}

/** The item number a raw link refers to, or 0 for none. */
export function itemIdOf(link: RawItemId): number {
  return link.raw === 0xffffffff ? 0 : link.raw + 2;
}

/** A raw link naming an item number, for writing one back. */
export function linkTo(itemId: number): RawItemId {
  return { raw: itemId === 0 ? 0xffffffff : itemId - 2 };
}

/**
 * One typed sub-structure.
 *
 * Held as its type and the values read, in order, rather than as a named record
 * per kind. That is a deliberate flattening: the layouts differ per Version in
 * ways that are counted rather than fixed — an Elvira 2 room's exits are sized
 * by counting two-bit fields in a mask, and an object's flag values by counting
 * set bits — so a per-kind record would need a per-Version variant of every
 * kind. The mask is kept beside the values, which is what makes them writable
 * again.
 */
export interface AgosItemChild {
  readonly type: number;
  /** The mask or header word that decides how many values follow, where there is one. */
  readonly header?: readonly number[];
  readonly values: readonly number[];
  /** Values that are item links rather than plain numbers, by index into `values`. */
  readonly links?: readonly number[];
}

export interface AgosItem {
  /** Elvira 1 and 2 only: a 32-bit name id ahead of the adjective. */
  readonly itemName?: number;
  readonly adjective: number;
  readonly noun: number;
  readonly state: number;
  /** Elvira 1's word between `state` and `next`, kept so the file can be written back. */
  readonly statePadding?: number;
  readonly next: RawItemId;
  readonly child: RawItemId;
  readonly parent: RawItemId;
  /** The words between `parent` and `classFlags`: three in Elvira 1, one otherwise. */
  readonly trailing: readonly number[];
  readonly classFlags: number;
  /** The 32-bit word that says whether any sub-structures follow. */
  readonly childrenLead: number;
  readonly children: readonly AgosItemChild[];
}

export interface AgosItemTree {
  /** Items by number. Index 0 and 1 are the predefined pair and are not in the file. */
  readonly items: readonly AgosItem[];
  /** The number of items the file said it had initialised. */
  readonly initedCount: number;
  /** The number of items the file said it had room for. */
  readonly arraySize: number;
}

/** The items whose parent is `parent`, in the order the sibling chain gives them. */
export function childrenOf(tree: AgosItemTree, parent: number): number[] {
  const found: number[] = [];
  for (let id = 0; id < tree.items.length; id += 1) {
    const item = tree.items[id];
    if (item && itemIdOf(item.parent) === parent) found.push(id);
  }
  return found;
}

/** The sub-structure of a given type on an item, if it has one. */
export function childOfType(item: AgosItem, type: number): AgosItemChild | undefined {
  return item.children.find((child) => child.type === type);
}
