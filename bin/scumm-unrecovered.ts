/**
 * Counts a real game's Unrecovered scripts, and checks its jump targets.
 *
 *   npm run unrecovered -- games/fate
 *
 * `CONTEXT.md` defines **Unrecovered** as a resource that could not be
 * Decompiled into editable structure, or that re-emitted as different bytes
 * than it arrived as. Its target is zero, it is tracked per game, and this is
 * where the number comes from. It cannot be a CI check for the usual reason:
 * `games/` is gitignored and stays that way.
 *
 * It also does the check that byte-identity on its own cannot do. `CONTEXT.md`
 * is explicit that a count of zero is not proof a game decoded correctly — a
 * reader that misreads a boundary re-emits its own misreading byte for byte and
 * passes. So every jump displacement in the game is followed: the destination
 * has to be the first byte of an instruction this reader decoded. A single
 * wrong length puts every boundary after it out by that much, and 25,000 jumps
 * across a shipped game do not all land on a shifted grid by accident.
 */
import { resolve } from 'node:path';

import { disassembleClassic, assembleClassic } from '../src/authoring/disassembleClassic.js';
import {
  assembleV6,
  assembleV8,
  disassembleV6,
  disassembleV7,
  disassembleV8,
} from '../src/authoring/disassembleV6.js';
import {
  CHUNK_HEADER_SIZE,
  SMALL_CHUNK_HEADER_SIZE,
  readChunkHeader,
  readSmallChunkHeader,
} from '../src/engine/resource/Chunk.js';
import { ScummEngine } from '../src/engine/ScummEngine.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { openGame } from '../src/hosting/openGame.js';

const path = resolve(process.argv[2] ?? '.');
const engine = await loadAdventureEngine(await openGame(path), { onLog: () => {} });
if (!(engine instanceof ScummEngine)) {
  console.error(`${path} is not a SCUMM game. AGI has its own Unrecovered count in the editor.`);
  process.exit(1);
}

const version = engine.resources.game.version;
const classic = version <= 5;

/**
 * How many bytes of a resource are its header.
 *
 * Six before v5 and eight from v5 on. Two bytes, and using the wrong one does
 * not fail: it starts every script two bytes in, which decodes to *something*
 * for a while and then stops — a reader reporting faults that are its own.
 */
const headerSize = version < 5 ? SMALL_CHUNK_HEADER_SIZE : CHUNK_HEADER_SIZE;

let scripts = 0;
let unrecovered = 0;
let partial = 0;
let jumps = 0;
let misaligned = 0;
const reasons = new Map<string, number>();

function note(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

/**
 * One script, read and re-emitted.
 *
 * `checkJumps` is off for a single object verb handler and on for the block its
 * object's handlers share: they jump across each other's boundaries, so a
 * displacement measured against one handler's slice lands outside it by design.
 */
function check(name: string, code: Uint8Array, checkJumps: boolean): void {
  if (code.length === 0) return;
  scripts++;

  if (classic) {
    const listing = disassembleClassic(code, version as 2 | 3 | 4 | 5);
    if (listing.undecodedFrom !== null) {
      partial++;
      note(reasons, (listing.reason ?? 'unknown').replace(/\d+/g, 'N'));
    }
    const rebuilt = assembleClassic(listing, code);
    if (rebuilt.length !== code.length || rebuilt.some((byte, i) => byte !== code[i])) {
      unrecovered++;
      console.log(`  not byte-identical: ${name}`);
    }
    if (!checkJumps) return;

    const starts = new Set(listing.instructions.map((instruction) => instruction.offset));
    starts.add(code.length);
    for (const instruction of listing.instructions) {
      for (const field of instruction.fields) {
        if (field.label !== 'jump') continue;
        jumps++;
        const target = instruction.offset + instruction.length + field.value;
        if (!starts.has(target)) {
          misaligned++;
          console.log(`  jump off a boundary: ${name}, ${instruction.text} -> ${target}`);
        }
      }
    }
    return;
  }

  // Each stack Version's own reader. v8's immediates are four bytes where v6's
  // are two, so reading a v8 script with v6's table measures every instruction
  // in the game wrongly — and re-emits the misreading byte for byte, which is
  // exactly the agreement this tool exists to catch.
  const listing =
    version === 8 ? disassembleV8(code) : version === 7 ? disassembleV7(code) : disassembleV6(code);
  if (listing.undecodedFrom !== null) {
    partial++;
    note(reasons, (listing.reason ?? 'unknown').replace(/\d+/g, 'N'));
  }
  // And the same Version's own writer. `assembleV8` exists because v8's stream
  // operand genuinely is four bytes wide where v6's is two, so re-emitting a
  // v8 listing through v6's writer reports every v8 script as Unrecovered and
  // blames the decompiler for the tool's own mismatched pair.
  const rebuilt = version === 8 ? assembleV8(listing, code) : assembleV6(listing, code);
  if (rebuilt.length !== code.length || rebuilt.some((byte, i) => byte !== code[i])) {
    unrecovered++;
    console.log(`  not byte-identical: ${name}`);
  }
}

for (let id = 0; id < 1000; id++) {
  const chunk = engine.resources.getScript(id);
  // Past this Version's chunk header: the script is what follows it.
  if (chunk) check(`script ${id}`, chunk.subarray(headerSize), true);
}

for (const room of engine.resources.listRooms()) {
  try {
    engine.startScene(room, null, 0);
  } catch {
    continue;
  }
  const data = engine.currentRoomData;
  if (!data) continue;
  // v8 keeps a room's code in its `RMSC` block rather than in `ROOM`, and
  // `scriptData` is that block where there is one.
  const code = data.scriptData;

  const entry = data.scripts.entry;
  if (entry)
    check(`room ${room} entry`, code.subarray(entry.offset, entry.offset + entry.length), true);
  const exit = data.scripts.exit;
  if (exit) check(`room ${room} exit`, code.subarray(exit.offset, exit.offset + exit.length), true);
  for (const [number, local] of data.scripts.local) {
    check(
      `room ${room} local ${number}`,
      code.subarray(local.offset, local.offset + local.length),
      true,
    );
  }

  for (const object of data.objects) {
    if (object.verbCodeBase < 0 || object.verbs.size === 0) continue;
    const source = object.source ?? data.data;
    const block =
      version < 5
        ? readSmallChunkHeader(source, object.verbCodeBase)
        : readChunkHeader(source, object.verbCodeBase);
    const end = object.verbCodeBase + block.size;
    const first = Math.min(...object.verbs.values());
    check(
      `room ${room} object ${object.id} verbs`,
      source.subarray(object.verbCodeBase + first, end),
      true,
    );
  }
}

console.log(
  [
    '',
    `${engine.targetName} "${engine.gameId}" — ${scripts} scripts`,
    `Unrecovered: ${unrecovered}`,
    `Read short: ${partial}`,
    ...[...reasons].sort((a, b) => b[1] - a[1]).map(([reason, count]) => `  ${count}x ${reason}`),
    classic ? `Jump targets: ${jumps}, of which ${misaligned} miss an instruction boundary` : '',
  ]
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n'),
);

process.exit(unrecovered === 0 && partial === 0 && misaligned === 0 ? 0 : 1);
