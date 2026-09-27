/**
 * SCI16's pull-down menu bar and the status line it shares the top of the
 * screen with.
 *
 * **Why the interpreter owns this and not the game.** Almost everything a SCI
 * game shows is built by its own scripts (ADR 0011), and the menu bar is the
 * exception: SCI0 through SCI1.1 hand the interpreter a title and a packed
 * string per menu with `AddMenu`, and from then on the interpreter draws the
 * bar, runs the pull-down, and answers `MenuSelect` with `(menu << 8) | item`.
 * A game that got nought from all of this — which is what it got — has a
 * status line that never appears and a menu that ESC cannot open, and its
 * "Save", "Restore" and "Quit" are reachable only by typing.
 *
 * Transcribed from ScummVM's `GfxMenu` (`engines/sci/graphics/menu.cpp`) and
 * `kmenu.cpp`, fetched 2026-09-27. Three things are this engine's rather than
 * Sierra's, and each is said where it is done:
 *
 * - **the pull-down does not block the Kernel call.** Sierra's `MenuSelect`
 *   loops on the keyboard until the player chooses. A Kernel call here cannot
 *   wait, so `select` plays the interaction over whatever input is already
 *   queued and, when that runs out first, leaves the session open for the
 *   engine to feed between cycles — the answer then arrives on the next
 *   `MenuSelect`, which is the next event the game's own menu bar sees;
 * - **drawing is into two buffers the engine composites**, rather than into
 *   a screen with `bitsSave` and `bitsRestore` under it. Closing a menu is
 *   dropping the overlay, which is what the restore was for;
 * - **left-to-right only.** ScummVM's right-to-left branches serve Hebrew
 *   fan translations, and no release this project reads is one.
 */

import type { Reg } from '../script/PMachine.js';
import type { SciFontResource } from './SciFont.js';
import { drawSciText, sciTextWidth } from './SciText.js';

/** `SCI_MENU_ATTRIBUTE_*`, from `graphics/menu.h`. */
export const SCI_MENU_ATTRIBUTE = {
  said: 0x6d,
  text: 0x6e,
  keyPress: 0x6f,
  enabled: 0x70,
  tag: 0x71,
} as const;

/** The key codes and modifier bits the bar matches on, from `event.h`. */
const KEY = {
  tab: 9,
  enter: 13,
  esc: 27,
  up: 72 << 8,
  down: 80 << 8,
  left: 75 << 8,
  right: 77 << 8,
  f1: 59 << 8,
} as const;
const MOD_SHIFT = 0x03;
const MOD_CTRL = 0x04;
const MOD_ALT = 0x08;
const MOD_NON_STICKY = MOD_SHIFT | MOD_CTRL | MOD_ALT;

/** SCI's event types, as far as the bar reads them. */
const EVENT = { none: 0, mouseDown: 1, mouseUp: 2, keyDown: 4, said: 0x80, quit: 0x800 } as const;

/** The bar is the top nine rows, and the tenth is a black rule under it. */
export const SCI_MENU_BAR_HEIGHT = 10;
const BAR_ROWS = 9;

export interface SciMenu {
  id: number;
  title: string;
}

export interface SciMenuItem {
  menuId: number;
  id: number;
  enabled: boolean;
  tag: number;
  keyPress: number;
  keyModifier: number;
  separator: boolean;
  /** The said spec a typed sentence is matched against, or null. */
  said: Reg | null;
  text: string;
  /** Where the item's text sits inside the string `AddMenu` was handed. */
  textRef: Reg;
  rightText: string;
}

/** One event, as `MenuSelect` reads it off an Event object or the queue. */
export interface SciMenuEvent {
  type: number;
  message: number;
  modifiers: number;
  x: number;
  y: number;
}

/** A pixel rectangle the engine composites over the room. */
export interface SciMenuLayer {
  x: number;
  y: number;
  width: number;
  height: number;
  pixels: Uint8Array;
}

export interface SciMenuOptions {
  /** The font the menu port draws in, which is font 0. Null until it is read. */
  font: () => SciFontResource | null;
  /** 15 in sixteen colours and 255 in 256; `getColorWhite`. */
  white: number;
  /** The screen's width, which the bar spans. */
  width?: number;
}

