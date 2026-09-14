/**
 * A notice the reader has to dismiss, for an answer that is not a one-liner.
 *
 * The status bar holds one line and the log panel scrolls, which between them
 * are enough for everything that *happens* and not enough for a refusal. When
 * the editor declines a game — ADR 0013 refuses one whose interpreter version
 * was a guess — the reason is three paragraphs explaining what would go wrong
 * and what file would fix it. Sent to the status bar it is truncated to its
 * first clause; sent to the log it lands below the fold of a panel nobody was
 * looking at. Either way the click reads as a button that does nothing, which
 * is precisely how it was reported.
 *
 * So: a modal, dismissed by its button, by Escape, or by clicking away from it.
 *
 * Modal in the sense the word has to mean for a keyboard: `trapFocus` keeps Tab
 * inside the panel and makes the rest of the page inert while it is up. Before
 * that, `aria-modal` was a claim the markup made and the tab order contradicted
 * — two presses of Tab left the dialog and landed on the title bar, with the
 * running game still listening for keys underneath.
 */
import { trapFocus, type FocusTrap } from './a11y.js';

/** One `<select>` in an asking notice. */
export interface NoticeField {
  /** Key this field's answer comes back under. */
  name: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  /** Which option starts selected. */
  value?: string;
}

export interface Notice {
  /** Shows the notice. Replaces one already up rather than stacking. */
  show(title: string, body: string): void;
  /**
   * Shows the notice with choices, and resolves with them — or with null when
   * it is dismissed instead.
   *
   * Here rather than in a second component because the choice belongs *with*
   * the explanation: what a person is agreeing to when they declare an
   * interpreter version is exactly the three paragraphs above the control, and
   * a dialog that made them dismiss the warning to reach the button would be
   * asking them to decide having put the reasons away.
   */
  ask(
    title: string,
    body: string,
    fields: NoticeField[],
    confirmLabel: string,
  ): Promise<Record<string, string> | null>;
  hide(): void;
}

export function createNotice(parent: HTMLElement = document.body): Notice {
  const overlay = document.createElement('div');
  overlay.className = 'notice-overlay';
  overlay.hidden = true;

  const panel = document.createElement('div');
  panel.className = 'notice-panel';
  // A dialog rather than a status: the reader is being asked to read it and
  // acknowledge it, and a screen reader should say so and take focus with it.
  panel.setAttribute('role', 'alertdialog');
  panel.setAttribute('aria-modal', 'true');

  const heading = document.createElement('h2');
  heading.className = 'notice-title';
  heading.id = 'notice-title';
  panel.setAttribute('aria-labelledby', heading.id);

  const body = document.createElement('div');
  body.className = 'notice-body';
  body.id = 'notice-body';
  panel.setAttribute('aria-describedby', body.id);

  const form = document.createElement('div');
  form.className = 'notice-form';
  form.hidden = true;

  const buttons = document.createElement('div');
  buttons.className = 'notice-buttons';

  const dismiss = document.createElement('button');
  dismiss.type = 'button';
  dismiss.className = 'notice-dismiss';
  dismiss.textContent = 'OK';

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'notice-confirm';
  confirm.hidden = true;

  buttons.append(dismiss, confirm);
  panel.append(heading, body, form, buttons);
  overlay.append(panel);
  parent.appendChild(overlay);

  /**
   * The live trap, which also holds the focus to return to.
   *
   * Releasing it un-inerts the page and puts focus back on the button that
   * raised the notice — a keyboard user who lands at the top of the document
   * instead has to walk the whole toolbar again to try the next thing.
   */
  let trap: FocusTrap | null = null;
  /** Settles the pending `ask`, so a dismissal is an answer rather than a hang. */
  let settle: ((answer: Record<string, string> | null) => void) | null = null;

  function close(): void {
    overlay.hidden = true;
    trap?.release();
    trap = null;
  }

  function hide(): void {
    if (overlay.hidden) return;
    // Settled before focus moves, and always: a caller awaiting an answer that
    // never arrives is a button that has silently stopped working, which is the
    // fault this whole component exists to remove.
    const pending = settle;
    settle = null;
    pending?.(null);
    close();
  }

  /** The fields currently on show, in the order they were asked for. */
  let fieldElements: Array<{ name: string; select: HTMLSelectElement }> = [];

  confirm.addEventListener('click', () => {
    const answer = Object.fromEntries(
      fieldElements.map((field) => [field.name, field.select.value]),
    );
    const pending = settle;
    // Cleared first so `hide` does not then settle the same promise with null.
    settle = null;
    close();
    pending?.(answer);
  });

  dismiss.addEventListener('click', hide);
  overlay.addEventListener('click', (event) => {
    // Only the backdrop. A click that started inside the panel — selecting the
    // text of the explanation, which is the likeliest thing to do with it —
    // must not take the explanation away.
    if (event.target === overlay) hide();
  });
  function render(title: string, text: string): void {
    heading.textContent = title;
    // Paragraph per blank-line-separated block, which is the shape these
    // messages are already written in. Set as text, never as markup: some of
    // it comes from a game's own files.
    body.replaceChildren(
      ...text
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
        .map((paragraph) => {
          const element = document.createElement('p');
          element.textContent = paragraph;
          return element;
        }),
    );
    overlay.hidden = false;
    // After it is on screen, so the trap can measure what is focusable in it.
    trap = trapFocus(overlay, { onEscape: hide });
  }

  return {
    show(title, text) {
      hide();
      fieldElements = [];
      form.replaceChildren();
      form.hidden = true;
      confirm.hidden = true;
      dismiss.textContent = 'OK';
      render(title, text);
      dismiss.focus();
    },

    async ask(title, text, fields, confirmLabel) {
      hide();
      fieldElements = fields.map((field) => {
        const row = document.createElement('label');
        row.className = 'notice-field';

        const caption = document.createElement('span');
        caption.textContent = field.label;

        const select = document.createElement('select');
        for (const option of field.options) {
          const element = document.createElement('option');
          element.value = option.value;
          element.textContent = option.label;
          select.appendChild(element);
        }
        if (field.value !== undefined) select.value = field.value;

        row.append(caption, select);
        form.appendChild(row);
        return { name: field.name, select };
      });

      form.hidden = fieldElements.length === 0;
      confirm.hidden = false;
      confirm.textContent = confirmLabel;
      // Named for what declining does, not "Cancel": the reader is choosing
      // between two real outcomes and both deserve a verb.
      dismiss.textContent = 'Leave it alone';
      render(title, text);
      // Focus the first choice rather than a button, because the choice is the
      // thing being made and the buttons only record it.
      (fieldElements[0]?.select ?? confirm).focus();

      return await new Promise<Record<string, string> | null>((resolve) => {
        settle = resolve;
      });
    },
    hide,
  };
}
