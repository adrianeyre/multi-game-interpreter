/**
 * Writes an edited Broken Sword II back out as a playable install.
 *
 * Same principle as `sword1/export.ts` — "copy what was not touched, substitute
 * what was, rebuild the index" — against a layout that makes the rebuild
 * *smaller*, which is worth stating because it looks like an omission.
 *
 * ## Only the cluster tails move
 *
 * Sword2's index is two files and they do different jobs. `resource.tab` maps a
 * resource **id** to a `(cluster, index within that cluster)` pair, and each
 * cluster carries its own table of `(offset, length)` in its tail. An edit
 * changes a resource's *size* and therefore its offset — but never which
 * cluster it is in, and never its index within that cluster.
 *
 * So `resource.tab`, `resource.inf` and `cd.inf` are **copied through
 * unchanged**, and the only thing rebuilt is each cluster's own tail. That is
 * not a shortcut: rewriting `resource.tab` would be writing the same bytes back
 * with extra chances to be wrong.
 *
 * ## What this refuses
 *
 * An object whose code did not round-trip on import. `Sword2ProjectObject.roundTrips`
 * is checked per object at import time, and writing a misreading back produces a
 * game that runs until it does not.
 *
 * It also refuses an object whose **checksum block** would disagree with its
 * code. Sword2 stores a code length and a byte sum beside every script block and
 * the interpreter checks them, so an export has to recompute both — and this
 * one does, which is why an edited script is a legal object rather than one that
 * merely parses.
 */

import { fromBase64 } from '../base64.js';
import { reassembleSword2Code, type Sword2Instruction } from './disassemble.js';
import type { Sword2Project } from './project.js';
import { rebuildSword2Sound, type Sword2SoundReplacement } from './soundContainer.js';
import { encodeSingleByte } from '../../engine/resource/singleByteText.js';
import {
  OBJECT_HUB_SIZE,
  readSword2MultiScreenHeader,
  RES_HEADER_SIZE,
  Sword2FileType,
  SWORD2_TEXT_ENCODING,
  TEXT_HEADER_SIZE,
} from '../../engine/sword2/resource/sword2Headers.js';
import { SWORD2_SCRIPT_ID } from '../../engine/sword2/script/Sword2Interpreter.js';
import { SWORD2_GLOBAL_VAR_RESOURCE } from '../../engine/sword2/script/sword2Vars.js';
import { writeSword2WalkGrid } from '../../engine/sword2/script/sword2WalkGrid.js';

/** Raised when an export is refused, with what was wrong. */
export class Sword2ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword2ExportError';
  }
}

/** The files an export reads from and writes back over. */
export interface Sword2ExportSource {
  /**
   * Every cluster `resource.inf` names, in the order it names them.
   *
   * The order is the identity: `resource.tab` says which cluster a resource is
   * in by that **line number**, so a folder holding five of the fourteen
   * clusters the demo declares cannot be matched up by position in the list of
   * files it happens to have. Taking the declared names is the difference
   * between reading `TEXT.CLU`'s resources out of `Docks.clu` and reading them
   * out of `TEXT.CLU`.
   */
  readonly declared: readonly string[];
  /** The cluster files this folder holds, named as `resource.inf` names them. */
  readonly clusters: ReadonlyArray<{ name: string; data: Uint8Array }>;
  /** `resource.tab`, as it was read. Copied through. */
  readonly resourceTab: Uint8Array;
  /**
   * An effect an author replaced, as the resource id it is the payload of.
   *
   * An effect is an ordinary `WAV_FILE` resource, so this is a substitution
   * like every other and the cluster is relaid around it. The 44-byte resource
   * header it arrived with is kept — it holds the resource's own name, which
   * nothing here could invent — and only the payload behind it is new.
   */
  readonly effects?: ReadonlyArray<{ readonly id: number; readonly data: Uint8Array }>;
  /**
   * The streamed containers, when a recording in one is to be replaced.
   *
   * Speech and music in this family are the one thing that is not a resource:
   * `SPEECH1.CLU` and `MUSIC1.CLU` are opened by name and indexed by the id a
   * script plays them by, and `resource.inf` never mentions them. Supplied by
   * whoever has the folder open, and **absent from every install reachable
   * here** — both demos ship neither, so this path is written and unverified
   * (`docs/editor-parity.md` §27a).
   */
  readonly sounds?: ReadonlyArray<{
    readonly name: string;
    readonly data: Uint8Array;
    readonly replacements: readonly Sword2SoundReplacement[];
  }>;
}

