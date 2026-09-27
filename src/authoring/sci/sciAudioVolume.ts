/**
 * Writing a replaced SCI recording into the install, rather than only into the
 * project (#227, row 27).
 *
 * Until this file an export carried `RESOURCE.AUD` and `RESOURCE.SFX` through
 * byte for byte, so a replaced track changed what played in this editor and
 * nothing an author could take away. The reason given was that nothing in a
 * Project could rebuild an audio Volume — true of the Volume's *contents*, and
 * not of its *shape*: an audio Volume is samples end to end, each carrying its
 * own length, addressed by offsets in a `map` resource the Project already
 * holds. Rebuilding one needs the original Volume (which the re-supplied folder
 * hands over, ADR 0034), the map (which is a resource), and the one recording
 * that changed. Nothing else in it has to be understood, only copied.
 *
 * ## Two places a recording is, two writes
 *
 * - **An `audio` resource in the resource map** is a resource like any View:
 *   its body is substituted in the export's resource map and `packSciGame`
 *   lays the resource Volume out around it, the same as for an edited Script.
 * - **An entry in the base audio map (65535)** addresses a bulk audio Volume.
 *   Which one follows ScummVM's `addAudioSources`, because that is the rule an
 *   interpreter applies: map 65535 reads `RESOURCE.SFX` when the install has
 *   one and `RESOURCE.AUD` otherwise. The row's own `file` is the listing's
 *   label and is not what the interpreter reads, so it is not consulted.
 *
 * ## Two ways to rebuild the Volume, chosen by who else points into it
 *
 * **A Volume only map 65535 addresses is rebuilt whole.** Every distinct
 * offset the map names is copied, header and body, byte for byte and in map
 * order, with the replaced sample substituted — and the map is rewritten with
 * the offsets those samples landed at. Bytes no entry addresses do not
 * survive, which is correct rather than lossy: no reader can reach them.
 *
 * **Before SCI32, a Volume that per-room speech maps also address is appended
 * to.** Those maps (audio36, #222) are keyed by Message tuple, come in widths
 * this project only partly reads (`detectAudio36Stride`), and point into the same
 * `RESOURCE.AUD`. Compacting the Volume would move every recording they name,
 * and rewriting a table whose layout is inferred is the wrong answer written
 * confidently. So the replacement is written after the last byte, only its own
 * entry is repointed, and every other offset in every table stays true because
 * nothing it addresses moved. The old sample becomes bytes nobody reads. A
 * sample's length is in its own header (ScummVM's `loadFromAudioVolumeSCI11`
 * reads it from there), so no reader infers a size from the gap to the next
 * entry and the dead bytes are harmless.
 *
 * Either base map form is read and written (`readBaseTable`): six bytes an
 * entry, or five with a cumulative 24-bit step, told apart as ScummVM does. A
 * cumulative map is written in offset order, so an appended entry moves to its
 * end, and is refused by name if the step to it does not fit.
 *
 * ## SCI32: every map is read, so the Volume is compacted and all of them rewritten
 *
 * From SCI2 on ScummVM does not infer a map's width — it fixes the entry size
 * at 11, the "late" form — so the per-room maps that SCI1.1 has to leave alone
 * can be read exactly: a 32-bit base, then per entry the tuple, a 24-bit step
 * and a sync size when the tuple's flag byte says so (seven bytes or nine).
 * The base map is five bytes an entry with a cumulative 24-bit step. Both are
 * cumulative, so an append is not the gentle option it is in SCI1.1: pointing
 * one entry at the end of a Volume hundreds of megabytes long needs one step
 * far past the 16MB a step holds. So a SCI32 Volume is rebuilt whole —
 * `rebuildSci32Volume` — with every recording any map names copied byte for
 * byte, the replacement written where its original began, and every map that
 * addresses the Volume rewritten with the offsets that move produced. A map
 * none of whose recordings moved is carried as it was.
 *
 * Which Volume is ScummVM's rule for a single-disc install and is the same as
 * SCI1.1's: `RESOURCE.SFX` for map 65535 when there is one, `RESOURCE.AUD`
 * otherwise and for every per-room map.
 *
 * ## Numbered discs: one disc rebuilt, the others untouched
 *
 * An install whose audio is on numbered discs (`RESSCI.001` present and no
 * `RESOURCE.AUD`, ScummVM's `_multiDiscAudio`) keeps each disc's audio maps in
 * that disc's own `RESMAP.00n`, addressing that disc's `RESAUD.00n` (and, for
 * map 65535, its `RESSFX.00n` when it has one — `sciDiscAudioVolume`). The
 * same map number on two discs is two tables. So `rebuildSciDiscAudio` finds
 * the disc the recording is played from — the lowest whose base map lists it,
 * which is ScummVM's `addResource` keeping the first — and runs the rebuild
 * above over that disc's maps and that disc's Volume alone. Every other
 * disc's Volume and maps are carried exactly as they arrived.
 *
 * ## What it refuses, by name
 *
 * - A step that does not fit a cumulative map's 24 bits, naming the recording
 *   and the step; and a map whose entries cannot be told apart.
 * - A recording no disc's base map lists, on a numbered-disc install.
 * - A replacement that is not a **PCM WAVE**. The sample is written in the
 *   container the original used — a RIFF where the release ships RIFF, Sierra's
 *   SOL where it ships SOL — and both are made from PCM; there is no encoder
 *   here for anything else and no decoder for the result would agree.
 * - A sample rate SOL's 16-bit field cannot hold, and any recording the base
 *   map does not list or whose header cannot be read — a sample with no
 *   readable header has no known length, so it cannot be copied as itself.
 *
 * Nothing here runs when nothing was replaced: an unedited export carries the
 * Volumes exactly as they arrived, which is the byte-identity everything else
 * in this family is held to.
 */

