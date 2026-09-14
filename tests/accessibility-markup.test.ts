import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

import { JSDOM } from 'jsdom';
import { describe, expect, it } from 'vitest';

function parse(relative: string): Document {
  const html = readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
  return new JSDOM(html).window.document;
}

const PLAYER = parse('index.html');
const EDITOR = parse('editor.html');

/**
 * The two pages' own markup, read as a browser reads it.
 *
 * The repository's earlier accessibility tests were static assertions on source
 * text, because there was no DOM in the test environment and adding one for a
 * single file was not worth the dependency. A conformance pass across every
 * surface changes that arithmetic: these are the real documents, parsed, and
 * what is asserted is what an assistive technology would actually find.
 */
describe.each([
  ['the player', PLAYER, '#main-content'],
  ['the editor', EDITOR, '#editor-canvas-area'],
])('%s page', (_name, document, skipTarget) => {
  /** 3.1.1: without it a screen reader guesses, and usually guesses wrong. */
  it('declares its language', () => {
    expect(document.documentElement.getAttribute('lang')).toBe('en');
  });

  /** 2.4.2: the tab title is how a page is told apart from twenty others. */
  it('has a title that says what the page is', () => {
    expect(document.title.length).toBeGreaterThan(10);
    expect(document.title).toContain('MGI');
  });

  /**
   * 2.4.1, Bypass Blocks. Both pages open with a toolbar of a dozen controls,
   * and the link has to be first in the tab order or it is not a skip link.
   */
  it('opens with a skip link that points at something real', () => {
    const link = document.querySelector<HTMLAnchorElement>('a.skip-link');
    expect(link).not.toBeNull();
    expect(link!.getAttribute('href')).toBe(skipTarget);
    expect(link!.textContent?.trim().length).toBeGreaterThan(0);

    // First focusable thing in the document, or it is skipping nothing.
    const first = document.querySelector('a[href], button, input, select, textarea');
    expect(first).toBe(link);
  });

  /** 1.3.1: one top-level heading, so the outline has a root. */
  it('has exactly one h1', () => {
    expect(document.querySelectorAll('h1')).toHaveLength(1);
    expect(document.querySelector('h1')!.textContent?.trim().length).toBeGreaterThan(0);
  });

  /**
   * A focusable element hidden from assistive technology is a stop a screen
   * reader user lands on and cannot be told anything about.
   */
  it('never hides a focusable element from assistive technology', () => {
    const offenders = [...document.querySelectorAll('[aria-hidden="true"]')].flatMap((node) =>
      [...node.querySelectorAll('a[href], button, input, select, textarea')]
        .concat(node.matches('a[href], button, input, select, textarea') ? [node] : [])
        .filter((control) => control.getAttribute('tabindex') !== '-1'),
    );
    expect(offenders.map((node) => node.outerHTML)).toEqual([]);
  });

  /** 4.1.2: a control with no text and no label has no name at all. */
  it('names every button', () => {
    for (const button of document.querySelectorAll('button')) {
      const named =
        (button.textContent ?? '').trim().length > 0 ||
        button.hasAttribute('aria-label') ||
        button.hasAttribute('aria-labelledby');
      expect(named, button.outerHTML).toBe(true);
    }
  });
});

