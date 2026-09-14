// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { announce, focusableWithin, resetAnnouncer, trapFocus } from '../src/ui/a11y.js';

/**
 * The focus trap every modal in this project now shares.
 *
 * This is the piece the dialogs were each missing a different half of: they set
 * `aria-modal="true"` and then let Tab walk out onto the page behind them, with
 * the running game still listening for keys underneath. These tests are the
 * definition of what "modal" has to mean here, rendered rather than grepped —
 * the repo could only make static assertions about accessibility before, and a
 * static assertion cannot tell you where focus went.
 */
describe('trapFocus', () => {
  let page: HTMLElement;
  let dialog: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();

    page = document.createElement('div');
    page.innerHTML = `
      <button id="opener">Open</button>
      <button id="behind">Behind</button>
    `;

    dialog = document.createElement('div');
    dialog.innerHTML = `
      <button id="first">First</button>
      <input id="middle" />
      <button id="last">Last</button>
    `;

    document.body.append(page, dialog);
  });

  function press(key: string, options: KeyboardEventInit = {}): KeyboardEvent {
    const event = new KeyboardEvent('keydown', {
      key,
      bubbles: true,
      cancelable: true,
      ...options,
    });
    (document.activeElement ?? document.body).dispatchEvent(event);
    return event;
  }

  it('makes everything outside the dialog inert and hidden from assistive technology', () => {
    const trap = trapFocus(dialog);

    expect(page.hasAttribute('inert')).toBe(true);
    expect(page.getAttribute('aria-hidden')).toBe('true');
    expect(dialog.hasAttribute('inert')).toBe(false);

    trap.release();

    expect(page.hasAttribute('inert')).toBe(false);
    expect(page.hasAttribute('aria-hidden')).toBe(false);
  });

  /**
   * Not every overlay is a child of the body.
   *
   * The editor's play overlay is mounted inside `#editor`, beside the editor it
   * covers, so muting only the body's children skipped `#editor` — it contains
   * the overlay — and left the toolbar, sidebar and canvases behind a "modal"
   * dialog fully tabbable.
   */
  it('mutes the siblings at every level, not only at the body', () => {
    document.body.replaceChildren();

    const app = document.createElement('div');
    const editor = document.createElement('div');
    editor.innerHTML = '<button id="tool">Paint</button>';
    const overlay = document.createElement('div');
    overlay.innerHTML = '<button id="stop">Stop</button>';
    app.append(editor, overlay);

    const elsewhere = document.createElement('div');
    elsewhere.innerHTML = '<button id="far">Far away</button>';
    document.body.append(app, elsewhere);

    const trap = trapFocus(overlay);

    expect(editor.hasAttribute('inert')).toBe(true);
    expect(elsewhere.hasAttribute('inert')).toBe(true);
    // The chain down to the dialog stays reachable, or the dialog goes with it.
    expect(app.hasAttribute('inert')).toBe(false);
    expect(overlay.hasAttribute('inert')).toBe(false);
    expect(focusableWithin(document.body).map((node) => node.id)).toEqual(['stop']);

    trap.release();

    expect(editor.hasAttribute('inert')).toBe(false);
    expect(elsewhere.hasAttribute('inert')).toBe(false);
  });

  /**
   * A surface that was already hidden before the dialog opened has to stay
   * hidden after it closes. Restoring blindly would reveal it.
   */
  it('restores what the background was, rather than assuming it was visible', () => {
    page.setAttribute('aria-hidden', 'true');
    page.setAttribute('inert', '');

    trapFocus(dialog).release();

    expect(page.getAttribute('aria-hidden')).toBe('true');
    expect(page.hasAttribute('inert')).toBe(true);
  });

  it('wraps Tab from the last control back to the first', () => {
    trapFocus(dialog);
    document.querySelector<HTMLElement>('#last')!.focus();

    const event = press('Tab');

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('first');
  });

  it('wraps Shift+Tab from the first control back to the last', () => {
    trapFocus(dialog);
    document.querySelector<HTMLElement>('#first')!.focus();

    const event = press('Tab', { shiftKey: true });

    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement?.id).toBe('last');
  });

  it('leaves Tab alone in the middle of the dialog, so the browser moves normally', () => {
    trapFocus(dialog);
    document.querySelector<HTMLElement>('#first')!.focus();

    expect(press('Tab').defaultPrevented).toBe(false);
  });

  it('reports Escape to the surface rather than closing itself', () => {
    let escapes = 0;
    trapFocus(dialog, { onEscape: () => escapes++ });
    document.querySelector<HTMLElement>('#first')!.focus();

    press('Escape');

    expect(escapes).toBe(1);
  });

  /**
   * The page underneath is a running game that acts on keys, so the keystroke
   * that closed a dialog must not also reach it.
   */
  it('stops Escape from reaching the page underneath', () => {
    let leaked = 0;
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') leaked++;
    });

    trapFocus(dialog, { onEscape: () => undefined });
    document.querySelector<HTMLElement>('#first')!.focus();
    press('Escape');

    expect(leaked).toBe(0);
  });

  it('gives focus back to the control that opened it', () => {
    const opener = document.querySelector<HTMLElement>('#opener')!;
    opener.focus();

    const trap = trapFocus(dialog);
    document.querySelector<HTMLElement>('#last')!.focus();
    trap.release();

    expect(document.activeElement).toBe(opener);
  });

  it('keeps Tab inside a dialog that has nothing to focus', () => {
    const empty = document.createElement('div');
    empty.textContent = 'Nothing here';
    document.body.append(empty);

    trapFocus(empty);
    const event = press('Tab');

    expect(event.defaultPrevented).toBe(true);
  });
});

