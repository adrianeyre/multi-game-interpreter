/**
 * Broken Sword's pointer and its two menu bars.
 *
 * One module for two subsystems because they are not separable: the *mouse* is
 * what opens the top menu (moving into the top 40 pixels calls `fnStartMenu`),
 * and the menu is what the mouse's clicks land on when it is open. ScummVM
 * splits them into `mouse.cpp` and `menu.cpp` and then has each hold a pointer
 * to the other; keeping them together here says what that circularity means.
 *
 * ## What the mouse actually does each cycle
 *
 * Four things, in order, and the order is load-bearing:
 *
 * 1. **Delays events by one cycle.** A left and a right button arriving in the
 *    same frame must be seen as "both buttons", which cannot be known until the
 *    frame is over — so every event is held for a cycle. That is why clicking
 *    feels like it does, and why `testEvent` can return two bits.
 * 2. **Opens or closes the top menu**, from the pointer's y alone.
 * 3. **Hit-tests the objects the logic registered**, lowest `o_priority`
 *    first — priority here is a *layer*, not an importance, and 0 wins.
 * 4. **Runs the get-on, get-off and click scripts** of whatever changed.
 *
 * The get-off script is the subtle one: it belongs to the object the pointer
 * *left*, so it has to be remembered from the previous cycle rather than
 * looked up. `SCR_std_off` is the default, set by `fnAddHuman`.
 *
 * ## The two bars
 *
 * The top bar is the inventory, built from the 52 pocket globals. The bottom
 * bar is the conversation chooser, built from the subjects a script added with
 * `fnAddSubject`. They are the same mechanism with different contents, which is
 * why `MenuBar` is one class used twice.
 */

import { SwordLogicMode, SwordStatus } from './resource/swordDefs.js';
import type { SwordCompact } from './resource/swordCompact.js';
import {
  SWORD1_BASE_SUBJECT,
  SWORD1_MENU_OBJECTS,
  SWORD1_TOTAL_POCKETS,
  sword1Subject,
} from './resource/swordMenuTables.js';
import type { SwordMouseTarget } from './gfx/SwordScreen.js';
import { SV } from './script/swordVarIndex.js';

/** The button bits, as the original numbers them. */
export const BS1L_BUTTON_DOWN = 1;
export const BS1L_BUTTON_UP = 2;
export const BS1R_BUTTON_DOWN = 4;
export const BS1R_BUTTON_UP = 8;
export const MOUSE_DOWN_MASK = BS1L_BUTTON_DOWN | BS1R_BUTTON_DOWN;
export const MOUSE_UP_MASK = BS1L_BUTTON_UP | BS1R_BUTTON_UP;

/** `SCR_std_off` — the default get-off script `fnAddHuman` installs. */
const SCR_STD_OFF = 6;
/** `SCR_menu_look` — what clicking an inventory icon while "looking" runs. */
const SCR_MENU_LOOK = 24;
/** `MSE_POINTER` — the ordinary arrow. */
const MSE_POINTER = 0x04040001;

/** The top bar is the inventory; the bottom is the conversation chooser. */
export type SwordMenuBar = 'top' | 'bottom';

/** One icon on a bar: which resource and frame, and whether it is lit. */
export interface SwordMenuIcon {
  readonly slot: number;
  readonly resource: number;
  readonly frame: number;
  readonly selected: boolean;
  /** The pocket number or subject number this icon stands for. */
  readonly value: number;
}

/** What the UI needs from the engine: scripts to run, and a pointer to set. */
export interface SwordUiHost {
  /**
   * Runs a mouse script against a compact, outside the logic tree.
   *
   * `runMouseScript` in the original: a get-on, get-off or click script runs
   * *now*, on the interpreter, without touching the object's own script stack.
   * That is how clicking a thing can start George walking without interrupting
   * whatever the clicked thing was doing.
   */
  runMouseScript(compact: SwordCompact | null, script: number): void;
  /** Sets a compact's script and wakes it if idle — `cfnPresetScript`. */
  presetScript(targetId: number, script: number): void;
  fetch(id: number): SwordCompact | null;
  getVar(number: number): number;
  setVar(number: number, value: number): void;
}

/** One icon's width on either bar, and the geometry the art was drawn at. */
export const SWORD1_MENU_ICON_WIDTH = 40;

export class SwordUi {
  /** This cycle's button state, after the one-cycle delay. */
  private state = 0;
  private lastState = 0;
  /** Pointer position in display pixels, 0..639 / 0..479. */
  private pointerX = 0;
  private pointerY = 0;
  private inTopMenu = false;
  /** The get-off script of whatever the pointer was over last cycle. */
  private getOff = 0;

