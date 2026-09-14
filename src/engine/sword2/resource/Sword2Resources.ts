/**
 * Broken Sword II's resource manager: two index files, then flat clusters.
 *
 * ## The layout, and why it is the opposite of Sword1's
 *
 * Sword1 keeps one nested index (`swordres.rif`) describing every cluster's
 * contents. Sword2 keeps the opposite arrangement:
 *
 * - **`resource.inf`** is a plain text file: one cluster filename per line.
 * - **`resource.tab`** is a flat array of `uint16` pairs — for resource *id*
 *   `n`, `(cluster index, index within that cluster)`. So the id space is
 *   global and dense, and a resource's id says nothing about where it lives.
 * - **`cd.inf`** says which disc each cluster is on: a 20-byte name and a flag
 *   byte per cluster.
 * - **Each `.clu`** begins with a `uint32` offset to its own lookup table,
 *   which sits at the **end** of the file as `(offset, length)` pairs.
 *
 * Two consequences worth knowing before reading the code. First, the index is
 * three files and any one of them missing is fatal, so all three are refused by
 * name. Second, a cluster's own table is only read when that cluster is first
 * touched — which is why `readCluIndex` is lazy here as it is in ScummVM.
 *
 * ## Residency
 *
 * The same seam `SwordResources` draws, for the same reason and with a
 * different list. Sword2's logic path reads objects (`GAME_OBJECT`), screen
 * managers and the globals, and **all three of those live in `scripts.clu`**;
 * `general.clu` and `text.clu` hold the shared animations, the pointers and the
 * words. Its screens and walk grids live in per-region clusters loaded on a
 * session change. Speech and music are 100 MB a disc and are range-read.
 */

import type { DataSource } from '../../resource/DataSource.js';
import { readRangeFrom } from '../../resource/DataSource.js';
import {
  parseSword2CluIndex,
  SWORD2_CLU_TABLE_AT,
  type Sword2CluEntry,
  type Sword2CluIndex,
} from '../sound/sword2Clu.js';
import { readSword2ResHeader, RES_HEADER_SIZE, type Sword2ResHeader } from './sword2Headers.js';

/** Raised with something a person can act on, never a bare assertion. */
export class Sword2ResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Sword2ResourceError';
  }
}

/**
 * Clusters held whole for the life of the game.
 *
 * **`scripts.clu` is the one that matters and it was missing.** Measured
 * against the mounted demo, that cluster holds every one of the 905
 * `GAME_OBJECT` resources, all 68 `SCREEN_MANAGER`s and the single
 * `GLOBAL_VAR_FILE` — so it is not merely *a* cluster a logic cycle reads, it
 * is the only one the cycle reads *code* from. Without it resident, `fetch(1)`
 * answers null and the game cannot start at all.
 *
 * It also has to be **pinned** rather than merely loaded, for a reason the
 * other entries do not share: an object's hub — its logic level and its script
 * program counters — is written back into the resource's own bytes, which are a
 * view onto this cluster. Evicting it would discard the running state of every
 * object in the game.
 *
 * `general.clu` holds the mouse pointers, the menu icons and the shared
 * animations; `text.clu` holds every line in every language. Region clusters
 * and `players.clu` arrive through the LRU on a session change, which is where
 * the asynchronous seam belongs.
 */
export const SWORD2_RESIDENT_CLUSTERS = ['scripts.clu', 'general.clu', 'text.clu'] as const;

/**
 * `cd.inf`'s flag bits, from ScummVM's `resman.cpp`.
 *
 * `LOCAL_CACHE` (0x4) is in the format and "is no longer used", so it is not
 * named here — what it did was say a CD cluster gets copied to disk, and the
 * disc bit beside it is what still answers the question.
 */
const SWORD2_CD1 = 0x1;
const SWORD2_CD2 = 0x2;
/** The cluster is on the hard disk, so no disc has to be asked for. */
const SWORD2_CD_LOCAL_PERM = 0x8;

/** Clusters never held whole: read by range and discarded. */
export const SWORD2_STREAMED = /^(speech|music)\d*\.clu$/i;

