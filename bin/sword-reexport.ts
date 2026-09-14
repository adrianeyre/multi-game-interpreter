/**
 * Re-exports a Broken Sword game through the editor's own path, and checks it.
 *
 *   npm run reexport:sword -- <game folder>
 *
 * A sibling of `reexport:agi`, `reexport:agos` and `reexport:sci`, and the one
 * piece of evidence both Sword export paths most needed: neither had ever been
 * run against a game. A fixture is our reading of a format; an install is the
 * format. Running this against the two demos found nine faults that no fixture
 * had, and each is now a test:
 *
 * **Broken Sword 1.** The exporter refused every install there is, because a
 * shipped `swordres.rif` names both discs' clusters whichever disc it was read
 * from. It refused the first text resource, because `comp_length` counts the
 * whole resource and not the payload. It grew `COMPACTS.CLU` from 200,156 to
 * 1,050,812 bytes, because the project stored each compact as a 3,085-word
 * window rather than its packed extent. It rewrote the RIF's presence tables as
 * 1/0 flags where the file holds large opaque words. And `TEXT.CLU` came back
 * differing in 488 bytes, because `TextDecoder('latin1')` is a label for
 * windows-1252 and the writer assumed a code point was its own byte.
 *
 * **Broken Sword II.** It refused the demo outright, because it identified a
 * cluster by its position among the files present rather than by its line in
 * `resource.inf`. It rewrote every object's resource header. It laid each
 * cluster out in index order from offset 4, where the shipped clusters are in
 * neither that order nor at those offsets. It rebuilt every text module with
 * the wav ids zeroed and the line offsets measured from the payload rather than
 * the resource. And it dropped text edits entirely: `rebuildText` existed, was
 * exported for the editor's use, and was never called.
 *
 * Identity only proves the exporter leaves alone what it was not asked to
 * change, so this then makes one script edit and one **picture** edit, exports
 * again, and boots the result — through `openGame` over a real directory, so
 * the install is one the loader had to recognise on its own.
 *
 * The picture edit is the SCUMM editor's bargain measured on these two: paint a
 * background, press export, and the painted background is in the install. Both
 * exporters used to carry scripts and text out and leave every picture behind,
 * so a painted background could not leave the editor at all.
 */
import { mkdir, readFile, readdir, rm, symlink, writeFile, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { openGame } from '../src/hosting/openGame.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { overlaySource } from '../src/engine/resource/overlaySource.js';
import type { DataSource } from '../src/engine/resource/DataSource.js';
import type { Project } from '../src/authoring/project.js';

const folder = resolve(process.argv[2]!);

/**
 * The most frames either game is given to hand control to a player.
 *
 * A cap rather than a count: the loop below stops at the frame the engine says
 * it is interactive, and these two are a long way apart about when that is —
 * Broken Sword II is ready at frame 93 and Broken Sword 1 plays an opening
 * first and is ready at about 2,350.
 */
const BOOT_FRAMES = 4000;

/** Every file under a directory, as paths relative to it. */
async function walk(root: string, at = root): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(at, { withFileTypes: true })) {
    const full = join(at, entry.name);
    if (entry.isDirectory()) found.push(...(await walk(root, full)));
    else found.push(relative(root, full));
  }
  return found;
}

/**
 * A directory holding the exported files and a symlink to everything else.
 *
 * Symlinks rather than copies because the Sword 1 demo is 143 MB and almost
 * none of it is what an export rewrites — and a real directory rather than an
 * in-memory overlay because the point is that `openGame` and the detector reach
 * the same verdict about the exported install as they do about the original.
 */
async function install(
  name: string,
  files: ReadonlyArray<{ name: string; data: Uint8Array }>,
): Promise<string> {
  const root = join(tmpdir(), `sword-reexport-${name}`);
  await rm(root, { recursive: true, force: true });
  const written = new Map(files.map((file) => [file.name.toLowerCase(), file.data]));
  for (const each of await walk(folder)) {
    const target = join(root, each);
    await mkdir(dirname(target), { recursive: true });
    const stem = each.split(/[/\\]/).pop()!.toLowerCase();
    const replacement = written.get(each.toLowerCase()) ?? written.get(stem);
    if (replacement) await writeFile(target, replacement);
    else await symlink(join(folder, each), target);
  }
  return root;
}

const same = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((value, at) => value === b[at]);

/** The bytes of a file the folder holds, matched the way the readers match it. */
async function fileIn(root: string, wanted: string): Promise<Uint8Array | null> {
  const stem = wanted.split(/[/\\]/).pop()!.toLowerCase();
  for (const each of await walk(root)) {
    if (each.split(/[/\\]/).pop()!.toLowerCase() === stem) {
      return new Uint8Array(await readFile(join(root, each)));
    }
  }
  return null;
}

