/**
 * One operand of one bytecode call, as a labelled control.
 *
 * A widget, shared between the two Broken Sword surfaces the way
 * `sceneCanvas.ts` is — and sharing a *widget* is not sharing a *record* (ADR
 * 0036). Neither family's call records touch this file: they hand it a label,
 * a number, and optionally a list of things that number could be.
 *
 * It is the same `label.field` shape `ActionEditor`'s `numberField` and
 * `selectField` produce, so a Sword call looks like a SCUMM action rather than
 * like a second design. It adds the two things a bytecode operand needs that a
 * SCUMM action field does not:
 *
 * - **A hint.** A text id is a number, and the useful thing to show beside it
 *   is the line it names. The hint is wired with `aria-describedby` rather than
 *   left as loose text beside the control, so it reaches a screen reader at the
 *   moment the control does (1.3.1, 3.3.2).
 * - **A select that keeps a value it does not know.** A script may name a
 *   screen this project did not import — a demo ships three of ninety. A plain
 *   `<select>` would snap such a value to its first option the moment the
 *   element is created, silently rewriting the script on render. So an
 *   unrecognised value is added as its own option, marked as absent.
 */

/** One thing an operand could be, for a picker. */
export interface OperandChoice {
  readonly value: number;
  readonly label: string;
}

export interface OperandFieldOptions {
  /** The operand's name, which is what the label reads. */
  readonly label: string;
  readonly value: number;
  /** A picker's options, or null for a plain number. */
  readonly choices?: readonly OperandChoice[] | null;
  /** What the value names — the line a text id names, say. */
  readonly hint?: string | null;
  /** A stable id prefix, so the hint's `id` is unique on the page. */
  readonly id: string;
  readonly onChange: (value: number) => void;
}

let hintSerial = 0;

/** A labelled number or picker, with an optional described hint. */
export function operandField(options: OperandFieldOptions): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'field operand-field';

  const text = document.createElement('span');
  text.textContent = options.label;

  const control = options.choices?.length
    ? choiceControl(options.choices, options.value, options.onChange)
    : numberControl(options.value, options.onChange);

  wrapper.append(text, control);

  if (options.hint) {
    const hint = document.createElement('span');
    hint.className = 'operand-hint';
    hint.id = `${options.id}-hint-${++hintSerial}`;
    hint.textContent = options.hint;
    control.setAttribute('aria-describedby', hint.id);
    wrapper.appendChild(hint);
  }

  return wrapper;
}

function numberControl(value: number, onChange: (value: number) => void): HTMLElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value);
  input.addEventListener('change', () => {
    const parsed = Number.parseInt(input.value, 10);
    if (Number.isFinite(parsed)) onChange(parsed);
  });
  return input;
}

function choiceControl(
  choices: readonly OperandChoice[],
  value: number,
  onChange: (value: number) => void,
): HTMLElement {
  const select = document.createElement('select');
  const known = choices.some((choice) => choice.value === value);
  const options: OperandChoice[] = known
    ? [...choices]
    : // Kept rather than snapped: see the note at the top of this file.
      [{ value, label: `${value} — not in this project` }, ...choices];
  for (const choice of options) {
    const option = document.createElement('option');
    option.value = String(choice.value);
    option.textContent = choice.label;
    select.appendChild(option);
  }
  select.value = String(value);
  select.addEventListener('change', () => {
    const parsed = Number.parseInt(select.value, 10);
    if (Number.isFinite(parsed)) onChange(parsed);
  });
  return select;
}

/**
 * How many choices a picker is allowed before it becomes a number field.
 *
 * Broken Sword holds thousands of compacts, and a `<select>` with four thousand
 * options is a control nobody can use and a page that takes a second to build.
 * Past this, the caller shows a number with a hint naming what it points at,
 * which is the information without the list.
 */
export const OPERAND_CHOICE_LIMIT = 200;
