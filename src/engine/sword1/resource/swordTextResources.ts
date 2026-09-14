/**
 * Broken Sword's subtitles as they sit in `TEXT.CLU`.
 *
 * One resource per section per language, and the layout is the simplest in the
 * game:
 *
 * ```text
 * uint32   lineCount
 * uint32[] lineOffset      lineCount of them, from the payload's start
 * …        NUL-terminated strings
 * ```
 *
 * A zero offset means "this line does not exist in this language", which is a
 * real and common case — a release localised for six languages still ships a
 * seventh group in some builds, empty. So `readSwordTextResource` answers an
 * empty string for such a line rather than throwing, and `lockText` falls back
 * to English the way the original does.
 *
 * ## Encoding
 *
 * Latin-1, except the Czech release, which is Windows-1250, and the Russian
 * fan translations, which are Windows-1251. The decoder is a parameter because
 * getting it wrong is not a crash — it is accented characters silently turning
 * into the wrong accented characters, which is the shape of bug that survives
 * review.
 */

import { encodeSingleByte } from '../../resource/singleByteText.js';
import { SWORD1_ITM_ID, SWORD1_LANGUAGES, type Sword1Language } from './swordDefs.js';
import { SWORD1_SECTION_TEXT } from './swordSections.js';
import type { SwordResources } from './SwordResources.js';

/** The language index a name maps to, as the game's own table orders them. */
export function sword1LanguageIndex(language: Sword1Language): number {
  return SWORD1_LANGUAGES.indexOf(language);
}

/** One text resource, read into strings. */
export interface SwordTextResource {
  readonly resource: number;
  readonly lines: readonly string[];
}

/**
 * Reads a text resource's lines.
 *
 * `decoder` defaults to Latin-1. A line whose offset is zero comes back as an
 * empty string, which keeps the array's indexes lined up with the line numbers
 * the scripts use — dropping such lines instead would shift every line after
 * the first hole.
 */
export function readSwordTextResource(
  payload: Uint8Array,
  bigEndian = false,
  encoding = 'latin1',
): readonly string[] {
  if (payload.length < 4) return [];
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const count = view.getUint32(0, !bigEndian);
  if (count === 0 || 4 + count * 4 > payload.length) return [];

  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(encoding);
  } catch {
    decoder = new TextDecoder('latin1');
  }

  const lines: string[] = [];
  for (let line = 0; line < count; line++) {
    const offset = view.getUint32(4 + line * 4, !bigEndian);
    if (offset === 0 || offset >= payload.length) {
      lines.push('');
      continue;
    }
    let end = offset;
    while (end < payload.length && payload[end] !== 0) end++;
    lines.push(decoder.decode(payload.subarray(offset, end)));
  }
  return lines;
}

/**
 * Rebuilds a text resource from strings, byte-identically where unchanged.
 *
 * The offset table is rebuilt in line order with the strings packed after it,
 * which is how the shipped resources are laid out — so a resource read and
 * written back with no edit produces the same bytes. An empty line is written
 * as a zero offset rather than as an empty string, which is what the original
 * holes are.
 *
 * `encoding` must be the one the resource was read with; the two together are
 * a round trip, and apart they are a silent mistranslation. `encodeSingleByte`
 * builds the reverse map by asking the decoder, which matters here more than it
 * looks: `TextDecoder('latin1')` is a label for windows-1252, so a byte-wise
 * writer turned the shipped bytes 0x83 and 0x85 into '?' and `TEXT.CLU` came
 * back from an edit-free round trip differing in 488 bytes.
 */
export function writeSwordTextResource(lines: readonly string[], encoding = 'latin1'): Uint8Array {
  const bodies = lines.map((line) => {
    if (line === '') return null;
    const bytes = new Uint8Array(line.length + 1);
    bytes.set(encodeSingleByte(line, encoding), 0);
    bytes[line.length] = 0;
    return bytes;
  });

  const headerBytes = 4 + lines.length * 4;
  const bodyBytes = bodies.reduce((total, body) => total + (body?.length ?? 0), 0);
  const out = new Uint8Array(headerBytes + bodyBytes);
  const view = new DataView(out.buffer);
  view.setUint32(0, lines.length, true);

  let at = headerBytes;
  bodies.forEach((body, line) => {
    if (!body) {
      view.setUint32(4 + line * 4, 0, true);
      return;
    }
    view.setUint32(4 + line * 4, at, true);
    out.set(body, at);
    at += body.length;
  });
  return out;
}

/**
 * The text manager: which resource a text id lives in, and its line.
 *
 * A text id is `section * 0x10000 + line`, so the section selects the resource
 * through the generated table and the low sixteen bits select the line.
 */
export class SwordTexts {
  private readonly cache = new Map<number, readonly string[]>();

  constructor(
    private readonly resources: SwordResources,
    private language: Sword1Language = 'english',
    private readonly encoding = 'latin1',
  ) {}

  /** Switches language. A release ships the ones it was localised for. */
  setLanguage(language: Sword1Language): void {
    this.language = language;
  }

  get currentLanguage(): Sword1Language {
    return this.language;
  }

  /** The resource id for a section in a language, or 0 when there is none. */
  resourceFor(section: number, language = this.language): number {
    return SWORD1_SECTION_TEXT[section]?.[sword1LanguageIndex(language)] ?? 0;
  }

  /**
   * One line, or null.
   *
   * Falls back to English when the chosen language has no such line, which is
   * the original's behaviour and is why a partially-localised release reads
   * sensibly rather than going silent.
   */
  line(textId: number): string | null {
    const section = Math.floor(textId / 0x10000);
    const index = textId & SWORD1_ITM_ID;
    const own = this.linesFor(section, this.language);
    const line = own?.[index];
    if (line !== undefined && line !== '') return line;
    if (this.language !== 'english') {
      const english = this.linesFor(section, 'english');
      const fallback = english?.[index];
      if (fallback !== undefined && fallback !== '') return fallback;
    }
    return line ?? null;
  }

  /** How many lines a section holds, for a sweep. */
  lineCount(section: number): number {
    return this.linesFor(section, this.language)?.length ?? 0;
  }

  private linesFor(section: number, language: Sword1Language): readonly string[] | null {
    const resourceId = this.resourceFor(section, language);
    if (resourceId === 0) return null;
    const cached = this.cache.get(resourceId);
    if (cached) return cached;
    const resource = this.resources.fetch(resourceId);
    if (!resource) return null;
    const lines = readSwordTextResource(resource.payload, this.resources.bigEndian, this.encoding);
    this.cache.set(resourceId, lines);
    return lines;
  }

  /** Languages this install actually holds text for. */
  availableLanguages(): Sword1Language[] {
    const found: Sword1Language[] = [];
    for (const language of SWORD1_LANGUAGES) {
      const hasAny = SWORD1_SECTION_TEXT.some((row) => {
        const id = row[sword1LanguageIndex(language)] ?? 0;
        return id !== 0 && this.resources.fetch(id) !== null;
      });
      if (hasAny) found.push(language);
    }
    return found;
  }
}
