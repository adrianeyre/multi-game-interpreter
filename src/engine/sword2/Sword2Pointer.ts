/**
 * Broken Sword II's mouse engine: the four modes a pointer can be in.
 *
 * `Mouse::mouseEngine` (`mouse.cpp:217`) is a switch over `_mouseMode`, and
 * until now this project only had the first arm of it. A click was hit-tested
 * against the room and nothing else, which is `normalMouse` with its first
 * twenty lines missing — the twenty that notice the pointer has reached the
 * bottom of the screen and open the inventory. So the bar was built correctly
 * by `fnAddMenuObject`, coloured correctly by `buildMenu`, drawn correctly by
 * the renderer, and a player had no way to ask for it. `Sword2Menu.buildMenu`
 * said so in its own comment: two of its three colour rules were unreachable
 * "until the pointer can open the bar by itself".
 *
 * ## The four modes
 *
 * - **normal** — the pointer is over the room. A click runs the clicked
 *   object's action script. Pushing to the bottom opens the inventory.
 * - **menu** — the inventory bar is up. Left-click an icon to pick it up
 *   (which is drag mode), right-click to examine it. Moving off the bar closes
 *   it.
 * - **drag** — something is held. Clicking a room object uses the held thing
 *   on it; clicking another icon combines the two, or cancels if it is the
 *   same icon.
 *
 * - **system menu** — the pointer has reached the top of the screen, and the
 *   panel is up: options, quit, save, restore, restart. Moving off it closes
 *   it again, unless the player is dead, in which case the original leaves it
 *   up because it is the only thing left to use.
 *
 * ## What the system menu's five icons do here
 *
 * Save and restore are the two the game cannot be played without, and they are
 * serviced: the click goes out through {@link Sword2PointerHost.systemMenuPick}
 * and reaches the shell's own save menu and its ten slots. The original refuses
 * a save while the player is dead (`icons.cpp:221-225`) and so does this.
 *
 * Options, quit and restart are drawn and **greyed**, because this shell's
 * page is where those three live: the volume and the subtitles are its
 * controls, closing the tab is its quit, and re-opening the game is its
 * restart. Greyed is the game's own way of saying "not that one" and is why
 * the panel is still the panel the game was designed with rather than a
 * two-icon invention. `docs/scummvm-parity-roadmap.md` says the same in words.
 *
 * ## Two coordinates, and the one that is off by forty
 *
 * ScummVM's `getPos` returns `pos.y - MENUDEEP` (`mouse.cpp:126-132`), so its
 * `y > 399` and `y < 400` are measured from the top of the *game area*, forty
 * pixels below the top of the display. This project draws the game over the
 * whole 480 and overlays the bars, so the same line is 440 in display pixels —
 * which is {@link SWORD2_BOTTOM_MENU_LINE}, already used by the conversation
 * chooser for exactly this reason.
 *
 * The room hit test wants room coordinates, which are display plus scroll. The
 * bar does not scroll. Both are passed in rather than computed here.
 *
 * ## The luggage
 *
 * The held object's "luggage" — the icon the original hangs off the cursor
 * while you drag — is published here as {@link luggage} and drawn by
 * `Sword2Screen.setLuggage`, which the engine hands it to each frame along with
 * where the pointer is. The original composes it *into* the cursor sprite
 * (`Mouse::drawMouse`) and this project has no cursor sprite to compose with —
 * the pointer is the browser's own — so it is stamped onto the display by its
 * own hotspot, which is `drawMouse`'s own branch for a luggage without a mouse
 * animation.
 */

import {
  SWORD2_BOTTOM_MENU_LINE,
  SWORD2_ENGINE_POCKETS,
  SWORD2_MENU,
  SWORD2_MENU_MASTER_OBJECT,
  SWORD2_SYSTEM_ICONS,
  SWORD2_TOP_MENU_LINE,
  sword2MenuClick,
  type Sword2MenuObject,
} from './Sword2Menu.js';

/** `MOUSE_normal`, `MOUSE_menu`, `MOUSE_drag`, `MOUSE_system_menu` (`mouse.h:38-42`). */
export const SWORD2_MOUSE_MODE = { NORMAL: 0, MENU: 1, DRAG: 2, SYSTEM_MENU: 3 } as const;
export type Sword2MouseMode = (typeof SWORD2_MOUSE_MODE)[keyof typeof SWORD2_MOUSE_MODE];