  /** The pointer's sprite and its luggage, as the scripts set them. */
  pointer = { tag: 0, rate: 0 };
  luggage = { tag: 0, rate: 0 };

  /** Whether each bar is shown. The scripts open and close them. */
  topOpen = false;
  bottomOpen = false;

  /** The subjects a script added, in order. Up to sixteen. */
  private subjectBar: number[] = [];

  private topIcons: SwordMenuIcon[] = [];
  private bottomIcons: SwordMenuIcon[] = [];

  constructor(private readonly host: SwordUiHost) {}

  /** What the renderer should draw on a bar. */
  icons(bar: SwordMenuBar): readonly SwordMenuIcon[] {
    return bar === 'top' ? this.topIcons : this.bottomIcons;
  }

  /** Whether a bar is shown, which is also whether a click on it counts. */
  isOpen(bar: SwordMenuBar): boolean {
    return bar === 'top' ? this.topOpen : this.bottomOpen;
  }

  /**
   * Where each icon on a bar sits, in the display pixels a click is given in.
   *
   * The same arithmetic `iconAt` inverts, said forwards: a caller that wants to
   * pick a conversation topic needs the point, and computing it a second time
   * somewhere else is how the two come to disagree.
   */
  iconPoints(bar: SwordMenuBar): Array<{ slot: number; value: number; x: number; y: number }> {
    const icons = this.icons(bar);
    const left = Math.floor((640 - icons.length * SWORD1_MENU_ICON_WIDTH) / 2);
    return icons.map((icon) => ({
      slot: icon.slot,
      value: icon.value,
      x: left + icon.slot * SWORD1_MENU_ICON_WIDTH + SWORD1_MENU_ICON_WIDTH / 2,
      y: bar === 'top' ? 20 : 460,
    }));
  }

  /** Buttons pressed this cycle, for the speech driver's click-through. */
  testEvent(): number {
    return this.state;
  }

  /** Records raw input. The engine calls this before `engine`. */
  setInput(x: number, y: number, buttons: number): void {
    this.pointerX = x;
    this.pointerY = y;
    this.pendingButtons |= buttons;
  }

  private pendingButtons = 0;

  /**
   * One cycle of the pointer.
   *
   * `targets` is what the logic registered this cycle, and it is consumed: the
   * list is rebuilt every cycle, which is what makes an object that stopped
   * asking for the mouse stop being clickable immediately.
   */
  engine(targets: readonly SwordMouseTarget[]): void {
    const eventFlags = this.pendingButtons;
    this.pendingButtons = 0;

    // The one-cycle delay, so a left and a right press in one frame are seen
    // together. Everything downstream reads `this.state`.
    this.state = 0;
    if (this.lastState) {
      this.state = this.lastState | eventFlags;
      this.lastState = 0;
    } else if (eventFlags) {
      this.lastState = eventFlags;
    }
    // A press and a release in one cycle are resorted so the release lands
    // next cycle; otherwise a fast click is invisible to a script that tests
    // for a press.
    if (this.state & MOUSE_DOWN_MASK && this.state & MOUSE_UP_MASK) {
      this.lastState = this.state & MOUSE_UP_MASK;
      this.state &= MOUSE_DOWN_MASK;
    }

    if (!(this.host.getVar(SV.MOUSE_STATUS) & 1)) return; // no human

    if (!this.host.getVar(SV.TOP_MENU_DISABLED)) {
      if (this.pointerY < 40) {
        if (!this.inTopMenu) {
          if (!this.host.getVar(SV.OBJECT_HELD)) this.startMenu();
          this.setPointer(MSE_POINTER, 0);
        }
        if (this.topOpen) this.checkMenuClick('top');
        this.inTopMenu = true;
      } else if (this.inTopMenu) {
        if (!this.host.getVar(SV.OBJECT_HELD)) this.endMenu();
        this.inTopMenu = false;
      }
    } else if (this.inTopMenu) {
      this.endMenu();
      this.inTopMenu = false;
    }

    // Into the game's own coordinate space: scroll offset, plus the 128 origin,
    // less the 40-pixel menu bar the display has and the room does not.
    this.host.setVar(SV.MOUSE_X, this.host.getVar(SV.SCROLL_OFFSET_X) + this.pointerX + 128);
    this.host.setVar(SV.MOUSE_Y, this.host.getVar(SV.SCROLL_OFFSET_Y) + this.pointerY + 128 - 40);
    const mouseX = this.host.getVar(SV.MOUSE_X);
    const mouseY = this.host.getVar(SV.MOUSE_Y);

    let touched: SwordMouseTarget | null = null;
    if (this.pointerY > 40 || !this.inTopMenu) {
      // Priority is a layer and 0 is nearest, so the search is ascending and
      // stops at the first hit.
      for (let priority = 0; priority < 10 && !touched; priority++) {
        for (const target of targets) {
          if (target.priority !== priority) continue;
          if (
            mouseX >= target.x1 &&
            mouseX <= target.x2 &&
            mouseY >= target.y1 &&
            mouseY <= target.y2
          ) {
            touched = target;
            break;
          }
        }
      }
      const touchedId = touched?.id ?? 0;
      if (touchedId !== this.host.getVar(SV.SPECIAL_ITEM)) {
        this.host.setVar(SV.SPECIAL_ITEM, touchedId);
        if (this.getOff) {
          this.host.runMouseScript(null, this.getOff);
          this.getOff = 0;
        }
        if (touched) {
          const compact = this.host.fetch(touched.id);
          if (touched.mouseOn) this.host.runMouseScript(compact, touched.mouseOn);
          this.getOff = touched.mouseOff;
        }
      }
    } else {
      this.host.setVar(SV.SPECIAL_ITEM, 0);
    }

    if (this.state & MOUSE_DOWN_MASK) {
      if (this.inTopMenu) this.clickTopMenu();
      this.host.setVar(SV.MOUSE_BUTTON, this.state & MOUSE_DOWN_MASK);
      const special = this.host.getVar(SV.SPECIAL_ITEM);
      if (special) {
        const compact = this.host.fetch(special);
        const target = targets.find((candidate) => candidate.id === special);
        if (compact && target?.mouseClick) this.host.runMouseScript(compact, target.mouseClick);
      }
    }
  }

