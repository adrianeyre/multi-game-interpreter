/**
 * Importing a SCI game into a Project: the class graph, by name.
 *
 * ADR 0018. What makes this different from either sibling is not the amount of
 * work but the *shape* of what comes out: a SCI Project holds classes, their
 * Selectors, their methods and their instances by name, and the assembler that
 * writes it back is a **linker** rather than an emitter.
 *
 * **Bytes are kept beside the graph, and that is not redundancy.** A Script
 * resource nobody edits must come back exactly as it arrived — `Unrecovered`
 * counts a resource that "re-emitted as different bytes than it arrived as",
 * with a target of zero — and the cheapest way to guarantee that is not to
 * rebuild it. The linker runs for the ones that changed. ADR 0010 reached the
 * same conclusion for SCUMM; this is that reasoning in a third family.
 */

import { toBase64 } from '../base64.js';
import type {
  SciProject,
  SciProjectMethod,
  SciProjectObject,
  SciProjectScript,
} from '../project.js';
import type { SciResources } from '../../engine/sci/resource/SciResources.js';
import type { DetectedSciGame } from '../../engine/sci/resource/sciDetect.js';
import { decodeSciInstruction } from '../../engine/sci/script/opcodes.js';
import { readSelectorTable, readClassTable } from '../../engine/sci/script/selectors.js';
import {
  readSci0Blocks,
  readSci0Exports,
  readSci0Methods,
  readSci0Object,
  sci0ScriptBias,
  type SciBlock,
  type SciMethod,
} from '../../engine/sci/script/scriptResource.js';
import { SCI_RESOURCE_TYPES } from '../../engine/sci/resource/sciResourceTypes.js';
import { readSciMessages, audio36Number } from '../../engine/sci/resource/sciMessage.js';
import { sciPictureKind } from '../../engine/sci/gfx/pictureKind.js';
import { readSciCelPicture } from '../../engine/sci/gfx/SciCelPicture.js';
import {
  readSci11Script,
  readSci3Script,
  sci11CodeEnd,
} from '../../engine/sci/script/scriptResource.js';
import {
  atLeast,
  describeSciVersion,
  selectorIdCarriesReadWriteBit,
  type SciVersion,
} from '../../engine/sci/sciVersion.js';

export interface SciImportOptions {
  onProgress?: (done: number, total: number, what: string) => void;
}

/**
 * Builds a Project from a loaded SCI game.
 *
 * Refuses nothing here: whether this game may be edited at all is a property of
 * its Target and is asked *before* the work (ADR 0013), by
 * `describeEditRefusal`. Reaching this function means the answer was yes.
 */
