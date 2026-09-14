/**
 * Packing a SCI Project back into an install: the map and the Volume.
 *
 * `exportSciGame` answers "what are this game's resources now" and stops there,
 * returning a `Map<'type:number', Uint8Array>`. That is the right seam — an
 * author's edit passes through the writer and not through the container — but a
 * map of resources is not a game, and until this file existed nothing in the
 * project turned one into files. `bin/sci-reexport.ts` said so plainly:
 * "`RESOURCE.MAP` and the Volumes are built by whoever is writing the game
 * out", and nobody was.
 *
 * This is the inverse of `resourceMap.ts` and of `readSciResourceHeader`, and
 * it is written as their inverse deliberately: `headerShapeFor` is imported
 * from the reader rather than copied, so the two cannot drift about which map
 * era carries SCI0's `+ 4` in its packed size.
 *
 * ## What it will not do
 *
 * **It refuses by name rather than approximating.** Every field below is
 * narrower than the thing it holds — a SCI0 map entry has eleven bits for a
 * resource number, a directory map addresses its own entry blocks with a 16-bit
 * offset, a SCI1.1 volume offset is 24 bits doubled — and a value that does not
 * fit has no wrong answer that fails loudly. Writing `number & 0x7ff` produces
 * an install that loads and serves the wrong resource, which is the silent
 * failure `SciResources` refuses compressed-bytes-as-a-resource for. So each
 * limit is checked and the whole pack is refused with the resource named.
 *
 * **It writes one resource Volume.** Sierra split at DOS-era limits and this
 * does not, because the two directory maps have nowhere to put a volume number
 * at all — `readSci1Map` reads a volume nibble for SCI1 late and zero for
 * everything else — so for SCI1.1 and SCI32 one Volume is not a simplification
 * but the format. For the flat maps it *is* a simplification, and its cost is a
 * ceiling: 64MB of resources at SCI0 and SCI1 late, 256MB at SCI1 middle, past
 * which this refuses rather than writing an offset the map cannot address.
 *
 * **It writes every resource uncompressed** (method 0). Sierra's own Volumes
 * use LZW and DCL and `sciCompression.ts` reads both; nothing here writes
 * either, and an uncompressed resource is legal for every reader — ScummVM's
 * included — because the method number is in the header beside it. The cost is
 * file size, and it is real: a game whose Volume was 12MB packed comes back
 * nearer 20MB. What it buys is that the bytes in the Volume are the bytes the
 * Project holds, so a difference in a round trip is a difference in the writer
 * rather than in a compressor.
 *
 * **Carried Volumes are copied, not rebuilt.** `exportSciGame`'s
 * `carriedVolumes` names them and #227 is the reason: a game's audio and video
 * are played rather than held (`CONTEXT.md`), so there is nothing in a Project
 * that could rebuild them. They arrive here as bytes already read from the
 * folder the author re-supplied (ADR 0010) and go out byte for byte.
 */

import { headerShapeFor, type HeaderShape } from '../../engine/sci/resource/SciResources.js';
import {
  detectMapVersion,
  isDirectoryMap,
  type SciMapVersion,
} from '../../engine/sci/resource/resourceMap.js';
import type { SciLayout } from '../../engine/sci/resource/sciDetect.js';
import {
  SCI_RESOURCE_TYPES,
  type SciResourceType,
} from '../../engine/sci/resource/sciResourceTypes.js';

