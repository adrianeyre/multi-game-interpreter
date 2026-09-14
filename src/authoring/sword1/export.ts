/**
 * Writes an edited Broken Sword back out as a playable install.
 *
 * ## The principle is the one every layout here follows
 *
 * `CONTEXT.md` states it once for all three SCUMM Resource layouts — "copy what
 * was not touched, substitute what was, rebuild the index" — and it is exactly
 * what this does. A resource an author never opened is written back as the
 * bytes it arrived as, so an export with no edits in it is byte-identical to
 * its input. That property is not a nicety: it is what makes a diff of an
 * exported install *the author's changes and nothing else*.
 *
 * ## What has to be rebuilt, and why it is only the index
 *
 * A Broken Sword cluster is a flat run of resources with no internal structure
 * — no directory, no back-references — and `swordres.rif` holds every offset
 * and length. So a resource that changes size moves everything after it in its
 * cluster and invalidates nothing except the index. That is the whole of the
 * rebuild:
 *
 * 1. Re-emit each edited resource from the project.
 * 2. Lay every cluster out again, in the index's own order.
 * 3. Write a new `swordres.rif` with the offsets and lengths that fell out.
 *
 * The index's *shape* is preserved exactly — the same clusters, the same
 * groups, the same presence tables, the same holes. Only offsets and lengths
 * move, because anything else would renumber resources the game's own scripts
 * address by id.
 *
 * ## The two things that are not in the index at all
 *
 * Almost every byte an export writes is addressed through `swordres.rif`. Two
 * are not, and both are recordings.
 *
 * **Speech** is one file beside the install with an index of its own, so it is
 * rebuilt by `speechContainer.ts` and appended to the files this writes. It is
 * rebuilt only when the caller hands the container over, because it is
 * forty-odd megabytes and an export with no line to replace has no reason to
 * copy it. **Music** is a file per tune, addressed by name rather than by
 * number (ADR 0029), so carrying a replaced one out is writing that file and
 * nothing else.
 *
 * An **effect** is neither: it is an ordinary resource inside a cluster, so it
 * joins the substitutions and needs no path of its own.
 *
 * ## What this refuses, and why refusing is right
 *
 * A script module that did not round-trip on import is refused rather than
 * written. `Sword1ProjectScript.roundTrips` is checked per module at import
 * time; a module that re-emits differently from how it arrived is a module this
 * project misread, and writing a misreading back produces a game that runs
 * until it does not. The refusal names the module.
 */

import { fromBase64 } from '../base64.js';
import { reassembleSword1Script, type Sword1Instruction } from './disassemble.js';
import type { Sword1Project } from './project.js';
import {
  clusterOf,
  formatResourceId,
  groupOf,
  indexOf,
  parseRif,
  resourceId,
  type RifIndex,
} from '../../engine/sword1/resource/rif.js';
import { SWORD1_HEADER_SIZE } from '../../engine/sword1/resource/swordDefs.js';
import { writeSwordTextResource } from '../../engine/sword1/resource/swordTextResources.js';
import { writeSword1WalkGrid } from '../../engine/sword1/script/swordWalkGrid.js';
import { rebuildSword1Speech, type Sword1SpeechReplacement } from './speechContainer.js';
import {
  patchSword1Executable,
  readSword1Executable,
  type Sword1ExecutableEdit,
} from './executable.js';
import type { Sword1RoomDef } from '../../engine/sword1/resource/swordRooms.js';

/** Raised when an export is refused, with what was wrong. */
export class Sword1ExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword1ExportError';
  }
}