export async function importSciGame(
  game: DetectedSciGame,
  resources: SciResources,
  options: SciImportOptions = {},
): Promise<SciProject> {
  const selectorBytes = await resources.read('vocab', 997);
  // **Two views of one table, and they are different lengths.**
  //
  // `selectors` is the resource as the game ships it, and it is what the
  // Project carries — `exportSciGame` compares its length against the shipped
  // one to decide whether the table has to be rewritten, and a doubled copy
  // would look like growth and rewrite a byte-identical resource every time.
  //
  // `naming` is the numbering a script's *bytecode* uses, which in SCI0 early
  // is the same names at twice the indices: Sierra spent the low bit of a
  // Selector ID on a read/write toggle. Naming a method off the undoubled view
  // called King's Quest IV's `play` `selector84` and named nothing at all past
  // 254.
  const selectors = selectorBytes ? readSelectorTable(selectorBytes).names : [];
  const naming = selectorBytes
    ? readSelectorTable(selectorBytes, {
        lsbToggle: selectorIdCarriesReadWriteBit(game.version),
      }).names
    : [];
  const classBytes = await resources.read('vocab', 996);
  const classes = classBytes
    ? readClassTable(classBytes).map((entry, number) => ({ number, script: entry.script }))
    : [];

  const scriptNumbers = resources.list('script');
  const scripts: SciProjectScript[] = [];
  let unrecovered = 0;

  for (const [index, number] of scriptNumbers.entries()) {
    options.onProgress?.(index, scriptNumbers.length, `script ${number}`);
    const bytes = await resources.read('script', number);
    if (!bytes) {
      unrecovered++;
      scripts.push({
        number,
        objects: [],
        exports: [],
        locals: [],
        bytes: '',
        unrecovered: 'could not be read from its Volume',
      });
      continue;
    }

    // The heap, where there is one. Its presence is what says which layout
    // this script is in — the same three-way test the heap-split probe makes
    // (#216) — rather than the Version, which for most releases is a guess.
    const heap = await resources.read('heap', number);
    const script = heap
      ? readHeapScript(number, bytes, heap, naming, game.version)
      : readSci0Blocks(bytes, sci0ScriptBias(bytes)).length > 0
        ? readScript(number, bytes, naming, game.version)
        : // No heap and no block chain. On a SCI3 game that is the third
          // layout — the Script resource folds its objects back in behind a
          // fixed header, which ADR 0017 predicted would cost a reader rather
          // than a decoder. On anything earlier it is not: it is a script this
          // project could not read, and **saying "a SCI3 layout" about a SCI1
          // game is a wrong answer rather than a missing one.**
          //
          // Quest for Glory II and the Christmas Card 1990 demo were reporting
          // exactly that for 25 scripts between them, which sent a reader
          // looking at the SCI3 header code for a fault that is not there.
          atLeast(game.version, 'sci3')
          ? readSci3ScriptGraph(number, bytes, selectors, game.version)
          : {
              number,
              objects: [],
              exports: [],
              locals: [],
              bytes: toBase64(bytes),
              unrecovered:
                `no block chain, and this game is ${describeSciVersion(game.version)} rather ` +
                `than SCI3, so there is no other layout to try`,
            };
    if (script.unrecovered) unrecovered++;
    scripts.push(script);
  }

  // Everything that is not a Script resource, carried through as bytes. Views,
  // fonts, cursors and vocabularies are editable as themselves (#220's last
  // criterion) and each needs its own surface; carrying the bytes is what makes
  // the round trip exact until those surfaces exist, rather than what makes
  // them unnecessary.
  //
  // Pictures are the exception, and it is ADR 0018's exception: they are split
  // into two kinds *here*, by what each resource is, because the split is the
  // decision and putting it off until the editor opens one would mean the
  // editor deciding it.
  const resourceEntries: SciProject['resources'] = [];
  const vectorPictures: SciProject['vectorPictures'] = [];
  const celPictures: SciProject['celPictures'] = [];

  for (const type of SCI_RESOURCE_TYPES) {
    if (type === 'script' || type === 'heap') continue;
    for (const number of resources.list(type)) {
      const bytes = await resources.read(type, number);
      if (!bytes) {
        unrecovered++;
        continue;
      }
      const entry = { type, number, bytes: toBase64(bytes) };
      if (type !== 'pic') {
        resourceEntries.push(entry);
        continue;
      }
      const kind = sciPictureKind(bytes);
      if (kind === 'vector') vectorPictures.push(entry);
      else if (kind === 'cel') {
        // Read as a composition now rather than when the editor opens it, for
        // the same reason the kind is decided here: the editor should be handed
        // a decision, not asked to make one (ADR 0018).
        const composition = readSciCelPicture(bytes);
        celPictures.push({
          ...entry,
          container: composition.container,
          resolution: composition.resolution,
          hasVectors: (composition.vectorData?.length ?? 0) > 1,
          items: composition.cels.map((placed, index) => ({
            // The cel headers sit end to end after the container's own header,
            // which is what makes an item's position a fixed place in the file.
            headerAt:
              composition.container === 'sci32'
                ? (bytes[0] | (bytes[1] << 8)) + 42 * index
                : (bytes[32] | (bytes[33] << 8) | (bytes[34] << 16) | (bytes[35] << 24)) >>> 0,
            width: placed.cel.width,
            height: placed.cel.height,
            x: placed.x,
            y: placed.y,
            priority: placed.priority,
          })),
          ...(composition.unknown ? { unrecovered: composition.unknown.why } : {}),
        });
        // A Picture whose composition could not be read whole is a resource
        // that did not come back as what it was, whatever its bytes do.
        if (composition.unknown) unrecovered++;
      } else {
        // Neither shape. Held with everything else and read-only, rather than
        // being handed to an editor that would misread it — and counted,
        // because a Picture nobody can open is a resource that did not come
        // back as what it was.
        resourceEntries.push(entry);
        unrecovered++;
      }
    }
  }

  nameInstanceProperties(scripts, classes);

  const messages = await readMessages(resources);
  const languages = detectLanguages(resources);

  return {
    identification: { how: game.identification, evidence: game.notes },
    version: game.version,
    selectors,
    classes,
    scripts,
    resources: resourceEntries,
    vectorPictures,
    celPictures,
    messages,
    languages,
    unrecoveredCount: unrecovered,
  };
}