describe('focusableWithin', () => {
  beforeEach(() => document.body.replaceChildren());

  it('finds the controls in document order and skips the ones that are not stops', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <a href="#one">One</a>
      <button>Two</button>
      <button disabled>Not this</button>
      <input />
      <select><option>x</option></select>
      <textarea></textarea>
      <div tabindex="0">Six</div>
      <div tabindex="-1">Not this either</div>
      <span>Nor this</span>
    `;
    document.body.append(container);

    expect(focusableWithin(container).map((node) => node.tagName)).toEqual([
      'A',
      'BUTTON',
      'INPUT',
      'SELECT',
      'TEXTAREA',
      'DIV',
    ]);
  });

  /**
   * The visually-hidden class is the whole point of the distinction: it is off
   * the screen and still a tab stop, where `hidden` is neither.
   */
  it('skips a hidden subtree and keeps a visually hidden one', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <div hidden><button id="away">Away</button></div>
      <div aria-hidden="true"><button id="silent">Silent</button></div>
      <button id="clipped" style="position:absolute;clip-path:inset(50%)">Clipped</button>
    `;
    document.body.append(container);

    expect(focusableWithin(container).map((node) => node.id)).toEqual(['clipped']);
  });
});

describe('announce', () => {
  beforeEach(() => {
    resetAnnouncer();
    document.body.replaceChildren();
  });

  it('creates one polite region and says the message through it', async () => {
    announce('Saved.');

    const regions = document.querySelectorAll('[aria-live="polite"]');
    expect(regions).toHaveLength(1);
    expect(regions[0].getAttribute('role')).toBe('status');

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(regions[0].textContent).toBe('Saved.');
  });

  /**
   * Two of the same sentence means it happened twice, and a screen reader only
   * treats text as new if the region changed — hence the clear before the set.
   */
  it('reuses the one region rather than stacking a second', async () => {
    announce('One.');
    await new Promise((resolve) => setTimeout(resolve, 80));
    announce('One.');

    expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(1);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('');

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe('One.');
  });

  it('says nothing for an empty message', () => {
    announce('');
    expect(document.querySelectorAll('[aria-live]')).toHaveLength(0);
  });
});
