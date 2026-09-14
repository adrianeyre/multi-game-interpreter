import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { keyCodeFor } from '../src/engine/agi/AgiInput.js';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

const SOURCE = read('src/engine/agi/AgiInput.ts');

/**
 * The same file with its comments removed.
 *
 * The prose has to be able to say "deliberately not `display: none`" without a
 * test that forbids `display: none` failing on the sentence explaining why it
 * is forbidden.
 */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/**
 * The Parser input line's accessibility, as far as a test can go.
 *
 * #130 asks for typing checked by hand with a real screen reader and a real
 * phone, and that check is not one a test can make — nobody has run this
 * against a screen reader yet and the issue stays open until someone has.
 *
 * What a test *can* do is guard the properties that check would depend on, so
 * they cannot be removed by someone tidying the CSS. These are static
 * assertions on the source because the repo has no DOM in its test environment
 * and adding one for a single file would cost every install a dependency.
 * Static is weaker than rendering it; it is much stronger than nothing, and it
 * catches the regression that actually happens.
 */
describe('the Parser input line stays reachable by assistive technology', () => {
  /**
   * The whole arrangement rests on this. `display: none` and
   * `visibility: hidden` remove an element from the accessibility tree *and*
   * from the mobile keyboard's reach — which is exactly what this field exists
   * to keep. The clip-rect technique hides it visually and keeps both.
   */
  it('hides the field visually without removing it from the accessibility tree', () => {
    expect(CODE).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(CODE).toMatch(/clip:\s*rect\(0 0 0 0\)/);
    expect(CODE).not.toMatch(/display\s*:\s*none/);
    expect(CODE).not.toMatch(/visibility\s*:\s*hidden/);
    // A zero-size element is also dropped by some screen readers, hence 1px.
    expect(CODE).toMatch(/width:\s*1px/);
    expect(CODE).toMatch(/height:\s*1px/);
  });

  /**
   * A screen reader user has no picture to read: the drawn input line is
   * pixels. The accessible name is the only thing that says what the field is
   * for.
   */
  it('gives the field an accessible name that says what to do with it', () => {
    expect(CODE).toMatch(/aria-label/);
    expect(CODE).toMatch(/Type what you want to do/);
  });

  it('asks a phone for a keyboard that submits rather than one that returns', () => {
    expect(CODE).toMatch(/enterkeyhint/);
  });

  /**
   * A real `<input type="text">` rather than a `contenteditable` or a
   * keydown trap, because that is what an IME, autocomplete and a phone's
   * keyboard all expect to be talking to.
   */
  it('is a real text input, not a keydown trap', () => {
    expect(CODE).toMatch(/createElement\('input'\)/);
    expect(CODE).toMatch(/field\.type = 'text'/);
  });

  /**
   * One source of truth. A second copy of the text would drift the first time
   * an IME composed a character or the player pasted — and the drawn line is
   * rendered *from* the field's value, so there is nowhere for it to drift to.
   */
  it('keeps the text and the caret only in the field', () => {
    expect(CODE).toMatch(/this\.field\?\.value/);
    expect(CODE).toMatch(/selectionStart/);
    // No shadow copy of the typed text anywhere in the class.
    expect(CODE).not.toMatch(/private\s+(typed|buffer|line)\b/);
  });

  it('is focused when the player clicks the game, so typing just works', () => {
    expect(CODE).toMatch(/pointerdown/);
    expect(CODE).toMatch(/field\.focus\(\)/);
  });
});

describe('keys reach the game as AGI numbered them', () => {
  /**
   * ASCII in the low byte, a scan code in the high one. A game binds with
   * whichever half suits, so both have to be reported or half its controls are
   * dead.
   */
  it('reports a printable key by its character code', () => {
    expect(keyCodeFor({ key: 'a' } as KeyboardEvent)).toBe(97);
    expect(keyCodeFor({ key: ' ' } as KeyboardEvent)).toBe(32);
  });

  it('reports the editing keys by their ASCII values', () => {
    expect(keyCodeFor({ key: 'Enter' } as KeyboardEvent)).toBe(13);
    expect(keyCodeFor({ key: 'Escape' } as KeyboardEvent)).toBe(27);
    expect(keyCodeFor({ key: 'Backspace' } as KeyboardEvent)).toBe(8);
    expect(keyCodeFor({ key: 'Tab' } as KeyboardEvent)).toBe(9);
  });

  /**
   * Function keys have no ASCII value at all — they are a scan code in the
   * high byte, which is how `set.key(0, 68, c40)` binds F10.
   */
  it('reports a function key as a scan code in the high byte', () => {
    expect(keyCodeFor({ key: 'F1' } as KeyboardEvent)).toBe(0x3b00);
    expect(keyCodeFor({ key: 'F10' } as KeyboardEvent)).toBe(0x4400);
    expect(keyCodeFor({ key: 'F10' } as KeyboardEvent) & 0xff).toBe(0);
  });

  it('reports nothing for a key AGI has no number for', () => {
    expect(keyCodeFor({ key: 'ScrollLock' } as KeyboardEvent)).toBe(0);
  });
});
