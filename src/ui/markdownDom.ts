/**
 * Markdown as elements, for showing a game's README.
 *
 * The half of the renderer that needs a document. `markdown.ts` reads the text
 * into an AST — pure, and shared with the Node side that reads a title out of a
 * file — and this walks that AST into nodes.
 *
 * **Built as nodes, never as markup.** Nothing here assigns `innerHTML`. A
 * README is a file on the machine running the dev server, dropped in beside a
 * game whose provenance is a download; the text of one is not something to hand
 * to an HTML parser, and building elements means the question does not arise.
 * The one place a string still reaches an attribute is a link's or an image's
 * URL, which is why `safeUrl` is here and is checked against a scheme list
 * rather than against a list of bad ones.
 */
import {
  parseMarkdown,
  type MarkdownAlignment,
  type MarkdownBlock,
  type MarkdownInline,
} from './markdown.js';

export interface MarkdownRenderOptions {
  /**
   * What relative links and images resolve against.
   *
   * A game's README sits in `games/<id>/`, so `![](cover.png)` in it means the
   * file beside it — and resolved against the page instead would mean one at
   * the site root, which is a broken image on every README that has a picture.
   */
  base?: string;
  /** Heading level the README's own top level maps to. Default 3. */
  headingOffset?: number;
}

/**
 * Schemes a link or an image may use.
 *
 * A list of what is allowed rather than of what is not: `javascript:` is the
 * one everybody names, and there are others — `data:` carrying an SVG is a
 * script, `blob:` too — so the check is that a URL is one of these and nothing
 * else. A relative URL has no scheme of its own and takes the page's, which is
 * already one of them.
 */
const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * A URL fit to put in an attribute, or null when it is not.
 *
 * Resolved rather than merely inspected, because whether `//evil.example` or
 * `\tjavascript:alert(1)` is safe is not a question about the text.
 */
export function safeUrl(raw: string, base?: string): string | null {
  const text = raw.trim();
  if (text === '') return null;
  // A fragment is a link within the page being shown, and has no scheme to check.
  if (text.startsWith('#')) return text;

  try {
    const against = new URL(base ?? '.', document.baseURI);
    const url = new URL(text, against);
    return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

/** A document's blocks as nodes, ready to append. */
export function renderMarkdown(
  source: string | MarkdownBlock[],
  options: MarkdownRenderOptions = {},
): DocumentFragment {
  const blocks = typeof source === 'string' ? parseMarkdown(source) : source;
  const fragment = document.createDocumentFragment();
  for (const block of blocks) fragment.appendChild(renderBlock(block, options));
  return fragment;
}

function renderBlock(block: MarkdownBlock, options: MarkdownRenderOptions): Node {
  switch (block.kind) {
    case 'heading': {
      // Offset, because these headings sit inside a dialog that has its own:
      // a README's `#` is not the top level of the page showing it.
      const level = Math.min(6, block.level + (options.headingOffset ?? 3) - 1);
      const heading = document.createElement(`h${level}`);
      heading.append(...renderInlines(block.children, options));
      return heading;
    }

    case 'paragraph': {
      const paragraph = document.createElement('p');
      paragraph.append(...renderInlines(block.children, options));
      return paragraph;
    }

    case 'code': {
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      // Named but not acted on: there is no highlighter here, and a stylesheet
      // or a later one can find the language without the text being re-read.
      if (block.language) code.dataset.language = block.language;
      code.textContent = block.text;
      pre.appendChild(code);
      return pre;
    }

    case 'quote': {
      const quote = document.createElement('blockquote');
      for (const child of block.children) quote.appendChild(renderBlock(child, options));
      return quote;
    }

    case 'rule':
      return document.createElement('hr');

    case 'list': {
      // Built in two branches rather than one with a cast: `start` is an
      // ordered list's property and does not exist on the other.
      let list: HTMLElement;
      if (block.ordered) {
        const ordered = document.createElement('ol');
        if (block.start !== 1) ordered.start = block.start;
        list = ordered;
      } else {
        list = document.createElement('ul');
      }
      for (const item of block.items) {
        const element = document.createElement('li');
        // A one-paragraph item goes in without the paragraph, so a plain list
        // is not spaced as though every bullet were a section.
        if (item.length === 1 && item[0].kind === 'paragraph') {
          element.append(...renderInlines(item[0].children, options));
        } else {
          for (const child of item) element.appendChild(renderBlock(child, options));
        }
        list.appendChild(element);
      }
      return list;
    }

    case 'table': {
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      block.head.forEach((cell, column) => {
        const th = document.createElement('th');
        applyAlignment(th, block.align[column]);
        th.append(...renderInlines(cell, options));
        headRow.appendChild(th);
      });
      head.appendChild(headRow);

      const body = document.createElement('tbody');
      for (const row of block.rows) {
        const tr = document.createElement('tr');
        row.forEach((cell, column) => {
          const td = document.createElement('td');
          applyAlignment(td, block.align[column]);
          td.append(...renderInlines(cell, options));
          tr.appendChild(td);
        });
        body.appendChild(tr);
      }

      table.append(head, body);
      // Its own scroller: a table wider than the dialog must not make the
      // whole dialog scroll sideways.
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-table';
      wrapper.appendChild(table);
      return wrapper;
    }
  }
}

function applyAlignment(cell: HTMLElement, align: MarkdownAlignment): void {
  if (align) cell.style.textAlign = align;
}

function renderInlines(inlines: MarkdownInline[], options: MarkdownRenderOptions): Node[] {
  return inlines.map((inline) => renderInline(inline, options));
}

function renderInline(inline: MarkdownInline, options: MarkdownRenderOptions): Node {
  switch (inline.kind) {
    case 'text':
      return document.createTextNode(inline.text);

    case 'break':
      return document.createElement('br');

    case 'code': {
      const code = document.createElement('code');
      code.textContent = inline.text;
      return code;
    }

    case 'strong': {
      const strong = document.createElement('strong');
      strong.append(...renderInlines(inline.children, options));
      return strong;
    }

    case 'emphasis': {
      const em = document.createElement('em');
      em.append(...renderInlines(inline.children, options));
      return em;
    }

    case 'strike': {
      const strike = document.createElement('s');
      strike.append(...renderInlines(inline.children, options));
      return strike;
    }

    case 'link': {
      const href = safeUrl(inline.href, options.base);
      // A link whose URL did not pass is shown as its text: the words the
      // author wrote, with nothing to click. Dropping it would take the
      // sentence with it.
      if (href === null) {
        const span = document.createElement('span');
        span.append(...renderInlines(inline.children, options));
        return span;
      }
      const link = document.createElement('a');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noreferrer noopener';
      link.append(...renderInlines(inline.children, options));
      return link;
    }

    case 'image': {
      const src = safeUrl(inline.src, options.base);
      if (src === null) return document.createTextNode(inline.alt);
      const image = document.createElement('img');
      image.src = src;
      image.alt = inline.alt;
      // Off the main thread of loading the dialog: a README's screenshots are
      // not what the reader is waiting for.
      image.loading = 'lazy';
      // A README hotlinking a picture should not also announce where it was
      // being read from.
      image.referrerPolicy = 'no-referrer';
      return image;
    }
  }
}
