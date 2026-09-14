/**
 * Broken Sword II's menu bars: the conversation chooser and the inventory.
 *
 * ## What the game puts on a bar
 *
 * Two 40-pixel bars slide over the picture, one at the top and one at the
 * bottom, each holding up to fifteen 35x30 icons. The top one is the system
 * menu; the bottom one is two different things at two different times — the
 * player's inventory, and the list of subjects a conversation can be steered
 * with. This module is both, because in the original they are one: the same
 * pockets, the same blitter, the same `hideMenu(RDMENU_BOTTOM)`.
 *
 * ScummVM keeps it in `icons.cpp` (the two lists) and `menu.cpp` (the pockets),
 * hung off `Mouse`. It is its own module here because this project's mouse is
 * the host's and its logic is the script engine's, and a bar is neither.
 *
 * ## The chooser is the part a player notices
 *
 * A conversation is scripted as: `fnAddSubject` once per thing that can be
 * talked about, then `fnChoose`, then a `CP_JUMP_ON_RETURNED` table. The
 * chooser spans cycles — the first call puts the icons up and answers
 * `IR_REPEAT`, and the script re-enters it every cycle until a click lands on
 * an icon. The answer then comes back **packed into the opcode's return
 * value**, `IR_CONT | (response << 3)`, which is the only place in the game
 * that uses that packing and the reason `CP_JUMP_ON_RETURNED` exists.
 *
 * So a `fnChoose` that returns a bare `IR_CONT` does not merely miss the menu:
 * it sends every conversation down entry 0 of its jump table, for ever.
 *
 * ## Two things the game keeps outside this module
 *
 * `IN_SUBJECT` is the subject *count*, and it is a script global rather than a
 * field here — the scripts zero it to start a new list and read it to decide
 * how many subjects they offered. And the inventory's contents are not here
 * either: `buildMenu` runs `menu_master`'s own script, which calls
 * `fnAddMenuObject` once per thing the player is carrying. Both are the same
 * arrangement as the rest of this family, where the scripts own the state and
 * the engine owns the mechanism.
 */

/** The two bars. `RDMENU_TOP`, `RDMENU_BOTTOM` (`mouse.h:44-45`). */
export const SWORD2_MENU = { TOP: 0, BOTTOM: 1 } as const;

/** One icon: 35 across, 30 deep. `RDMENU_ICONWIDE`, `RDMENU_ICONDEEP`. */
export const SWORD2_ICON_WIDTH = 35;
export const SWORD2_ICON_DEPTH = 30;
/** Where the first pocket starts and how far apart they sit. */
export const SWORD2_ICON_START = 24;
export const SWORD2_ICON_SPACING = 5;
/** How many pockets a bar has. `RDMENU_MAXPOCKETS`. */
export const SWORD2_MAX_POCKETS = 15;

/**
 * The top of the bottom bar's icon row, in **display** pixels.
 *
 * ScummVM's layout is `menu * (RENDERDEEP + MENUDEEP) + (MENUDEEP -
 * RDMENU_ICONDEEP) / 2` (`menu.cpp:51`) over a 640x480 display made of a
 * 40-pixel bar, a 400-pixel game area and another 40-pixel bar. This project
 * draws the game area over the whole 480 and overlays the bars, so the numbers
 * below are that same arithmetic evaluated: 5 for the top bar, 445 for the
 * bottom. The rows land in the same place on screen; only what is underneath
 * them differs.
 */
export const SWORD2_TOP_MENU_TOP = 5;
export const SWORD2_BOTTOM_MENU_TOP = 445;

/**
 * The line a click has to be below to be a click on the bottom bar.
 *
 * `mouseY < 400` in `chooseMouse`, against a pointer position measured from
 * the top of the game area rather than the top of the display — so 440 here.
 */
export const SWORD2_BOTTOM_MENU_LINE = 440;

/**
 * The line a click has to be above to be a click on the top bar.
 *
 * The same conversion as {@link SWORD2_BOTTOM_MENU_LINE} at the other end:
 * `systemMenuMouse` tests `y < 0` against a pointer measured from the top of
 * the game area (`mouse.cpp:317-323`), and the game area starts forty pixels
 * down the display.
 */
export const SWORD2_TOP_MENU_LINE = 40;

