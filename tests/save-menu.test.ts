// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import {
  createSaveMenu,
  describeSavedGame,
  slotsFrom,
  type SavedGameView,
  type SlotView,
} from '../src/ui/saveMenu.js';
import { SAVE_SLOTS } from '../src/engine/save/SaveStore.js';

/**
 * The save and load menus, as a player works them.
 *
 * What is asserted here is the whole of what the shell promises: ten slots you
 * can see all of, a name you chose rather than a number, and a route back to a
 * game saved in some earlier visit. The store beneath it is tested separately;
 * nothing here touches storage, because a dialog that reads a slot correctly
 * and shows it in the wrong row is still a broken dialog.
 */

function pressEscape(on: Element = document.activeElement ?? document.body): void {
  on.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
}

const overlay = (): HTMLElement => document.querySelector<HTMLElement>('#save-menu-overlay')!;
const dialog = (): HTMLElement => overlay().querySelector<HTMLElement>('[role="dialog"]')!;
const slots = (): HTMLButtonElement[] => [
  ...overlay().querySelectorAll<HTMLButtonElement>('.save-slot'),
];
const games = (): HTMLButtonElement[] => [
  ...overlay().querySelectorAll<HTMLButtonElement>('.save-game'),
];
const heading = (): string => overlay().querySelector('.details-title')!.textContent ?? '';
const subtitle = (): string => overlay().querySelector('.details-subtitle')!.textContent ?? '';

/** Ten slots with the named ones filled in. */
function board(filled: Record<number, string> = {}): SlotView[] {
  return Array.from({ length: SAVE_SLOTS }, (_, index): SlotView => {
    const slot = index + 1;
    const name = filled[slot];
    return name
      ? { slot, save: { name, savedAt: 1_700_000_000_000 + slot, room: 10 + slot } }
      : { slot };
  });
}

beforeEach(() => {
  document.body.replaceChildren();
  // Something for the trap to make inert, and somewhere for focus to return to.
  const bar = document.createElement('div');
  bar.innerHTML = '<button id="save-game">Save</button>';
  document.body.append(bar);
});

function openSave(
  overrides: Partial<Parameters<ReturnType<typeof createSaveMenu>['save']>[0]> = {},
) {
  const menu = createSaveMenu();
  const answer = menu.save({
    title: 'Monkey Island 2',
    subtitle: 'SCUMM v5 · room 12 “the beach”',
    suggestedName: 'the beach',
    slots: board({ 3: 'before the maze' }),
    note: 'Saves are kept in this browser.',
    ...overrides,
  });
  return { menu, answer };
}

