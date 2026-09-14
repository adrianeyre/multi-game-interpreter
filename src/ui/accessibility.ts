/**
 * The accessibility statement, and the footer link that opens it.
 *
 * Beside the cookie notice because it is the same kind of thing: a claim the
 * project makes about itself that a reader is entitled to check. A statement
 * nobody can find is not a statement, and the footer is where the other one
 * already lives.
 *
 * It reuses the consent dialog's shell — same overlay, same panel, same cross —
 * deliberately. Two dialogs that hold a document over the page should look like
 * two of the same thing, and a second stylesheet describing the same box would
 * be a copy waiting to drift.
 *
 * **The content is a report, not a marketing page.** It says what has been done,
 * and it says what is not done and why, because a conformance claim without its
 * exceptions is worth nothing to the person who hits one.
 */

import { prefersReducedMotion, trapFocus, type FocusTrap } from './a11y.js';

const REPOSITORY = 'https://github.com/adrianeyre/multi-game-interpreter';

/** Shown in the dialog, so a stale statement is visible as one. */
const LAST_REVIEWED = 'September 2026';

/** One claim the statement makes, and the detail behind it. */
interface Measure {
  title: string;
  detail: string;
}

/**
 * What has actually been built, grouped the way a reader looks for it.
 *
 * Written as data rather than as markup so the dialog cannot say one thing
 * while a heading says another, and so a new measure is one entry rather than
 * three edits.
 */
const MEASURES: Array<{ heading: string; items: Measure[] }> = [
  {
    heading: 'Using it without a mouse',
    items: [
      {
        title: 'Everything is operable from the keyboard',
        detail:
          'Every control, including the drawing canvases in the editor. Arrow keys move a ' +
          'cursor on the canvas, Enter or Space applies the current tool, Delete erases and ' +
          'P picks up the colour under the cursor. The room canvas also takes two presses ' +
          'to draw a rectangle or a walk box — one for each corner — and Alt with an arrow ' +
          'key moves whatever is selected.',
      },
      {
        title: 'Nothing needs a drag',
        detail:
          'Dropping game files on the page is a convenience, never a requirement: the two ' +
          'buttons in the title bar do the same job. In the editor, a click that does not ' +
          'move anchors the first corner of a shape and the next click finishes it, and ' +
          'every position and size can be typed into the panel on the right.',
      },
      {
        title: 'Focus is always visible, and never lost',
        detail:
          'A two-tone ring marks whatever holds focus, contrasty against every surface in ' +
          'the interface. Dialogs keep focus inside themselves while they are open, make ' +
          'the page behind them inert, close on Escape, and hand focus back to the control ' +
          'that opened them.',
      },
      {
        title: 'Long lists are one stop, not hundreds',
        detail:
          'Palettes, cel strips, tabs and the AGI pixel grid take a single Tab to reach ' +
          'and arrow keys to move within, so a 256-colour palette is one stop rather than ' +
          'two hundred and fifty-six.',
      },
      {
        title: 'A skip link on every page',
        detail:
          'The first thing Tab reaches is a link past the toolbar to the content, so the ' +
          'title bar is not walked again on every load.',
      },
    ],
  },
  {
    heading: 'Using it with a screen reader',
    items: [
      {
        title: 'Every control has a name that says what it does',
        detail:
          'Buttons whose face is a symbol carry words instead: a palette swatch is named ' +
          'by its index and its red, green and blue values, a cel by its number and how ' +
          'long it is held, a remove button by what it removes.',
      },
      {
        title: 'State is in the page, not only in the colours',
        detail:
          'Which tool is armed, which tab is open, which room is selected and which colour ' +
          'is chosen are all exposed as pressed, selected, checked or current — not left ' +
          'to a background colour to imply.',
      },
      {
        title: 'Things that happen are announced',
        detail:
          'Load progress, saves, refusals, compile problems, imports and the result of a ' +
          'keystroke on a canvas are sent to a polite live region. Repeating heartbeats — ' +
          'the frame counter, the pointer read-out — deliberately are not, because a ' +
          'message every second buries the messages that matter.',
      },
      {
        title: 'Landmarks and headings match the page',
        detail:
          'One banner, one main region, named side panels and one footer per page, with a ' +
          'heading structure that starts at the top rather than in the middle.',
      },
    ],
  },
  {
    heading: 'Seeing it',
    items: [
      {
        title: 'Contrast',
        detail:
          'Body text is at least 4.5 to 1 against its background and most of it is far ' +
          'above that. The visible edge of anything you can press or type into is at least ' +
          '3 to 1, which is why controls have a lighter outline than the rules between ' +
          'blocks of text.',
      },
      {
        title: 'Colour is never the only signal',
        detail:
          'The selected tool carries an underline as well as a fill, the open row in a list ' +
          'carries a bar, a concave walk box says the word “concave”, and a problem in the ' +
          'status line says “Problem”.',
      },
      {
        title: 'Targets are at least 24 by 24 pixels',
        detail: 'With one deliberate exception, described under Known limits below.',
      },
      {
        title: 'It reflows and it zooms',
        detail:
          'The whole interface works in a 320 pixel column, which is also what 400% zoom ' +
          'on a normal screen amounts to. The editor’s three columns become one rather ' +
          'than being cut off. Raised line height, letter spacing and word spacing reflow ' +
          'rather than clipping.',
      },
      {
        title: 'Motion and forced colours are respected',
        detail:
          'Asking your system for reduced motion stops the transitions and turns the ' +
          'loading spinner into a pulse rather than a rotation. In a forced-colours mode, ' +
          'the focus ring and every selected state are redrawn with system colours instead ' +
          'of being flattened away.',
      },
    ],
  },
  {
    heading: 'What it does not do to you',
    items: [
      {
        title: 'No time limits',
        detail:
          'Nothing on the page expires, times out or moves on without you. A game’s own ' +
          'pacing is the game’s, and it can be paused from the title bar.',
      },
      {
        title: 'No flashing',
        detail:
          'The interface flashes nothing. A game you load draws its own pictures, which is ' +
          'covered under Known limits.',
      },
      {
        title: 'No login, and nothing to re-enter',
        detail:
          'There is no account, no password and no form to fill in twice. Your work is ' +
          'kept in your own browser and reloaded for you.',
      },
    ],
  },
];