interface Session {
  mode: 'keyboard' | 'mouse';
  /** Keyboard: the highlighted item. Mouse: the item under the pointer, if any. */
  current: SciMenuItem | null;
  /** Mouse only: which title the pointer last rested on, and which item. */
  menuId: number;
  itemId: number;
}

export type SciMenuResult =
  /** The interaction has ended; `item` is what was chosen, or null for none. */
  { done: true; item: SciMenuItem | null } | { done: false };

export class SciMenuBar {
  readonly menus: SciMenu[] = [];
  readonly items: SciMenuItem[] = [];
  /**
   * The status line as it stands, row-major, `width` by ten.
   *
   * Persistent: `DrawStatus` and `DrawMenuBar` write it and nothing clears it,
   * which is what a SCI0 score line is.
   */
  readonly status: Uint8Array;
  /** The bar and pull-down while a menu is open, drawn over `status`. */
  overlay: { bar: SciMenuLayer; dropdown: SciMenuLayer | null } | null = null;
  /** A choice made after `select` returned, handed to the next `select`. */
  pending: SciMenuItem | null = null;
  /** Whether a game has drawn the status line at all, so a game that never does keeps its rows. */
  statusShown = false;

  private readonly options: SciMenuOptions;
  private readonly width: number;
  /**
   * The menu and item a keyboard session opens on.
   *
   * ScummVM remembers the last one chosen where Sierra went back to the first
   * item of the first menu every time; ScummVM's comment says it does not
   * follow Sierra there and this follows ScummVM.
   */
  private curMenuId = 1;
  private curItemId = 1;
  private session: Session | null = null;
  private dropdownRect = { left: 0, top: 0, right: 0, bottom: 0 };

  constructor(options: SciMenuOptions) {
    this.options = options;
    this.width = options.width ?? 320;
    this.status = new Uint8Array(this.width * SCI_MENU_BAR_HEIGHT);
  }

  /** Whether a pull-down is open and waiting for input. */
  get open(): boolean {
    return this.session !== null;
  }

  // ------------------------------------------------------------- AddMenu ---

  /**
   * `AddMenu(title, content)` — one menu and every item in it.
   *
   * `kernelAddEntry`. The content is one string, items separated by `:`, and
   * each item can carry a right-aligned part after `` ` ``, a hot key after `^`
   * (Ctrl), `@` (Alt) or `#` (a function key, only once `` ` `` has been
   * reached — `#G` is a language separator before it), and a tag after `=`.
   * An item that is nothing but `-`, `!` and spaces is a separator line.
   */
  add(title: string, source: string, contentRef: Reg): void {
    const menuId = this.menus.length + 1;
    this.menus.push({ id: menuId, title });

    const content = source.split('');
    const size = content.length;
    let itemCount = 0;
    let at = 0;
    do {
      itemCount++;
      const item: SciMenuItem = {
        menuId,
        id: itemCount,
        enabled: true,
        tag: 0,
        keyPress: 0,
        keyModifier: 0,
        separator: false,
        said: null,
        text: '',
        textRef: contentRef,
        rightText: '',
      };
      const begin = at;
      let tagPos = 0;
      let rightPos = 0;
      let controlPos = 0;
      let altPos = 0;
      let functionPos = 0;
      while (at < size && content[at] !== ':') {
        switch (content[at]) {
          case '=':
            // A right-aligned "=" is the normal-speed item's label, not a tag.
            if (rightPos !== at - 1 && !tagPos) tagPos = at;
            break;
          case '`':
            rightPos = at;
            break;
          case '^':
            if (!controlPos) controlPos = at;
            break;
          case '@':
            if (!altPos) altPos = at;
            break;
          case '#':
            if (rightPos && !functionPos) functionPos = at;
            break;
        }
        at++;
      }
      const end = at;

      // The marker is replaced by what the bar shows in its place and the key
      // after it is upper-cased for display and lower-cased for matching.
      if (controlPos && controlPos + 1 < size) {
        content[controlPos] = '\x03';
        item.keyModifier = MOD_CTRL;
        item.keyPress = content[controlPos + 1].toLowerCase().charCodeAt(0);
        content[controlPos + 1] = content[controlPos + 1].toUpperCase();
      }
      if (altPos && altPos + 1 < size) {
        content[altPos] = '\x02';
        item.keyModifier = MOD_ALT;
        item.keyPress = content[altPos + 1].toLowerCase().charCodeAt(0);
        content[altPos + 1] = content[altPos + 1].toUpperCase();
      }
      if (functionPos && functionPos + 1 < size) {
        content[functionPos] = 'F';
        const digit = content[functionPos + 1];
        if (digit >= '1' && digit <= '9')
          item.keyPress = KEY.f1 + ((digit.charCodeAt(0) - 49) << 8);
        else if (digit === '0') item.keyPress = KEY.f1 + (9 << 8);
      }

      const textEnd = rightPos || tagPos || end;
      let separators = 0;
      for (let i = begin; i < textEnd; i++) {
        const character = content[i];
        if (character === '!' || character === '-' || character === ' ') separators++;
        else if (character === '%' || character === '#') {
          // Multilingual SCI01 writes "--!%G--!", which is still a separator.
          separators += 2;
          i++;
        }
      }
      if (separators === textEnd - begin) {
        item.separator = true;
      } else {
        item.text = content.slice(begin, textEnd).join('');
        // LSL6 writes "Ctrl-" where every other game writes "^".
        const ctrl = item.text.indexOf('Ctrl-');
        if (ctrl >= 0 && ctrl + 5 < item.text.length) {
          item.keyModifier = MOD_CTRL;
          item.keyPress = item.text[ctrl + 5].toLowerCase().charCodeAt(0);
        }
      }
      item.textRef = { segment: contentRef.segment, offset: contentRef.offset + begin };

      if (rightPos) {
        const from = rightPos + 1;
        const to = tagPos && tagPos >= from ? tagPos : end;
        let right = content.slice(from, to).join('');
        if (right.endsWith(' ')) right = right.slice(0, -1);
        if (right === '-' || right === '+' || right === '=') item.keyPress = right.charCodeAt(0);
        // "#0" became "F0", and F10 is three characters where "#0" was two.
        if (item.keyPress === KEY.f1 + (9 << 8)) right = right.replace('F0', 'F10');
        item.rightText = right;
      }
      if (tagPos) {
        // Sierra's own offset, `functionPos + 1`, which is a bug ScummVM keeps
        // for fidelity: the tag is read from after the function marker, and
        // from the start of the string when there is none.
        item.tag = parseInt(content.slice(functionPos + 1).join(''), 10) || 0;
      }

      at = end + 1;
      this.items.push(item);
    } while (at < size);
  }