/**
 * Gives an instance the property names its class declares.
 *
 * **From SCI1.1 on, only a class carries a property-name table.** An instance's
 * heap record is the values and nothing else, because the engine reaches the
 * names through the species — so a reader that stops at the record leaves every
 * instance's properties unnamed while every class's are named, and an author
 * looking at `rm15` sees a column of numbers where `Rm` shows `picture`,
 * `style`, `horizon`. Over King's Quest VII that is 2,663 of 2,821 objects.
 *
 * Resolved here rather than in `readHeapScript` because the class may be in a
 * script that has not been read yet: `vocab.996` says which script holds each
 * species, and the answer is only complete once every script is in.
 *
 * **An instance is found by its superclass, not by its species.** On disk an
 * instance's `-species-` is `0xffff` — the engine fills it in when the script
 * loads — and the class number is in `-super-`. A resolver that reads
 * `-species-` finds nothing for every instance in the game and reports it as
 * "this class has no table", which is the wrong fault entirely.
 *
 * The class's list is taken as far as the instance has values and no further. A
 * subclass declares its own properties after the ones it inherits, so a shorter
 * list names a prefix correctly and an instance with more values than its class
 * has names keeps the rest unnamed rather than borrowing a name from the wrong
 * slot.
 */
function nameInstanceProperties(
  scripts: SciProjectScript[],
  classes: readonly { number: number; script: number }[],
): void {
  const byScript = new Map<number, SciProjectScript>();
  for (const script of scripts) byScript.set(script.number, script);

  const classByNumber = new Map<number, SciProjectObject>();
  for (const entry of classes) {
    const script = byScript.get(entry.script);
    const held = script?.objects.find(
      (object) => object.isClass && object.species === entry.number,
    );
    if (held) classByNumber.set(entry.number, held);
  }

  /**
   * The nearest ancestor with a table, walked rather than assumed.
   *
   * A subclass's table already repeats everything it inherits, so one hop is
   * usually enough — but a class whose own table could not be read would
   * otherwise leave every instance below it unnamed, and the grandparent's
   * names are still right for the properties it declares.
   */
  const namesFor = (from: number): number[] | undefined => {
    let at: number | undefined = from;
    for (let hops = 0; at !== undefined && hops < 32; hops++) {
      const held = classByNumber.get(at);
      if (!held) return undefined;
      if (held.variableSelectors.length > 0) return held.variableSelectors;
      at = held.superClass;
    }
    return undefined;
  };

  for (const script of scripts) {
    for (const object of script.objects) {
      if (object.variableSelectors.length > 0) continue;
      const names = namesFor(object.superClass);
      if (!names) continue;
      object.variableSelectors = names.slice(0, object.variables.length);
    }
  }
}

/**
 * Reads every Message, with its speech and its mouth timing found by key.
 *
 * By key, not by a parallel index. `audio36` and `sync36` are numbered by an
 * encoding of the same (noun, verb, condition, sequence) tuple, so a Message's
 * three faces are one lookup rather than three lists that have to stay in the
 * same order — which is the mistake #222 names and which would show up as a
 * translation with the right words and the wrong lip sync.
 */
async function readMessages(resources: SciResources): Promise<SciProject['messages']> {
  const audio = new Set(resources.list('audio36'));
  const sync = new Set(resources.list('sync36'));
  const messages: SciProject['messages'] = [];

  for (const number of resources.list('message')) {
    const bytes = await resources.read('message', number);
    if (!bytes) continue;
    for (const message of readSciMessages(bytes).messages) {
      const key = audio36Number(message);
      messages.push({
        resource: number,
        noun: message.noun,
        verb: message.verb,
        cond: message.cond,
        seq: message.seq,
        talker: message.talker,
        text: message.text,
        audio: audio.has(key) ? key : undefined,
        sync: sync.has(key) ? key : undefined,
      });
    }
  }
  return messages;
}

/**
 * Which languages a release ships, from the numbering of its own resources.
 *
 * Sierra offsets a translated resource's number by the language's number times
 * a thousand — so English text 300 becomes 1300 in the first alternate
 * language. Reading only the base numbers imports one language and discards the
 * rest, which is silent data loss and, by this project's own definitions,
 * `Unrecovered`.
 *
 * Detected rather than declared, because a release does not say anywhere how
 * many languages it has: the evidence is that its resource numbers run past
 * 1000.
 */
function detectLanguages(resources: SciResources): SciProject['languages'] {
  const numbers: number[] = [];
  for (const type of ['message', 'text', 'font'] as const) numbers.push(...resources.list(type));
  return detectLanguagesFrom(numbers);
}

/** The same, over resource numbers alone, so it can be checked without a game. */
export function detectLanguagesFrom(numbers: readonly number[]): SciProject['languages'] {
  const counts = new Map<number, number>();
  for (const number of numbers) {
    const language = Math.floor(number / 1000);
    counts.set(language, (counts.get(language) ?? 0) + 1);
  }

  const names: Record<number, string> = {
    0: 'the release language',
    1: 'French',
    2: 'Spanish',
    3: 'Italian',
    4: 'German',
    5: 'English',
    6: 'Japanese',
    7: 'Portuguese',
  };

  return [...counts]
    .sort((a, b) => a[0] - b[0])
    .map(([number, resourceCount]) => ({
      number,
      name: names[number] ?? `language ${number}`,
      resourceCount,
    }));
}

