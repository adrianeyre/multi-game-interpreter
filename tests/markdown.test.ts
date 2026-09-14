import { describe, expect, it } from 'vitest';

import {
  markdownSubtitle,
  markdownTitle,
  parseInline,
  parseMarkdown,
  plainText,
} from '../src/ui/markdown.js';

/**
 * Reading a README.
 *
 * A game's folder can carry a `README.md`, and the player shows it instead of a
 * directory name. There is no markdown dependency here and there is not going
 * to be one, so what matters is that the constructs a README is actually
 * written in come out as structure — and that the ones this does not read come
 * out as their own text rather than as half-applied markup.
 */

/** A document as `kind` plus flattened text, which is a readable expectation. */
function outline(text: string): string[] {
  return parseMarkdown(text).map((block) => {
    switch (block.kind) {
      case 'heading':
        return `h${block.level}: ${plainText(block.children)}`;
      case 'paragraph':
        return `p: ${plainText(block.children)}`;
      case 'code':
        return `code[${block.language}]: ${block.text}`;
      case 'quote':
        return `quote: ${block.children.map(summarise).join(' / ')}`;
      case 'rule':
        return 'rule';
      case 'list':
        return `${block.ordered ? 'ol' : 'ul'}: ${block.items
          .map((item) => item.map(summarise).join('+'))
          .join(' | ')}`;
      case 'table':
        return `table: ${block.head.map(plainText).join(',')} :: ${block.rows
          .map((row) => row.map(plainText).join(','))
          .join(' | ')}`;
    }
  });
}

function summarise(block: ReturnType<typeof parseMarkdown>[number]): string {
  return block.kind === 'paragraph' ? plainText(block.children) : block.kind;
}

describe('the shape of a document', () => {
  it('reads headings, paragraphs and the blank lines between them', () => {
    expect(
      outline('# Fate of Atlantis\n\nA SCUMM v5 game.\n\n## Files\n\nAn index and one data file.'),
    ).toEqual([
      'h1: Fate of Atlantis',
      'p: A SCUMM v5 game.',
      'h2: Files',
      'p: An index and one data file.',
    ]);
  });

  it('joins a wrapped paragraph into one line, because the wrap is in the source only', () => {
    expect(outline('one\ntwo\nthree')).toEqual(['p: one two three']);
  });

  it('takes two trailing spaces as the line break they were typed as', () => {
    const [paragraph] = parseMarkdown('one  \ntwo');
    expect(paragraph.kind === 'paragraph' && paragraph.children.map((child) => child.kind)).toEqual(
      ['text', 'break', 'text'],
    );
  });

  it('reads a heading underlined with = or -, which is how a title is often written', () => {
    expect(outline('Fate of Atlantis\n================\n\nText.')).toEqual([
      'h1: Fate of Atlantis',
      'p: Text.',
    ]);
    expect(outline('Files\n-----')).toEqual(['h2: Files']);
  });

  it('closes a heading that was written with trailing hashes', () => {
    expect(outline('## Files ##')).toEqual(['h2: Files']);
  });

  it('starts a new block at a heading with no blank line before it', () => {
    expect(outline('Text.\n## Files')).toEqual(['p: Text.', 'h2: Files']);
  });

  it('keeps a fenced block verbatim, markup and blank lines and all', () => {
    expect(outline('```\ngames/\n  indy/\n\n    ATLANTIS.000\n```')).toEqual([
      'code[]: games/\n  indy/\n\n    ATLANTIS.000',
    ]);
  });

  it('names the fence language without doing anything about it', () => {
    expect(outline('```bash\nnpm start\n```')).toEqual(['code[bash]: npm start']);
  });

  it('leaves an unclosed fence as a code block to the end, rather than as its source', () => {
    expect(outline('```\nnpm start')).toEqual(['code[]: npm start']);
  });

  it('reads a rule, and does not mistake one for a bullet', () => {
    expect(outline('above\n\n---\n\nbelow')).toEqual(['p: above', 'rule', 'p: below']);
    expect(outline('* * *')).toEqual(['rule']);
  });

  it('reads a quote across its lines, including one that forgot its marker', () => {
    expect(outline('> The game asked to quit.\n> Which is not a fault.')).toEqual([
      'quote: The game asked to quit. Which is not a fault.',
    ]);
  });
});