/**
 * A file beside the install that is a sound container rather than a cluster.
 *
 * The same names as `SWORD2_STREAMED` and a different question. That constant
 * asks "is this declared cluster one the engine never holds whole"; this asks
 * "is this *file*, which `resource.inf` does not name, one of the two streamed
 * containers a retail disc ships". Neither demo has one — the clusters the
 * demo declares are all ordinary — and the two layouts are not the same file
 * read two ways: a cluster's first word is the offset of its own tail table,
 * and a container's is the number of entries in its index (`sword2Clu.ts`).
 */
export const SWORD2_SOUND_FILE = /^(speech|music)\d*\.clu$/i;

/**
 * How much of a cluster's tail to read when hunting for its entry table.
 *
 * The table's length is not stated anywhere, so it is read generously and
 * trimmed. A megabyte is 131,072 entries; the largest cluster either release
 * ships holds 275.
 */
const STREAMED_TABLE_LIMIT = 1 << 20;

/** How many region clusters stay resident at once. */
export const SWORD2_MAX_OPEN_CLUSTERS = 8;

interface ClusterState {
  /** As `resource.inf` spells it. */
  readonly name: string;
  /** The file in the folder, with its real case and any subdirectory. */
  readonly file: string | null;
  /** Which disc, from `cd.inf`. 0 means "always available". */
  cd: number;
  /** `(offset, length)` pairs, read lazily from the file's tail. */
  entries: Uint32Array | null;
  bytes: Uint8Array | null;
}

/** A resource's bytes, with its header already read. */
export interface Sword2Resource {
  readonly id: number;
  readonly header: Sword2ResHeader;
  /** The whole resource, header included — offsets in the format are from here. */
  readonly bytes: Uint8Array;
  readonly payload: Uint8Array;
}

export interface Sword2ResourcesOptions {
  onLog?: (message: string) => void;
}

export class Sword2Resources {
  private readonly clusters: ClusterState[] = [];
  /** Where the two index files were found, kept so an export can re-read them. */
  private infFile = '';
  private tabFile = '';
  /** Resource id -> `(cluster, index)`, from `resource.tab`. */
  private table = new Uint16Array(0);
  private readonly open: string[] = [];
  private readonly missing = new Set<number>();
  /**
   * Reads in flight, keyed on the cluster's name as `resource.inf` spells it.
   *
   * A promise and not a boolean, and that is the whole point. `step()` is
   * synchronous while a cluster read is not, so the engine asks for the same
   * cluster on *every* frame until one of the asks lands — and before this
   * cache each ask found `bytes` still null and started another read. Measured
   * on the mounted demo, whose `Docks.clu` is 20 MB: 400 frames of a probe
   * issued 400 reads of it and the docks background never arrived, because the
   * read that would have satisfied the frame was always the one still in
   * flight. Caching the *promise* is what makes the second caller wait for the
   * first rather than race it.
   *
   * `pinned` is not part of the key. It does not need to be: everything pinned
   * is loaded by `loadResident()`, which awaits each one in turn before the
   * first cycle, so no pinned ask ever arrives behind an unpinned one.
   */
  private readonly loads = new Map<string, Promise<boolean>>();

  /** Streamed sound containers this folder holds, which `resource.inf` never names. */
  private readonly sounds: Array<{ name: string; file: string }> = [];
  /** Their indices, read by range once and kept: a retail one is half a gigabyte. */
  private readonly soundIndices = new Map<string, Sword2CluIndex | null>();

  private constructor(
    private readonly source: DataSource,
    private readonly log?: (message: string) => void,
  ) {}

  /** How many resource ids the table declares. */
  get resourceCount(): number {
    return this.table.length >> 1;
  }

  get clusterNames(): string[] {
    return this.clusters.map((cluster) => cluster.name);
  }

  get absentClusters(): string[] {
    return this.clusters.filter((cluster) => !cluster.file).map((cluster) => cluster.name);
  }

  get presentClusters(): string[] {
    return this.clusters.filter((cluster) => cluster.file).map((cluster) => cluster.name);
  }

