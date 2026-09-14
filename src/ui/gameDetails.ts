/**
 * What a game in the `games/` folder is, before you load it.
 *
 * The folder list used to be one button per game: click it and nine megabytes
 * of Fate of Atlantis started loading. That is the right thing to have, and it
 * is the wrong thing to be the *only* thing, because a folder called `indy`
 * with `ATLANTIS.000` in it does not say which release it is, what works in it,
 * or whether the talkie files are the ones beside it.
 *
 * So a game's folder can carry a `README.md`, and clicking the entry shows it:
 * the play button on the right starts the game, and everything else about the
 * row opens this. The dialog carries the same play button at the bottom, so
 * reading first costs nothing — and a cross in the corner, Escape, or a click
 * on the backdrop closes it without loading anything.
 *
 * Rendered from the markdown as elements, never as markup — see `markdownDom.ts`
 * for why that distinction is the one that matters here.
 */
import { trapFocus, type FocusTrap } from './a11y.js';
import { closeIcon } from './icons.js';
import { parseMarkdown, plainText } from './markdown.js';
import { renderMarkdown } from './markdownDom.js';

export interface GameDetailsRequest {
  /** Heading: the README's title, or the folder's name. */
  title: string;
  /** The line under it — what it runs on, how it will be read, how big it is. */
  subtitle: string;
  /**
   * What the README's second line said, on its own.
   *
   * Passed as well as being part of `subtitle` so the body can leave it out:
   * the header already says it, and a document that opens by repeating its own
   * heading and subheading reads as a mistake.
   */
  engine?: string;
  /** Where the README's own relative links and images point. */
  base: string;
  /** The README's text, or null where the folder has none. */
  readme: Promise<string | null>;
  /** Started by the play button, after the dialog has closed. */
  onPlay: () => void;
}

export interface GameDetailsDialog {
  /** Shows the dialog. Replaces one already up rather than stacking. */
  show(request: GameDetailsRequest): void;
  hide(): void;
}

export function createGameDetails(parent: HTMLElement = document.body): GameDetailsDialog {
  const overlay = document.createElement('div');
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
  heading.id = 'game-details-title';
  panel.setAttribute('aria-labelledby', heading.id);
  const subtitle = document.createElement('p');
  subtitle.className = 'details-subtitle';
  // Named and described: the heading says which document this is, the subtitle
  // says what it covers, and a screen reader opening the dialog gets both.
  subtitle.id = `${heading.id}-subtitle`;
  panel.setAttribute('aria-describedby', subtitle.id);
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

  const footer = document.createElement('footer');
  footer.className = 'details-footer';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'details-play';
  play.textContent = 'Play game';

  footer.append(play);
  panel.append(header, body, footer);
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
  /** What the play button starts, for as long as this dialog is the one up. */
  let start: (() => void) | null = null;
  /**
   * Which showing this is.
   *
   * A README is fetched over HTTP while the dialog is already open, so a slow
   * one can arrive after the reader has closed the dialog or opened another
   * game's — and writing it into the body then would show one game's
   * description under another game's name.
   */
  let generation = 0;

  function hide(): void {
    if (overlay.hidden) return;
    overlay.hidden = true;
    generation++;
    start = null;
    // Returned rather than dropped: the row that opened this is where the
    // reader was, and a keyboard user sent back to the top of the document has
    // to walk the whole page again to try the next game.
    trap?.release();
    trap = null;
  }

  close.addEventListener('click', hide);
  play.addEventListener('click', () => {
    const begin = start;
    // Closed first: loading takes over the page, and a dialog left up over it
    // would be covering the progress it caused.
    hide();
    begin?.();
  });

  overlay.addEventListener('click', (event) => {
    // Only the backdrop. A click that began inside the panel — selecting a
    // filename out of the description, which is a likely thing to do with it —
    // must not take the description away.
    if (event.target === overlay) hide();
  });

  return {
    show(request) {
      const mine = ++generation;
      heading.textContent = request.title;
      subtitle.textContent = request.subtitle;
      start = request.onPlay;

      const note = document.createElement('p');
      note.className = 'details-note';
      note.textContent = 'Reading README.md…';
      body.replaceChildren(note);
      body.scrollTop = 0;

      void request.readme.then(
        (text) => {
          if (mine !== generation) return;
          body.replaceChildren(renderReadme(text, request));
        },
        () => {
          if (mine !== generation) return;
          body.replaceChildren(missing('That README.md could not be read.'));
        },
      );

      overlay.hidden = false;
      // After it is shown, so the trap can measure what is focusable inside it.
      trap = trapFocus(overlay, { onEscape: hide });
      // The cross rather than the play button: this dialog opened because
      // someone wanted to read, and Enter on a focused Play would load a game
      // they had not decided on yet.
      close.focus();
    },
    hide,
  };
}

/** The body of the dialog: the README, or a line saying there is not one. */
function renderReadme(text: string | null, request: GameDetailsRequest): Node {
  if (text === null || text.trim() === '') {
    return missing(
      'No README.md in this game’s folder. Add one and it is shown here — its first heading becomes the name in the list.',
    );
  }

  let blocks = parseMarkdown(text);

  // The dialog's own heading is already this title, and its subtitle is
  // already the line under it. Showing either again reads as a mistake rather
  // than as a document.
  if (blocks[0]?.kind === 'heading' && sameText(plainText(blocks[0].children), request.title)) {
    blocks = blocks.slice(1);
  }
  if (
    request.engine !== undefined &&
    blocks[0]?.kind === 'paragraph' &&
    sameText(plainText(blocks[0].children), request.engine)
  ) {
    blocks = blocks.slice(1);
  }

  return renderMarkdown(blocks, { base: request.base });
}

function missing(message: string): HTMLElement {
  const note = document.createElement('p');
  note.className = 'details-note';
  note.textContent = message;
  return note;
}

function sameText(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}
