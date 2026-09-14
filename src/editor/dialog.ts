/**
 * The editor's own alert, confirm and prompt.
 *
 * `window.alert`, `window.confirm` and `window.prompt` are the three places
 * this editor handed its interface back to the browser, and each one is a
 * different problem. They block the main thread, so a canvas mid-repaint stays
 * half-drawn behind them. They cannot be styled, so a dark editor throws up a
 * white system box. Chrome offers "prevent this page from creating additional
 * dialogs" after the second one, and a person who clicks it silently loses
 * every later question — including the one asking whether to run somebody
 * else's JavaScript. And a `prompt` has no place to say what it wants, which is
 * why the audio rename read "Track name" and nothing else.
 *
 * So these three replace them, and the shapes match on purpose: {@link ask}
 * resolves to a string or `null` exactly as `prompt` returned, and
 * {@link confirm} resolves to a boolean. What changes at a call site is the
 * `await`.
 *
 * ## What makes it a dialog rather than a div
 *
 * `PlayOverlay` learned this the hard way — it was "a `<div>` over the page
 * with the whole editor still tabbable behind it" — so the same four things are
 * done here from the start:
 *
 * - `role="dialog"` with `aria-modal="true"`, labelled by its own heading, and
 *   described by its message so a screen reader reads the question rather than
 *   just the buttons.
 * - **Focus goes in and comes back.** The element that was focused when the
 *   dialog opened is focused again when it closes, because a question answered
 *   should leave the person where they were.
 * - **Tab is trapped.** Wrapping at both ends, so the editor behind is not
 *   reachable while a question is open — which is what "modal" means and what
 *   the browser's own dialogs give for free.
 * - **Escape answers.** It cancels, which is `null` from {@link ask}, `false`
 *   from {@link confirm} and simple dismissal from {@link alert} — the same
 *   thing the system dialogs do with it.
 *
 * One deliberate difference from the browser: {@link confirm} takes which
 * button starts focused. The import path asks whether to run untrusted
 * JavaScript, and a dialog that opens with "Allow" under the cursor is a
 * dialog that gets Allow pressed. That one opens on Cancel.
 */

/** Which button a confirm opens with focused. */
export type ConfirmDefault = 'accept' | 'cancel';

export interface ConfirmOptions {
  /** The heading. Defaults to a plain "Confirm". */
  readonly title?: string;
  /** The accepting button's label. Defaults to "OK". */
  readonly acceptLabel?: string;
  /** The cancelling button's label. Defaults to "Cancel". */
  readonly cancelLabel?: string;
  /**
   * Which button opens focused. Defaults to `accept`, and is `cancel` wherever
   * pressing the wrong one costs something a person cannot take back.
   */
  readonly defaultButton?: ConfirmDefault;
}

export interface AskOptions {
  /** The heading. Defaults to a plain "Enter a value". */
  readonly title?: string;
  /** What the field is called, shown as its label. */
  readonly label?: string;
  /** The accepting button's label. Defaults to "OK". */
  readonly acceptLabel?: string;
}

export interface AlertOptions {
  /** The heading. Defaults to a plain "Notice". */
  readonly title?: string;
  /** The dismissing button's label. Defaults to "OK". */
  readonly dismissLabel?: string;
}

/** Every focusable thing inside a panel, in tab order. */
function focusable(panel: HTMLElement): HTMLElement[] {
  const selector = 'button:not([disabled]), input:not([disabled]), [href], [tabindex]';
  return [...panel.querySelectorAll<HTMLElement>(selector)].filter(
    (element) => element.tabIndex >= 0,
  );
}

/**
 * A message as paragraphs.
 *
 * The calls being replaced pass `\n\n` between a sentence and a list of
 * compiler errors, because that is all `window.alert` understood. Splitting on
 * it keeps those readable as paragraphs, and `white-space: pre-wrap` in the
 * stylesheet keeps single newlines inside one — so a list of errors stays a
 * list of lines instead of collapsing into a paragraph.
 */
function messageParagraphs(message: string, id: string): HTMLElement {
  const wrapper = document.createElement('div');
  wrapper.className = 'dialog-message';
  wrapper.id = id;
  for (const part of message.split('\n\n')) {
    const paragraph = document.createElement('p');
    paragraph.textContent = part;
    wrapper.appendChild(paragraph);
  }
  return wrapper;
}

let sequence = 0;

interface PanelParts<T> {
  /** Built by the caller, appended between the message and the buttons. */
  readonly body?: HTMLElement;
  /** The buttons, in tab order. Each resolves the promise. */
  readonly buttons: readonly {
    readonly label: string;
    /**
     * What pressing it resolves to, or a function read at click time.
     *
     * `ask` needs the second: its OK button resolves to whatever is in the
     * field *then*, not to whatever was there when the dialog was built.
     */
    readonly value: T | (() => T);
    readonly primary?: boolean;
  }[];
  /** Which of `buttons` opens focused, or the body element instead. */
  readonly focusIndex: number | 'body';
  /** What Escape resolves to. */
  readonly escapeValue: T;
  /**
   * Called with a closer, so a body can accept on its own terms.
   *
   * A single-line field has to answer to Enter — that is how the browser's
   * `prompt` behaved and it is the whole interaction for a rename. Without
   * this, Enter inside the field does nothing at all, which is worse than the
   * dialog being replaced.
   */
  readonly wire?: (accept: (value: T) => void) => void;
}

