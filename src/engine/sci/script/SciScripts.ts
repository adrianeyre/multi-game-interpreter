/**
 * Loading Script resources into the PMachine.
 *
 * The seam ADR 0017 predicted: object layout varies across the family and the
 * instruction encoding does not, so this file has three readers and
 * `PMachine.ts` has one decoder. SCI0 and SCI1 carry object data inline in
 * typed blocks; SCI1.1 through SCI2.1 split it into a code and heap pair; SCI3
 * folds it back behind a fixed header (#221, #229).
 *
 * A script is loaded once and stays loaded, because SCI's own `ScriptID`
 * semantics are that a loaded script keeps its locals and its objects until
 * `DisposeScript` — a reloader that starts fresh loses every property a script
 * has set since the game began, which reads as a game that forgets.
 */

import { atLeast, type SciVersion } from '../sciVersion.js';
import type { SciResources } from '../resource/SciResources.js';
import { NULL_REG, reg, type PMachine, type SciObject, type Reg } from './PMachine.js';
import {
  readSci3Script,
  readSci0Blocks,
  readSci0Exports,
  readSci0Methods,
  readSci0Object,
  readSci0Relocations,
  readSci0String,
  sci0ScriptBias,
  type SciBlock,
} from './scriptResource.js';

/**
 * How far past an object's magic word its property table starts.
 *
 * The magic word and the size word, so four bytes — and an object's identity is
 * its *properties'* address rather than its header's, which is what a send
 * resolves against and what an export has to be translated into.
 */
const OBJECT_VARIABLES_AT = 4;

/**
 * Bit 15 of `-info-`: this object is a class rather than an instance.
 *
 * SCI's own flag, and the only test that works for both object layouts — an
 * inline class carries variable Selectors and a heap class does not, so
 * anything derived from the property table is a test of the *layout* rather
 * than of what the object is.
 */
const CLASS_BIT = 0x8000;

/** One loaded script: its bytes and where things are inside them. */
export interface LoadedScript {
  number: number;
  /** The bytes the program counter indexes, code and all. */
  code: Uint8Array;
  /** Export offsets, which is how one script calls into another. */
  exports: number[];
  /**
   * Where the heap begins inside `code`, for a code-and-heap pair.
   *
   * Zero for an inline script, which has no heap. `lofs` needs it: at SCI1.1 a
   * `lofsa` operand is measured from the heap's start rather than from the
   * script's, so without this every object a script points at by address is
   * looked for in the code.
   */
  heapAt: number;
  /** Objects and classes this script defines, by offset. */
  objects: SciObject[];
}

/**
 * Loads Script resources, and keeps them.
 *
 * Reading is async because a SCI32 Volume is not in memory (ADR 0021), so a
 * script is loaded at a room change rather than mid-send. That is the whole of
 * what streaming costs the layers above.
 */
export class SciScripts {
  private readonly resources: SciResources;
  private readonly machine: PMachine;
  private readonly version: SciVersion;
  private readonly log: (message: string) => void;
  private readonly loaded = new Map<number, LoadedScript>();

  constructor(
    resources: SciResources,
    machine: PMachine,
    version: SciVersion,
    log: (message: string) => void,
  ) {
    this.resources = resources;
    this.machine = machine;
    this.version = version;
    this.log = log;
  }

  get(number: number): LoadedScript | null {
    return this.loaded.get(number) ?? null;
  }

  /** The code a frame's program counter indexes, for `PMachineHost`. */
  code(number: number): Uint8Array | null {
    return this.loaded.get(number)?.code ?? null;
  }

