import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseMarkdown, plainText } from '../src/ui/markdown.js';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

/** A file with its comments removed, so the prose can name what the code must not do. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const RELEASED_GAMES = read('docs/released-games.md');
const INDEX = read('index.html');
const MAIN = code(read('src/main.ts'));
const RELEASES = code(read('src/ui/releases.ts'));
const STYLES = code(read('src/ui/styles.css'));
const EDITOR_STYLES = code(read('src/editor/editor.css'));

/**
 * The Releases dialog, and the title bar it is reached from.
 *
 * The dialog itself is a DOM object and this repo's tests run in Node, so what
 * is pinned here is what a rendering test would rest on: that the document it
 * shows is the repository's own and parses into something to render, and that
 * the buttons are wired the way the page claims. Static is weaker than
 * rendering it and much stronger than nothing — and it catches the regression
 * that actually happens, which is a file renamed out from under an import or a
 * button left with no listener.
 */
describe('the Releases dialog shows the repository’s own list', () => {
  it('reads a document whose first heading is its title', () => {
    const first = parseMarkdown(RELEASED_GAMES)[0];
    expect(first?.kind).toBe('heading');
    expect(first?.kind === 'heading' && plainText(first.children)).toBe('Released Games');
  });

  /** The list is the thing being shown, so it has to be a list of games. */
  it('covers every SCUMM Version and both Sierra families', () => {
    const headings = parseMarkdown(RELEASED_GAMES)
      .filter((block) => block.kind === 'heading')
      .map((block) => (block.kind === 'heading' ? plainText(block.children) : ''));

    for (const version of ['v0', 'v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7', 'v8']) {
      expect(headings.some((text) => text.startsWith(`SCUMM ${version} `))).toBe(true);
    }
    expect(headings.some((text) => text.includes('AGI'))).toBe(true);
    expect(headings.some((text) => text.includes('SCI'))).toBe(true);
  });

  /**
   * Compiled in rather than fetched. `docs/` is not a served route — `public/`
   * and `games/` are the only ones a build has — so a dialog that fetched this
   * would be empty in production and full in development.
   */
  it('imports the document as text instead of requesting it', () => {
    expect(RELEASES).toContain("from '../../docs/released-games.md?raw'");
    expect(RELEASES).not.toMatch(/\bfetch\s*\(/);
  });

  /** Built as elements, never as markup: the renderer is the one that checks URLs. */
  it('renders through markdownDom rather than assigning innerHTML', () => {
    expect(RELEASES).toContain('renderMarkdown');
    expect(RELEASES).not.toContain('innerHTML');
  });

  /**
   * A cross in the corner, Escape, and the backdrop — the three ways out.
   *
   * Escape is the shared focus trap's now rather than a listener of this
   * dialog's own: every modal in the project needed the same handling plus the
   * `inert` background the local version never had, so it moved to `a11y.ts`
   * and each dialog says what Escape should do. The behaviour is the same one
   * this test was written for; the assertion follows it to where it lives.
   */
  it('closes by cross, by Escape and by the backdrop', () => {
    expect(RELEASES).toContain('closeIcon()');
    expect(RELEASES).toMatch(/close\.addEventListener\('click', hide\)/);
    expect(RELEASES).toMatch(/trapFocus\(overlay, \{ onEscape: hide \}\)/);
    expect(RELEASES).toContain('event.target === overlay');
  });
});

describe('the title bar', () => {
  /**
   * The Play button is gone and its toggle is the Load button's, because the
   * Load button is the one people were clicking and finding disabled.
   */
  it('offers Releases where the Play button was', () => {
    expect(INDEX).not.toContain('id="play-button"');
    expect(INDEX).toContain('id="releases-button"');
    expect(MAIN).toContain("releasesButton.addEventListener('click', () => releases.show())");
  });

  it('shows and hides the game from the Boot button', () => {
    expect(MAIN).toContain(
      "bootButton.addEventListener('click', () => showGame(!gameIsShowing()))",
    );
    // Not disabled: the stage is simply empty before a game is loaded, and
    // getting the file section back is the same click that hid it.
    const button = INDEX.slice(INDEX.indexOf('id="boot-game"'), INDEX.indexOf('Boot\n'));
    expect(button).toContain('aria-pressed="false"');
    expect(button).not.toContain('disabled');
  });

  it('opens the save menus from Save and Load', () => {
    expect(MAIN).toContain("saveButton.addEventListener('click', () => void openSaveMenu())");
    expect(MAIN).toContain("loadButton.addEventListener('click', () => void openLoadMenu())");
  });
});

/**
 * The two rows that frame the page.
 *
 * Both are pinned, and both are pinned with `sticky` rather than `fixed` so
 * they keep their place in the column and nothing has to be padded out from
 * under them. A game taken fullscreen loses both by itself — the browser
 * renders only the stage's subtree.
 */
describe('the player’s chrome stays on screen', () => {
  it('pins the title bar to the top', () => {
    expect(STYLES).toMatch(/\.topbar\s*\{[^}]*position:\s*sticky/);
    expect(STYLES).toMatch(/\.topbar\s*\{[^}]*top:\s*0/);
  });

  it('pins the credit row to the bottom', () => {
    expect(STYLES).toMatch(/\.creditbar\s*\{[^}]*position:\s*sticky/);
    expect(STYLES).toMatch(/\.creditbar\s*\{[^}]*bottom:\s*0/);
  });

  /**
   * Its own row, last in the document: the status bar above it carries a
   * sentence of unbounded length about the running game, and the credit used
   * to be dropped entirely on a narrow screen to make room for it.
   */
  it('gives the credit and the storage notice a row of their own', () => {
    expect(INDEX).toContain('id="creditbar"');
    expect(INDEX.indexOf('id="creditbar"')).toBeGreaterThan(INDEX.indexOf('class="statusbar"'));
    expect(MAIN).toContain('creditBar.appendChild(createCredit())');
    expect(MAIN).toContain('mountConsent(creditBar)');
    expect(STYLES).not.toMatch(
      /@media\s*\(max-width:\s*720px\)\s*\{\s*\.credit\s*\{\s*display:\s*none/,
    );
  });
});

/**
 * The editor's two bars, which are pinned by construction rather than by
 * `sticky`.
 *
 * Its page is a fixed-height column that never scrolls — the sidebars and the
 * canvas scroll inside it — so the title bar and the credit row are on screen
 * because nothing can push them off. That is a stronger arrangement than
 * `sticky` and an easy one to lose: one `overflow` removed from `body`, or one
 * `flex-shrink` from a bar, and the bottom row goes under the fold on a short
 * window. Pinned here so it cannot be lost quietly.
 *
 * Playing a compiled game covers both, which is the intended exception: the
 * play overlay is `position: fixed` over the whole page.
 */
describe('the editor’s chrome stays on screen', () => {
  it('never scrolls the page itself', () => {
    expect(EDITOR_STYLES).toMatch(/\bbody\s*\{[^}]*height:\s*100vh/);
    expect(EDITOR_STYLES).toMatch(/\bbody\s*\{[^}]*overflow:\s*hidden/);
    expect(EDITOR_STYLES).toMatch(/#editor\s*\{[^}]*min-height:\s*0/);
  });

  it('keeps the title bar and the credit row at their full height', () => {
    expect(EDITOR_STYLES).toMatch(/\.topbar\s*\{[^}]*flex-shrink:\s*0/);
    expect(EDITOR_STYLES).toMatch(/\.creditbar\s*\{[^}]*flex-shrink:\s*0/);
  });

  it('covers them only while a compiled game is playing', () => {
    expect(EDITOR_STYLES).toMatch(/\.play-overlay\s*\{[^}]*position:\s*fixed/);
    expect(EDITOR_STYLES).toMatch(/\.play-overlay\s*\{[^}]*inset:\s*0/);
  });
});
