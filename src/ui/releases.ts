/**
 * Which games exist, as a document rather than a claim in a paragraph.
 *
 * `docs/released-games.md` is the list this project is measured against: every
 * SCUMM and Sierra release by Version, what is supported, and what is refused
 * by name. It was written for the repository, and a reader who has just been
 * told the interpreter ships no game data is exactly the reader who wants it —
 * so the title bar opens it here instead of sending them to GitHub.
 *
 * **Compiled in, not fetched.** The file lives in `docs/`, which is not served:
 * `public/` and `games/` are the only routes a build has. Imported as text it
 * is part of the bundle, so the dialog opens with the document already in hand
 * and a static build shows the same list as `npm start` — no request to fail,
 * and no second copy of the list to keep in step with the first.
 *
 * Rendered from the markdown as elements, never as markup — `markdownDom.ts`
 * says why that distinction is the one that matters. The dialog itself is the
 * game details one's shape and stylesheet, minus the footer: there is nothing
 * to start from here, only something to read.
 */
import releasedGames from '../../docs/released-games.md?raw';

import { trapFocus, type FocusTrap } from './a11y.js';
import { closeIcon } from './icons.js';
import { parseMarkdown, plainText, type MarkdownBlock } from './markdown.js';
import { renderMarkdown } from './markdownDom.js';

/**
 * What the document's own relative links resolve against.
 *
 * The list links a sibling file — `../.out-of-scope/agi-booter-and-apple-ii.md`
 * — and those paths are the repository's, not the site's. Resolved against the
 * page they would be 404s under whatever directory the app is served from, so
 * they are resolved against the file's own home on GitHub and go where the text
 * says they go.
 */
const DOCS_BASE = 'https://github.com/adrianeyre/multi-game-interpreter/blob/main/docs/';

export interface ReleasesDialog {
  /** Shows the dialog, with the list already rendered. */
  show(): void;
  hide(): void;
}

export function createReleases(parent: HTMLElement = document.body): ReleasesDialog {
  const overlay = document.createElement('div');
  // The game details dialog's classes, deliberately: same backdrop, same panel,
  // same cross, because it is the same kind of thing — a document over the page.
  overlay.className = 'details-overlay';
  overlay.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'details-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');

  const header = document.createElement('header');
  header.className = 'details-header';

  const headings = document.createElement('div');
  const heading = document.createElement('h2');
  heading.className = 'details-title';
  heading.id = 'releases-title';
  panel.setAttribute('aria-labelledby', heading.id);
  heading.textContent = title();
  const subtitle = document.createElement('p');
  subtitle.className = 'details-subtitle';
  // Named and described: the heading says which document this is, the subtitle
  // says what it covers, and a screen reader opening the dialog gets both.
  subtitle.id = `${heading.id}-subtitle`;
  panel.setAttribute('aria-describedby', subtitle.id);
  subtitle.textContent =
    'Every SCUMM and Sierra release by Version, and which of them this interpreter runs.';
  headings.append(heading, subtitle);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'details-close';
  // A cross has no text of its own, and the button is the only way out for
  // someone who cannot see where the backdrop is.
  close.setAttribute('aria-label', 'Close');
  close.title = 'Close';
  close.appendChild(closeIcon());

  header.append(headings, close);

  const body = document.createElement('div');
  body.className = 'details-body markdown';
  panel.append(header, body);
  overlay.append(panel);
  parent.appendChild(overlay);

  /**
   * The live focus trap.
   *
   * `aria-modal` said this was modal; the tab order said otherwise, and two
   * presses of Tab walked out of the dialog onto the title bar behind it. The
   * trap makes the claim true — Tab cycles inside the panel, the rest of the
   * page is `inert`, and releasing it hands focus back to whatever opened this.
   */
  let trap: FocusTrap | null = null;
  /**
   * Whether the list has been built yet.
   *
   * On first open rather than at startup: two hundred lines of list are a few
   * hundred elements, and a reader who never opens this pays nothing for it.
   * The document is a constant, so once built it stays — a second open is the
   * same elements rather than the same work again.
   */
  let filled = false;

  function hide(): void {
    if (overlay.hidden) return;
    overlay.hidden = true;
    // Returned rather than dropped: the reader was at the title bar, and a
    // keyboard user sent back to the top of the document has to walk the whole
    // page again to reach the next button.
    trap?.release();
    trap = null;
  }

  close.addEventListener('click', hide);

  overlay.addEventListener('click', (event) => {
    // Only the backdrop. A click that began inside the panel — selecting a game
    // title out of the list, which is a likely thing to do with it — must not
    // take the list away.
    if (event.target === overlay) hide();
  });

  return {
    show() {
      if (!filled) {
        body.replaceChildren(
          renderMarkdown(bodyBlocks(), {
            base: DOCS_BASE,
            // The dialog's heading is the document's `#`, so its `##` sections
            // are the top level of what is left.
            headingOffset: 2,
          }),
        );
        filled = true;
      }
      body.scrollTop = 0;

      overlay.hidden = false;
      // After it is shown, so the trap can measure what is focusable inside it.
      trap = trapFocus(overlay, { onEscape: hide });
      // The cross: this dialog has one action, and it is the way out.
      close.focus();
    },
    hide,
  };
}

/** The document's own first heading, so the dialog is titled by the file. */
function title(): string {
  const first = parseMarkdown(releasedGames)[0];
  return first?.kind === 'heading' ? plainText(first.children) : 'Released games';
}

/**
 * The list without its title.
 *
 * The header above already carries it, and a document that opens by repeating
 * its own heading reads as a mistake rather than as a document.
 */
function bodyBlocks(): MarkdownBlock[] {
  const blocks = parseMarkdown(releasedGames);
  return blocks[0]?.kind === 'heading' ? blocks.slice(1) : blocks;
}
