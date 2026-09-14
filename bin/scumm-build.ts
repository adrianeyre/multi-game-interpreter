/**
 * Compiles an authored game to a playable SCUMM v5 container.
 *
 *   npm run build:game examples/demo/game.ts
 *   npm run build:game examples/demo/game.ts -- --out public/games/demo
 *
 * The game module must default-export a `GameBuilder`. Output is the index/data
 * pair plus a `manifest.json`, which is what the web app needs to load a game
 * over HTTP without a directory listing.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { compileGame } from '../src/authoring/compile.js';
import type { GameBuilder } from '../src/authoring/GameBuilder.js';

interface Options {
  entry: string;
  outDir: string;
  name?: string;
}

function parseArguments(argv: string[]): Options {
  const positional: string[] = [];
  let outDir: string | undefined;
  let name: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === '--out' || argument === '-o') outDir = argv[++i];
    else if (argument === '--name' || argument === '-n') name = argv[++i];
    else if (argument.startsWith('--out=')) outDir = argument.slice(6);
    else if (argument.startsWith('--name=')) name = argument.slice(7);
    else positional.push(argument);
  }

  if (positional.length === 0) {
    throw new Error(
      'Usage: npm run build:game <game.ts> [-- --out <dir>] [--name <id>]\n' +
        'Example: npm run build:game examples/demo/game.ts',
    );
  }

  const entry = positional[0];
  const derivedName = name ?? basename(entry).replace(/\.[^.]*$/, '');

  return {
    entry,
    name: derivedName,
    outDir: outDir ?? `public/games/${derivedName === 'game' ? 'demo' : derivedName}`,
  };
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const entryPath = resolve(process.cwd(), options.entry);

  const module = (await import(pathToFileURL(entryPath).href)) as { default?: GameBuilder };
  const game = module.default;
  if (!game) {
    throw new Error(`${options.entry} does not default-export a game (use \`export default\`)`);
  }

  const compiled = compileGame(game);

  // Real SCUMM releases use an 8.3 stem shared by both files; keeping that
  // convention means the detector finds the pair exactly as it would a
  // commercial game.
  const stem =
    (options.name ?? 'game')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 8) || 'GAME';
  const indexName = `${stem}.000`;
  const dataName = `${stem}.001`;

  const outDir = resolve(process.cwd(), options.outDir);
  await mkdir(outDir, { recursive: true });

  await writeFile(resolve(outDir, indexName), compiled.index);
  await writeFile(resolve(outDir, dataName), compiled.data);
  await writeFile(
    resolve(outDir, 'manifest.json'),
    `${JSON.stringify({ name: game.options.name, files: [indexName, dataName] }, null, 2)}\n`,
  );

  for (const warning of compiled.warnings) console.warn(`warning: ${warning}`);

  const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;
  console.log(`Built "${game.options.name}" -> ${options.outDir}/`);
  console.log(
    `  ${compiled.stats.rooms} rooms, ${compiled.stats.objects} objects, ` +
      `${compiled.stats.scripts} scripts, ${compiled.stats.costumes} costumes`,
  );
  console.log(
    `  ${indexName} ${kb(compiled.index.length)}   ${dataName} ${kb(compiled.data.length)}`,
  );
  console.log(`\nPlay it:  npm start  then open  ?game=${basename(outDir)}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
