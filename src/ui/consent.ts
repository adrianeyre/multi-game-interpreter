/**
 * The storage notice, and the policy behind it.
 *
 * This project sends nothing anywhere — a game is read in the browser and stays
 * there — but it does keep things in the browser between visits: ten saved-game
 * slots per game and the title each game is listed under, the editor's autosave
 * of the project you are building, and the player's handoff of an imported game
 * to the editor through IndexedDB. That is worth saying plainly and in one
 * place, rather than leaving someone to infer it from the absence of a notice.
 *
 * Built in script rather than written into both pages' markup, for the same
 * reason as the credit beside it: two copies of the same block drift, and the
 * player and the editor store overlapping sets of the same keys.
 */

import { prefersReducedMotion, trapFocus, type FocusTrap } from './a11y.js';
import { DATABASE_NAME, STORAGE_KEYS } from './storageKeys.js';

const REPOSITORY = 'https://github.com/adrianeyre/multi-game-interpreter';

/** Namespaced like every other key this project writes. */
const CONSENT_KEY = STORAGE_KEYS.consent;

/** Shown in the dialog, so a stale policy is visible as one. */
const LAST_UPDATED = 'September 2026';

interface StoredItem {
  name: string;
  kind: 'Essential' | 'Functional';
  purpose: string;
}

/**
 * Everything this project writes to the browser.
 *
 * The names come from `storageKeys.ts`, which is where they are declared and
 * where the code that writes them reads them from — so this list cannot say
 * one thing while the browser holds another.
 */
const STORED: StoredItem[] = [
  {
    name: STORAGE_KEYS.project,
    kind: 'Functional',
    purpose: 'The game you are building in the editor, saved as you work.',
  },
  {
    name: STORAGE_KEYS.projectBackup,
    kind: 'Functional',
    purpose: 'The previous autosave, kept so a bad edit can be undone.',
  },
  {
    name: STORAGE_KEYS.projectMeta,
    kind: 'Functional',
    purpose: 'When that project was last written, and how large it is.',
  },
  {
    name: STORAGE_KEYS.editorSections,
    kind: 'Functional',
    purpose: 'Which editor panels you left open.',
  },
  {
    // Listed as the set rather than as four more rows: they hold the same
    // thing for the same reason, and the notice is read by a person deciding
    // whether to allow it rather than by a machine matching names.
    name: `${STORAGE_KEYS.editorSectionsAgos}, ${STORAGE_KEYS.editorSectionsSword1}, ${STORAGE_KEYS.editorSectionsSword2}, ${STORAGE_KEYS.editorSectionsSci}`,
    kind: 'Functional',
    purpose:
      'The same, for the Simon the Sorcerer, Broken Sword, Broken Sword II and Sierra SCI sidebars, which have sections of their own.',
  },
  {
    name: CONSENT_KEY,
    kind: 'Essential',
    purpose: 'Remembers that you have seen this notice, so it is shown once.',
  },
  {
    name: `${DATABASE_NAME} (IndexedDB)`,
    kind: 'Functional',
    purpose:
      'A game handed from the player to the editor, and any audio too large to sit inside the saved project.',
  },
  {
    name: 'scumm.save.<game>.<slot>',
    kind: 'Functional',
    purpose:
      'Your saved games, one key per slot, ten slots per game. Still named for SCUMM, because renaming it would orphan saves already in your browser.',
  },
  {
    name: 'scumm.save.<game>.meta',
    kind: 'Functional',
    purpose:
      'What each of those games is called, so the Load menu can name a game you have not opened this visit. A title and the folder it came from — no part of the game itself.',
  },
];

/** Whether the notice has already been acknowledged. */
function acknowledged(): boolean {
  // Private windows and blocked site data both throw rather than return null,
  // and a notice that crashes the page it is explaining is worse than one shown
  // twice.
  try {
    return localStorage.getItem(CONSENT_KEY) !== null;
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    localStorage.setItem(CONSENT_KEY, 'acknowledged');
  } catch {
    // Nothing to do: the notice reappears next visit, which is the honest
    // outcome when the browser will not let us record that it was seen.
  }
}

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