/**
 * The system menu's five icons, in the order the top bar shows them.
 *
 * `icon_list` in `Mouse::systemMenuMouse` (`mouse.cpp:306-312`), whose members
 * are `defs.h:197-201`. The order is the panel's layout, so it is a list and
 * not a set: `menuClick` turns an x into an index into exactly this array.
 */
export const SWORD2_SYSTEM_ICONS = [344, 335, 366, 364, 342] as const;

/** What each of the five is, for the code that decides what a click does. */
export const SWORD2_SYSTEM_MENU = {
  OPTIONS: 0,
  QUIT: 1,
  SAVE: 2,
  RESTORE: 3,
  RESTART: 4,
} as const;

/** `MAX_SUBJECT_LIST`, `mouse.h:31`. "is that enough?" — Revolution's comment. */
export const SWORD2_MAX_SUBJECTS = 30;

/** `TOTAL_engine_pockets`: fifteen pockets and ten of overflow. */
export const SWORD2_ENGINE_POCKETS = 15 + 10;

/** `MENU_MASTER_OBJECT`: the object whose script 0 lists what is carried. */
export const SWORD2_MENU_MASTER_OBJECT = 44;

/** `EXIT_ICON`, `defs.h:204`. The one icon number the chooser knows by heart. */
export const SWORD2_EXIT_ICON = 65;

/** `chooseMouse`'s answer when nothing has been picked yet. */
export const SWORD2_NO_CHOICE = -1;

/** One thing the player is carrying: its icon, and the pointer that drags it. */
export interface Sword2MenuObject {
  readonly icon: number;
  readonly luggage: number;
}

/** What is in one pocket: an icon resource, and which of its two images. */
export interface Sword2Pocket {
  readonly icon: number;
  readonly coloured: boolean;
}

/** A bar, as the renderer is handed it. */
export interface Sword2MenuBar {
  readonly shown: boolean;
  readonly pockets: ReadonlyArray<Sword2Pocket | null>;
}

/** What the menu needs from the rest of the engine. */
export interface Sword2MenuHost {
  getVar(number: number): number;
  setVar(number: number, value: number): void;
  /** Runs an object's script with that object's own structures. */
  runResScript(object: number, script: number): void;
  /**
   * Where the pointer is on the **display**, and whether it was clicked.
   *
   * Display and not room coordinates: a bar is drawn over the picture and does
   * not scroll with it, so a chooser tested against room coordinates would
   * move its own icons out from under the pointer in any wide room.
   */
  pointer(): { x: number; y: number; clicked: boolean };
  log?(message: string): void;
}

/** The globals the menu reads and writes. Indexes from `sword2Vars.ts`. */
interface Sword2MenuVars {
  readonly RESULT: number;
  readonly IN_SUBJECT: number;
  readonly COMBINE_BASE: number;
  readonly OBJECT_HELD: number;
  readonly CHOOSER_COUNT_FLAG: number;
  readonly AUTO_SELECTED: number;
}

/** One subject: the icon shown for it, and Dave's reference number. */
interface Sword2Subject {
  res: number;
  ref: number;
}

export class Sword2Menu {
  /**
   * The subjects, indexed by `IN_SUBJECT` rather than by its own length.
   *
   * That indirection is the original's and it matters: a script sets
   * `IN_SUBJECT` to 0 to start a new list, and the entries above it stay in
   * the array until they are written over. Keeping a private count instead
   * would disagree with the scripts about how many subjects there are.
   */
  private readonly subjects: Sword2Subject[] = [];
  private defaultResponseId = 0;

  /** What `menu_master` registered this time round, and what is on the bar. */
  private temp: Array<Sword2MenuObject | null> = [];
  private master: Sword2MenuObject[] = [];

  /** Whether a chooser is up and waiting. `_choosing`. */
  private choosing = false;

  /**
   * `refreshInventory`'s flag, which changes what `buildMenu` colours.
   *
   * Revolution's comment above it says "Cause 'object_held' icon to be greyed.
   * The rest are colored" and the code it introduces does the opposite
   * (`icons.cpp:160-164`, `mouse.cpp:1433-1441`). The code is what the game
   * runs, so it is what is mirrored here; the comment is noted so that reading
   * the original later does not look like a fault found.
   */
  private examining = false;

