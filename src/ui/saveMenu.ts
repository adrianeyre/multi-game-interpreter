/**
 * The save and load menus: a board of ten slots, and the game they belong to.
 *
 * Saving used to be one button and one hidden slot. It wrote, it said "Saved",
 * and there was no way to write a second save, no way to tell one from another
 * and — because the Load button had been given to the show/hide toggle —
 * no way to read any of them back. What a save is *for* is choosing a moment to
 * return to, and none of that is possible without somewhere to see the moments.
 *
 * So: two flows over one panel.
 *
 * **Save** shows the running game's title and its ten slots. Picking one asks
 * what to call it, with the slot's existing name or a suggestion already in the
 * box, because a slot called "save 3" is a slot you will not recognise in a
 * fortnight.
 *
 * **Load** is the same board with a step in front of it: the games this browser
 * holds saves for, then that game's slots. Two steps rather than one flat list
 * of every save on the machine, because the question a player is answering is
 * "which game?" and only then "which moment?" — and a single list mixes two
 * games' room numbers into one column where neither means anything.
 *
 * The panel is the game details dialog's shell and stylesheet, deliberately:
 * same backdrop, same header, same cross, because it is the same kind of thing
 * — something over the page that you read, choose from, and dismiss.
 */
import type { SaveSummary } from '../engine/save/SaveStore.js';
import { SAVE_SLOTS } from '../engine/save/SaveStore.js';

import { announce, trapFocus, type FocusTrap } from './a11y.js';
import { closeIcon } from './icons.js';

/** What a slot holds, when it holds anything. */
export interface SlotSave {
  name: string;
  savedAt: number;
  room: number;
  /** The room's authored name, when the game carries one. */
  roomName?: string;
}

/** One position on the board, occupied or not. */
export interface SlotView {
  slot: number;
  save?: SlotSave;
}

/** One game in the Load menu's first step. */
export interface SavedGameView {
  gameId: string;
  title: string;
  /** The line under the title — what it runs on, and how many saves it has. */
  subtitle: string;
  slots: SlotView[];
}

export interface SaveRequest {
  /** The running game, named. */
  title: string;
  subtitle: string;
  /**
   * What to put in the name box for a slot that has none.
   *
   * The room the player is standing in, which is the one thing the shell knows
   * that would help them recognise the save later. Offered rather than imposed:
   * it is selected in the box, so typing over it costs one keystroke.
   */
  suggestedName: string;
  slots: SlotView[];
  /** Where these saves live, said once at the bottom. */
  note: string;
}

export interface LoadRequest {
  games: SavedGameView[];
  note: string;
}

export interface SaveMenu {
  /** Picks a slot and a name for it. Resolves null when dismissed instead. */
  save(request: SaveRequest): Promise<{ slot: number; name: string } | null>;
  /** Picks a game and one of its saves. Resolves null when dismissed instead. */
  load(request: LoadRequest): Promise<{ gameId: string; slot: number } | null>;
  /** Whether the menu is currently on screen. */
  isOpen(): boolean;
  hide(): void;
}

/** What a chosen save resolves to, whichever flow chose it. */
type Choice = { slot: number; name: string } | { gameId: string; slot: number } | null;