  find(menuId: number, itemId: number): SciMenuItem | null {
    return this.items.find((item) => item.menuId === menuId && item.id === itemId) ?? null;
  }

  /**
   * `SetMenu(menu << 8 | item, attribute, value, ...)`.
   *
   * An item that is not there is ignored rather than refused, which is what
   * Sierra did and what the PQ2 demo relies on: it sets attributes on a menu
   * it never built.
   */
  setAttribute(menuId: number, itemId: number, attribute: number, value: Reg, text: string): void {
    const item = this.find(menuId, itemId);
    if (!item) return;
    switch (attribute) {
      case SCI_MENU_ATTRIBUTE.enabled:
        item.enabled = value.segment !== 0 || value.offset !== 0;
        break;
      case SCI_MENU_ATTRIBUTE.said:
        item.said = value;
        break;
      case SCI_MENU_ATTRIBUTE.text:
        item.text = text;
        item.textRef = value;
        break;
      case SCI_MENU_ATTRIBUTE.keyPress:
        item.keyPress = String.fromCharCode(value.offset & 0xff)
          .toLowerCase()
          .charCodeAt(0);
        item.keyModifier = 0;
        break;
      case SCI_MENU_ATTRIBUTE.tag:
        item.tag = value.offset;
        break;
    }
  }

  /** `GetMenu(menu << 8 | item, attribute)`, or null for an item or attribute there is not. */
  getAttribute(menuId: number, itemId: number, attribute: number): Reg | null {
    const item = this.find(menuId, itemId);
    if (!item) return null;
    switch (attribute) {
      case SCI_MENU_ATTRIBUTE.enabled:
        return { segment: 0, offset: item.enabled ? 1 : 0 };
      case SCI_MENU_ATTRIBUTE.said:
        return item.said ?? { segment: 0, offset: 0 };
      case SCI_MENU_ATTRIBUTE.text:
        return item.textRef;
      case SCI_MENU_ATTRIBUTE.keyPress:
        return { segment: 0, offset: item.keyPress };
      case SCI_MENU_ATTRIBUTE.tag:
        return { segment: 0, offset: item.tag };
      default:
        return null;
    }
  }