import {
  looksLikeRiffSample,
  readSciAudioHeader,
  SCI_BASE_AUDIO_MAP,
  sciDiscAudioVolume,
  type SciAudioSample,
} from '../../engine/sci/sound/sciAudio.js';
import { readWavePcm, writeWavePcm } from '../../engine/sound/wave.js';

/** One recording an author replaced, as the export needs it. */
export interface SciAudioReplacement {
  /** The number the game's own scripts and maps use. */
  readonly number: number;
  /**
   * The bulk file the row names, or absent for an `audio` resource in the
   * resource map. Only *whether* it is set is read: which bulk file map 65535
   * addresses is the install's answer, not the row's.
   */
  readonly file?: string;
  /** The author's file, which has to be a PCM WAVE. */
  readonly wave: Uint8Array;
  /** The row's name, for the sentences below. */
  readonly name: string;
}

/** A file of the install, as `packSciGame` carries it. */
export interface SciAudioVolumeFile {
  readonly name: string;
  readonly data: Uint8Array;
}

export interface SciAudioRebuild {
  /** The export's resources, with `audio:n` and `map:65535` substituted. */
  readonly resources: Map<string, Uint8Array>;
  /** The carried Volumes, with a rebuilt one in the place of its original. */
  readonly carried: SciAudioVolumeFile[];
  /** Which carried Volumes were rebuilt rather than copied. */
  readonly rebuiltVolumes: string[];
  /** One sentence per recording written. */
  readonly replaced: string[];
  /** One sentence per recording that could not be, each naming why. */
  readonly refused: string[];
}

/**
 * How many bytes one sample occupies, header and all.
 *
 * A RIFF's own size field measures everything after its first eight bytes; a
 * SOL's measures the audio alone, and its header — type byte, size byte and
 * the header the size byte measures — sits in front of it.
 */
export function sciSampleLength(header: SciAudioSample, head: Uint8Array): number {
  return looksLikeRiffSample(head) ? header.length + 8 : header.dataOffset + header.length;
}

/** SOL's flag bits, as ScummVM's `makeSOLStream` reads them. */
const SOL_SIXTEEN_BIT = 0x04;

/**
 * The author's WAVE as a sample in the container the original used.
 *
 * Returns a sentence instead where it cannot. The width follows the original
 * rather than the author's file, because what a release's driver was built to
 * play is the original's width — a 16-bit sample in a release that shipped
 * 8-bit is a file ScummVM plays and a 1993 sound card may not. The result is
 * never DPCM: this project has no encoder for Sierra's delta compression, and
 * an uncompressed SOL is legal in every release (the flag says which it is).
 */
