import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseMarkdown } from '../src/ui/markdown.js';

/**
 * Markdown as elements.
 *
 * Two things are worth pinning down here, and one of them is a security
 * boundary. A README is a file in a folder next to game data whose provenance
 * is a download, so the renderer builds nodes and never assigns markup — and
 * the one string that still reaches an attribute is a link's or an image's URL,
 * which is checked against a list of schemes that are allowed rather than a
 * list of ones that are not.
 *
 * The other is that a README's own relative paths resolve against the game's
 * folder. `![Box art](image.jpg)` means the file beside the README; resolved
 * against the page it would name one at the site root, which is a broken image
 * on every README with a picture in it.
 *
 * Tests here run in Node, so the document is the stub below: enough of one to
 * record what the renderer built, and no more. That keeps this suite free of a
 * browser-environment dependency, which is the same trade `SaveStore` makes by
 * taking its storage as a parameter.
 */

interface StubNode {
  kind: 'element' | 'text';
  name: string;
  text: string;
  attributes: Record<string, string>;
  children: StubNode[];
}

/** Elements with no closing tag, so an expectation can be read as HTML. */
const VOID = new Set(['img', 'br', 'hr']);

function serialise(node: StubNode): string {
  if (node.kind === 'text') return node.text;
  const attributes = Object.entries(node.attributes)
    .filter(([, value]) => value !== '' && value !== 'undefined')
    // `className` is the property the renderer sets; `class` is what it means.
    .map(([name, value]) => ` ${name === 'className' ? 'class' : name}="${value}"`)
    .join('');
  const open = `<${node.name}${attributes}>`;
  if (VOID.has(node.name)) return open;
  return `${open}${node.children.map(serialise).join('') + node.text}</${node.name}>`;
}

/** The properties the renderer sets that are worth seeing in an expectation. */
const RECORDED = new Set([
  'href',
  'src',
  'alt',
  'className',
  'target',
  'rel',
  'loading',
  'referrerPolicy',
  'start',
]);

function element(name: string): StubNode {
  const node: StubNode = { kind: 'element', name, text: '', attributes: {}, children: [] };
  const style: Record<string, string> = {};

  return new Proxy(node, {
    get(target, property) {
      switch (property) {
        case 'style':
          return style;
        case 'dataset':
          // `el.dataset.language = x` is the attribute `data-language`, and an
          // expectation should say so rather than say `language`.
          return new Proxy(
            {},
            {
              set(_unused, key, value) {
                target.attributes[`data-${String(key)}`] = String(value);
                return true;
              },
            },
          );
        case 'append':
        case 'appendChild':
          return (...nodes: StubNode[]) => {
            target.children.push(...nodes);
            return nodes[0];
          };
        case 'setAttribute':
          return (attribute: string, value: string) => {
            target.attributes[attribute] = value;
          };
        default:
          return Reflect.get(target, property);
      }
    },
    set(target, property, value) {
      if (property === 'textContent') {
        target.text = String(value);
        return true;
      }
      if (typeof property === 'string' && RECORDED.has(property)) {
        target.attributes[property] = String(value);
        return true;
      }
      return Reflect.set(target, property, value);
    },
  }) as unknown as StubNode;
}

const globals = globalThis as unknown as { document?: unknown };
const previousDocument = globals.document;

beforeAll(() => {
  globals.document = {
    baseURI: 'https://example.org/player/',
    createElement: (name: string) => element(name),
    createElementNS: (_namespace: string, name: string) => element(name),
    createTextNode: (text: string): StubNode => ({
      kind: 'text',
      name: '#text',
      text,
      attributes: {},
      children: [],
    }),
    createDocumentFragment: () => element('#fragment'),
  };
});

afterAll(() => {
  globals.document = previousDocument;
});

/** The rendered markup of a document, as a string, for a readable expectation. */
async function render(source: string, base?: string): Promise<string> {
  const { renderMarkdown } = await import('../src/ui/markdownDom.js');
  const fragment = renderMarkdown(parseMarkdown(source), base ? { base } : {}) as unknown as {
    children: StubNode[];
  };
  return fragment.children.map(serialise).join('');
}

describe('blocks as elements', () => {
  it('offsets a README’s headings, which sit inside a dialog that has its own', async () => {
    // A README's `#` is its top level, not the page's, and an `h1` inside a
    // dialog titled with the same words reads as a mistake.
    expect(await render('# Title\n\n## Section')).toBe('<h3>Title</h3><h4>Section</h4>');
  });

  it('renders a paragraph with its inline markup', async () => {
    expect(await render('a **b** and `c`')).toBe('<p>a <strong>b</strong> and <code>c</code></p>');
  });

  it('renders a fenced block as pre/code, naming the language without acting on it', async () => {
    expect(await render('```bash\nnpm start\n```')).toBe(
      '<pre><code data-language="bash">npm start</code></pre>',
    );
  });

  it('renders a one-paragraph list item without the paragraph', async () => {
    expect(await render('- one\n- two')).toBe('<ul><li>one</li><li>two</li></ul>');
  });

  it('keeps the number an ordered list started at', async () => {
    expect(await render('3. three')).toBe('<ol start="3"><li>three</li></ol>');
  });

  it('gives a table its own scroller, so a wide one does not move the dialog', async () => {
    expect(await render('| A | B |\n| --- | ---: |\n| 1 | 2 |')).toBe(
      '<div class="markdown-table"><table><thead><tr><th>A</th><th>B</th></tr></thead>' +
        '<tbody><tr><td>1</td><td>2</td></tr></tbody></table></div>',
    );
  });
});

describe('the URLs a README brings with it', () => {
  it('resolves a relative image against the game’s own folder', async () => {
    expect(await render('![Box art](image.jpg)', 'games/indy/')).toBe(
      '<p><img src="https://example.org/player/games/indy/image.jpg" alt="Box art" ' +
        'loading="lazy" referrerPolicy="no-referrer"></p>',
    );
  });

  it('opens an external link in its own tab, without passing the referrer on', async () => {
    expect(await render('[docs](https://example.net/a)')).toBe(
      '<p><a href="https://example.net/a" target="_blank" rel="noreferrer noopener">docs</a></p>',
    );
  });

  /**
   * The boundary. A README is a file beside game data that arrived from
   * somewhere, and `javascript:` in a link is the oldest way to turn showing a
   * document into running one. The words stay; the link does not.
   */
  it('shows a javascript: link as text with nothing to click', async () => {
    expect(await render('[click me](javascript:alert(1))')).toBe('<p><span>click me</span></p>');
  });

  it('refuses a data: image, which can carry a script of its own', async () => {
    expect(await render('![x](data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=)')).toBe('<p>x</p>');
  });

  it('refuses a scheme dressed up with whitespace or case', async () => {
    expect(await render('[a](\tJavaScript:alert(1))')).toBe('<p><span>a</span></p>');
    expect(await render('[a](vbscript:msgbox)')).toBe('<p><span>a</span></p>');
  });

  it('keeps a fragment link, which points inside the document being shown', async () => {
    expect(await render('[to the files](#files)')).toBe(
      '<p><a href="#files" target="_blank" rel="noreferrer noopener">to the files</a></p>',
    );
  });
});