/** The globals this reads and writes. Indexes from `sword2Vars.ts`. */
export interface Sword2PointerVars {
  readonly LEFT_BUTTON: number;
  readonly RIGHT_BUTTON: number;
  readonly CLICKED_ID: number;
  readonly OBJECT_HELD: number;
  readonly COMBINE_BASE: number;
  readonly EXIT_CLICK_ID: number;
  readonly MOUSE_X: number;
  readonly MOUSE_Y: number;
  /** Set while the player is dead, which is when the panel never closes. */
  readonly DEAD: number;
}

/** What the mouse engine needs from the rest of the engine. */
export interface Sword2PointerHost {
  getVar(number: number): number;
  setVar(number: number, value: number): void;
  /**
   * What is on the inventory bar right now.
   *
   * A call rather than a property: `buildMenu` replaces the list, so a
   * reference captured when the host was built would go stale the first time
   * the player picked anything up.
   */
  inventory(): readonly Sword2MenuObject[];
  buildMenu(): void;
  hideMenu(menu: number): void;
  /** Whether `buildMenu` should grey everything but the held icon. */
  setExamining(examining: boolean): void;
  /** Puts the system menu up, with the five flags saying which are live. */
  buildSystemMenu(available: readonly boolean[]): void;
  /**
   * Which of the five the player clicked. An index into `SWORD2_SYSTEM_ICONS`.
   *
   * Returns whether the click was taken, because the panel stays up for one
   * that was not — a greyed icon is a click the game ignores rather than a
   * reason to close.
   */
  systemMenuPick(choice: number): boolean;
  /** Which of the five this shell can service. Read fresh on every open. */
  systemMenuAvailable(): readonly boolean[];
  /** Sends the player object an event naming a script to run. */
  setPlayerActionEvent(interactId: number): void;
  /** Which room object is under the pointer, or 0. Room coordinates. */
  objectUnder(roomX: number, roomY: number): number;
  log?(message: string): void;
}

/** Where the pointer is this cycle, and which buttons went down. */
export interface Sword2PointerState {
  /** Display pixels: 0..639 across, 0..479 down. The bar's coordinates. */
  readonly displayX: number;
  readonly displayY: number;
  /** Display plus scroll: what the room's mouse rectangles are measured in. */
  readonly roomX: number;
  readonly roomY: number;
  readonly left: boolean;
  readonly right: boolean;
}

export class Sword2Pointer {
  private currentMode: Sword2MouseMode = SWORD2_MOUSE_MODE.NORMAL;

  /**
   * `_mouseModeLocked`: set while a script holds an object *for* the player.
   *
   * `fnSetObjectHeld` locks it (`mouse.cpp:1126-1135`) so that a puzzle which
   * puts something in George's hand cannot be undone by opening the inventory;
   * `fnAddHuman` clears it again (`mouse.cpp:1388`), which is also what a new
   * room does. Revolution's own comment for why it must be cleared outside the
   * `OBJECT_HELD` test is "see syphon in rm 3".
   */
  private locked = false;

  /** `_menuSelectedPos`: which pocket the held object came out of. */
  private selectedPocket = 0;

  /** `_currentLuggageResource`: which sprite the pointer drags. See the header. */
  private currentLuggage = 0;

  /**
   * Whether this cycle's arm got as far as reading the click.
   *
   * A click in this game is an *event in a one-slot queue*, not a flag that is
   * true for one cycle: `Sword2Engine::mouseEvent` (`sword2.cpp:403-409`) hands
   * it out once and clears `pending`, and every arm of `mouseEngine` calls it
   * *after* its own early returns. So a cycle that only changes mode — the one
   * where the pointer reaches the bottom of the screen and `normalMouse` opens
   * the inventory — leaves the click in the queue, and the arm that takes over
   * reads it on the next cycle.
   *
   * That is not a detail. Without it, a press that lands on the same cycle as
   * the mode change is thrown away, and since a script's `fnAddHuman` puts the
   * mode back to normal whenever the pointer is over the bar, a player standing
   * on the inventory could click an icon repeatedly and never pick it up. The
   * engine holds the press until {@link run} reports it taken.
   */
  private tookEvent = false;

