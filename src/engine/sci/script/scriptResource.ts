/**
 * Reading a Script resource, which is not a script.
 *
 * `CONTEXT.md` is firm about this and it is the reason bare "script" stays
 * ambiguous in this project: a SCI Script resource is a whole linked object —
 * class definitions with their Selector tables and method dispatch, object
 * instances, code, locals, a strings and `said` table, and a relocation list.
 * Neither sibling has anything of the shape.
 *
 * **Three layouts, one decoder.** ADR 0017 names object layout as varying
 * *outside* the instruction encoding, and this file is what that costs: SCI0
 * and SCI1 carry object data inline in typed blocks; SCI1.1 through SCI2.1
 * split it into a code and heap pair; SCI3 folds it back in behind a fixed
 * 22-byte header with a relocation table. Three readers here, one `PMachine`
 * above (#217, #221, #229).
 *
 * Transcribed from ScummVM's `Script::identifyOffsets`, `findBlockSCI0` and
 * `getSci3ObjectsPointer` (`engines/sci/engine/script.cpp`).
 */

/** The typed blocks a SCI0 or SCI1 Script resource is made of. */
export const SCI_BLOCK_TYPES = [
  'terminator',
  'object',
  'code',
  'synonyms',
  'said',
  'strings',
  'class',
  'exports',
  'pointers',
  'preload-text',
  'locals',
] as const;

export type SciBlockType = (typeof SCI_BLOCK_TYPES)[number];

export interface SciBlock {
  type: SciBlockType;
  /** Offset of the block's data, past its own four-byte header. */
  offset: number;
  /** Bytes of data, with the header already subtracted. */
  size: number;
}

/**
 * Walks a SCI0 or SCI1 Script resource's block chain.
 *
 * `{type:u16, size:u16}` per block, and **the size counts its own four-byte
 * header** — ScummVM's reader subtracts four with a comment saying so, and a
 * walker that does not runs four bytes past every block into the next one's
 * header, which reads as a type nobody recognises.
 */
export function readSci0Blocks(script: Uint8Array, from = 0): SciBlock[] {
  const blocks: SciBlock[] = [];
  let at = from;

  while (at + 4 <= script.length) {
    const type = script[at] | (script[at + 1] << 8);
    const size = script[at + 2] | (script[at + 3] << 8);
    if (type === 0) break;
    if (size < 4 || at + size > script.length) break;
    const name = SCI_BLOCK_TYPES[type];
    if (name) blocks.push({ type: name, offset: at + 4, size: size - 4 });
    at += size;
  }
  return blocks;
}

/**
 * Where a SCI0 script's block chain starts: 0, or 2 for a SCI0 *early* game.
 *
 * ScummVM refers to this as "the old script header" in `op_callk`'s
 * `SCI_VERSION_0_EARLY` branch without saying what it is; the Christmas Card
 * 1988 demo says what it is. Its scripts open with a two-byte word before the
 * first block, and read from zero they produce no blocks at all — which is how
 * this was found, because every other SCI0 demo produced eighty to a hundred
 * and fifty code blocks and that one produced none.
 *
 * So it is also a Version probe, and a good one: it is a property of the
 * game's own bytes, it separates two Versions the resource map cannot, and it
 * has no false positive — a script with a header read without one yields
 * nothing rather than something wrong.
 */
export function sci0ScriptBias(script: Uint8Array): 0 | 2 {
  // **By coverage, not by "did it find anything".**
  //
  // The first version returned 0 as soon as a chain read from zero produced a
  // single block, and retail King's Quest IV showed why that is not enough:
  // twenty-nine of its scripts read from zero produce exactly *one* block of
  // three bytes — a type and a size that happen to be plausible — and then
  // stop. Read from two, the same scripts produce their real chain of sixty.
  // The demos never showed it, because a demo's scripts happened not to have
  // that pair of bytes in front.
  //
  // So both readings are made and the one that accounts for more of the
  // resource wins. A chain that covers a few bytes of a two-kilobyte script is
  // not a chain, whatever it parsed.
  return coverage(script, 2) > coverage(script, 0) ? 2 : 0;
}