export function encodeSciAudioSample(
  wave: Uint8Array,
  original: Uint8Array,
  what: string,
): Uint8Array | string {
  const pcm = readWavePcm(wave);
  if (!pcm) {
    return (
      `${what}: the replacement is not a PCM WAVE, and a SCI sample is written from PCM ` +
      `whichever container the release uses — save it as a WAV and it will be written`
    );
  }

  const header = readSciAudioHeader(original);
  if (!header) {
    return `${what}: the recording it replaces has no sample header this project can read`;
  }

  // A release that ships RIFF gets a RIFF: the smallest one that plays
  // everywhere, mono and 16-bit, which is what `waveFrom` hands the editor too.
  if (looksLikeRiffSample(original)) return writeWavePcm(pcm.samples, pcm.sampleRate);

  if (pcm.sampleRate > 0xffff) {
    return (
      `${what}: ${pcm.sampleRate} Hz, and a SOL header holds its rate in sixteen bits — ` +
      `resample it to ${header.sampleRate || 22050} Hz, the rate the original was recorded at`
    );
  }

  // Sierra's own header. The size byte is the original's where it is one of
  // the two ScummVM accepts for a sample with a length field (11, or 12 with a
  // pad byte after the length); `loadFromAudioVolumeSCI11` refuses any other.
  const sizeByte = original[1] === 12 ? 12 : 11;
  const sixteen = header.sixteenBit;
  const bodyLength = pcm.samples.length * (sixteen ? 2 : 1);
  const out = new Uint8Array(2 + sizeByte + bodyLength);
  const view = new DataView(out.buffer);

  // The first byte is the resource type (audio, with the high bit set), which
  // is what this project's reader calls SOL's marker; it is copied rather than
  // restated so the two cannot disagree.
  out[0] = original[0];
  out[1] = sizeByte;
  out.set([0x53, 0x4f, 0x4c, 0x00], 2);
  view.setUint16(6, pcm.sampleRate, true);
  out[8] = sixteen ? SOL_SIXTEEN_BIT : 0;
  view.setUint32(9, bodyLength, true);

  const body = 2 + sizeByte;
  for (const [index, sample] of pcm.samples.entries()) {
    // Eight-bit SOL is unsigned and centred on 128, the inverse of `pcmOf`'s
    // `(byte - 128) << 8`; sixteen-bit is signed little-endian.
    if (sixteen) view.setInt16(body + index * 2, sample, true);
    else out[body + index] = (sample >> 8) + 128;
  }
  return out;
}

function u16(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8);
}

function u24(bytes: Uint8Array, at: number): number {
  return bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16);
}

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
}

/** The largest step a cumulative map's 24-bit field holds. */
const MAX_STEP = 0xffffff;

/** One entry of the base audio map. */
interface BaseEntry {
  readonly number: number;
  readonly offset: number;
}

/**
 * The base audio map as a table that can be written back.
 *
 * Not patched in place, because one of its two forms cannot be: a cumulative
 * map stores each offset as a step from the one before, so moving one sample
 * changes the step after it too. Both forms are therefore read into offsets
 * and written out again, and the bytes after the terminator are carried as
 * they were — an unedited map written back is the map it was.
 */
interface BaseTable {
  /** `six` is (u16 number, u32 offset); `cumulative` is (u16 number, u24 step). */
  readonly form: 'six' | 'cumulative';
  readonly entries: readonly BaseEntry[];
  /** Everything from the `0xffff` terminator on. */
  readonly tail: Uint8Array;
}

/**
 * The base map's entries, in either of the forms ScummVM's
 * `readAudioMapSCI11` reads.
 *
 * Its rule and not a stricter one: SCI32 is always the cumulative five-byte
 * form (ScummVM fixes the width there, because the heuristic breaks on at least
 * one release), and before SCI32 the map's trailing `0xff` bytes are counted —
 * six of them is the six-byte form, anything else the cumulative one.
 */
function readBaseTable(map: Uint8Array, sci32: boolean): BaseTable {
  let form: BaseTable['form'] = 'cumulative';
  if (!sci32) {
    let trailing = 0;
    for (let at = map.length - 1; at >= 0 && map[at] === 0xff; at--) trailing++;
    if (trailing === 6) form = 'six';
  }
  const stride = form === 'six' ? 6 : 5;
  const entries: BaseEntry[] = [];
  let offset = 0;
  let at = 0;
  for (; at + stride <= map.length; at += stride) {
    const number = u16(map, at);
    if (number === 0xffff) break;
    offset = form === 'six' ? u32(map, at + 2) : offset + u24(map, at + 2);
    entries.push({ number, offset });
  }
  return { form, entries, tail: map.slice(at) };
}

/**
 * The base map again, with each entry at the offset given for it.
 *
 * A cumulative map is written in offset order — the order of its entries is
 * not something an interpreter reads, only their steps are, and a step cannot
 * be negative — and is refused by name when a step does not fit its 24 bits.
 */
function writeBaseTable(table: BaseTable, offsets: readonly number[]): Uint8Array | string {
  const out: number[] = [];
  if (table.form === 'six') {
    for (const [index, entry] of table.entries.entries()) {
      const offset = offsets[index];
      if (offset > 0xffffffff) {
        return `recording ${entry.number} would sit past the 4GB a base map offset can address`;
      }
      out.push(entry.number & 0xff, entry.number >> 8);
      out.push(offset & 0xff, (offset >> 8) & 0xff, (offset >> 16) & 0xff, (offset >>> 24) & 0xff);
    }
  } else {
    // A stable sort, so entries that already rose keep their order and two
    // numbers at one offset stay in the order the release wrote them.
    const order = table.entries.map((_, index) => index).sort((a, b) => offsets[a] - offsets[b]);
    let previous = 0;
    for (const index of order) {
      const entry = table.entries[index];
      const step = offsets[index] - previous;
      if (step > MAX_STEP) {
        return (
          `recording ${entry.number} would be ${step} bytes past the recording before it, and ` +
          `a cumulative base map holds each step in 24 bits (at most ${MAX_STEP})`
        );
      }
      out.push(entry.number & 0xff, entry.number >> 8);
      out.push(step & 0xff, (step >> 8) & 0xff, (step >> 16) & 0xff);
      previous = offsets[index];
    }
  }
  const bytes = new Uint8Array(out.length + table.tail.length);
  bytes.set(out);
  bytes.set(table.tail, out.length);
  return bytes;
}