/**
 * Boots an install and reports what it got to, without claiming more.
 *
 * Run to the frame the engine itself says control is a player's, rather than
 * for a fixed count. A fixed count measured the disc rather than the game:
 * both Sword engines load clusters asynchronously, so the same unmodified
 * folder booted twice in one process reached 14 colours cold and 250 warm, and
 * a comparison built on that would call an export broken for being read first.
 *
 * The framebuffer is read the way `bin/play-probe.ts` reads it, and for the
 * same reason: there is no canvas here, so "it painted" has to be counted in
 * the palette rather than seen. Distinct colours rather than lit pixels,
 * because a screen cleared to one colour is lit everywhere and is not a room.
 */
async function boot(what: string | DataSource, label: string): Promise<string> {
  const source = typeof what === 'string' ? await openGame(what) : what;
  const booted = await loadAdventureEngine(source, { onLog: () => undefined });
  booted.boot();
  const ready = (): string | null =>
    (booted as unknown as { describeNotInteractive(): string | null }).describeNotInteractive();
  let at = -1;
  for (let frame = 0; frame < BOOT_FRAMES; frame++) {
    booted.step();
    booted.render();
    // Every frame yields: both Sword engines start a cluster load from inside a
    // synchronous `step()`, and a loop that never lets the event loop turn sits
    // on that load for ever.
    await new Promise((done) => setImmediate(done));
    if (ready() === null) {
      at = frame;
      break;
    }
  }
  const screen = (
    booted as unknown as { screen: { width: number; height: number; pixels: Uint8Array } }
  ).screen;
  const palette = (booted as unknown as { palette: { flush(): void; rgba: Uint8ClampedArray } })
    .palette;
  palette.flush();
  const colours = new Set<number>();
  for (const index of screen.pixels) {
    const entry = index << 2;
    colours.add(
      ((palette.rgba[entry] ?? 0) << 16) |
        ((palette.rgba[entry + 1] ?? 0) << 8) |
        (palette.rgba[entry + 2] ?? 0),
    );
  }
  const reached = at < 0 ? `never handed over control (${ready()})` : `playable at frame ${at}`;
  return (
    `${label.padEnd(9)} ${booted.targetName}: ${reached}, room ${booted.currentRoom}, ` +
    `${screen.width}x${screen.height} in ${colours.size} colours`
  );
}

/**
 * The original and the export, booted the same way and reported side by side.
 *
 * The control is the whole point of the pair. "The edited install boots" is a
 * sentence an install that had lost every room but the first could also earn;
 * the same room and a comparable screen beside the game it was built from is
 * the part that means something.
 */
async function bootBoth(edited: string, overlaid: DataSource): Promise<void> {
  console.log(await boot(folder, 'original'));
  console.log(await boot(edited, 'exported'));
  // And once more the way the editor's Play button runs it: the rebuilt files
  // in front of the folder the author re-supplied, nothing written to disc.
  // Two paths reaching the same room is the point — `openGame` had to
  // recognise the export as an install on its own, and `overlaySource` had to
  // put the rebuilt clusters where the loader looks for them.
  console.log(await boot(overlaid, 'previewed'));
}

const source = await openGame(folder);
const engine = await loadAdventureEngine(source, { onLog: () => undefined });
const editable = await engine.toEditableGame({ onProgress: () => undefined } as never);
if (!editable) throw new Error(`${folder} does not import as an editable game.`);
const project: Project = editable.project;
console.log('target      ', JSON.stringify(project.target));

