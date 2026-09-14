/**
 * AGI's menu bar, which is a UI the game builds and the interpreter draws.
 *
 * A game declares it with `set.menu` and `set.menu.item`, closes the
 * declaration with `submit.menu`, and from then on every entry is a
 * **controller number** — the same currency `set.key` deals in. So a menu is
 * not a feature of the interpreter's own interface, the way SCUMM's verb panel
 * is: it is the game's own interface, and the interpreter's job is to draw it
 * and hand back which entry was chosen (ADR 0011's reasoning, one family
 * along).
 *
 * **Why it had to be built rather than left as a controller alias.** The engine
 * used to log `submit.menu` as unimplemented, on the argument that "every
 * controller a menu would fire is also reachable from `set.key`". That is true
 * of some games and not of King's Quest III: its File menu is the only route to
 * Save, Restore, Restart and Quit — `Save  <F5>` names a key beside the entry,
 * but the binding is the *menu's*, not a `set.key`, so the key does nothing on
 * its own. A player could reach none of the four.
 *
 * Kept out of `AgiEngine` because it is a small state machine with a cursor in
 * it, and because what it decides — which controller fired — is the only thing
 * the engine needs back.
 */

import { GLYPH_HEIGHT, TEXT_COLUMNS, drawText } from './gfx/AgiFont.js';

/** One entry of one menu. */
export interface AgiMenuItem {
  readonly text: string;
  /** The controller `menu.input` fires when this is chosen. */
  readonly controller: number;
}

/** One menu on the bar, and the entries under it. */
export interface AgiMenuColumn {
  readonly text: string;
  readonly items: AgiMenuItem[];
  /** Where the title starts on the bar, in characters. */
  column: number;
}

/**
 * A separator, which is an item and is not choosable.
 *
 * Sierra wrote them as a row of hyphens with a controller number like any
 * other, so there is no flag to read: the text is the evidence. A menu that let
 * one be chosen would fire a controller the game bound to nothing and look, to
 * a player, like a menu entry that does nothing.
 */
function isSeparator(item: AgiMenuItem): boolean {
  const trimmed = item.text.trim();
  return trimmed.length > 0 && /^-+$/.test(trimmed);
}

export class AgiMenu {
  private readonly columns: AgiMenuColumn[] = [];
  /** Whether `submit.menu` has been reached, which is what makes it usable. */
  private submitted = false;
  /** The open menu and the entry the cursor is on, or null when closed. */
  private cursor: { column: number; item: number } | null = null;

  /** `set.menu` — starts a new column, which the items after it belong to. */
  addColumn(text: string): void {
    // Declared after `submit.menu` means a game is rebuilding the bar, which
    // Sierra's own interpreter allows: the second declaration replaces the
    // first rather than appending to it.
    if (this.submitted) {
      this.columns.length = 0;
      this.submitted = false;
    }
    this.columns.push({ text, items: [], column: 0 });
  }

  /** `set.menu.item` — an entry under the column most recently declared. */
  addItem(text: string, controller: number): void {
    const column = this.columns[this.columns.length - 1];
    // An item before any `set.menu` is a game bug rather than ours, and
    // dropping it is better than inventing a column to hold it.
    if (!column) return;
    column.items.push({ text, controller });
  }

  /**
   * `submit.menu` — the bar is complete, so lay it out and make it usable.
   *
   * The titles are spaced out along the bar the way Sierra's are: one column of
   * padding at the left, then each title with a space either side.
   */
  submit(): void {
    let at = 1;
    for (const column of this.columns) {
      column.column = at;
      at += column.text.length + 1;
    }
    this.submitted = true;
  }

  /** Whether there is a menu to open at all. */
  get available(): boolean {
    return this.submitted && this.columns.some((column) => column.items.length > 0);
  }

  get open(): boolean {
    return this.cursor !== null;
  }

  /** Opens on the first column, on its first choosable entry. */
  show(): void {
    if (!this.available) return;
    const column = this.columns.findIndex((entry) => entry.items.length > 0);
    this.cursor = { column: Math.max(0, column), item: 0 };
    this.settle(1);
  }

  close(): void {
    this.cursor = null;
  }