  /**
   * Loads a script, or returns the one already loaded.
   *
   * Idempotent on purpose: `ScriptID` is called on every room change for
   * scripts that are usually already in, and reloading would discard every
   * property those scripts have set.
   */
  async load(number: number): Promise<LoadedScript | null> {
    const existing = this.loaded.get(number);
    if (existing) return existing;

    const bytes = await this.resources.read('script', number);
    if (!bytes) return null;

    // Three layouts, decided by what the game actually ships rather than by the
    // Version — the same test the resource probe makes. A SCI3 script has no
    // heap resource beside it and its objects sit behind a fixed 22-byte
    // header; routing it to the heap reader gave it no exports and no objects,
    // so Lighthouse's script 0 exported nothing and the game never started.
    // **Asked of the game, not of its Version.** EcoQuest and Quest for Glory
    // III are bucketed SCI1 late and ship a heap resource beside every script —
    // the heap-split probe says so, "36 script resources, 36 heap resources" —
    // and gating this read on the Version sent them to the inline reader, which
    // found no block chain and returned an empty script. Both exported nothing
    // and executed nothing.
    //
    // ADR 0020's rule inside the loader: what the game ships decides, because a
    // Version most releases only reach by probe cannot.
    const heap = await this.resources.read('heap', number);
    const script = heap
      ? this.loadWithHeap(number, bytes, heap)
      : atLeast(this.version, 'sci3')
        ? this.loadSci3(number, bytes)
        : this.loadInline(number, bytes);
    if (!script) return null;

    this.loaded.set(number, script);
    for (const object of script.objects) {
      this.machine.addObject(object);
      // A class registers itself under its species number so `class N` and a
      // `super` can find it. An instance does not, and the class table is
      // exactly that difference.
      //
      // **Asked of `-info-`, which is SCI's own answer.** The test used to be
      // "does it carry variable Selectors", which is true of an inline class
      // and *never* true of a heap object — `loadWithHeap` has no variable
      // Selectors to read. So no SCI1.1, SCI2, SCI2.1 or SCI3 class was ever
      // registered, every superclass walk stopped at the object it started on,
      // and the first send of every one of those games — `play` to the game
      // object, which inherits it — resolved to nothing. Ten games executed
      // zero instructions because of this one predicate.
      if ((object.info & CLASS_BIT) !== 0) {
        this.machine.classes.set(object.species, object);
      }
    }
    return script;
  }

  /**
   * SCI0 and SCI1: object data inline, in typed blocks.
   *
   * The block chain may start two bytes in for a SCI0 *early* game — the "old
   * script header" ScummVM names without describing, and which the Christmas
   * Card 1988 demo is the reason this project knows about at all (#216).
   */
  private loadInline(number: number, bytes: Uint8Array): LoadedScript {
    // The bias moves where the *block chain* starts, not where the script's
    // own offsets are measured from. Its exports, its method offsets and its
    // program counter are all relative to the whole resource, header included —
    // so the buffer stays whole and only the walk starts two bytes in. Slicing
    // instead put every entry point two bytes early, which decoded one
    // instruction and then landed mid-operand.
    const bias = sci0ScriptBias(bytes);
    // **A copy, because a running script writes into itself.** A script's own
    // buffers live in its own segment and the Kernel fills them in — a rect
    // for `TextSize`, a line for `Format`. Writing into the resource layer's
    // cache instead would hand a mutated copy to the next reader of the same
    // resource, which is a save, an export or a reload.
    const body = bytes.slice();
    const blocks = readSci0Blocks(body, bias);

    // **Which property words are addresses, from the script's own relocation
    // list.** Read before the objects, because an object's variables are built
    // from it: a word named here becomes a reference into this script and a
    // word not named here stays an integer.
    const relocations = readSci0Relocations(body, blocks);

    const objects: SciObject[] = [];
    for (const block of blocks) {
      if (block.type !== 'object' && block.type !== 'class') continue;
      const object = this.readInlineObject(
        number,
        body,
        block,
        block.type === 'class',
        relocations,
      );
      if (object) objects.push(object);
    }

    const locals = blocks.find((block) => block.type === 'locals');
    if (locals) {
      const values = [];
      for (let at = locals.offset; at + 1 < locals.offset + locals.size; at += 2) {
        values.push(reg(0, body[at] | (body[at + 1] << 8)));
      }
      this.machine.locals.set(number, values);
    }

    return { number, code: body, exports: readSci0Exports(body, blocks), objects, heapAt: 0 };
  }

