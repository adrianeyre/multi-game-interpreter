/**
 * Where a click means something.
 *
 * The interesting fact about AGOS's interface is that **it is data**. Simon's
 * verb list, his inventory grid, the arrows beside it and every clickable thing
 * in a room are boxes the game's own Subroutines define at runtime with
 * `o_addBox`, each carrying the verb it stands for and the item it refers to.
 * Nothing about the layout is in the interpreter.
 *
 * That is why ADR 0027's "three interfaces, one family" is less frightening than
 * it sounds: Elvira's menus, Simon's verb bar and Feeble's interface differ in
 * what their scripts define, not in what the engine has to know. A hit test is
 * the same operation in all three, and this table is the whole of it.
 *
 * The id carries flags in its thousands digit — `id / 1000` is a flag set and
 * `id % 1000` is the actual id — which is the sort of thing that reads as a bug
 * until you have seen it done deliberately.
 */

/** Flags a box's id carries, in its thousands digit. */
export const BOX_FLAGS = {
  invertTouch: 1,
  noTouchName: 2,
  boxItem: 4,
  textBox: 8,
  dragBox: 16,
} as const;

export interface HitArea {
  readonly id: number;
  x: number;
  y: number;
  readonly width: number;
  readonly height: number;
  /** The item this box refers to, as an item number; 0 for none. */
  readonly item: number;
  /** The verb a click on it means. */
  readonly verb: number;
  readonly flags: number;
  /**
   * Which box wins where two overlap, highest first.
   *
   * `defineBox` sets `ha->priority = id` in the reference (`verb.cpp`), and
   * `boxController` keeps the box with the greatest priority under the pointer
   * — so a room's clickable things, defined with larger ids, sit *in front of*
   * the room-floor box (id 0) that covers the whole screen behind them. See
   * {@link HitAreaTable.at}.
   */
  readonly priority: number;
  enabled: boolean;
}

export class HitAreaTable {
  private readonly areas = new Map<number, HitArea>();

  /**
   * Defines a box.
   *
   * `rawId` is the id as the script wrote it, flags and all, because splitting
   * it at the boundary is the only place that split can be got right once.
   */
  add(
    rawId: number,
    x: number,
    y: number,
    width: number,
    height: number,
    item: number,
    verb: number,
  ): HitArea {
    const flags = Math.floor(rawId / 1000);
    const id = rawId % 1000;
    // `ha->id = ha->priority = id` in the reference's `defineBox`: a box's
    // priority is its id unless something later changes it, and nothing in the
    // Simon interfaces does.
    const area: HitArea = {
      id,
      x,
      y,
      width,
      height,
      item,
      verb,
      flags,
      priority: id,
      enabled: true,
    };
    this.areas.set(id, area);
    return area;
  }

  remove(id: number): void {
    this.areas.delete(id % 1000);
  }

  setEnabled(id: number, enabled: boolean): void {
    const area = this.areas.get(id % 1000);
    if (area) area.enabled = enabled;
  }

  move(id: number, dx: number, dy: number): void {
    const area = this.areas.get(id % 1000);
    if (!area) return;
    area.x += dx;
    area.y += dy;
  }

  has(id: number): boolean {
    return this.areas.has(id % 1000);
  }

  /**
   * The box with an id, whether or not it is live.
   *
   * Disabled boxes are included where {@link at} skips them, because this
   * answers a question about the *interface* rather than about a click: the
   * reference's `findBox` is how `resetVerbs` reads the verb the strip's first
   * box carries, and a disabled box there means "no default verb" rather than
   * "look further".
   */
  find(id: number): HitArea | undefined {
    return this.areas.get(id % 1000);
  }

  get size(): number {
    return this.areas.size;
  }

  /**
   * The box under a point, or undefined.
   *
   * The highest-priority box wins, which is the reference's `boxController`:
   * it keeps the greatest `priority` under the pointer rather than the last one
   * it happens to find. Priority is the box id (see {@link HitArea.priority}),
   * so a room's clickable things (larger ids) sit in front of the room-floor
   * box that covers the whole screen — without this a click on the scenery hit
   * the floor behind it and Simon only ever walked. Ties keep the later box,
   * matching the reference's `priority <= ha->priority`. Disabled boxes are
   * skipped rather than removed, because a script re-enables them by id.
   */
  at(x: number, y: number): HitArea | undefined {
    let found: HitArea | undefined;
    for (const area of this.areas.values()) {
      if (!area.enabled) continue;
      if (x < area.x || y < area.y) continue;
      if (x >= area.x + area.width || y >= area.y + area.height) continue;
      if (!found || area.priority >= found.priority) found = area;
    }
    return found;
  }

  all(): HitArea[] {
    return [...this.areas.values()];
  }
}