/** One file of a packed install. */
export interface SciPackedFile {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface SciPackOptions {
  /**
   * Which map structure to write.
   *
   * Not a Version, and the difference is the whole of ADR 0020: a map's
   * structure is read from the map's own bytes — `detectMapVersion` returns
   * null rather than guessing — while a Version is probed out of the game's
   * resources and may end as a bucket. So this is the one thing about the
   * container that is never a guess, and asking for it rather than deriving it
   * from `target.version` is what keeps the packer out of ADR 0013's argument.
   *
   * The inverse is not available anyway: five Versions share
   * `sci0-sci1-early`, and `sci2`, `sci2-1-*` and `sci3` all ship the same
   * SCI32 container.
   */
  readonly mapVersion: SciMapVersion;
  /**
   * The install this game was read from, so a packed one keeps its file names.
   *
   * Names are not free-form: `sciLayout` claims `RESOURCE.MAP` beside
   * `RESOURCE.00n` and `RESMAP.00n` beside `RESSCI.00n`, and Space Quest 6 is
   * a SCI32 container under the first pair — so the names say which files to
   * open and nothing about the Version. Keeping the original's means a packed
   * install looks like the game it came from; without one, the map version
   * picks the pair every release of that era ships.
   */
  readonly layout?: SciLayout;
  /** Volumes carried through byte for byte, already read from the folder. */
  readonly carried?: readonly SciPackedFile[];
}

export interface SciPackResult {
  /** The install, or nothing at all when anything was refused. */
  readonly files: readonly SciPackedFile[];
  readonly mapFile: string;
  readonly volumeFile: string;
  /** Resources this writer will not produce, each named and reasoned. */
  readonly refused: readonly string[];
  /** Names copied through rather than rebuilt. */
  readonly carried: readonly string[];
  /** How many resources went into the Volume. */
  readonly resourceCount: number;
  /** How large the Volume is, which is the number compression would change. */
  readonly volumeBytes: number;
}

/**
 * The volume number a packed install writes into its map entries.
 *
 * Zero for the directory maps, where the field either holds a nibble nobody
 * needs (SCI1 late) or does not exist (SCI1.1, SCI32).
 *
 * **One for the flat maps, and that is not arbitrary.** `detectMapVersion`
 * separates `sci0-sci1-early` from `sci1-middle` by reading the volume out of
 * the top *six* bits and asking whether that volume is present: the two
 * readings are both well-formed and only the missing file says which is right.
 * Writing volume 0 makes the two readings identical, so a SCI1 middle install
 * packed here would read back as a SCI0 one — harmlessly, since every offset
 * still resolves, but a round trip that quietly renames the container is a
 * round trip that has stopped measuring it. Volume 1 keeps the evidence:
 * written into the top four bits it reads as volume 4 through SCI0's rule, and
 * volume 4 is not there.
 */
function volumeNumberFor(mapVersion: SciMapVersion): number {
  return isDirectoryMap(mapVersion) ? 0 : 1;
}

function baseName(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? name;
}

/**
 * What to call the two files.
 *
 * The Volume's name is derived from the map's rather than chosen beside it,
 * because `SciResources.load` resolves a volume through the map's own number
 * when the map is one of the `RESMAP.0nn` set — an entry's volume is a number
 * *within that disc*. Deriving keeps the pair consistent for both schemes and
 * for the one release that mixes them.
 */
function namesFor(
  mapVersion: SciMapVersion,
  layout: SciLayout | undefined,
): { mapFile: string; volumeFile: string } {
  const fallback = isDirectoryMap(mapVersion) && headerShapeFor(mapVersion) === 'sci32';
  const mapFile = layout ? baseName(layout.mapFile) : fallback ? 'RESMAP.000' : 'RESOURCE.MAP';

  const numbered = /^resmap\.(\d{3})$/i.exec(mapFile);
  if (numbered) return { mapFile, volumeFile: `RESSCI.${numbered[1]}` };

  const number = volumeNumberFor(mapVersion).toString().padStart(3, '0');
  return { mapFile, volumeFile: `RESOURCE.${number}` };
}

/** A resource on its way into a Volume, with its key kept for the refusals. */
interface Packable {
  readonly key: string;
  readonly type: SciResourceType;
  readonly number: number;
  readonly body: Uint8Array;
  offset: number;
}

function u16(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff);
}

function u32(out: number[], value: number): void {
  out.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
}

/**
 * Sorts the resources and rejects a key that is not one.
 *
 * By type in `SCI_RESOURCE_TYPES` order and then by number, which a flat map
 * does not care about and a directory map does: entry blocks are sized by the
 * gap to the next directory offset, so they have to be contiguous and in the
 * directory's own order.
 */