/** How many bytes of the resource a block chain read at `from` accounts for. */
function coverage(script: Uint8Array, from: number): number {
  let covered = 0;
  for (const block of readSci0Blocks(script, from)) covered += block.size + 4;
  return covered;
}

/**
 * How many bytes one entry of an exports block takes: two, or four.
 *
 * **Measured from the block, never inferred from the Version.** A SCI0, SCI01
 * and some SCI1 games write a two-byte offset per export; Leisure Suit Larry 1,
 * Conquests of the Longbow, Police Quest 3, Castle of Dr. Brain, EcoQuest and
 * Mixed Up Fairy Tales write four, with the offset in the low word and a zero
 * high word. The block's own size says which, because a count and a size are
 * two facts about the same table and only one stride reconciles them:
 * `size === 2 + count * stride`.
 *
 * Deciding it by Version would have been wrong twice over. Both readings turn
 * up *inside* `SCI1 early` — the Christmas Card 1990 is narrow and Leisure Suit
 * Larry 1 is wide — so there is no Version seam to branch on, and ADR 0020's
 * reasoning applies unchanged: read the game's own bytes rather than consult a
 * table of what games are supposed to be.
 *
 * **What the wrong stride does is the fault class this project keeps naming.**
 * Read narrow, a wide table yields the right offset for export 0, zero for
 * export 1, the right offset for export 2, and so on — half the exports plausible
 * and half of them zero. Nothing fails: `calle` resolves, a frame is pushed at
 * offset zero, and the machine decodes the block header as instructions. Conquests
 * of the Longbow halted on `lat 36609` six instructions later, which is three
 * blocks and a data table away from the actual defect.
 */
export function sci0ExportStride(script: Uint8Array, block: SciBlock): 2 | 4 {
  const count = script[block.offset] | (script[block.offset + 1] << 8);
  if (count > 0 && block.size === 2 + count * 4) return 4;
  return 2;
}

/** Every export a Script resource offers, as offsets into the script. */
export function readSci0Exports(script: Uint8Array, blocks: readonly SciBlock[]): number[] {
  // **The last exports block, not the first.** A handful of Sierra's own
  // scripts ship two, and the first one is broken — ScummVM's `Script::load`
  // says so and names the two it knows: "script 912 in Camelot and script 306
  // in KQ4". King's Quest IV's script 306 has a one-entry table at offset 6
  // and a two-entry one at 14, and reading the first gives a single export
  // whose offset is not code.
  //
  // The *last*, for the same reason ScummVM passes `findLastBlock`: what makes
  // it right is that the assembler appended it, so there is nothing to
  // reconcile between the two.
  let block: SciBlock | undefined;
  for (const candidate of blocks) if (candidate.type === 'exports') block = candidate;
  if (!block) return [];
  const count = script[block.offset] | (script[block.offset + 1] << 8);
  const stride = sci0ExportStride(script, block);
  const exports: number[] = [];
  for (let i = 0; i < count; i++) {
    const at = block.offset + 2 + i * stride;
    if (at + 1 >= script.length) break;
    exports.push(script[at] | (script[at + 1] << 8));
  }
  return exports;
}

/**
 * Where a SCI0 or SCI1 object's own data begins, given its block.
 *
 * Eight bytes into the block: the magic word `0x1234`, the local-variable
 * offset, the function area offset and the selector count sit in front, and
 * everything the VM addresses is measured from after them. ScummVM records the
 * same bias as "the VM uses +8".
 */
export const SCI0_OBJECT_BIAS = 8;

/** The magic word that opens an object, and ends the object list at SCI1.1. */
export const SCRIPT_OBJECT_MAGIC = 0x1234;

