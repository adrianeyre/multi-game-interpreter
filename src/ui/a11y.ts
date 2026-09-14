/**
 * The pieces every accessible surface in this project needs, in one place.
 *
 * Three dialogs, an editor overlay and a consent notice were each doing their
 * own version of "take focus, give it back, close on Escape" — and each was
 * doing a different subset of it. A modal that returns focus but lets Tab walk
 * into the page behind it is only visually modal: the toolbar underneath is
 * still reachable, still clickable by Enter, and on the player page the thing
 * underneath is a running game that reacts to keys.
 *
 * So the behaviour lives here once, and the surfaces declare that they want it.
 */

/**
 * Everything focusable inside a container, in document order.
 *
 * `disabled` and `[tabindex="-1"]` are excluded because they are not tab stops;
 * `hidden` subtrees are excluded by measuring, because a `hidden` ancestor is
 * the way every panel in this project puts itself away.
 */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  const candidates = container.querySelectorAll<HTMLElement>(
    [
      'a[href]',
      'area[href]',
      'button:not([disabled])',
      'input:not([disabled]):not([type="hidden"])',
      'select:not([disabled])',
      'textarea:not([disabled])',
      'details > summary:first-of-type',
      'iframe',
      'audio[controls]',
      'video[controls]',
      '[contenteditable]:not([contenteditable="false"])',
      '[tabindex]:not([tabindex^="-"])',
    ].join(','),
  );

  return [...candidates].filter(isVisible);
}

/**
 * Whether an element can actually be reached.
 *
 * Asked of the cascade rather than of the layout. `offsetParent` is null for a
 * perfectly visible `position: fixed` element, and every overlay here is fixed;
 * `getClientRects` is empty for anything the engine has not laid out, which is
 * everything in a test. Computed `display` and `visibility` are the properties
 * that actually decide, they are the ones the `hidden` attribute resolves to,
 * and they are true whether or not a box has been measured yet.
 */