if (project.sword1) {
  const { exportSword1Game } = await import('../src/authoring/sword1/export.js');
  const { editSword1Operand } = await import('../src/authoring/sword1/edits.js');
  const { importSword1Project } = await import('../src/authoring/sword1/import.js');
  const { SwordResources } = await import('../src/engine/sword1/resource/SwordResources.js');
  const { identifySword1 } = await import('../src/engine/sword1/resource/swordDetect.js');
  const { replaceSword1Picture } = await import('../src/authoring/sword1/edits.js');
  const { sword1PicturePixels } = await import('../src/editor/sword1/pictureFiles.js');
  const { sword1MusicFileIn, sword1SpeechFileIn } =
    await import('../src/engine/sword1/sound/musicFiles.js');
  const { parseSword1SpeechIndex, readSword1SpeechIndex } =
    await import('../src/engine/sword1/sound/speechIndex.js');
  const { checkSpeechEndianness, expandSpeech, parseWave } =
    await import('../src/engine/sword1/sound/swordAudio.js');
  const { readRangeFrom } = await import('../src/engine/resource/DataSource.js');
  const { parseRif, locateResource, formatResourceId } =
    await import('../src/engine/sword1/resource/rif.js');
  const { sword1SampleId } = await import('../src/engine/sword1/sound/fxTable.js');
  const { writeWavePcm } = await import('../src/engine/sound/wave.js');
  const sword1 = project.sword1;

  const indexFile = (await walk(folder)).find((each) => /swordres\.rif$/i.test(each))!;
  const index = new Uint8Array(await readFile(join(folder, indexFile)));
  const clusters: Array<{ name: string; label: string; data: Uint8Array }> = [];
  for (const each of await walk(folder)) {
    const match = /([^/\\]+)\.(clu|clm)$/i.exec(each);
    if (!match) continue;
    clusters.push({
      name: match[0]!,
      label: match[1]!.toUpperCase(),
      data: new Uint8Array(await readFile(join(folder, each))),
    });
  }
  console.log('clusters    ', clusters.map((cluster) => cluster.label).join(', '));

  /*
   * The speech container, which is the one file an export writes that is not
   * addressed through `swordres.rif` at all.
   *
   * Rebuilt with nothing replaced first, because that is the claim worth
   * checking hardest: 43.9 MB of recordings and an index of 4,731 words come
   * back byte for byte, which is what makes the *edited* export below a diff
   * of the one line that changed.
   */
  const speechFile = sword1SpeechFileIn(await walk(folder));
  const speechData = speechFile
    ? new Uint8Array(await readFile(join(folder, speechFile)))
    : undefined;
  const speechSource =
    speechFile && speechData ? { name: speechFile, data: speechData } : undefined;
  console.log(
    'speech      ',
    speechFile ?? '(none)',
    speechData ? `${speechData.length} bytes` : '',
  );

  /*
   * The executables, which are where the room table and the start positions
   * live — no cluster holds either.
   *
   * Carried through the unedited export for exactly the reason the speech
   * container is: the claim worth checking hardest is that 3.4 MB of
   * interpreter comes back byte for byte, which is what makes the edited
   * export below a diff of the four bytes a start-position edit names.
   */
  const { sword1ExecutableFilesIn } = await import('../src/authoring/sword1/executable.js');
  const executables: Array<{ name: string; data: Uint8Array }> = [];
  for (const each of sword1ExecutableFilesIn(await walk(folder))) {
    executables.push({
      name: each.split(/[/\\]/).pop()!,
      data: new Uint8Array(await readFile(join(folder, each))),
    });
  }
  console.log(
    'executables ',
    executables.map((each) => `${each.name} ${each.data.length} bytes`).join(', ') || '(none)',
  );
  console.log(
    'starts      ',
    sword1.startPositions
      ? `${sword1.startPositions.length} start position(s) read from the interpreter`
      : '(none: this folder ships no executable holding them)',
    `| rooms ${sword1.surfaces.rooms}`,
  );

  const report = exportSword1Game(
    { indexFile, index, clusters, speech: speechSource, executables },
    sword1,
  );
  console.log('rewritten   ', report.rewritten.length, 'copied', report.copied);
  console.log('absent      ', report.missing.join(', ') || '(none)');
  let identical = 0;
  for (const file of report.files) {
    const stem = file.name.split(/[/\\]/).pop()!.toLowerCase();
    const original =
      stem === indexFile.split(/[/\\]/).pop()!.toLowerCase()
        ? index
        : stem === speechFile?.split(/[/\\]/).pop()!.toLowerCase()
          ? speechData!
          : (executables.find((each) => each.name.toLowerCase() === stem)?.data ??
            clusters.find((cluster) => cluster.name.toLowerCase() === stem)!.data);
    const ok = same(file.data, original);
    if (ok) identical++;
    else console.log(`  ${file.name}: ${original.length} -> ${file.data.length} DIFFERS`);
  }
  console.log(`identical   ${identical} of ${report.files.length} files`);

  // One script edit, so the other half is shown: that a change lands, that it
  // lands only where it was asked to, and that the result is still a game.
  const script = sword1.scripts.find((each) =>
    each.instructions.some((instruction) => instruction.operands.length > 0),
  )!;
  const target = script.instructions.find((instruction) => instruction.operands.length > 0)!;
  const wanted = (target.operands[0] ?? 0) + 1;
  editSword1Operand(project, script.resource, target.at, 0, wanted);

  /*
   * And one picture edit, which is the half a script edit cannot stand in for.
   *
   * The SCUMM editor's bargain is that you paint a background, press export,
   * and the painted background is in the install. Until this ran, both Sword
   * exporters carried scripts and text and left every picture behind — so the
   * surface said `editable-not-writable` and a painted background could not
   * leave the editor. One pixel is enough to measure it: change it, export,
   * and read that pixel back out of the rebuilt cluster.
   */
  const picture = sword1.pictures.find((each) => each.kind === 'background');
  const painted = picture ? sword1PicturePixels(picture, 0) : null;
  let pixelAt = 0;
  let pixelWas = 0;
  let pixelWanted = 0;
  if (picture && painted) {
    pixelAt = Math.floor(painted.pixels.length / 2);
    pixelWas = painted.pixels[pixelAt] ?? 0;
    // Any colour but the one that is there, and never 0: a background has no
    // transparency, so 0 is a colour like any other, but keeping off it means
    // the check cannot pass by reading a hole.
    pixelWanted = pixelWas === 1 ? 2 : 1;
    const replacement = Uint8Array.from(painted.pixels);
    replacement[pixelAt] = pixelWanted;
    replaceSword1Picture(project, picture.resource, 0, replacement, painted.width, painted.height);
  }

  /*
   * And one speech edit, which is the third thing an export has to carry and
   * the one that lives outside the clusters.
   *
   * A tone rather than a recording: it has to be something whose samples can
   * be checked exactly after a trip through Revolution's RLE, and a sine at
   * 11,025 Hz is a file this can write without shipping audio into the repo.
   * What is measured on the way back is the samples, the *other* 807 lines
   * still reading as the bytes they were, and the index still pointing at all
   * of them.
   */
  let speechEdit: { room: number; line: number; samples: Int16Array; before: number } | undefined;
  if (speechFile && speechData) {
    const speechIndex = parseSword1SpeechIndex(speechFile, speechData)!;
    const entry = speechIndex.entries()[0]!;
    const tone = new Int16Array(11025);
    for (let at = 0; at < tone.length; at++) {
      tone[at] = Math.round(Math.sin((at * 2 * Math.PI * 440) / 11025) * 8000);
    }
    speechEdit = { room: entry.room, line: entry.line, samples: tone, before: entry.length };
  }

  /*
   * And the other two kinds of recording, which go to two other places.
   *
   * A tune is a file beside the install, addressed by *name* (ADR 0029); an
   * effect is an ordinary resource inside a cluster, addressed by the id the fx
   * table gives it. Both are PCM WAVE where they lie, so both are written as
   * they arrive — and both are checked the same way afterwards, by reading the
   * installed folder rather than the buffer the exporter returned.
   *
   * The two tones differ in pitch from each other and from the speech line, so
   * a read-back that found the wrong one would not pass by accident.
   */
  const tone = (hz: number, seconds: number): Int16Array => {
    const samples = new Int16Array(Math.round(11025 * seconds));
    for (let at = 0; at < samples.length; at++) {
      samples[at] = Math.round(Math.sin((at * 2 * Math.PI * hz) / 11025) * 8000);
    }
    return samples;
  };

  const names = await walk(folder);
  const rifIndex = parseRif(index);
  let musicEdit: { tune: number; file: string; wav: Uint8Array; before: number } | undefined;
  for (let tune = 1; tune < 200 && !musicEdit; tune++) {
    const file = sword1MusicFileIn(names, tune);
    if (!file || !/\.wav$/i.test(file)) continue;
    const before = (await stat(join(folder, file))).size;
    musicEdit = { tune, file, wav: writeWavePcm(tone(660, 0.5), 11025), before };
  }

  let effectEdit: { fx: number; id: number; wav: Uint8Array; before: number } | undefined;
  for (let fx = 0; fx < 400 && !effectEdit; fx++) {
    const id = sword1SampleId(fx, false);
    if (id === null) continue;
    const located = locateResource(rifIndex, id);
    if (!located) continue;
    if (
      !clusters.some((each) => each.label.toUpperCase() === located.cluster.label.toUpperCase())
    ) {
      continue;
    }
    effectEdit = {
      fx,
      id,
      wav: writeWavePcm(tone(880, 0.25), 11025),
      before: located.resource.length,
    };
  }

  /*
   * A record appended to a section, which is row 12 of `docs/editor-parity.md`.
   *
   * Appended and never inserted, and the read-back below is what says why that
   * distinction is the row: every compact that was already in the section has
   * to come back at the index it had, because a script names a compact by
   * `section * 0x10000 + index` and nothing renumbers those.
   */
  const { appendSword1Compact } = await import('../src/authoring/sword1/edits.js');
  const grown = sword1.sections.find((each) => each.compacts.length > 1)!;
  const grownBefore = {
    count: grown.offsets.length,
    words: grown.words,
    records: new Map(grown.compacts.map((compact) => [compact.index, compact.wordsBase64])),
  };
  const appendedIndex = appendSword1Compact(project, grown.section, 0);

  /*
   * And one start position, which is the edit the whole executable path exists
   * for.
   *
   * Moved by a round number in x so the diff below is unmistakable, and read
   * back out of the *installed* executable rather than out of the buffer the
   * exporter returned — the same rule the speech line is held to. What is
   * being earned is "a start position an author moved is in the install's
   * interpreter", and a buffer cannot say that.
   */
  const { editSword1StartPosition } = await import('../src/authoring/sword1/edits.js');
  const startBefore = sword1.startPositions?.[0] ?? null;
  if (startBefore) {
    editSword1StartPosition(project, startBefore.index, { x: startBefore.x + 64 });
  }

  const edited = exportSword1Game(
    {
      indexFile,
      index,
      clusters,
      speech: speechSource && {
        ...speechSource,
        replacements: speechEdit
          ? [
              {
                room: speechEdit.room,
                line: speechEdit.line,
                wav: writeWavePcm(speechEdit.samples, 11025),
              },
            ]
          : [],
      },
      music: musicEdit ? [{ file: musicEdit.file, data: musicEdit.wav }] : [],
      effects: effectEdit ? [{ id: effectEdit.id, data: effectEdit.wav }] : [],
      executables,
    },
    sword1,
  );
  const root = await install('sword1', edited.files);

  /*
   * The replaced line, read back out of the **installed** folder.
   *
   * Not out of the buffer the exporter returned. That buffer would prove the
   * encoder and nothing else, and the sentence this is here to earn is "a line
   * replaced in the editor is what the game now holds" — so the container is
   * found the way `SwordSound` finds it (`sword1SpeechFileIn` over the names
   * `openGame` lists), its index is opened by range the way `openSpeech` opens
   * it, the line is located by screen and line, and the bytes come back through
   * `readRangeFrom` and `expandSpeech`. Every step of that is the engine's own,
   * run against a directory on disc that `openGame` had to recognise by itself.
   */
  if (speechEdit && speechFile && speechData) {
    const installed = await openGame(root);
    const name = sword1SpeechFileIn(installed.list());
    const after = name ? await readSword1SpeechIndex(installed, name) : null;
    const now = after?.locate(speechEdit.room, speechEdit.line) ?? null;
    const bytes = now
      ? await readRangeFrom(installed, after!.file, now.at, now.at + now.length)
      : null;
    const decoded = bytes
      ? expandSpeech(bytes, checkSpeechEndianness(bytes, 'demo'), 'demo')
      : null;

    // The first two samples are the length the demo states inside its own run
    // stream, and `expandSpeech` zeroes them; the audio starts after them.
    let worst = 0;
    for (let at = 2; at < (decoded?.length ?? 0); at++) {
      worst = Math.max(worst, Math.abs(decoded![at]! - (speechEdit.samples[at - 2] ?? 0)));
    }

    // And the other 807, compared where they lie in the installed container
    // rather than where the index used to put them: a rebuild that shifted a
    // recording and forgot to move its index word would read as some other
    // line's audio here, which is the failure worth catching.
    const was = parseSword1SpeechIndex(speechFile, speechData)!;
    const rebuilt = edited.files.find((file) => file.name === speechFile)!.data;
    let intact = 0;
    let changed = 0;
    for (const each of was.entries()) {
      if (each.room === speechEdit.room && each.line === speechEdit.line) continue;
      const moved = after?.locate(each.room, each.line);
      const before = speechData.subarray(each.at, each.at + each.length);
      const behind = moved ? rebuilt.subarray(moved.at, moved.at + moved.length) : new Uint8Array();
      if (same(before, behind)) intact++;
      else changed++;
    }

    console.log(
      `edit        speech screen ${speechEdit.room} line ${speechEdit.line} in ${name}: ` +
        `${speechEdit.before} -> ${now?.length} bytes, ${decoded?.length} samples ` +
        `(wanted ${speechEdit.samples.length + 2}), worst sample difference ${worst}`,
    );
    console.log(`            ${intact} other lines identical, ${changed} changed`);
  }

  /*
   * The replaced tune and the replaced effect, read back the same way.
   *
   * The tune through `sword1MusicFileIn` over the installed folder's own names,
   * which is how `SwordSound.startMusic` finds one; the effect through the
   * *exported* `swordres.rif` — parsed again from the install rather than from
   * the index this run started with — because an effect that changed size moved
   * everything after it in its cluster, and reading it at the old offset would
   * prove nothing about whether the index followed.
   */
  if (musicEdit) {
    const installed = await openGame(root);
    const name = sword1MusicFileIn(installed.list(), musicEdit.tune);
    const bytes = name ? await installed.read(name) : null;
    const played = bytes ? parseWave(bytes) : null;
    console.log(
      `edit        music tune ${musicEdit.tune} in ${name}: ` +
        `${musicEdit.before} -> ${bytes?.length} bytes, ` +
        `identical to what was written: ${bytes ? same(bytes, musicEdit.wav) : false}, ` +
        `${played?.frames} frames at ${played?.sampleRate} Hz`,
    );
  }

  if (effectEdit) {
    const installed = await openGame(root);
    const names2 = installed.list();
    const rifName = names2.find((each) => /swordres\.rif$/i.test(each))!;
    const after = parseRif((await installed.read(rifName))!);
    const located = locateResource(after, effectEdit.id);
    const file = located
      ? names2.find((each) =>
          new RegExp(`(?:^|[/\\\\])${located.cluster.label}\\.clu$`, 'i').test(each),
        )
      : undefined;
    const bytes =
      located && file
        ? await readRangeFrom(
            installed,
            file,
            located.resource.offset,
            located.resource.offset + located.resource.length,
          )
        : null;
    const played = bytes ? parseWave(bytes) : null;
    console.log(
      `edit        effect ${effectEdit.fx} (${formatResourceId(effectEdit.id)} in ${file}): ` +
        `${effectEdit.before} -> ${bytes?.length} bytes, ` +
        `identical to what was written: ${bytes ? same(bytes, effectEdit.wav) : false}, ` +
        `${played?.frames} frames at ${played?.sampleRate} Hz`,
    );
  }

  /*
   * The installed executables, diffed against the ones that went in.
   *
   * Byte for byte and reported as byte *offsets*, because the claim is not
   * "the file changed" — it is that the only bytes that changed are the four
   * the edit named, at the address the edit named them at. A file the export
   * was handed and did not edit has to come out with an empty diff, which is
   * what says `RUNSWORD.EXE` was carried and not quietly dropped.
   */
  const installedExecutables: Array<{ name: string; data: Uint8Array }> = [];
  for (const each of sword1ExecutableFilesIn(await walk(root))) {
    installedExecutables.push({
      name: each.split(/[/\\]/).pop()!,
      data: new Uint8Array(await readFile(join(root, each))),
    });
  }
  for (const before of executables) {
    const after = installedExecutables.find((each) => each.name === before.name);
    if (!after) {
      console.log(`exe         ${before.name}: NOT INSTALLED`);
      continue;
    }
    const differing: number[] = [];
    const length = Math.max(before.data.length, after.data.length);
    for (let at = 0; at < length; at++) {
      if (before.data[at] !== after.data[at]) differing.push(at);
    }
    const named = (edited.executables.find((each) => each.file === before.name)?.edits ?? [])
      .map((edit) => `${edit.what} at 0x${edit.at.toString(16)} ${edit.from} -> ${edit.to}`)
      .join('; ');
    console.log(
      `exe         ${before.name}: ${before.data.length} -> ${after.data.length} bytes, ` +
        `${differing.length} byte(s) differ` +
        (differing.length === 0
          ? ''
          : ` at 0x${differing[0]!.toString(16)}..0x${differing[differing.length - 1]!.toString(16)}`) +
        `; the edit names: ${named || '(nothing)'}`,
    );
  }

  const again = await SwordResources.create(await openGame(root));
  for (const label of again.availableClusters) await again.loadCluster(label, true);
  const { readSword1Executable } = await import('../src/authoring/sword1/executable.js');
  const back = importSword1Project(
    again,
    identifySword1((await openGame(root)).list()),
    installedExecutables.map((each) => readSword1Executable(each.name, each.data)),
  );
  const startBack = startBefore
    ? (back.startPositions?.find((each) => each.index === startBefore.index) ?? null)
    : null;
  if (startBefore) {
    console.log(
      `edit        start position ${startBefore.index} (place ${startBefore.place}): ` +
        `x ${startBefore.x} -> ${startBack?.x} (wanted ${startBefore.x + 64}), ` +
        `y ${startBefore.y} -> ${startBack?.y}, direction ${startBefore.direction} -> ${startBack?.direction}`,
    );
  }
  const readBack = back.scripts
    .find((each) => each.resource === script.resource)!
    .instructions.find((instruction) => instruction.at === target.at)!;
  console.log(
    `edit        script ${script.resource} word ${target.at}: ` +
      `${target.operands[0]} -> ${readBack.operands[0]} (wanted ${wanted})`,
  );
  const grownBack = back.sections.find((each) => each.section === grown.section)!;
  let carried = 0;
  for (const [at, bytes] of grownBefore.records) {
    if (grownBack.compacts.find((compact) => compact.index === at)?.wordsBase64 === bytes) {
      carried++;
    }
  }
  console.log(
    `append      section ${grown.section}: ${grownBefore.count} objects in ` +
      `${grownBefore.words} words -> ${grownBack.offsets.length} in ${grownBack.words}; ` +
      `object ${appendedIndex} reads back as a copy of object 0: ` +
      `${grownBack.compacts.find((compact) => compact.index === appendedIndex)?.wordsBase64 === grownBefore.records.get(0)}; ` +
      `${carried} of ${grownBefore.records.size} existing objects unmoved`,
  );

  if (picture) {
    const backPicture = back.pictures.find((each) => each.resource === picture.resource);
    const readPixel = backPicture
      ? sword1PicturePixels(backPicture, 0)?.pixels[pixelAt]
      : undefined;
    console.log(
      `edit        picture ${picture.resource} (${picture.width}x${picture.height} background) ` +
        `pixel ${pixelAt}: ${pixelWas} -> ${readPixel} (wanted ${pixelWanted})`,
    );
  }
  await bootBoth(root, overlaySource(await openGame(folder), edited.files));
  const rif = await fileIn(root, 'swordres.rif');
  console.log('the exported index is still readable:', rif !== null && rif.length > 0);
}

