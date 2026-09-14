/**
 * Exporting a SCI Project: the assembler is a linker.
 *
 * ADR 0018's hard part, and the reason it is hard is not code generation. A
 * Script resource is a *linked* unit — adding a Selector to a class relays out
 * every instance of it and every relocation entry, and adding a method changes
 * the dispatch table — so writing one back means rebuilding the relationships
 * rather than emitting a list.
 *
 * **The constraint that shapes everything: a new Selector must extend the
 * game's own table without renumbering the ones untouched Script resources
 * still index by number.** A Selector's number is not a name in the file, it is
 * an index, and every script in the game holds those indexes. Renumbering one
 * rewrites the meaning of every send in every script that was not touched.
 *
 * **An untouched script is not rebuilt.** `Unrecovered` counts a resource that
 * came back as different bytes, with a target of zero, and the only way to
 * guarantee that for a resource nobody edited is to write back what arrived.
 * The linker runs for the ones that changed, and an edited method re-emits as
 * *valid* rather than identical — which is the whole distinction #220 draws.
 */

import { fromBase64, toBase64 } from '../base64.js';
import type {
  SciProject,
  SciProjectCelPicture,
  SciProjectMethod,
  SciProjectScript,
} from '../project.js';
import { SCI_OPCODES, sciParameterBlockIsWord } from '../../engine/sci/script/opcodes.js';
import type { SciVersion } from '../../engine/sci/sciVersion.js';
import { linkSci11Script, linkSciScript, sciScriptIsHeapPair } from './sciLinker.js';
import { readSelectorTable } from '../../engine/sci/script/selectors.js';

export interface SciExportResult {
  /** Resource type and number to its bytes, ready to be packed into Volumes. */
  resources: Map<string, Uint8Array>;
  /** Scripts that were rebuilt rather than carried through. */
  rebuilt: number[];
  /** Cel Pictures whose composition an author moved, and which were rewritten. */
  recomposed: number[];
  /**
   * Volumes this export carries through byte for byte rather than rebuilding.
   *
   * **#227's honest answer to the size question.** ADR 0021 put a read-by-offset
   * seam under the resource layer so that a seven-disc game can be *played*.
   * Editing is a different claim: an export rebuilds a game, and rebuilding a
   * 1.5GB one in a browser is not the same problem as streaming it.
   *
   * So it does not. A game's video and audio Volumes are not resources this
   * editor holds — nothing in a Project references their contents — and they
   * are named here so the UI can say "these are carried through untouched"
   * rather than implying an export rewrote them.
   */
  carriedVolumes: string[];
  /** What could not be written, and why. */
  problems: string[];
}

/**
 * The Volumes an export never rebuilds.
 *
 * Named by what they hold rather than by a size threshold: audio and video are
 * played, not held (`CONTEXT.md`), so there is nothing in a Project that could
 * rebuild them even if it were cheap to. A resource Volume is a different case
 * and is rebuilt.
 */
export const CARRIED_VOLUMES = ['RESOURCE.AUD', 'RESOURCE.SFX', 'RESSCI.PAT', 'RESOURCE.MSG'];

/**
 * Re-emits one method's instruction list.
 *
 * The low bit of the opcode byte is the operand width, so an instruction whose
 * operands still fit re-emits byte-identically — which is what makes an
 * untouched method's bytes match without this having to know it was untouched.
 * An operand that has grown past a byte forces the wide form, and the
 * instruction gets longer; that is the case a linker exists for, because every
 * offset after it in the script moves.
 */
