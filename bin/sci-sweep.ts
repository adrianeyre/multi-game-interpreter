/**
 * A static sweep of every Script resource in a SCI game.
 *
 *   npm run sweep:sci -- <game>
 *
 * **A change of kind from `npm run sweep`, and deliberately so (#219).** The
 * SCUMM sweep runs every verb handler on every object in every room. SCI has no
 * verb handlers — the UI is in the game's own scripts — so a dynamic sweep of
 * that shape has nothing to run. What SCI needs instead is static: decompile
 * every Script resource and report what could not be read.
 *
 * That attacks SCI's characteristic failure directly. A Kernel table off by one
 * entry produces a game that runs and does the wrong things, and no report
 * about engine state will show it; a Kernel number nothing implements, listed
 * with the Version it was called at, will. And it does not need the game to be
 * reachable by playing, which for a family where most Versions land on `guess`
 * is the difference between a check and a wish.
 *
 * A dynamic sweep that enters every room and runs its `init` comes second and
 * is worth less.
 *
 * ## Three layouts, one decoder
 *
 * ADR 0017's claim, exercised: what varies across the family varies *outside*
 * the instruction encoding. So this walks three different ways of finding where
 * the code is — SCI0's block chain, SCI1.1's code-and-heap pair, SCI3's fixed
 * header — and hands all three to the same `decodeSciInstruction`. If that
 * stopped being possible, the tripwire in `CONTEXT.md` would have fired.
 *
 * The first version of this file read only the block chain, so every SCI1.1,
 * SCI2 and SCI3 game reported every script Unrecovered and swept nothing —
 * which looked like a finding and was a gap in the tool.
 */

import { resolve } from 'node:path';

import { openGame } from '../src/hosting/openGame.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { decodeSciInstruction } from '../src/engine/sci/script/opcodes.js';
import {
  classifyKernelNumber,
  kernelNamesFor,
  readKernelVocab,
} from '../src/engine/sci/script/kernel.js';
import { kernelCoverage, unreachableHandlers } from '../src/engine/sci/script/kernelCoverage.js';
import { readSelectorTable } from '../src/engine/sci/script/selectors.js';
import {
  readSci0Blocks,
  readSci0Methods,
  readSci0Object,
  readSci11Script,
  sci11CodeEnd,
  sci0ScriptBias,
} from '../src/engine/sci/script/scriptResource.js';
import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import { sciRooms } from '../src/authoring/sci/sciRooms.js';
import { sciRoomBackdrop, sciRoomPieces } from '../src/editor/sci/SciRoomCanvas.js';
import {
  describeSciVersion,
  SCI_VERSIONS,
  selectorIdCarriesReadWriteBit,
  type SciVersion,
} from '../src/engine/sci/sciVersion.js';

const args = process.argv.slice(2);
const flags = args.filter((argument) => argument.startsWith('--'));
const path = args.find((argument) => !argument.startsWith('--'));

/**
 * `--kernel-coverage` prints which Kernel calls this engine answers, and stops.
 *
 * **The one mode of this tool that needs no game**, which is the point of it.
 * Everything else here is a static sweep of a real install; this is a static
 * sweep of *the engine*, and it exists because the figure it replaces was taken
 * with `awk` and `comm` outside the code and was wrong three ways — it counted
 * a placeholder slot as a call, it read SCI16 as one table when SCI0 ships a
 * different one, and it filed calls Sierra never implemented alongside calls
 * this project has not written yet.
 *
 * Four columns rather than two, and the middle two are the honest part. A call
 * answered by the unused-call stub is not implemented, and neither is one whose
 * handler returns the same value whatever a game passes it — `DoSound`, `Parse`,
 * `SaveGame` and fifty-one others are `() => int(0)`. Reading "implemented" as
 * "a key exists under this name" is how a gap closes without anything being
 * written: `MergePoly: () => NULL_REG` would have emptied SCI1's missing column
 * outright. `SCI_UNUSED_KERNEL_NAMES` and `SCI_CONSTANT_KERNEL_NAMES` in
 * `SciKernel.ts` say which calls are in each and why.
 *
 * **It is Tier 1 and says so.** `SciEngine.kernelNameFor` prefers the table a
 * game ships in its own `vocab.999`, and below SCI1 most games ship one — so
 * this is a measurement of the tables this repository carries, not of any
 * game's.
 */