/**
 * Reads a SCI3 Script resource into a graph.
 *
 * The layout that made #229 the cheap shape rather than the expensive one: the
 * objects moved and the *encoding* did not, so this is a reader and there is no
 * second Script engine (#214).
 *
 * A 22-byte header with the code, string and relocation offsets as 32-bit words
 * at 0, 4 and 8; a locals count at 12; an export count at 20 and the table at
 * 22. Objects are found arithmetically rather than by scanning — past the
 * export table and the locals array, each padded to a four-byte boundary —
 * which is why getting the padding wrong finds no objects at all rather than
 * finding wrong ones.
 */
/**
 * A SCI3 object's methods, which are in a selector bank rather than a table.
 *
 * **The reason row 21 failed on SCI3 alone, and it was one missing reader.**
 * SCI0 and SCI1.1 put an object's methods in a dictionary — a count and then
 * `(selector, offset)` pairs — and SCI3 does not. It carries a **256-byte
 * selector bank** after a 16-byte header, one byte per group of 32 selectors,
 * holding a *one-based* index into the 64-byte groups that follow. A group is a
 * 32-bit type mask and then thirty-two words; a bit set in the mask makes that
 * word a property's value, a bit clear makes it a method's offset, and `0xffff`
 * means the selector is not defined on this object at all.
 *
 * Two details are Sierra's and both matter (`Object::initSelectorsSci3`):
 *
 * **Bits 0 and 1 of every group are not selectors.** Their four bytes *are* the
 * type mask, so SCI3 has no selector numbered 0, 1, 32, 33 and so on — a reader
 * that starts at bit 0 finds two spurious entries in every group it touches.
 *
 * **A method's stored word is relative to the code**, not to the resource:
 * `methodOffset = value + codeOffset`, where the code's start is the resource's
 * own first 32-bit word. Read as an absolute offset it lands in the object
 * table for every script.
 *
 * How many groups there are is a property of the *game's* Selector table rather
 * than of the object, which is why the count is passed in: 32 selectors to a
 * group, rounded up.
 */
export function readSci3Methods(
  bytes: Uint8Array,
  objectAt: number,
  selectorCount: number,
  codeAt: number,
): Array<{ selector: number; offset: number }> {
  const OBJECT_HEADER = 16;
  const BANK = 256;
  const GROUP = 64;
  const IN_GROUP = 32;

  const u16 = (at: number): number => bytes[at] | (bytes[at + 1] << 8);
  const u32 = (at: number): number =>
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

  const bankAt = objectAt + OBJECT_HEADER;
  const groupsAt = bankAt + BANK;
  if (groupsAt > bytes.length) return [];

  const groups = Math.ceil(selectorCount / IN_GROUP);
  const methods: Array<{ selector: number; offset: number }> = [];

  for (let bank = 0; bank < groups && bankAt + bank < bytes.length; bank++) {
    const index = bytes[bankAt + bank];
    if (index === 0) continue;
    const group = groupsAt + (index - 1) * GROUP;
    if (group + GROUP > bytes.length) continue;
    const typeMask = u32(group);

    // From bit 2: the first two words of a group are the type mask itself.
    for (let bit = 2; bit < IN_GROUP; bit++) {
      const value = u16(group + bit * 2);
      if ((typeMask & (1 << bit)) !== 0) continue; // a property
      if (value === 0xffff) continue; // not defined here
      methods.push({ selector: bank * IN_GROUP + bit, offset: value + codeAt });
    }
  }
  return methods;
}