export function emitSciMethod(method: SciProjectMethod, version?: SciVersion): Uint8Array {
  // Two passes, because a branch inside this method is a *distance* and an
  // instruction ahead of it may change width. Laying the instructions out
  // first gives every one its new offset, so a branch can be recomputed
  // against where its target actually lands rather than against where it used
  // to be. One pass leaves a branch pointing into the middle of the
  // instruction that grew — a body that runs and jumps to a misread boundary,
  // which is the fault ADR 0017 names twice over.
  const widths = method.instructions.map((instruction) => widthOf(instruction, version));
  const newOffsets: number[] = [];
  let at = 0;
  for (const width of widths) {
    newOffsets.push(at);
    at += width;
  }

  /** Old offset to new, within this body. */
  const moved = new Map<number, number>();
  for (const [index, instruction] of method.instructions.entries()) {
    moved.set(instruction.offset, method.offset + newOffsets[index]);
  }

  const out: number[] = [];
  for (const [index, instruction] of method.instructions.entries()) {
    const spec = SCI_OPCODES[instruction.raw >> 1];
    // The same decision `widthOf` made, taken from the same place rather than
    // inferred back out of the width. Inferring it broke every `send`: a send
    // has only a `byte` operand, so its narrow and wide forms are the same
    // length and the width says nothing about which one it is.
    const { wide } = layoutOf(instruction, version);
    out.push(wide ? instruction.raw & ~1 : instruction.raw | 1);

    // A `fileName` carries a NUL-terminated string where another opcode would
    // carry operands. It has to go back exactly as it came, terminator
    // included, or the method is shorter than the file said it was.
    if (instruction.name === 'fileName') {
      for (const letter of instruction.text ?? '') out.push(letter.charCodeAt(0) & 0xff);
      out.push(0);
      continue;
    }

    for (const [position, operand] of instruction.operands.entries()) {
      const kind = spec?.operands[position];
      if (kind === 'byte') {
        // **A parameter block is a word from SCI2 on**, whatever the opcode's
        // low bit says — the decoder reads two bytes here and this has to write
        // two back, or the instruction shrinks by one and everything after it
        // in the body moves.
        out.push(operand & 0xff);
        if (sciParameterBlockIsWord(instruction.raw >> 1, version)) {
          out.push((operand >> 8) & 0xff);
        }
        continue;
      }

      // A branch's operand is recomputed; every other operand is a value and
      // is written as it is.
      let value = operand;
      if (position === 0 && isBranch(instruction.name)) {
        const oldAfter = instruction.offset + originalWidthOf(instruction, version);
        const target = moved.get(oldAfter + operand);
        if (target !== undefined) {
          value = target - (method.offset + newOffsets[index] + widths[index]);
        }
      }

      if (wide) {
        const stored = value < 0 ? value + 0x10000 : value;
        out.push(stored & 0xff, (stored >> 8) & 0xff);
      } else {
        out.push((value < 0 ? value + 0x100 : value) & 0xff);
      }
    }
  }

  return new Uint8Array(out);
}

function isBranch(name: string): boolean {
  return name === 'bt' || name === 'bnt' || name === 'jmp';
}

/** The width this instruction arrived at. */
function originalWidthOf(
  instruction: SciProjectMethod['instructions'][number],
  version?: SciVersion,
): number {
  if (instruction.name === 'fileName') return 1 + (instruction.text ?? '').length + 1;
  const spec = SCI_OPCODES[instruction.raw >> 1];
  const narrow = (instruction.raw & 1) !== 0;
  const block = sciParameterBlockIsWord(instruction.raw >> 1, version) ? 2 : 1;
  return (
    1 +
    (spec?.operands ?? []).reduce(
      (sum, operand) => sum + (operand === 'byte' ? block : narrow ? 1 : 2),
      0,
    )
  );
}

/**
 * The width this instruction will be emitted at.
 *
 * The width it arrived at, unless an operand no longer fits. Widening on the
 * way out when nothing changed would make every untouched method's bytes
 * differ, which is exactly the `Unrecovered` count this is trying to keep at
 * zero.
 *
 * **A `byte` operand is not part of that decision.** A send's parameter-byte
 * count is one byte whichever way the low bit goes, so it is excluded from the
 * fit test — including it made every `send` in every game look like an
 * instruction that had grown.
 */
function layoutOf(
  instruction: SciProjectMethod['instructions'][number],
  version?: SciVersion,
): {
  wide: boolean;
  width: number;
} {
  if (instruction.name === 'fileName') {
    // The low bit is not a width here — it is what says this is a name at all,
    // so it must be left exactly as it arrived.
    return { wide: false, width: 1 + (instruction.text ?? '').length + 1 };
  }
  const spec = SCI_OPCODES[instruction.raw >> 1];
  const narrow = (instruction.raw & 1) !== 0;
  const sized = instruction.operands.filter((_operand, index) => spec?.operands[index] !== 'byte');
  const fits = sized.every((operand) => operand >= -0x80 && operand <= 0xff);
  const wide = !narrow || !fits;
  const block = sciParameterBlockIsWord(instruction.raw >> 1, version) ? 2 : 1;

  return {
    wide,
    width:
      1 +
      (spec?.operands ?? []).reduce(
        (sum, operand) => sum + (operand === 'byte' ? block : wide ? 2 : 1),
        0,
      ),
  };
}