if (flags.includes('--kernel-coverage')) {
  console.log('Kernel coverage, per Version — measured from SCI_KERNEL against each');
  console.log("Version's own table. Tier 1: this is the engine, not a game.");
  console.log('');
  console.log('Version              slots  named  impl  constant  unused  missing');
  for (const row of kernelCoverage()) {
    const columns = [
      describeSciVersion(row.version).padEnd(20),
      String(row.slots).padStart(5),
      String(row.named.length).padStart(7),
      String(row.implemented.length).padStart(6),
      String(row.constant.length).padStart(10),
      String(row.unused.length).padStart(8),
      String(row.missing.length).padStart(9),
    ];
    console.log(columns.join(''));
    if (row.missing.length > 0) console.log(`    missing: ${row.missing.join(' ')}`);
  }
  const stray = unreachableHandlers();
  console.log('');
  console.log(
    stray.length === 0
      ? "  ok   every handler is reachable from at least one Version's table"
      : `  FAIL  ${stray.length} handlers no table names: ${stray.join(' ')}`,
  );
  console.log(
    '  note  "unused" is answered by the stub for the calls Sierra shipped and no retail\n' +
      '        game makes. "constant" is a handler that answers the same value whatever a\n' +
      '        game passes it — some finished, like SetVideoMode; some whole surfaces with\n' +
      '        nothing behind them yet, like Said and Graph. Neither column is an\n' +
      '        implementation and neither is ever counted as one.',
  );
  process.exit(stray.length === 0 ? 0 : 1);
}

if (!path) {
  console.error(
    'Usage: npm run sweep:sci -- <game> [--version=sci1-late]\n' +
      '       npm run sweep:sci -- --kernel-coverage',
  );
  process.exit(1);
}

/**
 * `--version=sci1-late` sweeps under a Version you name rather than the game's.
 *
 * The counterpart of `sweep:agi --interpreter=`, and it exists for a sharper
 * reason. SCI stamps its Version nowhere: a resource map separates six buckets
 * and the thirteen Versions on the axis are finer than any of them, so the
 * detector's answer for most games is the earliest Version of a bucket and an
 * `identification` of `guess` (ADR 0020). The useful next question is what each
 * of the other candidates makes of the same bytes — a Kernel number that lands
 * inside one Version's table and past another's is exactly the evidence that
 * narrows it, and it cannot be gathered without naming the Version.
 *
 * It is also the only way a Version with no data reaches this tool at all. Four
 * fixture layouts cover thirteen Versions (`bin/fixture-install.ts`), so a
 * matrix row for SCI1 middle is this flag over a SCI0-layout install — which
 * checks that Version's Kernel table and decoder against bytes whose map is
 * somebody else's, and the report has to say so.
 *
 * ADR 0013's warning applies unchanged: a wrong Version decodes to something
 * that looks like instructions and re-emits byte for byte. Naming one is a
 * question, never an identification, and the header line says `declared` so a
 * report cannot quietly turn it into one.
 */
const declared = flags.find((flag) => flag.startsWith('--version='))?.slice('--version='.length) as
  SciVersion | undefined;

if (declared && !SCI_VERSIONS.includes(declared)) {
  console.error(`--version must be one of:\n  ${SCI_VERSIONS.join('\n  ')}`);
  process.exit(1);
}

const source = await openGame(resolve(path));
const { game: detected, resources } = await detectSciGame(source, { onLog: () => undefined });

const game = declared
  ? { ...detected, version: declared, identification: 'declared' as const }
  : detected;

const selectorBytes = await resources.read('vocab', 997);
// Doubled for SCI0 early: its Selector IDs carry a read/write bit in the low
// bit, so a 255-entry table answers 510 numbers. Undoubled, every King's Quest
// IV Selector past 254 was reported unresolved and the sweep's own reading was
// the fault rather than the game's.
const selectors = selectorBytes
  ? readSelectorTable(selectorBytes, {
      lsbToggle: selectorIdCarriesReadWriteBit(game.version),
    })
  : { names: [], numbers: new Map() };
const kernelBytes = await resources.read('vocab', 999);
const shippedKernelNames = kernelBytes ? readKernelVocab(kernelBytes) : [];
const kernelNames = kernelNamesFor(game.version);