describe('the save menu', () => {
  it('names the game it is about to save', () => {
    openSave();

    expect(overlay().hidden).toBe(false);
    expect(heading()).toBe('Monkey Island 2');
    expect(subtitle()).toBe('SCUMM v5 · room 12 “the beach”');
  });

  /** A board you can see all of at once is the entire point of ten. */
  it('shows ten slots, occupied and empty alike', () => {
    openSave();

    expect(slots()).toHaveLength(SAVE_SLOTS);
    expect(slots()[2].textContent).toContain('before the maze');
    expect(slots()[0].textContent).toContain('Empty');
    // Every slot is a target: an empty one is where a new save goes, and an
    // occupied one is overwritten on purpose.
    expect(slots().every((slot) => !slot.disabled)).toBe(true);
  });

  it('says which room and when, so one save can be told from another', () => {
    openSave({ slots: board({ 1: 'in the swamp' }) });

    expect(slots()[0].textContent).toContain('room 11');
  });

  /**
   * 4.1.2. The number sits in its own span and is hidden from assistive
   * technology to stop it being read twice, so the button's own name has to
   * carry the whole sentence.
   */
  it('names each slot as one sentence', () => {
    openSave();

    expect(slots()[0].getAttribute('aria-label')).toMatch(/^Slot 1, empty\. Save here\.$/);
    expect(slots()[2].getAttribute('aria-label')).toMatch(/^Slot 3, before the maze,.*Overwrite/);
  });

  it('opens as a modal dialog named by its heading, with focus on the first slot', () => {
    openSave();

    expect(dialog().getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog().getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBe('Monkey Island 2');
    expect(document.activeElement).toBe(slots()[0]);
  });

  describe('naming a slot', () => {
    it('offers the room as a name, ready to be typed over', () => {
      openSave();
      slots()[0].click();

      const input = overlay().querySelector<HTMLInputElement>('.save-slot-input')!;
      expect(input.value).toBe('the beach');
      expect(document.activeElement).toBe(input);
    });

    /** Overwriting starts from what is there, because that is usually the edit. */
    it('offers the existing name when the slot is occupied', () => {
      openSave();
      slots()[2].click();

      expect(overlay().querySelector<HTMLInputElement>('.save-slot-input')!.value).toBe(
        'before the maze',
      );
      expect(overlay().querySelector('.save-slot-confirm')!.textContent).toBe('Overwrite');
    });

    it('resolves with the slot and the name that was typed', async () => {
      const { answer } = openSave();
      slots()[4].click();

      const input = overlay().querySelector<HTMLInputElement>('.save-slot-input')!;
      input.value = 'just before the ghost ship';
      overlay().querySelector<HTMLFormElement>('.save-slot-form')!.requestSubmit();

      await expect(answer).resolves.toEqual({ slot: 5, name: 'just before the ghost ship' });
      expect(overlay().hidden).toBe(true);
    });

    /**
     * The player has already said which slot they mean. Blocking the submit
     * over a blank box is a dialog arguing with someone trying to save.
     */
    it('falls back to the suggestion rather than refusing an empty name', async () => {
      const { answer } = openSave();
      slots()[0].click();

      overlay().querySelector<HTMLInputElement>('.save-slot-input')!.value = '   ';
      overlay().querySelector<HTMLFormElement>('.save-slot-form')!.requestSubmit();

      await expect(answer).resolves.toEqual({ slot: 1, name: 'the beach' });
    });

    /** One level in, so Escape gives back the board rather than the whole menu. */
    it('steps back to the board on Escape, keeping the menu open', () => {
      openSave();
      slots()[0].click();
      expect(overlay().querySelector('.save-slot-form')).not.toBeNull();

      pressEscape(overlay().querySelector('.save-slot-input')!);

      expect(overlay().querySelector('.save-slot-form')).toBeNull();
      expect(overlay().hidden).toBe(false);
      expect(document.activeElement).toBe(slots()[0]);
    });

    it('does the same from the Cancel button', () => {
      openSave();
      slots()[0].click();
      overlay().querySelector<HTMLButtonElement>('.save-slot-cancel')!.click();

      expect(overlay().querySelector('.save-slot-form')).toBeNull();
      expect(overlay().hidden).toBe(false);
    });
  });

  describe('dismissing it', () => {
    /**
     * A caller awaiting an answer that never arrives is a button that has
     * silently stopped working — and this caller has paused the game.
     */
    it('resolves null from the close button', async () => {
      const { answer } = openSave();
      overlay().querySelector<HTMLButtonElement>('.details-close')!.click();

      await expect(answer).resolves.toBeNull();
    });

    it('resolves null from Escape', async () => {
      const { answer } = openSave();
      pressEscape(slots()[0]);

      await expect(answer).resolves.toBeNull();
    });

    it('resolves null from a click on the backdrop', async () => {
      const { answer } = openSave();
      overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }));

      await expect(answer).resolves.toBeNull();
    });

    /** A click that began inside the panel must not take the panel away. */
    it('stays open when the click was inside the panel', () => {
      openSave();
      dialog().dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(overlay().hidden).toBe(false);
    });
  });
});

const LIBRARY: SavedGameView[] = [
  {
    gameId: 'monkey2',
    title: 'Monkey Island 2',
    subtitle: 'SCUMM v5 · 2 saves',
    slots: board({ 1: 'the beach', 4: 'before the maze' }),
  },
  {
    gameId: 'kq3',
    title: "King's Quest III",
    subtitle: 'AGI v2 · 1 save',
    slots: board({ 2: 'out of the tower' }),
  },
];

function openLoad(list: SavedGameView[] = LIBRARY) {
  const menu = createSaveMenu();
  const answer = menu.load({ games: list, note: 'Saves are kept in this browser.' });
  return { menu, answer };
}

