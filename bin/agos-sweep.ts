/**
 * Decodes every Subroutine in an AGOS game and checks it against its table.
 *
 *   npm run sweep:agos -- games/simon1
 *   npm run sweep:agos -- games/simon1 --version=Simon1 --release=talkie
 *
 * ## Why this exists, and why it lands before the interpreter
 *
 * An AGOS instruction's length comes from a table outside the bytecode, and
 * that table is this project's rather than the game's — AGOS shipped its
 * interpreter as a bundled executable, so there is no `agidata.ovl` to read
 * (ADR 0029). ADR 0013 named the failure that produces: decode with a wrong
 * table and every boundary after the first mismatch is wrong, then re-emit the
 * misreading byte for byte while the byte-identity check passes.
 *
 * AGOS fails that way loudly, and this is what makes the noise audible. Lines
 * end on a terminator and Subroutines are introduced by a zero word, so a
 * decode that has lost its place walks into an opcode with no table entry or
 * past the end of the data. Over a whole game it does so almost immediately.
 *
 * Running it costs nothing and needs no interpreter, which is why the sequencing
 * agreed for this family puts it first: the table is falsified or not before a
 * single opcode's behaviour is written.
 *
 * `CONTEXT.md` calls the property **Structural agreement**, and is careful about
 * what it claims: a falsifier, not a proof. A table can be wrong about an opcode
 * no game uses, or wrong in a way that stays in step. A clean sweep says nothing
 * was caught, not that nothing is there.
 *
 * ## It sweeps the table files too, and used to sweep only `GAMEPC`
 *
 * `CONTEXT.md` says a game's Subroutines "are split across its `GAMEPC` and its
 * table resources", and this checked the first half. That was not a small gap:
 * Simon 1 keeps 75 Subroutines in `GAMEPC` and the rest of the game across
 * thirty `TABLES` files, so a clean sweep was a clean sweep of a fifth of the
 * bytecode — and the fifth that contains no room logic. The table files are
 * where a wrong argument table would most likely show, because they are where
 * the game actually is.
 *
 * Game data is not redistributable and never lives in this repository, so the
 * path is always an argument — the rule `npm run sweep` and `npm run diagnose`
 * already follow.
 */

import { resolve } from 'node:path';
import { openGame } from '../src/hosting/openGame.js';
import { detectAgosGame } from '../src/engine/agos/resource/agosDetect.js';
import { readGamePc } from '../src/engine/agos/resource/gamePc.js';
import { checkStructuralAgreement } from '../src/engine/agos/script/structuralAgreement.js';
import { readTableSource } from '../src/engine/agos/resource/tableSource.js';
import { readZoneSource } from '../src/engine/agos/resource/zoneSource.js';
import { writeSubroutineBlock } from '../src/engine/agos/script/subroutines.js';
import {
  AGOS_VERSIONS,
  type AgosReleaseKind,
  type AgosVersion,
} from '../src/engine/agos/agosVersion.js';

function flag(name: string): string | undefined {
  const found = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return found?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path || path.startsWith('--')) {
    console.error(
      'usage: npm run sweep:agos -- <game folder> [--version=Simon1] [--release=talkie]',
    );
    process.exitCode = 1;
    return;
  }

  const source = await openGame(resolve(path));
  const declaredVersion = flag('version') as AgosVersion | undefined;
  if (declaredVersion && !AGOS_VERSIONS.includes(declaredVersion)) {
    console.error(`--version must be one of: ${AGOS_VERSIONS.join(', ')}`);
    process.exitCode = 1;
    return;
  }

  const detection = await detectAgosGame(source);
  const target = {
    ...detection.target,
    ...(declaredVersion ? { version: declaredVersion } : {}),
    ...(flag('release') ? { releaseKind: flag('release') as AgosReleaseKind } : {}),
  };

  console.log(`${source.label}`);
  console.log(`  base file      ${detection.baseFile}`);
  console.log(`  Version        AGOS ${target.version} (${detection.identification})`);
  if (detection.candidates.length > 1) {
    console.log(`  still standing ${detection.candidates.join(', ')} — refused for editing`);
  }
  console.log(`  release kind   ${target.releaseKind}`);
  console.log('');

  const data = await source.read(detection.baseFile);
  if (!data) throw new Error(`could not read ${detection.baseFile}`);

  // A failure here is the sweep's answer, not the sweep failing: GAMEPC has no
  // index, so a Target that cannot read the item records cannot reach the
  // bytecode either, and reporting that as a crash would hide the finding.
  let game;
  try {
    game = readGamePc(data, target);
  } catch (error) {
    console.log('  Structural agreement: 1 finding.');
    console.log(`    ${detection.baseFile}: ${error instanceof Error ? error.message : error}`);
    console.log('');
    console.log('  The file did not read whole under this Target, so nothing after');
    console.log('  the failure was checked. ADR 0030: GAMEPC is all or nothing.');
    process.exitCode = 1;
    return;
  }

  const blocks = [
    {
      source: detection.baseFile,
      data: writeSubroutineBlock(game.subroutines, target),
    },
  ];

  // The other four fifths of the game. Read through the same reader the engine
  // uses, so a sweep and a running game cannot disagree about where a table is.
  const zones = await readZoneSource(source, target.version);
  const tables = await readTableSource(source, target, zones.archive);
  for (const entry of tables.tables) {
    const block = tables.subroutinesFor(entry.ranges[0]?.min ?? -1);
    if (!block) continue;
    blocks.push({ source: entry.file, data: writeSubroutineBlock(block, target) });
  }

  const report = checkStructuralAgreement(blocks, target);

  console.log(`  items          ${game.items.length}`);
  console.log(`  strings        ${game.strings.length}`);
  console.log(`  table files    ${blocks.length - 1} of ${tables.tables.length} read`);
  console.log(`  subroutines    ${report.subroutinesDecoded}`);
  console.log(`  instructions   ${report.instructionsDecoded}`);
  console.log('');

  if (report.agrees) {
    console.log('  Structural agreement: nothing disagreed.');
    console.log('  That is a falsifier passing, not a proof the table is right.');
    return;
  }

  console.log(`  Structural agreement: ${report.findings.length} finding(s).`);
  for (const finding of report.findings) {
    const where = finding.offset === undefined ? '' : ` at ${finding.offset}`;
    console.log(`    ${finding.source}${where}: ${finding.reason}`);
  }
  console.log('');
  console.log('  A finding means the Target is wrong or the table is: the two are');
  console.log('  indistinguishable from here, and both make the game uneditable.');
  process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