let scripts = 0;
let codeBlocks = 0;
let instructions = 0;
let objects = 0;
let methods = 0;
/** Scripts that read cleanly and hold no code — an empty slot, not a defect. */
let scriptsWithoutCode = 0;

/** An opcode Sierra left unused, which means the decode desynchronised. */
const unknownOpcodes = new Map<number, number>();
/**
 * A Kernel number **past the end of this Version's table** — a real fault.
 *
 * Either a misread instruction or the wrong Version, and both are the thing
 * this sweep exists to catch.
 */
const outOfRangeKernels = new Map<number, number>();
/**
 * A Kernel number inside the table that this project has not named yet.
 *
 * Not a fault: `kernel.ts` names only the SCI2 and SCI2.1 entries there is
 * positive evidence for, and the rest report themselves by number (#217).
 * Counted apart from the faults because reporting them together made this
 * sweep say "4,941 unknown Kernel numbers" over six SCI32 demos, which is true
 * and tells a reader nothing about whether anything is broken.
 */
const unnamedKernels = new Map<number, number>();
/** A Selector number past the end of the game's own table. */
const unresolvedSelectors = new Set<number>();
/** A code block the decode did not consume exactly. */
let overruns = 0;
/**
 * `Unrecovered`, in this project's own sense: a resource that did not come back
 * as it arrived. Static, so what it counts here is a resource that could not be
 * *read* — an export or a method offset that is not inside any code block, or a
 * Script resource whose block chain does not parse.
 */
const unrecovered: string[] = [];

/** Sorts one Kernel call into a fault, a gap, or neither. */
function noteKernel(number: number): void {
  const kind = classifyKernelNumber(number, game.version, kernelNames, shippedKernelNames);
  if (kind === 'out-of-range') {
    outOfRangeKernels.set(number, (outOfRangeKernels.get(number) ?? 0) + 1);
  } else if (kind === 'unnamed-slot') {
    unnamedKernels.set(number, (unnamedKernels.get(number) ?? 0) + 1);
  }
}