function readSci3ScriptGraph(
  number: number,
  bytes: Uint8Array,
  selectors: string[],
  version: SciVersion,
): SciProjectScript {
  const kept = toBase64(bytes);
  let header;
  try {
    header = readSci3Script(bytes);
  } catch (error) {
    return {
      number,
      objects: [],
      exports: [],
      locals: [],
      bytes: kept,
      unrecovered: error instanceof Error ? error.message : String(error),
    };
  }

  const u16 = (at: number): number => bytes[at] | (bytes[at + 1] << 8);
  const objects: SciProjectObject[] = [];
  let at = header.objectsAt;

  while (at + 4 <= bytes.length && u16(at) === 0x1234) {
    const words = u16(at + 2);
    if (words < 2 || at + words * 2 > bytes.length) break;
    const variables: number[] = [];
    for (let i = 0; i < words - 2; i++) variables.push(u16(at + 4 + i * 2));

    // **The methods, which used to be an empty list.** SCI3 keeps them in a
    // selector bank rather than a dictionary, so nothing read them and row 21
    // of `docs/editor-parity.md` failed on SCI3 for that one reason. Bounded by
    // the code region the header names, because a SCI3 resource holds its
    // objects, strings and relocations in the same file as its code and a body
    // read past the end of the code decodes a relocation table as instructions.
    const found = readSci3Methods(bytes, at, selectors.length, header.codeAt);
    const codeBlock: SciBlock[] = [
      { type: 'code', offset: header.codeAt, size: Math.max(0, header.stringsAt - header.codeAt) },
    ];
    const entryPoints = [...new Set(found.map((method) => method.offset))].sort((a, b) => a - b);
    const methods = found.map((method) =>
      readMethod(bytes, method.selector, method.offset, selectors, codeBlock, entryPoints, version),
    );

    objects.push({
      name: `object${variables[3] ?? 0}`,
      isClass: ((variables[5] ?? 0) & 0x8000) !== 0,
      species: variables[3] ?? 0,
      superClass: variables[4] ?? 0,
      variables,
      variableSelectors: [],
      // SCI3 puts the objects back in the Script resource, so a property word
      // is written where it was read: four bytes past the `0x1234` marker.
      variablesAt: { resource: 'code', offset: at + 4 },
      methods,
    });
    at += words * 2;
  }

  const localsOffset = 22 + header.exports.length * 2;
  const localsAt = localsOffset % 4 === 0 ? localsOffset : localsOffset + (4 - (localsOffset % 4));
  const locals: number[] = [];
  for (let i = 0; i < header.localCount; i++) locals.push(u16(localsAt + i * 2));

  return {
    number,
    objects,
    exports: header.exports,
    locals,
    localsAt: { resource: 'code', offset: localsAt },
    bytes: kept,
    unrecovered:
      objects.length === 0
        ? 'a SCI3 layout whose object list did not start where the header says'
        : undefined,
  };
}

/**
 * Reads a SCI1.1 Script resource — a code and heap pair — into a graph.
 *
 * The layout ADR 0017 named as varying *outside* the encoding, and this is what
 * that costs: a different reader, not a different decoder. The two resources
 * are concatenated with the heap word-aligned, and every pointer in the heap is
 * 16-bit into that combined space.
 *
 * **Both resources are kept.** A round trip has to write back two resources,
 * not one, and reconstructing the split from a combined buffer would put the
 * word of alignment padding in the wrong half for any script whose code is an
 * odd number of bytes.
 */