function widthOf(
  instruction: SciProjectMethod['instructions'][number],
  version?: SciVersion,
): number {
  return layoutOf(instruction, version).width;
}

/**
 * Whether a script can be written back byte-identically.
 *
 * True when nothing about it changed, which is the common case and the one
 * `Unrecovered = 0` depends on. A script with no graph — a SCI1.1 pair or a
 * SCI3 layout this import could not read — is also in this arm, and that is
 * correct rather than a shortcut: it was never turned into a graph, so there is
 * nothing to have edited.
 *
 * **Compared byte for byte, not by length.** This asked only whether a method
 * re-emitted to the same *size*, which meant an edit that kept an instruction's
 * width — changing a constant, an opcode, a Selector number, which is most
 * edits and exactly the case `emitSciMethod` is proud of handling — was
 * invisible. The script then took this arm and its original bytes were written
 * back, so **the edit was silently dropped**. `Unrecovered` stayed at zero and
 * the export reported no problem, because by its own test nothing had happened.
 *
 * Found by editing one operand in Police Quest 3, Conquests of the Longbow and
 * Castle of Dr. Brain and diffing the export: zero bytes changed in all three.
 * The old comment said a length is "something the bytes cannot lie about",
 * which is true of a length and not of an edit.
 */
export function isUntouched(script: SciProjectScript, version?: SciVersion): boolean {
  if (script.unrecovered) return true;
  const original = script.bytes === '' ? null : fromBase64(script.bytes);

  // A property word is not code, and before SCI1.1 it is in this resource
  // anyway. A script whose only edit is a property would otherwise export as
  // untouched, which is the original bytes and not the author's change.
  const words = propertyWords(script, 'code');
  if (words.length > 0 && !original) return false;
  if (original && words.some(({ offset, value }) => readWord(original, offset) !== value)) {
    return false;
  }

  return script.objects.every((object) =>
    object.methods.every((method) => {
      if (method.unrecovered !== undefined) return false;
      const emitted = emitSciMethod(method, version);
      if (emitted.length !== originalLengthOf(method, version)) return false;
      // No original to compare against means this cannot be shown untouched,
      // and the honest answer to "can I write these bytes back unchanged" is
      // then no — the linker runs and produces something valid instead.
      if (!original) return false;
      return emitted.every((byte, index) => byte === original[method.offset + index]);
    }),
  );
}

/**
 * How many bytes a method's instructions occupied when they were read.
 *
 * From the recorded offsets rather than by re-deriving each length, because the
 * offsets are what the file actually had — and re-deriving would make this
 * agree with `emitSciMethod` by construction, which is the one thing it must
 * not do.
 */
function originalLengthOf(method: SciProjectMethod, version?: SciVersion): number {
  const instructions = method.instructions;
  if (instructions.length === 0) return 0;
  const last = instructions[instructions.length - 1];
  const lastLength =
    instructions.length > 1
      ? // The last instruction's own length is not recorded, so it is taken
        // from the emitted form. Every earlier one is measured from the gap to
        // the next, which is the file's own answer.
        emitOne(last, version).length
      : emitOne(last, version).length;
  return last.offset + lastLength - method.offset;
}

/** One instruction, in the width it arrived at. */
function emitOne(
  instruction: SciProjectMethod['instructions'][number],
  version?: SciVersion,
): Uint8Array {
  return emitSciMethod(
    {
      selector: '',
      selectorNumber: 0,
      offset: instruction.offset,
      instructions: [instruction],
    },
    version,
  );
}

/**
 * Extends the Selector table without renumbering anything already in it.
 *
 * The constraint #220 calls the hard part, implemented as the only thing it can
 * be: append, and refuse anything else. A caller that wants to *rename* a
 * Selector is asking for the name at an index to change, which is safe; a
 * caller that wants to remove one is asking every script that indexes past it
 * to mean something else, and that is refused rather than done.
 */