/** One entry of a SCI32 per-room speech map. */
interface RoomEntry {
  /** The four key bytes as they lie: noun, verb, condition, sequence and flags. */
  readonly tuple: Uint8Array;
  /** Where the entry's bytes start — its sync data when it has any. */
  readonly offset: number;
  /** How much sync data comes before the sample, zero when none. */
  readonly syncSize: number;
}

/** A per-room speech map (audio36), as SCI2 and later write it. */
interface RoomTable {
  /** The map resource's own number, which is its room. */
  readonly number: number;
  readonly entries: readonly RoomEntry[];
  /** Everything from the `0xffffffff` terminator on. */
  readonly tail: Uint8Array;
}

/** ScummVM's `kSpeechFlag`: this entry carries a sync size, and sync data first. */
const SPEECH_FLAG = 0x80;

/**
 * A SCI32 per-room map, read exactly as `readAudioMapSCI11` reads its "late"
 * form — which SCI32 always is, because ScummVM fixes its entry size at 11
 * there rather than inferring it.
 *
 * A 32-bit base offset, then per entry the four tuple bytes (read big-endian
 * as one number, so the sequence byte and its flags are the low byte), a
 * 24-bit step from the previous offset, and — when the sequence byte has
 * `0x80` set — a 16-bit sync size. That makes an entry seven bytes or nine,
 * and the sample itself sits after its sync data. The 0x40 rave flag is King's
 * Quest VI's, read for that game alone and never for SCI32.
 *
 * This is the table SCI1.1's rebuild cannot read, which is why it appends
 * rather than compacts; from SCI2 on the width is not inferred, so a compacting
 * rebuild can rewrite these maps with the rest.
 */
function readSci32RoomTable(number: number, map: Uint8Array): RoomTable | string {
  if (map.length < 4) {
    return `map ${number} is shorter than the four bytes a SCI32 speech map's base offset takes`;
  }
  const entries: RoomEntry[] = [];
  let offset = u32(map, 0);
  let at = 4;
  while (at + 4 <= map.length) {
    if (map[at] === 0xff && map[at + 1] === 0xff && map[at + 2] === 0xff && map[at + 3] === 0xff) {
      return { number, entries, tail: map.slice(at) };
    }
    const flags = map[at + 3];
    const needs = 7 + (flags & SPEECH_FLAG ? 2 : 0);
    if (at + needs > map.length) break;
    offset += u24(map, at + 4);
    const syncSize = flags & SPEECH_FLAG ? u16(map, at + 7) : 0;
    entries.push({ tuple: map.slice(at, at + 4), offset, syncSize });
    at += needs;
  }
  return (
    `map ${number} ends at byte ${at} in the middle of an entry, without the 0xffffffff that ` +
    `closes a SCI32 speech map, so its entries cannot be told apart to be moved`
  );
}

/** A SCI32 per-room map again, with each entry at its new offset. */
function writeSci32RoomTable(table: RoomTable, offsets: readonly number[]): Uint8Array | string {
  const order = table.entries.map((_, index) => index).sort((a, b) => offsets[a] - offsets[b]);
  const base = order.length > 0 ? offsets[order[0]] : 0;
  if (base > 0xffffffff) {
    return `map ${table.number}'s first recording would sit past the 4GB its base offset can address`;
  }
  const out: number[] = [
    base & 0xff,
    (base >> 8) & 0xff,
    (base >> 16) & 0xff,
    (base >>> 24) & 0xff,
  ];
  let previous = base;
  for (const index of order) {
    const entry = table.entries[index];
    const step = offsets[index] - previous;
    if (step > MAX_STEP) {
      return (
        `a recording in map ${table.number} would be ${step} bytes past the one before it, and a ` +
        `SCI32 speech map holds each step in 24 bits (at most ${MAX_STEP})`
      );
    }
    out.push(...entry.tuple, step & 0xff, (step >> 8) & 0xff, (step >> 16) & 0xff);
    if (entry.tuple[3] & SPEECH_FLAG) out.push(entry.syncSize & 0xff, entry.syncSize >> 8);
    previous = offsets[index];
  }
  const bytes = new Uint8Array(out.length + table.tail.length);
  bytes.set(out);
  bytes.set(table.tail, out.length);
  return bytes;
}