  /**
   * Moves the cursor and, on Enter, answers with the controller chosen.
   *
   * Returns `'closed'` for Escape, a controller number for a choice, and null
   * for a move — three outcomes rather than a flag, because the caller has to
   * do something different for each and a boolean would need a second question
   * afterwards.
   *
   * `disabled` is asked rather than stored: a script calls `disable.item`
   * between one opening of the menu and the next, so a copy taken at
   * `submit.menu` would be stale exactly when it mattered.
   */
  key(code: number, disabled: (controller: number) => boolean): number | 'closed' | null {
    if (!this.cursor) return null;
    const ascii = code & 0xff;
    const scan = (code >> 8) & 0xff;

    if (ascii === KEY_ESCAPE) {
      this.close();
      return 'closed';
    }
    if (ascii === KEY_ENTER) {
      const item = this.itemAt(this.cursor);
      this.close();
      if (!item || isSeparator(item) || disabled(item.controller)) return 'closed';
      return item.controller;
    }

    if (scan === SCAN_LEFT) this.moveColumn(-1);
    else if (scan === SCAN_RIGHT) this.moveColumn(1);
    else if (scan === SCAN_UP) this.moveItem(-1);
    else if (scan === SCAN_DOWN) this.moveItem(1);
    return null;
  }

  private itemAt(cursor: { column: number; item: number }): AgiMenuItem | undefined {
    return this.columns[cursor.column]?.items[cursor.item];
  }

  /**
   * Leaves the cursor on something choosable, without moving it first.
   *
   * Split from the movement below because the two callers want opposite
   * things: a key press has to *move* and then skip separators, and an opening
   * of the menu has to skip separators *where it already is*. One function
   * doing both, told apart by a direction of zero, checked the current entry
   * before moving — so an arrow key on a choosable entry moved nowhere at all,
   * and King's Quest III's File menu would not walk down past Save.
   */
  private settle(direction: 1 | -1): void {
    const cursor = this.cursor;
    const entries = cursor ? (this.columns[cursor.column]?.items ?? []) : [];
    if (!cursor || entries.length === 0) return;
    for (let tried = 0; tried < entries.length; tried++) {
      if (!isSeparator(entries[cursor.item])) return;
      cursor.item = (cursor.item + direction + entries.length) % entries.length;
    }
  }

  /** One entry up or down, wrapping, then past any separators in the way. */
  private moveItem(direction: 1 | -1): void {
    const cursor = this.cursor;
    const entries = cursor ? (this.columns[cursor.column]?.items ?? []) : [];
    if (!cursor || entries.length === 0) return;
    cursor.item = (cursor.item + direction + entries.length) % entries.length;
    this.settle(direction);
  }

  /** One column left or right, skipping any that declared no entries. */
  private moveColumn(direction: 1 | -1): void {
    const cursor = this.cursor;
    if (!cursor || this.columns.length === 0) return;
    for (let tried = 0; tried < this.columns.length; tried++) {
      cursor.column = (cursor.column + direction + this.columns.length) % this.columns.length;
      if (this.columns[cursor.column].items.length > 0) break;
    }
    cursor.item = 0;
    this.settle(1);
  }

  /** Every column, for a report or a test. */
  describe(): Array<{ text: string; items: string[] }> {
    return this.columns.map((column) => ({
      text: column.text,
      items: column.items.map((item) => item.text),
    }));
  }

  /**
   * Draws the bar, and the open column under it.
   *
   * On the status row, because that is where AGI puts it — the bar replaces the
   * score line while the menu is up, which is why the score is not drawn
   * underneath it.
   */
  draw(
    pixels: Uint8Array,
    width: number,
    height: number,
    disabled: (controller: number) => boolean,
  ): void {
    if (!this.cursor) return;

    let bar = ' '.repeat(TEXT_COLUMNS);
    for (const column of this.columns) {
      bar =
        bar.slice(0, column.column) + column.text + bar.slice(column.column + column.text.length);
    }
    drawText(pixels, width, height, 0, 0, bar.slice(0, TEXT_COLUMNS), 0, 15);

    const active = this.columns[this.cursor.column];
    if (!active) return;
    // The open title is inverted on the bar, so which column is open is visible
    // even before the drop-down is read.
    drawText(pixels, width, height, active.column * 8, 0, active.text, 15, 0);

    const entries = active.items;
    const boxWidth = Math.max(...entries.map((item) => item.text.length), 1);
    const left = Math.min(active.column, Math.max(0, TEXT_COLUMNS - boxWidth)) * 8;

    for (const [index, item] of entries.entries()) {
      const top = (index + 1) * GLYPH_HEIGHT;
      if (top + GLYPH_HEIGHT > height) break;
      const chosen = index === this.cursor.item;
      // A disabled entry is drawn in grey rather than hidden: a game disables
      // Save during a cutscene, and an entry that vanished would move every
      // entry under it.
      const foreground = disabled(item.controller) ? 7 : 0;
      drawText(
        pixels,
        width,
        height,
        left,
        top,
        item.text.padEnd(boxWidth),
        chosen ? 15 : foreground,
        chosen ? 0 : 15,
      );
    }
  }
}

const KEY_ESCAPE = 0x1b;
const KEY_ENTER = 0x0d;
const SCAN_UP = 72;
const SCAN_DOWN = 80;
const SCAN_LEFT = 75;
const SCAN_RIGHT = 77;