  private readInlineObject(
    script: number,
    body: Uint8Array,
    block: SciBlock,
    isClass: boolean,
    relocations: ReadonlySet<number> = new Set(),
  ): SciObject | null {
    const layout = readSci0Object(body, block);
    if (!layout) return null;
    const u16 = (at: number): number => body[at] | (body[at + 1] << 8);

    const variables: number[] = [];
    for (let i = 0; i < layout.variableCount; i++) variables.push(u16(layout.at + i * 2));

    // A class also carries the Selector each of its variables answers to; an
    // instance does not, and inherits its class's. That asymmetry is why a
    // property send has to walk the class graph rather than index the object.
    const variableSelectors: number[] = [];
    if (isClass) {
      const selectorsAt = layout.at + layout.variableCount * 2;
      for (let i = 0; i < layout.variableCount; i++) {
        variableSelectors.push(u16(selectorsAt + i * 2));
      }
    }

    const methods = new Map<number, number>();
    for (const method of readSci0Methods(body, layout.methodsAt)) {
      methods.set(method.selector, method.offset);
    }

    return {
      id: reg(script, layout.at),
      // Selectors 0, 1 and 2 are `species`, `superClass` and `-info-` at SCI0
      // and SCI1 — the three the SCI1.1 table drops, which is why this is not
      // the same arithmetic for a heap object.
      species: variables[0] ?? 0,
      superClass: variables[1] ?? 0,
      // SCI0 and SCI1 keep the three leading Selectors, so `-info-` is the third.
      info: variables[2] ?? 0,
      // The fourth is `name`, and it is a pointer — so it is only readable now
      // that the relocation list says which words are. Kept as a string on the
      // object because every report and every halt message wants it, and the
      // alternative is a species number a reader has to look up.
      name: readSci0String(body, relocations.has(layout.at + 6) ? (variables[3] ?? 0) : 0),
      // An inline object's properties start where the object does.
      propertyBias: 0,
      // **A property is an integer unless the relocation list says otherwise.**
      // The table holds 16-bit initial values and nothing in it distinguishes
      // an address from a number; the script's own `pointers` block is what
      // does. A word named there becomes a reference into this script, which is
      // what makes `name` a name and a control's `text` a string — without it
      // King's Quest IV drew every window empty while its scripts ran
      // correctly, which is this project's worst fault class.
      variables: variables.map((value, index) =>
        relocations.has(layout.at + index * 2) && value !== 0 ? reg(script, value) : reg(0, value),
      ),
      methods,
      variableSelectors,
      script,
      clone: false,
    };
  }