  /**
   * A click in the top bar: use the second item, or look at one.
   *
   * Both branches interrupt George first — a rest animation is cancelled and a
   * walk is asked to stop at the end of its current step (`GEORGE_WALKING = 2`),
   * which is why clicking the inventory mid-walk does not snap him.
   */
  private clickTopMenu(): void {
    const interrupt = (): void => {
      if (this.host.getVar(SV.GEORGE_WALKING)) this.host.setVar(SV.GEORGE_WALKING, 2);
    };
    const second = this.host.getVar(SV.SECOND_ITEM);
    if (second) {
      interrupt();
      const definition = SWORD1_MENU_OBJECTS[second];
      if (definition?.useScript) this.host.runMouseScript(null, definition.useScript);
    }
    if (this.host.getVar(SV.MENU_LOOKING)) {
      interrupt();
      // The player's own compact, so the look-at happens to George.
      this.host.presetScript(0x800000, SCR_MENU_LOOK);
    }
  }

  // -- the mcodes' side ------------------------------------------------------

  noHuman(): void {
    if (this.host.getVar(SV.MOUSE_STATUS) & 2) return; // locked
    this.host.setVar(SV.MOUSE_STATUS, 0);
    this.setLuggage(0, 0);
    this.setPointer(0, 0);
  }

  addHuman(): void {
    if (this.host.getVar(SV.MOUSE_STATUS) & 2) return; // locked
    this.host.setVar(SV.MOUSE_STATUS, 1);
    this.host.setVar(SV.SPECIAL_ITEM, 0);
    this.getOff = SCR_STD_OFF;
    this.setPointer(MSE_POINTER, 0);
  }

  blank(): void {
    this.setPointer(0, 0);
  }

  normal(): void {
    this.setPointer(MSE_POINTER, 0);
  }

  /** Locking sets bit 1, which is what makes `noHuman`/`addHuman` no-ops. */
  lock(): void {
    this.host.setVar(SV.MOUSE_STATUS, this.host.getVar(SV.MOUSE_STATUS) | 2);
  }

  unlock(): void {
    this.host.setVar(SV.MOUSE_STATUS, this.host.getVar(SV.MOUSE_STATUS) & ~2);
  }

  setPointer(tag: number, rate: number): void {
    this.pointer = { tag, rate };
  }

  setLuggage(tag: number, rate: number): void {
    this.luggage = { tag, rate };
  }

  /** `fnStartMenu`: clear the selections and rebuild the inventory bar. */
  startMenu(): void {
    this.host.setVar(SV.OBJECT_HELD, 0);
    this.host.setVar(SV.SECOND_ITEM, 0);
    this.host.setVar(SV.MENU_LOOKING, 0);
    this.buildMenu();
    this.topOpen = true;
  }

  endMenu(): void {
    this.topOpen = false;
  }

