/**
 * The editor's chrome, as pieces two surfaces share.
 *
 * These were private to `main.ts` and shaped around SCUMM's four sidebar
 * sections. They are here because the AGOS surface needs exactly the same
 * affordances — a counted, collapsible, remembered section and a list row a
 * keyboard can reach — and a second copy of them is a second set of ARIA
 * decisions to keep in step. The accessibility notes that used to sit beside
 * each one moved with it: they are the reason the shapes are what they are, and
 * they belong with the code rather than with one of its two callers.
 *
 * Nothing here knows what a room, an item or a Subroutine is. A caller names
 * its own sections and supplies its own storage key, so the two surfaces
 * remember their sidebars independently — an author who collapsed Subroutines
 * in an AGOS game has not asked for Rooms to close in a SCUMM one.
 */

/**
 * Which sidebar sections are open, remembered between sessions.
 *
 * More than one at a time, deliberately. Picking a room and then editing its
 * objects is one continuous task, and a sidebar that collapsed the object list
 * every time a room was clicked would fight the work it exists to support.
 * Remembered because an author who closed a section wants it to stay closed.
 */
export class OpenSections<Name extends string> {
  private readonly openNames: Set<Name>;

  constructor(
    private readonly key: string,
    private readonly fallback: readonly Name[],
  ) {
    this.openNames = this.load();
  }

  has(name: Name): boolean {
    return this.openNames.has(name);
  }

  /** Opens a section that a background event has just put something into. */
  open(name: Name): void {
    if (this.openNames.has(name)) return;
    this.openNames.add(name);
    this.save();
  }

  toggle(name: Name): void {
    if (this.openNames.has(name)) this.openNames.delete(name);
    else this.openNames.add(name);
    this.save();
  }

  private load(): Set<Name> {
    try {
      const raw = window.localStorage.getItem(this.key);
      if (!raw) return new Set(this.fallback);
      const parsed = JSON.parse(raw) as Name[];
      return new Set(Array.isArray(parsed) ? parsed : this.fallback);
    } catch {
      return new Set(this.fallback);
    }
  }

  private save(): void {
    try {
      window.localStorage.setItem(this.key, JSON.stringify([...this.openNames]));
    } catch {
      // Storage being unavailable costs a preference, not any work.
    }
  }
}

export interface AccordionOptions<Name extends string> {
  name: Name;
  title: string;
  count: number;
  sections: OpenSections<Name>;
  /** Distinguishes two surfaces' section bodies, which share an id space. */
  idPrefix?: string;
  fill: (body: HTMLElement) => void;
  onToggle: () => void;
}

/**
 * One collapsible sidebar section.
 *
 * The count in the header is the point of collapsing: a closed section still
 * has to say how much is inside it, or closing one hides information rather
 * than just hiding detail.
 */
export function accordion<Name extends string>(options: AccordionOptions<Name>): HTMLElement {
  const container = document.createElement('section');
  container.className = 'accordion';

  const open = options.sections.has(options.name);
  const bodyId = `${options.idPrefix ?? 'accordion'}-${options.name}`;

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'accordion-head';
  head.setAttribute('aria-expanded', String(open));
  // Names the thing the button opens, so a screen reader can move to it — and
  // so "collapsed" is attached to something rather than floating.
  head.setAttribute('aria-controls', bodyId);

  const chevron = document.createElement('span');
  chevron.className = 'chevron';
  chevron.textContent = open ? '▾' : '▸';
  // The arrow says the same thing `aria-expanded` already says, and says it as
  // "black down-pointing small triangle" if it is left to be read.
  chevron.setAttribute('aria-hidden', 'true');

  const label = document.createElement('span');
  label.className = 'accordion-title';
  label.textContent = options.title;

  const badge = document.createElement('span');
  badge.className = 'accordion-count';
  badge.textContent = String(options.count);
  // "Rooms 4" reads as a room called four. The unit is said for a screen reader
  // and left out on screen, where the heading beside it already supplies it.
  badge.setAttribute('aria-label', `${options.count} ${options.count === 1 ? 'item' : 'items'}`);

  head.append(chevron, label, badge);
  head.addEventListener('click', () => {
    options.sections.toggle(options.name);
    options.onToggle();
  });

  /*
   * The button lives inside a heading.
   *
   * Jumping by heading is how a screen reader user navigates a page of this
   * shape, and the sidebar's sections had no headings at all — they were loose
   * buttons, so the whole of the project's contents was one undifferentiated
   * run. The heading is the section's name; the button inside it is the thing
   * that opens it (1.3.1, and the ARIA disclosure pattern).
   */
  const headingWrapper = document.createElement('h2');
  headingWrapper.className = 'accordion-heading';
  headingWrapper.appendChild(head);
  container.appendChild(headingWrapper);

  if (open) {
    const body = document.createElement('div');
    body.className = 'accordion-body';
    body.id = bodyId;
    options.fill(body);
    container.appendChild(body);
  }

  return container;
}

export interface ListRowOptions {
  label: string;
  selected: boolean;
  onSelect: () => void;
  /** Said instead of the label, when the label alone is not the whole fact. */
  description?: string;
  /** A short note shown after the label, such as a count or a warning. */
  note?: string;
}

/**
 * One row of a sidebar list, as something a keyboard can reach.
 *
 * These were `<li>` elements with a click handler: no role, no tab stop, no
 * way to activate them without a pointer, and nothing telling a screen reader
 * that one of them was the selected one. A button inside the item is the
 * smallest honest fix — it keeps the list a list, and the thing you press is a
 * thing the platform already knows how to press (2.1.1, 4.1.2).
 */
export function listRow(options: ListRowOptions): HTMLLIElement {
  const item = document.createElement('li');
  item.className = options.selected ? 'selected' : '';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'list-button';
  button.textContent = options.note ? `${options.label} — ${options.note}` : options.label;
  if (options.description) button.setAttribute('aria-label', options.description);
  // `aria-current` rather than `aria-selected`: these are not the options of a
  // listbox, they are a list of things one of which is open — which is the
  // distinction `aria-current` exists to draw.
  if (options.selected) button.setAttribute('aria-current', 'true');
  button.addEventListener('click', options.onSelect);

  item.appendChild(button);
  return item;
}

/** A `<ul class="list">`, which is what both sidebars put their rows in. */
export function listOf(rows: readonly HTMLLIElement[]): HTMLUListElement {
  const list = document.createElement('ul');
  list.className = 'list';
  for (const row of rows) list.appendChild(row);
  return list;
}
