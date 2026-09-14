/**
 * The working overlay: the screen darkens and a spinner turns.
 *
 * Decompiling a game is seconds of synchronous work, and the page cannot
 * respond while it runs. The progress bar it reports into is a few pixels in
 * the footer, so the honest reading of the screen during a decompile was that
 * the button had done nothing. This says otherwise, at the size the wait
 * deserves.
 */

export interface BusyOverlay {
  /** Darkens the screen and starts the spinner. */
  show(message: string, hint?: string): void;
  /** Replaces the message without flickering the overlay. */
  setMessage(message: string): void;
  /** Puts the page back. */
  hide(): void;
}

/**
 * Builds the overlay and attaches it to `parent` (the body by default).
 *
 * `aria-live` on the message rather than the overlay, so a screen reader hears
 * each step rather than the whole block again on every change.
 */
export function createBusyOverlay(parent: HTMLElement = document.body): BusyOverlay {
  const overlay = document.createElement('div');
  overlay.className = 'busy-overlay';
  overlay.hidden = true;
  overlay.setAttribute('role', 'status');

  const spinner = document.createElement('div');
  spinner.className = 'busy-spinner';
  spinner.setAttribute('aria-hidden', 'true');

  const message = document.createElement('p');
  message.className = 'busy-message';
  message.setAttribute('aria-live', 'polite');

  const hint = document.createElement('p');
  hint.className = 'busy-hint';
  hint.hidden = true;

  overlay.append(spinner, message, hint);
  parent.appendChild(overlay);

  return {
    show(text, hintText) {
      message.textContent = text;
      hint.textContent = hintText ?? '';
      hint.hidden = !hintText;
      overlay.hidden = false;
    },
    setMessage(text) {
      message.textContent = text;
    },
    hide() {
      overlay.hidden = true;
    },
  };
}