for (const number of resources.list('script')) {
  const bytes = await resources.read('script', number);
  if (!bytes) {
    unrecovered.push(`script ${number}: could not be read from its Volume`);
    continue;
  }
  scripts++;

  // The bias moves where the block chain *starts*, not where the script's own
  // offsets are measured from — a method offset and an export are relative to
  // the whole resource, header included. Slicing instead of offsetting reads
  // every entry point two bytes early.
  const bias = sci0ScriptBias(bytes);
  const body = bytes;
  const blocks = readSci0Blocks(body, bias);
  if (blocks.length === 0) {
    // Not an inline layout. A SCI1.1-and-later script pairs with a heap
    // resource; a SCI3 one folds the heap back in behind a fixed header. Both
    // are a different *reader*, not a different decoder (ADR 0017), which is
    // what makes this a few lines rather than a second sweep.
    const heap = await resources.read('heap', number);
    const entries = heap ? heapEntryPoints(bytes, heap) : sci3EntryPoints(bytes);
    // **A SCI1.1 code resource ends with its relocation table, and that table
    // is not code.** Word 0 of the header names it. The last method has no
    // next entry point to stop at, so bounding it at the resource's end walks
    // it into a list of ascending `lofs` positions that decode as perfectly
    // plausible instructions.
    const codeEnd = heap ? sci11CodeEnd(bytes) : bytes.length;
    // Counted here as well as in the block-chain path, so the line the sweep
    // prints is about the game rather than about which layout it happens to be
    // in — a heap game reporting "0 objects" reads as a fault and is not. It is
    // counted *before* the no-code test, because a script can hold objects and
    // no code: King's Quest VII's 7000 is one object and the export naming it.
    objects += heap ? readSci11Script(bytes, heap).objects.length : 0;

    // **A script with nothing to disassemble is not a script that could not be
    // read.** King's Quest VII ships three: 64910 and 64943 are ten bytes of
    // code and eight of heap — an empty slot Sierra left in the numbering —
    // and 7000 is a heap holding one object and a code resource holding only
    // the export that names it. All three have a heap pair, so the layout was
    // read; there is simply no code in them. Calling that Unrecovered reports
    // a defect where the release has none, and ADR 0013 puts the target for
    // Unrecovered at zero, so a false one costs as much as a missed one.
    if (entries.length === 0) {
      if (!heap) {
        unrecovered.push(`script ${number}: neither a block chain, a heap pair, nor a SCI3 header`);
      } else {
        scriptsWithoutCode++;
      }
      continue;
    }

    codeBlocks += entries.length;
    methods += entries.length;
    for (const [index, entry] of entries.entries()) {
      // **A method ends where the next one begins.** There is no size word here
      // — the block chain is where those live — and stopping only at `ret`
      // walks off the end of any method whose last instruction is a jump,
      // decoding the next method's dispatch table as instructions. That showed
      // up as a handful of "unknown opcodes" and, in Torin's Passage, as a
      // Kernel number of 0x2f04, which is a 16-bit operand read as a call.
      const end = entries[index + 1] ?? codeEnd;
      let at = entry;
      while (at < end) {
        const instruction = decodeSciInstruction(body, at, game.version);
        if (!instruction) {
          const opcode = body[at] >> 1;
          unknownOpcodes.set(opcode, (unknownOpcodes.get(opcode) ?? 0) + 1);
          break;
        }
        if (at + instruction.length > end) {
          overruns++;
          break;
        }
        instructions++;
        if (instruction.name === 'callk') noteKernel(instruction.operands[0]);
        at += instruction.length;
        if (instruction.name === 'ret') break;
      }
    }
    continue;
  }

  const code = blocks.filter((block) => block.type === 'code');
  codeBlocks += code.length;

  for (const block of code) {
    let at = block.offset;
    const end = block.offset + block.size;
    while (at < end) {
      const instruction = decodeSciInstruction(body, at, game.version);
      if (!instruction) {
        const opcode = body[at] >> 1;
        unknownOpcodes.set(opcode, (unknownOpcodes.get(opcode) ?? 0) + 1);
        break;
      }
      if (at + instruction.length > end) {
        overruns++;
        break;
      }
      instructions++;

      if (instruction.name === 'callk') noteKernel(instruction.operands[0]);
      at += instruction.length;
    }
  }

  for (const block of blocks) {
    if (block.type !== 'object' && block.type !== 'class') continue;
    const object = readSci0Object(body, block);
    if (!object) {
      unrecovered.push(`script ${number}: an ${block.type} block with no magic word`);
      continue;
    }
    objects++;

    for (const method of readSci0Methods(body, object.methodsAt)) {
      methods++;
      if (selectors.names.length > 0 && method.selector >= selectors.names.length) {
        unresolvedSelectors.add(method.selector);
      }
      const inside = code.some(
        (block2) => method.offset >= block2.offset && method.offset < block2.offset + block2.size,
      );
      if (!inside) {
        unrecovered.push(
          `script ${number}: method ${selectors.names[method.selector] ?? method.selector} ` +
            `points at ${method.offset}, which is not inside any code block`,
        );
      }
    }
  }
}

/**
 * Where the code is in a SCI1.1-and-later code-and-heap pair.
 *
 * Every object in the heap carries a pointer to its own method dictionary — a
 * count, then (Selector, offset) pairs — and those offsets are into the *code*
 * resource. Together with the export table that is every entry point a script
 * has, which is what a static sweep needs and all it needs.
 *
 * The pointer is the object's **second** variable, at six bytes past its magic
 * word. Checked against King's Quest VI, Space Quest 6 and Torin's Passage:
 * every offset it yields lands inside the code resource, and reading the first
 * variable instead yields sizes rather than pointers.
 */
function heapEntryPoints(code: Uint8Array, heap: Uint8Array): number[] {
  const script = readSci11Script(code, heap);
  const codeEnd = sci11CodeEnd(code);
  const u16 = (at: number): number => script.buffer[at] | (script.buffer[at + 1] << 8);
  const entries = new Set<number>();

  // **An export that names an object is measured from the heap, not from the
  // code.** The table holds both in one undistinguished list, and an object's
  // heap offset is a small number that lands inside the code resource as
  // readily as a real entry point does — so taking it for one starts a
  // disassembly in the middle of the heap's object data. That is where King's
  // Quest VII's 27 "unknown opcodes" and 108 of its overruns came from: they
  // are property words, read as instructions. An entry is an object exactly
  // when adding the heap's start lands on one, which is the same test the
  // engine's own loader makes.
  const objectExports = new Set(script.objects.map((at) => at - script.heapAt));
  for (const offset of script.exports) {
    if (offset > 0 && offset < codeEnd && !objectExports.has(offset)) entries.add(offset);
  }

  for (const object of script.objects) {
    const dictionary = u16(object + 6);
    if (dictionary === 0 || dictionary + 2 > codeEnd) continue;
    const count = u16(dictionary);
    // A count that would run past the code resource is a pointer read out of
    // something that is not a method dictionary. Skipped rather than clamped.
    if (count === 0 || count > 512 || dictionary + 2 + count * 4 > codeEnd) continue;
    for (let index = 0; index < count; index++) {
      const at = u16(dictionary + 2 + index * 4 + 2);
      if (at > 0 && at < codeEnd) entries.add(at);
    }
  }

  return [...entries].sort((a, b) => a - b);
}

