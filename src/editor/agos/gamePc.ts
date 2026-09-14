/**
 * The editor's AGOS project, as the thing the authoring layer edits.
 *
 * There are two AGOS project shapes in this repository and they exist for
 * different jobs. `authoring/agos/project.ts` holds an `AgosGamePc` — the
 * file's structures, as read — and every edit in `authoring/agos/edits.ts`
 * takes and returns one. `authoring/project.ts` holds the shape that is
 * **serialised into IndexedDB and back**, so its strings are base64 and its
 * pool is bytes rather than a split list.
 *
 * This is the seam between them, in one place. It exists so the editor never
 * grows a second copy of a rule the authoring layer already owns: renaming an
 * item is "append a string and repoint the noun", and an editor that
 * open-coded that would eventually disagree with the exporter about whether
 * the header's string count moves with it.
 *
 * Nothing here decides anything. It converts, applies a function from
 * `edits.ts`, and converts back.
 */

import { fromBase64, toBase64 } from '../../authoring/base64.js';
import type { AgosProject } from '../../authoring/project.js';
import type { AgosGamePc } from '../../engine/agos/resource/gamePc.js';

/** The byte that ends every pooled string. */
const NUL = '\0';

/** The project's AGOS half, as the structures `edits.ts` works on. */
export function gamePcOf(agos: AgosProject): AgosGamePc {
  const textBytes = fromBase64(agos.textBase64);
  return {
    header: { ...agos.header },
    strings: splitPool(textBytes),
    textBytes,
    items: agos.items,
    subroutines: agos.subroutines,
    trailing: fromBase64(agos.trailingBase64 ?? ''),
  };
}

/**
 * Writes an edited game back onto the project, in place.
 *
 * In place because the caller is inside an `update` callback, which is where
 * this editor records undo — returning a new project here would mean the caller
 * had two ways to apply one edit and only one of them was recorded.
 */
export function writeGamePcInto(agos: AgosProject, game: AgosGamePc): void {
  agos.header = { ...game.header };
  agos.textBase64 = toBase64(game.textBytes);
  agos.items = [...game.items];
  agos.subroutines = game.subroutines;
  agos.trailingBase64 = toBase64(game.trailing);
}

/**
 * Applies one edit from `edits.ts` to a project.
 *
 * The whole point of the two functions above having one caller: an edit is
 * convert, apply, convert back, and spelling that out at every call site is
 * three chances to forget the third step.
 */
export function editGamePc(agos: AgosProject, edit: (game: AgosGamePc) => AgosGamePc): void {
  writeGamePcInto(agos, edit(gamePcOf(agos)));
}

/**
 * The pool as strings.
 *
 * Split here rather than stored beside the bytes, so the pool has one truth.
 * ADR 0030 rebuilds `GAMEPC` from exactly these bytes, and a second copy of
 * them is a second thing to keep in step.
 */
export function splitPool(textBytes: Uint8Array): string[] {
  const strings: string[] = [];
  let current = '';
  for (const byte of textBytes) {
    const character = String.fromCharCode(byte);
    if (character === NUL) {
      strings.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  return strings;
}

/** The strings a project's pool holds, by the index an operand carries. */
export function stringsOf(agos: AgosProject): string[] {
  return splitPool(fromBase64(agos.textBase64));
}
