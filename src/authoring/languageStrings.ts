import type { LanguageBundle } from '../engine/script/v7/language.js';

/**
 * A v7 game's text, as editable Project content (ADR 0009).
 *
 * **This applies to The Dig and not to Full Throttle.** ScummVM's
 * `loadLanguageBundle` opens `LANGUAGE.BND` only for The Dig; every other v7
 * game returns without opening anything. Full Throttle's scripts carry
 * `/TAG/fallback` strings whose *fallback* is the line that displays, so
 * editing its words is editing its instructions — ADR 0005, already supported,
 * and needing none of this. ADR 0009 as written claims more than that; the
 * narrowing is recorded on #112.
 *
 * The property that makes this need care: one string can be referenced from
 * many scripts, so editing it changes every place it appears. That is not true
 * of Preserved bytes or of `Action`s, both of which belong to one place, and the
 * editor has to make an edit's reach visible before the author commits to it.
 */

export interface ProjectString {
  /** The bundle tag, upper case, as both the file and a script write it. */
  tag: string;
  /** The words. What the author edits. */
  text: string;
  /** The text as imported, so an untouched entry can be written back exactly. */
  original: string;
}

export interface ProjectStrings {
  /** Which file these came from, so export writes back the one it read. */
  source: string;
  entries: ProjectString[];
}

/** Turns a read bundle into Project content, preserving file order. */
export function importStrings(bundle: LanguageBundle): ProjectStrings {
  const entries: ProjectString[] = [];
  for (const [tag, text] of bundle.lines) {
    entries.push({ tag, text, original: text });
  }
  return { source: bundle.source, entries };
}

/**
 * Which scripts reference a tag, so the editor can show an edit's reach.
 *
 * Takes the listings rather than the bytes: a `/TAG/` only exists inside an
 * inline message, and the disassembler has already found where those are and
 * how long they run. Re-scanning the bytes for slashes would also match a
 * slash inside ordinary dialogue.
 */
export function findReferences(
  listings: ReadonlyMap<string, { text: string }[]>,
): Map<string, string[]> {
  const references = new Map<string, string[]>();

  for (const [scriptName, instructions] of listings) {
    for (const instruction of instructions) {
      for (const tag of tagsIn(instruction.text)) {
        const existing = references.get(tag);
        if (existing) {
          if (!existing.includes(scriptName)) existing.push(scriptName);
        } else {
          references.set(tag, [scriptName]);
        }
      }
    }
  }

  return references;
}

/** Every `/TAG/` in a rendered instruction, upper-cased as lookups are. */
function tagsIn(text: string): string[] {
  const tags: string[] = [];
  const pattern = /\/([A-Za-z0-9_.]{1,12})\//g;
  let match = pattern.exec(text);
  while (match) {
    tags.push(match[1].toUpperCase());
    match = pattern.exec(text);
  }
  return tags;
}

/** Whether an entry has been edited, and so must be written differently. */
export function isEdited(entry: ProjectString): boolean {
  return entry.text !== entry.original;
}

/**
 * Writes the strings back as a `LANGUAGE.BND`.
 *
 * Grouped by base tag, because that is the file's own structure: `@BASE` then
 * numbered lines beneath it. Regenerated rather than patched in place, which is
 * why `original` is kept — an untouched entry has to come back out as the text
 * that went in, so that "nothing was edited" produces a file with the same
 * lines rather than one that merely parses.
 *
 * The `e` encoding marker is deliberately not re-emitted. It exists to stop a
 * player reading the script in a text editor, it costs a game nothing to omit,
 * and writing an encoded file this reader could not read back would be a worse
 * failure than a readable one.
 */
export function writeDigLanguageBundle(strings: ProjectStrings): Uint8Array {
  const byBase = new Map<string, Array<{ index: number; text: string }>>();
  const untagged: string[] = [];

  for (const entry of strings.entries) {
    const dot = entry.tag.lastIndexOf('.');
    if (dot <= 0) {
      untagged.push(entry.tag);
      continue;
    }
    const base = entry.tag.slice(0, dot);
    const index = Number(entry.tag.slice(dot + 1));
    if (!Number.isInteger(index)) {
      untagged.push(entry.tag);
      continue;
    }
    const group = byBase.get(base);
    if (group) group.push({ index, text: entry.text });
    else byBase.set(base, [{ index, text: entry.text }]);
  }

  const lines: string[] = [];
  for (const [base, group] of byBase) {
    lines.push(`@${base}`);
    for (const { index, text } of group) lines.push(`${index}/${text}`);
  }

  // An entry whose tag this cannot take apart would be dropped silently, and a
  // dropped line is missing dialogue. Better to fail the export.
  if (untagged.length > 0) {
    throw new Error(
      `${untagged.length} string(s) have tags this writer cannot rebuild ` +
        `(${untagged.slice(0, 3).join(', ')}). Writing the bundle without them would ` +
        `produce a game with missing dialogue, so the export is refused instead.`,
    );
  }

  return new TextEncoder().encode(lines.join('\n') + '\n');
}
