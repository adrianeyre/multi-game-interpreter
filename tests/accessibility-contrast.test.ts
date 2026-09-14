import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { describe, expect, it } from 'vitest';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

const A11Y_CSS = read('src/ui/a11y.css');
const PLAYER_CSS = read('src/ui/styles.css');
const EDITOR_CSS = read('src/editor/editor.css');

/** One channel of sRGB, linearised, as WCAG defines it. */
function channel(value: number): number {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const digits = hex.replace('#', '');
  const [red, green, blue] = [0, 2, 4].map((at) => parseInt(digits.slice(at, at + 2), 16));
  return 0.2126 * channel(red) + 0.7152 * channel(green) + 0.0722 * channel(blue);
}

/** The ratio WCAG 1.4.3 and 1.4.11 are both stated in. */
function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/**
 * The value of a custom property, read out of the stylesheet that declares it.
 *
 * Read rather than repeated, so a token changed in the CSS and not here fails
 * this test instead of quietly dropping the contrast it was chosen for.
 */
function token(css: string, name: string): string {
  const match = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!match) throw new Error(`No --${name} in the stylesheet`);
  return match[1];
}

const BG = token(PLAYER_CSS, 'bg');
const PANEL = token(PLAYER_CSS, 'panel');
const PANEL_2 = token(EDITOR_CSS, 'panel-2');
const TEXT = token(PLAYER_CSS, 'text');
const MUTED = token(PLAYER_CSS, 'muted');
const ACCENT = token(PLAYER_CSS, 'accent');
const CONTROL_EDGE = token(A11Y_CSS, 'control-edge');
const FOCUS_RING = token(A11Y_CSS, 'focus-ring');
const FOCUS_HALO = token(A11Y_CSS, 'focus-halo');

/** Every surface a control or a line of text is drawn on in this project. */
const SURFACES: Array<[string, string]> = [
  ['the page background', BG],
  ['a panel', PANEL],
  ['the editor panel', PANEL_2],
  ['a button', '#22222b'],
  ['a folder card', '#1c1c24'],
];

describe('1.4.3, Contrast (Minimum)', () => {
  it.each(SURFACES)('reads body text against %s', (_where, surface) => {
    expect(contrast(TEXT, surface)).toBeGreaterThanOrEqual(4.5);
  });

  /**
   * The muted colour is ordinary body text, not decoration: it carries the drop
   * zone's instructions, the audio metadata and the status line's detail. 4.5
   * applies to all of it.
   */
  it.each(SURFACES)('reads muted text against %s', (_where, surface) => {
    expect(contrast(MUTED, surface)).toBeGreaterThanOrEqual(4.5);
  });

  it.each(SURFACES)('reads the accent against %s', (_where, surface) => {
    expect(contrast(ACCENT, surface)).toBeGreaterThanOrEqual(4.5);
  });

  /** The reverse case: dark text on an accent-filled button. */
  it('reads the label on an accent-filled button', () => {
    expect(contrast('#1a1a20', ACCENT)).toBeGreaterThanOrEqual(4.5);
    expect(contrast('#1a1206', ACCENT)).toBeGreaterThanOrEqual(4.5);
  });
});

describe('1.4.11, Non-text Contrast', () => {
  /**
   * The boundary of anything you can press or type into.
   *
   * `--border` is 1.3:1 against these surfaces — right for a rule between two
   * blocks of text, and not enough to say "this is a button". That is why there
   * are two tokens rather than one.
   */
  it.each(SURFACES)('shows a control boundary against %s', (_where, surface) => {
    expect(contrast(CONTROL_EDGE, surface)).toBeGreaterThanOrEqual(3);
  });

  /**
   * The focus ring is two bands for exactly this reason: no single colour
   * reaches 3:1 against both a dark panel and an accent-filled button. Whatever
   * the ring is drawn over, one of its two bands contrasts with it — and the
   * bands contrast with each other, so the ring is visible as a ring.
   */
  it.each([...SURFACES, ['an accent-filled button', ACCENT] as [string, string]])(
    'shows the focus ring against %s',
    (_where, surface) => {
      const best = Math.max(contrast(FOCUS_RING, surface), contrast(FOCUS_HALO, surface));
      expect(best).toBeGreaterThanOrEqual(3);
    },
  );

  it('draws the two bands of the focus ring against each other', () => {
    expect(contrast(FOCUS_RING, FOCUS_HALO)).toBeGreaterThanOrEqual(3);
  });
});

