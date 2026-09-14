/**
 * Broken Sword II's mouse engine: the four modes, and the gestures between.
 *
 * `Sword2Pointer` is a state machine over an injected host, so every case here
 * is driven without a game: the inventory is a list this test hands over, and
 * what is asserted is which globals moved and which mode the pointer ended in.
 * That is the half worth pinning — the bar's pixels are `Sword2Menu`'s and are
 * covered where it is.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
  Sword2Pointer,
  SWORD2_MOUSE_MODE,
  type Sword2PointerHost,
  type Sword2PointerState,
} from '../src/engine/sword2/Sword2Pointer.js';
import {
  SWORD2_BOTTOM_MENU_LINE,
  SWORD2_ICON_START,
  SWORD2_ICON_SPACING,
  SWORD2_ICON_WIDTH,
  SWORD2_MENU,
  SWORD2_MENU_MASTER_OBJECT,
  SWORD2_SYSTEM_MENU,
  SWORD2_TOP_MENU_LINE,
  type Sword2MenuObject,
} from '../src/engine/sword2/Sword2Menu.js';
import { SV2 } from '../src/engine/sword2/script/sword2Vars.js';

/** The centre of pocket `n`, in display pixels. */
const pocketX = (n: number): number =>
  SWORD2_ICON_START + n * (SWORD2_ICON_WIDTH + SWORD2_ICON_SPACING) + SWORD2_ICON_WIDTH / 2;

/** A y inside the bottom bar, and one above it. */
const ON_BAR = SWORD2_BOTTOM_MENU_LINE + 5;
const IN_ROOM = 200;
/** A y inside the top bar, where the system menu lives. */
const ON_PANEL = SWORD2_TOP_MENU_LINE - 5;

class FakeHost implements Sword2PointerHost {
  vars = new Map<number, number>();
  carried: Sword2MenuObject[] = [];
  built = 0;
  hidden: number[] = [];
  examining: boolean | null = null;
  events: number[] = [];
  /** Room objects, as a rectangle-free "what is at this point" stub. */
  objectAt = new Map<string, number>();
  /** The system menu: which icons the shell says are live, and what was picked. */
  live: boolean[] = [false, false, true, true, false];
  systemBuilds: boolean[][] = [];
  picked: number[] = [];

  getVar(number: number): number {
    return this.vars.get(number) ?? 0;
  }
  setVar(number: number, value: number): void {
    this.vars.set(number, value);
  }
  inventory(): readonly Sword2MenuObject[] {
    return this.carried;
  }
  buildMenu(): void {
    this.built++;
  }
  hideMenu(menu: number): void {
    this.hidden.push(menu);
  }
  setExamining(examining: boolean): void {
    this.examining = examining;
  }
  setPlayerActionEvent(interactId: number): void {
    this.events.push(interactId);
  }
  objectUnder(roomX: number, roomY: number): number {
    return this.objectAt.get(`${roomX},${roomY}`) ?? 0;
  }
  buildSystemMenu(available: readonly boolean[]): void {
    this.systemBuilds.push([...available]);
  }
  systemMenuAvailable(): readonly boolean[] {
    return this.live;
  }
  systemMenuPick(choice: number): boolean {
    if (!this.live[choice]) return false;
    this.picked.push(choice);
    return true;
  }
}

const at = (
  displayX: number,
  displayY: number,
  buttons: { left?: boolean; right?: boolean } = {},
): Sword2PointerState => ({
  displayX,
  displayY,
  roomX: displayX,
  roomY: displayY,
  left: buttons.left ?? false,
  right: buttons.right ?? false,
});