describe('the player page', () => {
  /**
   * 1.3.1. It used to be one `<main>` wrapping a header and two footers, which
   * names the banner and the credit row as page content and leaves "skip to the
   * main content" with nowhere to land.
   */
  it('has one banner, one main and one contentinfo', () => {
    expect(PLAYER.querySelectorAll('body > div#app > header')).toHaveLength(1);
    expect(PLAYER.querySelectorAll('main')).toHaveLength(1);
    expect(PLAYER.querySelectorAll('body > div#app > footer')).toHaveLength(1);
  });

  /** The skip link's target has to be able to take focus, or nothing moves. */
  it('gives the main region a tabindex so the skip link can land on it', () => {
    expect(PLAYER.querySelector('#main-content')!.getAttribute('tabindex')).toBe('-1');
  });

  /**
   * 3.3.2 and 4.1.2. The scale box carried only a `title`, which several screen
   * readers ignore when anything else is available and no touch user ever sees.
   */
  it('labels every form control with something other than a title attribute', () => {
    for (const control of PLAYER.querySelectorAll<HTMLElement>('select, input:not([type=file])')) {
      const labelled =
        control.hasAttribute('aria-label') ||
        control.hasAttribute('aria-labelledby') ||
        PLAYER.querySelector(`label[for="${control.id}"]`) !== null ||
        control.closest('label') !== null;
      expect(labelled, control.outerHTML).toBe(true);
    }
  });

  /**
   * 1.1.1 as far as it can go here. The picture is a third-party game redrawn
   * sixty times a second and cannot be described; the canvas can still be
   * named, be operable, and carry a description of how to work it.
   */
  it('names the game screen and says how to operate it', () => {
    const canvas = PLAYER.querySelector<HTMLElement>('#screen')!;
    expect(canvas.getAttribute('aria-label')).toBeTruthy();
    expect(canvas.getAttribute('tabindex')).toBe('0');

    const describedBy = canvas.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    const help = PLAYER.getElementById(describedBy!);
    expect(help?.textContent?.length ?? 0).toBeGreaterThan(40);

    // Fallback content, for a browser with no canvas at all.
    expect(canvas.textContent?.trim().length ?? 0).toBeGreaterThan(0);
  });

  /** 4.1.3: the loading bar has to say what it is as well as how far along. */
  it('describes the load bar as a progress bar with a name and a range', () => {
    const bar = PLAYER.querySelector<HTMLElement>('#progress')!;
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-label')).toBeTruthy();
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('100');
  });

  /** 2.1.1: a region that scrolls and has no tab stop cannot be scrolled. */
  it('makes the engine log reachable by keyboard', () => {
    const log = PLAYER.querySelector<HTMLElement>('#log')!;
    expect(log.getAttribute('tabindex')).toBe('0');
    expect(log.getAttribute('aria-label')).toBeTruthy();
  });

  /**
   * 2.5.7. Dropping files is a drag, so the same job has to be reachable
   * without one — and the alternative has to be findable, not merely present.
   */
  it('says in the drop zone that dragging is never required', () => {
    const text = PLAYER.querySelector('#dropzone')!.textContent ?? '';
    expect(text).toMatch(/Dragging is never required/i);
    expect(PLAYER.querySelector('#pick-folder')).not.toBeNull();
    expect(PLAYER.querySelector('#pick-files')).not.toBeNull();
  });

  /** A toggle's state belongs in the page, not only in a background colour. */
  it('exposes the toggle buttons as toggles', () => {
    expect(PLAYER.querySelector('#boot-game')!.getAttribute('aria-pressed')).toBe('false');
    expect(PLAYER.querySelector('#fullscreen-button')!.getAttribute('aria-pressed')).toBe('false');
  });

  /** A button that opens a modal should say so before it is pressed. */
  it('marks the buttons that open dialogs', () => {
    expect(PLAYER.querySelector('#releases-button')!.getAttribute('aria-haspopup')).toBe('dialog');
    expect(PLAYER.querySelector('#save-game')!.getAttribute('aria-haspopup')).toBe('dialog');
    expect(PLAYER.querySelector('#load-game')!.getAttribute('aria-haspopup')).toBe('dialog');
  });

  /**
   * Load reads saves back and Boot shows the game. They were one button called
   * Load doing the second job under the first job's name, and a toggle is not
   * a menu: `aria-pressed` on the one that opens a dialog would promise a state
   * it does not have.
   */
  it('separates reading saves back from showing the game', () => {
    const load = PLAYER.querySelector('#load-game')!;
    const boot = PLAYER.querySelector('#boot-game')!;

    expect(load.textContent?.trim()).toBe('Load');
    expect(boot.textContent?.trim()).toBe('Boot');
    expect(load.hasAttribute('aria-pressed')).toBe(false);
    expect(boot.hasAttribute('aria-haspopup')).toBe(false);
    // Neither is disabled: a save from an earlier visit is exactly what the
    // Load menu is for, and requiring a loaded game to reach it is a deadlock.
    expect(load.hasAttribute('disabled')).toBe(false);
    expect(boot.hasAttribute('disabled')).toBe(false);
  });
});

describe('the editor page', () => {
  /**
   * The editor builds its chrome in script, so the document had no heading at
   * all and a screen reader's outline began at a sidebar's `<h3>`.
   */
  it('carries a heading even though its interface is built in script', () => {
    const heading = EDITOR.querySelector('h1')!;
    expect(heading.textContent).toContain('editor');
    // Off the screen, on the page: the interface has no room for a title bar
    // heading, and a screen reader still needs one.
    expect(heading.className).toContain('visually-hidden');
  });

  /** The boot spinner is a status: it appears without taking focus. */
  it('announces the boot overlay rather than leaving it silent', () => {
    const busy = EDITOR.querySelector<HTMLElement>('#boot-busy')!;
    expect(busy.getAttribute('role')).toBe('status');
    expect(busy.getAttribute('aria-live')).toBe('polite');
    expect(busy.querySelector('.busy-spinner')!.getAttribute('aria-hidden')).toBe('true');
  });
});
