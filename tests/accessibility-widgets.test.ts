// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { groupItem, rovingGrid, rovingGroup } from '../src/editor/a11yWidgets.js';
import { KeyboardCursor, isActivation, isErase } from '../src/editor/canvasKeyboard.js';
import { describeColour } from '../src/ui/a11y.js';

function press(target: Element, key: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
  target.dispatchEvent(event);
  return event;
}

/**
 * The palette, the cel strip and the tab row.
 *
 * All three were rows of plain buttons: one tab stop each, so a 256-colour
 * palette was 256 stops and reaching the last one meant 256 presses of Tab.
 * That is technically operable and is a 2.4.3 failure in the only sense that
 * matters to a person using it.
 */
describe('rovingGroup', () => {
  let group: HTMLElement;

  function build(count: number, selectedIndex: number, role: 'radio' | 'tab' = 'radio'): void {
    group = document.createElement('div');
    for (let index = 0; index < count; index++) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.index = String(index);
      groupItem(button, { role, selected: index === selectedIndex, label: `Item ${index}` });
      group.appendChild(button);
    }
    document.body.replaceChildren(group);
  }

  const items = (): HTMLElement[] => [...group.querySelectorAll<HTMLElement>('button')];

  it('gives the group one tab stop, on the selected item', () => {
    build(5, 2, 'radio');
    rovingGroup(group, { role: 'radiogroup', label: 'Paint colour' });

    expect(items().map((item) => item.tabIndex)).toEqual([-1, -1, 0, -1, -1]);
    expect(group.getAttribute('role')).toBe('radiogroup');
    expect(group.getAttribute('aria-label')).toBe('Paint colour');
  });

  it('falls back to the first item when nothing is selected', () => {
    build(3, -1);
    rovingGroup(group, { role: 'radiogroup', label: 'Paint colour' });

    expect(items()[0].tabIndex).toBe(0);
  });

  it('moves with the arrow keys and carries the tab stop with it', () => {
    build(4, 0);
    rovingGroup(group, { role: 'radiogroup', label: 'Paint colour' });
    items()[0].focus();

    press(items()[0], 'ArrowRight');

    expect(document.activeElement).toBe(items()[1]);
    expect(items()[0].tabIndex).toBe(-1);
    expect(items()[1].tabIndex).toBe(0);
  });

  /** A palette has no useful end, and a key that does nothing is a dead key. */
  it('wraps at both ends', () => {
    build(3, 0);
    rovingGroup(group, { role: 'radiogroup', label: 'Paint colour' });

    items()[0].focus();
    press(items()[0], 'ArrowLeft');
    expect(document.activeElement).toBe(items()[2]);

    press(items()[2], 'ArrowRight');
    expect(document.activeElement).toBe(items()[0]);
  });

  it('goes to the ends with Home and End', () => {
    build(6, 0);
    rovingGroup(group, { role: 'radiogroup', label: 'Paint colour' });
    items()[0].focus();

    press(items()[0], 'End');
    expect(document.activeElement).toBe(items()[5]);

    press(items()[5], 'Home');
    expect(document.activeElement).toBe(items()[0]);
  });

  /**
   * The ARIA practices' default for each pattern, and right here twice over:
   * moving through a palette *is* choosing a colour, and selecting on arrow
   * through the tab row would rebuild the whole centre column per keypress.
   */
  it('selects as it moves in a radio group', () => {
    build(3, 0);
    let clicked = -1;
    items().forEach((item, index) => item.addEventListener('click', () => (clicked = index)));
    rovingGroup(group, { role: 'radiogroup', label: 'Paint colour' });

    items()[0].focus();
    press(items()[0], 'ArrowRight');

    expect(clicked).toBe(1);
  });

  it('only moves in a tab list, leaving the choice to Enter or Space', () => {
    build(3, 0, 'tab');
    let clicked = -1;
    items().forEach((item, index) => item.addEventListener('click', () => (clicked = index)));
    rovingGroup(group, { role: 'tablist', label: 'Editor view', orientation: 'horizontal' });

    items()[0].focus();
    press(items()[0], 'ArrowRight');

    expect(document.activeElement).toBe(items()[1]);
    expect(clicked).toBe(-1);
  });

  it('ignores the vertical arrows in a horizontal group', () => {
    build(3, 0, 'tab');
    rovingGroup(group, { role: 'tablist', label: 'Editor view', orientation: 'horizontal' });
    items()[0].focus();

    expect(press(items()[0], 'ArrowDown').defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(items()[0]);
  });

  it('skips a disabled item rather than parking focus on it', () => {
    build(3, 0, 'tab');
    items()[1].setAttribute('disabled', '');
    rovingGroup(group, { role: 'tablist', label: 'Editor view', orientation: 'horizontal' });
    items()[0].focus();

    press(items()[0], 'ArrowRight');

    expect(document.activeElement).toBe(items()[2]);
  });
});

/**
 * The AGI cel grid: a thousand-odd buttons, one per pixel of the artwork.
 */