  /**
   * Where the pointer was on the last cycle the mouse engine ran.
   *
   * Only {@link addHuman} needs it, and only to answer "is the pointer over
   * the bar" without being handed a position it has no other use for.
   */
  private lastDisplayY = 0;

  constructor(
    private readonly host: Sword2PointerHost,
    private readonly vars: Sword2PointerVars,
  ) {}

  get mode(): Sword2MouseMode {
    return this.currentMode;
  }

  /** Whether the inventory is open because the pointer opened it. */
  get menuOpen(): boolean {
    return this.currentMode !== SWORD2_MOUSE_MODE.NORMAL;
  }

  /** The held object's luggage resource — the sprite the pointer drags. */
  get luggage(): number {
    return this.currentLuggage;
  }

  /** `fnSetObjectHeld`: a script puts something in the player's hand. */
  setObjectHeld(resource: number): void {
    this.host.setVar(this.vars.OBJECT_HELD, resource);
    this.currentLuggage = resource;
    this.locked = true;
  }

  /**
   * `Mouse::addHuman`'s share of the work: unlock, and drop what was dragged.
   *
   * Called from `fnAddHuman` rather than duplicated there, so that the mode
   * and the globals cannot disagree about whether anything is being held.
   */
  addHuman(): void {
    this.locked = false;
    if (this.host.getVar(this.vars.OBJECT_HELD)) {
      this.host.setVar(this.vars.OBJECT_HELD, 0);
      this.host.setVar(this.vars.COMBINE_BASE, 0);
      this.host.setExamining(false);
      this.currentLuggage = 0;
    }
    // "If mouse is over menu area ... VITAL - reset things & rebuild the menu"
    // (`mouse.cpp:1401-1408`). The reset is *conditional*, and this project
    // used to do it unconditionally: a script handing control back while the
    // pointer was in the room would close a panel the player had opened, and
    // one handing it back while the pointer rested on the bar would knock the
    // bar's mode out from under the click that was about to be read. The
    // second of those is why a press on an icon could be swallowed.
    if (this.lastDisplayY >= SWORD2_BOTTOM_MENU_LINE) {
      this.currentMode = SWORD2_MOUSE_MODE.NORMAL;
    }
  }

  /** A room change: `closeMenuImmediately` leaves no mode behind it. */
  reset(): void {
    this.currentMode = SWORD2_MOUSE_MODE.NORMAL;
    this.selectedPocket = 0;
    this.currentLuggage = 0;
    this.locked = false;
  }

  /**
   * `Mouse::mouseEngine`: one cycle of whichever mode is current.
   *
   * Returns whether the cycle consumed the pending click — see
   * {@link tookEvent}. A `false` means the caller must offer the same press
   * again next cycle.
   */
  run(state: Sword2PointerState): boolean {
    // "If George is dead, the system menu is visible all the time, and is the
    // only thing that can be used" (`mouse.cpp:221-238`). Ahead of the switch
    // rather than inside it, because it has to *take* the mode from whatever
    // the player was doing when they died.
    this.tookEvent = false;
    this.lastDisplayY = state.displayY;
    if (this.host.getVar(this.vars.DEAD)) {
      if (this.currentMode !== SWORD2_MOUSE_MODE.SYSTEM_MENU) {
        this.currentMode = SWORD2_MOUSE_MODE.SYSTEM_MENU;
        this.host.buildSystemMenu(this.host.systemMenuAvailable());
      }
      this.systemMenuMouse(state);
      return this.tookEvent;
    }

    switch (this.currentMode) {
      case SWORD2_MOUSE_MODE.SYSTEM_MENU:
        this.systemMenuMouse(state);
        break;
      case SWORD2_MOUSE_MODE.MENU:
        this.menuMouse(state);
        break;
      case SWORD2_MOUSE_MODE.DRAG:
        this.dragMouse(state);
        break;
      default:
        this.normalMouse(state);
    }
    return this.tookEvent;
  }

  /**
   * `Sword2Engine::mouseEvent`: take the pending click, if there is one.
   *
   * Called from each arm at the line the original calls it on, so that "the
   * arm looked" and "the press was used up" are the same thing.
   */
  private takeEvent(state: Sword2PointerState): boolean {
    this.tookEvent = true;
    return state.left || state.right;
  }