/** A cookie, inline so the notice needs no network request to render. */
function cookieMark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20');
  svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  body.setAttribute('d', 'M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5z');
  svg.appendChild(body);

  for (const [cx, cy] of [
    [9, 11],
    [14.5, 15.5],
    [15, 9],
  ]) {
    const chip = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    chip.setAttribute('cx', String(cx));
    chip.setAttribute('cy', String(cy));
    chip.setAttribute('r', '1');
    svg.appendChild(chip);
  }

  return svg;
}

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

function buildTable(): HTMLElement {
  const scroll = element('div', 'consent-table-scroll');
  const table = element('table', 'consent-table');

  const caption = element('caption', undefined, 'What this site keeps in your browser.');
  table.appendChild(caption);

  const head = element('thead');
  const headRow = element('tr');
  for (const label of ['Name', 'Type', 'Purpose']) {
    const cell = element('th', undefined, label);
    cell.setAttribute('scope', 'col');
    headRow.appendChild(cell);
  }
  head.appendChild(headRow);
  table.appendChild(head);

  const body = element('tbody');
  for (const item of STORED) {
    const row = element('tr');
    const name = element('td');
    name.appendChild(element('code', undefined, item.name));
    row.appendChild(name);
    row.appendChild(element('td', undefined, item.kind));
    row.appendChild(element('td', undefined, item.purpose));
    body.appendChild(row);
  }
  table.appendChild(body);

  scroll.appendChild(table);
  return scroll;
}

function paragraph(parent: HTMLElement, text: string): void {
  parent.appendChild(element('p', undefined, text));
}