  releaseMenu(): void {
    this.topOpen = false;
    this.bottomOpen = false;
  }

  refreshTop(): void {
    if (this.topOpen) this.buildMenu();
  }

  /** `fnAddSubject`: a conversation topic for the bottom bar. */
  addSubject(subject: number): void {
    if (this.subjectBar.length >= 16) return;
    this.subjectBar.push(subject);
    this.host.setVar(SV.IN_SUBJECT, this.subjectBar.length);
  }

  /** `fnChooser`: show the subjects and park the compact in `LOGIC_choose`. */
  startChooser(compact: SwordCompact): void {
    this.host.setVar(SV.OBJECT_HELD, 0);
    this.setLuggage(0, 0);
    this.buildSubjects();
    compact.logic = SwordLogicMode.CHOOSE;
    this.bottomOpen = true;
  }

  endChooser(): void {
    // ScummVM's `fnEndChooser` clears the held subject and closes *both* bars.
    // The clear is not decoration: `OBJECT_HELD` carries the chosen subject id
    // back into the conversation script, and a subject left in it afterwards is
    // read by the next interact script as an inventory object being used, which
    // sends every later click down the wrong branch.
    this.host.setVar(SV.OBJECT_HELD, 0);
    this.setLuggage(0, 0);
    this.bottomOpen = false;
    this.topOpen = false;
    this.subjectBar = [];
    this.host.setVar(SV.IN_SUBJECT, 0);
    this.host.setVar(SV.SUBJECT_CHOSEN, 0);
  }

  /**
   * One cycle of the chooser: has the player picked something yet?
   *
   * Returns 1 when they have, which puts the compact back into `LOGIC_script`
   * so the conversation script resumes with `OBJECT_HELD` set to the subject.
   */
  logicChooser(compact: SwordCompact): number {
    let chosen = this.topOpen ? this.checkMenuClick('top') : 0;
    if (!chosen) chosen = this.checkMenuClick('bottom');
    if (!chosen) return 0;
    this.host.setVar(SV.SUBJECT_CHOSEN, 1);
    compact.logic = SwordLogicMode.SCRIPT;
    return 1;
  }

  /**
   * A click on an icon, which is the only place `OBJECT_HELD` comes from.
   *
   * ScummVM's `Menu::checkMenuClick`, and the two halves of it are genuinely
   * different rules rather than one rule with a parameter:
   *
   * - **While the conversation bar is up**, an icon is *highlighted* on the
   *   press and *answered* on the release. That is what lets a player press,
   *   see which topic they are on, and slide off it. The answer is the slot,
   *   one-based, because zero means "nothing picked yet" to `logicChooser`.
   * - **Otherwise** — the inventory — everything happens on the press. A left
   *   press with nothing held picks the icon up onto the pointer; with the same
   *   icon held it puts it down again; with a *different* icon held it sets
   *   `SECOND_ITEM`, which is `Mouse::engine`'s cue to run the held item's
   *   use-script. A right press is "look at", which sets `MENU_LOOKING` and the
   *   text the description script reads.
   *
   * Without this the bar could be opened and the icons drawn, and nothing a
   * player did to one of them reached a script: no item could be picked up, so
   * no item could be used on anything.
   */
  private checkMenuClick(bar: SwordMenuBar): number {
    if (!this.state) return 0;
    const held = this.host.getVar(SV.OBJECT_HELD);
    const icons = this.icons(bar);
    const picked = this.iconAt(this.pointerX, this.pointerY, bar);

    if (this.bottomOpen) {
      if (held && this.state & MOUSE_UP_MASK) {
        const slot = icons.findIndex((icon) => icon.value === held);
        return slot < 0 ? 0 : slot + 1;
      }
      if (this.state & MOUSE_DOWN_MASK && picked) {
        this.host.setVar(SV.OBJECT_HELD, picked.value);
        this.refreshBars();
      }
      return 0;
    }

    if (bar !== 'top' || !picked) return 0;
    const definition = SWORD1_MENU_OBJECTS[picked.value];
    if (this.state & BS1R_BUTTON_DOWN) {
      this.host.setVar(SV.OBJECT_HELD, picked.value);
      this.host.setVar(SV.MENU_LOOKING, 1);
      this.host.setVar(SV.DEFAULT_ICON_TEXT, definition?.textDesc ?? 0);
    } else if (this.state & BS1L_BUTTON_DOWN) {
      if (!held) {
        this.host.setVar(SV.OBJECT_HELD, picked.value);
        this.setLuggage(definition?.luggageIconRes ?? 0, 0);
      } else if (held === picked.value) {
        this.setLuggage(0, 0);
        this.host.setVar(SV.OBJECT_HELD, 0);
      } else {
        this.host.setVar(SV.SECOND_ITEM, picked.value);
        this.setLuggage(0, 0);
      }
    }
    this.refreshBars();
    return 0;
  }