/** The sample at an offset, header and all, or null where there is none. */
function sampleAt(volume: Uint8Array, offset: number): Uint8Array | null {
  const head = volume.subarray(offset, offset + 64);
  const header = readSciAudioHeader(head);
  if (!header) return null;
  const end = offset + sciSampleLength(header, head);
  return end <= volume.length ? volume.subarray(offset, end) : null;
}

/** Joins chunks into one buffer, copying each once. */
function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

function baseName(name: string): string {
  return name.replace(/\\/g, '/').split('/').pop() ?? name;
}

/** What a compacting SCI32 rebuild produces. */
interface Sci32Rebuilt {
  readonly data: Uint8Array;
  readonly baseMap: Uint8Array;
  /** Rewritten per-room maps, by number; a map nothing in moved is absent. */
  readonly roomMaps: Map<number, Uint8Array>;
}

/**
 * A SCI32 audio Volume rebuilt whole, with every map that addresses it.
 *
 * **Every byte a map names is kept, and only those.** Each recording's extent
 * is known — a base entry is one sample, a speech entry is its sync data and
 * then its sample — so the Volume is the union of those extents, copied in
 * their original order with the gaps between them closed. Extents that overlap
 * or share bytes are copied as one run, so two entries that pointed at the same
 * bytes still do. A replaced recording is written where its original began, so
 * the steps around it stay about the size they were rather than one step
 * spanning the whole Volume.
 *
 * Every offset in every map is then translated through that one move, which is
 * what makes rewriting maps safe here and not in SCI1.1: there is no entry this
 * reads at an inferred width.
 */
function rebuildSci32Volume(
  file: SciAudioVolumeFile,
  base: BaseTable,
  rooms: readonly RoomTable[],
  substitutes: ReadonlyMap<number, Uint8Array>,
): Sci32Rebuilt | string {
  const volume = file.data;
  const extents: Array<{ start: number; end: number }> = [];

  for (const entry of base.entries) {
    if (substitutes.has(entry.number)) continue;
    const sample = sampleAt(volume, entry.offset);
    if (!sample) {
      return (
        `recording ${entry.number}: ${file.name} has no sample header at offset ${entry.offset}, ` +
        `so its length is unknown and it cannot be copied as itself`
      );
    }
    extents.push({ start: entry.offset, end: entry.offset + sample.length });
  }
  for (const room of rooms) {
    for (const entry of room.entries) {
      const sample = sampleAt(volume, entry.offset + entry.syncSize);
      if (!sample) {
        return (
          `map ${room.number} names a recording at offset ${entry.offset + entry.syncSize} of ` +
          `${file.name} with no sample header there, so its length is unknown and the Volume ` +
          `cannot be compacted without losing it`
        );
      }
      extents.push({ start: entry.offset, end: entry.offset + entry.syncSize + sample.length });
    }
  }

  // Overlapping extents become one run.
  extents.sort((a, b) => a.start - b.start);
  const runs: Array<{ start: number; end: number; at: number }> = [];
  for (const extent of extents) {
    const last = runs[runs.length - 1];
    if (last && extent.start < last.end) last.end = Math.max(last.end, extent.end);
    else runs.push({ ...extent, at: 0 });
  }

  // Where each replacement goes: where its original began, or straight after
  // the run its original was inside, since a run is not cut.
  const placed = new Map<number, number>();
  const pieces: Array<{ key: number; number: number }> = [];
  for (const number of substitutes.keys()) {
    const original = base.entries.find((entry) => entry.number === number)!.offset;
    const inside = runs.find((run) => original > run.start && original < run.end);
    pieces.push({ key: inside ? inside.end - 0.5 : original - 0.5, number });
  }

  const order = [
    ...runs.map((run) => ({ key: run.start, run })),
    ...pieces.map((piece) => ({ key: piece.key, piece })),
  ].sort((a, b) => a.key - b.key);

  const chunks: Uint8Array[] = [];
  let end = 0;
  for (const item of order) {
    if ('run' in item) {
      item.run.at = end;
      chunks.push(volume.subarray(item.run.start, item.run.end));
      end += item.run.end - item.run.start;
    } else {
      placed.set(item.piece.number, end);
      const sample = substitutes.get(item.piece.number)!;
      chunks.push(sample);
      end += sample.length;
    }
  }
  if (end > 0xffffffff) return `${file.name} would grow past the 4GB a map offset can address`;

  const moved = (offset: number): number => {
    const run = runs.find((each) => offset >= each.start && offset < each.end)!;
    return run.at + (offset - run.start);
  };

  const baseMap = writeBaseTable(
    base,
    base.entries.map((entry) => placed.get(entry.number) ?? moved(entry.offset)),
  );
  if (typeof baseMap === 'string') return baseMap;

  const roomMaps = new Map<number, Uint8Array>();
  for (const room of rooms) {
    const offsets = room.entries.map((entry) => moved(entry.offset));
    if (offsets.every((offset, index) => offset === room.entries[index].offset)) continue;
    const written = writeSci32RoomTable(room, offsets);
    if (typeof written === 'string') return written;
    roomMaps.set(room.number, written);
  }

  return { data: concat(chunks), baseMap, roomMaps };
}

