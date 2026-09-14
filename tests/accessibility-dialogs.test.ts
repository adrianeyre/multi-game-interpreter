// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { mountAccessibilityStatement } from '../src/ui/accessibility.js';
import { createNotice } from '../src/ui/notice.js';

/**
 * The dialogs, rendered.
 *
 * Every modal in this project used to make the same claim in markup —
 * `aria-modal="true"` — and none of them kept it: two presses of Tab walked out
 * onto the title bar, and on the player page the thing underneath was a running
 * game still listening for keys. What is asserted here is the claim itself.
 */

function pressEscape(): void {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
  );
}

describe('the accessibility statement', () => {
  let footer: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    footer = document.createElement('footer');
    // Something to return focus to, and something for the trap to make inert.
    footer.innerHTML = '<button id="cookies">Cookies</button>';
    document.body.append(footer);
    mountAccessibilityStatement(footer);
  });

  const link = (): HTMLButtonElement =>
    [...footer.querySelectorAll('button')].find(
      (button) => button.textContent === 'Accessibility',
    ) as HTMLButtonElement;

  const overlay = (): HTMLElement => document.querySelector<HTMLElement>('#accessibility-overlay')!;

  const dialog = (): HTMLElement => overlay().querySelector<HTMLElement>('[role="dialog"]')!;

  it('adds a link to the footer, beside the cookie one', () => {
    expect(link()).toBeTruthy();
    expect(link().previousElementSibling?.id).toBe('cookies');
    expect(link().getAttribute('aria-haspopup')).toBe('dialog');
  });

  /**
   * 2.5.3, Label in Name: the accessible name has to begin with the visible
   * text, or someone saying "click Accessibility" to a voice control is naming
   * something the software cannot find.
   */
  it('starts the accessible name with the visible word', () => {
    expect(link().getAttribute('aria-label')).toMatch(/^Accessibility\b/);
  });

  it('starts closed', () => {
    expect(overlay().hidden).toBe(true);
  });

  it('opens as a named modal dialog and takes focus into it', () => {
    link().click();

    expect(overlay().hidden).toBe(false);
    expect(dialog().getAttribute('aria-modal')).toBe('true');

    const labelledBy = dialog().getAttribute('aria-labelledby')!;
    expect(document.getElementById(labelledBy)?.textContent).toBe('Accessibility');

    const describedBy = dialog().getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toContain('WCAG 2.2 Level AA');

    expect(dialog().contains(document.activeElement)).toBe(true);
  });

  it('makes the page behind it inert while it is open', () => {
    link().click();
    expect(footer.hasAttribute('inert')).toBe(true);
    expect(footer.getAttribute('aria-hidden')).toBe('true');
  });

  it('closes on Escape and gives focus back to the link', () => {
    link().focus();
    link().click();
    pressEscape();

    expect(footer.hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(link());
  });

  it('closes on the backdrop but not on a click inside the panel', () => {
    link().click();
    dialog().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay().classList.contains('is-open')).toBe(true);

    overlay().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(overlay().classList.contains('is-open')).toBe(false);
  });

  it('closes with the cross', () => {
    link().click();
    overlay().querySelector<HTMLButtonElement>('.consent-close')!.click();
    expect(overlay().classList.contains('is-open')).toBe(false);
  });

  /**
   * A statement that lists only what works is marketing. The value of this
   * document to a reader who has just hit one of the limits is that the limit
   * is named, with what is done instead.
   */
  it('says where the claim stops, not only what it covers', () => {
    link().click();
    const text = dialog().textContent ?? '';

    expect(text).toContain('Known limits');
    // The three real exceptions, each named rather than implied.
    expect(text).toMatch(/running game.s own pictures and words cannot be described/i);
    expect(text).toMatch(/12-pixel cells/);
    expect(text).toMatch(/has not been checked with a real screen reader/i);
    // And a route for anything it missed.
    expect(dialog().querySelector('a[href*="/issues"]')).not.toBeNull();
  });

  it('names the criteria groups a reader would look for', () => {
    link().click();
    const headings = [...dialog().querySelectorAll('h3')].map((node) => node.textContent);

    expect(headings).toContain('Using it without a mouse');
    expect(headings).toContain('Using it with a screen reader');
    expect(headings).toContain('Seeing it');
    expect(headings).toContain('Known limits');
  });

  /** An external link that says where it goes, and does not leak the opener. */
  it('opens the issue tracker safely', () => {
    link().click();
    const issues = dialog().querySelector<HTMLAnchorElement>('a[href*="/issues"]')!;
    expect(issues.rel).toContain('noopener');
    expect(issues.target).toBe('_blank');
  });
});

describe('the notice dialog', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    const page = document.createElement('div');
    page.innerHTML = '<button id="opener">Edit game</button>';
    document.body.append(page);
  });

  it('is an alert dialog, named and described by its own content', () => {
    const notice = createNotice();
    notice.show('This game cannot be edited', 'The interpreter version was a guess.');

    const panel = document.querySelector<HTMLElement>('.notice-panel')!;
    expect(panel.getAttribute('role')).toBe('alertdialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(panel.getAttribute('aria-labelledby')!)?.textContent).toBe(
      'This game cannot be edited',
    );
    expect(document.getElementById(panel.getAttribute('aria-describedby')!)?.textContent).toContain(
      'a guess',
    );
  });

  it('takes focus, makes the page inert, and hands focus back on Escape', () => {
    const opener = document.querySelector<HTMLButtonElement>('#opener')!;
    opener.focus();

    const notice = createNotice();
    notice.show('Could not decompile this game', 'Something went wrong.');

    const overlay = document.querySelector<HTMLElement>('.notice-overlay')!;
    expect(overlay.contains(document.activeElement)).toBe(true);
    expect(document.querySelector('#opener')!.closest('[inert]')).not.toBeNull();

    pressEscape();

    expect(overlay.hidden).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  /**
   * A caller awaiting an answer that never arrives is a button that has
   * silently stopped working — which is the fault this component exists to
   * remove, so dismissing has to settle the promise rather than drop it.
   */
  it('answers null when an asking notice is dismissed', async () => {
    const notice = createNotice();
    const answer = notice.ask(
      'This game cannot be edited',
      'Pick the interpreter it shipped with.',
      [
        {
          name: 'interpreter',
          label: 'Interpreter',
          options: [
            { value: '2917', label: '2.917' },
            { value: '3002', label: '3.002' },
          ],
          value: '2917',
        },
      ],
      'Use this version',
    );

    // The choice is what is being made, so it is what takes focus.
    expect((document.activeElement as HTMLElement).tagName).toBe('SELECT');

    document.querySelector<HTMLButtonElement>('.notice-dismiss')!.click();
    await expect(answer).resolves.toBeNull();
  });

  it('answers with the chosen values when confirmed', async () => {
    const notice = createNotice();
    const answer = notice.ask(
      'This game cannot be edited',
      'Pick the interpreter it shipped with.',
      [
        {
          name: 'platform',
          label: 'Platform',
          options: [
            { value: 'dos', label: 'dos' },
            { value: 'amiga', label: 'amiga' },
          ],
          value: 'dos',
        },
      ],
      'Use this version',
    );

    document.querySelector<HTMLSelectElement>('.notice-field select')!.value = 'amiga';
    document.querySelector<HTMLButtonElement>('.notice-confirm')!.click();

    await expect(answer).resolves.toEqual({ platform: 'amiga' });
    expect(document.querySelector<HTMLElement>('.notice-overlay')!.hidden).toBe(true);
  });
});