describe('lists', () => {
  it('reads a bulleted list, whichever marker it was written with', () => {
    expect(outline('- one\n* two\n+ three')).toEqual(['ul: one | two | three']);
  });

  it('reads a numbered list and keeps the number it started at', () => {
    const [list] = parseMarkdown('3. three\n4. four');
    expect(list.kind === 'list' && [list.ordered, list.start, list.items.length]).toEqual([
      true,
      3,
      2,
    ]);
  });

  it('carries a wrapped bullet as one item, not as an item and a paragraph', () => {
    expect(outline('- a bullet that runs\n  onto a second line\n- another')).toEqual([
      'ul: a bullet that runs onto a second line | another',
    ]);
  });

  it('nests a list written under an item', () => {
    const [list] = parseMarkdown('- outer\n  - inner\n  - inner two\n- second');
    expect(list.kind === 'list' && list.items.length).toBe(2);
    expect(list.kind === 'list' && list.items[0].map((block) => block.kind)).toEqual([
      'paragraph',
      'list',
    ]);
  });

  it('keeps a second paragraph under an item, which a blank line does not end', () => {
    expect(outline('- first\n\n  still first\n\n- second')).toEqual([
      'ul: first+still first | second',
    ]);
  });

  it('ends the list at the first line that is neither an item nor indented under one', () => {
    expect(outline('- one\n- two\n\nAfter.')).toEqual(['ul: one | two', 'p: After.']);
  });

  it('keeps a fenced block inside an item', () => {
    const [list] = parseMarkdown('- run it:\n\n  ```\n  npm start\n  ```\n');
    expect(list.kind === 'list' && list.items[0].map((block) => block.kind)).toEqual([
      'paragraph',
      'code',
    ]);
  });
});

describe('tables', () => {
  it('reads a pipe table with its header and its alignments', () => {
    const [table] = parseMarkdown(
      '| File | Size |\n| :--- | ---: |\n| ATLANTIS.000 | 12 kB |\n| ATLANTIS.001 | 9.4 MB |',
    );
    expect(table.kind === 'table' && table.align).toEqual(['left', 'right']);
    expect(outline('| File | Size |\n| --- | --- |\n| A | 1 |')).toEqual([
      'table: File,Size :: A,1',
    ]);
  });

  it('is a paragraph when the row under the header is not a delimiter', () => {
    expect(outline('| File | Size |\n| ATLANTIS.000 | 12 kB |')).toEqual([
      'p: | File | Size | | ATLANTIS.000 | 12 kB |',
    ]);
  });
});

describe('inline markup', () => {
  const kinds = (text: string) => parseInline(text).map((inline) => inline.kind);

  it('reads bold, italic and struck-through text', () => {
    expect(kinds('**bold** and *italic* and ~~gone~~')).toEqual([
      'strong',
      'text',
      'emphasis',
      'text',
      'strike',
    ]);
  });

  it('reads a code span, and does not read markup inside one', () => {
    const [code] = parseInline('`**not bold**`');
    expect(code).toEqual({ kind: 'code', text: '**not bold**' });
  });

  it('leaves an underscore inside a word alone, because filenames are full of them', () => {
    expect(plainText(parseInline('ROL_330.IMS and MT32_PCM.ROM'))).toBe(
      'ROL_330.IMS and MT32_PCM.ROM',
    );
    expect(kinds('ROL_330.IMS and MT32_PCM.ROM')).toEqual(['text']);
  });

  it('still reads _emphasis_ at a word boundary', () => {
    expect(kinds('_yes_')).toEqual(['emphasis']);
  });

  it('leaves a delimiter with nothing to close it as the character it is', () => {
    expect(plainText(parseInline('2 * 3 * 4'))).toBe('2 * 3 * 4');
    expect(plainText(parseInline('a lone ** pair'))).toBe('a lone ** pair');
  });

  it('reads a link, and an image, keeping the URL as written', () => {
    expect(parseInline('[the docs](https://example.org/a)')).toEqual([
      {
        kind: 'link',
        href: 'https://example.org/a',
        children: [{ kind: 'text', text: 'the docs' }],
      },
    ]);
    expect(parseInline('![box art](image.jpg)')).toEqual([
      { kind: 'image', src: 'image.jpg', alt: 'box art' },
    ]);
  });

  it('drops a link title, which is not part of the URL', () => {
    const [link] = parseInline('[a](https://example.org "Example")');
    expect(link.kind === 'link' && link.href).toBe('https://example.org');
  });

  it('reads a bare URL written in angle brackets', () => {
    const [link] = parseInline('<https://example.org>');
    expect(link.kind === 'link' && link.href).toBe('https://example.org');
  });

  it('honours a backslash escape rather than showing the backslash', () => {
    expect(plainText(parseInline('\\*not italic\\*'))).toBe('*not italic*');
  });

  it('reads emphasis inside a link label', () => {
    const [link] = parseInline('[**bold** link](https://example.org)');
    expect(link.kind === 'link' && link.children.map((child) => child.kind)).toEqual([
      'strong',
      'text',
    ]);
  });
});