  /**
   * SCI1.1 and later: a code and heap pair.
   *
   * Landed here rather than in #221 because the PMachine cannot be exercised
   * against a SCI1.1 game without it, and #217's own claim is that the *decoder*
   * is unchanged by the split — which is only checkable if the split is read.
   *
   * The two resources are concatenated with the heap word-aligned, and every
   * pointer in the heap is 16-bit into that combined space.
   */
  private loadWithHeap(number: number, code: Uint8Array, heap: Uint8Array): LoadedScript {
    const heapAt = code.length + (code.length & 1);
    const buffer = new Uint8Array(heapAt + heap.length);
    buffer.set(code, 0);
    buffer.set(heap, heapAt);
    const u16 = (at: number): number => buffer[at] | (buffer[at + 1] << 8);

    const localCount = u16(heapAt + 2);
    const locals = [];
    for (let i = 0; i < localCount; i++) locals.push(reg(0, u16(heapAt + 4 + i * 2)));
    this.machine.locals.set(number, locals);

    const exportCount = code.length > 7 ? u16(6) : 0;
    const rawExports: number[] = [];
    for (let i = 0; i < exportCount; i++) rawExports.push(u16(8 + i * 2));

    const objects: SciObject[] = [];
    let at = heapAt + 4 + localCount * 2;
    while (at + 4 <= buffer.length && u16(at) === 0x1234) {
      // The word after the magic is the object's **whole size in words**, not
      // its variable count — ScummVM advances by `seeker.getUint16SEAt(2) * 2`.
      // Advancing by the variable count instead lands four bytes short of the
      // next object every time, and the magic-word test then ends the list at
      // the first object rather than at the last.
      const words = u16(at + 2);
      if (words < 2 || at + words * 2 > buffer.length) break;

      const variables: number[] = [];
      for (let i = 0; i < words - 2; i++) variables.push(u16(at + 4 + i * 2));

      // At SCI1.1 the three leading Selectors are gone and the fixed fields
      // move: ScummVM's own constants put `-info-` at byte 14 and the name
      // pointer at 16, rather than SCI0's 4 and 6. Reading them at SCI0's
      // offsets gives an object whose class is a coordinate.
      // **The method dictionary, which this was leaving empty.** A SCI1.1
      // object's second variable points at a table in the *code* resource: a
      // count, then (Selector, offset) pairs. Without it every object answered
      // no method at all, so the very first send of every SCI1.1-and-later boot
      // — `play` to the game object — resolved to nothing and the machine
      // executed zero instructions.
      //
      // The pointer is the second variable and not the first. Checked against
      // King's Quest VI, Space Quest 6 and Torin's Passage: every offset it
      // yields lands inside the code resource, and the first variable yields
      // sizes rather than pointers.
      const methods = new Map<number, number>();
      const dictionary = variables[1] ?? 0;
      if (dictionary > 0 && dictionary + 2 <= code.length) {
        const count = u16(dictionary);
        // A count that would run past the code resource is a pointer read out
        // of something that is not a dictionary. Skipped rather than clamped.
        if (count > 0 && count <= 512 && dictionary + 2 + count * 4 <= code.length) {
          for (let entry = 0; entry < count; entry++) {
            const selector = u16(dictionary + 2 + entry * 4);
            const offset = u16(dictionary + 2 + entry * 4 + 2);
            if (offset > 0 && offset < code.length) methods.set(selector, offset);
          }
        }
      }

      // A SCI1.1 class names the Selector each of its properties answers to in
      // a table in the code resource, pointed at by the object's *first*
      // variable — the sibling of the method dictionary at the second. An
      // instance shares its class's, so it carries none of its own.
      //
      // **The table names every property, including the two in the header.**
      // Its first two entries are `-objID-` and `-size-`, which live at the
      // object's first two words — and `variables` starts *past* them. So the
      // table has `words` entries where `variables` has `words - 2`, and the
      // two lists line up only after the first two are dropped.
      //
      // Reading `words - 2` entries from the front got this wrong twice over:
      // every selector resolved to a property two slots too early, and the
      // last two properties of every class had no Selector at all. Island of
      // Dr. Brain halted sending `detailLevel` — 306 — to a class whose list
      // ended at 304, and four SCI1.1 games halted on Selectors that were in
      // range and declared by nothing.
      const propertySelectors: number[] = [];
      const heapInfo = variables[5] ?? 0;
      const dictionaryAt = variables[0] ?? 0;
      if ((heapInfo & CLASS_BIT) !== 0 && dictionaryAt > 0) {
        for (let entry = 2; entry < words; entry++) {
          const at2 = dictionaryAt + entry * 2;
          if (at2 + 2 > code.length) break;
          propertySelectors.push(u16(at2));
        }
      }

      objects.push({
        id: reg(number, at + OBJECT_VARIABLES_AT),
        species: variables[3] ?? 0,
        superClass: variables[4] ?? 0,
        // SCI1.1 drops them, and ScummVM's own constant puts `-info-` at byte
        // 14 of the object — the sixth word of the property table.
        info: variables[5] ?? 0,
        // A heap object's properties start two words past the object, after the
        // magic word and the size word — and a property opcode's operand is
        // measured from the object, not from the properties.
        propertyBias: OBJECT_VARIABLES_AT / 2,
        variables: variables.map((value) => reg(0, value)),
        methods,
        variableSelectors: propertySelectors,
        script: number,
        clone: false,
      });
      at += words * 2;
    }

    // **An export that names an object is measured from the heap, not from the
    // script.** A SCI1.1 script's export table holds code offsets for its
    // procedures and *heap* offsets for its objects, in one undistinguished
    // list — so an entry is an object exactly when adding the heap's start
    // lands on one, and it is a procedure otherwise.
    //
    // Without this, export 0 of script 0 — which is the game object every SCI
    // boot sends `play` to — resolved to nothing, and every SCI1.1, SCI2,
    // SCI2.1 and SCI3 game executed **zero** instructions. The engine said so
    // plainly ("Export 0 of script 0 points at 886, where this engine found no
    // object") and the fault was in what 886 was measured from.
    //
    // Checked against King's Quest VI, Gabriel Knight, Space Quest 6 and
    // Torin's Passage: in every one, export 0 resolves this way and the entries
    // that do not are code offsets, which is what a procedure export is.
    const byOffset = new Map(objects.map((object) => [object.id.offset, object]));
    const exports = rawExports.map((offset) =>
      byOffset.has(offset + heapAt + OBJECT_VARIABLES_AT)
        ? offset + heapAt + OBJECT_VARIABLES_AT
        : offset,
    );

    return { number, code: buffer, exports, objects, heapAt };
  }