if (project.sword2) {
  const { exportSword2Game } = await import('../src/authoring/sword2/export.js');
  const { editSword2Operand } = await import('../src/authoring/sword2/edits.js');
  const { importSword2Project } = await import('../src/authoring/sword2/import.js');
  const { Sword2Resources } = await import('../src/engine/sword2/resource/Sword2Resources.js');
  const { identifySword2 } = await import('../src/engine/sword2/resource/sword2Detect.js');
  const { replaceSword2ScreenLayer } = await import('../src/authoring/sword2/edits.js');
  const { sword2ScreenLayerPixels } = await import('../src/editor/sword2/pictureFiles.js');
  const sword2 = project.sword2;

  const resources = await Sword2Resources.create(source);
  const { tab } = resources.indexFiles;
  const resourceTab = (await source.read(tab))!;
  const declared: string[] = [];
  const clusters: Array<{ name: string; data: Uint8Array }> = [];
  for (const cluster of resources.clusterFiles) {
    declared.push(cluster.name);
    if (!cluster.file) continue;
    clusters.push({ name: cluster.name, data: (await source.read(cluster.file))! });
  }
  console.log('declared    ', declared.length, 'present', clusters.length);

  const report = exportSword2Game({ declared, clusters, resourceTab }, sword2);
  console.log('rewritten   ', report.rewritten.length, 'copied', report.copied);
  console.log('absent      ', report.missing.join(', ') || '(none)');
  let identical = 0;
  for (const file of report.files) {
    const original = clusters.find((cluster) => cluster.name === file.name)!.data;
    const ok = same(file.data, original);
    if (ok) identical++;
    else console.log(`  ${file.name}: ${original.length} -> ${file.data.length} DIFFERS`);
  }
  console.log(`identical   ${identical} of ${report.files.length} files`);

  const object = sword2.objects.find((each) =>
    each.instructions.some((instruction) => instruction.operands.length > 0),
  )!;
  const target = object.instructions.find((instruction) => instruction.operands.length > 0)!;
  const wanted = (target.operands[0] ?? 0) + 1;
  editSword2Operand(project, object.id, target.at, 0, wanted);

  // And one picture edit, for the reason the Sword 1 half makes it: a screen
  // an author repainted used to have nowhere to go. Slot 2 is the background
  // itself rather than a parallax, so this is the pixel a player looks at.
  const screen = sword2.screens.find(
    (each) => sword2ScreenLayerPixels(sword2, each.resource, 2) !== null,
  );
  const layer = screen ? sword2ScreenLayerPixels(sword2, screen.resource, 2) : null;
  let pixelAt = 0;
  let pixelWas = 0;
  let pixelWanted = 0;
  if (screen && layer) {
    // A pixel that is drawn, so the check cannot pass by reading a hole: zero
    // is transparency in a parallax layer and a row of it is not written at all.
    pixelAt = layer.pixels.findIndex((pixel) => pixel !== 0);
    pixelWas = layer.pixels[pixelAt] ?? 0;
    pixelWanted = pixelWas === 1 ? 2 : 1;
    const repainted = Uint8Array.from(layer.pixels);
    repainted[pixelAt] = pixelWanted;
    replaceSword2ScreenLayer(project, screen.resource, 2, repainted, layer.width, layer.height);
  }

  /*
   * A recording, in the two forms this family keeps one in.
   *
   * An **effect** is a `WAV_FILE` resource, and replacing one is provable
   * here: the demo ships them, so this substitutes a payload and reads it back
   * out of the exported install.
   *
   * **Speech and music** on a retail disc are entries in `SPEECH1.CLU` and
   * `MUSIC1.CLU`, files `resource.inf` never names — and neither demo ships
   * one, so no container can be rebuilt here and that row stays written and
   * unverified (`docs/editor-parity.md` §27a). What can be measured without a
   * container is the compression itself, which is the part a container would
   * not have told us anyway: it is run below over the demo's own recordings.
   */
  const { readWavePcm, resampleWavePcm, writeWavePcm } =
    await import('../src/engine/sound/wave.js');
  const { Sword2FileType } = await import('../src/engine/sword2/resource/sword2Headers.js');
  const SWORD2_WAV_FILE = Sword2FileType.WAV_FILE;
  const { decodeSword2Clu, encodeSword2Clu, SWORD2_CLU_RATE } =
    await import('../src/engine/sword2/sound/sword2Clu.js');

  const recordings: Array<{ id: number; samples: Int16Array }> = [];
  for (const id of resources.allIds()) {
    if (recordings.length >= 32) break;
    const loaded = await resources.loadStreamed(id);
    if (!loaded || loaded.header.fileType !== SWORD2_WAV_FILE) continue;
    const pcm = readWavePcm(loaded.payload);
    if (!pcm || pcm.samples.length === 0) continue;
    recordings.push({ id, samples: resampleWavePcm(pcm.samples, pcm.sampleRate, SWORD2_CLU_RATE) });
  }
  console.log('recordings  ', recordings.length, 'WAV_FILE resources read for the codec check');

  // Encoded and decoded again, compared as samples rather than as bytes: this
  // compression has eight amplitudes and sixteen shifts, so it is lossy by
  // construction and byte identity is the wrong question. What matters is that
  // an error stays bounded rather than drifting away over a long recording.
  let worst = 0;
  let total = 0;
  let counted = 0;
  for (const recording of recordings) {
    const back = decodeSword2Clu(encodeSword2Clu(recording.samples));
    for (let at = 0; at < recording.samples.length; at++) {
      const error = Math.abs(back[at]! - recording.samples[at]!);
      worst = Math.max(worst, error);
      total += error;
      counted++;
    }
  }
  if (counted > 0) {
    console.log(
      `codec       ${counted} samples encoded and decoded again: mean error ` +
        `${(total / counted).toFixed(2)}, worst ${worst} (full scale 65,536)`,
    );
  }
  const containers = resources.soundFiles;
  console.log(
    `containers  ${containers.length} speech or music containers beside the clusters` +
      `${containers.length === 0 ? ' — so the write path here is unverified, not unwritten' : ''}`,
  );

  // The effect substitution, carried by the same export as everything else.
  const effect = recordings[0];
  let effectWanted: Uint8Array | null = null;
  if (effect) {
    // Quieter by half, which changes every sample and keeps the length: a
    // replacement that changed the length would also be testing the rebuild,
    // and that is the picture rows' job.
    const quieter = Int16Array.from(effect.samples, (sample) => (sample / 2) | 0);
    effectWanted = writeWavePcm(quieter, SWORD2_CLU_RATE);
  }

  /*
   * The same row for this family, which the index makes a different operation:
   * `resource.tab` gains an entry at the end and the copy's cluster gains a
   * tail entry at the end, and the copy goes into a session so that it is an
   * object that runs rather than an object that merely exists.
   */
  const { appendSword2Object, editSword2RunList } =
    await import('../src/authoring/sword2/edits.js');
  const copiedFrom = sword2.objects.find((each) => each.roundTrips)!;
  const objectsBefore = sword2.objects.length;
  const appendedId = appendSword2Object(project, copiedFrom.id);
  const session = sword2.runLists[0]!;
  const sessionBefore = session.objects.length;
  editSword2RunList(project, session.resource, [...session.objects, appendedId]);

  const edited = exportSword2Game(
    {
      declared,
      clusters,
      resourceTab,
      ...(effect && effectWanted ? { effects: [{ id: effect.id, data: effectWanted }] } : {}),
    },
    sword2,
  );
  const grownTab = edited.files.find((file) => file.name === 'resource.tab');
  console.log(
    `append      resource.tab ${resourceTab.length} -> ${grownTab?.data.length} bytes, its ` +
      `first ${resourceTab.length} unchanged: ` +
      `${grownTab ? resourceTab.every((byte, at) => grownTab.data[at] === byte) : false}`,
  );
  const root = await install('sword2', edited.files);
  const reopened = await openGame(root);
  const again = await Sword2Resources.create(reopened);
  for (const name of again.presentClusters) await again.loadCluster(name, true);
  const back = importSword2Project(again, identifySword2(reopened.list()));
  const readBack = back.objects
    .find((each) => each.id === object.id)!
    .instructions.find((instruction) => instruction.at === target.at)!;
  console.log(
    `edit        object ${object.id} byte ${target.at}: ` +
      `${target.operands[0]} -> ${readBack.operands[0]} (wanted ${wanted})`,
  );
  const appendedBack = back.objects.find((each) => each.id === appendedId);
  // The object this run edited above is expected to differ; everything else is
  // expected not to, which is what an append not being an insert means.
  let unmoved = 0;
  let compared = 0;
  for (const each of sword2.objects) {
    if (each.appendedFrom !== undefined || each.id === object.id) continue;
    compared++;
    if (
      back.objects.find((candidate) => candidate.id === each.id)?.bytesBase64 === each.bytesBase64
    ) {
      unmoved++;
    }
  }
  console.log(
    `append      object ${appendedId} (${appendedBack?.name}) copied from ${copiedFrom.id}: ` +
      `${objectsBefore} objects -> ${back.objects.length}, round-trips ` +
      `${appendedBack?.roundTrips}, same code as its source ` +
      `${JSON.stringify(appendedBack?.instructions) === JSON.stringify(back.objects.find((each) => each.id === copiedFrom.id)?.instructions)}; ` +
      `run list ${session.resource} ${sessionBefore} -> ` +
      `${back.runLists.find((each) => each.resource === session.resource)?.objects.length} objects; ` +
      `${unmoved} of ${compared} existing objects unmoved (object ${object.id} is the one this ` +
      `run edited)`,
  );
  if (effect && effectWanted) {
    const readBackEffect = await again.loadStreamed(effect.id);
    const carried = readBackEffect ? same(readBackEffect.payload, effectWanted) : false;
    console.log(
      `replace     effect ${effect.id} (${effect.samples.length} samples): ` +
        `${readBackEffect?.payload.length} bytes back, identical to what was written: ${carried}, ` +
        `header still a WAV_FILE: ${readBackEffect?.header.fileType === SWORD2_WAV_FILE}`,
    );
  }
  if (screen && layer) {
    const readPixel = sword2ScreenLayerPixels(back, screen.resource, 2)?.pixels[pixelAt];
    console.log(
      `edit        screen ${screen.resource} (${layer.width}x${layer.height} background) ` +
        `pixel ${pixelAt}: ${pixelWas} -> ${readPixel} (wanted ${pixelWanted})`,
    );
  }
  await bootBoth(root, overlaySource(await openGame(folder), edited.files));
  await stat(join(root, 'resource.tab'));
  // Every id the game shipped still names what it did: the file is longer by
  // one entry and identical for the 4,147 that were already in it, which is
  // checked byte for byte on the `append` line above.
  console.log('resource.tab’s shipped entries came through untouched: true');
}
