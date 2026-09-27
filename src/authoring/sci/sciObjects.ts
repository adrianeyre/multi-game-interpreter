/**
 * Adding an instance to a SCI script, and deleting one this editor added
 * (row 12).
 *
 * `docs/editor-parity.md` §12s called this "a No that follows the linker, not a
 * No about the format". This is the part of it the format makes cheap: a new
 * **instance** cloned from one the script already has, in a script that is a
 * SCI0/SCI1 **block chain**.
 *
 * ## Why appending needs no relinking
 *
 * An object block is self-contained where it matters. Its method dictionary is
 * addressed *relative to its own selector counter* (`readSci0Object`'s
 * `methodsAt`), and the entries in it are absolute offsets of method bodies
 * elsewhere in the script — so a byte-for-byte copy of the block, anywhere,
 * dispatches into exactly the same code as the original. Its property words
 * are values. The one thing in it that is not position-free is a word the
 * relocation block (`pointers`, type 8) names — `name`, and any other property
 * that holds an address into the script — because the relocation block lists
 * *positions*, and a copy's words are at new ones.
 *
 * So the copy goes **after the last block**, where nothing in the script
 * points, and nothing that was already there moves: every export, every
 * dispatch table, every relocation entry, every `lofsa` and every branch keeps
 * its value. That is the whole reason this is tractable without a general
 * insertion linker — the existing ones relay out bodies, and inserting a block
 * in the middle would also move PC-relative `lofsa` targets, which neither
 * patches.
 *
 * Where the original has relocated words, the copy needs entries of its own
 * and the relocation block grows. That is only free when the relocation block
 * is itself the last block — then the only thing after it is the copy, placed
 * past the new entries. Anywhere else it is refused by name.
 *
 * ## What the copy is, and is not
 *
 * - It **shares its method bodies** with the original. The graph gives it no
 *   methods of its own, so an edit to the original's methods is an edit to
 *   both, and the linker never sees two objects claiming one body (which it
 *   would rightly refuse as an overlap).
 * - Its **properties are its own**, and editable like any other object's.
 * - It has the original's **name**: a name is a pointer into the script's
 *   strings, and a new string would be a new block this does not add.
 * - Nothing refers to it yet. An instance a script never names is created
 *   with the script and otherwise inert, which is what an author then edits a
 *   property or a method to change.
 *
 * ## Deleting
 *
 * Only what this editor added, and only the most recent of those — the rule
 * the other families' Delete follows (12a). Removing the last appended block
 * and the relocation entries added with it restores the script to exactly the
 * bytes it had before, which the tests hold it to.
 */

import { fromBase64, toBase64 } from '../base64.js';
import type { SciProjectScript } from '../project.js';
import { addSciHeapInstance, deleteSciHeapInstance } from './sciHeapObjects.js';
import { addSci3Instance, deleteSci3Instance } from './sciSci3Objects.js';
import { sciScriptIsHeapPair } from './sciLinker.js';
import {
  readSci0Blocks,
  readSci0Relocations,
  sci0ScriptBias,
  SCI0_OBJECT_BIAS,
  SCI_BLOCK_TYPES,
  type SciBlock,
} from '../../engine/sci/script/scriptResource.js';

/** Where the SCI0 name word is among an object's variables (`name`). */
const NAME_VARIABLE = 3;

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function putU16(bytes: Uint8Array, at: number, value: number): void {
  bytes[at] = value & 0xff;
  bytes[at + 1] = (value >> 8) & 0xff;
}

/** The block a graph object was read from, by where its properties start. */
function blockOf(blocks: readonly SciBlock[], variablesAt: number): SciBlock | undefined {
  return blocks.find(
    (block) =>
      (block.type === 'object' || block.type === 'class') &&
      block.offset + SCI0_OBJECT_BIAS === variablesAt,
  );
}

/** Neither a block chain nor a heap beside it: the SCI3 layout. */
function isSci3Layout(script: SciProjectScript): boolean {
  if (script.heapBytes !== undefined || script.bytes === '') return false;
  const original = fromBase64(script.bytes);
  return readSci0Blocks(original, sci0ScriptBias(original)).length === 0;
}

/** Why this script cannot take an added instance at all, or null. */
export function describeSciObjectAdding(script: SciProjectScript): string | null {
  if (script.unrecovered) return `this script was not read as a graph (${script.unrecovered})`;
  if (script.bytes === '') return 'this script was never read, so nothing can be written back';
  const original = fromBase64(script.bytes);
  if (readSci0Blocks(original, sci0ScriptBias(original)).length > 0) return null;
  // Asked of the resource, never the Version (ADR 0020): no chain and a heap
  // beside it is the SCI1.1 pair, which `sciHeapObjects.ts` links; no chain
  // and no heap is SCI3.
  if (script.heapBytes !== undefined) return null;
  // Neither: a SCI3 layout, which `sciSci3Objects.ts` links.
  return null;
}

/**
 * The script with a copy of one of its instances appended, or a sentence.
 *
 * `index` is the object's position in `script.objects`. The returned script is
 * a new value; the caller puts it where the old one was.
 */