/**
 * Puts every replaced recording into the install.
 *
 * `resources` is `exportSciGame`'s map and is not mutated; `sci32` says whether
 * the container is SCI32's, which settles every map's width without the
 * heuristic. `volume`, when given, names the Volume map 65535 addresses, for a
 * numbered disc. With no replacements the inputs come back as they went in.
 */
export function rebuildSciAudio(
  resources: ReadonlyMap<string, Uint8Array>,
  carried: readonly SciAudioVolumeFile[],
  replacements: readonly SciAudioReplacement[],
  options: {
    sci32: boolean;
    /**
     * The carried Volume map 65535 addresses, by name, where it is not
     * ScummVM's single-disc choice — a numbered disc's `RESSFX.00n` or
     * `RESAUD.00n` (`rebuildSciDiscAudio`).
     */
    volume?: string;
  },
): SciAudioRebuild {
  const out = new Map(resources);
  const volumes = [...carried];
  const replaced: string[] = [];
  const refused: string[] = [];
  const rebuiltVolumes: string[] = [];

  // The resource-map half: a body substituted, and the packer does the rest.
  const bulk: SciAudioReplacement[] = [];
  for (const replacement of replacements) {
    if (replacement.file !== undefined) {
      bulk.push(replacement);
      continue;
    }
    const key = `audio:${replacement.number}`;
    const original = out.get(key);
    if (!original) {
      refused.push(
        `${replacement.name}: audio ${replacement.number} is not a resource this project holds, ` +
          `so the replacement would have nowhere to go`,
      );
      continue;
    }
    const sample = encodeSciAudioSample(replacement.wave, original, replacement.name);
    if (typeof sample === 'string') {
      refused.push(sample);
      continue;
    }
    out.set(key, sample);
    replaced.push(
      `${replacement.name}: written as audio ${replacement.number} in the resource map`,
    );
  }

  if (bulk.length === 0) {
    return { resources: out, carried: volumes, rebuiltVolumes, replaced, refused };
  }

  // The bulk half. Which file map 65535 addresses is ScummVM's rule, and the
  // refusals say which file they were looking for.
  const names = volumes.map((volume) => baseName(volume.name).toUpperCase());
  const index = options.volume
    ? names.indexOf(baseName(options.volume).toUpperCase())
    : names.includes('RESOURCE.SFX')
      ? names.indexOf('RESOURCE.SFX')
      : names.indexOf('RESOURCE.AUD');
  const map = out.get(`map:${SCI_BASE_AUDIO_MAP}`);

  const refuseAll = (why: string): void => {
    for (const replacement of bulk) refused.push(`${replacement.name}: ${why}`);
  };
  if (index < 0) {
    refuseAll(
      options.volume
        ? `the folder does not hold ${baseName(options.volume)}, so there is no audio Volume ` +
            'to write the recording into'
        : 'the folder holds neither RESOURCE.SFX nor RESOURCE.AUD, so there is no audio Volume ' +
            'to write the recording into',
    );
    return { resources: out, carried: volumes, rebuiltVolumes, replaced, refused };
  }
  if (!map) {
    refuseAll(`this project holds no base audio map (map ${SCI_BASE_AUDIO_MAP}) to repoint`);
    return { resources: out, carried: volumes, rebuiltVolumes, replaced, refused };
  }
  const table = readBaseTable(map, options.sci32);
  const entries = table.entries;

  const file = volumes[index];
  const volume = file.data;

  // The new samples, by number. The last replacement of a number wins, which
  // is what the project holds — a track has one set of bytes.
  const substitutes = new Map<number, Uint8Array>();
  const labels = new Map<number, string>();
  for (const replacement of bulk) {
    const entry = entries.find((each) => each.number === replacement.number);
    if (!entry) {
      refused.push(
        `${replacement.name}: the base audio map lists no recording ${replacement.number}, so ` +
          `the replacement would have nowhere to go`,
      );
      continue;
    }
    const original = sampleAt(volume, entry.offset);
    if (!original) {
      refused.push(
        `${replacement.name}: ${file.name} has no sample header at offset ${entry.offset}, so ` +
          `the recording it replaces cannot be found to write over`,
      );
      continue;
    }
    const sample = encodeSciAudioSample(replacement.wave, original, replacement.name);
    if (typeof sample === 'string') {
      refused.push(sample);
      continue;
    }
    substitutes.set(replacement.number, sample);
    labels.set(replacement.number, replacement.name);
  }

  // A refusal writes nothing, for the reason `packSciGame` gives: half an
  // audio Volume is an install that loads and then plays the wrong line.
  if (refused.length > 0 || substitutes.size === 0) {
    return { resources: out, carried: volumes, rebuiltVolumes, replaced, refused };
  }

  // Map 200 and its siblings key a room's speech into RESOURCE.AUD. Their
  // presence is what decides, before SCI32, between a compacting rebuild and
  // an append; from SCI32 on they are read and rewritten with the rest.
  const roomKeys = [...out.keys()].filter(
    (key) => key.startsWith('map:') && key !== `map:${SCI_BASE_AUDIO_MAP}`,
  );
  // An effects Volume (`RESOURCE.SFX`, a disc's `RESSFX.00n`) is map 65535's
  // alone; any other is the one the room maps address too.
  const sharedWithRooms = !/(^RESSFX\.|\.SFX$)/.test(names[index]) && roomKeys.length > 0;

  let rebuilt: Uint8Array;
  let rewrittenMap: Uint8Array | string;

  if (options.sci32) {
    const rooms: RoomTable[] = [];
    if (sharedWithRooms) {
      for (const key of roomKeys) {
        const room = readSci32RoomTable(Number(key.slice(4)), out.get(key)!);
        if (typeof room === 'string') {
          refuseAll(room);
          return { resources: out, carried: volumes, rebuiltVolumes, replaced, refused };
        }
        rooms.push(room);
      }
    }
    const result = rebuildSci32Volume(file, table, rooms, substitutes);
    if (typeof result === 'string') {
      refuseAll(result);
      return {
        resources: new Map(resources),
        carried: [...carried],
        rebuiltVolumes: [],
        replaced: [],
        refused,
      };
    }
    for (const [number, bytes] of result.roomMaps) out.set(`map:${number}`, bytes);
    for (const number of substitutes.keys()) {
      replaced.push(
        `${labels.get(number)}: written into ${file.name}, rebuilt with its base audio map` +
          (rooms.length > 0
            ? ` and the ${rooms.length} per-room speech map${rooms.length === 1 ? '' : 's'} ` +
              `that address it (${result.roomMaps.size} rewritten), every other recording ` +
              `copied byte for byte`
            : ''),
      );
    }
    rebuilt = result.data;
    rewrittenMap = result.baseMap;
  } else if (sharedWithRooms) {
    // Appended: every other offset in every table still points at bytes that
    // did not move.
    const chunks: Uint8Array[] = [volume];
    const offsets = entries.map((entry) => entry.offset);
    let end = volume.length;
    for (const [number, sample] of substitutes) {
      for (const [at, entry] of entries.entries()) {
        if (entry.number === number) offsets[at] = end;
      }
      replaced.push(
        `${labels.get(number)}: appended to ${file.name} at offset ${end}, its base map entry ` +
          `repointed; the per-room speech maps address the same Volume and none of their ` +
          `recordings moved`,
      );
      chunks.push(sample);
      end += sample.length;
    }
    rebuilt = concat(chunks);
    rewrittenMap = writeBaseTable(table, offsets);
  } else {
    // Rebuilt whole: each distinct offset copied once, in map order, so two
    // numbers that shared a sample still share one.
    const chunks: Uint8Array[] = [];
    const moved = new Map<number, number>();
    const offsets: number[] = [];
    let end = 0;
    for (const entry of entries) {
      const substitute = substitutes.get(entry.number);
      if (!substitute && moved.has(entry.offset)) {
        offsets.push(moved.get(entry.offset)!);
        continue;
      }
      const sample = substitute ?? sampleAt(volume, entry.offset);
      if (!sample) {
        refused.push(
          `recording ${entry.number}: ${file.name} has no sample header at offset ` +
            `${entry.offset}, so its length is unknown and it cannot be copied as itself`,
        );
        offsets.push(entry.offset);
        continue;
      }
      if (!substitute) moved.set(entry.offset, end);
      offsets.push(end);
      chunks.push(sample);
      end += sample.length;
    }
    for (const number of substitutes.keys()) {
      replaced.push(`${labels.get(number)}: written into ${file.name}, rebuilt with its map`);
    }
    rebuilt = concat(chunks);
    rewrittenMap = writeBaseTable(table, offsets);
  }

  if (typeof rewrittenMap === 'string') refuseAll(rewrittenMap);
  if (refused.length > 0 || typeof rewrittenMap === 'string') {
    return {
      resources: new Map(resources),
      carried: [...carried],
      rebuiltVolumes: [],
      replaced: [],
      refused,
    };
  }

  volumes[index] = { name: file.name, data: rebuilt };
  out.set(`map:${SCI_BASE_AUDIO_MAP}`, rewrittenMap);
  rebuiltVolumes.push(file.name);
  return { resources: out, carried: volumes, rebuiltVolumes, replaced, refused };
}