export interface Sword2ExportedFile {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface Sword2ExportReport {
  readonly files: readonly Sword2ExportedFile[];
  readonly rewritten: readonly number[];
  /** Resources copied through untouched, which should be almost all of them. */
  readonly copied: number;
  /**
   * Clusters `resource.inf` declares that this folder does not hold.
   *
   * Normal rather than a fault: the demo declares fourteen and ships five, and
   * a one-CD install declares both discs' clusters whichever disc it was read
   * from. No file is written for them, so an export names them rather than
   * implying a complete install — and an edit that lands in one is refused by
   * name instead of being written somewhere it would not be found.
   */
  readonly missing: readonly string[];
  /**
   * The containers rebuilt, and which recordings in each changed.
   *
   * Named separately from `rewritten` because a line of speech has no resource
   * id in this family — the same reason Sword 1's report names its speech
   * container apart from its clusters.
   */
  readonly sounds: ReadonlyArray<{ readonly file: string; readonly replaced: readonly string[] }>;
}

/**
 * Re-emits one object's resource with its edited code in it.
 *
 * The layout is read back from the object's own bytes rather than from the
 * project's record of it, because the record describes where things *were* and
 * this is building where they will be. The three things that move are the code,
 * the offset table and the checksum block — everything before the variable
 * block is copied byte for byte, which is what keeps an object with an edited
 * string identical everywhere else.
 */
function rebuildObject(
  bytes: Uint8Array,
  instructions: readonly Sword2Instruction[],
  entries: readonly number[],
  name: string,
): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const scriptBase = RES_HEADER_SIZE + OBJECT_HUB_SIZE;
  const localsBytes = view.getUint32(scriptBase, true);
  const head = scriptBase + 4 + localsBytes;

  const rebuilt = reassembleSword2Code(instructions, entries);
  const scriptCount = rebuilt.entries.length;

  // header + hub + size word + locals + count + offsets + identifier/len/sum
  const prefix = head + 4 + scriptCount * 4 + 12;
  const out = new Uint8Array(prefix + rebuilt.code.length);
  out.set(bytes.subarray(0, Math.min(head, bytes.length)), 0);

  const outView = new DataView(out.buffer);
  let at = head;
  outView.setUint32(at, scriptCount, true);
  at += 4;
  for (const entry of rebuilt.entries) {
    outView.setUint32(at, entry, true);
    at += 4;
  }
  outView.setUint32(at, SWORD2_SCRIPT_ID, true);
  outView.setUint32(at + 4, rebuilt.code.length, true);

  // The byte sum the interpreter checks. Recomputed rather than copied: an
  // edited script with its old checksum is an object the game complains about.
  let checksum = 0;
  for (const byte of rebuilt.code) checksum = (checksum + byte) >>> 0;
  outView.setUint32(at + 8, checksum, true);
  out.set(rebuilt.code, at + 12);

  // The resource header is left exactly as it arrived. Its two length fields
  // read like the thing to update and are not: they are zero in every resource
  // the game ships, nothing in ScummVM's resource manager reads them, and a
  // resource's real length is the one in its cluster's tail table. Writing a
  // length here changed 3,390 bytes of SCRIPTS.CLU for no reader at all.
  void name;
  return out;
}