  // ------------------------------------------------ DrawStatus, DrawMenuBar ---

  /**
   * `DrawStatus(text, pen, back)` — the status line.
   *
   * `kernelDrawStatus`: the nine rows filled with `back`, the text at (0, 1) in
   * `pen`, and the tenth row black. ScummVM's comment says Sierra never drew
   * that rule and it draws it anyway, because Dr. Brain's Mac release paints
   * over it; it is drawn here for the same reason.
   */
  drawStatus(text: string, pen: number, back: number): void {
    this.statusShown = true;
    this.fillStatus(back);
    const font = this.options.font();
    if (font && text !== '') {
      drawSciText(this.status, this.width, BAR_ROWS, font, text, { x: 0, y: 1, colour: pen });
    }
    this.status.fill(0, BAR_ROWS * this.width, SCI_MENU_BAR_HEIGHT * this.width);
  }

  /** `DrawMenuBar(show)` — the titles, or with `show` null, a blank black bar. */
  drawMenuBar(show: boolean): void {
    if (!show) {
      this.drawStatus('', 0, 0);
      return;
    }
    this.statusShown = true;
    this.drawBar(this.status);
  }

  private fillStatus(colour: number): void {
    this.status.fill(colour & 0xff, 0, BAR_ROWS * this.width);
  }

  /** `drawBar`: white, a black rule, the titles from x 8 in black. */
  private drawBar(target: Uint8Array): void {
    target.fill(this.options.white, 0, BAR_ROWS * this.width);
    target.fill(0, BAR_ROWS * this.width, SCI_MENU_BAR_HEIGHT * this.width);
    const font = this.options.font();
    if (!font) return;
    let x = 8;
    for (const menu of this.menus) {
      drawSciText(target, this.width, BAR_ROWS, font, menu.title, { x, y: 1, colour: 0 });
      x += sciTextWidth(font, menu.title);
    }
  }

  // ------------------------------------------------------------ MenuSelect ---

  /**
   * `MenuSelect(event, pauseSound)` — which item, if any, this event chooses.
   *
   * `GfxMenu::kernelSelect`. A key is matched against each enabled item's hot
   * key and modifier; ESC opens the bar for the keyboard. A typed sentence is
   * matched against each enabled item's said spec, through `said`. A press on
   * the top ten rows opens it for the mouse.
   *
   * `drain` hands over what is already queued, so an interaction the player
   * has finished typing resolves inside this call as Sierra's did. `claimed`
   * is ScummVM's `forceClaimed` or a match, and is what the caller writes
   * back to the event.
   */
  select(
    event: SciMenuEvent,
    drain: () => SciMenuEvent | null,
    said: (spec: Reg) => boolean,
  ): { claimed: boolean; item: SciMenuItem | null } {
    // A choice made while the scripts were held, which this is the first
    // event since. It answers whatever the event was.
    if (this.pending) {
      const item = this.pending;
      this.pending = null;
      return { claimed: true, item };
    }

    let item: SciMenuItem | null = null;
    let forceClaimed = false;

    if (event.type === EVENT.keyDown) {
      let key = event.message;
      let modifiers = event.modifiers;
      // Ctrl+letter arrives as a control character, and the bar matches on
      // the printable letter it was.
      if ((modifiers & MOD_NON_STICKY) === MOD_CTRL && key > 0 && key < 27) key += 96;
      if (key === KEY.esc) {
        forceClaimed = true;
        item = this.play('keyboard', event, drain);
      } else if (key !== 0) {
        // Tab and Ctrl+I are one character, and the match checks modifiers.
        if (key === KEY.tab) {
          modifiers = MOD_CTRL;
          key = 'i'.charCodeAt(0);
        }
        modifiers &= 0xff;
        item =
          this.items.find(
            (entry) => entry.keyPress === key && entry.keyModifier === modifiers && entry.enabled,
          ) ?? null;
      }
    } else if (event.type === EVENT.said) {
      item = this.items.find((entry) => entry.enabled && entry.said && said(entry.said)) ?? null;
    } else if (event.type === EVENT.mouseDown && event.y < SCI_MENU_BAR_HEIGHT) {
      forceClaimed = true;
      item = this.play('mouse', event, drain);
    }

    return { claimed: forceClaimed || item !== null, item };
  }