/** The files an export reads from and writes back over. */
export interface Sword1ExportSource {
  /** `swordres.rif`, as it was read. */
  readonly indexFile: string;
  readonly index: Uint8Array;
  /** Every cluster file, named as the folder has them. */
  readonly clusters: ReadonlyArray<{ name: string; label: string; data: Uint8Array }>;
  /**
   * The speech container, when a line in it is to be replaced.
   *
   * Optional, and the option is a size rather than a preference: the demo's
   * container is 43.9 MB and a retail disc's is 45.5 MB, so reading one in to
   * write it straight back out again would make every export forty megabytes
   * larger for nothing. Supplied, it is rebuilt and emitted; absent, it is
   * left where it is and the export does not mention it.
   *
   * With an empty `replacements` the rebuild is a copy, which is exactly what
   * `npm run reexport:sword` uses to prove that it is one.
   */
  readonly speech?: {
    /** The file's name as the folder has it, e.g. `SPEECH/COWS.MAD`. */
    readonly name: string;
    readonly data: Uint8Array;
    readonly replacements?: readonly Sword1SpeechReplacement[];
    /** The Macintosh releases' sample order, as `checkSpeechEndianness` found it. */
    readonly bigEndian?: boolean;
  };
  /**
   * Tunes an author replaced, each with the file in the install it belongs to.
   *
   * A tune is not a resource: `MUSIC/1M10.WAV` sits beside the clusters and is
   * addressed by *name* through `SWORD1_TUNE_NAMES` (ADR 0029), so there is no
   * index to rebuild and the whole of carrying one out is writing the file.
   * The bytes are written as they arrived, because a shipped tune is already
   * 11,025 Hz mono PCM WAVE and `parseWave` reads the replacement the same way
   * it reads the original — the caller has already had it agree.
   */
  readonly music?: ReadonlyArray<{ readonly file: string; readonly data: Uint8Array }>;
  /**
   * Effects an author replaced, as the resource ids the fx table gives them.
   *
   * These *are* resources, so they need no path of their own: they join the
   * substitutions a script or a picture edit makes and the cluster is laid out
   * again around them. An effect whose cluster this folder does not hold is
   * refused by the same sentence that refuses an edited picture in one.
   *
   * Substituted whole rather than as a payload, for the reason a palette is:
   * an fx resource carries no Sword 1 header — it begins `RIFF` — so there is
   * no header to size.
   */
  readonly effects?: ReadonlyArray<{ readonly id: number; readonly data: Uint8Array }>;
  /**
   * The install's executables, when the folder ships them.
   *
   * The room table and the start positions are not in any cluster: Revolution
   * built them into the interpreter, and the interpreter is in the box next to
   * the clusters. So these are the file the two surfaces are written back to,
   * and an export that is given them carries them out — patched where the
   * project changed a row, byte-identical where it did not, and copied through
   * untouched for an executable that holds neither table.
   *
   * Optional for the reason `speech` is: reading three executables in to write
   * them straight back out costs 3.4 MB an export, so a caller that has no
   * executable edit to make may leave them out and the export does not mention
   * them.
   */
  readonly executables?: ReadonlyArray<{ readonly name: string; readonly data: Uint8Array }>;
}

/** A file to write out. */
export interface Sword1ExportedFile {
  readonly name: string;
  readonly data: Uint8Array;
}

/** What an export did, so a caller can report it rather than guess. */
export interface Sword1ExportReport {
  readonly files: readonly Sword1ExportedFile[];
  /** Resource ids whose bytes this export changed. */
  readonly rewritten: readonly number[];
  /** Resources copied through untouched, which should be almost all of them. */
  readonly copied: number;
  /**
   * Clusters `swordres.rif` declares that this folder does not hold.
   *
   * Normal rather than a fault: the index names both discs' clusters whichever
   * disc it was read from. Their entries are carried through unchanged and no
   * file is written for them, so an export names them rather than implying a
   * complete install.
   */
  readonly missing: readonly string[];
  /**
   * The speech container, when one was supplied and rebuilt.
   *
   * Named separately from `rewritten` because a line of speech has no resource
   * id: it is addressed by screen and line through an index the RIF knows
   * nothing about, so there is no number to put in that list.
   */
  readonly speech: { readonly file: string; readonly replaced: readonly string[] } | null;
  /**
   * Tunes written out, by the file each was written to.
   *
   * Also not in `rewritten`, and for the same reason as speech: a tune has no
   * resource id either. An effect *does*, so a replaced effect is in
   * `rewritten` with every other resource this export changed.
   */
  readonly music: readonly string[];
  /**
   * Each executable carried out, and what was written into it.
   *
   * An empty `edits` means the file went out as it came in, which is the
   * normal case and the one `npm run reexport:sword` checks byte for byte.
   */
  readonly executables: ReadonlyArray<{
    readonly file: string;
    readonly edits: readonly Sword1ExecutableEdit[];
  }>;
}