describe('the title a game is listed under', () => {
  it('is the first heading, without its hashes', () => {
    expect(markdownTitle('# Indiana Jones and the Fate of Atlantis\n\nText.')).toBe(
      'Indiana Jones and the Fate of Atlantis',
    );
  });

  it('is the underlined first line where that is how the title was written', () => {
    expect(markdownTitle('Day of the Tentacle\n===================\n')).toBe('Day of the Tentacle');
  });

  it('is the first line of text when the README has no heading at all', () => {
    expect(markdownTitle('Fate of Atlantis, the talkie release.\n\nMore.')).toBe(
      'Fate of Atlantis, the talkie release.',
    );
  });

  it('flattens markup, because it ends up as the text of a button', () => {
    expect(markdownTitle('# The **talkie** release')).toBe('The talkie release');
  });

  it('is nothing when the file opens with something that is not a title', () => {
    // Reading past it would take a line out of the middle of the file and
    // present it as the game's name.
    expect(markdownTitle('```\nnot a title\n```\n\n# Late heading')).toBeNull();
  });

  it('is nothing for an empty file, so the folder name is kept', () => {
    expect(markdownTitle('')).toBeNull();
    expect(markdownTitle('\n\n   \n')).toBeNull();
  });
});

describe('the line under the title', () => {
  it('is the second line, which is where a README says what it runs on', () => {
    expect(markdownSubtitle('# Fate of Atlantis\n\nSCUMM v5\n\nText.')).toBe('SCUMM v5');
  });

  it('is read under an underlined title too', () => {
    expect(markdownSubtitle('Day of the Tentacle\n===\n\nSCUMM v6\n')).toBe('SCUMM v6');
  });

  it('flattens markup, because it ends up as a label', () => {
    expect(markdownSubtitle('# A\n\n**AGI v3**, interpreter 2.917\n')).toBe(
      'AGI v3, interpreter 2.917',
    );
  });

  /**
   * The guard that matters: most READMEs open straight into prose, and a
   * paragraph of it must not become a chip beside the game's name.
   */
  it('is nothing when the second block is a paragraph of prose', () => {
    expect(
      markdownSubtitle(
        '# A game\n\nLucasArts, 1993. A point-and-click adventure, and the sequel to a\ngame from 1987.\n',
      ),
    ).toBeNull();
  });

  it('is nothing when the second block is a picture, however short its alt text', () => {
    expect(markdownSubtitle('# A game\n\n![Box art](image.jpg)\n\nSCUMM v6\n')).toBeNull();
  });

  it('is nothing when the second block is not a paragraph at all', () => {
    expect(markdownSubtitle('# A game\n\n- SCUMM v6\n')).toBeNull();
    expect(markdownSubtitle('# A game\n\n```\nSCUMM v6\n```\n')).toBeNull();
    expect(markdownSubtitle('# A game\n\n## Files\n')).toBeNull();
  });

  it('is nothing for a title with nothing under it', () => {
    expect(markdownSubtitle('# A game\n')).toBeNull();
    expect(markdownSubtitle('')).toBeNull();
  });

  it('is nothing when the file does not open with a title', () => {
    expect(markdownSubtitle('```\nnot a title\n```\n\nSCUMM v6\n')).toBeNull();
  });
});