function readHeapScript(
  number: number,
  code: Uint8Array,
  heap: Uint8Array,
  selectors: string[],
  version: SciVersion,
): SciProjectScript {
  const script = readSci11Script(code, heap);
  const { buffer, heapAt } = script;
  const u16 = (at: number): number => buffer[at] | (buffer[at + 1] << 8);

  const localCount = u16(heapAt + 2);
  const locals: number[] = [];
  for (let i = 0; i < localCount; i++) locals.push(u16(heapAt + 4 + i * 2));
  // Heap-relative, because that is the resource the export writes them into.
  const localsAt = 4;

  // **The objects are read in two passes, because a body's end is a property
  // of the script and not of the method.**
  //
  // `readMethod` bounds a body at the next entry point after it, and at SCI1.1
  // the entry points are scattered across every object's own dictionary — so
  // the first object cannot be disassembled until the last one's dictionary
  // has been read. Reading each object's methods as the object is met instead
  // would run every body to the end of the code resource, which is correct to
  // *display* and useless to *write*: the linker cannot place two bodies that
  // claim the same bytes, and at SCI1.1 they all would.
  const headers: { at: number; words: number; variables: number[] }[] = [];
  let at = heapAt + 4 + localCount * 2;
  while (at + 4 <= buffer.length && u16(at) === 0x1234) {
    const words = u16(at + 2);
    if (words < 2 || at + words * 2 > buffer.length) break;
    const variables: number[] = [];
    for (let i = 0; i < words - 2; i++) variables.push(u16(at + 4 + i * 2));
    headers.push({ at, words, variables });
    at += words * 2;
  }

  // One synthetic block covering the code resource, because at SCI1.1 there is
  // no block chain to bound a body with — the code resource *is* the block, and
  // the heap is a separate resource that no method offset ever points into.
  //
  // **It stops at the relocation table, not at the end of the resource.** The
  // last thing in a SCI1.1 code resource is a list of `lofs` operand positions,
  // and a body bounded at `code.length` runs into it and decodes a run of
  // ascending pointers as instructions — 85 of King's Quest VII's 3,929 methods
  // did, which is 85 scripts the linker then refused to leave untouched.
  const codeEnd = sci11CodeEnd(code);
  const codeBlock: SciBlock[] = [{ type: 'code', offset: 0, size: codeEnd }];
  const entries = new Set<number>();
  // **An export that names an object is measured from the heap, and taking it
  // for a code offset puts a boundary in the middle of a method.** A SCI1.1
  // export table holds code offsets for procedures and heap offsets for
  // objects in one undistinguished list, and a heap offset is a small number
  // that lands inside the code resource as readily as a real entry point does.
  // An entry is an object exactly when adding the heap's start lands on one.
  const objectExports = new Set(headers.map((header) => header.at - heapAt));
  for (const entry of script.exports) {
    if (entry > 0 && entry < codeEnd && !objectExports.has(entry)) entries.add(entry);
  }
  for (const header of headers) {
    for (const method of readHeapMethods(buffer, header.variables[1] ?? 0, codeEnd)) {
      entries.add(method.offset);
    }
    // **The dictionaries are in the code resource, between the methods.** At
    // SCI0 the block chain says where code ends; at SCI1.1 there is no chain,
    // and an object's method dictionary and property-name table sit in the same
    // resource as the bodies. A body bounded only by the next *method* runs
    // through whichever table follows it and decodes a Selector number as an
    // opcode — 85 of King's Quest VII's 3,929 methods, reported as unused
    // opcodes and overruns that are neither.
    //
    // They are boundaries and not entry points: nothing starts here, and a body
    // ends here.
    for (const at of [header.variables[0] ?? 0, header.variables[1] ?? 0]) {
      if (at > 0 && at < codeEnd) entries.add(at);
    }
  }
  const entryPoints = [...entries].sort((a, b) => a - b);

  const objects: SciProjectObject[] = [];
  for (const { at, words, variables } of headers) {
    // A SCI1.1 class names each of its properties in a table in the *code*
    // resource, pointed at by its first variable; an instance shares its
    // class's and carries none. The table names every property including the
    // two in the header, and `variables` starts past them — so the two lists
    // line up only after the first two entries are dropped. Getting that wrong
    // names every property two slots early and leaves the last two unnamed.
    const propertySelectors: number[] = [];
    const propertyDictionary = variables[0] ?? 0;
    if (((variables[5] ?? 0) & 0x8000) !== 0 && propertyDictionary > 0) {
      for (let entry = 2; entry < words; entry++) {
        const from = propertyDictionary + entry * 2;
        if (from + 2 > codeEnd) break;
        propertySelectors.push(u16(from));
      }
    }

    const methods: SciProjectMethod[] = [];
    for (const method of readHeapMethods(buffer, variables[1] ?? 0, codeEnd)) {
      methods.push(
        readMethod(
          buffer,
          method.selector,
          method.offset,
          selectors,
          codeBlock,
          entryPoints,
          version,
        ),
      );
    }

    objects.push({
      // SCI1.1 drops the three leading Selectors, so the fixed fields move:
      // ScummVM puts `-info-` at byte 14 and the name pointer at 16 rather than
      // at SCI0's 4 and 6.
      // The name pointer is an offset into the *heap*, not into the combined
      // buffer — the heap's own pointers are relative to where it starts, which
      // is what lets a script's code and its heap be separate resources at all.
      // Read as a combined offset it lands in the code and resolves to nothing
      // for all but the handful of objects whose pointer happens to be large.
      name: readName(buffer, heapAt + (variables[6] ?? 0)) ?? `object${variables[3] ?? 0}`,
      // The class bit of `-info-`, which is how an instance and a class are
      // told apart at SCI1.1 — there is no block type to read it from.
      isClass: ((variables[5] ?? 0) & 0x8000) !== 0,
      species: variables[3] ?? 0,
      superClass: variables[4] ?? 0,
      variables,
      variableSelectors: propertySelectors,
      // Relative to the heap resource rather than to the combined buffer the
      // reader walks, because the export writes the heap back as its own file
      // — the same reason the name pointer is read heap-relative above.
      variablesAt: { resource: 'heap', offset: at - heapAt + 4 },
      methods,
    });
  }

  return {
    number,
    objects,
    exports: script.exports,
    locals,
    localsAt: { resource: 'heap', offset: localsAt },
    bytes: toBase64(code),
    heapBytes: toBase64(heap),
  };
}

/**
 * A SCI1.1 object's method dictionary: a count, then (Selector, offset) pairs.
 *
 * The pointer is the object's *second* variable and not its first — the first
 * points at the property-name table, and reading that one yields property
 * counts where offsets are expected. The dictionary lives in the code
 * resource, so both the pointer and every offset it yields are bounded by the
 * code's length; a pair that falls outside is a pointer read out of something
 * that is not a dictionary, and the dictionary is skipped rather than clamped.
 *
 * The pair layout is what differs from SCI0, where the Selectors and the
 * offsets are two separate runs with a zero word between them.
 */