  /** `Mouse::normalMouse` (`mouse.cpp:663`). */
  private normalMouse(state: Sword2PointerState): void {
    // "Check if the cursor has moved onto the system menu area. No save in
    // big-object menu lock situation, or if the player is dragging an object."
    // The second test is the one that keeps a held object held: opening the
    // panel mid-drag would put the game's hand down without the player asking.
    if (
      state.displayY < SWORD2_TOP_MENU_LINE &&
      !this.locked &&
      !this.host.getVar(this.vars.OBJECT_HELD)
    ) {
      this.currentMode = SWORD2_MOUSE_MODE.SYSTEM_MENU;
      this.host.buildSystemMenu(this.host.systemMenuAvailable());
      return;
    }

    // "Check if the cursor has moved onto the inventory menu area. No
    // inventory in big-object menu lock situation." Note this is a *hover*
    // test and not a click: the bar opens by being reached, which is the one
    // gesture the whole interface is built on and the one a player who cannot
    // find a button will still discover.
    if (state.displayY >= SWORD2_BOTTOM_MENU_LINE && !this.locked) {
      // "If an object is being held, go to drag mode instead of menu mode, but
      // the menu is still opened. That way, we can still use an object on
      // another inventory object, even if the inventory menu was closed after
      // the first object was selected."
      this.currentMode = this.host.getVar(this.vars.OBJECT_HELD)
        ? SWORD2_MOUSE_MODE.DRAG
        : SWORD2_MOUSE_MODE.MENU;
      this.host.buildMenu();
      return;
    }

    if (!this.takeEvent(state)) return;

    const clicked = this.host.objectUnder(state.roomX, state.roomY);
    this.host.setVar(this.vars.CLICKED_ID, clicked);
    // `normalMouse` does not stop at `CLICKED_ID`: it sends the player an event
    // naming the clicked object's action script (`mouse.cpp:847-857`), and the
    // player's own logic — looping in `fnPauseForEvent` — replaces itself with
    // it. Writing the global and nothing else records the click where no script
    // is waiting for it, and the floor click that follows moves nobody.
    if (clicked !== 0) this.host.setPlayerActionEvent(clicked);
  }

  /** `Mouse::systemMenuMouse` (`mouse.cpp:300`). */
  private systemMenuMouse(state: Sword2PointerState): void {
    const dead = this.host.getVar(this.vars.DEAD) !== 0;

    // "If the mouse is moved off the menu, close it. Unless the player is
    // dead, in which case the menu should always be visible."
    if (state.displayY >= SWORD2_TOP_MENU_LINE && !dead) {
      this.currentMode = SWORD2_MOUSE_MODE.NORMAL;
      this.host.hideMenu(SWORD2_MENU.TOP);
      return;
    }

    // "Check if the user left-clicks anywhere in the menu area." Left only:
    // the panel has no right-click, unlike the inventory bar below it.
    if (!this.takeEvent(state)) return;
    if (!state.left) return;
    if (state.displayY >= SWORD2_TOP_MENU_LINE) return;

    const hit = sword2MenuClick(SWORD2_SYSTEM_ICONS.length, state.displayX);
    if (hit < 0) return;

    // A refused pick — greyed here, "no save when dead" in the original
    // (`mouse.cpp:347-350`) — leaves the panel exactly as it was, which is
    // what lets the player then click one that is live.
    if (!this.host.systemMenuPick(hit)) return;

    // "Menu stays open on death screen. Otherwise it's closed."
    if (dead) {
      this.host.buildSystemMenu(this.host.systemMenuAvailable());
      return;
    }
    this.currentMode = SWORD2_MOUSE_MODE.NORMAL;
    this.host.hideMenu(SWORD2_MENU.TOP);
  }

