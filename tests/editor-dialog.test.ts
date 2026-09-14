// @vitest-environment jsdom
import { describe, expect, it, beforeEach } from 'vitest';
import { alert, confirm, ask } from '../src/editor/dialog.js';

/**
 * The editor's own alert, confirm and prompt.
 *
 * These replace `window.alert`/`confirm`/`prompt`, and the point of the tests
 * is that the *contract* survived the replacement: `confirm` still answers a
 * boolean, `ask` still answers a string or `null`, and Escape still cancels.
 * A modal that looks right and answers `undefined` where the old call answered
 * `null` moves the bug into every call site instead of fixing it.
 */
function panel(): HTMLElement {
  const found = document.querySelector<HTMLElement>('.dialog-panel');
  if (!found) throw new Error('no dialog is open');
  return found;
}

function buttonLabelled(label: string): HTMLButtonElement {
  const match = [...panel().querySelectorAll('button')].find(
    (candidate) => candidate.textContent === label,
  );
  if (!match) throw new Error(`no button labelled ${label}`);
  return match;
}

function pressEscape(): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

describe('the editor’s dialogs', () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it('is a labelled modal dialog, not a div over the page', () => {
    // The correction `PlayOverlay` had to be given, done here from the start.
    void alert('Something happened.', { title: 'Notice' });

    const dialog = panel();
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');

    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('Notice');

    const describedBy = dialog.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain(
      'Something happened.',
    );
  });

  it('confirm answers true and false, the way window.confirm did', async () => {
    const accepted = confirm('Go ahead?');
    buttonLabelled('OK').click();
    await expect(accepted).resolves.toBe(true);

    const refused = confirm('Go ahead?');
    buttonLabelled('Cancel').click();
    await expect(refused).resolves.toBe(false);
  });

  it('ask answers the field’s value, and null when cancelled', async () => {
    const named = ask('What should this be called?', 'Old name');
    const field = panel().querySelector('input');
    if (!field) throw new Error('no field');
    field.value = 'New name';
    buttonLabelled('OK').click();
    await expect(named).resolves.toBe('New name');

    // `null` and not `''`: a call site distinguishes "cancelled" from "cleared",
    // and the audio rename is one — it writes the value only when it is not null.
    const cancelled = ask('What should this be called?', 'Old name');
    buttonLabelled('Cancel').click();
    await expect(cancelled).resolves.toBeNull();
  });

  it('ask accepts on Enter, because a rename is one keystroke', async () => {
    const named = ask('Name', 'Old');
    const field = panel().querySelector('input');
    if (!field) throw new Error('no field');
    field.value = 'Typed';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await expect(named).resolves.toBe('Typed');
  });

  it('Escape cancels, and cancels as each call’s own falsy answer', async () => {
    const asked = ask('Name', 'Old');
    pressEscape();
    await expect(asked).resolves.toBeNull();

    const confirmed = confirm('Go ahead?');
    pressEscape();
    await expect(confirmed).resolves.toBe(false);

    const noticed = alert('Something happened.');
    pressEscape();
    await expect(noticed).resolves.toBeUndefined();
  });

  it('opens on the refusal where the wrong press costs something', () => {
    // The import path asks whether to run somebody else's JavaScript. A dialog
    // that opens with Allow focused is a dialog that gets Allow pressed.
    void confirm('Allow custom code to run?', {
      acceptLabel: 'Allow custom code',
      cancelLabel: 'Open without it',
      defaultButton: 'cancel',
    });
    expect(document.activeElement).toBe(buttonLabelled('Open without it'));
  });

  it('gives the keyboard back to whatever had it', async () => {
    const before = document.createElement('button');
    document.body.appendChild(before);
    before.focus();
    expect(document.activeElement).toBe(before);

    const answered = confirm('Go ahead?');
    expect(document.activeElement).not.toBe(before);
    buttonLabelled('OK').click();
    await answered;

    expect(document.activeElement).toBe(before);
  });

  it('closes on the first answer and ignores a second press', async () => {
    const answered = confirm('Go ahead?');
    const ok = buttonLabelled('OK');
    const cancel = buttonLabelled('Cancel');
    ok.click();
    cancel.click(); // detached by now, and must not change the answer
    await expect(answered).resolves.toBe(true);
    expect(document.querySelector('.dialog-panel')).toBeNull();
  });

  it('keeps a blank line between paragraphs as separate paragraphs', () => {
    // The calls being replaced pass `\n\n` between a sentence and a list of
    // compiler errors, because that is all `window.alert` understood.
    void alert('It did not compile:\n\nline 1\nline 2');
    const paragraphs = panel().querySelectorAll('.dialog-message p');
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[1].textContent).toBe('line 1\nline 2');
  });
});