  /** Opens a session and plays it over the queue, for as long as the queue lasts. */
  private play(
    mode: 'keyboard' | 'mouse',
    opening: SciMenuEvent,
    drain: () => SciMenuEvent | null,
  ): SciMenuItem | null {
    if (!this.begin(mode, opening)) return null;
    for (let event = drain(); event; event = drain()) {
      const result = this.feed(event);
      if (result.done) return result.item;
    }
    return null;
  }

  /**
   * Starts an interaction. False when there is nothing to open, which is a
   * game with no menus: Sierra's code would dereference a missing item.
   */
  begin(mode: 'keyboard' | 'mouse', opening: SciMenuEvent): boolean {
    if (this.items.length === 0) return false;
    const bar = this.layer(0, 0, this.width, SCI_MENU_BAR_HEIGHT);
    this.drawBar(bar.pixels);
    this.overlay = { bar, dropdown: null };

    if (mode === 'keyboard') {
      const current =
        this.find(this.curMenuId, this.curItemId) ??
        this.items.find((item) => !item.separator) ??
        null;
      if (!current) {
        this.overlay = null;
        return false;
      }
      this.session = { mode, current, menuId: current.menuId, itemId: current.id };
      this.drawMenu(0, current.menuId);
      this.invertItem(current.id);
      return true;
    }

    this.session = { mode, current: null, menuId: 0, itemId: 0 };
    // The press that opened the bar is where the pointer is, and Sierra's loop
    // reads the pointer before it reads anything else.
    this.track(opening);
    return true;
  }

  /**
   * One event into an open session.
   *
   * Mouse sessions follow the pointer on every event, including a queue that
   * has none — `interactiveWithMouse` reads `mousePos` off a null event too —
   * so the engine feeds `{ type: 0 }` with the pointer's position between
   * cycles.
   */
  feed(event: SciMenuEvent): SciMenuResult {
    const session = this.session;
    if (!session) return { done: true, item: null };
    if (event.type === EVENT.quit) return this.finish(null);
    return session.mode === 'keyboard' ? this.feedKeyboard(session, event) : this.feedMouse(event);
  }

  /** Ends the session and takes the pull-down off the screen. */
  close(): void {
    this.session = null;
    this.overlay = null;
  }

  private finish(item: SciMenuItem | null): SciMenuResult {
    this.close();
    return { done: true, item };
  }

  private feedKeyboard(session: Session, event: SciMenuEvent): SciMenuResult {
    const current = session.current as SciMenuItem;
    if (event.type === EVENT.mouseDown) return this.keyboardClick(session, event);
    if (event.type !== EVENT.keyDown) return { done: false };

    let key = event.message;
    let menuId = current.menuId;
    let itemId = current.id;
    let next = current;
    // ScummVM's loop: a move that lands on a separator repeats, and a left or
    // right that did so repeats as a down so it does not skip a whole menu.
    for (let guard = 0; guard < 256; guard++) {
      switch (key) {
        case KEY.esc:
          this.curMenuId = current.menuId;
          this.curItemId = current.id;
          return this.finish(null);
        case KEY.enter:
          if (current.enabled) {
            this.curMenuId = current.menuId;
            this.curItemId = current.id;
            return this.finish(current);
          }
          break;
        case KEY.left:
          menuId -= 1;
          itemId = 1;
          break;
        case KEY.right:
          menuId += 1;
          itemId = 1;
          break;
        case KEY.up:
          itemId--;
          break;
        case KEY.down:
          itemId++;
          break;
      }
      if (menuId !== current.menuId || itemId !== current.id) {
        next = this.itemFor(menuId, itemId, menuId !== current.menuId) ?? current;
        menuId = next.menuId;
        itemId = next.id;
        if (key === KEY.left || key === KEY.right) key = KEY.down;
      }
      if (!next.separator) break;
    }

    if (next !== current) {
      if (next.menuId !== current.menuId) this.drawMenu(current.menuId, next.menuId);
      else this.invertItem(current.id);
      this.invertItem(next.id);
      session.current = next;
    }
    return { done: false };
  }