export function extendSelectors(
  existing: readonly string[],
  wanted: readonly string[],
): { selectors: string[]; added: string[]; refused: string[] } {
  const selectors = [...existing];
  const added: string[] = [];
  const refused: string[] = [];

  for (const name of wanted) {
    if (selectors.includes(name)) continue;
    selectors.push(name);
    added.push(name);
  }

  for (const name of existing) {
    if (!wanted.includes(name) && wanted.length > 0) {
      // Not an error and not acted on: a Selector nobody uses any more still
      // has to keep its number, because a script this Project did not read may
      // index past it.
      refused.push(name);
    }
  }

  return { selectors, added, refused };
}

/** Writes a Selector table back in `vocab.997`'s own format. */
export function emitSelectorTable(selectors: readonly string[]): Uint8Array {
  // A count that is one short, then that many offsets, then the strings. The
  // count being short is Sierra's, not a mistake here — ScummVM's own comment
  // is "Counter is slightly off" — and writing the true count would lose the
  // last Selector on every reader that expects the short one.
  const header = 2 + selectors.length * 2;
  const bodies = selectors.map((name) => {
    const bytes = new Uint8Array(2 + name.length);
    bytes[0] = name.length & 0xff;
    bytes[1] = name.length >> 8;
    for (let i = 0; i < name.length; i++) bytes[2 + i] = name.charCodeAt(i) & 0xff;
    return bytes;
  });

  const total = header + bodies.reduce((sum, body) => sum + body.length, 0);
  const out = new Uint8Array(total);
  out[0] = (selectors.length - 1) & 0xff;
  out[1] = (selectors.length - 1) >> 8;

  let at = header;
  for (const [index, body] of bodies.entries()) {
    out[2 + index * 2] = at & 0xff;
    out[2 + index * 2 + 1] = (at >> 8) & 0xff;
    out.set(body, at);
    at += body.length;
  }
  return out;
}

/**
 * Writes a Project's resources back.
 *
 * Untouched scripts and every non-script resource are carried through exactly;
 * an edited script is rebuilt. What is *not* here yet is the rebuild of a
 * script whose method lengths changed — relaying out the code block, the
 * dispatch table and the relocation list — and it says so rather than emitting
 * something that boots and behaves differently.
 */