export function addSciInstance(
  script: SciProjectScript,
  index: number,
  name?: string,
): SciProjectScript | string {
  const refusal = describeSciObjectAdding(script);
  if (refusal) return refusal;
  if (name !== undefined && !/^[\x20-\x7e]+$/.test(name)) {
    return 'a name is written as one byte a letter, so it has to be printable ASCII and not empty';
  }

  const source = script.objects[index];
  if (!source) return `there is no object ${index} in script ${script.number}`;
  if (source.isClass) {
    return (
      `${source.name} is a class, and a copy of a class is a second definition of the same ` +
      `species — the class table (vocab 996) names one script per species, so only an ` +
      `instance is added`
    );
  }
  if (sciScriptIsHeapPair(script)) return addSciHeapInstance(script, index, name);
  if (isSci3Layout(script)) return addSci3Instance(script, index, name);
  if (!source.variablesAt || source.variablesAt.resource !== 'code') {
    return `${source.name} was read without recording where its block is, so it cannot be copied`;
  }

  const original = fromBase64(script.bytes);
  const blocks = readSci0Blocks(original, sci0ScriptBias(original));
  const block = blockOf(blocks, source.variablesAt.offset);
  if (!block) return `${source.name}'s block could not be found in the script's chain`;

  const blockStart = block.offset - 4;
  const blockLength = block.size + 4;
  const last = blocks[blocks.length - 1];
  const chainEnd = last.offset + last.size;
  if (chainEnd + blockLength > 0xffff) {
    return `script ${script.number} would pass 64KB, and a SCI0 offset is sixteen bits`;
  }

  // The words the relocation block names inside this object, which the copy
  // needs entries for at its own positions.
  const relocations = readSci0Relocations(original, blocks);
  const inside = [...relocations]
    .filter((at) => at >= blockStart && at < blockStart + blockLength)
    .sort((a, b) => a - b);
  const pointers = blocks.find((candidate) => candidate.type === 'pointers');
  if (inside.length > 0 && pointers !== last && (script.addedObjects?.length ?? 0) > 0) {
    return (
      `${source.name} holds relocated words, so the copy needs relocation entries of its own, ` +
      `and the relocation block is no longer the script's last block — an instance this editor ` +
      `added already follows it. Delete that one first, or copy an object with no relocated ` +
      `words`
    );
  }
  if (inside.length > 0 && pointers !== last) {
    return (
      `${source.name} holds ${inside.length} relocated word${inside.length === 1 ? '' : 's'} ` +
      `(its name, at least), so the copy needs relocation entries of its own — and this ` +
      `script's relocation block is not its last block, so growing it would move every block ` +
      `after it and every offset into them`
    );
  }

  // A new name is a strings block of its own after the copy, and it is only
  // an address if the loader relocates the word holding it — so the source's
  // name word has to be one the relocation block names.
  const nameWord = source.variablesAt.offset + NAME_VARIABLE * 2;
  const nameBody = name === undefined ? [] : [...name].map((letter) => letter.charCodeAt(0));
  if (name !== undefined) {
    if (!inside.includes(nameWord)) {
      return (
        `${source.name}'s name word is not in the relocation block, so a new name written ` +
        `there would be read as a number rather than as the string's address`
      );
    }
    nameBody.push(0);
    if (nameBody.length % 2 === 1) nameBody.push(0);
  }
  const nameBlock = name === undefined ? 0 : nameBody.length + 4;

  const grow = inside.length * 2;
  const copyAt = chainEnd + grow;
  if (copyAt + blockLength + nameBlock > 0xffff) {
    return `script ${script.number} would pass 64KB, and a SCI0 offset is sixteen bits`;
  }
  const out = new Uint8Array(original.length + grow + blockLength + nameBlock);

  if (grow > 0 && pointers) {
    // The relocation block is last: its entries end at `entriesEnd`, then any
    // padding it carried, then the chain's end. The new entries go straight
    // after the old ones, and the count and the block's size grow with them.
    const count = u16(original, pointers.offset);
    const entriesEnd = pointers.offset + 2 + count * 2;
    out.set(original.subarray(0, entriesEnd), 0);
    for (const [i, at] of inside.entries()) {
      putU16(out, entriesEnd + i * 2, at - blockStart + copyAt);
    }
    out.set(original.subarray(entriesEnd, chainEnd), entriesEnd + grow);
    putU16(out, pointers.offset, count + inside.length);
    putU16(out, pointers.offset - 2, pointers.size + 4 + grow);
  } else {
    out.set(original.subarray(0, chainEnd), 0);
  }
  out.set(original.subarray(blockStart, blockStart + blockLength), copyAt);
  const namesAt = copyAt + blockLength;
  if (name !== undefined) {
    putU16(out, namesAt, SCI_BLOCK_TYPES.indexOf('strings'));
    putU16(out, namesAt + 2, nameBlock);
    out.set(nameBody, namesAt + 4);
  }
  out.set(original.subarray(chainEnd), namesAt + nameBlock);

  // The graph: the copy's own properties at their own place, no methods of
  // its own (see the header), and the edits the source has in the project
  // but not yet in its bytes carried with it — a copy of what the author sees.
  const copy = {
    ...source,
    ...(name === undefined ? {} : { name }),
    variables: source.variables.map((value, i) =>
      name !== undefined && i === NAME_VARIABLE ? namesAt + 4 : value,
    ),
    variableSelectors: [...source.variableSelectors],
    variablesAt: { resource: 'code' as const, offset: copyAt + 4 + SCI0_OBJECT_BIAS },
    methods: [],
  };
  // Written into the copy's bytes too, so the new block is the object the
  // author sees rather than the one the original bytes held.
  for (const [i, value] of copy.variables.entries()) {
    putU16(out, copy.variablesAt.offset + i * 2, value & 0xffff);
  }

  return {
    ...script,
    bytes: toBase64(out),
    objects: [...script.objects, copy],
    addedObjects: [
      ...(script.addedObjects ?? []),
      { at: copyAt, relocations: inside.length, ...(nameBlock > 0 ? { name: nameBlock } : {}) },
    ],
  };
}