  /** Both bars rebuilt, because highlighting depends on what is held. */
  private refreshBars(): void {
    if (this.topOpen) this.buildMenu();
    if (this.bottomOpen) this.buildSubjects();
  }

  /**
   * Which icon the pointer is over, or null.
   *
   * The bars are 40 pixels tall at the top and bottom of the 480-pixel display,
   * and each icon is 40 wide with the row centred — which is the geometry the
   * shipped icon graphics were authored at.
   */
  private iconAt(x: number, y: number, want?: SwordMenuBar): SwordMenuIcon | null {
    const iconWidth = SWORD1_MENU_ICON_WIDTH;
    const bar: SwordMenuBar | null = y < 40 ? 'top' : y >= 440 ? 'bottom' : null;
    if (!bar) return null;
    if (want && bar !== want) return null;
    if (bar === 'top' && !this.topOpen) return null;
    if (bar === 'bottom' && !this.bottomOpen) return null;
    const icons = this.icons(bar);
    if (icons.length === 0) return null;
    const left = Math.floor((640 - icons.length * iconWidth) / 2);
    const slot = Math.floor((x - left) / iconWidth);
    return icons.find((icon) => icon.slot === slot) ?? null;
  }

  /** Builds the inventory bar from the 52 pocket globals. */
  private buildMenu(): void {
    const held = this.host.getVar(SV.OBJECT_HELD);
    const second = this.host.getVar(SV.SECOND_ITEM);
    const looking = this.host.getVar(SV.MENU_LOOKING);
    const carried: number[] = [];
    for (let pocket = 0; pocket < SWORD1_TOTAL_POCKETS; pocket++) {
      if (this.host.getVar(SV.POCKET_1 + pocket)) carried.push(pocket + 1);
    }
    this.topIcons = carried.map((value, slot) => {
      const definition = SWORD1_MENU_OBJECTS[value];
      // Three highlighting rules, and they are not the same rule. While looking
      // or choosing, everything is lit unless one item is held. With a second
      // item picked, only the two involved are lit. Otherwise every icon *but*
      // the held one is lit — the held one is the greyed-out one.
      let selected: boolean;
      if (looking || this.bottomOpen) selected = !held || held === value;
      else if (second) selected = value === held || value === second;
      else selected = held !== value;
      return {
        slot,
        resource: definition?.bigIconRes ?? 0,
        frame: definition?.bigIconFrame ?? 0,
        selected,
        value,
      };
    });
  }

  /** Builds the conversation bar from the subjects a script added. */
  private buildSubjects(): void {
    const held = this.host.getVar(SV.OBJECT_HELD);
    this.bottomIcons = this.subjectBar.map((value, slot) => {
      const subject = sword1Subject(value & 0xffff);
      return {
        slot,
        resource: subject?.subjectRes ?? 0,
        frame: subject?.frameNo ?? 0,
        selected: held ? value === held : true,
        value,
      };
    });
  }

  /** Subject numbering, exported so a caller can name one in a log. */
  static get baseSubject(): number {
    return SWORD1_BASE_SUBJECT;
  }

  /** A line for the stall report. */
  describe(): string {
    const held = this.host.getVar(SV.OBJECT_HELD);
    return (
      `pointer ${this.pointerX},${this.pointerY}; ` +
      `mouse status ${this.host.getVar(SV.MOUSE_STATUS)}; ` +
      `${this.topOpen ? `${this.topIcons.length} inventory icons` : 'inventory closed'}; ` +
      `${this.bottomOpen ? `${this.bottomIcons.length} subjects` : 'chooser closed'}` +
      (held ? `; holding ${held}` : '')
    );
  }

  /** Status bits a save carries, so the pointer comes back as it was. */
  snapshot(): { pointer: number; luggage: number; subjects: number[] } {
    return { pointer: this.pointer.tag, luggage: this.luggage.tag, subjects: [...this.subjectBar] };
  }

  restore(state: { pointer: number; luggage: number; subjects: number[] }): void {
    this.pointer = { tag: state.pointer, rate: 0 };
    this.luggage = { tag: state.luggage, rate: 0 };
    this.subjectBar = [...state.subjects];
  }
}

/** Bit test helper for a compact's mouse flag, used by the engine's hit list. */
export function wantsMouse(compact: SwordCompact): boolean {
  return (compact.status & SwordStatus.MOUSE) !== 0;
}