export interface SciObjectLayout {
  /** Offset of the object's variables, which is where selector 0 lives. */
  at: number;
  /** How many variables — properties — this object has. */
  variableCount: number;
  /** Offset of the method dictionary within the script. */
  methodsAt: number;
  /** Offset of the local variables, or 0. */
  localsAt: number;
}

/**
 * Reads an object's header out of a SCI0 or SCI1 block.
 *
 * Returns null when the magic word is absent, which is the honest answer for a
 * block whose type said object and whose bytes do not agree — that is a
 * misread block chain, and inventing a variable count from it produces an
 * object with hundreds of properties made of neighbouring code.
 */
export function readSci0Object(script: Uint8Array, block: SciBlock): SciObjectLayout | null {
  const u16 = (at: number): number => script[at] | (script[at + 1] << 8);
  if (block.offset + SCI0_OBJECT_BIAS > script.length) return null;
  if (u16(block.offset) !== SCRIPT_OBJECT_MAGIC) return null;

  const at = block.offset + SCI0_OBJECT_BIAS;
  return {
    at,
    localsAt: u16(at - 6),
    // Measured from the selector counter — `at - 2` — rather than from the
    // object's variables or from the script. Established against real data
    // rather than assumed: across Space Quest III, King's Quest IV and King's
    // Quest I the stored value is always `variableCount * 2 + 2`, which places
    // the dictionary exactly at the end of the variable area when read from
    // `at - 2` and two bytes past it when read from `at`. Two bytes is
    // precisely the kind of error this project has shipped twice before, so it
    // is spelled out here rather than left as an arithmetic coincidence.
    methodsAt: at - 2 + u16(at - 4),
    variableCount: u16(at - 2),
  };
}

/**
 * The offsets a SCI0 script says hold pointers rather than numbers.
 *
 * **A property table holds 16-bit initial values and nothing in it says which
 * are addresses.** Sierra's answer is a relocation block — `SCI_OBJ_POINTERS`,
 * type 8 — listing every word the loader has to turn into a real address once
 * it knows where the script landed. Without it every pointer-valued property
 * is a small integer: an object's `name` reads as nothing, and a control's
 * `text` reads as nothing, so a game draws empty windows while its scripts run
 * correctly.
 *
 * A count, then that many 16-bit offsets into the resource. King's Quest IV's
 * script 0 lists 85 of them, and 7174 — the `name` word of the game object at
 * 7168 — is among them, which is what confirmed the reading.
 *
 * **What reads it, and what deliberately does not yet.** Object *names* are
 * read through it, which is why a halt message can say `DText` instead of
 * "object 12". Turning the other pointer-valued properties into references is
 * a second change and not this one: it needs the Kernel able to read a string
 * out of a script segment, and doing the two halves separately took King's
 * Quest IV from its title screen back to a blank one. Recorded rather than
 * half-done.
 */
export function readSci0Relocations(script: Uint8Array, blocks: readonly SciBlock[]): Set<number> {
  const offsets = new Set<number>();
  const block = blocks.find((candidate) => candidate.type === 'pointers');
  if (!block) return offsets;

  const u16 = (at: number): number => script[at] | (script[at + 1] << 8);
  const count = u16(block.offset);
  for (let i = 0; i < count; i++) {
    const at = block.offset + 2 + i * 2;
    if (at + 1 >= block.offset + block.size) break;
    offsets.add(u16(at));
  }
  return offsets;
}

/**
 * A method dictionary: which Selector runs which code.
 *
 * `count`, then `count` Selector numbers, then a zero word, then `count` code
 * offsets. The zero word in the middle is easy to read as a terminator and is
 * not one — the offsets come after it, and a reader that stops there finds no
 * methods at all on every object in the game.
 */
export interface SciMethod {
  selector: number;
  offset: number;
}