function packableFrom(resources: ReadonlyMap<string, Uint8Array>, refused: string[]): Packable[] {
  const packable: Packable[] = [];

  for (const [key, body] of resources) {
    const split = key.lastIndexOf(':');
    const type = key.slice(0, split) as SciResourceType;
    const number = Number(key.slice(split + 1));

    if (!SCI_RESOURCE_TYPES.includes(type) || !Number.isInteger(number) || number < 0) {
      refused.push(`${key}: not a resource type and number this packer recognises`);
      continue;
    }
    packable.push({ key, type, number, body, offset: 0 });
  }

  return packable.sort(
    (a, b) =>
      SCI_RESOURCE_TYPES.indexOf(a.type) - SCI_RESOURCE_TYPES.indexOf(b.type) ||
      a.number - b.number,
  );
}

/**
 * Writes the Volume and records where each resource landed.
 *
 * The header shapes are `readSciResourceHeader`'s four, inverted. The `+ 4` on
 * `packed` for the SCI0 and SCI1-late shapes is the reader's `- 4` and is the
 * single easiest thing here to get wrong: the field counts the four bytes of
 * header that follow the id as well as the body.
 *
 * **The bodies are kept as chunks rather than appended byte by byte**, and at
 * this family's sizes that is not a micro-optimisation. A `number[]` holds each
 * byte in eight, so growing one to hold a Volume costs an order of magnitude
 * more than the Volume. Measured on a 48MB resource set: the array cost
 * 1,437MB of RSS and 1,578ms, the chunks 48MB and 32ms. This runs in a browser
 * tab, beside the folder it was read from and the Project it came out of, and a
 * SCI install is the one place in this repository where tens of megabytes is
 * the ordinary case rather than the pathological one — 1.4GB there is not a
 * slow export but a failed one. Only the headers are built as numbers; a body
 * goes in by reference and is copied once, into the final buffer.
 *
 * The two map writers still build a `number[]` and are left alone: a map entry
 * is five to seven bytes, so the largest map this packer will write at all —
 * the 16-bit ceiling `writeDirectoryMap` refuses past — is 64KB.
 */