export function createSaveMenu(parent: HTMLElement = document.body): SaveMenu {
  const overlay = document.createElement('div');
  // The details dialog's classes plus one of our own, so the backdrop and panel
  // are shared and only the board inside needs styling.
  overlay.className = 'details-overlay save-overlay';
  overlay.id = 'save-menu-overlay';
  overlay.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'details-panel save-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const header = document.createElement('header');
  header.className = 'details-header';

  const headings = document.createElement('div');
  const heading = document.createElement('h2');
  heading.className = 'details-title';
  heading.id = 'save-menu-title';
  panel.setAttribute('aria-labelledby', heading.id);

  const subtitle = document.createElement('p');
  subtitle.className = 'details-subtitle';
  subtitle.id = `${heading.id}-subtitle`;
  panel.setAttribute('aria-describedby', subtitle.id);
  headings.append(heading, subtitle);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'details-close';
  close.setAttribute('aria-label', 'Close');
  close.title = 'Close';
  close.appendChild(closeIcon());

  header.append(headings, close);

  const body = document.createElement('div');
  body.className = 'details-body save-body';

  const footer = document.createElement('footer');
  footer.className = 'details-footer save-footer';

  const note = document.createElement('p');
  note.className = 'save-note';

  /**
   * The way back to the game list, shown only in the Load flow's second step.
   *
   * A button in the footer rather than a breadcrumb in the header: it is an
   * action — it changes what the dialog shows — and Escape closes the whole
   * dialog rather than stepping back, which is what Escape means everywhere
   * else on this page.
   */
  const back = document.createElement('button');
  back.type = 'button';
  back.className = 'save-back';
  back.textContent = '← All games';
  back.hidden = true;

  footer.append(note, back);
  panel.append(header, body, footer);
  overlay.append(panel);
  parent.appendChild(overlay);

  let trap: FocusTrap | null = null;
  /** Settles the pending flow, so a dismissal is an answer rather than a hang. */
  let settle: ((choice: Choice) => void) | null = null;
  /**
   * What the footer's back button does right now.
   *
   * Bound once here rather than on each `load()`, because a listener added per
   * call accumulates: the second time the menu is opened, one click would run
   * both openings' handlers and draw the older one's list of games.
   */
  let goBack: (() => void) | null = null;
  /**
   * How to put a half-typed slot name away, when one is open.
   *
   * Escape has to mean two different things a level apart — close the name box,
   * or close the menu — and only one handler ever sees the key: the focus trap
   * listens on the overlay in the capture phase, which by definition runs
   * before anything bound inside it. A listener on the form would be told after
   * the menu had already gone. So the trap asks here, and here is where the
   * level is decided.
   */
  let cancelNaming: (() => void) | null = null;

  function closePanel(): void {
    overlay.hidden = true;
    trap?.release();
    trap = null;
  }

  /** Escape: one level at a time, innermost first. */
  function onEscape(): void {
    if (cancelNaming) {
      cancelNaming();
      return;
    }
    hide();
  }

  function hide(): void {
    if (overlay.hidden) return;
    cancelNaming = null;
    // Settled before focus moves, and always: a caller awaiting an answer that
    // never arrives is a button that has silently stopped working.
    const pending = settle;
    settle = null;
    pending?.(null);
    closePanel();
  }

  function finish(choice: Choice): void {
    const pending = settle;
    // Cleared first so `hide` does not then settle the same promise with null.
    settle = null;
    closePanel();
    pending?.(choice);
  }

  /*
   * Keys typed in here are for here.
   *
   * The game underneath is paused but not deaf: every family attaches its key
   * listeners to the *window*, so a keystroke inside this dialog bubbles all
   * the way out to a game that is still listening. For SCUMM and SCI that
   * queues input to be delivered the moment play resumes; for AGI it is worse
   * than that — its handler pulls focus to the hidden parser field on any
   * single character, so the first letter of a save's name empties the box and
   * types itself into the game instead.
   *
   * `inert` on the background does not help: it removes the elements from the
   * tab order and from hit testing, and says nothing about a listener bound to
   * the window. Stopping the event at the overlay does, and does it for every
   * family at once without this module knowing which one is running.
   *
   * The bubble phase, so the focus trap — which listens on this same element in
   * the capture phase — still sees Tab and Escape first.
   */
  for (const type of ['keydown', 'keyup', 'keypress']) {
    overlay.addEventListener(type, (event) => event.stopPropagation());
  }

  back.addEventListener('click', () => goBack?.());
  close.addEventListener('click', hide);
  overlay.addEventListener('click', (event) => {
    // Only the backdrop. A click that began inside the panel — dragging across
    // a slot name to select it — must not close the dialog.
    if (event.target === overlay) hide();
  });

  function open(title: string, subtitleText: string, noteText: string): void {
    heading.textContent = title;
    subtitle.textContent = subtitleText;
    note.textContent = noteText;
    overlay.hidden = false;
    // After it is on screen, so the trap can measure what is focusable in it.
    trap ??= trapFocus(overlay, { onEscape });
  }

  /**
   * Draws the ten slots.
   *
   * One list for both flows, because the difference between them is what a
   * click does and not what a slot looks like: a player choosing where to save
   * and a player choosing what to load are reading the same board for the same
   * reason. What does differ is which rows are actionable — every slot can be
   * written, only an occupied one can be read — so an empty slot is a disabled
   * button in the Load flow and a perfectly good target in the Save one.
   */
  function renderSlots(
    slots: SlotView[],
    mode: 'save' | 'load',
    onPick: (slot: SlotView, row: HTMLLIElement) => void,
  ): HTMLUListElement {
    const list = document.createElement('ul');
    list.className = 'save-slots';
    list.setAttribute('aria-label', mode === 'save' ? 'Save slots' : 'Saved games in this game');

    for (const view of slots) {
      const row = document.createElement('li');
      row.className = 'save-slot-row';

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'save-slot';
      button.dataset.slot = String(view.slot);

      const number = document.createElement('span');
      number.className = 'save-slot-number';
      number.textContent = String(view.slot);
      // Read as part of the button's own name below, so the digit on its own is
      // not announced twice.
      number.setAttribute('aria-hidden', 'true');

      const text = document.createElement('span');
      text.className = 'save-slot-text';

      const name = document.createElement('span');
      name.className = view.save ? 'save-slot-name' : 'save-slot-name save-slot-empty';
      name.textContent = view.save ? view.save.name : 'Empty';

      const detail = document.createElement('span');
      detail.className = 'save-slot-detail';
      detail.textContent = view.save ? describeSave(view.save) : '';

      text.append(name, detail);
      button.append(number, text);

      // The whole sentence, because "3" and a name in two separate spans is
      // read as two unrelated fragments and neither says which slot it is.
      button.setAttribute('aria-label', describeSlot(view, mode));

      if (mode === 'load' && !view.save) {
        // Nothing to load. Disabled rather than absent, so the board keeps its
        // shape and slot 7 is in the same place in both menus.
        button.disabled = true;
      } else {
        button.addEventListener('click', () => onPick(view, row));
      }

      row.append(button);
      list.append(row);
    }

    return list;
  }

  /**
   * Turns one slot row into a name box.
   *
   * In the row rather than on a step of its own: the slot being named is the
   * one under the cursor, and a separate "what shall we call it?" screen loses
   * the only piece of context that matters — which of the ten this is, and what
   * was in it before.
   */
  function askForName(
    row: HTMLLIElement,
    view: SlotView,
    suggested: string,
    onConfirm: (name: string) => void,
    onCancel: () => void,
  ): void {
    const button = row.querySelector<HTMLButtonElement>('.save-slot');
    if (button) button.hidden = true;

    const form = document.createElement('form');
    form.className = 'save-slot-form';

    const label = document.createElement('label');
    label.className = 'save-slot-label';
    const caption = document.createElement('span');
    caption.className = 'visually-hidden';
    caption.textContent = `Name for slot ${view.slot}`;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'save-slot-input';
    input.id = `save-slot-name-${view.slot}`;
    // 3.3.2: the visible number is the label a sighted user reads, and this is
    // the same fact said to everyone else.
    label.htmlFor = input.id;
    input.value = view.save?.name ?? suggested;
    input.maxLength = 60;
    // The slot the player is naming, on the box itself: the number beside it is
    // hidden from assistive technology to stop it being read twice, so without
    // this the input would be an unnumbered box in a list of ten.
    input.setAttribute('aria-label', `Name for slot ${view.slot}`);

    label.append(caption, input);

    const confirm = document.createElement('button');
    confirm.type = 'submit';
    confirm.className = 'save-slot-confirm';
    confirm.textContent = view.save ? 'Overwrite' : 'Save here';

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'save-slot-cancel';
    cancel.textContent = 'Cancel';

    form.append(label, confirm, cancel);
    row.append(form);

    function restore(): void {
      cancelNaming = null;
      form.remove();
      if (button) {
        button.hidden = false;
        button.focus();
      }
    }

    // Escape steps back to the board rather than closing the whole menu: the
    // player is one level in, and losing the board as well is a keystroke that
    // undoes more than it was asked to.
    cancelNaming = () => {
      restore();
      onCancel();
    };

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      // Falling back rather than refusing an empty box: the player has already
      // said which slot they mean, and a blocked submit over a name is a dialog
      // arguing with someone who is trying to save their game.
      const typed = input.value.trim();
      cancelNaming = null;
      onConfirm(typed.length > 0 ? typed : suggested);
    });

    cancel.addEventListener('click', () => {
      restore();
      onCancel();
    });

    input.focus();
    // Selected rather than merely present, so the suggestion is one keystroke
    // from being replaced and zero from being accepted.
    input.select();
  }

  return {
    isOpen: () => !overlay.hidden,

    async save(request) {
      hide();
      back.hidden = true;
      goBack = null;
      open(request.title, request.subtitle, request.note);

      const list = renderSlots(request.slots, 'save', (view, row) => {
        askForName(
          row,
          view,
          request.suggestedName,
          (name) => finish({ slot: view.slot, name }),
          () => announce('Cancelled. Pick a slot to save into.'),
        );
      });
      body.replaceChildren(list);

      // The first slot, not the close button: the dialog exists to be chosen
      // from, and a keyboard user should arrive on the choice.
      body.querySelector<HTMLButtonElement>('.save-slot')?.focus();

      return await new Promise<{ slot: number; name: string } | null>((resolve) => {
        settle = resolve as (choice: Choice) => void;
      });
    },

    async load(request) {
      hide();
      open(
        'Load a game',
        request.games.length === 1
          ? 'One game has saves in this browser.'
          : `${request.games.length} games have saves in this browser.`,
        request.note,
      );

      const showGames = (): void => {
        back.hidden = true;
        heading.textContent = 'Load a game';
        subtitle.textContent =
          request.games.length === 1
            ? 'One game has saves in this browser.'
            : `${request.games.length} games have saves in this browser.`;

        const list = document.createElement('ul');
        list.className = 'save-games';
        list.setAttribute('aria-label', 'Games with saved data');

        for (const game of request.games) {
          const row = document.createElement('li');
          row.className = 'save-game-row';

          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'save-game';
          button.dataset.gameId = game.gameId;

          const title = document.createElement('span');
          title.className = 'save-game-title';
          title.textContent = game.title;

          const detail = document.createElement('span');
          detail.className = 'save-game-detail';
          detail.textContent = game.subtitle;

          button.append(title, detail);
          button.addEventListener('click', () => showSlotsFor(game));

          row.append(button);
          list.append(row);
        }

        body.replaceChildren(list);
        body.querySelector<HTMLButtonElement>('.save-game')?.focus();
      };

      const showSlotsFor = (game: SavedGameView): void => {
        back.hidden = false;
        heading.textContent = game.title;
        subtitle.textContent = game.subtitle;

        const list = renderSlots(game.slots, 'load', (view) => {
          finish({ gameId: game.gameId, slot: view.slot });
        });
        body.replaceChildren(list);

        // Which game's board this is, said out loud: the panel's contents
        // changed without the page navigating, and nothing else would say so.
        announce(`${game.title}. Choose a save to resume from.`);
        // The first slot that can actually be picked, rather than the first
        // slot: landing on a disabled control says "nothing here works".
        const first = body.querySelector<HTMLButtonElement>('.save-slot:not([disabled])');
        (first ?? back).focus();
      };

      goBack = showGames;
      showGames();

      return await new Promise<{ gameId: string; slot: number } | null>((resolve) => {
        settle = resolve as (choice: Choice) => void;
      });
    },

    hide,
  };
}