  private readonly icons: Array<Array<Sword2Pocket | null>> = [
    new Array<Sword2Pocket | null>(SWORD2_MAX_POCKETS).fill(null),
    new Array<Sword2Pocket | null>(SWORD2_MAX_POCKETS).fill(null),
  ];
  private readonly status: boolean[] = [false, false];

  constructor(
    private readonly host: Sword2MenuHost,
    private readonly vars: Sword2MenuVars,
  ) {}

  /** The two bars, for the renderer. */
  get bars(): readonly [Sword2MenuBar, Sword2MenuBar] {
    return [
      { shown: this.status[SWORD2_MENU.TOP], pockets: this.icons[SWORD2_MENU.TOP] },
      { shown: this.status[SWORD2_MENU.BOTTOM], pockets: this.icons[SWORD2_MENU.BOTTOM] },
    ];
  }

  /** What the player is carrying, in the order the bar shows it. */
  get inventory(): readonly Sword2MenuObject[] {
    return this.master;
  }

  /** Whether a chooser is up. The engine suppresses room clicks while it is. */
  get isChoosing(): boolean {
    return this.choosing;
  }

  /**
   * `fnAddSubject`: one more thing this conversation can be steered with.
   *
   * `Mouse::addSubject` (`icons.cpp:47`). Three things happen here that read
   * like special cases and are not: an empty list clears the default response
   * so a stale one cannot leak into the next conversation, id −1 *is* the
   * default response rather than a subject, and the count goes back into
   * `IN_SUBJECT` because that is where the scripts keep it.
   */
  addSubject(id: number, ref: number): void {
    const inSubject = this.host.getVar(this.vars.IN_SUBJECT);
    if (inSubject === 0) this.defaultResponseId = 0;

    if (id === -1) {
      this.defaultResponseId = ref;
      return;
    }
    if (inSubject >= SWORD2_MAX_SUBJECTS) {
      this.host.log?.(
        `a conversation offered more than ${SWORD2_MAX_SUBJECTS} subjects, which is more than ` +
          `the original's list holds, so subject ${id} was dropped`,
      );
      return;
    }
    this.subjects[inSubject] = { res: id, ref };
    this.host.setVar(this.vars.IN_SUBJECT, inSubject + 1);
  }

  /** Clears the subject list without disturbing what is on screen. */
  forgetSubjects(): void {
    this.subjects.length = 0;
    this.defaultResponseId = 0;
    this.choosing = false;
  }

  /**
   * `fnChoose`, the whole of it. `Mouse::chooseMouse` (`mouse.cpp:872`).
   *
   * Returns the chosen subject's reference, or {@link SWORD2_NO_CHOICE} while
   * it is still waiting. Four answers, in the order the original tests them:
   *
   * 1. **An object is held.** The player used something on a person, so this
   *    is not a menu at all: the held object is the subject, and a person who
   *    knows nothing about it gets the default response.
   * 2. **One subject and it is the exit icon, first time round.** There is
   *    nothing to talk about, so the menu is skipped and `AUTO_SELECTED` says
   *    so — the speech scripts branch on it.
   * 3. **A new menu.** The icons go up and the opcode repeats.
   * 4. **A click.** The icons that were not picked are greyed, the bar is
   *    closed, and the reference comes back.
   */
  choose(): number {
    this.host.setVar(this.vars.AUTO_SELECTED, 0);

    const inSubject = this.host.getVar(this.vars.IN_SUBJECT);
    const objectHeld = this.host.getVar(this.vars.OBJECT_HELD);

    if (objectHeld) {
      let response = this.defaultResponseId;
      for (let at = 0; at < inSubject; at++) {
        if (this.subjects[at]?.res === objectHeld) {
          response = this.subjects[at].ref;
          break;
        }
      }
      this.host.setVar(this.vars.OBJECT_HELD, 0);
      this.host.setVar(this.vars.IN_SUBJECT, 0);
      this.choosing = false;
      return response;
    }

    if (
      this.host.getVar(this.vars.CHOOSER_COUNT_FLAG) === 0 &&
      inSubject === 1 &&
      this.subjects[0]?.res === SWORD2_EXIT_ICON
    ) {
      this.host.setVar(this.vars.AUTO_SELECTED, 1);
      this.host.setVar(this.vars.IN_SUBJECT, 0);
      this.choosing = false;
      return this.subjects[0].ref;
    }

    if (!this.choosing) {
      if (inSubject === 0) {
        // ScummVM calls `error("fnChoose with no subjects")` and stops the
        // game. Here it is a fault and a response of 0, which is the jump
        // table's "nothing chosen" entry: a conversation that goes nowhere is
        // a better report than an engine that quits, and the fault says which.
        this.host.log?.('a script reached fnChoose with no subjects, so nothing could be chosen');
        this.host.setVar(this.vars.IN_SUBJECT, 0);
        return 0;
      }
      for (let at = 0; at < inSubject && at < SWORD2_MAX_POCKETS; at++) {
        this.setIcon(SWORD2_MENU.BOTTOM, at, { icon: this.subjects[at].res, coloured: true });
      }
      for (let at = inSubject; at < SWORD2_MAX_POCKETS; at++) {
        this.setIcon(SWORD2_MENU.BOTTOM, at, null);
      }
      this.showMenu(SWORD2_MENU.BOTTOM);
      this.choosing = true;
      return SWORD2_NO_CHOICE;
    }

    const pointer = this.host.pointer();
    if (!pointer.clicked || pointer.y < SWORD2_BOTTOM_MENU_LINE) return SWORD2_NO_CHOICE;

    const hit = sword2MenuClick(inSubject, pointer.x);
    if (hit < 0) return SWORD2_NO_CHOICE;

    // "Hilight the clicked icon by greying the others." The bar stays up until
    // the speech script takes it down, so this is what the player sees while
    // the answer is being spoken.
    for (let at = 0; at < inSubject && at < SWORD2_MAX_POCKETS; at++) {
      if (at !== hit)
        this.setIcon(SWORD2_MENU.BOTTOM, at, { icon: this.subjects[at].res, coloured: false });
    }

    // "For non-speech scripts that manually call the chooser."
    this.host.setVar(this.vars.RESULT, this.subjects[hit].res);
    this.choosing = false;
    this.host.setVar(this.vars.IN_SUBJECT, 0);
    return this.subjects[hit].ref;
  }