describe('the stylesheets carry the rules the criteria need', () => {
  /** 2.4.7: the ring is the whole point, and removing it is the usual failure. */
  it('defines a visible focus indicator', () => {
    expect(A11Y_CSS).toMatch(/:focus-visible\s*\{[^}]*outline:\s*3px solid/);
    expect(A11Y_CSS).toMatch(/:focus-visible\s*\{[^}]*box-shadow:/);
  });

  /**
   * And never takes it away again.
   *
   * `outline: none` under a `:focus-visible` selector is the regression this
   * whole change was fixing; the one permitted use is `.main:focus`, which is
   * the skip link's landing spot and is only ever focused by script — where
   * `:focus-visible` does not match and a permanent box around the page would
   * be noise.
   */
  it.each([
    ['a11y.css', A11Y_CSS],
    ['styles.css', PLAYER_CSS],
    ['editor.css', EDITOR_CSS],
  ])('never suppresses the ring in %s', (_name, css) => {
    // Comments first: the prose above a rule is allowed to say "outline" and to
    // contain the very selector the rule is about.
    const rules = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const suppressed = [...rules.matchAll(/([^{}]*):focus(?:-visible)?[^{}]*\{([^}]*)\}/g)]
      .filter(([, , body]) => /outline:\s*(none|0)\b/.test(body))
      .map(([, selector]) => selector.trim().split(/\s+/).pop() ?? '');

    expect(suppressed.filter((selector) => selector !== '.main')).toEqual([]);
  });

  /**
   * 2.4.11, Focus Not Obscured. Both pages pin a bar to the top and another to
   * the bottom, and a browser scrolling a newly focused control to the very
   * edge parks it under one of them.
   */
  it('keeps a focused control clear of the sticky bars', () => {
    expect(A11Y_CSS).toMatch(/scroll-margin-block:/);
  });

  /** 2.5.8: 24 by 24, declared once so the exceptions can point at it. */
  it('states the minimum target size once', () => {
    expect(A11Y_CSS).toMatch(/--target-min:\s*24px/);
    expect(A11Y_CSS).toMatch(/min-height:\s*var\(--target-min\)/);
  });

  /** 2.2.2 and 2.3.3: nothing here needs to move, so nothing has to. */
  it('honours a request for reduced motion', () => {
    expect(A11Y_CSS).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    expect(A11Y_CSS).toMatch(/animation-duration:\s*0\.01ms\s*!important/);
  });

  /** A forced palette flattens every colour this interface signals with. */
  it('redraws focus and selection under forced colours', () => {
    expect(A11Y_CSS).toMatch(/@media \(forced-colors: active\)/);
    expect(A11Y_CSS).toContain('Highlight');
  });

  /**
   * 1.4.10, Reflow. The editor was three columns with two fixed side panels
   * inside a `100vh` body with `overflow: hidden`: what did not fit was not
   * awkward, it was unreachable.
   */
  it('reflows the editor to one column on a narrow screen', () => {
    expect(EDITOR_CSS).toMatch(/@media \(max-width: 60rem\)/);
    expect(EDITOR_CSS).toMatch(/grid-template-columns:\s*1fr/);
    expect(EDITOR_CSS).toMatch(/overflow:\s*auto/);
  });

  it('reflows the player on a narrow screen', () => {
    expect(PLAYER_CSS).toMatch(/@media \(max-width: 30rem\)/);
  });

  /**
   * The clip-rect technique, not `display: none`: hiding a live region or a
   * canvas description that way removes it from the accessibility tree too,
   * which is the whole thing it exists to be in.
   */
  it('hides text visually without removing it from the accessibility tree', () => {
    expect(A11Y_CSS).toMatch(/\.visually-hidden\s*\{/);
    expect(A11Y_CSS).toMatch(/clip-path:\s*inset\(50%\)/);
    expect(A11Y_CSS).toMatch(/width:\s*1px/);
    const block = /\.visually-hidden\s*\{([^}]*)\}/.exec(A11Y_CSS)![1];
    expect(block).not.toMatch(/display:\s*none/);
    expect(block).not.toMatch(/visibility:\s*hidden/);
  });

  /**
   * 2.1.1. `visibility: hidden` takes an element out of the tab order, so a
   * control revealed only on hover could not be reached by keyboard at all —
   * there was no hover to produce.
   */
  it('reveals the hover-only audio controls on focus as well', () => {
    expect(EDITOR_CSS).toMatch(/\.audio-item:focus-within \.audio-remove/);
    expect(EDITOR_CSS).not.toMatch(/\.audio-remove\s*\{[^}]*visibility:\s*hidden/);
  });
});
