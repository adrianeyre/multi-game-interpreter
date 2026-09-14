/**
 * A keyboard cursor for the editor's canvases.
 *
 * Every drawing surface in this editor was pointer-only: paint by dragging,
 * place an object by clicking, shape a walk box by dragging a rectangle. None
 * of it could be done from a keyboard at all, which is 2.1.1 failed outright —
 * and the drag-shaped half of it is 2.5.7 as well, because a walk box could not
 * be drawn with a single pointer either.
 *
 * So each canvas grows a cursor: a cell the arrow keys move and the canvas
 * draws, with Enter doing whatever a click would have done there. The cursor is
 * per-canvas state rather than global, because the three canvases are three
 * different grids and a shared position would jump between them.
 *
 * What the cursor is *for* differs — a pixel in a costume, a point in a room —
 * so this holds the position and the movement, and the canvases say what a
 * press means.
 */

/** How far a plain arrow moves, and how far a shifted one does. */
const STEP = 1;
const FAST_STEP = 8;

export interface CursorBounds {
  width: number;
  height: number;
}

/**
 * A position on a grid, moved by the arrow keys and clamped to the grid.
 *
 * Clamped rather than wrapped: a cursor that reappears at the far edge of a
 * costume when you hold Left is a cursor nobody can aim, and the edges of these
 * grids are meaningful — the left column of a room is the left of the room.
 */
export class KeyboardCursor {
  x = 0;
  y = 0;
  /** Whether the canvas has focus, which is when the cursor is drawn. */
  visible = false;

  /** Moves by a key, or returns false when the key was not a movement. */
  handle(event: KeyboardEvent, bounds: CursorBounds): boolean {
    const step = event.shiftKey ? FAST_STEP : STEP;
    let dx = 0;
    let dy = 0;

    switch (event.key) {
      case 'ArrowLeft':
        dx = -step;
        break;
      case 'ArrowRight':
        dx = step;
        break;
      case 'ArrowUp':
        dy = -step;
        break;
      case 'ArrowDown':
        dy = step;
        break;
      case 'Home':
        this.x = 0;
        this.clamp(bounds);
        return true;
      case 'End':
        this.x = bounds.width - 1;
        this.clamp(bounds);
        return true;
      case 'PageUp':
        this.y = 0;
        this.clamp(bounds);
        return true;
      case 'PageDown':
        this.y = bounds.height - 1;
        this.clamp(bounds);
        return true;
      default:
        return false;
    }

    this.x += dx;
    this.y += dy;
    this.clamp(bounds);
    return true;
  }

  clamp(bounds: CursorBounds): void {
    this.x = Math.max(0, Math.min(bounds.width - 1, Math.round(this.x)));
    this.y = Math.max(0, Math.min(bounds.height - 1, Math.round(this.y)));
  }
}

/** Whether a key means "do the thing here". */
export function isActivation(event: KeyboardEvent): boolean {
  return event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar';
}

/** Whether a key means "clear the thing here". */
export function isErase(event: KeyboardEvent): boolean {
  return event.key === 'Delete' || event.key === 'Backspace';
}

/**
 * Draws the cursor over a canvas that has focus.
 *
 * Two rectangles, black then white, one pixel apart: a single-colour cursor is
 * invisible on artwork that happens to be that colour, and pixel art is exactly
 * the content where that happens. Together they are 1.4.11's 3:1 against
 * anything underneath, because whatever is under them contrasts with one of the
 * two.
 */
export function drawCursor(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellWidth: number,
  cellHeight: number,
): void {
  context.save();
  context.lineWidth = 1;
  context.strokeStyle = '#000000';
  context.strokeRect(x * cellWidth - 0.5, y * cellHeight - 0.5, cellWidth + 1, cellHeight + 1);
  context.strokeStyle = '#ffffff';
  context.strokeRect(x * cellWidth + 0.5, y * cellHeight + 0.5, cellWidth - 1, cellHeight - 1);
  context.restore();
}

/**
 * Makes a canvas an operable, named control.
 *
 * `role="application"` because the arrow keys mean something here that they do
 * not mean in a document, and a screen reader in browse mode would otherwise
 * eat every one of them before the canvas saw it. The description is a real
 * element rather than an `aria-label` sentence, so the key map can be read at
 * leisure rather than announced in one breath with the name.
 */
export function describeCanvas(
  canvas: HTMLCanvasElement,
  options: { id: string; label: string; help: string },
): HTMLElement {
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'application');
  canvas.setAttribute('aria-label', options.label);
  canvas.setAttribute('aria-describedby', options.id);

  const help = document.createElement('p');
  help.id = options.id;
  help.className = 'visually-hidden';
  help.textContent = options.help;
  return help;
}