  /**
   * Every declared cluster with the file that holds it, in `resource.inf` order.
   *
   * The order is the point. `resource.tab` addresses a cluster by its line
   * number in `resource.inf`, so anything that has to map a resource back to a
   * file — an export, above all — needs the declared list and not the list of
   * files that happen to be present. The demo declares fourteen and ships five.
   */
  get clusterFiles(): ReadonlyArray<{ name: string; file: string | null }> {
    return this.clusters.map((cluster) => ({ name: cluster.name, file: cluster.file }));
  }

  /** Where `resource.inf` and `resource.tab` were found, with their real case. */
  get indexFiles(): { inf: string; tab: string } {
    return { inf: this.infFile, tab: this.tabFile };
  }

  /**
   * The streamed sound containers this folder holds, lower-cased with the file.
   *
   * Empty for both demos and for the PlayStation conversion, which is why
   * everything downstream of it treats "no containers" as ordinary rather than
   * as a fault: the demo's whole audio surface is its effects.
   */
  get soundFiles(): ReadonlyArray<{ name: string; file: string }> {
    return this.sounds;
  }

  /**
   * One container's index, read by range and kept.
   *
   * The header and the table only — a retail `SPEECH1.CLU` is hundreds of
   * megabytes and the editor lists what is in it without reading a recording.
   * Two ranges rather than one generous read, because the table's size is
   * stated by the file's first word and reading a megabyte of a file that
   * turned out not to be a container would be a megabyte wasted.
   */
  async readSoundIndex(file: string): Promise<Sword2CluIndex | null> {
    const found = this.soundIndices.get(file);
    if (found !== undefined) return found;
    const index = await this.loadSoundIndex(file);
    this.soundIndices.set(file, index);
    return index;
  }

  private async loadSoundIndex(file: string): Promise<Sword2CluIndex | null> {
    const head = await readRangeFrom(this.source, file, 0, SWORD2_CLU_TABLE_AT);
    if (!head || head.length < SWORD2_CLU_TABLE_AT) return null;
    const count = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(0, true);
    // A count that would ask for more than a hundred megabytes of table is not
    // one, and `parseSword2CluIndex` would refuse it anyway — this is only so
    // the range asked for is bounded by something before the read happens.
    if (count === 0 || count > 1 << 20) return null;
    const bytes = await readRangeFrom(this.source, file, 0, SWORD2_CLU_TABLE_AT + count * 8);
    if (!bytes) return null;
    // Null for the length, not `bytes.length`: this is a prefix of the file and
    // every payload in it lies past the end of what was read.
    return parseSword2CluIndex(file, bytes, null);
  }

  /** One recording's payload, read by range. The codec is `sword2Clu.ts`'s. */
  async readSoundPayload(file: string, entry: Sword2CluEntry): Promise<Uint8Array | null> {
    return readRangeFrom(this.source, file, entry.at, entry.at + entry.length);
  }

  /**
   * Reads the three index files, or refuses by name.
   *
   * `cd.inf` is refused *conditionally*: the PlayStation conversion ships none,
   * and ScummVM skips the check for it. So its absence is a note when
   * `screens.clu` is present and a refusal otherwise — which is the same
   * evidence `sword2Detect.ts` uses to name the Release, kept consistent on
   * purpose.
   */
  static async create(
    source: DataSource,
    options: Sword2ResourcesOptions = {},
  ): Promise<Sword2Resources> {
    const names = source.list();
    const find = (wanted: string): string | undefined =>
      names.find((name) => new RegExp(`(?:^|[/\\\\])${wanted}$`, 'i').test(name));

    const infName = find('resource\\.inf');
    const tabName = find('resource\\.tab');
    if (!infName || !tabName) {
      throw new Sword2ResourceError(
        `Broken Sword II keeps its index in resource.inf and resource.tab, and this folder is ` +
          `missing ${!infName ? 'resource.inf' : 'resource.tab'}. The game cannot be read ` +
          `without both — the first names its clusters and the second maps resource numbers ` +
          `into them.`,
      );
    }

    const resources = new Sword2Resources(source, options.onLog);
    resources.infFile = infName;
    resources.tabFile = tabName;

    const infBytes = await source.read(infName);
    if (!infBytes) throw new Sword2ResourceError(`${infName} could not be read.`);
    // A plain text file, one name per line. CRLF and LF both appear in the
    // wild, and a trailing blank line is normal — hence the filter.
    const clusterNames = new TextDecoder('latin1')
      .decode(infBytes)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '');
    if (clusterNames.length === 0) {
      throw new Sword2ResourceError(`${infName} names no clusters, so there is nothing to read.`);
    }