function buildDialog(): { overlay: HTMLElement; close: HTMLButtonElement } {
  const overlay = element('div', 'consent-overlay');
  overlay.id = 'consent-overlay';
  overlay.hidden = true;

  const dialog = element('div', 'consent-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', 'consent-title');

  const head = element('div', 'consent-head');
  const title = element('h2', undefined, 'Cookies and local storage');
  title.id = 'consent-title';
  const close = element('button', 'consent-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.appendChild(closeMark());
  head.append(title, close);

  const scroll = element('div', 'consent-scroll');
  scroll.appendChild(element('p', 'consent-updated', `Last updated: ${LAST_UPDATED}`));

  scroll.appendChild(element('h3', undefined, 'This site sets no cookies'));
  paragraph(
    scroll,
    'Not one. What it does use is your browser’s own local storage, which serves ' +
      'the same purpose for the things this project needs to remember and, unlike ' +
      'a cookie, is never attached to a network request.',
  );

  scroll.appendChild(element('h3', undefined, 'Your game files are never uploaded'));
  paragraph(
    scroll,
    'A game you open is read inside your browser and stays on your machine. It is ' +
      'not sent to a server, because there is no server: this page is static files ' +
      'and the interpreter runs entirely on your device.',
  );

  scroll.appendChild(element('h3', undefined, 'What is stored'));
  scroll.appendChild(buildTable());
  paragraph(
    scroll,
    'All of it is essential or functional. There is no analytics, tracking, ' +
      'profiling or advertising storage of any kind, and nothing is shared with ' +
      'anyone.',
  );

  scroll.appendChild(element('h3', undefined, 'Third parties'));
  paragraph(
    scroll,
    'There are none. This page loads no fonts, scripts, styles, images or other ' +
      'resources from another server, so no third party sees your visit at all.',
  );

  scroll.appendChild(element('h3', undefined, 'Clearing it'));
  paragraph(
    scroll,
    'Your browser settings clear local storage for a site at any time, and most ' +
      'browsers let you do that for one site alone. Nothing here is needed for the ' +
      'engine to run — clearing it loses a project saved in the editor and every ' +
      'saved game in every slot, and this notice appears again. Saved games live ' +
      'nowhere else: they are not files, and there is no copy on a server.',
  );

  scroll.appendChild(element('h3', undefined, 'Questions'));
  const contact = element('p');
  contact.append('This is an open source project. Anything unclear or wrong is worth raising at ');
  const link = element('a', undefined, 'the issue tracker');
  link.href = `${REPOSITORY}/issues`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  contact.append(link, ', and the code that does the storing can be read alongside it.');
  scroll.appendChild(contact);

  dialog.append(head, scroll);
  overlay.appendChild(dialog);
  return { overlay, close };
}

/**
 * Shows the notice and wires the policy dialog.
 *
 * `anchor` gets a quiet button that reopens the policy — a policy reachable
 * only from a banner you have already dismissed is not reachable.
 */
export function mountConsent(anchor?: HTMLElement | null): void {
  const reducedMotion = prefersReducedMotion();
  const { overlay, close } = buildDialog();

  const banner = element('div', 'consent-banner');
  banner.id = 'consent-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Storage notice');
  // Not a live region: it is present at load rather than appearing in response
  // to something, and a region announced on arrival would talk over the page.
  banner.hidden = true;

  const mark = element('span', 'consent-mark');
  mark.setAttribute('aria-hidden', 'true');
  mark.appendChild(cookieMark());

  const body = element('div', 'consent-body');
  const text = element('p', 'consent-text');
  text.append(
    'This site sets no cookies. It keeps a few things in your browser’s local ' +
      'storage — your saved games, and what you were building in the editor. ' +
      'Nothing is tracked, and the games you open never leave your machine. ',
  );
  const inline = element('button', 'consent-inline', 'What is stored');
  inline.type = 'button';
  inline.setAttribute('aria-haspopup', 'dialog');
  text.append(inline, '.');

  const actions = element('div', 'consent-actions');
  const accept = element('button', 'consent-accept', 'Got it');
  accept.type = 'button';
  actions.appendChild(accept);

  body.append(text, actions);
  banner.append(mark, body);
  document.body.append(banner, overlay);

  function hideBanner(): void {
    banner.classList.add('is-hiding');
    const done = (): void => {
      banner.hidden = true;
      banner.classList.remove('is-hiding');
      banner.removeEventListener('transitionend', done);
    };
    if (reducedMotion) done();
    else {
      banner.addEventListener('transitionend', done);
      // A transition that never fires — an interrupted animation, a backgrounded
      // tab — would otherwise leave the notice on screen for good.
      setTimeout(done, 600);
    }
  }

  if (!acknowledged()) banner.hidden = false;

  accept.addEventListener('click', () => {
    remember();
    hideBanner();
  });

  // --- the dialog ----------------------------------------------------------

  /**
   * The live focus trap.
   *
   * This dialog grew its own version of one, which worked and only worked here.
   * The shared trap does the same cycling and adds what the local one could
   * not: `inert` on everything behind the dialog, so the page underneath is out
   * of the tab order, out of hit testing and out of the accessibility tree
   * rather than merely being tabbed past.
   */
  let trap: FocusTrap | null = null;

  function open(): void {
    overlay.hidden = false;
    // Forces a reflow so the transition runs from the closed state rather than
    // the dialog simply appearing at its final position.
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
      setTimeout(done, 350);
    }
    // Released rather than merely hidden: the page behind it is `inert` until
    // this runs, and focus goes back to whichever button opened the dialog.
    trap?.release();
    trap = null;
  }

  inline.addEventListener('click', open);
  close.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (event) => {
    // Only the backdrop itself; a click inside the dialog bubbles to here too.
    if (event.target === overlay) closeDialog();
  });

  if (anchor) {
    const reopen = element('button', 'consent-link', 'Cookies');
    reopen.type = 'button';
    // "Cookies" alone is the visible word, and out of the footer's context it
    // says nothing about what pressing it does. 2.4.6 wants the label to
    // describe the purpose; the visible text stays short and the accessible
    // name says the rest, with the visible text as its first words (2.5.3).
    reopen.setAttribute('aria-label', 'Cookies and local storage — what this site stores');
    reopen.setAttribute('aria-haspopup', 'dialog');
    reopen.addEventListener('click', open);
    anchor.appendChild(reopen);
  }
}