describe('rovingGrid', () => {
  let grid: HTMLElement;

  beforeEach(() => {
    grid = document.createElement('div');
    for (let index = 0; index < 12; index++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.setAttribute('role', 'gridcell');
      cell.dataset.index = String(index);
      grid.appendChild(cell);
    }
    document.body.replaceChildren(grid);
    rovingGrid(grid, { label: 'Cel 0 of loop 0, 4 by 3 pixels', columns: 4 });
  });

  const cells = (): HTMLElement[] => [...grid.querySelectorAll<HTMLElement>('[role="gridcell"]')];

  it('is one tab stop for the whole grid', () => {
    expect(cells().filter((cell) => cell.tabIndex === 0)).toHaveLength(1);
    expect(grid.getAttribute('role')).toBe('grid');
  });

  it('moves a row at a time with the vertical arrows', () => {
    cells()[0].focus();
    press(cells()[0], 'ArrowDown');
    expect(document.activeElement).toBe(cells()[4]);

    press(cells()[4], 'ArrowUp');
    expect(document.activeElement).toBe(cells()[0]);
  });

  /**
   * A grid does not wrap: running off the right of row one and appearing at the
   * left of row two is how you lose your place on a drawing.
   */
  it('stops at the edges rather than wrapping to the next row', () => {
    cells()[3].focus();
    press(cells()[3], 'ArrowRight');
    expect(document.activeElement).toBe(cells()[3]);

    cells()[0].focus();
    press(cells()[0], 'ArrowUp');
    expect(document.activeElement).toBe(cells()[0]);
  });

  it('goes to the ends of the current row with Home and End', () => {
    cells()[5].focus();
    press(cells()[5], 'End');
    expect(document.activeElement).toBe(cells()[7]);

    press(cells()[7], 'Home');
    expect(document.activeElement).toBe(cells()[4]);
  });
});

/**
 * The cursor the arrow keys move on a canvas.
 *
 * Drawing was pointer-only across all three canvases, which is 2.1.1 failed for
 * the whole of the editor's actual work.
 */
describe('KeyboardCursor', () => {
  const bounds = { width: 10, height: 6 };

  it('moves one cell per arrow, and eight with Shift', () => {
    const cursor = new KeyboardCursor();

    cursor.handle(new KeyboardEvent('keydown', { key: 'ArrowRight' }), bounds);
    expect([cursor.x, cursor.y]).toEqual([1, 0]);

    cursor.handle(new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true }), bounds);
    expect([cursor.x, cursor.y]).toEqual([9, 0]);
  });

  /** Clamped, not wrapped: the edges of a room are the edges of the room. */
  it('stops at the edges', () => {
    const cursor = new KeyboardCursor();

    cursor.handle(new KeyboardEvent('keydown', { key: 'ArrowLeft' }), bounds);
    expect([cursor.x, cursor.y]).toEqual([0, 0]);

    for (let step = 0; step < 20; step++) {
      cursor.handle(new KeyboardEvent('keydown', { key: 'ArrowDown' }), bounds);
    }
    expect(cursor.y).toBe(5);
  });

  it('goes to the edges with Home, End, Page Up and Page Down', () => {
    const cursor = new KeyboardCursor();

    cursor.handle(new KeyboardEvent('keydown', { key: 'End' }), bounds);
    expect(cursor.x).toBe(9);

    cursor.handle(new KeyboardEvent('keydown', { key: 'PageDown' }), bounds);
    expect(cursor.y).toBe(5);

    cursor.handle(new KeyboardEvent('keydown', { key: 'Home' }), bounds);
    cursor.handle(new KeyboardEvent('keydown', { key: 'PageUp' }), bounds);
    expect([cursor.x, cursor.y]).toEqual([0, 0]);
  });

  it('reports that a key was not a movement, so the canvas can use it', () => {
    const cursor = new KeyboardCursor();
    expect(cursor.handle(new KeyboardEvent('keydown', { key: 'Enter' }), bounds)).toBe(false);
    expect(cursor.handle(new KeyboardEvent('keydown', { key: 'p' }), bounds)).toBe(false);
  });

  it('re-clamps when the grid it is on shrinks under it', () => {
    const cursor = new KeyboardCursor();
    cursor.handle(new KeyboardEvent('keydown', { key: 'End' }), bounds);
    cursor.clamp({ width: 4, height: 4 });
    expect(cursor.x).toBe(3);
  });

  it('knows which keys mean apply and which mean erase', () => {
    expect(isActivation(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe(true);
    expect(isActivation(new KeyboardEvent('keydown', { key: ' ' }))).toBe(true);
    expect(isActivation(new KeyboardEvent('keydown', { key: 'a' }))).toBe(false);
    expect(isErase(new KeyboardEvent('keydown', { key: 'Delete' }))).toBe(true);
    expect(isErase(new KeyboardEvent('keydown', { key: 'Backspace' }))).toBe(true);
  });
});

/**
 * 1.4.1: a swatch is a square of colour and nothing else, so without a name the
 * colour is the only thing carrying its meaning.
 */
describe('describeColour', () => {
  it('says the index the format stores and the values the square shows', () => {
    expect(describeColour(4, [216, 166, 87])).toBe('Colour 4, red 216 green 166 blue 87');
  });

  it('survives a palette entry that is not there', () => {
    expect(describeColour(0, undefined)).toBe('Colour 0, red 0 green 0 blue 0');
  });
});