/**
 * Where the claim stops.
 *
 * The honest part of a conformance statement, and the part a reader actually
 * needs: three specific things, each with what is done about it instead.
 */
const LIMITS: Measure[] = [
  {
    title: 'A running game’s own pictures and words cannot be described',
    detail:
      'This is an interpreter for games written by other people in the 1980s and 1990s. ' +
      'What appears on the game screen is those games’ artwork and text, drawn sixty times ' +
      'a second, and no text alternative can be written for it here. What the application ' +
      'can do, and does, is name the screen, say which game and which room you are in, ' +
      'keep the engine log readable, and make every control around the picture accessible. ' +
      'A game’s own content is outside what this project can fix.',
  },
  {
    title: 'The AGI cel grid uses 12-pixel cells',
    detail:
      'One cell there is one pixel of the artwork being edited. At the 24 pixel minimum a ' +
      'cel would be four thousand pixels across and would no longer be legible as a ' +
      'drawing, so the size is essential to what is being shown — which is the exception ' +
      'the rule itself allows. The keyboard route is the answer instead: the grid is one ' +
      'tab stop, arrow keys move within it, and every cell is named by its row, its column ' +
      'and its colour.',
  },
  {
    title: 'The AGI typing line has not been checked with a real screen reader',
    detail:
      'Sierra’s parser games take typed commands, and the field that captures them is ' +
      'built to stay reachable by a screen reader and by a phone keyboard. That is ' +
      'guarded by tests, but nobody has yet sat down with an actual screen reader and ' +
      'typed a command into a real game. Until someone has, treat it as untested rather ' +
      'than as working.',
  },
];

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** A cross, inline so the dialog needs no network request to render. */
function closeMark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M18 6 6 18M6 6l12 12');
  svg.appendChild(path);
  return svg;
}