export function exportSciGame(project: SciProject): SciExportResult {
  const resources = new Map<string, Uint8Array>();
  const rebuilt: number[] = [];
  // Scripts whose *heap* changed, tracked apart from the code so a script that
  // changed in both halves is named once. `rebuilt` is "this resource is not
  // the bytes it arrived as", and it is a set of script numbers rather than a
  // count of edits.
  const heapEdited = new Set<number>();
  const recomposed: number[] = [];
  const problems: string[] = [];

  for (const resource of [...project.resources, ...project.vectorPictures]) {
    resources.set(`${resource.type}:${resource.number}`, fromBase64(resource.bytes));
  }

  for (const picture of project.celPictures) {
    const original = fromBase64(picture.bytes);
    const rewritten = recomposeCelPicture(original, picture);
    if (rewritten) recomposed.push(picture.number);
    resources.set(`pic:${picture.number}`, rewritten ?? original);
  }

  for (const script of project.scripts) {
    if (script.bytes === '') {
      problems.push(`script ${script.number} was never read, so it cannot be written`);
      continue;
    }
    const original = fromBase64(script.bytes);
    // A SCI1.1 script is two resources and both are written back. Rebuilding
    // the pair from a combined buffer would put the word of alignment padding
    // in the wrong half for any script whose code is an odd number of bytes.
    if (script.heapBytes !== undefined) {
      // The heap is where a SCI1.1 object's properties are, so this is not a
      // carry-through: the bytes are copied and the edited words are written
      // over them. Nothing else in the heap moves, so an unedited heap comes
      // back byte for byte — `writeWords` skips a word that already holds what
      // the graph holds.
      const heap = fromBase64(script.heapBytes);
      if (writeWords(heap, propertyWords(script, 'heap')) > 0) heapEdited.add(script.number);
      resources.set(`heap:${script.number}`, heap);
    }

    if (isUntouched(script, project.version)) {
      resources.set(`script:${script.number}`, original);
      continue;
    }

    const rewritten = rewriteInPlace(original, script, project.version);
    if (rewritten) {
      resources.set(`script:${script.number}`, rewritten);
      rebuilt.push(script.number);
      continue;
    }

    // A method changed length, so the code block, the dispatch tables, the
    // export table and the relocation list all have to be relaid out. That is
    // the linker (ADR 0018), and it is what makes this an assembler for a
    // *linked* unit rather than an emitter.
    //
    // **Two layouts, two linkers, chosen by what the script ships as.** A SCI0
    // script is a block chain and a SCI1.1 one is a code-and-heap pair with no
    // chain at all, so the same relayout cannot serve both — which is why a
    // length-changing edit was refused from SCI1.1 on until `linkSci11Script`
    // existed. Decided by the *resource* and never by the Version, which is
    // ADR 0020's rule: a release ships what it ships.
    // A heap resource beside the script is not on its own enough: what decides
    // is whether the *code* resource is a block chain, because that is what
    // `linkSciScript` reads. A script with both — which a fixture can be — goes
    // to the chain linker, the one that can actually read it.
    const linked = sciScriptIsHeapPair(script)
      ? linkSci11Script(script, project.version)
      : linkSciScript(script, project.version);

    // A relayout that moved a dictionary rewrote the heap's pointers to it, and
    // that heap supersedes the property-word copy written above — it is the
    // same bytes with the moved offsets in them.
    if (linked.heapBytes) {
      writeWords(linked.heapBytes, propertyWords(script, 'heap'));
      resources.set(`heap:${script.number}`, linked.heapBytes);
      heapEdited.add(script.number);
    }
    if (linked.refused) {
      problems.push(`script ${script.number}: ${linked.refused}`);
      resources.set(`script:${script.number}`, original);
      continue;
    }

    resources.set(`script:${script.number}`, linked.bytes);
    rebuilt.push(script.number);
  }

  // **Only when the table grew.** Rebuilding it unconditionally made
  // `vocab.997` the one resource that differed in a round trip of every game
  // that ships one — which is the headline criterion of five editing issues,
  // failing quietly on 21 of 25 real games.
  //
  // It is not a cosmetic difference either. From SCI1.1 on Sierra ships a
  // fixed **4,104-entry** table, most of whose slots point at empty strings or
  // at the literal `BAD SELECTOR` — King's Quest VI names only 883 of them.
  // Re-emitting it gives every one of those slots a two-byte length prefix and
  // a body, turning a 17KB resource into 62KB. Carrying it through is both
  // byte-identical and smaller.
  const originalSelectors = resources.get('vocab:997');
  const grew =
    !originalSelectors ||
    project.selectors.length > readSelectorTable(originalSelectors).names.length;
  if (grew) resources.set('vocab:997', emitSelectorTable(project.selectors));

  for (const number of heapEdited) if (!rebuilt.includes(number)) rebuilt.push(number);
  rebuilt.sort((a, b) => a - b);

  return { resources, rebuilt, recomposed, carriedVolumes: [...CARRIED_VOLUMES], problems };
}

/**
 * Writes a cel Picture's composition back, when an author moved something.
 *
 * **No linker, and that is a fact about the format rather than a shortcut.** An
 * item's position and priority are fixed-width fields at fixed offsets in its
 * own cel header, so moving an item writes six bytes and nothing else moves.
 * Editing a Script resource cannot work that way — adding a Selector relays out
 * every instance and every relocation entry (ADR 0018) — and the contrast is
 * the reason this editor and that one share no machinery.
 *
 * Returns null when nothing moved, so an untouched Picture exports the bytes it
 * arrived as and `Unrecovered` stays at zero.
 */
function recomposeCelPicture(
  original: Uint8Array,
  picture: SciProjectCelPicture,
): Uint8Array | null {
  // Only SCI32's container carries positions. A SCI1.1 cel Picture has one item
  // and it is the background; there is nowhere to move it to, and pretending
  // otherwise would write into bytes that mean something else.
  if (picture.container !== 'sci32') return null;

  const rewritten = original.slice();
  const view = new DataView(rewritten.buffer, rewritten.byteOffset, rewritten.byteLength);
  let moved = false;

  for (const item of picture.items) {
    if (item.headerAt + 42 > rewritten.length) continue;
    const priority = view.getInt16(item.headerAt + 36, true);
    const x = view.getInt16(item.headerAt + 38, true);
    const y = view.getInt16(item.headerAt + 40, true);
    if (priority === item.priority && x === item.x && y === item.y) continue;

    view.setInt16(item.headerAt + 36, item.priority, true);
    view.setInt16(item.headerAt + 38, item.x, true);
    view.setInt16(item.headerAt + 40, item.y, true);
    moved = true;
  }

  return moved ? rewritten : null;
}