describe('the load menu', () => {
  /**
   * Which game, then which moment. One flat list of every save on the machine
   * mixes two games' room numbers into a column where neither means anything.
   */
  it('asks which game first', () => {
    openLoad();

    expect(heading()).toBe('Load a game');
    expect(games().map((game) => game.querySelector('.save-game-title')!.textContent)).toEqual([
      'Monkey Island 2',
      "King's Quest III",
    ]);
    expect(games()[0].textContent).toContain('SCUMM v5 · 2 saves');
    expect(document.activeElement).toBe(games()[0]);
  });

  it('counts the games it found', () => {
    openLoad();
    expect(subtitle()).toBe('2 games have saves in this browser.');
  });

  it('does not say "1 games"', () => {
    openLoad([LIBRARY[0]]);
    expect(subtitle()).toBe('One game has saves in this browser.');
  });

  it('shows that game’s board once one is picked', () => {
    openLoad();
    games()[0].click();

    expect(heading()).toBe('Monkey Island 2');
    expect(subtitle()).toBe('SCUMM v5 · 2 saves');
    expect(slots()).toHaveLength(SAVE_SLOTS);
    expect(slots()[0].textContent).toContain('the beach');
  });

  /**
   * Disabled rather than absent, so the board keeps its shape and slot 7 is in
   * the same place in both menus — but focus must not land on one, because a
   * dead control says "nothing here works".
   */
  it('disables the empty slots and lands on the first that is not', () => {
    openLoad();
    games()[1].click();

    expect(slots()[0].disabled).toBe(true);
    expect(slots()[1].disabled).toBe(false);
    expect(document.activeElement).toBe(slots()[1]);
  });

  it('resolves with the game and the slot', async () => {
    const { answer } = openLoad();
    games()[0].click();
    slots()[3].click();

    await expect(answer).resolves.toEqual({ gameId: 'monkey2', slot: 4 });
    expect(overlay().hidden).toBe(true);
  });

  it('goes back to the games from the second step', () => {
    openLoad();
    const back = overlay().querySelector<HTMLButtonElement>('.save-back')!;
    expect(back.hidden).toBe(true);

    games()[0].click();
    expect(back.hidden).toBe(false);

    back.click();
    expect(heading()).toBe('Load a game');
    expect(games()).toHaveLength(2);
  });

  /**
   * A listener added per opening accumulates: the second time the menu is
   * opened, one click on Back would run both openings' handlers.
   */
  it('goes back to this opening’s games, not an earlier one’s', () => {
    const menu = createSaveMenu();
    void menu.load({ games: LIBRARY, note: '' });
    menu.hide();
    void menu.load({ games: [LIBRARY[1]], note: '' });

    games()[0].click();
    overlay().querySelector<HTMLButtonElement>('.save-back')!.click();

    expect(games()).toHaveLength(1);
    expect(games()[0].querySelector('.save-game-title')!.textContent).toBe("King's Quest III");
  });

  it('resolves null when dismissed without choosing', async () => {
    const { answer } = openLoad();
    games()[0].click();
    pressEscape(slots()[0]);

    await expect(answer).resolves.toBeNull();
  });
});

describe('the game underneath', () => {
  /**
   * Every family attaches its key listeners to the window, and pausing the game
   * does not make it deaf. AGI is the loud case: its handler pulls focus to the
   * hidden parser field on any single character, so without this the first
   * letter of a save's name empties the box and types itself into the game.
   */
  it('does not let a typed save name reach a listener on the window', () => {
    const heard: string[] = [];
    window.addEventListener('keydown', (event) => heard.push(event.key));

    openSave();
    slots()[0].click();
    const input = overlay().querySelector<HTMLInputElement>('.save-slot-input')!;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));

    expect(heard).toEqual([]);
  });

  /** The trap listens on the same element in the capture phase, so it still wins. */
  it('still closes on Escape and still cycles on Tab', async () => {
    const { answer } = openSave();
    slots()[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    await expect(answer).resolves.toBeNull();
  });
});

describe('turning a store listing into a board', () => {
  /**
   * The store answers with whatever happens to exist; the menu shows ten rows
   * whether or not there is anything in them. Somebody has to fill in the gaps.
   */
  it('is always ten, in slot order, however sparse the listing', () => {
    const board = slotsFrom([
      { slot: 7, name: 'late', savedAt: 900, room: 3 },
      { slot: 2, name: 'early', savedAt: 100, room: 1 },
    ]);

    expect(board).toHaveLength(SAVE_SLOTS);
    expect(board.map((view) => view.slot)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(board[1].save?.name).toBe('early');
    expect(board[6].save?.name).toBe('late');
    expect(board[0].save).toBeUndefined();
  });

  it('names the room when the running game can name it', () => {
    const board = slotsFrom([{ slot: 1, name: 'here', savedAt: 1, room: 12 }], (room) =>
      room === 12 ? 'the bridge' : undefined,
    );

    expect(board[0].save?.roomName).toBe('the bridge');
  });

  /**
   * A room name is the *running* game's to give, and the Load menu spans games
   * that are not loaded. A number is all there is for those.
   */
  it('leaves the room unnamed when nothing can name it', () => {
    const board = slotsFrom([{ slot: 1, name: 'here', savedAt: 1, room: 12 }]);

    expect(board[0].save?.roomName).toBeUndefined();
    expect(board[0].save?.room).toBe(12);
  });

  it('drops a room name the game does not have', () => {
    const board = slotsFrom([{ slot: 1, name: 'here', savedAt: 1, room: 99 }], () => undefined);

    expect(board[0].save).not.toHaveProperty('roomName');
  });
});

describe('describing a game in the load menu', () => {
  it('counts saves without saying "1 saves"', () => {
    expect(describeSavedGame('SCUMM v5', 1)).toBe('SCUMM v5 · 1 save');
    expect(describeSavedGame('SCUMM v5', 3)).toBe('SCUMM v5 · 3 saves');
  });

  /** An older record carries no target, and a count on its own still reads. */
  it('says what it knows when the target was never recorded', () => {
    expect(describeSavedGame(undefined, 2)).toBe('2 saves');
  });
});