export function readSci0Methods(script: Uint8Array, methodsAt: number): SciMethod[] {
  const u16 = (at: number): number => script[at] | (script[at + 1] << 8);
  if (methodsAt + 2 > script.length) return [];
  const count = u16(methodsAt);
  if (count === 0 || methodsAt + 2 + count * 4 + 2 > script.length) return [];

  const methods: SciMethod[] = [];
  for (let i = 0; i < count; i++) {
    methods.push({
      selector: u16(methodsAt + 2 + i * 2),
      offset: u16(methodsAt + 2 + count * 2 + 2 + i * 2),
    });
  }
  return methods;
}

// ------------------------------------------------------------- SCI1.1 ---

/**
 * SCI1.1's Script resource, which is a code and heap pair.
 *
 * The two resources are concatenated with the heap starting on a word
 * boundary, and every pointer in the heap is 16-bit into that combined space —
 * which is why ScummVM refuses a pair over 65535 bytes rather than widening
 * anything. The exports move to fixed positions: a count at 6 and the table at
 * 8, instead of living in a block that has to be searched for.
 */
export const SCI11_EXPORT_COUNT_AT = 6;
export const SCI11_EXPORT_TABLE_AT = 8;

export interface Sci11Script {
  /** The code and heap laid out as the VM addresses them. */
  buffer: Uint8Array;
  /** Where the heap begins inside `buffer`. */
  heapAt: number;
  exports: number[];
  /** Offsets of the object instances, in the heap. */
  objects: number[];
}

/**
 * Where a SCI1.1 code resource's relocation table starts — and so where its
 * code ends.
 *
 * **The last thing in the code resource is not code.** Word 0 of the header is
 * the offset of a `{count:u16, count × u16}` list naming every `lofs` operand
 * in the resource, so the linker can add the load address to each. A
 * disassembler that walks to `code.length` walks into that list and decodes a
 * table of ascending pointers as instructions — which is exactly what it looks
 * like, because half of those pointers are valid opcodes.
 *
 * Validated rather than trusted: the table has to end exactly at the resource's
 * end, which is a strong enough check to tell a real header word from a script
 * whose word 0 means something else. Returns `code.length` when it does not
 * hold, so a script this cannot read is disassembled as it was before rather
 * than truncated at a number this guessed.
 */
export function sci11CodeEnd(code: Uint8Array): number {
  if (code.length < 4) return code.length;
  const u16 = (at: number): number => code[at] | (code[at + 1] << 8);
  const at = u16(0);
  if (at < SCI11_EXPORT_TABLE_AT || at + 2 > code.length) return code.length;
  if (at + 2 + u16(at) * 2 !== code.length) return code.length;
  return at;
}

export function readSci11Script(code: Uint8Array, heap: Uint8Array): Sci11Script {
  // Word-aligned, as ScummVM aligns it: `if (script->size() & 2) ++bufSize`.
  const heapAt = code.length + (code.length & 1);
  const buffer = new Uint8Array(heapAt + heap.length);
  buffer.set(code, 0);
  buffer.set(heap, heapAt);

  const u16 = (at: number): number => buffer[at] | (buffer[at + 1] << 8);

  const exportCount = code.length > SCI11_EXPORT_COUNT_AT + 1 ? u16(SCI11_EXPORT_COUNT_AT) : 0;
  const exports: number[] = [];
  for (let i = 0; i < exportCount; i++) {
    const at = SCI11_EXPORT_TABLE_AT + i * 2;
    if (at + 1 >= buffer.length) break;
    exports.push(u16(at));
  }

  // Objects live in the heap and are recognised by the magic word rather than
  // by a block type — the list ends at the first word that is not `0x1234`.
  // The heap opens with a pointer to its own relocation table and a count of
  // local variables; the object list follows them.
  const objects: number[] = [];
  let at = heapAt + 4 + u16(heapAt + 2) * 2;
  while (at + 2 <= buffer.length && u16(at) === SCRIPT_OBJECT_MAGIC) {
    objects.push(at);
    const variableCount = u16(at + 2);
    at += variableCount * 2;
    if (variableCount === 0) break;
  }

  return { buffer, heapAt, exports, objects };
}