/**
 * Where the code is in a SCI3 Script resource.
 *
 * A 22-byte fixed header with the code offset as a 32-bit word at zero and the
 * export table located arithmetically after it (#214). No heap resource, so a
 * SCI3 script can exceed 64K — which is the reason the offsets are 32-bit and
 * the reason this is a separate reader rather than a flag on the last one.
 */
function sci3EntryPoints(bytes: Uint8Array): number[] {
  if (bytes.length < 22) return [];
  const u16 = (at: number): number => bytes[at] | (bytes[at + 1] << 8);
  const u32 = (at: number): number =>
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;

  const codeAt = u32(0);
  if (codeAt === 0 || codeAt >= bytes.length) return [];

  const exportCount = u16(20);
  if (exportCount === 0 || exportCount > 4096) return [codeAt];

  const entries = new Set<number>([codeAt]);
  for (let index = 0; index < exportCount; index++) {
    const at = u16(22 + index * 2);
    if (at > 0 && at < bytes.length) entries.add(at);
  }
  return [...entries].sort((a, b) => a - b);
}

const version = describeSciVersion(game.version);
console.log(
  `${version} "${game.id}" — identified by ${game.identification}` +
    (declared && declared !== detected.version
      ? ` (detection said ${describeSciVersion(detected.version)})`
      : ''),
);
console.log(
  `${scripts} scripts, ${codeBlocks} code blocks, ${instructions} instructions, ` +
    `${objects} objects, ${methods} methods`,
);
console.log(
  `${selectors.names.length} Selector names, ` +
    `${shippedKernelNames.length} Kernel names shipped in the game`,
);
console.log('');

const report = (label: string, count: number, detail = ''): void => {
  console.log(`${count === 0 ? '  ok  ' : ' FAIL '} ${label}: ${count}${detail}`);
};

report(
  'unknown opcodes',
  [...unknownOpcodes.values()].reduce((a, b) => a + b, 0),
  unknownOpcodes.size
    ? ` (${[...unknownOpcodes].map(([op, n]) => `0x${op.toString(16)}×${n}`).join(', ')})`
    : '',
);
report('code blocks overrun', overruns);
report(
  "Kernel numbers past this Version's table",
  [...outOfRangeKernels.values()].reduce((a, b) => a + b, 0),
  outOfRangeKernels.size
    ? ` (${[...outOfRangeKernels]
        .map(([number, count]) => `0x${number.toString(16)}×${count}`)
        .join(', ')})`
    : '',
);
// Reported without a pass/fail marker, because it is not one: these are slots
// this project has not named, and the game calling them is the game working.
const unnamedTotal = [...unnamedKernels.values()].reduce((a, b) => a + b, 0);
console.log(
  `  note  ${unnamedKernels.size} Kernel slots called but unnamed here ` +
    `(${unnamedTotal} calls) — inside ${describeSciVersion(game.version)}'s table, so a gap in ` +
    `what this project knows rather than a fault in what it read`,
);
if (scriptsWithoutCode > 0) {
  console.log(
    `  note  ${scriptsWithoutCode} scripts hold no code — a heap pair that read cleanly with ` +
      `nothing to disassemble, which is an empty slot in Sierra's numbering rather than a defect`,
  );
}
report(
  'unresolved Selectors',
  unresolvedSelectors.size,
  unresolvedSelectors.size ? ` (${[...unresolvedSelectors].slice(0, 8).join(', ')})` : '',
);
report('Unrecovered', unrecovered.length);
for (const line of unrecovered.slice(0, 10)) console.log(`        ${line}`);
if (unrecovered.length > 10) console.log(`        …and ${unrecovered.length - 10} more`);