/**
 * Re-emits the resources a project changed, keyed by resource id.
 *
 * Built before anything is laid out, because a resource's *length* decides
 * where everything after it goes — so every substitution has to be in hand
 * before the first offset is written.
 */
type Substitution = { payload: Uint8Array | Int32Array } | { whole: Uint8Array };

function editedResources(project: Sword1Project): Map<number, Substitution> {
  const edited = new Map<number, Substitution>();

  // Scripts. A module that did not round-trip is refused rather than written:
  // re-emitting a misreading produces a game that runs until it does not.
  for (const script of project.scripts) {
    if (!script.roundTrips) {
      throw new Sword1ExportError(
        `Script module ${formatResourceId(script.resource)} did not re-emit byte-identically ` +
          `when it was imported, so this project's reading of it is wrong somewhere. Writing it ` +
          `back would put that misreading into the game, which is refused.`,
      );
    }
    const words = reassembleSword1Script(
      script.instructions as readonly Sword1Instruction[],
      script.entries,
    );
    edited.set(script.resource, { payload: words });
  }

  /*
   * Compacts. A section's resource is a count, a one-based offset table and
   * then the records, and every part of that is put back where it was: the
   * payload is as long as it arrived, the table holds the offsets it held, and
   * each record is written at its own.
   *
   * Rebuilding it instead — laying the records out end to end in index order —
   * is what this did, and it is wrong twice over. It renumbered the three
   * demo sections whose tables are out of order, and it wrote each record at
   * the 3,085-word width the *reader* hands the interpreter rather than the
   * width the game packs, which grew COMPACTS.CLU from 200,156 bytes to
   * 1,050,812.
   *
   * A record may not change size (`editSword1CompactWord` refuses), so nothing
   * here has to move anything.
   */
  for (const section of project.sections) {
    if (section.compacts.length === 0) continue;
    const payload = new Uint8Array(section.words * 4);
    const view = new DataView(payload.buffer);
    view.setUint32(0, section.offsets.length, true);
    section.offsets.forEach((offset, index) => {
      // A byte offset from the payload's start, which is what the table holds
      // and what `readCompactSection` shifts back down by two.
      view.setUint32(4 + index * 4, offset * 4, true);
    });
    for (const compact of section.compacts) {
      const at = section.offsets[compact.index];
      if (at === undefined) continue;
      const record = fromBase64(compact.wordsBase64);
      if (at * 4 + record.length > payload.length) {
        throw new Sword1ExportError(
          `Section ${section.section}'s object ${compact.index} is ${record.length} bytes at ` +
            `word ${at}, which runs past the ${section.words} words its section's resource ` +
            `holds. That cannot be written without moving another object, so it is refused.`,
        );
      }
      payload.set(record, at * 4);
    }
    edited.set(section.resource, { payload });
  }

  // Text. `writeSwordTextResource` is the inverse of the reader and keeps a
  // hole as a zero offset, which is what makes an unedited resource identical.
  for (const entry of project.text) {
    edited.set(entry.resource, { payload: writeSwordTextResource(entry.lines) });
  }

  // Palettes. Six-bit triples, written back where they were read — a palette
  // resource is 768 bytes of payload and nothing else.
  // A palette carries no header: the resource *is* its 768 bytes, which is why
  // this one is substituted whole rather than rewritten behind a header.
  for (const palette of project.palettes) {
    edited.set(palette.resource, { whole: fromBase64(palette.bytesBase64) });
  }

  /*
   * Pictures — backgrounds, parallax layers, mask layers and sprites.
   *
   * Which of the two substitution shapes a picture takes is a **measured**
   * property of its format rather than a choice:
   *
   * - A background carries no resource header at all. The resource *is* its
   *   pixels — 256,000 of them for a 640x400 screen, 313,600 for 784x400 —
   *   so it goes in whole, the way a palette does.
   * - A parallax layer's first twenty bytes *are* its own header: `char[16]`
   *   of "PARALLAX LAYER", then `sizeX` and `sizeY`. That overlaps the generic
   *   `Header` exactly and means none of its fields hold what `rewriteResource`
   *   would rewrite, so it goes in whole too.
   * - A sprite and a mask layer are headed, and a re-encoded sprite frame can
   *   change size. Those go in as a payload behind the resource's own header,
   *   so `comp_length` and `decomp_length` come out describing the new bytes.
   *   Substituting a sprite whole would have left both stale, which is a bound
   *   check the game fails rather than a difference nobody sees.
   *
   * Every picture is substituted, edited or not, exactly as every script and
   * every text module is: `bytesBase64` holds the resource as the cluster held
   * it, so an untouched one re-emits identically and the export stays a diff of
   * the author's changes.
   */
  for (const picture of project.pictures) {
    const bytes = fromBase64(picture.bytesBase64);
    if (bytes.length === 0) continue;
    if (picture.kind === 'background' || picture.kind === 'parallax') {
      edited.set(picture.resource, { whole: bytes });
    } else {
      edited.set(picture.resource, { payload: bytes.subarray(SWORD1_HEADER_SIZE) });
    }
  }

  /*
   * Walk grids, written back from the segments the project holds.
   *
   * `writeSword1WalkGrid` re-derives the seven fields a bar stores and does not
   * hold — its bounding box, its deltas and its line constant — so an author
   * who moved one endpoint has not left ten other numbers describing where the
   * endpoint used to be. Measured before it was relied on: every one of the
   * demo's nine grids re-emits byte-identically from its segments, which is
   * what `npm run sweep:sword` counts.
   *
   * Substituted as a payload rather than whole, so `rewriteResource` sets the
   * two length fields from the resource's *own* header when a deleted bar makes
   * the grid shorter.
   */
  for (const grid of project.walkGrids ?? []) {
    const header = fromBase64(grid.headerBase64);
    if (header.length < SWORD1_HEADER_SIZE) continue;
    const bytes = writeSword1WalkGrid(grid, header);
    edited.set(grid.resource, { payload: bytes.subarray(SWORD1_HEADER_SIZE) });
  }

  return edited;
}