  /**
   * `fnAddMenuObject`: one pocket of the inventory being rebuilt.
   *
   * Only ever called from inside {@link buildMenu}, by `menu_master`'s own
   * script, which is why it appends to a *temporary* list: the master list is
   * rebuilt from it afterwards so that the bar keeps the order it already had.
   */
  addMenuObject(icon: number, luggage: number): void {
    if (this.temp.length >= SWORD2_ENGINE_POCKETS) {
      this.host.log?.(
        `menu_master registered more than ${SWORD2_ENGINE_POCKETS} objects, which is more than ` +
          `the original's inventory holds, so icon ${icon} was dropped`,
      );
      return;
    }
    this.temp.push({ icon, luggage });
  }

  /**
   * `Mouse::buildMenu` (`icons.cpp:73`): rebuild the inventory bar.
   *
   * The middle of this is the part worth reading. The new list is not simply
   * the one `menu_master` just registered: anything already on the bar keeps
   * its place, anything the player has lost since last time is dropped, and
   * anything new is appended. Rebuilding from scratch instead would reshuffle
   * the player's inventory every time they picked something up.
   */
  buildMenu(): void {
    this.temp = [];
    this.host.runResScript(SWORD2_MENU_MASTER_OBJECT, 0);

    // Anything in the master list that is no longer carried is dropped;
    // anything still carried is struck off the temporary list, so what is left
    // there is exactly what is new.
    const kept: Sword2MenuObject[] = [];
    for (const held of this.master) {
      const at = this.temp.findIndex((object) => object !== null && object.icon === held.icon);
      if (at < 0) continue;
      this.temp[at] = null;
      kept.push(held);
    }
    for (const fresh of this.temp) {
      if (fresh && fresh.icon !== 0) kept.push(fresh);
    }
    this.master = kept.slice(0, SWORD2_ENGINE_POCKETS);

    const objectHeld = this.host.getVar(this.vars.OBJECT_HELD);
    const combineBase = this.host.getVar(this.vars.COMBINE_BASE);
    for (let pocket = 0; pocket < SWORD2_MAX_POCKETS; pocket++) {
      const icon = this.master[pocket]?.icon ?? 0;
      if (!icon) {
        this.setIcon(SWORD2_MENU.BOTTOM, pocket, null);
        continue;
      }
      // Three rules, one per way an inventory icon can be in play. All three
      // are reachable now that `Sword2Pointer` opens the bar: examining is a
      // right-click on an icon (and `fnRefreshInventory`), a combine base is
      // set by clicking a second icon while holding the first, and the plain
      // rule is the bar at rest.
      const coloured = this.examining
        ? icon === objectHeld
        : combineBase
          ? icon === objectHeld || combineBase !== 0
          : icon !== objectHeld;
      this.setIcon(SWORD2_MENU.BOTTOM, pocket, { icon, coloured });
    }

    this.showMenu(SWORD2_MENU.BOTTOM);
  }