/**
 * Re-emits a text module: a count, an offset table, then the lines.
 *
 * Three things here are what make an unedited module come back byte-identical.
 *
 * The offsets are measured from the **resource's start**, header included,
 * which is where `fetchTextLine` measures them from. The wav id in front of
 * each string is written from the project rather than zeroed — it is the
 * number `fnISpeak` plays the line's recording by, so zeroing it ships
 * subtitles with no voices. And the 44-byte resource header is copied whole
 * rather than rebuilt: its two length fields are zero in all 112 of the demo's
 * text resources and in every other resource it ships, neither we nor ScummVM
 * read them, and writing a length into them changes bytes for no reader.
 */
function rebuildText(
  lines: readonly string[],
  wavIds: readonly number[],
  original: Uint8Array,
): Uint8Array {
  const table = RES_HEADER_SIZE + TEXT_HEADER_SIZE;
  const header = table + lines.length * 4;
  const bodies = lines.map((line) => {
    const encoded = encodeSingleByte(line, SWORD2_TEXT_ENCODING);
    const bytes = new Uint8Array(2 + encoded.length + 1);
    bytes.set(encoded, 2);
    return bytes;
  });

  const out = new Uint8Array(header + bodies.reduce((sum, body) => sum + body.length, 0));
  out.set(original.subarray(0, Math.min(RES_HEADER_SIZE, original.length)), 0);
  const view = new DataView(out.buffer);
  view.setUint32(RES_HEADER_SIZE, lines.length, true);
  let at = header;
  bodies.forEach((body, line) => {
    view.setUint32(table + line * 4, at, true);
    out.set(body, at);
    view.setUint16(at, wavIds[line] ?? 0, true);
    at += body.length;
  });
  return out;
}