  /** `Mouse::menuMouse` (`mouse.cpp:583`). */
  private menuMouse(state: Sword2PointerState): void {
    // "If the mouse is moved off the menu, close it."
    if (state.displayY < SWORD2_BOTTOM_MENU_LINE) {
      this.currentMode = SWORD2_MOUSE_MODE.NORMAL;
      this.host.hideMenu(SWORD2_MENU.BOTTOM);
      return;
    }

    if (!this.takeEvent(state)) return;

    const hit = this.pocketAt(state.displayX);
    if (hit === null) return;

    if (state.right) {
      // "Right button - examine an object, identified by its icon resource id."
      this.host.setExamining(true);
      this.host.setVar(this.vars.OBJECT_HELD, hit.icon);
      // "Must clear this so next click on exit becomes 1st click again."
      this.host.setVar(this.vars.EXIT_CLICK_ID, 0);
      this.host.setPlayerActionEvent(SWORD2_MENU_MASTER_OBJECT);
      this.host.buildMenu();
      return;
    }

    // "Left button - bung us into drag luggage mode."
    this.currentMode = SWORD2_MOUSE_MODE.DRAG;
    this.selectedPocket = hit.pocket;
    this.host.setVar(this.vars.OBJECT_HELD, hit.icon);
    this.currentLuggage = hit.luggage;
    this.host.setVar(this.vars.EXIT_CLICK_ID, 0);
    this.host.buildMenu();
  }

  /** `Mouse::dragMouse` (`mouse.cpp:458`). */
  private dragMouse(state: Sword2PointerState): void {
    // "We can use dragged object both on other inventory objects, or on
    // objects in the scene, so if the mouse moves off the inventory menu, then
    // close it." The mode goes back to normal and the *object stays held*,
    // which is what lets a held thing be used on something in the room.
    if (state.displayY < SWORD2_BOTTOM_MENU_LINE) {
      this.currentMode = SWORD2_MOUSE_MODE.NORMAL;
      this.host.hideMenu(SWORD2_MENU.BOTTOM);
      return;
    }

    if (!this.takeEvent(state)) return;
    if (!state.left) return;

    // "Mouse is over an on screen object - and we have luggage." Reachable
    // only where a room object's rectangle reaches under the bar; the ordinary
    // way to use a held thing on the room is the branch above, which drops back
    // to normal mode with `OBJECT_HELD` still set.
    const touching = this.host.objectUnder(state.roomX, state.roomY);
    if (touching !== 0) {
      // "Set global script variable 'button'. We know that it was the left
      // button, not the right one."
      this.host.setVar(this.vars.LEFT_BUTTON, 1);
      this.host.setVar(this.vars.RIGHT_BUTTON, 0);
      this.host.setVar(this.vars.MOUSE_X, state.roomX);
      this.host.setVar(this.vars.MOUSE_Y, state.roomY);
      this.host.setVar(this.vars.CLICKED_ID, touching);
      this.host.setPlayerActionEvent(touching);
      this.host.hideMenu(SWORD2_MENU.BOTTOM);
      this.currentMode = SWORD2_MOUSE_MODE.NORMAL;
      return;
    }

    // "Better check for combine/cancel. Cancel puts us back in MOUSE_menu mode."
    const hit = this.pocketAt(state.displayX);
    if (hit === null) return;

    // "Always back into menu mode. Remove the luggage as well."
    this.currentMode = SWORD2_MOUSE_MODE.MENU;
    this.currentLuggage = 0;

    if (hit.pocket === this.selectedPocket) {
      // "If we clicked on the same icon again, reset the first icon" — which is
      // the game's cancel gesture, and the only way to put something down.
      this.host.setVar(this.vars.OBJECT_HELD, 0);
      this.selectedPocket = 0;
    } else {
      // "Otherwise, combine the two icons." `menu_master`'s script reads both
      // `OBJECT_HELD` and `COMBINE_BASE` and decides what the pair makes.
      this.host.setVar(this.vars.COMBINE_BASE, hit.icon);
      this.host.setPlayerActionEvent(SWORD2_MENU_MASTER_OBJECT);
    }

    this.host.buildMenu();
  }

  /**
   * Which inventory object a click at `x` landed on, or null.
   *
   * `menuClick(TOTAL_engine_pockets)` and then "check if we clicked on an
   * actual icon" — the two together, because a pocket index past the end of
   * the inventory is not a thing the player can click and every caller here
   * wants the object rather than the index.
   */
  private pocketAt(x: number): { pocket: number; icon: number; luggage: number } | null {
    const pocket = sword2MenuClick(SWORD2_ENGINE_POCKETS, x);
    if (pocket < 0) return null;
    const object = this.host.inventory()[pocket];
    if (!object || !object.icon) return null;
    return { pocket, icon: object.icon, luggage: object.luggage };
  }
}
