/**
 * A document held over the page, opened from a link in the credit bar.
 *
 * The privacy policy and the terms are the same shape as the accessibility
 * statement and the cookie notice beside them: a heading, a date, a few
 * sections of prose, and a cross. They reuse that shell's classes — same
 * overlay, same panel, same focus trap — so four links in one footer open four
 * of the same thing, and the shell is written once here rather than copied into
 * each document that needs it.
 *
 * Content is data rather than markup, so a document is its words and nothing
 * else, and a new section is one entry rather than a block of element calls.
 */

import { prefersReducedMotion, trapFocus, type FocusTrap } from './a11y.js';

/** A run of text, or a link out of the page. */
export type Inline = string | { text: string; href: string };

/** A paragraph, or a list of titled points. */
export type Block = { kind: 'paragraph'; content: Inline[] } | { kind: 'list'; items: Point[] };

export interface Point {
  title: string;
  detail: string;
}

export interface Section {
  heading: string;
  blocks: Block[];
}

export interface FooterDialog {
  /** Prefixes every id the dialog owns: `<id>-overlay`, `<id>-title`, `<id>-intro`. */
  id: string;
  title: string;
  /** "Last updated: …", shown first so a stale document is visible as one. */
  dated: string;
  /** The first paragraph, and the dialog's accessible description. */
  intro: string;
  sections: Section[];
  /** The footer link's visible word. */
  linkText: string;
  /** Its accessible name, which must begin with `linkText` (2.5.3). */
  linkLabel: string;
}

/** Shorthand for the common case: a paragraph of plain text. */
export function paragraph(...content: Inline[]): Block {
  return { kind: 'paragraph', content };
}

export function list(items: Point[]): Block {
  return { kind: 'list', items };
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

/** A cross, inline so the dialog needs no network request to render. */
function closeMark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', 'M18 6 6 18M6 6l12 12');
  svg.appendChild(path);
  return svg;
}

function inline(parent: HTMLElement, content: Inline[]): void {
  for (const run of content) {
    if (typeof run === 'string') {
      parent.append(run);
      continue;
    }
    const link = element('a', undefined, run.text);
    link.href = run.href;
    // A new tab, like every other link out of this application: a game that
    // is mid-load should not be thrown away by a click on a policy.
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    parent.append(link);
  }
}

function block(parent: HTMLElement, content: Block): void {
  if (content.kind === 'paragraph') {
    const node = element('p');
    inline(node, content.content);
    parent.appendChild(node);
    return;
  }
  const node = element('ul', 'a11y-list');
  for (const item of content.items) {
    const entry = element('li');
    entry.append(element('strong', undefined, item.title), ` — ${item.detail}`);
    node.appendChild(entry);
  }
  parent.appendChild(node);
}

function buildDialog(spec: FooterDialog): { overlay: HTMLElement; close: HTMLButtonElement } {
  const overlay = element('div', 'consent-overlay');
  overlay.id = `${spec.id}-overlay`;
  overlay.hidden = true;

  const dialog = element('div', 'consent-dialog');
  dialog.setAttribute('role', 'dialog');
  dialog.setAttribute('aria-modal', 'true');
  dialog.setAttribute('aria-labelledby', `${spec.id}-title`);
  dialog.setAttribute('aria-describedby', `${spec.id}-intro`);

  const head = element('div', 'consent-head');
  const title = element('h2', undefined, spec.title);
  title.id = `${spec.id}-title`;
  const close = element('button', 'consent-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close');
  close.appendChild(closeMark());
  head.append(title, close);

  const scroll = element('div', 'consent-scroll');
  scroll.appendChild(element('p', 'consent-updated', spec.dated));

  const intro = element('p', undefined, spec.intro);
  intro.id = `${spec.id}-intro`;
  scroll.appendChild(intro);

  for (const section of spec.sections) {
    scroll.appendChild(element('h3', undefined, section.heading));
    for (const content of section.blocks) block(scroll, content);
  }

  dialog.append(head, scroll);
  overlay.appendChild(dialog);
  return { overlay, close };
}

/**
 * Adds the footer link and wires the dialog behind it.
 *
 * `anchor` is the credit bar on either page. Without one the dialog is still
 * built, so a test can reach it, but nothing on the page opens it.
 */
export function mountFooterDialog(spec: FooterDialog, anchor?: HTMLElement | null): void {
  const reducedMotion = prefersReducedMotion();
  const { overlay, close } = buildDialog(spec);
  document.body.append(overlay);

  let trap: FocusTrap | null = null;

  function open(): void {
    overlay.hidden = false;
    // Forces a reflow, so the transition runs from the closed state rather than
    // the dialog appearing already in place.
    void overlay.offsetWidth;
    overlay.classList.add('is-open');
    trap = trapFocus(overlay, { onEscape: closeDialog });
    close.focus();
  }

  function closeDialog(): void {
    if (overlay.hidden) return;
    overlay.classList.remove('is-open');
    const done = (): void => {
      overlay.hidden = true;
      overlay.removeEventListener('transitionend', done);
    };
    if (reducedMotion) done();
    else {
      overlay.addEventListener('transitionend', done);
      // A transition that never fires — a backgrounded tab, an interrupted
      // animation — would otherwise leave the dialog up for good.
      setTimeout(done, 350);
    }
    trap?.release();
    trap = null;
  }

  close.addEventListener('click', closeDialog);
  overlay.addEventListener('click', (event) => {
    // Only the backdrop; a click inside the dialog bubbles to here too.
    if (event.target === overlay) closeDialog();
  });

  if (!anchor) return;

  const link = element('button', 'consent-link', spec.linkText);
  link.type = 'button';
  link.setAttribute('aria-haspopup', 'dialog');
  link.setAttribute('aria-label', spec.linkLabel);
  link.addEventListener('click', open);
  anchor.appendChild(link);
}