function writeVolume(packable: Packable[], shape: HeaderShape, refused: string[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let at = 0;

  const emit = (bytes: Uint8Array): void => {
    chunks.push(bytes);
    at += bytes.length;
  };

  for (const resource of packable) {
    const length = resource.body.length;
    const header: number[] = [];

    // SCI1.1 halves its offsets, so every resource starts on a word boundary.
    // The pad goes before the header rather than after the previous body, so
    // the offset recorded is the one the header is at.
    if (shape === 'sci11' && at % 2 === 1) emit(new Uint8Array(1));
    resource.offset = at;

    if (shape === 'sci0') {
      if (resource.number > 0x7ff) {
        refused.push(
          `${resource.key}: a SCI0 volume header packs the number into eleven bits, and ` +
            `${resource.number} does not fit`,
        );
        continue;
      }
      if (length + 4 > 0xffff) {
        refused.push(
          `${resource.key}: ${length} bytes, and a SCI0 volume header has a 16-bit packed ` +
            `size that counts four bytes of header with it`,
        );
        continue;
      }
      u16(header, (SCI_RESOURCE_TYPES.indexOf(resource.type) << 11) | resource.number);
      u16(header, length + 4);
      u16(header, length);
      u16(header, 0);
    } else if (shape === 'sci1-late' || shape === 'sci11') {
      if (resource.number > 0xffff) {
        refused.push(`${resource.key}: a volume header's number field is 16 bits`);
        continue;
      }
      const packed = shape === 'sci1-late' ? length + 4 : length;
      if (packed > 0xffff) {
        refused.push(
          `${resource.key}: ${length} bytes, and a ${shape} volume header has 16-bit sizes`,
        );
        continue;
      }
      header.push(SCI_RESOURCE_TYPES.indexOf(resource.type));
      u16(header, resource.number);
      u16(header, packed);
      u16(header, length);
      u16(header, 0);
    } else {
      if (resource.number > 0xffff) {
        refused.push(`${resource.key}: a volume header's number field is 16 bits`);
        continue;
      }
      header.push(SCI_RESOURCE_TYPES.indexOf(resource.type));
      u16(header, resource.number);
      // Equal packed and unpacked sizes, which for SCI3 is how the reader is
      // told this resource is not compressed at all: SCI3 "writes the field and
      // does not mean it", so the method number below is not what it reads.
      u32(header, length);
      u32(header, length);
      u16(header, 0);
    }

    emit(new Uint8Array(header));
    emit(resource.body);
  }

  const volume = new Uint8Array(at);
  let cursor = 0;
  for (const chunk of chunks) {
    volume.set(chunk, cursor);
    cursor += chunk.length;
  }
  return volume;
}

/** The flat six-byte map: SCI0, SCI01 and early SCI1, plus FM-Towns' seven. */
function writeFlatMap(
  packable: Packable[],
  mapVersion: SciMapVersion,
  volume: number,
  refused: string[],
): Uint8Array {
  const wide = mapVersion === 'sci1-middle';
  const shift = wide ? 28 : 26;
  const limit = wide ? 0x0fffffff : 0x03ffffff;
  const volumeLimit = wide ? 0x0f : 0x3f;
  const towns = mapVersion === 'kq5-fm-towns';

  const out: number[] = [];
  for (const resource of packable) {
    if (resource.offset > limit) {
      refused.push(
        `${resource.key}: at offset ${resource.offset}, past the ${limit + 1} bytes a ` +
          `${mapVersion} map entry can address in one volume — this packer writes a single ` +
          `resource Volume and will not wrap an offset`,
      );
      continue;
    }
    if (volume > volumeLimit) {
      refused.push(`${resource.key}: volume ${volume} does not fit this map's volume field`);
      continue;
    }
    if (!towns && resource.number > 0x7ff) {
      refused.push(
        `${resource.key}: a flat map entry packs the number into eleven bits, and ` +
          `${resource.number} does not fit`,
      );
      continue;
    }

    if (towns) {
      out.push(SCI_RESOURCE_TYPES.indexOf(resource.type));
      u16(out, resource.number);
    } else {
      u16(out, (SCI_RESOURCE_TYPES.indexOf(resource.type) << 11) | resource.number);
    }
    u32(out, ((volume << shift) >>> 0) | resource.offset);
  }

  // The terminator is read off the offset word, which is why it is six bytes
  // here and seven for FM-Towns: the entry is a byte wider and
  // `detectMapVersion` tells the two apart by counting the 0xff bytes at the
  // end. Six after a seven-byte entry would be read as a SCI0 map.
  for (let i = 0; i < (towns ? 7 : 6); i++) out.push(0xff);
  return new Uint8Array(out);
}

/** The two-tier map: a type directory, then a block of entries per type. */
function writeDirectoryMap(
  packable: Packable[],
  mapVersion: SciMapVersion,
  volume: number,
  refused: string[],
): Uint8Array {
  const shape = headerShapeFor(mapVersion);
  const width = mapVersion === 'sci11' ? 5 : 6;
  // SCI1 late and SCI1.1 OR 0x80 into every directory type; SCI32 does not, and
  // that bit is the *whole* of what `detectMapVersion` separates the two on.
  const highBit = shape !== 'sci32';

  const types: SciResourceType[] = [];
  for (const resource of packable) {
    if (!types.includes(resource.type)) types.push(resource.type);
  }

  const directoryBytes = (types.length + 1) * 3;
  const entries: number[] = [];
  const directory: number[] = [];
  let at = directoryBytes;

  for (const type of types) {
    directory.push(SCI_RESOURCE_TYPES.indexOf(type) | (highBit ? 0x80 : 0));
    u16(directory, at);

    for (const resource of packable.filter((each) => each.type === type)) {
      if (resource.number > 0xffff) {
        refused.push(`${resource.key}: a directory map entry's number field is 16 bits`);
        continue;
      }
      u16(entries, resource.number);

      if (mapVersion === 'sci11') {
        // A 24-bit offset that the reader doubles. `writeVolume` pads every
        // resource onto an even offset, so the halving is exact; the check is
        // here anyway, because an odd offset would be halved into the middle of
        // the previous resource rather than rejected.
        if (resource.offset % 2 !== 0 || resource.offset / 2 > 0xffffff) {
          refused.push(
            `${resource.key}: at offset ${resource.offset}, which a SCI1.1 map cannot ` +
              `address — its entry holds a 24-bit offset that is doubled on the way in`,
          );
          continue;
        }
        const halved = resource.offset / 2;
        entries.push(halved & 0xff, (halved >> 8) & 0xff, (halved >> 16) & 0xff);
      } else if (shape === 'sci32') {
        u32(entries, resource.offset);
      } else {
        if (resource.offset > 0x0fffffff) {
          refused.push(
            `${resource.key}: at offset ${resource.offset}, past the 256MB a SCI1 late map ` +
              `entry can address — the top nibble of that word is the volume number`,
          );
          continue;
        }
        u32(entries, ((volume << 28) >>> 0) | resource.offset);
      }
      at += width;
    }
  }

  // The terminator points at the end of the file, which is what gives the last
  // type its entry count. A map that ends anywhere else has a last type of
  // nonsense length.
  directory.push(0xff);
  u16(directory, at);

  if (at > 0xffff) {
    refused.push(
      `the resource map is ${at} bytes, and a directory map addresses its own entry blocks ` +
        `with 16-bit offsets — this game has too many resources for one map`,
    );
  }

  return new Uint8Array([...directory, ...entries]);
}

/**
 * Turns a Project's resources into the files of an install.
 *
 * Called with `exportSciGame`'s `resources` and the map structure the game was
 * read from. Returns no files at all when anything was refused: half a packed
 * game is an install that loads and then cannot find something, which is worse
 * than one that did not pack — the rule `save.ts` already applies to a SCUMM
 * game whose dialogue would not write back.
 */
export function packSciGame(
  resources: ReadonlyMap<string, Uint8Array>,
  options: SciPackOptions,
): SciPackResult {
  const { mapVersion } = options;
  const refused: string[] = [];
  const packable = packableFrom(resources, refused);
  const { mapFile, volumeFile } = namesFor(mapVersion, options.layout);
  const volumeNumber = volumeNumberFor(mapVersion);

  const volume = writeVolume(packable, headerShapeFor(mapVersion), refused);
  const map = isDirectoryMap(mapVersion)
    ? writeDirectoryMap(packable, mapVersion, volumeNumber, refused)
    : writeFlatMap(packable, mapVersion, volumeNumber, refused);

  // Does the map we just wrote read back as the map we were asked for?
  //
  // `detectMapVersion` has no field to read the entry width out of; it infers
  // it from the gaps between directory offsets, and a gap divisible by thirty
  // is divisible by both five and six. So a SCI1-late map whose every type
  // block holds a multiple of five entries is indistinguishable from a SCI1.1
  // one, and the reader resolves the tie towards SCI1.1 — at which point every
  // entry is read at the wrong width and the resources are not merely moved but
  // lost.
  //
  // The bytes are not wrong; an interpreter built for one version is told its
  // width rather than inferring it. But everything in this project that opens
  // an install goes through the reader above — `playSci` packs and reads
  // straight back — so an install this reader cannot parse is one this editor
  // cannot play, and that is a refusal by name rather than a zip that fails
  // later. Only the volume this pack writes is offered as existing, because
  // that is the install the author will have.
  //
  // A game with no resources at all is exempt, and not as a special case to get
  // a test passing: an empty directory map is three bytes of terminator, which
  // `detectMapVersion` answers null for because it genuinely carries no
  // evidence of its own width. There are no entries to read at the wrong width
  // and no resources to lose, so there is nothing here to refuse.
  const written = detectMapVersion(map, (volume) => volume === volumeNumber);
  if (packable.length > 0 && refused.length === 0 && written !== mapVersion) {
    // The width ambiguity is the one cause known to reach here, so it is named
    // when it fits and not asserted when it does not: a mismatch this check has
    // not seen before should report what it saw rather than a stale reason.
    const widths = written !== null && isDirectoryMap(mapVersion) && isDirectoryMap(written);
    refused.push(
      `a ${mapVersion} map of these resources reads back as ` +
        `${written ?? 'no structure this project recognises'}, so the packed install would ` +
        `serve the wrong bytes` +
        (widths
          ? ': every one of its entry blocks is a multiple of five, which leaves the entry ' +
            'width ambiguous'
          : ''),
    );
  }

  const carried = options.carried ?? [];
  const files =
    refused.length > 0
      ? []
      : [{ name: mapFile, data: map }, { name: volumeFile, data: volume }, ...carried];

  return {
    files,
    mapFile,
    volumeFile,
    refused,
    carried: carried.map((file) => file.name),
    resourceCount: packable.length,
    volumeBytes: volume.length,
  };
}