/** "12 September 2025, 14:03 · room 12 “bridge”" — enough to recognise a save by. */
export function describeSave(save: SlotSave): string {
  const when = new Date(save.savedAt);
  const stamp = Number.isFinite(when.getTime())
    ? when.toLocaleString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'date unknown';
  const room = save.roomName ? `room ${save.room} “${save.roomName}”` : `room ${save.room}`;
  return `${stamp} · ${room}`;
}

/** The whole of a slot as one sentence, for the button's accessible name. */
function describeSlot(view: SlotView, mode: 'save' | 'load'): string {
  if (!view.save) {
    return mode === 'save' ? `Slot ${view.slot}, empty. Save here.` : `Slot ${view.slot}, empty.`;
  }
  const what = `Slot ${view.slot}, ${view.save.name}, ${describeSave(view.save)}`;
  return mode === 'save' ? `${what}. Overwrite this save.` : `${what}. Resume from here.`;
}

/**
 * Turns a store's listing into a board of ten.
 *
 * Here rather than in the shell because it is the dialog's own shape being
 * built: the store answers "what is saved" as a sparse list of whatever
 * happens to exist, and the menu shows ten rows whether or not there is
 * anything in them. Somebody has to fill in the gaps, and the gaps belong to
 * whoever draws them.
 *
 * Built from the listing rather than from ten reads: `list()` already skips an
 * entry that will not parse, so a damaged slot shows as empty instead of as a
 * row that cannot be drawn.
 *
 * `roomName` is optional because it is the *running* game's to give: the Load
 * menu spans games that are not loaded, and for those a room number is all
 * there is.
 */
export function slotsFrom(
  summaries: SaveSummary[],
  roomName?: (room: number) => string | undefined,
): SlotView[] {
  const occupied = new Map(summaries.map((summary) => [summary.slot, summary]));

  return Array.from({ length: SAVE_SLOTS }, (_, index): SlotView => {
    const slot = index + 1;
    const found = occupied.get(slot);
    if (!found) return { slot };

    const named = roomName?.(found.room);
    return {
      slot,
      save: {
        name: found.name,
        savedAt: found.savedAt,
        room: found.room,
        ...(named ? { roomName: named } : {}),
      },
    };
  });
}

/** "SCUMM v5 · 3 saves" — what a game in the Load menu is, in one line. */
export function describeSavedGame(targetName: string | undefined, count: number): string {
  const saves = count === 1 ? '1 save' : `${count} saves`;
  return targetName ? `${targetName} · ${saves}` : saves;
}