  /** `fnRefreshInventory`: rebuild the bar with the held object picked out. */
  refreshInventory(): void {
    this.host.setVar(this.vars.COMBINE_BASE, 0);
    this.examining = true;
    this.buildMenu();
    this.examining = false;
  }

  /**
   * `_examiningMenuIcon`, for the one caller that sets it and does not clear it.
   *
   * A right-click on an inventory icon examines it, and the bar stays greyed
   * that way until the pointer is handed back (`Mouse::addHuman`) — unlike
   * {@link refreshInventory}, which raises and drops the flag around a single
   * rebuild. Both write the same field; they differ only in how long it lasts.
   */
  setExamining(examining: boolean): void {
    this.examining = examining;
  }

  /**
   * `Mouse::buildSystemMenu` (`icons.cpp:199`): the five icons of the panel.
   *
   * `available` says which of them this shell can actually service, and an
   * unavailable one is drawn **greyed** rather than left out. That is the
   * game's own vocabulary. The original builds all five "high in full color"
   * and greys exactly one case — "the only case when an icon is grayed is when
   * the player is dead. Then SAVE is not available" — and greys the four you
   * did not click while a panel is up (`mouse.cpp:352-360`). This shell has one
   * more such case, the two panels it does not have, and says it the same way:
   * greyed means "not that one", which a player reads off the picture rather
   * than off a click that does nothing. Leaving them out instead would show a
   * panel of a different shape from the one the game was designed with, and
   * would still not say why.
   */
  buildSystemMenu(available: readonly boolean[]): void {
    for (let pocket = 0; pocket < SWORD2_MAX_POCKETS; pocket++) {
      const icon = SWORD2_SYSTEM_ICONS[pocket] ?? 0;
      this.setIcon(
        SWORD2_MENU.TOP,
        pocket,
        icon ? { icon, coloured: available[pocket] ?? false } : null,
      );
    }
    this.showMenu(SWORD2_MENU.TOP);
  }

  /** Puts a bar up. `showMenu`. */
  showMenu(menu: number): void {
    if (menu !== SWORD2_MENU.TOP && menu !== SWORD2_MENU.BOTTOM) return;
    this.status[menu] = true;
  }

  /** Takes one down. `hideMenu`, which is all `fnRemoveChooser` does. */
  hideMenu(menu: number): void {
    if (menu !== SWORD2_MENU.TOP && menu !== SWORD2_MENU.BOTTOM) return;
    this.status[menu] = false;
  }

  /** Takes both down at once. `closeMenuImmediately`: what leaving a room does. */
  closeImmediately(): void {
    this.status[SWORD2_MENU.TOP] = false;
    this.status[SWORD2_MENU.BOTTOM] = false;
    this.icons[SWORD2_MENU.TOP].fill(null);
    this.icons[SWORD2_MENU.BOTTOM].fill(null);
    this.choosing = false;
  }

  private setIcon(menu: number, pocket: number, icon: Sword2Pocket | null): void {
    if (pocket < 0 || pocket >= SWORD2_MAX_POCKETS) return;
    this.icons[menu][pocket] = icon;
  }
}

/**
 * Which pocket a click at `x` landed in, or −1. `Mouse::menuClick`.
 *
 * `items` rather than fifteen: the bar is only as wide as what is on it, and
 * the pixels past the last icon are not a click on the one before it.
 */
export function sword2MenuClick(items: number, x: number): number {
  if (x < SWORD2_ICON_START) return -1;
  const pitch = SWORD2_ICON_WIDTH + SWORD2_ICON_SPACING;
  if (x > SWORD2_ICON_START + items * pitch - SWORD2_ICON_SPACING) return -1;
  return Math.trunc((x - SWORD2_ICON_START) / pitch);
}