/**
 * Puts a new payload behind a resource's **own** header.
 *
 * Not a header this exporter invents, and that distinction is the reason an
 * unedited export is byte-identical. `Header` is six bytes of type tag, a
 * version word, `comp_length`, a four-character compression tag and
 * `decomp_length` (`sworddefs.h`) — and the two lengths do not count the same
 * thing across resource types, which is the whole difficulty here.
 *
 * Measured against the shipped clusters rather than reasoned about, because
 * reasoning about it got it wrong. `comp_length` is the **whole resource**,
 * header included: every one of the demo's 1,384 headed resources has it equal
 * to the length `swordres.rif` records. `decomp_length` is the **payload** for
 * a script module and a text module, and the whole resource again for a
 * compact section — so a rule that only knew about payload counts refused the
 * first text resource of the first cluster it reached, and the export path had
 * never been run against a game.
 *
 * So the original header is copied verbatim and each length field is adjusted
 * to whichever quantity it already held: the total, the payload, or the
 * payload in words. A field matching none of the three is **refused** rather
 * than written with a guess in it, because a wrong `decomp_length` is a bound
 * check that rejects a script the game needs.
 */
function rewriteResource(
  original: Uint8Array,
  payload: Uint8Array | Int32Array,
  id: number,
): Uint8Array {
  const bytes =
    payload instanceof Int32Array
      ? new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
      : payload;

  if (original.length < SWORD1_HEADER_SIZE) {
    throw new Sword1ExportError(
      `${formatResourceId(id)} is ${original.length} bytes in the game it was imported from, ` +
        `which is shorter than a resource header. It cannot be rewritten against.`,
    );
  }

  const oldPayload = original.length - SWORD1_HEADER_SIZE;
  const out = new Uint8Array(SWORD1_HEADER_SIZE + bytes.length);
  out.set(original.subarray(0, SWORD1_HEADER_SIZE), 0);
  out.set(bytes, SWORD1_HEADER_SIZE);

  // Unchanged size: the header is right as it stands, whatever its lengths
  // mean. This is the common case and the one byte-identity depends on.
  if (bytes.length === oldPayload) return out;

  const view = new DataView(out.buffer);
  const oldView = new DataView(original.buffer, original.byteOffset, original.byteLength);
  for (const at of [8, 16]) {
    const was = oldView.getUint32(at, true);
    // The total first: `comp_length` is the resource including its header, and
    // a payload check would only match it on a resource whose payload happened
    // to be twenty bytes shorter than itself, which is none of them.
    if (was === original.length) {
      view.setUint32(at, out.length, true);
    } else if (was === oldPayload) {
      view.setUint32(at, bytes.length, true);
    } else if (was === oldPayload >> 2) {
      view.setUint32(at, bytes.length >> 2, true);
    } else {
      throw new Sword1ExportError(
        `${formatResourceId(id)} changed size, and its header's length field at ${at} was ` +
          `${was} where the resource was ${original.length} bytes and its payload ${oldPayload} ` +
          `(${oldPayload >> 2} words). This exporter does not know what that field counts, so ` +
          `it refuses to guess rather than write a bound the game will reject.`,
      );
    }
  }
  return out;
}