function readHeapMethods(buffer: Uint8Array, dictionary: number, codeLength: number): SciMethod[] {
  const u16 = (at: number): number => buffer[at] | (buffer[at + 1] << 8);
  if (dictionary <= 0 || dictionary + 2 > codeLength) return [];
  const count = u16(dictionary);
  if (count === 0 || count > 512 || dictionary + 2 + count * 4 > codeLength) return [];

  const methods: SciMethod[] = [];
  for (let entry = 0; entry < count; entry++) {
    const selector = u16(dictionary + 2 + entry * 4);
    const offset = u16(dictionary + 2 + entry * 4 + 2);
    if (offset > 0 && offset < codeLength) methods.push({ selector, offset });
  }
  return methods;
}

/**
 * Reads one Script resource into a graph.
 *
 * The inline layout only — SCI0 and SCI1. SCI1.1's code and heap pair and
 * SCI3's fixed header are different readers (#222, #229), and a script this
 * cannot read is recorded as `Unrecovered` with its bytes kept rather than
 * being read approximately. An approximate class graph is worse than none: it
 * exports as a game that boots and behaves differently.
 */
function readScript(
  number: number,
  bytes: Uint8Array,
  selectors: string[],
  version: SciVersion,
): SciProjectScript {
  const kept = toBase64(bytes);
  const bias = sci0ScriptBias(bytes);
  const blocks = readSci0Blocks(bytes, bias);

  if (blocks.length === 0) {
    return {
      number,
      objects: [],
      exports: [],
      locals: [],
      bytes: kept,
      unrecovered: 'no block chain — a SCI1.1 heap pair or a SCI3 layout',
    };
  }

  // **Every entry point in the script, before any body is read.**
  //
  // A method's body ends where the next one begins, and "the next one" is not
  // knowable from the method itself — it is a property of the script. Running
  // each body to the end of its code block instead is what the first version
  // did, and it made every method in a block overlap every method after it:
  // correct to *read*, because the instructions are the same either way, and
  // useless to *write*, because the linker cannot place two bodies that claim
  // the same bytes. Eighteen of Space Quest III's twenty-two scripts were
  // refused for exactly that.
  const entries = entryPointsOf(bytes, blocks);

  const objects: SciProjectObject[] = [];
  for (const block of blocks) {
    if (block.type !== 'object' && block.type !== 'class') continue;
    const object = readObject(
      bytes,
      block,
      block.type === 'class',
      selectors,
      blocks,
      entries,
      version,
    );
    if (object) objects.push(object);
  }

  const locals: number[] = [];
  const localsBlock = blocks.find((block) => block.type === 'locals');
  if (localsBlock) {
    for (let at = localsBlock.offset; at + 1 < localsBlock.offset + localsBlock.size; at += 2) {
      locals.push(bytes[at] | (bytes[at + 1] << 8));
    }
  }

  return {
    number,
    objects,
    exports: readSci0Exports(bytes, blocks),
    locals,
    localsAt: localsBlock ? { resource: 'code', offset: localsBlock.offset } : undefined,
    bytes: kept,
  };
}

function readObject(
  script: Uint8Array,
  block: SciBlock,
  isClass: boolean,
  selectors: string[],
  blocks: readonly SciBlock[],
  entryPoints: readonly number[],
  version: SciVersion,
): SciProjectObject | null {
  const layout = readSci0Object(script, block);
  if (!layout) return null;
  const u16 = (at: number): number => script[at] | (script[at + 1] << 8);

  const variables: number[] = [];
  for (let i = 0; i < layout.variableCount; i++) variables.push(u16(layout.at + i * 2));

  const variableSelectors: number[] = [];
  if (isClass) {
    const selectorsAt = layout.at + layout.variableCount * 2;
    for (let i = 0; i < layout.variableCount; i++) {
      variableSelectors.push(u16(selectorsAt + i * 2));
    }
  }

  const code = blocks.filter((candidate) => candidate.type === 'code');
  const methods: SciProjectMethod[] = [];
  for (const method of readSci0Methods(script, layout.methodsAt)) {
    methods.push(
      readMethod(script, method.selector, method.offset, selectors, code, entryPoints, version),
    );
  }

  return {
    // The name is at Selector 3 at SCI0 and SCI1 — `species`, `superClass`,
    // `-info-`, `name` — and it is a pointer into the script's own strings, so
    // a generated name is used where the pointer is null rather than where the
    // string is empty.
    name: readName(script, variables[3]) ?? `${isClass ? 'class' : 'object'}${variables[0] ?? 0}`,
    isClass,
    species: variables[0] ?? 0,
    superClass: variables[1] ?? 0,
    variables,
    variableSelectors,
    // Before SCI1.1 the object is a block of the Script resource itself, and
    // `layout.at` is where its property words start.
    variablesAt: { resource: 'code', offset: layout.at },
    methods,
  };
}