  /** A click while the keyboard has the bar, which ScummVM allows and Sierra did not. */
  private keyboardClick(session: Session, event: SciMenuEvent): SciMenuResult {
    const current = session.current as SciMenuItem;
    if (event.y < SCI_MENU_BAR_HEIGHT) {
      const menuId = this.titleAt(event.x);
      if (!menuId) return { done: false };
      const next = this.itemFor(menuId, 1, menuId !== current.menuId);
      if (!next) return { done: false };
      if (menuId !== current.menuId) this.drawMenu(current.menuId, menuId);
      else this.invertItem(current.id);
      this.invertItem(next.id);
      session.current = next;
      return { done: false };
    }
    const itemId = this.itemAt(event.x, event.y, current.menuId);
    if (itemId) {
      const chosen = this.itemFor(current.menuId, itemId, false);
      if (chosen && chosen.enabled && !chosen.separator) {
        this.curMenuId = chosen.menuId;
        this.curItemId = chosen.id;
        return this.finish(chosen);
      }
    }
    return { done: false };
  }

  private feedMouse(event: SciMenuEvent): SciMenuResult {
    const session = this.session as Session;
    if (event.type === EVENT.mouseUp) {
      const chosen = session.current;
      if (!session.menuId || !session.itemId || !chosen) return this.finish(null);
      if (!chosen.enabled || chosen.separator) return this.finish(null);
      return this.finish(chosen);
    }
    this.track(event);
    return { done: false };
  }

  /** `interactiveWithMouse`'s tail: follow the pointer across titles and items. */
  private track(event: SciMenuEvent): void {
    const session = this.session as Session;
    let menuId = session.menuId;
    let itemId: number;
    if (event.y < SCI_MENU_BAR_HEIGHT) {
      menuId = this.titleAt(event.x);
      itemId = 0;
    } else {
      itemId = this.itemAt(event.x, event.y, menuId);
      session.current = this.itemFor(session.menuId, itemId, false);
    }
    if (itemId !== session.itemId) {
      this.invertItem(session.itemId);
      this.invertItem(itemId);
      session.itemId = itemId;
    }
    if (menuId !== session.menuId) {
      this.drawMenu(session.menuId, menuId);
      session.menuId = menuId;
    }
  }

  /**
   * `interactiveGetItem`: the item asked for, or the menu's first — its last
   * when stepping upward past the top or when the menu has just changed.
   * Menu numbers wrap at both ends.
   */
  private itemFor(menuId: number, itemId: number, menuChanged: boolean): SciMenuItem | null {
    let menu = menuId;
    if (menu > this.menus.length) menu = 1;
    if (menu === 0) menu = this.menus.length;
    let first: SciMenuItem | null = null;
    let last: SciMenuItem | null = null;
    for (const item of this.items) {
      if (item.menuId !== menu) continue;
      if (item.id === itemId) return item;
      if (!first) first = item;
      if (!last || item.id > last.id) last = item;
    }
    return itemId === 0 || menuChanged ? last : first;
  }

  /** `mouseFindMenuSelection`: which title spans this x, from x 8. */
  private titleAt(x: number): number {
    const font = this.options.font();
    if (!font) return 0;
    let left = 8;
    for (const menu of this.menus) {
      const width = sciTextWidth(font, menu.title);
      if (x >= left && x < left + width) return menu.id;
      left += width;
    }
    return 0;
  }

  /** `mouseFindMenuItemSelection`: which row of the open pull-down this is. */
  private itemAt(x: number, y: number, menuId: number): number {
    if (!menuId) return 0;
    if (x < this.dropdownRect.left || x >= this.dropdownRect.right) return 0;
    const height = this.lineHeight();
    let bottom = SCI_MENU_BAR_HEIGHT;
    for (const item of this.items) {
      if (item.menuId !== menuId) continue;
      bottom += height;
      if (bottom > y) return item.id;
    }
    return 0;
  }

  private lineHeight(): number {
    return this.options.font()?.lineHeight ?? 8;
  }

