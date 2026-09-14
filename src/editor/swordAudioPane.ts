/**
 * The Audio panel both Broken Sword surfaces use: a folder bar, then the rows.
 *
 * One widget, two families, on the same terms as `swordPictureView.ts`. ADR
 * 0036 forbids these two sharing a *record* — a Sword 1 effect is an index into
 * a table that lived in Revolution's interpreter and a Sword II effect is a
 * resource id, and neither could be held in the other's shape — and says
 * nothing against sharing a control. This one has never heard of either
 * family's document: it is handed a folder's name, a way to ask for one, and
 * the family-neutral `AudioSection` that draws the rows.
 *
 * ## Why there is a folder bar at all
 *
 * Because the rows are an index and not a copy (ADR 0030, ADR 0034). The
 * demo's speech container alone is 43.9 MB; a retail disc's is 45.5 MB. What
 * the project holds is which recording, by the numbers the game's own scripts
 * say, and the bytes are read out of a folder the author re-supplies for the
 * session. Without the folder every row lists and none of them plays — so the
 * button that fixes that belongs above the rows it lights up, not in another
 * pane an author would have to be told about.
 */

import type { AudioSection } from './audioSection.js';

export interface SwordAudioPaneOptions {
  /** The section that draws the rows; family-neutral, and shared with AGOS. */
  readonly audio: AudioSection;
  /** The open folder's name, or null when none is. */
  readonly folderName: string | null;
  /** Asks for a folder. Resolves to a refusal in words, or null on success. */
  readonly openFolder?: (() => Promise<string | null>) | undefined;
  /** The last refusal, to show beside the button that would try again. */
  readonly problem: string | null;
  /** "Broken Sword" or "Broken Sword II", for the sentences below. */
  readonly gameName: string;
  /** What this release keeps beside it, named so the gesture is unambiguous. */
  readonly whatIsInTheFolder: string;
  /** Re-render, after the gesture has changed the answer. */
  readonly onChanged: () => void;
  /** Records a refusal so the next render can show it. */
  readonly onProblem: (message: string | null) => void;
  /**
   * Something true about this install's recordings that the rows do not say.
   *
   * Drawn under the folder bar and above the rows, where an author reads it
   * before dropping a file rather than after exporting one. Broken Sword II
   * uses it to say which of its three kinds an export has been *measured*
   * carrying and which is only written — a distinction that belongs on the
   * surface and not just in `docs/editor-parity.md`.
   */
  readonly note?: string | null;
}

/**
 * Draws the bar and the rows into `body`.
 *
 * Appends rather than replaces, so a surface can put a heading above it.
 */
export function swordAudioPane(body: HTMLElement, options: SwordAudioPaneOptions): void {
  body.appendChild(folderBar(options));
  if (options.note) {
    const note = document.createElement('p');
    note.className = 'sword-note';
    note.textContent = options.note;
    body.appendChild(note);
  }
  options.audio.render(body);
}

function folderBar(options: SwordAudioPaneOptions): HTMLElement {
  const bar = document.createElement('div');
  bar.className = 'sword-folder-bar';

  const title = document.createElement('h3');
  title.className = 'sword-folder-title';
  title.textContent = 'Game folder';
  bar.appendChild(title);

  const open = options.folderName !== null;

  const where = document.createElement('p');
  where.className = open ? 'sword-folder-name' : 'sword-summary-warning';
  where.textContent = open
    ? options.folderName
    : `None open. ${options.gameName} keeps its recordings beside the game rather than in the ` +
      `project — ${options.whatIsInTheFolder} — so playing or saving one needs the folder ` +
      `this game was imported from (ADR 0034).`;
  bar.appendChild(where);

  if (options.problem) {
    const why = document.createElement('p');
    why.className = 'sword-summary-warning';
    why.textContent = options.problem;
    bar.appendChild(why);
  }

  if (!options.openFolder) {
    const none = document.createElement('p');
    none.className = 'sword-note';
    none.textContent =
      'This surface was mounted without a way to open a folder, so the rows below list what ' +
      'the game holds and cannot play it.';
    bar.appendChild(none);
    return bar;
  }

  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = open ? 'Change folder…' : 'Open game folder…';
  button.title = open
    ? 'Pick a different folder, for one chosen by mistake'
    : 'The recordings live beside the game rather than in the project (ADR 0034)';
  button.addEventListener('click', () => {
    void (async () => {
      // Disabled for the duration: a directory read is not instant, and a
      // second dialogue opened on top of the first is how two folders end up
      // racing to be the accepted one.
      button.disabled = true;
      try {
        const problem = await options.openFolder?.();
        options.onProblem(problem ?? null);
      } finally {
        button.disabled = false;
        options.onChanged();
      }
    })();
  });
  bar.appendChild(button);

  return bar;
}
