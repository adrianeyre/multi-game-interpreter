/**
 * Markdown, as much of it as a README is written in.
 *
 * A game's folder can carry a `README.md` — what the game is, which release
 * these files are, what still does not work in it — and the player shows it
 * rather than a directory name. Showing it means rendering it, and rendering it
 * means a parser, because nothing here has dependencies and a README displayed
 * as its own source is worse than the folder name it replaced.
 *
 * **A subset, deliberately.** Headings, paragraphs, lists, quotes, fenced code,
 * rules, pipe tables, and inline emphasis, code, links and images. That is what
 * a README uses. Reference links, footnotes, raw HTML and indented code blocks
 * are not read, and a README that uses them shows their source text — visible
 * and harmless, rather than half-applied.
 *
 * **Text in, data out.** This module produces an AST and never touches the DOM,
 * which is what lets the Node side of the games folder use it to read a title
 * out of a file, and what lets it be tested without a browser. `markdownDom.ts`
 * is the half that builds elements — including the URL check, which belongs
 * where the attribute is set rather than where the text is read.
 */

/** A pipe table's column alignment, or null where the delimiter said nothing. */
export type MarkdownAlignment = 'left' | 'center' | 'right' | null;

/** A run of text, or something wrapped around one. */
export type MarkdownInline =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: MarkdownInline[] }
  | { kind: 'emphasis'; children: MarkdownInline[] }
  | { kind: 'strike'; children: MarkdownInline[] }
  | { kind: 'link'; href: string; children: MarkdownInline[] }
  | { kind: 'image'; src: string; alt: string }
  /** An authored line break — two trailing spaces or a trailing backslash. */
  | { kind: 'break' };

/** One block of a document. */
export type MarkdownBlock =
  | { kind: 'heading'; level: number; children: MarkdownInline[] }
  | { kind: 'paragraph'; children: MarkdownInline[] }
  | { kind: 'code'; language: string; text: string }
  | { kind: 'quote'; children: MarkdownBlock[] }
  | { kind: 'rule' }
  /** Items hold blocks, so a list can carry paragraphs and nested lists. */
  | { kind: 'list'; ordered: boolean; start: number; items: MarkdownBlock[][] }
  | {
      kind: 'table';
      align: MarkdownAlignment[];
      head: MarkdownInline[][];
      rows: MarkdownInline[][][];
    };

const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(\S*)/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*#*[ \t]*$/;
const RULE = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const BULLET = /^( {0,3})([-*+])([ \t]+)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
/** `| --- | :-: |` — the row that makes the one above it a table header. */
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

/** Longest input read, so a stray binary file cannot become a parse that hangs. */
const MAX_LENGTH = 512 * 1024;

/**
 * The document's title, as the first heading or the first line of text.
 *
 * Used for the name a game is listed under, which is why it does not insist on
 * a `#`: a README that opens with its title underlined, or with no marker at
 * all, still means that line as its title. Inline markup is flattened, because
 * this ends up as the text of a button.
 */
export function markdownTitle(text: string): string | null {
  for (const block of parseMarkdown(text)) {
    if (block.kind === 'heading' || block.kind === 'paragraph') {
      const line = plainText(block.children).split('\n')[0].trim();
      if (line !== '') return line;
    }
    // Anything else first — a rule, a code fence, a badge table — is not a
    // title, and reading on would take a line out of the middle of the file.
    return null;
  }
  return null;
}

/**
 * Longest second line taken as a subtitle.
 *
 * A guard rather than a format: the line is meant to be an interpreter's name —
 * "SCUMM v5", "AGI v3, interpreter 2.917" — and the thing on the other side of
 * this limit is a README that opens straight into prose, whose first paragraph
 * must not become a label on a button. Sixty characters is past any of the
 * former and short of any of the latter.
 */
const MAX_SUBTITLE = 60;

/**
 * The line under the title, when the file puts one there.
 *
 * The convention this exists for: a game's README says on its second line what
 * it needs to run — `SCUMM v5` — and the games list shows it beside the name,
 * so which interpreter a folder is for is visible before it is loaded.
 *
 * **It is what the README claims, never what was detected.** Nothing here
 * reads the game's index; a folder whose second line says SCUMM v5 and whose
 * files are AGI is listed as its author wrote it, and the loader is what has
 * the last word. So this is shown as a label and never acted on.
 *
 * Null unless the file really does open title-then-line: no heading first
 * means no title, and a second block that is long, or a list, or a picture, is
 * a document that simply does not follow the convention.
 */