  /**
   * `drawMenu`: the old title un-highlighted, the new one highlighted, and
   * the new pull-down under it. Menu 0 is none.
   */
  private drawMenu(oldMenuId: number, newMenuId: number): void {
    const overlay = this.overlay;
    const font = this.options.font();
    if (!overlay || !font) return;

    // Titles are laid out from x 7 and highlighted one pixel to the right.
    let right = 7;
    let menuLeft = 0;
    for (const menu of this.menus) {
      const left = right;
      right += sciTextWidth(font, menu.title);
      if (menu.id === newMenuId) menuLeft = left;
      if (menu.id === newMenuId || menu.id === oldMenuId) {
        this.invert(overlay.bar, left + 1, 0, right + 1, BAR_ROWS);
      }
    }

    if (!newMenuId) {
      overlay.dropdown = null;
      return;
    }

    const height = this.lineHeight();
    const entries = this.items.filter((item) => item.menuId === newMenuId);
    let widest = 0;
    let widestRight = 0;
    for (const item of entries) {
      widest = Math.max(widest, sciTextWidth(font, item.text));
      widestRight = Math.max(widestRight, sciTextWidth(font, item.rightText));
    }
    const top = BAR_ROWS;
    const bottom = top + 2 + entries.length * height;
    let left = menuLeft;
    let rightEdge = left + 16 + 4 + 2 + widest + widestRight - (widestRight ? 0 : 5);
    // Pushed back on screen when it would run off the right, as multilingual
    // SQ3 and LSL3 need.
    if (rightEdge > this.width) {
      left -= rightEdge - this.width;
      rightEdge = this.width;
    }
    this.dropdownRect = { left, top, right: rightEdge, bottom };

    const layer = this.layer(left, top, rightEdge - left, bottom - top);
    layer.pixels.fill(0);
    for (let y = 0; y < layer.height - 1; y++) {
      layer.pixels.fill(this.options.white, y * layer.width + 1, (y + 1) * layer.width - 1);
    }
    let rowTop = 1;
    for (const item of entries) {
      if (item.separator) {
        // Every other pixel across, half a line down: ScummVM's own drawing,
        // which it says reads better than Sierra's.
        const y = rowTop + (height >> 1) - 1;
        for (let x = 2; x < layer.width - 1; x += 2) layer.pixels[y * layer.width + x] = 0;
      } else {
        // A disabled item is drawn grey in Sierra's; there is no grey in a
        // two-colour bar, so this dithers the ink, which is how
        // `textGreyedOutput` looks on an EGA screen.
        this.drawItemText(layer, font, item.text, 9, rowTop, !item.enabled);
        const rightWidth = sciTextWidth(font, item.rightText);
        this.drawItemText(
          layer,
          font,
          item.rightText,
          layer.width - 1 - rightWidth - 5,
          rowTop,
          !item.enabled,
        );
      }
      rowTop += height;
    }
    overlay.dropdown = layer;
  }

  private drawItemText(
    layer: SciMenuLayer,
    font: SciFontResource,
    text: string,
    x: number,
    y: number,
    grey: boolean,
  ): void {
    if (text === '') return;
    if (!grey) {
      drawSciText(layer.pixels, layer.width, layer.height, font, text, { x, y, colour: 0 });
      return;
    }
    const scratch = new Uint8Array(layer.pixels.length).fill(1);
    drawSciText(scratch, layer.width, layer.height, font, text, { x, y, colour: 0 });
    for (let index = 0; index < scratch.length; index++) {
      const px = index % layer.width;
      const py = Math.floor(index / layer.width);
      if (scratch[index] === 0 && (px + py) % 2 === 0) layer.pixels[index] = 0;
    }
  }

  /** `invertMenuSelection`: one row of the pull-down, pen and back swapped. */
  private invertItem(itemId: number): void {
    const dropdown = this.overlay?.dropdown;
    if (!dropdown || itemId === 0) return;
    const height = this.lineHeight();
    const top = (itemId - 1) * height + 1;
    this.invert(dropdown, 1, top, dropdown.width - 1, top + height);
  }

  /** `invertRect` with pen 0 and back white: the two swap, and nothing else moves. */
  private invert(
    layer: SciMenuLayer,
    left: number,
    top: number,
    right: number,
    bottom: number,
  ): void {
    const white = this.options.white;
    for (let y = Math.max(0, top); y < Math.min(layer.height, bottom); y++) {
      for (let x = Math.max(0, left); x < Math.min(layer.width, right); x++) {
        const index = y * layer.width + x;
        const pixel = layer.pixels[index];
        if (pixel === 0) layer.pixels[index] = white;
        else if (pixel === white) layer.pixels[index] = 0;
      }
    }
  }

  private layer(x: number, y: number, width: number, height: number): SciMenuLayer {
    return { x, y, width, height, pixels: new Uint8Array(Math.max(1, width * height)) };
  }
}