describe('Broken Sword II mouse modes', () => {
  let host: FakeHost;
  let pointer: Sword2Pointer;

  beforeEach(() => {
    host = new FakeHost();
    host.carried = [
      { icon: 11, luggage: 111 },
      { icon: 22, luggage: 222 },
    ];
    pointer = new Sword2Pointer(host, SV2);
  });

  describe('normal mode', () => {
    it('runs a clicked room object’s action script', () => {
      host.objectAt.set('300,200', 77);
      pointer.run(at(300, IN_ROOM, { left: true }));

      expect(host.getVar(SV2.CLICKED_ID)).toBe(77);
      expect(host.events).toEqual([77]);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);
    });

    it('sends no event for a click on nothing', () => {
      pointer.run(at(300, IN_ROOM, { left: true }));

      expect(host.getVar(SV2.CLICKED_ID)).toBe(0);
      expect(host.events).toEqual([]);
    });

    /** The gesture the whole interface is built on, and the one that was missing. */
    it('opens the inventory when the pointer reaches the bottom of the screen', () => {
      pointer.run(at(300, ON_BAR));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.MENU);
      expect(host.built).toBe(1);
    });

    it('does not open it one pixel above the line', () => {
      pointer.run(at(300, SWORD2_BOTTOM_MENU_LINE - 1));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);
      expect(host.built).toBe(0);
    });

    /** `_mouseModeLocked`: a script holding something for the player wins. */
    it('refuses to open while a script holds an object for the player', () => {
      pointer.setObjectHeld(99);
      pointer.run(at(300, ON_BAR));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);
      expect(host.built).toBe(0);
    });

    it('goes straight to drag mode when the player is already holding something', () => {
      host.setVar(SV2.OBJECT_HELD, 11);
      pointer.run(at(300, ON_BAR));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.DRAG);
      expect(host.built).toBe(1);
    });
  });

  describe('menu mode', () => {
    beforeEach(() => {
      pointer.run(at(300, ON_BAR));
      host.built = 0;
    });

    it('closes when the pointer leaves the bar', () => {
      pointer.run(at(300, IN_ROOM));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);
      expect(host.hidden).toEqual([SWORD2_MENU.BOTTOM]);
    });

    it('left-clicking an icon picks it up and enters drag mode', () => {
      pointer.run(at(pocketX(1), ON_BAR, { left: true }));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.DRAG);
      expect(host.getVar(SV2.OBJECT_HELD)).toBe(22);
      expect(pointer.luggage).toBe(222);
      expect(host.getVar(SV2.EXIT_CLICK_ID)).toBe(0);
      expect(host.built).toBe(1);
    });

    it('right-clicking an icon examines it through menu_master', () => {
      pointer.run(at(pocketX(0), ON_BAR, { right: true }));

      expect(host.getVar(SV2.OBJECT_HELD)).toBe(11);
      expect(host.examining).toBe(true);
      expect(host.events).toEqual([SWORD2_MENU_MASTER_OBJECT]);
      // Examining does not pick the object up: the mode stays on the bar.
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.MENU);
    });

    it('ignores a click on an empty pocket', () => {
      pointer.run(at(pocketX(5), ON_BAR, { left: true }));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.MENU);
      expect(host.getVar(SV2.OBJECT_HELD)).toBe(0);
    });
  });

  describe('drag mode', () => {
    beforeEach(() => {
      pointer.run(at(300, ON_BAR));
      pointer.run(at(pocketX(0), ON_BAR, { left: true }));
      host.built = 0;
      host.events = [];
    });

    /** The way a held object is used on the room: leave the bar, still holding. */
    it('drops back to normal mode still holding the object', () => {
      pointer.run(at(300, IN_ROOM));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);
      expect(host.getVar(SV2.OBJECT_HELD)).toBe(11);
      expect(host.hidden).toEqual([SWORD2_MENU.BOTTOM]);
    });

    it('clicking a second icon sets it as the combine base', () => {
      pointer.run(at(pocketX(1), ON_BAR, { left: true }));

      expect(host.getVar(SV2.COMBINE_BASE)).toBe(22);
      expect(host.getVar(SV2.OBJECT_HELD)).toBe(11);
      expect(host.events).toEqual([SWORD2_MENU_MASTER_OBJECT]);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.MENU);
    });

    /** The only way to put something down. */
    it('clicking the same icon again cancels and puts it down', () => {
      pointer.run(at(pocketX(0), ON_BAR, { left: true }));

      expect(host.getVar(SV2.OBJECT_HELD)).toBe(0);
      expect(host.getVar(SV2.COMBINE_BASE)).toBe(0);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.MENU);
      expect(pointer.luggage).toBe(0);
    });
  });

  describe('system menu', () => {
    it('opens when the pointer reaches the top of the screen', () => {
      pointer.run(at(300, ON_PANEL));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.SYSTEM_MENU);
      expect(host.systemBuilds).toEqual([[false, false, true, true, false]]);
    });

    it('does not open it one pixel below the line', () => {
      pointer.run(at(300, SWORD2_TOP_MENU_LINE));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);
      expect(host.systemBuilds).toEqual([]);
    });

    /** "No save in big-object menu lock situation, or if dragging an object." */
    it('does not open while something is held', () => {
      pointer.setObjectHeld(99);
      pointer.run(at(300, ON_PANEL));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);
      expect(host.systemBuilds).toEqual([]);
    });

    it('closes again when the pointer leaves the bar', () => {
      pointer.run(at(300, ON_PANEL));
      pointer.run(at(300, IN_ROOM));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);
      expect(host.hidden).toEqual([SWORD2_MENU.TOP]);
    });

    it('a click on the save icon asks the shell, and closes the panel', () => {
      pointer.run(at(300, ON_PANEL));
      pointer.run(at(pocketX(SWORD2_SYSTEM_MENU.SAVE), ON_PANEL, { left: true }));

      expect(host.picked).toEqual([SWORD2_SYSTEM_MENU.SAVE]);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);
      expect(host.hidden).toEqual([SWORD2_MENU.TOP]);
    });

    it('a click on the restore icon asks the shell', () => {
      pointer.run(at(300, ON_PANEL));
      pointer.run(at(pocketX(SWORD2_SYSTEM_MENU.RESTORE), ON_PANEL, { left: true }));

      expect(host.picked).toEqual([SWORD2_SYSTEM_MENU.RESTORE]);
    });

    /** A greyed icon is a click the game ignores, not a reason to close. */
    it('a click on a greyed icon leaves the panel up and runs nothing', () => {
      pointer.run(at(300, ON_PANEL));
      pointer.run(at(pocketX(SWORD2_SYSTEM_MENU.QUIT), ON_PANEL, { left: true }));

      expect(host.picked).toEqual([]);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.SYSTEM_MENU);
      expect(host.hidden).toEqual([]);
    });

    it('a right-click does nothing: the panel is left-button only', () => {
      pointer.run(at(300, ON_PANEL));
      pointer.run(at(pocketX(SWORD2_SYSTEM_MENU.SAVE), ON_PANEL, { right: true }));

      expect(host.picked).toEqual([]);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.SYSTEM_MENU);
    });

    /**
     * "If George is dead, the system menu is visible all the time, and is the
     * only thing that can be used" — so it takes the mode, and keeps it.
     */
    it('takes the pointer while the player is dead and will not give it back', () => {
      host.setVar(SV2.DEAD, 1);
      pointer.run(at(300, IN_ROOM));

      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.SYSTEM_MENU);

      pointer.run(at(300, IN_ROOM));
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.SYSTEM_MENU);
      expect(host.hidden).toEqual([]);
    });

    it('stays up after a pick while the player is dead', () => {
      host.setVar(SV2.DEAD, 1);
      pointer.run(at(300, IN_ROOM));
      pointer.run(at(pocketX(SWORD2_SYSTEM_MENU.RESTORE), ON_PANEL, { left: true }));

      expect(host.picked).toEqual([SWORD2_SYSTEM_MENU.RESTORE]);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.SYSTEM_MENU);
      expect(host.hidden).toEqual([]);
      // Rebuilt rather than left as it was: the open, and again after the pick.
      expect(host.systemBuilds).toHaveLength(2);
    });
  });

  /**
   * A click is an event in a one-slot queue, not a flag that is true for one
   * cycle. Every arm of the original's `mouseEngine` reads it *after* its own
   * early returns, so the cycle that opens the inventory leaves the press for
   * the cycle that can use it. Getting this wrong is invisible in a unit test
   * of one arm and fatal in the game: the press that opens the bar is usually
   * the same press meant for the icon under it.
   */
  describe('a press is an event, not a flag', () => {
    it('leaves the press unread on the cycle the bar opens, and reads it on the next', () => {
      const press = at(pocketX(0), ON_BAR, { left: true });

      expect(pointer.run(press)).toBe(false);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.MENU);
      expect(host.getVar(SV2.OBJECT_HELD)).toBe(0);

      expect(pointer.run(press)).toBe(true);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.DRAG);
      expect(host.getVar(SV2.OBJECT_HELD)).toBe(11);
      expect(pointer.luggage).toBe(111);
    });

    it('uses the press up even when it lands on no icon', () => {
      pointer.run(at(300, ON_BAR));
      // Past the last pocket: `menuClick` returns -1 and the original has
      // already taken the event by then, so the press does not survive to be
      // acted on somewhere else.
      expect(pointer.run(at(639, ON_BAR, { left: true }))).toBe(true);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.MENU);
    });

    it('leaves the press unread on the cycle the bar closes', () => {
      pointer.run(at(300, ON_BAR));
      expect(pointer.run(at(300, IN_ROOM, { left: true }))).toBe(false);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);
      expect(host.hidden).toEqual([SWORD2_MENU.BOTTOM]);
    });

    it('reads a press on nothing, so a cycle with no click is still a cycle', () => {
      expect(pointer.run(at(300, IN_ROOM))).toBe(true);
    });
  });

  describe('fnAddHuman', () => {
    it('drops what was dragged and unlocks the mode', () => {
      pointer.setObjectHeld(99);
      expect(host.getVar(SV2.OBJECT_HELD)).toBe(99);

      pointer.addHuman();

      expect(host.getVar(SV2.OBJECT_HELD)).toBe(0);
      expect(pointer.luggage).toBe(0);
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);

      // And the lock is gone, so the bar opens again.
      pointer.run(at(300, ON_BAR));
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.MENU);
    });

    /**
     * "If mouse is over menu area ... VITAL - reset things" (`mouse.cpp:1401`).
     * The reset is conditional, and this project used to do it unconditionally:
     * a script handing the pointer back closed a panel the player had opened.
     */
    it('puts the mode back to normal only when the pointer is on the bar', () => {
      pointer.run(at(300, ON_PANEL));
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.SYSTEM_MENU);

      pointer.addHuman();
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.SYSTEM_MENU);

      // Two cycles: the first closes the panel the pointer has left, the
      // second is `normalMouse` noticing the bar.
      pointer.run(at(300, ON_BAR));
      pointer.run(at(300, ON_BAR));
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.MENU);

      pointer.addHuman();
      expect(pointer.mode).toBe(SWORD2_MOUSE_MODE.NORMAL);
    });
  });
});