/**
 * What to tell an author about editing this game's cel Pictures.
 *
 * The editor states the limitation rather than letting it be discovered, which
 * is the same rule #222 sets for localisation: "edit this game's words" reaches
 * the Messages and not the artwork, and saying so is part of the feature.
 */
export function describeCelPictureEditing(picture: SciProjectCelPicture): string {
  if (picture.container === 'sci11') {
    return (
      `Picture ${picture.number} is a SCI1.1 cel Picture: one background bitmap` +
      (picture.hasVectors
        ? ', with vector operations after it that paint the priority buffer'
        : '') +
      `. There is no arrangement to edit — the composition arrived with SCI2 — so this Picture is ` +
      `held as it is rather than opened in an editor that would imply otherwise.`
    );
  }
  return (
    `Picture ${picture.number} is a composition of ${picture.items.length} ` +
    `item${picture.items.length === 1 ? '' : 's'}` +
    (picture.resolution ? ` at ${picture.resolution.width}x${picture.resolution.height}` : '') +
    `. Items are moved and re-prioritised; there are no drawing tools here, because a bitmap ` +
    `composition and a vector Picture share no editing operation (ADR 0018). The artwork inside ` +
    `each item is not reachable from this surface.`
  );
}

/**
 * Writes edited methods back over the original bytes, where they fit.
 *
 * The case that does not need a linker, and it is the common one: an author
 * changes a constant or an opcode and the instruction is the same length. Where
 * anything grew, this returns null and the caller says so — because a method
 * written over the top of the one after it produces a script that loads.
 */
function rewriteInPlace(
  original: Uint8Array,
  script: SciProjectScript,
  version?: SciVersion,
): Uint8Array | null {
  const out = new Uint8Array(original);

  for (const object of script.objects) {
    for (const method of object.methods) {
      if (method.unrecovered) continue;
      const emitted = emitSciMethod(method, version);
      if (emitted.length !== originalLengthOf(method, version)) return null;
      out.set(emitted, method.offset);
    }
  }
  writeWords(out, propertyWords(script, 'code'));
  return out;
}

/**
 * Every property and local word this script holds, as (where, what).
 *
 * Read from the graph rather than diffed against the bytes, so the same list
 * answers both questions the exporter asks: whether anything changed, and what
 * to write. A word is a fixed two bytes in a fixed place — an object's size is
 * in its own header and no edit here moves it — which is why properties need
 * no linker and methods do.
 */
function propertyWords(
  script: SciProjectScript,
  where: 'code' | 'heap',
): { offset: number; value: number }[] {
  const words: { offset: number; value: number }[] = [];
  // Script 0's are the game's globals, and every other script's are its own
  // state — the same two-byte word in the same fixed place, so they go through
  // the same writer rather than a second one that could disagree with it.
  if (script.localsAt && script.localsAt.resource === where) {
    for (const [index, value] of script.locals.entries()) {
      words.push({ offset: script.localsAt.offset + index * 2, value: value & 0xffff });
    }
  }
  for (const object of script.objects) {
    const at = object.variablesAt;
    if (!at || at.resource !== where) continue;
    for (const [index, value] of object.variables.entries()) {
      words.push({ offset: at.offset + index * 2, value: value & 0xffff });
    }
  }
  return words;
}

function readWord(bytes: Uint8Array, at: number): number | null {
  if (at < 0 || at + 2 > bytes.length) return null;
  return bytes[at] | (bytes[at + 1] << 8);
}

/**
 * Writes those words, and counts the ones that actually differed.
 *
 * A word past the end of the resource is skipped rather than grown into: the
 * offsets come from the reader that walked these same bytes, so one out of
 * range means the two disagree about the layout, and guessing is how a Script
 * resource becomes a longer Script resource nobody asked for.
 */
function writeWords(out: Uint8Array, words: readonly { offset: number; value: number }[]): number {
  let changed = 0;
  for (const { offset, value } of words) {
    if (readWord(out, offset) === null || readWord(out, offset) === value) continue;
    out[offset] = value & 0xff;
    out[offset + 1] = (value >> 8) & 0xff;
    changed++;
  }
  return changed;
}

export { toBase64 };