function buildDialog(): { overlay: HTMLElement; close: HTMLButtonElement } {
  const overlay = element('div', 'consent-overlay');
  overlay.id = 'accessibility-overlay';
  overlay.hidden = true;

  const dialog = element('div', 'consent-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'accessibility-title');
  dialog.setAttribute('aria-describedby', 'accessibility-intro');

  const head = element('div', 'consent-head');
  const title = element('h2', undefined, 'Accessibility');
  title.id = 'accessibility-title';
  const close = element('button', 'consent-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.appendChild(closeMark());
  head.append(title, close);

  const scroll = element('div', 'consent-scroll');
  scroll.appendChild(element('p', 'consent-updated', `Last reviewed: ${LAST_REVIEWED}`));

  const intro = element('p');
  intro.id = 'accessibility-intro';
  intro.textContent =
    'This site aims to meet WCAG 2.2 Level AA throughout — the player, the editor and ' +
    'everything in both. What follows is what that means in practice here, and where it ' +
    'stops.';
  scroll.appendChild(intro);

  for (const group of MEASURES) {
    scroll.appendChild(element('h3', undefined, group.heading));
    const list = element('ul', 'a11y-list');
    for (const item of group.items) {
      const entry = element('li');
      entry.append(element('strong', undefined, item.title), ` — ${item.detail}`);
      list.appendChild(entry);
    }
    scroll.appendChild(list);
  }

  scroll.appendChild(element('h3', undefined, 'Known limits'));
  const limits = element('ul', 'a11y-list');
  for (const item of LIMITS) {
    const entry = element('li');
    entry.append(element('strong', undefined, item.title), ` — ${item.detail}`);
    limits.appendChild(entry);
  }
  scroll.appendChild(limits);

  scroll.appendChild(element('h3', undefined, 'How this was checked'));
  const checked = element('p');
  checked.textContent =
    'By reading every surface against the WCAG 2.2 Level AA success criteria, by ' +
    'operating both pages with the keyboard alone, and by an automated test suite that ' +
    'renders the real interface and asserts its roles, names, states, focus behaviour and ' +
    'contrast. Automated checks catch a minority of accessibility problems; if something ' +
    'here does not work for you, that is a defect and not your fault.';
  scroll.appendChild(checked);

  scroll.appendChild(element('h3', undefined, 'Telling us something is wrong'));
  const contact = element('p');
  contact.append('This is an open source project, so the fastest route is ');
  const link = element('a', undefined, 'the issue tracker');
  link.href = `${REPOSITORY}/issues`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  contact.append(
    link,
    '. Say what you were using — screen reader, magnifier, keyboard, phone — and what ' +
      'happened; that is usually enough to reproduce it.',
  );
  scroll.appendChild(contact);

  dialog.append(head, scroll);
  overlay.appendChild(dialog);
  return { overlay, close };
}

/**
 * Adds the footer link and wires the dialog behind it.
 *
 * `anchor` is the credit bar on either page, which is where the cookie link
 * already sits — the two belong together, and a reader looking for one will
 * find the other.
 */
export function mountAccessibilityStatement(anchor?: HTMLElement | null): void {
  const reducedMotion = prefersReducedMotion();
  const { overlay, close } = buildDialog();
  document.body.append(overlay);

  let trap: FocusTrap | null = null;

  function open(): void {
    overlay.hidden = false;
    // Forces a reflow, so the transition runs from the closed state rather than
    // the dialog appearing already in place.
    void overlay.offsetWidth;
    overlay.classList.add('is-open');
    trap = trapFocus(overlay, { onEscape: closeDialog });
    close.focus();
  }

  function closeDialog(): void {
    if (overlay.hidden) return;
    overlay.classList.remove('is-open');
    const done = (): void => {
      overlay.hidden = true;
      overlay.removeEventListener('transitionend', done);
    };
    if (reducedMotion) done();
    else {
      overlay.addEventListener('transitionend', done);
      // A transition that never fires — a backgrounded tab, an interrupted
      // animation — would otherwise leave the dialog up for good.
      setTimeout(done, 350);
    }
    trap?.release();
    trap = null;
  }

  close.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (event) => {
    // Only the backdrop; a click inside the dialog bubbles to here too.
    if (event.target === overlay) closeDialog();
  });

  if (!anchor) return;

  const link = element('button', 'consent-link', 'Accessibility');
  link.type = 'button';
  link.setAttribute('aria-haspopup', 'dialog');
  // The visible word is one; what it opens is a statement. The accessible name
  // begins with the visible text, which is what 2.5.3 asks of it.
  link.setAttribute('aria-label', 'Accessibility — what this site does, and where it stops');
  link.addEventListener('click', open);
  anchor.appendChild(link);
}