/**
 * Every offset in the script that some dispatch table or export points at.
 *
 * Sorted, so a body's end is the first one after its start. Exports are
 * included as well as methods, because an export may point into the middle of
 * a code block at something no method claims — and a body that ran through one
 * would swallow code another script calls.
 */
function entryPointsOf(script: Uint8Array, blocks: readonly SciBlock[]): number[] {
  const points = new Set<number>(readSci0Exports(script, blocks));

  for (const block of blocks) {
    if (block.type !== 'object' && block.type !== 'class') continue;
    const layout = readSci0Object(script, block);
    if (!layout) continue;
    for (const method of readSci0Methods(script, layout.methodsAt)) points.add(method.offset);
  }
  return [...points].sort((a, b) => a - b);
}

/**
 * Disassembles one method body.
 *
 * A body ends where its code block does or at a `ret` that nothing jumps past,
 * and neither is knowable without following the branches — so the honest bound
 * is the enclosing code block, and a body that runs to the block's end is not
 * an error. What *is* an error is an opcode Sierra left unused, which means the
 * boundaries desynchronised, and that is recorded as `Unrecovered` on the
 * method rather than being dropped.
 */
function readMethod(
  script: Uint8Array,
  selectorNumber: number,
  offset: number,
  selectors: string[],
  code: readonly SciBlock[],
  entryPoints: readonly number[],
  version: SciVersion,
): SciProjectMethod {
  const block = code.find(
    (candidate) => offset >= candidate.offset && offset < candidate.offset + candidate.size,
  );
  const selector = selectors[selectorNumber] ?? `selector${selectorNumber}`;

  if (!block) {
    return {
      selector,
      selectorNumber,
      offset,
      instructions: [],
      unrecovered: `offset ${offset} is not inside any code block`,
    };
  }

  const instructions: SciProjectMethod['instructions'] = [];
  // The next entry point inside this block, or the block's end. That is what
  // makes a body a *span* rather than a tail, and it is what the linker needs:
  // two bodies that claim the same bytes cannot both be written back.
  const blockEnd = block.offset + block.size;
  /**
   * The next entry point inside this block that the instruction stream agrees
   * is one.
   *
   * **An entry point can be wrong, and the code says so.** King's Quest IV's
   * script 120 exports offset 1878, which is one byte inside the `pushi 354`
   * at 1877 — a broken entry in Sierra's own table, of the same family as the
   * two export blocks ScummVM works around in script 306. Taking it as the end
   * of the method that starts at 566 truncated a body that decodes perfectly,
   * and reported the *method* as Unrecovered when the fault was in the table.
   *
   * So a candidate that an instruction straddles is refuted and the search
   * moves on. Nothing is assumed about which is right: the bytes decide, and a
   * boundary the walk actually lands on is the only kind kept.
   */
  const nextBoundaryAfter = (from: number): number =>
    entryPoints.find((point) => point > from && point < blockEnd) ?? blockEnd;
  let end = nextBoundaryAfter(offset);
  let at = offset;
  let unrecovered: string | undefined;

  while (at < end) {
    const instruction = decodeSciInstruction(script, at, version);
    if (!instruction) {
      unrecovered = `opcode 0x${(script[at] >> 1).toString(16)} at ${at} is one Sierra left unused`;
      break;
    }
    if (at + instruction.length > end && end !== blockEnd) {
      // The entry point at `end` is inside this instruction, so it is not an
      // entry point. Take the next candidate and carry on from here.
      end = nextBoundaryAfter(end);
      continue;
    }
    if (at + instruction.length > end) {
      unrecovered = `the instruction at ${at} runs past the end of its code block`;
      break;
    }
    instructions.push({
      offset: instruction.offset,
      name: instruction.name,
      operands: instruction.operands,
      raw: instruction.raw,
      ...(instruction.text === undefined ? {} : { text: instruction.text }),
    });
    at += instruction.length;
    // The body ends at `end`, which is the next entry point — so a `ret`
    // before it is an early return and not the end. Stopping at every `ret`
    // would truncate a method with one.
    if (instruction.name === 'ret' && at >= end) break;
  }

  return { selector, selectorNumber, offset, instructions, unrecovered };
}

/** The string a name pointer points at, or null. */
function readName(script: Uint8Array, pointer: number | undefined): string | null {
  if (pointer === undefined || pointer === 0 || pointer >= script.length) return null;
  let name = '';
  for (let at = pointer; at < script.length && script[at] !== 0; at++) {
    name += String.fromCharCode(script[at]);
  }
  return name.length > 0 && /^[\x20-\x7e]+$/.test(name) ? name : null;
}
