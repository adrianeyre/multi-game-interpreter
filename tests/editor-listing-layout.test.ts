import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The instruction listing's column, which collapsed to one character wide.
 *
 * Opening a room in the editor draws its scripts as a listing: an offset, the
 * instruction, and a note beside it where one applies. Room 69 of Loom CD drew
 * `resourceRoutines 41` — and every other instruction in the room — one letter
 * per line, straight down the inspector.
 *
 * Nothing about it is visible to a test that renders markup, because jsdom does
 * no layout: the fault is entirely in how two CSS declarations size a grid
 * track between them, and it appears only at a width. So the stylesheet is read
 * as text, the way `accessibility-contrast.test.ts` reads it for its ratios.
 */
function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

const EDITOR_CSS = read('src/editor/editor.css');

/** One rule's declarations, by selector, with comments stripped. */
function rule(css: string, selector: string): string {
  const body = new RegExp(`(^|\\})\\s*${selector.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'm').exec(
    css,
  );
  expect(body, `no rule for ${selector}`).not.toBeNull();
  return body![2].replace(/\/\*[\s\S]*?\*\//g, '');
}

describe("the editor's instruction listing", () => {
  it('lets its text column be narrower than the longest instruction', () => {
    // A bare `1fr` is `minmax(auto, 1fr)`, and that `auto` floor is the
    // column's min-content width. Paired with a wrap mode that breaks anywhere,
    // min-content is one character — and the track takes that as licence to be
    // one character wide.
    const row = rule(EDITOR_CSS, '.instruction-row');

    expect(row).toContain('minmax(0, 1fr)');
  });

  it('wraps an instruction at its spaces rather than at any character', () => {
    // `break-word` and `anywhere` wrap identically once a width is settled and
    // size the box differently: only `anywhere` counts as a break opportunity
    // when min-content is worked out. That difference is the whole bug.
    const text = rule(EDITOR_CSS, '.instruction-text');

    expect(text).toContain('overflow-wrap: break-word');
    expect(text).not.toContain('anywhere');
  });
});