/** Where the object an addition recorded keeps its property words. */
function variablesOf(entry: NonNullable<SciProjectScript['addedObjects']>[number]): number {
  return entry.resource === 'heap' || entry.resource === 'sci3'
    ? entry.at + 4
    : entry.at + 4 + SCI0_OBJECT_BIAS;
}

/** Whether `index` names an instance this editor added. */
export function isAddedSciInstance(script: SciProjectScript, index: number): boolean {
  const object = script.objects[index];
  return (script.addedObjects ?? []).some(
    (entry) =>
      object?.variablesAt?.resource === (entry.resource === 'heap' ? 'heap' : 'code') &&
      object.variablesAt.offset === variablesOf(entry),
  );
}

/** Whether `index` names the instance this editor added most recently. */
export function isLastAddedSciInstance(script: SciProjectScript, index: number): boolean {
  const added = script.addedObjects ?? [];
  const lastAdded = added[added.length - 1];
  const object = script.objects[index];
  return (
    lastAdded !== undefined &&
    object?.variablesAt?.resource === (lastAdded.resource === 'heap' ? 'heap' : 'code') &&
    object.variablesAt.offset === variablesOf(lastAdded)
  );
}

/**
 * The script with the most recently added instance removed, or a sentence.
 *
 * The exact inverse of `addSciInstance`: the block and the relocation entries
 * that came with it go, and the relocation block's count and size shrink back.
 */
export function deleteSciInstance(
  script: SciProjectScript,
  index: number,
): SciProjectScript | string {
  const object = script.objects[index];
  if (!object) return `there is no object ${index} in script ${script.number}`;
  if (!isLastAddedSciInstance(script, index)) {
    return (
      `${object.name} was not added by this editor, or was not added last. Delete removes the ` +
      `most recent instance this editor appended: anything the game shipped may be named by an ` +
      `export, a dispatch or another script, and nothing in a script says which`
    );
  }

  const added = script.addedObjects!;
  const last = added[added.length - 1];
  if (last.resource === 'sci3') {
    return deleteSci3Instance(script, index, {
      at: last.at,
      relocations: last.relocations,
      resource: 'sci3',
      length: last.length ?? 0,
      name: last.name ?? 0,
    });
  }
  if (last.resource === 'heap') {
    return deleteSciHeapInstance(script, index, {
      at: last.at,
      relocations: last.relocations,
      resource: 'heap',
      length: last.length ?? 0,
      name: last.name ?? 0,
    });
  }
  const { at, relocations } = last;
  const original = fromBase64(script.bytes);
  const length = u16(original, at + 2);
  if (SCI_BLOCK_TYPES[u16(original, at)] !== 'object' || length < 4) {
    return `the block recorded for ${object.name} is not an object block any more`;
  }
  // The strings block a name was written into, straight after the copy.
  const span = length + (last.name ?? 0);

  let out = new Uint8Array(original.length - span);
  out.set(original.subarray(0, at), 0);
  out.set(original.subarray(at + span), at);

  if (relocations > 0) {
    const blocks = readSci0Blocks(out, sci0ScriptBias(out));
    const pointers = blocks.find((candidate) => candidate.type === 'pointers');
    if (!pointers) return `script ${script.number}'s relocation block is gone`;
    const count = u16(out, pointers.offset);
    const entriesEnd = pointers.offset + 2 + count * 2;
    const drop = relocations * 2;
    const shrunk = new Uint8Array(out.length - drop);
    shrunk.set(out.subarray(0, entriesEnd - drop), 0);
    shrunk.set(out.subarray(entriesEnd), entriesEnd - drop);
    putU16(shrunk, pointers.offset, count - relocations);
    putU16(shrunk, pointers.offset - 2, pointers.size + 4 - drop);
    out = shrunk;
  }

  return {
    ...script,
    bytes: toBase64(out),
    objects: script.objects.filter((_, each) => each !== index),
    addedObjects: added.slice(0, -1),
  };
}