/**
 * The one implementation the three exported calls share.
 *
 * Held in one place because the modal behaviour — the trap, the restore, the
 * Escape, the labelling — is the part that is easy to get subtly wrong, and
 * three copies of it would be three chances to.
 */
function present<T>(
  title: string,
  message: string,
  parts: (titleId: string, messageId: string) => PanelParts<T>,
): Promise<T> {
  sequence += 1;
  const titleId = `dialog-title-${sequence}`;
  const messageId = `dialog-message-${sequence}`;

  const overlay = document.createElement('div');
  overlay.className = 'dialog-overlay';

  const panel = document.createElement('div');
  panel.className = 'dialog-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', titleId);
  panel.setAttribute('aria-describedby', messageId);

  const heading = document.createElement('h2');
  heading.id = titleId;
  heading.textContent = title;

  panel.append(heading, messageParagraphs(message, messageId));

  const spec = parts(titleId, messageId);
  if (spec.body) panel.appendChild(spec.body);

  const row = document.createElement('div');
  row.className = 'dialog-buttons';
  panel.appendChild(row);
  overlay.appendChild(panel);

  // The element to give the keyboard back to. Read before the dialog is in the
  // document, because appending it does not move focus but the first `focus()`
  // below does.
  const previous = document.activeElement;

  return new Promise<T>((resolve) => {
    let settled = false;

    const close = (value: T): void => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKeyDown, true);
      overlay.remove();
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
      resolve(value);
    };

    const made = spec.buttons.map((definition) => {
      const element = document.createElement('button');
      element.type = 'button';
      element.textContent = definition.label;
      if (definition.primary) element.className = 'dialog-primary';
      element.addEventListener('click', () =>
        close(
          typeof definition.value === 'function'
            ? (definition.value as () => T)()
            : definition.value,
        ),
      );
      row.appendChild(element);
      return element;
    });

    function onKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(spec.escapeValue);
        return;
      }
      if (event.key !== 'Tab') return;

      // The trap. Without it the editor behind stays reachable, which is the
      // fault `PlayOverlay` had to be corrected for.
      const stops = focusable(panel);
      if (stops.length === 0) return;
      const first = stops[0];
      const last = stops[stops.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    spec.wire?.(close);

    document.addEventListener('keydown', onKeyDown, true);
    document.body.appendChild(overlay);

    const target =
      spec.focusIndex === 'body'
        ? (focusable(spec.body ?? panel)[0] ?? made[0])
        : made[spec.focusIndex];
    target?.focus();
    // Selected after focusing and after the panel is in the document, which is
    // the only order that takes: `select()` on a detached input does nothing.
    // It matters because `prompt` opened with its value selected, so typing
    // replaced the old name rather than appending to it.
    if (target instanceof HTMLInputElement) target.select();
  });
}

/** Says something and waits for it to be dismissed. Replaces `window.alert`. */
export function alert(message: string, options: AlertOptions = {}): Promise<void> {
  return present<void>(options.title ?? 'Notice', message, () => ({
    buttons: [{ label: options.dismissLabel ?? 'OK', value: undefined, primary: true }],
    focusIndex: 0,
    escapeValue: undefined,
  }));
}

/**
 * Asks a yes-or-no question. Replaces `window.confirm`, and resolves to the
 * same boolean it returned.
 */
export function confirm(message: string, options: ConfirmOptions = {}): Promise<boolean> {
  const onCancel = (options.defaultButton ?? 'accept') === 'cancel';
  return present<boolean>(options.title ?? 'Confirm', message, () => ({
    buttons: [
      { label: options.cancelLabel ?? 'Cancel', value: false },
      { label: options.acceptLabel ?? 'OK', value: true, primary: true },
    ],
    focusIndex: onCancel ? 0 : 1,
    escapeValue: false,
  }));
}

/**
 * Asks for a line of text. Replaces `window.prompt`, and resolves to the
 * string, or to `null` when it is cancelled — the same two outcomes.
 */
export function ask(
  message: string,
  initial = '',
  options: AskOptions = {},
): Promise<string | null> {
  const body = document.createElement('div');
  body.className = 'dialog-field';

  const field = document.createElement('input');
  field.type = 'text';
  field.value = initial;

  const label = document.createElement('label');
  sequence += 1;
  field.id = `dialog-input-${sequence}`;
  label.htmlFor = field.id;
  label.textContent = options.label ?? message;
  body.append(label, field);

  return present<string | null>(options.title ?? 'Enter a value', message, () => ({
    body,
    buttons: [
      { label: 'Cancel', value: null },
      { label: options.acceptLabel ?? 'OK', value: () => field.value, primary: true },
    ],
    focusIndex: 'body',
    escapeValue: null,
    wire: (accept) => {
      field.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        accept(field.value);
      });
    },
  }));
}