export function markdownSubtitle(text: string): string | null {
  const [title, second] = parseMarkdown(text);
  if (title?.kind !== 'heading' && title?.kind !== 'paragraph') return null;
  if (second?.kind !== 'paragraph') return null;

  // A picture is not a subtitle even when its alt text is short enough to
  // pass for one, and a line break means there was more than one line.
  if (second.children.some((child) => child.kind === 'image' || child.kind === 'break')) {
    return null;
  }

  const line = plainText(second.children).trim();
  if (line === '' || line.includes('\n') || line.length > MAX_SUBTITLE) return null;
  return line;
}

/** Inline markup with the markup dropped, for somewhere that holds only text. */
export function plainText(inlines: MarkdownInline[]): string {
  return inlines
    .map((inline) => {
      switch (inline.kind) {
        case 'text':
        case 'code':
          return inline.text;
        case 'image':
          return inline.alt;
        case 'break':
          return ' ';
        default:
          return plainText(inline.children);
      }
    })
    .join('');
}

/** Parses a document. Never throws: unrecognised markup stays as its own text. */
export function parseMarkdown(text: string): MarkdownBlock[] {
  const body = text
    .slice(0, MAX_LENGTH)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n');
  return parseBlocks(body.split('\n'));
}

function parseBlocks(lines: string[]): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];

    if (line.trim() === '') {
      index++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const [, marker, language] = fence;
      const closer = marker[0];
      const body: string[] = [];
      index++;
      while (index < lines.length) {
        const candidate = lines[index];
        // A closing fence is the same character, at least as long, alone.
        if (new RegExp(`^ {0,3}${closer}{${marker.length},}[ \t]*$`).test(candidate)) {
          index++;
          break;
        }
        body.push(candidate);
        index++;
      }
      blocks.push({ kind: 'code', language, text: body.join('\n') });
      continue;
    }

    const atx = ATX.exec(line);
    if (atx) {
      blocks.push({
        kind: 'heading',
        level: atx[1].length,
        children: parseInline(atx[2] ?? ''),
      });
      index++;
      continue;
    }

    // Before the bullet test: `---` is a rule, and only an underline when
    // there is a paragraph above it, which the paragraph branch handles.
    if (RULE.test(line)) {
      blocks.push({ kind: 'rule' });
      index++;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const quoted = QUOTE.exec(lines[index]);
        if (quoted) {
          body.push(quoted[1]);
          index++;
          continue;
        }
        // A blank line ends the quote; an unmarked line continues it, which is
        // how quotes are written in practice.
        if (lines[index].trim() === '') break;
        if (BULLET.test(lines[index]) || ORDERED.test(lines[index]) || ATX.test(lines[index]))
          break;
        body.push(lines[index]);
        index++;
      }
      blocks.push({ kind: 'quote', children: parseBlocks(body) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const list = parseList(lines, index);
      blocks.push(list.block);
      index = list.next;
      continue;
    }

    const table = parseTable(lines, index);
    if (table) {
      blocks.push(table.block);
      index = table.next;
      continue;
    }

    // A paragraph: everything up to a blank line or the start of another block.
    const body: string[] = [];
    let underlined = false;

    while (index < lines.length) {
      const candidate = lines[index];
      if (candidate.trim() === '') break;

      // `===` or `---` under the text makes what came above it a heading.
      const setext = body.length > 0 ? SETEXT.exec(candidate) : null;
      if (setext) {
        blocks.push({
          kind: 'heading',
          level: setext[1].startsWith('=') ? 1 : 2,
          children: parseInline(body.join('\n')),
        });
        index++;
        underlined = true;
        break;
      }

      if (
        body.length > 0 &&
        (ATX.test(candidate) ||
          FENCE.test(candidate) ||
          RULE.test(candidate) ||
          QUOTE.test(candidate) ||
          BULLET.test(candidate) ||
          ORDERED.test(candidate))
      ) {
        break;
      }

      body.push(candidate);
      index++;
    }

    if (!underlined && body.length > 0) {
      blocks.push({ kind: 'paragraph', children: parseInline(body.join('\n')) });
    }
  }

  return blocks;
}

/**
 * A run of list items, and where it ended.
 *
 * Items are parsed as documents in their own right — indentation stripped and
 * handed back to `parseBlocks` — which is what makes a nested list, or a second
 * paragraph under a bullet, work without a rule of its own here.
 */