if (resources.unreadable.length > 0) {
  console.log('');
  console.log(`${resources.unreadable.length} resources could not be decompressed:`);
  for (const entry of resources.unreadable.slice(0, 5)) {
    console.log(`   ${entry.type} ${entry.number}: ${entry.reason}`);
  }
}

/**
 * The room surface, counted.
 *
 * This part of the sweep is not about whether a Script decodes — everything
 * above is — but about whether the editor's **room** view has anything to show
 * for this release. ADR 0037 defines a room as a Script defining an instance
 * whose class chain reaches `Room`, seen together with the Picture that
 * instance names, and `sciRooms` derives exactly that from the authored
 * project. Counting it here is what lets `docs/editor-parity.md` quote rows 5,
 * 6 and 7 with a number and a command rather than a claim.
 *
 * It goes through `importSciGame` rather than the raw resources the rest of
 * this file reads, because the editor goes through `importSciGame` too, and a
 * count taken by a second route would be a count of something else.
 *
 * A cel is decoded per placed instance, which is what the panel does to draw
 * the thing: refusing to decode it would report a drawable instance the editor
 * cannot draw.
 *
 * **What this costs, measured on King's Quest VII.** The sweep was 1.08s and
 * is 12.0s. Nine of the eleven added seconds are `importSciGame` itself —
 * 9.1s to build the authoring project from 3,112 resources — and the room
 * work on top of it is 1.4s (0.5s of backdrops, 0.8s of cels, 6ms of
 * derivation). It is left on by default rather than behind a flag because a
 * count nobody runs is a count that stops being true, and because twelve
 * seconds is the right order for a static sweep of a whole release.
 */
const project = await importSciGame(game, resources);
const rooms = sciRooms(project);
const placed = rooms.flatMap((room) => room.things);

let backdrops = 0;
const backdropSizes = new Map<string, number>();
const missingPictures: string[] = [];
for (const room of rooms) {
  const drawn = sciRoomBackdrop(project, room);
  if (drawn === null) continue;
  if (typeof drawn === 'string') {
    missingPictures.push(`${room.picture}`);
    continue;
  }
  backdrops++;
  const size = `${drawn.width}x${drawn.height}`;
  backdropSizes.set(size, (backdropSizes.get(size) ?? 0) + 1);
}

let drawnCels = 0;
const refusedArt = new Map<string, number>();
for (const room of rooms) {
  for (const piece of sciRoomPieces(project, room)) {
    if (piece.image) drawnCels++;
    else {
      // Grouped by the shape of the reason rather than by its text, so that a
      // View number in the sentence does not turn one kind into 989 kinds.
      const kind = piece.why?.startsWith('declares no View')
        ? 'declare no View'
        : piece.why?.includes('not in this release')
          ? 'name a View this release does not ship'
          : 'name a loop or cel that View does not have';
      refusedArt.set(kind, (refusedArt.get(kind) ?? 0) + 1);
    }
  }
}

console.log('');
console.log(
  `${rooms.length} rooms of ${project.scripts.length} scripts, ` +
    `${placed.length} instances placed on them`,
);
console.log(
  `  note  ${backdrops} rooms draw a Picture` +
    (backdropSizes.size
      ? ` (${[...backdropSizes].map(([size, n]) => `${n}×${size}`).join(', ')})`
      : '') +
    `; ${rooms.length - backdrops - missingPictures.length} name none, ` +
    `${missingPictures.length} name one this release does not ship` +
    (missingPictures.length ? ` (${missingPictures.join(', ')})` : ''),
);
console.log(
  `  note  ${drawnCels} instances draw their own cel; ` +
    ([...refusedArt].map(([kind, n]) => `${n} ${kind}`).join(', ') || 'none refused'),
);
// Movable is a property of where the object's words live, not of its art: an
// instance the panel cannot draw is still an instance whose x and y can be
// written, so this is counted apart from the cels above rather than inside it.
console.log(
  `  note  ${placed.filter((thing) => thing.movable).length} of ${placed.length} ` +
    `instances are movable — their property words are addressable, so a drag has ` +
    `somewhere to write`,
);
