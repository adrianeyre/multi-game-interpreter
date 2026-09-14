/**
 * Keyboard behaviour for the editor's three "pick one of these" strips.
 *
 * The palette, the cel strip and the tab row are the same widget wearing three
 * costumes: a row of buttons where exactly one is chosen, the choice is shown
 * by colour or by an outline, and — before this — the only way to make one was
 * to click it. Tabbing through 256 palette swatches to reach the last one is
 * not keyboard access in any sense a person would recognise.
 *
 * So they get the pattern the ARIA practices give this shape: one tab stop for
 * the whole group, arrow keys to move within it, Home and End for the ends.
 * `role` differs — `radiogroup` for a palette, `tablist` for the tabs — because
 * a screen reader should say "tab" for a tab and "radio button" for a colour,
 * but the movement is identical and is written once.
 */

export type GroupRole = 'radiogroup' | 'tablist';

export interface RovingGroupOptions {
  /** `radiogroup` for a palette or a strip, `tablist` for the tab row. */
  role: GroupRole;
  /** What the group as a whole is, for a screen reader. */
  label: string;
  /**
   * Which way the arrows run.
   *
   * A palette wraps to several rows, so both axes move within it; a tab row is
   * one line and only the horizontal pair should do anything.
   */
  orientation?: 'horizontal' | 'both';
}

/**
 * Turns a container of buttons into one keyboard-navigable group.
 *
 * Call it after the buttons are in the container: it reads them, not a promise
 * of them. Every render in this editor rebuilds its strip from scratch, so this
 * is called again each time and simply re-reads the new children.
 *
 * The selected item is the one carrying `aria-checked="true"` or
 * `aria-selected="true"`; it becomes the group's single tab stop. With nothing
 * selected the first item takes the stop, so the group is never a hole in the
 * tab order.
 */
export function rovingGroup(container: HTMLElement, options: RovingGroupOptions): void {
  container.setAttribute('role', options.role);
  container.setAttribute('aria-label', options.label);
  if (options.orientation === 'horizontal') {
    container.setAttribute('aria-orientation', 'horizontal');
  }

  const items = itemsOf(container);
  if (items.length === 0) return;

  const selectedIndex = Math.max(
    0,
    items.findIndex(
      (item) =>
        item.getAttribute('aria-checked') === 'true' ||
        item.getAttribute('aria-selected') === 'true',
    ),
  );

  items.forEach((item, index) => {
    // One tab stop for the group. -1 keeps the others focusable by script,
    // which is what the arrow keys below do.
    item.tabIndex = index === selectedIndex ? 0 : -1;
  });

  container.addEventListener('keydown', (event) => onKeyDown(event, container, options));
}

/** The group's members: the elements carrying its item role. */
function itemsOf(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[role="radio"], [role="tab"]')].filter(
    (item) => !item.hasAttribute('disabled'),
  );
}

function onKeyDown(
  event: KeyboardEvent,
  container: HTMLElement,
  options: RovingGroupOptions,
): void {
  const items = itemsOf(container);
  if (items.length === 0) return;

  const active = document.activeElement;
  const current = items.findIndex((item) => item === active);
  if (current === -1) return;

  const vertical = options.orientation !== 'horizontal';
  let next: number;

  switch (event.key) {
    case 'ArrowRight':
      next = current + 1;
      break;
    case 'ArrowLeft':
      next = current - 1;
      break;
    case 'ArrowDown':
      if (!vertical) return;
      next = current + 1;
      break;
    case 'ArrowUp':
      if (!vertical) return;
      next = current - 1;
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = items.length - 1;
      break;
    default:
      return;
  }

  event.preventDefault();
  // Wraps: a palette of 256 has no useful "end", and stopping dead at one is a
  // dead key rather than a boundary anybody wanted.
  const target = items[(next + items.length) % items.length];
  target.tabIndex = 0;
  items[current].tabIndex = -1;
  target.focus();

  /*
   * A radio group selects on arrow, a tab list does not.
   *
   * Both are the ARIA practices' default for their pattern, and both are right
   * here for the same reason twice over: moving through a palette *is* choosing
   * a colour, and moving through tabs would otherwise rebuild the whole centre
   * column on every press of an arrow key.
   */
  if (options.role === 'radiogroup') target.click();
}

/**
 * Marks one button as a member of a group, with its state and its name.
 *
 * The name matters more here than anywhere else in the editor: these buttons
 * are a coloured square, a thumbnail or a single glyph, and without this the
 * accessible name of a palette swatch is the empty string.
 */
export function groupItem(
  button: HTMLElement,
  options: { role: 'radio' | 'tab'; selected: boolean; label: string; controls?: string },
): void {
  button.setAttribute('role', options.role);
  button.setAttribute(
    options.role === 'radio' ? 'aria-checked' : 'aria-selected',
    String(options.selected),
  );
  button.setAttribute('aria-label', options.label);
  if (options.controls) button.setAttribute('aria-controls', options.controls);
}

/**
 * The same idea for a two-dimensional grid: the AGI cel editor's pixels.
 *
 * Every pixel there is a `<button>`, which made a 32 by 40 cel one thousand two
 * hundred and eighty tab stops — technically reachable and unusable, and a
 * 2.4.3 failure in every sense that matters to a person. One tab stop for the
 * grid and arrow keys inside it is the pattern for a grid, and it is what makes
 * the cel editor operable rather than merely reachable.
 *
 * `role="grid"` with `gridcell` children rather than a radio group, because the
 * position of a pixel is part of what it is — a screen reader announcing "row
 * 4, column 12" is telling the author where they are on the drawing.
 */
export function rovingGrid(
  container: HTMLElement,
  options: { label: string; columns: number },
): void {
  container.setAttribute('role', 'grid');
  container.setAttribute('aria-label', options.label);

  const cells = [...container.querySelectorAll<HTMLElement>('[role="gridcell"]')];
  if (cells.length === 0) return;

  cells.forEach((cell, index) => {
    cell.tabIndex = index === 0 ? 0 : -1;
  });

  container.addEventListener('keydown', (event) => {
    const current = cells.findIndex((cell) => cell === document.activeElement);
    if (current === -1) return;

    const { columns } = options;
    const row = Math.floor(current / columns);
    const column = current % columns;
    const rows = Math.ceil(cells.length / columns);
    let next: number;

    switch (event.key) {
      case 'ArrowRight':
        next = column + 1 < columns ? current + 1 : current;
        break;
      case 'ArrowLeft':
        next = column > 0 ? current - 1 : current;
        break;
      case 'ArrowDown':
        next = row + 1 < rows ? current + columns : current;
        break;
      case 'ArrowUp':
        next = row > 0 ? current - columns : current;
        break;
      case 'Home':
        next = row * columns;
        break;
      case 'End':
        next = Math.min(cells.length - 1, row * columns + columns - 1);
        break;
      default:
        return;
    }

    event.preventDefault();
    const target = cells[Math.min(cells.length - 1, Math.max(0, next))];
    if (!target) return;
    cells[current].tabIndex = -1;
    target.tabIndex = 0;
    target.focus();
  });
}