function parseList(lines: string[], from: number): { block: MarkdownBlock; next: number } {
  const first = BULLET.exec(lines[from]) ?? ORDERED.exec(lines[from])!;
  const ordered = ORDERED.test(lines[from]) && !BULLET.test(lines[from]);
  const start = ordered ? Number(first[2]) : 1;

  const items: MarkdownBlock[][] = [];
  let index = from;
  let current: string[] | null = null;
  /** Where an item's own text begins, so continuation lines can be recognised. */
  let contentIndent = 0;

  const closeItem = (): void => {
    if (current) items.push(parseBlocks(current));
    current = null;
  };

  while (index < lines.length) {
    const line = lines[index];
    const bullet = BULLET.exec(line);
    const numbered = ORDERED.exec(line);
    const marker = bullet ?? numbered;

    // A rule reads as a bullet (`* * *`), and is not one.
    if (marker && !RULE.test(line)) {
      const indent = marker[1].length;
      if (indent < contentIndent || current === null) {
        closeItem();
        const markerText = bullet ? bullet[2] + bullet[3] : numbered![3] + numbered![4];
        contentIndent = indent + markerText.length + (bullet ? 0 : numbered![2].length);
        current = [bullet ? bullet[4] : numbered![5]];
        index++;
        continue;
      }
      // More deeply indented: content of the item that is open.
      current.push(line.slice(Math.min(contentIndent, indent)));
      index++;
      continue;
    }

    if (line.trim() === '') {
      // A blank line only ends the list if what follows is not indented under
      // the item — which is how a two-paragraph bullet is written.
      const following = lines[index + 1];
      if (following === undefined) break;
      if (following.trim() !== '' && leadingSpaces(following) < contentIndent) {
        const nextIsItem =
          (BULLET.test(following) || ORDERED.test(following)) && !RULE.test(following);
        if (!nextIsItem) break;
      }
      current?.push('');
      index++;
      continue;
    }

    if (leadingSpaces(line) >= contentIndent) {
      current?.push(line.slice(contentIndent));
      index++;
      continue;
    }

    // An unindented line straight after an item's text belongs to it: a bullet
    // wrapped across two lines is written that way far more often than not.
    if (current && current.at(-1) !== '') {
      current.push(line.trim());
      index++;
      continue;
    }

    break;
  }

  closeItem();
  return { block: { kind: 'list', ordered, start, items }, next: index };
}

function leadingSpaces(line: string): number {
  return /^ */.exec(line)![0].length;
}

/** A pipe table, if this line and the next make one. */
function parseTable(lines: string[], from: number): { block: MarkdownBlock; next: number } | null {
  const header = lines[from];
  const delimiter = lines[from + 1];
  if (!header.includes('|') || delimiter === undefined) return null;
  if (!TABLE_DELIMITER.test(delimiter) || !delimiter.includes('-')) return null;

  const align: MarkdownAlignment[] = splitRow(delimiter).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return null;
  });

  const head = splitRow(header).map(parseInline);
  const rows: MarkdownInline[][][] = [];
  let index = from + 2;
  while (index < lines.length && lines[index].trim() !== '' && lines[index].includes('|')) {
    rows.push(splitRow(lines[index]).map(parseInline));
    index++;
  }

  return { block: { kind: 'table', align, head, rows }, next: index };
}

/** A table row's cells: split on unescaped pipes, outer ones dropped. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = '';
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && line[i + 1] === '|') {
      cell += '|';
      i++;
      continue;
    }
    if (line[i] === '|') {
      cells.push(cell);
      cell = '';
      continue;
    }
    cell += line[i];
  }
  cells.push(cell);
  if (cells[0].trim() === '') cells.shift();
  if (cells.length > 0 && cells.at(-1)!.trim() === '') cells.pop();
  return cells.map((text) => text.trim());
}

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!>~|]/;

/**
 * One block's text as inline markup.
 *
 * Left-to-right with a look for a closing delimiter at each opener, rather than
 * a pass per feature: emphasis nests, and a `*` with nothing to close it is an
 * asterisk. Code spans are found first at every position, so backticks win over
 * everything inside them — which is what `` `**not bold**` `` has to mean.
 */