// --------------------------------------------------------------- SCI3 ---

/**
 * SCI3's Script resource: one resource again, behind a fixed header.
 *
 * The layout ADR 0017 predicted would cost a reader and not a decoder (#214).
 * Three 32-bit offsets at 0, 4 and 8 — code, strings, relocations — a locals
 * count at 12, an export count at 20 and the export table at 22. Objects are
 * found arithmetically rather than by scanning: past the export table and the
 * locals array, each padded to a four-byte boundary.
 *
 * Relocation entries are ten bytes — a 32-bit location and a 32-bit adjustment
 * — which is what a `lofs` operand is resolved through at this Version instead
 * of adding a base.
 */
export interface Sci3Script {
  codeAt: number;
  stringsAt: number;
  relocationsAt: number;
  relocationCount: number;
  localCount: number;
  exports: number[];
  objectsAt: number;
}

export function readSci3Script(script: Uint8Array): Sci3Script {
  const u16 = (at: number): number => script[at] | (script[at + 1] << 8);
  const u32 = (at: number): number =>
    (script[at] | (script[at + 1] << 8) | (script[at + 2] << 16) | (script[at + 3] << 24)) >>> 0;

  if (script.length < 22) {
    throw new Error(
      `A SCI3 script is ${script.length} bytes, shorter than its own 22-byte header.`,
    );
  }

  const localCount = u16(12);
  const exportCount = u16(20);
  const relocationsAt = u32(8);
  const relocationCount = u16(18);

  // **A SCI3 export can be a placeholder, and the relocation table holds its
  // real value.** Each entry is ten bytes: the position being relocated as a
  // 32-bit word, then the value. An export whose stored offset is zero and
  // whose position appears in the table is not an empty slot — it is one whose
  // address was written here instead.
  //
  // Lighthouse's script 0 makes the point exactly: exports 0, 3 and 4 are
  // stored as zero, and the first three relocation entries name positions 22,
  // 28 and 30 — which are those three exports. Without this, export 0 resolved
  // to offset 0, no object was found there, and the game never started.
  const relocated = new Map<number, number>();
  for (let i = 0; i < relocationCount; i++) {
    const at = relocationsAt + i * 10;
    if (at + 8 > script.length) break;
    relocated.set(u32(at), u32(at + 4));
  }

  const exports: number[] = [];
  for (let i = 0; i < exportCount; i++) {
    const position = 22 + i * 2;
    exports.push(relocated.get(position) ?? u16(position));
  }

  // Both the export table and the locals array are padded to a dword boundary
  // before the next thing starts, which is the whole of how SCI3 locates its
  // objects. ScummVM says so twice, once for each.
  let at = 22 + exportCount * 2;
  at += at % 4 === 0 ? 0 : 4 - (at % 4);
  at += localCount * 2;
  at += at % 4 === 0 ? 0 : 4 - (at % 4);

  return {
    codeAt: u32(0),
    stringsAt: u32(4),
    relocationsAt,
    relocationCount,
    localCount,
    exports,
    objectsAt: at,
  };
}

/**
 * A NUL-terminated string at an offset in a script, or undefined.
 *
 * Bounded by the resource rather than trusting the terminator: an offset that
 * is not really a string reads to the end of the resource and produces a
 * "name" made of bytecode, which is worse than no name at all.
 */
export function readSci0String(script: Uint8Array, offset: number): string | undefined {
  if (offset <= 0 || offset >= script.length) return undefined;
  let text = '';
  for (let at = offset; at < script.length; at++) {
    if (script[at] === 0) return text;
    if (script[at] < 0x20 || script[at] > 0x7e) return undefined;
    text += String.fromCharCode(script[at]);
  }
  return undefined;
}
