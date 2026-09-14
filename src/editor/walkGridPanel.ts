/**
 * A walk grid as a table of bars and nodes, editable from the keyboard alone.
 *
 * A *widget* shared between the two Broken Sword surfaces, which is what ADR
 * 0036 allows — "a widget or a codec may cross; a record may not". Nothing in
 * this file knows which family it is showing: it is handed segments and points
 * and two callbacks, and `Sword1Editor` and `Sword2Editor` each find those in
 * their own document.
 *
 * It exists beside the canvas rather than instead of it. The canvas is where an
 * author lines a bar up against the scenery; this is where they type an exact
 * coordinate, and it is what an author with no pointer — or no 2D context —
 * has. `docs/accessibility.md` treats a drawing tool with no typed equivalent
 * as a failure of 2.1.1, and this is that equivalent.
 *
 * Nodes have no delete and the panel says why rather than hiding the absence:
 * both routers address a node by its index, so removing one renumbers every
 * node after it and changes routes nobody edited.
 */

import { operandField } from './operandField.js';

/**
 * One number, named for a screen reader as well as for the eye.
 *
 * The visible label is `x1`, which is what the format calls it and all there is
 * room for in a row of four. On its own that is four controls called `x1` on a
 * screen with fifty bars, so the accessible name carries the row's name too —
 * "Bar 7 x1" — and starts with the visible text, which is what 2.5.3 asks for.
 */
function numberField(options: {
  label: string;
  name: string;
  value: number;
  id: string;
  onChange: (value: number) => void;
}): HTMLElement {
  const field = operandField({
    label: options.label,
    value: options.value,
    id: options.id,
    onChange: options.onChange,
  });
  const control = field.querySelector('input, select');
  control?.setAttribute('aria-label', options.name);
  if (control) control.id = options.id;
  return field;
}

/** One bar, by its two endpoints — the four numbers the project carries. */
export interface WalkPanelBar {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export interface WalkPanelNode {
  readonly x: number;
  readonly y: number;
}

export interface WalkGridPanelOptions {
  /** Unique on the page: every control's id is built from it. */
  readonly id: string;
  /** What the grid is called, in the game's own terms. */
  readonly name: string;
  /** A sentence about where it is used, or null where nothing reaches it. */
  readonly where: string | null;
  readonly bars: readonly WalkPanelBar[];
  readonly nodes: readonly WalkPanelNode[];
  /** Moves one endpoint of one bar. `end` 0 is the first, 1 the second. */
  readonly moveBar: (index: number, end: 0 | 1, x: number, y: number) => void;
  readonly deleteBar: (index: number) => void;
  readonly moveNode: (index: number, x: number, y: number) => void;
}

/** Builds the panel into a container of the caller's choosing. */
export function walkGridPanel(into: HTMLElement, options: WalkGridPanelOptions): void {
  const heading = document.createElement('h3');
  heading.textContent = options.name;
  into.appendChild(heading);

  const summary = document.createElement('p');
  summary.className = 'sword-note';
  summary.textContent =
    `${options.bars.length} bars a walking character may not cross, and ${options.nodes.length} ` +
    `nodes the router may turn at. ` +
    (options.where ?? 'Nothing in this project names the screen it is used on.');
  into.appendChild(summary);

  const barsHeading = document.createElement('h4');
  barsHeading.textContent = 'Bars';
  into.appendChild(barsHeading);

  if (options.bars.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'sword-note';
    empty.textContent = 'This grid has no bars, so nothing on its screen blocks a walk.';
    into.appendChild(empty);
  }

  options.bars.forEach((bar, index) => {
    const row = document.createElement('div');
    row.className = 'sword-call-fields';

    const label = document.createElement('h5');
    label.textContent = `Bar ${index}`;
    row.appendChild(label);

    // Four fields and not eleven. The seven the resource also stores — the
    // bounding box, the deltas and the line constant — are derived when the
    // grid is written, so there is nothing here that could be left describing
    // where the bar used to be (`swordWalkGrid.ts`).
    for (const field of [
      { label: 'x1', value: bar.x1, end: 0 as const, axis: 'x' as const },
      { label: 'y1', value: bar.y1, end: 0 as const, axis: 'y' as const },
      { label: 'x2', value: bar.x2, end: 1 as const, axis: 'x' as const },
      { label: 'y2', value: bar.y2, end: 1 as const, axis: 'y' as const },
    ]) {
      row.appendChild(
        numberField({
          label: field.label,
          name: `Bar ${index} ${field.label}`,
          value: field.value,
          id: `${options.id}-bar-${index}-${field.label}`,
          onChange: (value) => {
            const at = field.end === 0 ? { x: bar.x1, y: bar.y1 } : { x: bar.x2, y: bar.y2 };
            options.moveBar(
              index,
              field.end,
              field.axis === 'x' ? value : at.x,
              field.axis === 'y' ? value : at.y,
            );
          },
        }),
      );
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'sword-resource';
    remove.textContent = `Delete bar ${index}`;
    remove.addEventListener('click', () => options.deleteBar(index));
    row.appendChild(remove);

    into.appendChild(row);
  });

  const nodesHeading = document.createElement('h4');
  nodesHeading.textContent = 'Nodes';
  into.appendChild(nodesHeading);

  const nodeNote = document.createElement('p');
  nodeNote.className = 'sword-note';
  nodeNote.textContent =
    'A node can be moved and not removed: both routers address a node by its index, so deleting ' +
    'one would renumber every node after it and change routes nobody edited.';
  into.appendChild(nodeNote);

  options.nodes.forEach((node, index) => {
    const row = document.createElement('div');
    row.className = 'sword-call-fields';

    const label = document.createElement('h5');
    label.textContent = `Node ${index}`;
    row.appendChild(label);

    row.appendChild(
      numberField({
        label: 'x',
        name: `Node ${index} x`,
        value: node.x,
        id: `${options.id}-node-${index}-x`,
        onChange: (value) => options.moveNode(index, value, node.y),
      }),
    );
    row.appendChild(
      numberField({
        label: 'y',
        name: `Node ${index} y`,
        value: node.y,
        id: `${options.id}-node-${index}-y`,
        onChange: (value) => options.moveNode(index, node.x, value),
      }),
    );

    into.appendChild(row);
  });
}