export function parseInline(text: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let plain = '';

  const flush = (): void => {
    if (plain !== '') {
      out.push({ kind: 'text', text: plain });
      plain = '';
    }
  };

  let index = 0;
  while (index < text.length) {
    const char = text[index];

    if (char === '\\') {
      const next = text[index + 1];
      if (next === '\n') {
        flush();
        out.push({ kind: 'break' });
        index += 2;
        continue;
      }
      if (next !== undefined && ESCAPABLE.test(next)) {
        plain += next;
        index += 2;
        continue;
      }
    }

    if (char === '\n') {
      // Two trailing spaces are the authored line break; one or none is a soft
      // wrap in the source, which is a space when it is shown.
      const hard = / {2}$/.test(plain);
      plain = plain.replace(/[ \t]+$/, '');
      flush();
      out.push(hard ? { kind: 'break' } : { kind: 'text', text: ' ' });
      index++;
      // Leading space on the next line would double the one just added.
      while (text[index] === ' ' || text[index] === '\t') index++;
      continue;
    }

    if (char === '`') {
      const run = /^`+/.exec(text.slice(index))![0];
      const close = text.indexOf(run, index + run.length);
      if (close !== -1) {
        let code = text.slice(index + run.length, close).replace(/\n/g, ' ');
        if (code.startsWith(' ') && code.endsWith(' ') && code.trim() !== '')
          code = code.slice(1, -1);
        flush();
        out.push({ kind: 'code', text: code });
        index = close + run.length;
        continue;
      }
    }

    if (char === '!' && text[index + 1] === '[') {
      const image = parseLinkish(text, index + 1);
      if (image) {
        flush();
        out.push({ kind: 'image', src: image.href, alt: plainText(parseInline(image.label)) });
        index = image.next;
        continue;
      }
    }

    if (char === '[') {
      const link = parseLinkish(text, index);
      if (link) {
        flush();
        out.push({
          kind: 'link',
          href: link.href,
          // A link inside a link is not a thing, and its text is usually the
          // interesting part, so the label is parsed for everything else.
          children: parseInline(link.label).map((child) =>
            child.kind === 'link' ? { kind: 'text' as const, text: plainText([child]) } : child,
          ),
        });
        index = link.next;
        continue;
      }
    }

    // `<https://example.org>` — a URL written as its own link.
    if (char === '<') {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/.exec(text.slice(index));
      if (auto) {
        flush();
        out.push({ kind: 'link', href: auto[1], children: [{ kind: 'text', text: auto[1] }] });
        index += auto[0].length;
        continue;
      }
    }

    const emphasis = parseEmphasis(text, index);
    if (emphasis) {
      flush();
      out.push(emphasis.node);
      index = emphasis.next;
      continue;
    }

    plain += char;
    index++;
  }

  flush();
  return out;
}

/** `[label](href)`, with the brackets balanced, from the opening bracket. */
function parseLinkish(
  text: string,
  from: number,
): { label: string; href: string; next: number } | null {
  let depth = 0;
  let close = -1;
  for (let i = from; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || text[close + 1] !== '(') return null;

  let paren = 0;
  let end = -1;
  for (let i = close + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '(') paren++;
    else if (text[i] === ')') {
      paren--;
      if (paren === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const target = text.slice(close + 2, end).trim();
  // `(url "title")` — the title is dropped rather than shown as part of the URL.
  const href = (/^<(.*)>$/.exec(target)?.[1] ?? target.split(/\s+(?=["'(])/)[0]).trim();
  return { label: text.slice(from + 1, close), href, next: end + 1 };
}

/**
 * `**strong**`, `*em*`, `~~strike~~`, from a delimiter's first character.
 *
 * `_` is held to word boundaries, because filenames are full of underscores:
 * `MT32_CONTROL.ROM` and `ROL_330.IMS` in the same sentence would otherwise
 * italicise the words between them.
 */
function parseEmphasis(text: string, from: number): { node: MarkdownInline; next: number } | null {
  const char = text[from];
  if (char !== '*' && char !== '_' && char !== '~') return null;

  const run = new RegExp(`^\\${char}+`).exec(text.slice(from))![0];
  const width = char === '~' ? 2 : Math.min(run.length, 2);
  if (char === '~' && run.length < 2) return null;

  const marker = char.repeat(width);
  const before = text[from - 1] ?? ' ';
  if (char === '_' && /[\w]/.test(before)) return null;

  let index = from + marker.length;
  if (index >= text.length || /\s/.test(text[index])) return null;

  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text[index] === '`') {
      // Skip a code span whole: a delimiter inside one does not close anything.
      const run2 = /^`+/.exec(text.slice(index))![0];
      const close = text.indexOf(run2, index + run2.length);
      index = close === -1 ? index + run2.length : close + run2.length;
      continue;
    }
    if (text.startsWith(marker, index) && !/\s/.test(text[index - 1])) {
      const after = text[index + marker.length] ?? ' ';
      if (char === '_' && /[\w]/.test(after)) {
        index++;
        continue;
      }
      const inner = text.slice(from + marker.length, index);
      const children = parseInline(inner);
      const kind = char === '~' ? 'strike' : width === 2 ? 'strong' : 'emphasis';
      return { node: { kind, children }, next: index + marker.length };
    }
    index++;
  }

  return null;
}