/** One disc of a numbered install, as the audio rebuild and the packer need it. */
export interface SciAudioDisc {
  /** The disc's number, which is its `RESMAP.00n`'s. */
  readonly number: number;
  /** Every `type:number` this disc's own map lists. */
  readonly keys: readonly string[];
  /** This disc's own `map` resources, by number — its audio maps, as it holds them. */
  readonly maps: ReadonlyMap<number, Uint8Array>;
  /**
   * This disc's own copy of every resource it lists that a later disc also
   * lists, by `type:number`. The interpreter reads the later disc's (a later
   * map *updates* a Volume entry), so this copy is unreachable and is packed
   * back as it arrived rather than overwritten with the one that is read.
   */
  readonly shadowed?: ReadonlyMap<string, Uint8Array>;
}

export interface SciDiscAudioRebuild extends SciAudioRebuild {
  /** Each disc's audio maps after the rebuild; a disc nothing was written to is its own. */
  readonly discMaps: Map<number, Map<number, Uint8Array>>;
}

/**
 * Puts every replaced recording into a numbered-disc install.
 *
 * An `audio` resource in the resource map is the same case as on a single
 * disc and goes through `rebuildSciAudio` unchanged. A base-map recording is
 * written into the disc it is played from — the lowest disc whose own map
 * 65535 lists it (`findSciDiscRecording` gives ScummVM's reason) — by running
 * `rebuildSciAudio` over *that disc's* audio maps and *that disc's* Volume,
 * so its per-room speech maps are rewritten with it where they share the
 * Volume and every other disc is carried byte for byte.
 *
 * A refusal anywhere writes nothing anywhere, for the reason `packSciGame`
 * gives.
 */