  /**
   * SCI3's layout: a fixed header, and objects located arithmetically.
   *
   * The layout ADR 0017 predicted would cost a reader and not a decoder (#214).
   * No heap resource, so a script may exceed 64K; objects sit past the export
   * table and the locals array, each padded to a four-byte boundary, which is
   * why getting the padding wrong finds no objects rather than wrong ones.
   */
  private loadSci3(number: number, code: Uint8Array): LoadedScript {
    let header;
    try {
      header = readSci3Script(code);
    } catch (error) {
      this.log(`Script ${number} is not a SCI3 script: ${(error as Error).message}`);
      return { number, code, exports: [], objects: [], heapAt: 0 };
    }

    const u16 = (at: number): number => code[at] | (code[at + 1] << 8);

    const locals: Reg[] = [];
    const localsAt = 22 + header.exports.length * 2;
    for (let i = 0; i < header.localCount; i++) locals.push(reg(0, u16(localsAt + i * 2)));
    this.machine.locals.set(number, locals);

    // **A SCI3 object's size word is in bytes, where a heap object's is in
    // words.** Chaining by words finds one object in Lighthouse's script 0 and
    // stops at 1368, in the middle of the twenty-nine the file holds. Chaining
    // by bytes lands on every one: 568 + 400 = 968, 968 + 784 = 1752,
    // 1752 + 656 = 2408, each of which is a magic word.
    //
    // That difference is also why the walk is a chain again rather than a scan.
    // A scan finds the objects but not their sizes, and a property count taken
    // from the wrong unit reads a hundred and ninety-eight properties where
    // there are a handful.
    const objects: SciObject[] = [];
    const objectsEnd = Math.min(header.codeAt > 0 ? header.codeAt : code.length, code.length);
    for (let at = header.objectsAt; at + 4 <= objectsEnd && u16(at) === 0x1234;) {
      const size = u16(at + 2);
      if (size < 4 || at + size > code.length) break;

      const variables: Reg[] = [];
      for (let i = 0; i < (size - 4) / 2; i++) variables.push(reg(0, u16(at + 4 + i * 2)));

      objects.push({
        id: reg(number, at + OBJECT_VARIABLES_AT),
        species: variables[3]?.offset ?? 0,
        superClass: variables[4]?.offset ?? 0,
        info: variables[5]?.offset ?? 0,
        propertyBias: OBJECT_VARIABLES_AT / 2,
        variables,
        // **SCI3's method dictionary is not read, and here is how far the
        // reading got**, so the next attempt starts from evidence rather than
        // from nothing.
        //
        // Confirmed against Lighthouse's script 0, whose game object is at
        // 5096 and whose game ships 960 Selectors:
        //
        // - A selector *group* is 32 Selectors, so 960 of them make 30 groups.
        // - The object carries one **location byte per group**, at object
        //   offset 16. Lighthouse's game object reads `01 00 ... 00 02 00 00
        //   00 00 00 00 03 04 00 00 00 05 00 06 07`, which is exactly the shape
        //   the encoding implies: a location, or zero for a group this object
        //   has nothing in.
        // - A location maps to `object + 20 + location * 64`, and that is
        //   checked rather than assumed: the object's bytes are entirely zero
        //   until offset 275, and group 20's location of 4 maps to 276.
        // - A Selector's number is its position — group times 32 plus bit — and
        //   not a number written down anywhere. `play` is 246 in Lighthouse's
        //   own table and appears nowhere in the object's 720 bytes.
        //
        // What did **not** decode is a group's contents, and the failure is
        // measured rather than impressionistic. Reading each located group as
        // thirty u16 values and asking how many are plausible method offsets —
        // inside that script's own code region — gives **187 out of 77,110**
        // across 418 objects in Lighthouse's first twenty-five scripts. That is
        // 0.24%, which is noise: 43,423 of the values are zero and 29,987 are
        // `0xffff`. A type mask at the front, in either polarity, does not
        // rescue it: one way yields three methods whose offsets all fall below
        // the code's start, the other fourteen whose values are plainly
        // property data (1, 3, 196).
        //
        // **A second reading has since been tried and eliminated.** A 64-byte
        // group for 32 Selectors is exactly two bytes each, and the reading
        // above uses *thirty* u16 values — leaving four bytes over, which a
        // 32-bit presence mask followed by packed entries would explain, and
        // which would also explain the zeros. Measured the same way over
        // Lighthouse's first twenty-five scripts: 2,570 groups located, 258
        // masks with a plausible number of bits set, 4,322 entries, and **17 of
        // them inside the script's own code region**. 0.4% against a flat
        // reading's 0.04% is noise against noise.
        //
        // So the group *contents* are laid out some other way, and the entry
        // points above — the location bytes and the 64-byte stride — are as far
        // as this got. No implementation is written from a 0.24% fit, and none
        // from a 0.4% one either.
        //
        // Worth saying for the next attempt: with 2,570 groups located and
        // essentially nothing plausible inside any of them, **the mapping is as
        // suspect as the contents**. `object + 20 + location * 64` was checked
        // against one object's zero-run, which is enough to be consistent and
        // not enough to be right.
        methods: new Map(),
        variableSelectors: [],
        script: number,
        clone: false,
      });
      at += size;
    }

    // An export names an object's header; an object's identity is its
    // properties, four bytes on. The same translation SCI1.1's export table
    // needs, and preferred only where it lands on a known object, because an
    // export may also name a procedure.
    const byOffset = new Set(objects.map((object) => object.id.offset));
    const exports = header.exports.map((offset) =>
      byOffset.has(offset + OBJECT_VARIABLES_AT) ? offset + OBJECT_VARIABLES_AT : offset,
    );

    return { number, code, exports, objects, heapAt: 0 };
  }

  /** Every script loaded, for the diagnostic and the sweep. */
  loadedScripts(): LoadedScript[] {
    return [...this.loaded.values()];
  }
}

export { NULL_REG };