function isVisible(element: HTMLElement): boolean {
  // An ancestor's state removes the descendant too, which is exactly how every
  // panel in this project puts itself away.
  if (element.closest('[hidden]')) return false;
  if (element.closest('[aria-hidden="true"]')) return false;
  if (element.closest('[inert]')) return false;

  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  if (!style) return true;
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** What a `trapFocus` hands back, so the caller can put the page right again. */
export interface FocusTrap {
  /** Stops trapping, un-hides the background and returns focus. */
  release(): void;
}

export interface TrapOptions {
  /**
   * Where focus should land when the trap closes.
   *
   * Defaults to whatever had it when the trap opened, which is nearly always
   * the button that raised the dialog — and is the only landing spot that does
   * not make a keyboard user walk the whole page again to try the next thing.
   */
  returnFocusTo?: HTMLElement | null;
  /** Called for Escape. The trap does not close itself; the surface decides. */
  onEscape?: () => void;
}

/**
 * The siblings a modal hides while it is open, and what they were before.
 *
 * `inert` is the property that does the whole job — it removes a subtree from
 * the tab order, from hit testing and from the accessibility tree at once — and
 * `aria-hidden` is set beside it for the assistive technology that has not
 * caught up. Both are restored exactly, because a surface that was already
 * hidden for its own reasons must stay that way when the dialog closes.
 */
interface Muted {
  element: HTMLElement;
  hadInert: boolean;
  ariaHidden: string | null;
}

/**
 * Hides everything that is not the dialog, at every level between it and the
 * body.
 *
 * Walking up rather than sweeping the body's children, because not every
 * overlay is a child of the body: the editor's play overlay is mounted inside
 * `#editor`, alongside the whole editor it covers. Muting only the body's
 * children would skip `#editor` — it contains the overlay — and leave the
 * toolbar, the sidebar and the canvases behind a "modal" dialog fully tabbable,
 * which is the exact failure this function exists to prevent.
 *
 * The attribute rather than the property: `inert` as a property exists only
 * where the browser implements it, while the attribute is what the CSS and the
 * DOM both read, is what an older engine can be polyfilled against, and is what
 * a test can see. Setting the attribute sets the property wherever it exists.
 */
function muteBackground(exempt: HTMLElement): Muted[] {
  const muted: Muted[] = [];

  for (let node: HTMLElement | null = exempt; node && node !== document.body;) {
    const parent: HTMLElement | null =
      node.parentElement instanceof HTMLElement ? node.parentElement : null;
    if (!parent) break;

    for (const sibling of [...parent.children]) {
      if (!(sibling instanceof HTMLElement) || sibling === node) continue;
      muted.push({
        element: sibling,
        hadInert: sibling.hasAttribute('inert'),
        ariaHidden: sibling.getAttribute('aria-hidden'),
      });
      sibling.setAttribute('inert', '');
      sibling.setAttribute('aria-hidden', 'true');
    }
    node = parent;
  }

  return muted;
}

function unmute(muted: Muted[]): void {
  for (const entry of muted) {
    // Restored exactly: a surface that was already hidden for its own reasons
    // must stay that way when the dialog above it closes.
    if (entry.hadInert) entry.element.setAttribute('inert', '');
    else entry.element.removeAttribute('inert');
    if (entry.ariaHidden === null) entry.element.removeAttribute('aria-hidden');
    else entry.element.setAttribute('aria-hidden', entry.ariaHidden);
  }
}

/**
 * Keeps Tab inside `container` until the trap is released.
 *
 * The cycle is computed on each Tab rather than captured on open: these dialogs
 * change shape while they are up — a README arrives, a field appears, a button
 * stops being hidden — and a list of stops taken at open time would send Tab to
 * an element that is no longer there.
 */
export function trapFocus(container: HTMLElement, options: TrapOptions = {}): FocusTrap {
  const previous =
    options.returnFocusTo ??
    (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const muted = muteBackground(container);

  function onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      // Stopped here so a game or an editor listening on the window does not
      // also act on the key that was meant to close this.
      event.stopPropagation();
      options.onEscape?.();
      return;
    }
    if (event.key !== 'Tab') return;

    const stops = focusableWithin(container);
    if (stops.length === 0) {
      // Nothing to move to, so Tab must not leave: a dialog with no controls is
      // still a dialog, and the page behind it is inert.
      event.preventDefault();
      return;
    }

    const first = stops[0];
    const last = stops[stops.length - 1];
    const active = document.activeElement;

    if (event.shiftKey && (active === first || !container.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !container.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  }

  // On the container in the capture phase: a keystroke inside a dialog reaches
  // it before anything the page has bound on the window.
  container.addEventListener('keydown', onKeyDown, true);

  /*
   * A dialog with nothing to focus still has to hold the keyboard.
   *
   * Every surface here focuses something of its own on open — a close button, a
   * first field — and this is the case where there is nothing to focus: a
   * notice still being filled in, a dialog whose only content is text. Without
   * it, focus stays on the body, the container never sees a keystroke, and both
   * Tab and Escape go to the page the trap just made inert.
   */
  if (focusableWithin(container).length === 0) {
    container.tabIndex = -1;
    container.focus();
  }

  return {
    release(): void {
      container.removeEventListener('keydown', onKeyDown, true);
      unmute(muted);
      previous?.focus();
    },
  };
}

/**
 * The page's one polite announcer.
 *
 * A shared region rather than one per component, because two live regions that
 * update together are read in an order nobody chose. Created on first use so a
 * page that never announces anything carries no extra node.
 *
 * Repeats are re-announced deliberately — "Saved" twice means it happened
 * twice — by clearing the region first, which is the only way a screen reader
 * treats identical text as a new message.
 */
let politeRegion: HTMLElement | null = null;
let assertiveRegion: HTMLElement | null = null;

function liveRegion(kind: 'polite' | 'assertive'): HTMLElement {
  const existing = kind === 'polite' ? politeRegion : assertiveRegion;
  if (existing?.isConnected) return existing;

  const region = document.createElement('div');
  region.className = 'visually-hidden';
  region.setAttribute('role', kind === 'polite' ? 'status' : 'alert');
  region.setAttribute('aria-live', kind);
  region.setAttribute('aria-atomic', 'true');
  document.body.appendChild(region);

  if (kind === 'polite') politeRegion = region;
  else assertiveRegion = region;
  return region;
}

/** Says something to a screen reader without putting it on the screen. */
export function announce(message: string, kind: 'polite' | 'assertive' = 'polite'): void {
  if (!message) return;
  const region = liveRegion(kind);
  region.textContent = '';
  // A frame's gap, so a repeat of the same sentence is seen as a change rather
  // than as the same text still sitting there.
  window.setTimeout(() => {
    region.textContent = message;
  }, 50);
}

/**
 * Drops the announcer, so a test can start from nothing.
 *
 * Exported for tests alone: nothing in the app tears the page down.
 */
export function resetAnnouncer(): void {
  politeRegion?.remove();
  assertiveRegion?.remove();
  politeRegion = null;
  assertiveRegion = null;
}

/**
 * A label for a colour, said in words.
 *
 * A swatch is a square of colour and nothing else, so colour is the only thing
 * carrying its meaning — which is exactly what 1.4.1 forbids. The index is what
 * the format actually stores and what every other part of the editor names it
 * by, and the RGB triple is what it looks like, so both are said.
 */
export function describeColour(index: number, rgb: readonly number[] | undefined): string {
  const [r, g, b] = rgb ?? [0, 0, 0];
  return `Colour ${index}, red ${r} green ${g} blue ${b}`;
}

/**
 * Whether the reader has asked their system for less movement.
 *
 * Guarded, because `matchMedia` is not everywhere: some embedded web views
 * omit it, and a dialog that throws while deciding how to animate itself is a
 * dialog that never opens. The safe answer to "should this move" when the
 * question cannot be asked is the one that moves.
 */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
}