    for (const name of clusterNames) {
      const file = find(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) ?? null;
      resources.clusters.push({ name, file, cd: 0, entries: null, bytes: null });
    }

    // The streamed containers, which are files rather than clusters: a retail
    // disc ships `speech1.clu` and `music1.clu` beside the install and
    // `resource.inf` names neither. Anything the index *does* name is left to
    // the cluster path above, so a release that declared one would not be read
    // twice.
    const declared = new Set(clusterNames.map((name) => name.toLowerCase()));
    for (const name of names) {
      const base = (name.split(/[/\\]/).pop() ?? name).toLowerCase();
      if (!SWORD2_SOUND_FILE.test(base) || declared.has(base)) continue;
      resources.sounds.push({ name: base, file: name });
    }

    const tabBytes = await source.read(tabName);
    if (!tabBytes) throw new Sword2ResourceError(`${tabName} could not be read.`);
    if (tabBytes.length % 4 !== 0) {
      throw new Sword2ResourceError(
        `${tabName} is ${tabBytes.length} bytes, which is not a whole number of ` +
          `(cluster, index) pairs. It is not Broken Sword II's resource table.`,
      );
    }
    resources.table = new Uint16Array(tabBytes.length >> 1);
    const tabView = new DataView(tabBytes.buffer, tabBytes.byteOffset, tabBytes.byteLength);
    for (let at = 0; at < resources.table.length; at++) {
      resources.table[at] = tabView.getUint16(at * 2, true);
    }

    // `cd.inf`: a 20-byte name and a flag byte per cluster.
    const cdName = find('cd\\.inf');
    if (cdName) {
      const cdBytes = await source.read(cdName);
      if (cdBytes) {
        for (let at = 0; at + 21 <= cdBytes.length; at += 21) {
          let end = at;
          while (end < at + 20 && cdBytes[end] !== 0) end++;
          const name = new TextDecoder('latin1').decode(cdBytes.subarray(at, end)).toLowerCase();
          const flag = cdBytes[at + 20];
          const cluster = resources.clusters.find(
            (candidate) => candidate.name.toLowerCase() === name,
          );
          if (!cluster) continue;
          // Normalised the way ScummVM normalises them (`resman.cpp:193`), and
          // the **order matters**: `LOCAL_PERM` (0x8) is tested first, because
          // the shipped flags set it *together with* a disc bit. The demo's
          // cd.inf marks its four hard-disk clusters `0x9`, so testing CD1
          // first called every one of them "disc 1" — a file that is always
          // there, reported as one to go and fetch.
          cluster.cd =
            flag & SWORD2_CD_LOCAL_PERM ? 0 : flag & SWORD2_CD1 ? 1 : flag & SWORD2_CD2 ? 2 : 0;
        }
      }
    } else if (!find('screens\\.clu')) {
      throw new Sword2ResourceError(
        `Broken Sword II keeps its disc layout in cd.inf and this folder has none. Only the ` +
          `PlayStation conversion ships without it, and this folder has no screens.clu either, ` +
          `so it is a partial install rather than a PlayStation one.`,
      );
    }

    const absent = resources.absentClusters;
    if (!resources.clusters.some((cluster) => cluster.file)) {
      throw new Sword2ResourceError(
        `${infName} names ${clusterNames.length} clusters and this folder has none of them. ` +
          `The index is here and the game's data is not.`,
      );
    }