/**
 * Writes an edited game back out.
 *
 * The palette resources are the one case where the payload *is* the resource —
 * they carry no header — so they are substituted whole. Everything else gets a
 * fresh header sized to its new payload.
 */
export function exportSword1Game(
  source: Sword1ExportSource,
  project: Sword1Project,
): Sword1ExportReport {
  let index: RifIndex;
  try {
    index = parseRif(source.index);
  } catch (error) {
    throw new Sword1ExportError(
      `The index this project was imported from will not parse, so there is nothing to rebuild ` +
        `against: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const edited = editedResources(project);

  /*
   * And the effects, which are resources and so need no path of their own.
   *
   * An fx sample is a `RIFF` where it lies — no Sword 1 header in front of it,
   * exactly as a palette has none — so it is substituted whole, and the cluster
   * loop below lays its cluster out again around whatever length it now has.
   * It reaches `rewritten` the way every other changed resource does, and an
   * effect in a cluster this folder lacks hits the same refusal an edited
   * picture in one hits.
   */
  for (const effect of source.effects ?? []) edited.set(effect.id, { whole: effect.data });

  const byLabel = new Map(source.clusters.map((cluster) => [cluster.label.toUpperCase(), cluster]));
  const files: Sword1ExportedFile[] = [];
  const rewritten: number[] = [];
  let copied = 0;

  // The new index, written in the old one's exact shape: same clusters, same
  // groups, same presence tables, same holes. Only offsets and lengths move.
  const header: number[] = [];
  const push32 = (value: number): void => {
    header.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
  };

  /*
   * A cluster the index declares and the folder does not hold is carried
   * through as it stands: its entry keeps the offsets and lengths it arrived
   * with, and no file is written for it.
   *
   * Refusing was what this did, and refusing rejects every install there is.
   * `swordres.rif` declares all fourteen clusters of a two-disc game whichever
   * disc it is read from, and the demo ships six of them — so "open the game
   * folder again with every cluster present" was advice nobody could take, and
   * the export path had never run against a real game at all.
   *
   * Carrying the entry through unchanged is what keeps the exported game the
   * same game. Nothing in an absent cluster moves, because nothing in it is
   * laid out again, so every offset in its entry still points where it pointed
   * — supply the other disc beside the export and it reads exactly as before.
   */
  const missing = index.clusters
    .filter((cluster) => !byLabel.has(cluster.label.toUpperCase()))
    .map((cluster) => cluster.label);

  /*
   * The three presence tables are written back word for word.
   *
   * They are read as booleans and they are not written as booleans. The demo's
   * fourteen cluster words are 7939444, 7965808, 8003388 … — something the
   * build tool knew and no reader here does — and rebuilding them as ones and
   * zeroes produced an index every reader accepts and no diff calls identical.
   * Since nothing in the RIF's own layout moves when a resource changes size,
   * the words that were there are still right.
   */
  push32(index.presence.length);
  for (const word of index.presence) push32(word);

  for (const cluster of index.clusters) {
    const original = byLabel.get(cluster.label.toUpperCase());
    const located = new Map<number, { offset: number; length: number }>();

    if (original) {
      // Lay the cluster out in the index's own order, which is the order the
      // resources were read in — so an unedited cluster comes out identical.
      const parts: Uint8Array[] = [];
      let at = 0;
      for (const group of cluster.groups) {
        for (const resource of group.resources) {
          const id = resourceId(cluster.cluster, group.group, resource.index);
          const substitution = edited.get(id);
          const asRead = original.data.subarray(resource.offset, resource.offset + resource.length);
          let bytes = asRead;
          if (substitution) {
            bytes =
              'whole' in substitution
                ? substitution.whole
                : rewriteResource(asRead, substitution.payload, id);
            rewritten.push(id);
          } else {
            copied++;
          }
          parts.push(bytes);
          located.set(id, { offset: at, length: bytes.length });
          at += bytes.length;
        }
      }

      const data = new Uint8Array(at);
      let write = 0;
      for (const part of parts) {
        data.set(part, write);
        write += part.length;
      }
      files.push({ name: original.name, data });
    } else {
      // No file to lay out, so nothing in this cluster moves and its entry is
      // re-emitted exactly as it was read. An *edit* to a resource in it is a
      // different matter: the new bytes would have nowhere to go, and an index
      // that pointed at the old ones would be a silent loss rather than a
      // refusal.
      for (const group of cluster.groups) {
        for (const resource of group.resources) {
          const id = resourceId(cluster.cluster, group.group, resource.index);
          if (edited.has(id)) {
            throw new Sword1ExportError(
              `${formatResourceId(id)} was edited and it lives in ${cluster.label}, which this ` +
                `folder does not hold — on a two-disc game that is the other disc. The edit ` +
                `would have nowhere to be written, so the export is refused rather than made ` +
                `without it.`,
            );
          }
          located.set(id, { offset: resource.offset, length: resource.length });
        }
      }
    }

    // The cluster's entry in the new index.
    const label = cluster.label;
    for (let byte = 0; byte < 32; byte++) {
      header.push(byte < label.length ? label.charCodeAt(byte) : 0);
    }
    push32(cluster.presence.length);
    for (const word of cluster.presence) push32(word);

    for (const group of cluster.groups) {
      push32(group.declared);
      for (const word of group.presence) push32(word);
      for (const resource of group.resources) {
        const id = resourceId(cluster.cluster, group.group, resource.index);
        const placed = located.get(id);
        // Unreachable: every present resource was just laid out. An explicit
        // throw rather than a zero, because a zero offset here is a resource
        // the game reads as the cluster's first bytes.
        if (!placed) {
          throw new Sword1ExportError(
            `${formatResourceId(id)} is in the index and was not laid out, which is a bug in ` +
              `this exporter rather than in the project.`,
          );
        }
        push32(placed.offset);
        push32(placed.length);
      }
    }
  }

  files.push({ name: source.indexFile, data: Uint8Array.from(header) });

  /*
   * And the speech, which is the one thing here that is not a resource.
   *
   * Last, and outside the cluster loop, because nothing about it depends on
   * the index: the container carries its own, and a line that changes length
   * moves the recordings after it within that file and nothing else in the
   * game. `rebuildSword1Speech` is a copy when there is nothing to replace, so
   * supplying the container costs bytes and never correctness.
   */
  let speech: Sword1ExportReport['speech'] = null;
  if (source.speech) {
    const rebuilt = rebuildSword1Speech(
      source.speech.name,
      source.speech.data,
      source.speech.replacements ?? [],
      { bigEndian: source.speech.bigEndian ?? false },
    );
    files.push({ name: source.speech.name, data: rebuilt.data });
    speech = { file: source.speech.name, replaced: rebuilt.replaced };
  }

  /*
   * And the tunes, which are files and not resources either.
   *
   * Written as they arrived. A tune is found by name and read by `parseWave`
   * at the moment it plays, so there is nothing here to rebuild — the only
   * question is whether the bytes will play, and that one is asked where the
   * replacement is picked up rather than here, by the game's own reader.
   */
  const music = (source.music ?? []).map((tune) => tune.file);
  for (const tune of source.music ?? []) files.push({ name: tune.file, data: tune.data });

  /*
   * And the executables, which are where the room table and the start
   * positions live.
   *
   * Read again here rather than carried in already-parsed, so that what an
   * edit is compared against is the bytes about to be written and not a decode
   * made somewhere else. An executable holding neither table is copied through
   * without a byte touched — `RUNSWORD.EXE` is one — because a file the export
   * was handed is a file the export is responsible for putting back.
   */
  const executables: Array<{ file: string; edits: readonly Sword1ExecutableEdit[] }> = [];
  for (const file of source.executables ?? []) {
    const executable = readSword1Executable(file.name, file.data);
    const patched = patchSword1Executable(executable, {
      ...(sameExecutable(file.name, project.interpreter?.rooms)
        ? { rooms: project.rooms.map((room) => ({ screen: room.screen, room: roomDefOf(room) })) }
        : {}),
      ...(sameExecutable(file.name, project.interpreter?.startPositions)
        ? { startPositions: project.startPositions ?? [] }
        : {}),
    });
    files.push({ name: file.name, data: patched.data });
    executables.push({ file: file.name, edits: patched.edits });
  }

  return { files, rewritten, copied, missing, speech, music, executables };
}

/**
 * Whether two executable names are the same file, path and case aside.
 *
 * By basename because the name a project recorded came from whatever listed
 * the folder — `SWORD.EXE` from one, `sword1/SWORD.EXE` from another — and an
 * edit that failed to land because of a leading directory would be a silent
 * one.
 */
function sameExecutable(name: string, recorded: string | null | undefined): boolean {
  if (!recorded) return false;
  const stem = (value: string): string => (value.split(/[/\\]/).pop() ?? value).toUpperCase();
  return stem(name) === stem(recorded);
}

/** A project's room as the executable's table wants it, field for field. */
function roomDefOf(room: Sword1Project['rooms'][number]): Sword1RoomDef {
  return {
    totalLayers: room.totalLayers,
    sizeX: room.width,
    sizeY: room.height,
    gridWidth: room.gridWidth,
    layers: [...room.layers],
    grids: [...room.grids],
    palettes: [...room.palettes],
    parallax: [...room.parallax],
  };
}

/**
 * Which resource ids an export would rewrite, without doing the work.
 *
 * For an editor that wants to say "this will change 4 of 1,207 resources"
 * before a person commits to a download.
 */
export function sword1ExportSummary(project: Sword1Project): {
  scripts: number;
  sections: number;
  text: number;
  palettes: number;
  pictures: number;
} {
  return {
    scripts: project.scripts.length,
    sections: project.sections.length,
    text: project.text.length,
    palettes: project.palettes.length,
    pictures: project.pictures.length,
  };
}

/** The parts of an id, for an export log. */
export function describeSword1Resource(id: number): string {
  return `${formatResourceId(id)} (cluster ${clusterOf(id)}, group ${groupOf(id)}, index ${indexOf(id)})`;
}