export function rebuildSciDiscAudio(
  resources: ReadonlyMap<string, Uint8Array>,
  discs: readonly SciAudioDisc[],
  carried: readonly SciAudioVolumeFile[],
  replacements: readonly SciAudioReplacement[],
  options: { sci32: boolean },
): SciDiscAudioRebuild {
  const originalMaps = (): Map<number, Map<number, Uint8Array>> =>
    new Map(discs.map((disc) => [disc.number, new Map(disc.maps)]));

  const inMap = replacements.filter((replacement) => replacement.file === undefined);
  const bulk = replacements.filter((replacement) => replacement.file !== undefined);
  const first = rebuildSciAudio(resources, carried, inMap, options);

  let volumes = [...first.carried];
  const discMaps = originalMaps();
  const replaced = [...first.replaced];
  const refused = [...first.refused];
  const rebuiltVolumes = [...first.rebuiltVolumes];

  const present = new Map(
    carried.map((file) => [baseName(file.name).toUpperCase(), baseName(file.name)]),
  );
  const ordered = [...discs].sort((a, b) => a.number - b.number);

  const byDisc = new Map<number, SciAudioReplacement[]>();
  for (const replacement of bulk) {
    const disc = ordered.find((each) => {
      const map = each.maps.get(SCI_BASE_AUDIO_MAP);
      return map
        ? readBaseTable(map, options.sci32).entries.some(
            (entry) => entry.number === replacement.number,
          )
        : false;
    });
    if (!disc) {
      refused.push(
        `${replacement.name}: no disc's base audio map lists recording ${replacement.number}, so ` +
          `the replacement would have nowhere to go`,
      );
      continue;
    }
    byDisc.set(disc.number, [...(byDisc.get(disc.number) ?? []), replacement]);
  }

  for (const [number, group] of byDisc) {
    const disc = ordered.find((each) => each.number === number)!;
    const volume = sciDiscAudioVolume(present, SCI_BASE_AUDIO_MAP, number);
    if (!volume) {
      const n = String(number).padStart(3, '0');
      for (const replacement of group) {
        refused.push(
          `${replacement.name}: it is on disc ${number}, and the folder holds neither ` +
            `RESSFX.${n} nor RESAUD.${n} to write it into`,
        );
      }
      continue;
    }
    const own = new Map([...disc.maps].map(([map, bytes]) => [`map:${map}`, bytes]));
    const result = rebuildSciAudio(own, volumes, group, { ...options, volume });
    refused.push(...result.refused);
    if (result.refused.length > 0) continue;
    volumes = result.carried;
    rebuiltVolumes.push(...result.rebuiltVolumes);
    replaced.push(...result.replaced.map((sentence) => `${sentence} (disc ${number})`));
    const maps = discMaps.get(number)!;
    for (const [key, bytes] of result.resources) maps.set(Number(key.slice(4)), bytes);
  }

  if (refused.length > 0) {
    return {
      resources: new Map(resources),
      carried: [...carried],
      rebuiltVolumes: [],
      replaced: [],
      refused,
      discMaps: originalMaps(),
    };
  }
  return {
    resources: first.resources,
    carried: volumes,
    rebuiltVolumes,
    replaced,
    refused,
    discMaps,
  };
}