    options.onLog?.(
      `Broken Sword II index: ${resources.resourceCount} resources across ` +
        `${clusterNames.length} clusters` +
        (absent.length > 0 ? `; not in this folder: ${absent.join(', ')}` : ''),
    );
    return resources;
  }

  /** Makes a cluster resident, evicting the least recently used past the cap. */
  async loadCluster(name: string, pinned = false): Promise<boolean> {
    const cluster = this.clusters.find(
      (candidate) => candidate.name.toLowerCase() === name.toLowerCase(),
    );
    if (!cluster || !cluster.file) return false;
    if (cluster.bytes) {
      if (!pinned) this.touch(cluster.name);
      return true;
    }
    if (SWORD2_STREAMED.test(cluster.name)) return false;

    // Somebody is already reading it. Wait for their read rather than starting
    // a second one: see `loads` above for what that costs when it is missing.
    const inFlight = this.loads.get(cluster.name);
    if (inFlight) return inFlight;

    const load = this.readClusterBytes(cluster, pinned).finally(() =>
      this.loads.delete(cluster.name),
    );
    this.loads.set(cluster.name, load);
    return load;
  }

  /** The read itself, which is what `loads` holds while it is happening. */
  private async readClusterBytes(cluster: ClusterState, pinned: boolean): Promise<boolean> {
    if (!cluster.file) return false;
    const bytes = await this.source.read(cluster.file);
    if (!bytes) return false;
    cluster.bytes = bytes;
    this.readCluIndex(cluster);
    if (!pinned) {
      this.open.push(cluster.name);
      while (this.open.length > SWORD2_MAX_OPEN_CLUSTERS) {
        const evicted = this.open.shift();
        const dropped = this.clusters.find((candidate) => candidate.name === evicted);
        // The entry table is kept: it is a few kilobytes and re-reading it
        // costs a seek, where the bytes are megabytes and are what matters.
        if (dropped) dropped.bytes = null;
      }
    }
    this.log?.(`${cluster.name} loaded, ${bytes.length} bytes`);
    return true;
  }

  /** Loads the always-resident clusters. Called once, before the first cycle. */
  async loadResident(): Promise<void> {
    for (const name of SWORD2_RESIDENT_CLUSTERS) await this.loadCluster(name, true);
  }

  private touch(name: string): void {
    const at = this.open.indexOf(name);
    if (at >= 0) {
      this.open.splice(at, 1);
      this.open.push(name);
    }
  }

  /**
   * Reads a cluster's own lookup table from its tail.
   *
   * The first `uint32` of a cluster is the offset of the table, and the table
   * runs to the end of the file — so its length is the file size less the
   * offset, and a table whose length is not a multiple of eight means the file
   * is truncated rather than that the format differs.
   */
  private readCluIndex(cluster: ClusterState): void {
    if (!cluster.bytes || cluster.entries) return;
    const bytes = cluster.bytes;
    if (bytes.length < 4) {
      throw new Sword2ResourceError(`${cluster.name} is ${bytes.length} bytes and holds no index.`);
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tableOffset = view.getUint32(0, true);
    if (tableOffset >= bytes.length) {
      throw new Sword2ResourceError(
        `${cluster.name} says its index is at ${tableOffset} and the file is ${bytes.length} ` +
          `bytes. It is truncated or is not a Broken Sword II cluster.`,
      );
    }
    const tableSize = bytes.length - tableOffset;
    if (tableSize % 8 !== 0) {
      throw new Sword2ResourceError(
        `${cluster.name}'s index is ${tableSize} bytes, which is not a whole number of ` +
          `(offset, length) pairs. The file is truncated.`,
      );
    }
    const entries = new Uint32Array(tableSize >> 2);
    for (let at = 0; at < entries.length; at++) {
      entries[at] = view.getUint32(tableOffset + at * 4, true);
    }
    cluster.entries = entries;
  }

  /** Where a resource id lives, or null when the table has no such id. */
  locate(id: number): { cluster: ClusterState; offset: number; length: number } | null {
    if (id < 0 || id >= this.resourceCount) return null;
    const clusterIndex = this.table[id * 2];
    const resourceIndex = this.table[id * 2 + 1];
    // 0xffff is the table's "no such resource" marker and is a real entry: the
    // id space is dense and the game does not use every id.
    if (clusterIndex === 0xffff) return null;
    const cluster = this.clusters[clusterIndex];
    if (!cluster) return null;
    if (!cluster.entries) {
      this.missing.add(id);
      return null;
    }
    const at = resourceIndex * 2;
    if (at + 1 >= cluster.entries.length) return null;
    return { cluster, offset: cluster.entries[at], length: cluster.entries[at + 1] };
  }

  /**
   * A resource's bytes, synchronously, or null.
   *
   * Null means *not resident* as often as it means *not shipped*, so
   * `describeMissingResource` exists to say which — the same contract
   * `SwordResources.fetch` has, and for the same reason.
   */
  fetch(id: number): Sword2Resource | null {
    const located = this.locate(id);
    if (!located) return null;
    const { cluster, offset, length } = located;
    if (!cluster.bytes) {
      this.missing.add(id);
      return null;
    }
    if (offset + length > cluster.bytes.length || length < RES_HEADER_SIZE) {
      throw new Sword2ResourceError(
        `Resource ${id} is at ${offset} for ${length} bytes in ${cluster.name}, which holds ` +
          `${cluster.bytes.length}. The cluster does not match resource.tab.`,
      );
    }
    const slice = cluster.bytes.subarray(offset, offset + length);
    return {
      id,
      header: readSword2ResHeader(slice),
      bytes: slice,
      payload: slice.subarray(RES_HEADER_SIZE),
    };
  }

  /** Loads a resource, making its cluster resident first. */
  async load(id: number): Promise<Sword2Resource | null> {
    if (id < 0 || id >= this.resourceCount) return null;
    const clusterIndex = this.table[id * 2];
    if (clusterIndex === 0xffff) return null;
    const cluster = this.clusters[clusterIndex];
    if (!cluster) return null;
    if (!cluster.bytes) {
      if (!(await this.loadCluster(cluster.name))) return null;
    }
    return this.fetch(id);
  }

  /** A resource read by range, for speech and music. */
  async loadStreamed(id: number): Promise<Sword2Resource | null> {
    if (id < 0 || id >= this.resourceCount) return null;
    const clusterIndex = this.table[id * 2];
    if (clusterIndex === 0xffff) return null;
    const cluster = this.clusters[clusterIndex];
    if (!cluster?.file) return null;
    // The entry table has to be in hand, and it lives at the file's tail — so
    // a streamed cluster's index is read once by range and then kept.
    if (!cluster.entries) {
      const head = await readRangeFrom(this.source, cluster.file, 0, 4);
      if (!head || head.length < 4) return null;
      const tableOffset = new DataView(head.buffer, head.byteOffset, head.byteLength).getUint32(
        0,
        true,
      );
      // The file's size is not known without reading it, so the table is read
      // in one generous range — a megabyte, which is 131,072 entries against
      // the largest cluster the game ships holding 275 — and trimmed to a
      // whole number of pairs. A range read clamps to the end of the file, so
      // asking for more than is there costs nothing.
      //
      // `tableOffset + STREAMED_TABLE_LIMIT` and not `(tableOffset + 1) << 20`,
      // which is what this said and is a precedence slip: it shifts the byte
      // offset rather than the megabyte, and `<<` works on int32 — so every
      // cluster whose body runs past 2,047 bytes wrapped, about half of them
      // to a negative end. In the mounted demo that was General.clu and
      // SCRIPTS.CLU, whose resources then answered nothing at all.
      const tail = await readRangeFrom(
        this.source,
        cluster.file,
        tableOffset,
        tableOffset + STREAMED_TABLE_LIMIT,
      );
      // An empty read is a failed read, not a cluster with no resources, so it
      // is not cached: caching it would make the failure permanent for every
      // other id in the same cluster.
      if (!tail || tail.length < 8) return null;
      const usable = tail.length - (tail.length % 8);
      const entries = new Uint32Array(usable >> 2);
      const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
      for (let at = 0; at < entries.length; at++) entries[at] = view.getUint32(at * 4, true);
      cluster.entries = entries;
    }
    const resourceIndex = this.table[id * 2 + 1];
    const at = resourceIndex * 2;
    if (!cluster.entries || at + 1 >= cluster.entries.length) return null;
    const offset = cluster.entries[at];
    const length = cluster.entries[at + 1];
    const bytes = await readRangeFrom(this.source, cluster.file, offset, offset + length);
    if (!bytes || bytes.length < RES_HEADER_SIZE) return null;
    return {
      id,
      header: readSword2ResHeader(bytes),
      bytes,
      payload: bytes.subarray(RES_HEADER_SIZE),
    };
  }

  /** Ids a synchronous fetch could not answer, so the engine can load them. */
  get wanted(): number[] {
    return [...this.missing];
  }

  /**
   * Whether a failed {@link fetch} will succeed once the loads drain.
   *
   * The difference between "this cluster is still arriving" and "this cluster
   * is on the other disc" is the difference between a normal frame and a fault,
   * and `fetch` returns the same null for both. The engine asks this before
   * recording anything, so a resource that is merely *early* is not filed as a
   * defect for the rest of the session.
   */
  willBecomeResident(id: number): boolean {
    if (id < 0 || id >= this.resourceCount) return false;
    const clusterIndex = this.table[id * 2];
    if (clusterIndex === 0xffff) return false;
    const cluster = this.clusters[clusterIndex];
    // `file` is set only for a cluster this folder actually holds, and
    // `bytes`/`entries` only once it is resident. Streamed clusters are never
    // held whole, so a plain fetch of one will not start working either.
    return Boolean(
      cluster && cluster.file && !cluster.bytes && !SWORD2_STREAMED.test(cluster.name),
    );
  }

  /** Loads every cluster a wanted resource lives in. Returns how many arrived. */
  async satisfyWanted(): Promise<number> {
    const names = new Set<string>();
    for (const id of this.missing) {
      const clusterIndex = this.table[id * 2];
      const cluster = this.clusters[clusterIndex];
      if (cluster && !cluster.bytes) names.add(cluster.name);
    }
    this.missing.clear();
    let loaded = 0;
    for (const name of names) {
      if (await this.loadCluster(name)) loaded++;
    }
    return loaded;
  }

  /** Why a fetch answered null, in a sentence. */
  describeMissingResource(id: number): string {
    if (id < 0 || id >= this.resourceCount) {
      return (
        `Resource ${id} is outside resource.tab, which declares ${this.resourceCount}. Either ` +
        `this release does not ship it or the id is wrong.`
      );
    }
    const clusterIndex = this.table[id * 2];
    if (clusterIndex === 0xffff) {
      return `Resource ${id} is marked absent in resource.tab, which is a normal hole in the id space.`;
    }
    const cluster = this.clusters[clusterIndex];
    if (!cluster)
      return `Resource ${id} names cluster ${clusterIndex}, which resource.inf does not list.`;
    if (!cluster.file) {
      return (
        `Resource ${id} is in ${cluster.name}, which is not in this folder` +
        (cluster.cd > 0 ? ` — on a retail install that cluster is on disc ${cluster.cd}.` : '.')
      );
    }
    if (SWORD2_STREAMED.test(cluster.name)) {
      return (
        `Resource ${id} is in ${cluster.name}, which this project never holds whole — it is ` +
        `read by range. Ask for it with \`loadStreamed\`.`
      );
    }
    return `Resource ${id} is in ${cluster.name}, which is not resident yet.`;
  }

  /** Every id the table holds a real entry for, ascending. For a sweep. */
  allIds(): number[] {
    const ids: number[] = [];
    for (let id = 0; id < this.resourceCount; id++) {
      if (this.table[id * 2] !== 0xffff) ids.push(id);
    }
    return ids;
  }

  /** One line for the log. */
  describe(): string {
    const resident = this.clusters
      .filter((cluster) => cluster.bytes)
      .map((cluster) => cluster.name)
      .join(', ');
    return (
      `${this.resourceCount} resources across ${this.clusters.length} clusters; ` +
      `resident: ${resident || 'none'}` +
      (this.absentClusters.length > 0 ? `; absent: ${this.absentClusters.join(', ')}` : '')
    );
  }
}
