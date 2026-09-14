import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

/** A file with its comments removed, so the prose can name what the code must not do. */
function code(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

const MAIN = code(read('src/main.ts'));

/**
 * The shell's half of saving and loading.
 *
 * The menus themselves are tested in `save-menu.test.ts` and the store in
 * `save-store.test.ts`; what is left is the wiring between them, which lives in
 * `main.ts` — a module that starts a game loop on import and cannot be brought
 * up in a test runner. So the wiring is pinned the way this repository already
 * pins the rest of that file: by reading it. Static is weaker than rendered,
 * and it is the difference between these promises being checked and not.
 */
describe('saving from the shell', () => {
  /**
   * A save menu over a running game is a game still walking, still cutting
   * scenes and still moving the player somewhere else while they read the list
   * — so the moment they meant to save is not the moment that gets written.
   */
  it('pauses while the menu is up', () => {
    expect(MAIN).toMatch(/async function openSaveMenu\(\)[\s\S]*?const wasPaused = paused;/);
    expect(MAIN).toMatch(/async function openSaveMenu\(\)[\s\S]*?setPaused\(true\)/);
  });

  /**
   * Put back as it was found rather than simply resumed: unpausing a player who
   * paused deliberately first is the dialog undoing a decision it was never
   * asked about. In a `finally`, so a thrown save does not strand the game.
   */
  it('puts the previous pause state back, whatever happened', () => {
    expect(MAIN).toMatch(/} finally \{\s*setPaused\(wasPaused\);\s*\}/);
  });

  /** The one thing a player cannot discover for themselves — the game looks fine. */
  it('says so in a dialog when the save could not be written', () => {
    expect(MAIN).toContain("notice.show('The game could not be saved'");
  });

  /**
   * A `gameId` is `monkey2`, and the Load menu has to name games with no engine
   * in hand to ask. The title is recorded when the shell does know it.
   */
  it('records what the game is called, beside the save', () => {
    expect(MAIN).toMatch(/saves\.write\(chosen\.slot, engine\.saveState\(chosen\.name\)\)/);
    expect(MAIN).toMatch(/saves\.writeMeta\(\{\s*title: currentGameTitle\(\)/);
  });
});

describe('loading from the shell', () => {
  /**
   * Reaching a game saved in an earlier visit is the whole point of the menu,
   * so requiring a loaded game before you may look at your saves is a deadlock
   * — the same one the single Load button already had.
   */
  it('is reachable with no game running', () => {
    expect(read('index.html')).toMatch(/id="load-game"[\s\S]{0,200}?>\s*Load/);
    expect(MAIN).not.toMatch(/loadButton\.disabled/);
  });

  /**
   * Game data is not kept between visits — far too big, and this project never
   * copies it anywhere — so a save whose game is not running and not in the
   * games folder is held until those files arrive.
   */
  it('holds a save for a game whose files are not here yet', () => {
    expect(MAIN).toMatch(/pendingRestore = \{ gameId, slot, title \}/);
    expect(MAIN).toMatch(
      /if \(pendingRestore && saves && pendingRestore\.gameId === engine\.gameId\)/,
    );
  });

  /** A restored game sitting frozen looks like the restore failed. */
  it('resumes the game once a save is applied', () => {
    expect(MAIN).toMatch(/function applyRestore[\s\S]*?setPaused\(false\)/);
  });

  /**
   * A save from a newer build reads as an empty slot and a refused save leaves
   * the game exactly as it was. Both look, from the outside, like a click that
   * did nothing.
   */
  it('explains every refusal in words', () => {
    expect(MAIN).toContain('could not be read');
    expect(MAIN).toContain('was refused');
  });
});