/** Writes an edited game back out. */
export function exportSword2Game(
  source: Sword2ExportSource,
  project: Sword2Project,
): Sword2ExportReport {
  // What each edited resource becomes, as a function of what it was: a text
  // module keeps the 44-byte resource header it arrived with, and an object
  // and the globals build their own.
  const edited = new Map<number, (original: Uint8Array) => Uint8Array>();

  for (const object of project.objects) {
    if (!object.roundTrips) {
      throw new Sword2ExportError(
        `Object "${object.name}" (${object.id}) did not re-emit byte-identically when it was ` +
          `imported, so this project's reading of it is wrong somewhere. Writing it back would ` +
          `put that misreading into the game, which is refused.`,
      );
    }
    edited.set(object.id, () =>
      rebuildObject(
        fromBase64(object.bytesBase64),
        object.instructions as readonly Sword2Instruction[],
        object.entries,
        object.name,
      ),
    );
  }

  // Text. Left out of the export until now, which is the kind of omission that
  // reads as a working feature: an author edited a line, the editor showed the
  // new line, and the exported game shipped the old one.
  for (const entry of project.text) {
    edited.set(entry.resource, (original) => rebuildText(entry.lines, entry.wavIds, original));
  }

  // The globals: one resource whose payload is the variable block, so the
  // rebuild is the header it arrived with and the words the project holds.
  if (project.globals.bytesBase64) {
    const payload = fromBase64(project.globals.bytesBase64);
    edited.set(SWORD2_GLOBAL_VAR_RESOURCE, (original) => {
      const out = new Uint8Array(RES_HEADER_SIZE + payload.length);
      out.set(original.subarray(0, Math.min(RES_HEADER_SIZE, original.length)), 0);
      // File type 5 is `GLOBAL_VAR_FILE`, which is what the engine checks
      // before it will read a variable out of it. Asserted rather than
      // rebuilt: the rest of the header is the resource's own name and two
      // vestigial lengths, and inventing those loses the name.
      out[0] = Sword2FileType.GLOBAL_VAR_FILE;
      out.set(payload, RES_HEADER_SIZE);
      return out;
    });
  }

  /*
   * Screens and animations, which is what makes a repainted background leave
   * the editor.
   *
   * Both are carried **whole**. The project holds each one as the resource the
   * cluster held, header and all, and every edit to one — `replaceSword2Screen\
   * Layer`, `replaceSword2AnimationFrame` — rewrites that resource in place,
   * offsets and CDT entries included. There is nothing left for the exporter to
   * rebuild and nothing it could rebuild better: the substitution is the bytes.
   *
   * Every screen and every animation is substituted, edited or not, exactly as
   * every object and every text module is, so an untouched export is still the
   * bytes it arrived as.
   *
   * The two limits that stay are the picture budget's, not the format's: a
   * screen or an animation left out of the project on import — `import.ts`
   * counts them into `editable.reasons` — has no entry here and is copied
   * through as it stands, which is right rather than lossy.
   */
  for (const screen of project.screens) {
    const bytes = fromBase64(screen.bytesBase64);
    if (bytes.length === 0) continue;
    edited.set(screen.resource, () => bytes);
  }
  for (const animation of project.animations) {
    const bytes = fromBase64(animation.bytesBase64);
    if (bytes.length === 0) continue;
    edited.set(animation.resource, () => bytes);
  }

  /*
   * Palettes, folded into the screen resource that owns one.
   *
   * A palette is not a resource here: it is the 1,024-byte block a screen's
   * multi-screen header points at, and `import.ts` slices it out so the editor
   * can show colours rather than a screen file. So writing one means writing
   * into its screen — on top of whatever the screen substitution above just
   * produced, which is why this composes with it rather than replacing it.
   *
   * That composition also covers the case the budget makes: a screen too big
   * for the project still has its palette in it, so a palette edit lands even
   * where the screen's own bytes were never carried.
   */
  for (const palette of project.palettes) {
    const quads = fromBase64(palette.bytesBase64);
    if (quads.length === 0) continue;
    const screen = edited.get(palette.screen);
    edited.set(palette.screen, (original) => {
      const out = Uint8Array.from(screen ? screen(original) : original);
      if (out.length < RES_HEADER_SIZE + 36) return out;
      const at = RES_HEADER_SIZE + readSword2MultiScreenHeader(out, RES_HEADER_SIZE).palette;
      if (at === RES_HEADER_SIZE || at + quads.length > out.length) {
        throw new Sword2ExportError(
          `Screen ${palette.screen}'s palette is ${quads.length} bytes and its resource has no ` +
            `room for it at ${at}, so the edit cannot be written without moving a block this ` +
            `exporter does not understand.`,
        );
      }
      out.set(quads, at);
      return out;
    });
  }

  /*
   * Run lists: the object ids alive in a session, NUL-terminated.
   *
   * Written into the payload the resource already has rather than rebuilt, so
   * that the bytes past the terminator — which nothing reads, and which the
   * game shipped — come back as they were and an unedited list is identical.
   *
   * A list *longer* than the resource it arrived in extends it, which is worth
   * saying because it used to be refused and the refusal was wrong. A cluster's
   * tail table carries an `(offset, length)` per resource and the layout pass
   * below rewrites both, so a resource that grew is a resource the index still
   * finds — `Sword2Resources.fetch` reads exactly the length that table gives
   * it. None of the demo's thirteen run lists has a spare word, so a session
   * that is to run an appended object needs this and nothing less: the game's
   * own lists are packed tight against their terminator.
   */
  for (const runList of project.runLists) {
    edited.set(runList.resource, (original) => {
      const needed = RES_HEADER_SIZE + (runList.objects.length + 1) * 4;
      const out = new Uint8Array(Math.max(needed, original.length));
      out.set(original, 0);
      const view = new DataView(out.buffer);
      runList.objects.forEach((id, at) => view.setUint32(RES_HEADER_SIZE + at * 4, id, true));
      view.setUint32(RES_HEADER_SIZE + runList.objects.length * 4, 0, true);
      return out;
    });
  }

  /*
   * Walk grids: the bars a mega may not cross, written back from segments.
   *
   * The resource's own 44-byte header is put back in front rather than rebuilt,
   * for the reason the globals' is: it holds the resource's name, and this
   * project models no field that would let it be invented. `writeSword2WalkGrid`
   * re-derives a bar's bounding box, deltas and line constant, and all four of
   * the demo's grids re-emit byte-identically from that derivation — counted in
   * `npm run sweep:sword` every run.
   */
  for (const grid of project.walkGrids ?? []) {
    const header = fromBase64(grid.headerBase64);
    if (header.length < RES_HEADER_SIZE) continue;
    edited.set(grid.resource, () => writeSword2WalkGrid(grid, header));
  }

  /*
   * Effects, which are the one kind of recording this family keeps as a
   * resource and therefore the only one an install here can prove.
   *
   * The header is kept and the payload substituted, for the globals' reason: a
   * resource header holds the resource's own name and two vestigial lengths,
   * and rebuilding it would lose the name. The type byte is checked rather
   * than overwritten — writing WAVE bytes into a resource that is a screen
   * would produce an install that boots and then plays a picture.
   */
  for (const effect of source.effects ?? []) {
    edited.set(effect.id, (original) => {
      if (original.length >= 1 && original[0] !== Sword2FileType.WAV_FILE) {
        throw new Sword2ExportError(
          `Resource ${effect.id} has been replaced with a recording and this install says it is ` +
            `file type ${original[0]}, not a WAV_FILE. The new bytes are refused rather than ` +
            `written over a resource that is not a sound.`,
        );
      }
      const out = new Uint8Array(RES_HEADER_SIZE + effect.data.length);
      out.set(original.subarray(0, Math.min(RES_HEADER_SIZE, original.length)), 0);
      out.set(effect.data, RES_HEADER_SIZE);
      return out;
    });
  }

  const files: Sword2ExportedFile[] = [];
  const rewritten: number[] = [];
  const missing: string[] = [];
  let copied = 0;

  // `resource.tab` says which cluster and which index a resource is at, and an
  // edit changes neither — so it is copied, and only the tails are rebuilt.
  const table = new DataView(
    source.resourceTab.buffer,
    source.resourceTab.byteOffset,
    source.resourceTab.byteLength,
  );
  const idsByCluster = new Map<number, Array<{ id: number; index: number }>>();
  for (let id = 0; id * 4 + 3 < source.resourceTab.length; id++) {
    const cluster = table.getUint16(id * 4, true);
    const index = table.getUint16(id * 4 + 2, true);
    if (cluster === 0xffff) continue;
    const list = idsByCluster.get(cluster) ?? [];
    list.push({ id, index });
    idsByCluster.set(cluster, list);
  }

  const supplied = new Map(
    source.clusters.map((cluster) => [cluster.name.toLowerCase(), cluster] as const),
  );

  /*
   * Objects the editor appended, which are the one thing here that adds an
   * index entry rather than moving one.
   *
   * A copy goes into the cluster its source is in, at the index one past that
   * cluster's last — both tables grow at the end, so no id changes meaning and
   * `resource.tab` stays a copy of itself for every id the game shipped. The
   * source's own entry is where the cluster comes from: the project knows which
   * object was copied, and `resource.tab` knows where that object lives.
   */
  const appendedByCluster = new Map<number, Array<{ id: number; data: Uint8Array }>>();
  for (const object of project.objects) {
    if (object.appendedFrom === undefined) continue;
    if (object.appendedFrom * 4 + 3 >= source.resourceTab.length) {
      throw new Sword2ExportError(
        `Object ${object.id} was appended as a copy of ${object.appendedFrom}, and this index ` +
          `declares no such id, so there is no cluster to put the copy in.`,
      );
    }
    const cluster = table.getUint16(object.appendedFrom * 4, true);
    if (cluster === 0xffff) {
      throw new Sword2ExportError(
        `Object ${object.id} was appended as a copy of ${object.appendedFrom}, which this index ` +
          `says is in no cluster.`,
      );
    }
    const list = appendedByCluster.get(cluster) ?? [];
    list.push({
      id: object.id,
      data: rebuildObject(
        fromBase64(object.bytesBase64),
        object.instructions as readonly Sword2Instruction[],
        object.entries,
        object.name,
      ),
    });
    appendedByCluster.set(cluster, list);
  }
  const appendedAt = new Map<number, { cluster: number; index: number }>();

  source.declared.forEach((declaredName, clusterIndex) => {
    const ids = idsByCluster.get(clusterIndex) ?? [];
    const cluster = supplied.get(declaredName.toLowerCase());

    if (!cluster) {
      // An absent cluster is normal, and an edit inside one is not. Refusing by
      // name beats writing a file the install has no place for.
      const stranded = ids.filter((entry) => edited.has(entry.id)).map((entry) => entry.id);
      if (stranded.length > 0) {
        throw new Sword2ExportError(
          `resource.inf names the cluster ${declaredName} and this folder has no file for it, ` +
            `but ${stranded.length} edited resource${stranded.length === 1 ? '' : 's'} ` +
            `(${stranded.slice(0, 5).join(', ')}) live in it. Open the folder that holds ` +
            `${declaredName} and export from there.`,
        );
      }
      missing.push(declaredName);
      return;
    }

    const bytes = cluster.data;
    if (bytes.length < 4) {
      throw new Sword2ExportError(`${cluster.name} is ${bytes.length} bytes and holds no index.`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tableOffset = view.getUint32(0, true);
    if (tableOffset < 4 || tableOffset > bytes.length) {
      throw new Sword2ExportError(
        `${cluster.name} says its index is at ${tableOffset} and the file is ${bytes.length} ` +
          `bytes, so it cannot be rebuilt against.`,
      );
    }
    const entryCount = (bytes.length - tableOffset) / 8;
    if (!Number.isInteger(entryCount)) {
      throw new Sword2ExportError(
        `${cluster.name}'s index is not a whole number of (offset, length) pairs, so it cannot ` +
          `be rebuilt against.`,
      );
    }

    const byIndex = new Map(ids.map((entry) => [entry.index, entry.id]));
    const entries: Array<{ index: number; offset: number; length: number }> = [];
    for (let index = 0; index < entryCount; index++) {
      entries.push({
        index,
        offset: view.getUint32(tableOffset + index * 8, true),
        length: view.getUint32(tableOffset + index * 8 + 4, true),
      });
    }

    // The appended copies take the indices past the end of this table, and
    // their bytes go after the last resource in the file — which the layout
    // pass below reaches by giving them an offset of `tableOffset`, the first
    // byte no resource occupies. Everything already in the cluster keeps the
    // offset it had.
    const extra = appendedByCluster.get(clusterIndex) ?? [];
    extra.forEach((object, at) => {
      const index = entryCount + at;
      byIndex.set(index, object.id);
      edited.set(object.id, () => object.data);
      entries.push({ index, offset: tableOffset, length: 0 });
      appendedAt.set(object.id, { cluster: clusterIndex, index });
    });
    const outCount = entryCount + extra.length;

    // Lay the cluster out in the order its bytes are already in, not in index
    // order, and carry the gaps between resources with it. Both matter: the
    // demo's clusters address their resources out of order — Players.clu's
    // first entry sits 456,313 bytes in — and there is padding between them
    // that nothing reads and every byte of which has to come back. Rebuilding
    // in index order from offset 4 produced a working game that shared almost
    // no bytes with the one it was made from.
    const order = [...entries].sort(
      (first, second) => first.offset - second.offset || first.index - second.index,
    );
    const parts: Uint8Array[] = [bytes.subarray(0, order[0]?.offset ?? tableOffset)];
    const placed = new Map<number, { offset: number; length: number }>();
    let at = parts[0]!.length;
    let read = at;
    for (const entry of order) {
      if (entry.offset > read) {
        parts.push(bytes.subarray(read, entry.offset));
        at += entry.offset - read;
      }
      const id = byIndex.get(entry.index);
      const rebuild = id === undefined ? undefined : edited.get(id);
      const original = bytes.subarray(entry.offset, entry.offset + entry.length);
      const data = rebuild ? rebuild(original) : original;
      if (rebuild && id !== undefined) rewritten.push(id);
      else copied++;
      placed.set(entry.index, { offset: at, length: data.length });
      parts.push(data);
      at += data.length;
      read = Math.max(read, entry.offset + entry.length);
    }
    if (tableOffset > read) {
      parts.push(bytes.subarray(read, tableOffset));
      at += tableOffset - read;
    }

    const out = new Uint8Array(at + outCount * 8);
    const outView = new DataView(out.buffer);
    let write = 0;
    for (const part of parts) {
      out.set(part, write);
      write += part.length;
    }
    outView.setUint32(0, at, true);
    for (let index = 0; index < outCount; index++) {
      const entry = placed.get(index) ?? { offset: 0, length: 0 };
      outView.setUint32(at + index * 8, entry.offset, true);
      outView.setUint32(at + index * 8 + 4, entry.length, true);
    }
    files.push({ name: cluster.name, data: out });
  });

  /*
   * `resource.tab`, which is copied through byte for byte unless something was
   * appended — and then it is those same bytes with entries on the end.
   *
   * Written only when it grows, so the untouched-export claim the reexport
   * makes ("resource.tab came through untouched") stays a claim about the
   * file rather than about a rewrite that happened to match.
   */
  if (appendedAt.size > 0) {
    const declaredCount = project.resourceCount ?? source.resourceTab.length / 4;
    const grown = new Uint8Array(Math.max(declaredCount, source.resourceTab.length / 4) * 4);
    grown.fill(0xff);
    grown.set(source.resourceTab, 0);
    const grownView = new DataView(grown.buffer);
    for (const [id, where] of appendedAt) {
      if (id * 4 + 3 >= grown.length) {
        throw new Sword2ExportError(
          `Object ${id} was appended but this project says the index declares ` +
            `${declaredCount} ids, so there is no entry for it to take.`,
        );
      }
      grownView.setUint16(id * 4, where.cluster, true);
      grownView.setUint16(id * 4 + 2, where.index, true);
    }
    files.push({ name: 'resource.tab', data: grown });
  }

  const stranded = [...project.objects].filter(
    (object) => object.appendedFrom !== undefined && !appendedAt.has(object.id),
  );
  if (stranded.length > 0) {
    throw new Sword2ExportError(
      `${stranded.length} appended object${stranded.length === 1 ? '' : 's'} ` +
        `(${stranded.map((object) => object.id).join(', ')}) belong to a cluster this folder ` +
        `does not hold, so there is nowhere to write them.`,
    );
  }

  /*
   * And the containers, which are the one thing here that is not a resource.
   *
   * Rebuilt rather than copied so that a replaced line of speech leaves the
   * editor, and rebuilt only when the caller supplied one: a retail speech
   * container is hundreds of megabytes and an export that did not touch speech
   * should not carry a copy of it.
   */
  const sounds = (source.sounds ?? []).map((container) => {
    const rebuilt = rebuildSword2Sound(container.name, container.data, container.replacements);
    files.push({ name: container.name, data: rebuilt.data });
    return { file: container.name, replaced: rebuilt.replaced };
  });

  return { files, rewritten, copied, missing, sounds };
}

/** Re-emits a text module, exported for the editor's own use. */
export { rebuildText as rebuildSword2Text };
