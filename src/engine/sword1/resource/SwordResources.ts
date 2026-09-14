/**
 * Broken Sword's resource manager: clusters in, resources out.
 *
 * ## The one design decision in this file
 *
 * `AdventureEngine.step()` is synchronous and a browser's file reads are not,
 * so somewhere a family has to decide where the awaiting happens. ADR 0010 made
 * that call for SCUMM — the main container stays in memory "so the script
 * engine can ask for a costume synchronously mid-frame" — and it cannot be made
 * the same way here: a full Broken Sword install is around 300 MB of clusters,
 * and `SPEECH1.CLU` alone is 45 MB.
 *
 * So the decision is split along a seam **the game itself already has**.
 * `SwordEngine::mainLoop` is two nested loops: the outer one changes screen, the
 * inner one runs logic cycles, and the inner loop exits the moment
 * `NEW_SCREEN != SCREEN`. Every cluster a screen's logic can touch is therefore
 * knowable *before* its first cycle runs — which is what `fnPreload`,
 * `fnEnterSection` and Revolution's own two-CD packaging are built around.
 *
 * This manager is built on that:
 *
 * - **Resident clusters** are loaded whole and stay: `SCRIPTS`, `COMPACTS`,
 *   `TEXT`, `GENERAL`, `MAPS`, `PUZZLE`. Together about 12 MB, and they are
 *   every cluster the *logic* path reads — bytecode, objects, subtitles, walk
 *   grids, the font.
 * - **Section clusters** (`PARIS1`, `SYRIA`, …) are loaded whole on a screen
 *   change and evicted least-recently-used past a cap, mirroring ScummVM's
 *   `MAX_OPEN_CLUS`. Around 10-20 MB each.
 * - **Streamed clusters** (`SPEECH1`, `SPEECH2`, and the music files) are never
 *   held: they are read by range, which is what `DataSource.readRange` exists
 *   for and the case ADR 0010 carved out for `.BUN` bundles.
 *
 * The consequence a reader should know: `fetch` is synchronous and may answer
 * null, and null means *not resident* rather than *not shipped*.
 * `describeMissing` is what turns that into a sentence, and the engine pauses
 * its cycle rather than running one on a resource it does not have.
 */

import type { DataSource } from '../../resource/DataSource.js';
import { readRangeFrom } from '../../resource/DataSource.js';
import {
  allResourceIds,
  clusterOf,
  describeRif,
  formatResourceId,
  groupOf,
  indexOf,
  locateResource,
  parseRif,
  type RifIndex,
} from './rif.js';
import { readSwordHeader, type SwordHeader } from './swordDefs.js';

/** Raised with something a person can act on, never a bare assertion. */
export class SwordResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwordResourceError';
  }
}

/**
 * Clusters held whole for the life of the game.
 *
 * These and no others, and the list is a claim about the *logic* path: bytecode,
 * compacts, subtitles, walk grids and the font are all here, so a logic cycle
 * never misses. Anything a cycle can reach that is not in this list would be a
 * reason to add it, which is why the list is short and stated rather than
 * derived from file size.
 */
export const SWORD1_RESIDENT_CLUSTERS = [
  'SCRIPTS',
  'COMPACTS',
  'TEXT',
  'GENERAL',
  'MAPS',
  'PUZZLE',
] as const;

/**
 * Clusters never held: read by range and discarded.
 *
 * Speech is 45 MB a disc. Holding it to play one line is the cost ADR 0010
 * names for v7 bundles, and the answer is the same one.
 */
export const SWORD1_STREAMED_CLUSTERS = ['SPEECH1', 'SPEECH2', 'SPEECH'] as const;

/**
 * How many section clusters stay resident at once.
 *
 * Eight, which is ScummVM's `MAX_OPEN_CLUS` — chosen there for file handles and
 * here for memory, arriving at the same number for different reasons. Two would
 * be enough for one screen; eight means walking back and forth across a region
 * boundary does not reload.
 */
export const SWORD1_MAX_OPEN_SECTION_CLUSTERS = 8;

/** A resource's bytes, with its header already read. */
export interface SwordResource {
  readonly id: number;
  readonly header: SwordHeader;
  /** The whole resource, header included — offsets in the format are from here. */
  readonly bytes: Uint8Array;
  /** Just the payload, which is what every decoder wants. */
  readonly payload: Uint8Array;
}

interface ClusterFile {
  /** `GENERAL` — as `swordres.rif` spells it, upper-cased. */
  readonly label: string;
  /** The name in the folder, with its real case and any subdirectory. */
  readonly file: string;
  readonly bytes: number;
}

export interface SwordResourcesOptions {
  onLog?: (message: string) => void;
}

export class SwordResources {
  /** Set when the clusters are big-endian — the Macintosh release. */
  readonly bigEndian: boolean;

  private readonly resident = new Map<string, Uint8Array>();
  /**
   * Reads in flight, keyed on the cluster label.
   *
   * A promise and not a boolean, and that is the whole point. `step()` is
   * synchronous while a cluster read is not, so the engine asks for the same
   * cluster on *every* frame until one of the asks lands — and before this
   * cache each ask saw the cluster absent and started another read. Measured
   * on the mounted Broken Sword II demo, whose `Docks.clu` is 20 MB: 400
   * frames of a probe issued 400 reads of it and it never became resident,
   * because the 401st read was always the one still in flight. Caching the
   * *promise* is what makes the second caller wait for the first rather than
   * race it.
   *
   * `pinned` is not part of the key. It does not need to be: everything pinned
   * is loaded by `loadResident()`, which awaits each one in turn before the
   * engine exists, so no pinned ask ever arrives behind an unpinned one.
   */
  private readonly loads = new Map<string, Promise<boolean>>();
  /** Section clusters, most-recently-used last. */
  private readonly openSections: string[] = [];
  private readonly missing = new Set<number>();

  private constructor(
    private readonly source: DataSource,
    readonly index: RifIndex,
    private readonly files: ReadonlyMap<string, ClusterFile>,
    bigEndian: boolean,
    private readonly log?: (message: string) => void,
  ) {
    this.bigEndian = bigEndian;
  }

  /**
   * Opens a folder's `swordres.rif` and finds the clusters beside it.
   *
   * Refuses by name rather than by symptom: a folder with an index and no
   * clusters is a partial extraction, and saying which cluster is absent is the
   * difference between a fixable problem and a blank screen.
   */
  static async create(
    source: DataSource,
    options: SwordResourcesOptions = {},
  ): Promise<SwordResources> {
    const names = source.list();
    const rifName = names.find((name) => /(?:^|[/\\])swordres\.rif$/i.test(name));
    if (!rifName) {
      throw new SwordResourceError(
        `No swordres.rif in ${source.label}. That file is Broken Sword's cluster index and the ` +
          `game cannot be read without it; on a retail disc it is in the "clusters" folder.`,
      );
    }

    const rifBytes = await source.read(rifName);
    if (!rifBytes) {
      throw new SwordResourceError(`${rifName} could not be read from ${source.label}.`);
    }
    const index = parseRif(rifBytes);

    // `.CLM` is the Macintosh release's extension and its clusters are
    // big-endian; `.CLU` is every PC release's and they are little-endian. The
    // index itself is little-endian either way (see `rif.ts`), so the extension
    // is the only evidence of byte order there is — and it is decided here,
    // once, rather than asked about downstream.
    const macintosh = names.some((name) => /\.clm$/i.test(name));

    const files = new Map<string, ClusterFile>();
    for (const cluster of index.clusters) {
      const label = cluster.label.toUpperCase();
      const wanted = new RegExp(
        `(?:^|[/\\\\])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(clu|clm)$`,
        'i',
      );
      const file = names.find((name) => wanted.test(name));
      if (file) files.set(label, { label, file, bytes: 0 });
    }

    const declared = index.clusters.map((cluster) => cluster.label.toUpperCase());
    const absent = declared.filter((label) => !files.has(label));
    // The immediate three: ScummVM flags `COMPACTS`, `GENERAL` and `SCRIPTS`
    // `FLAG_IMMED` — "this file is needed immediately, game won't start without
    // it". Anything else absent is a region the player cannot reach, which is a
    // note rather than a refusal: a CD1-only install is a real thing people have.
    const immediate = ['COMPACTS', 'GENERAL', 'SCRIPTS'].filter((label) => !files.has(label));
    if (immediate.length > 0) {
      throw new SwordResourceError(
        `${rifName} names ${declared.length} clusters and this folder is missing ` +
          `${immediate.join(', ')}. Broken Sword cannot start without ` +
          `${immediate.length === 1 ? 'that one' : 'those'} — they hold its objects, its ` +
          `bytecode and its shared graphics.`,
      );
    }

    const resources = new SwordResources(source, index, files, macintosh, options.onLog);
    options.onLog?.(
      `swordres.rif: ${describeRif(index)}${macintosh ? ', Macintosh (big-endian) clusters' : ''}` +
        `${absent.length > 0 ? `; not in this folder: ${absent.join(', ')}` : ''}`,
    );
    return resources;
  }

  /** Cluster labels the index declares and this folder has. */
  get availableClusters(): string[] {
    return [...this.files.keys()].sort();
  }

  /** Cluster labels the index declares and this folder does not have. */
  get absentClusters(): string[] {
    return this.index.clusters
      .map((cluster) => cluster.label.toUpperCase())
      .filter((label) => !this.files.has(label))
      .sort();
  }

  /**
   * Cluster number to label, from the index rather than from the folder.
   *
   * Every cluster `swordres.rif` declares, present or not, because the use for
   * it is naming the one a resource lives in when the answer is "the disc this
   * install is not" — see `sword1AbsentPictureReason`.
   */
  get clusterLabels(): Record<number, string> {
    const labels: Record<number, string> = {};
    for (const cluster of this.index.clusters) labels[cluster.cluster] = cluster.label;
    return labels;
  }

  /** True when a cluster's bytes are in memory and `fetch` will answer. */
  isResident(label: string): boolean {
    return this.resident.has(label.toUpperCase());
  }

  /** Whether this cluster is one that is never held whole. */
  static isStreamed(label: string): boolean {
    return (SWORD1_STREAMED_CLUSTERS as readonly string[]).includes(label.toUpperCase());
  }

  /**
   * Loads the always-resident clusters. Called once, before the first cycle.
   *
   * A cluster the folder does not have is skipped rather than fatal — `create`
   * already refused the three the game cannot start without, and a CD1-only
   * install legitimately has no `SYRIA.CLU`.
   */
  async loadResident(): Promise<void> {
    for (const label of SWORD1_RESIDENT_CLUSTERS) {
      if (!this.files.has(label)) continue;
      await this.loadCluster(label, true);
    }
  }

  /**
   * Makes a cluster resident, evicting the least recently used past the cap.
   *
   * `pinned` clusters are never evicted. Everything in
   * `SWORD1_RESIDENT_CLUSTERS` is pinned; a section cluster is not.
   */
  async loadCluster(label: string, pinned = false): Promise<boolean> {
    const key = label.toUpperCase();
    if (this.resident.has(key)) {
      if (!pinned) this.touch(key);
      return true;
    }
    // Somebody is already reading it. Wait for their read rather than starting
    // a second one: see `loads` above for what that costs when it is missing.
    const inFlight = this.loads.get(key);
    if (inFlight) return inFlight;

    const file = this.files.get(key);
    if (!file) return false;
    if (SwordResources.isStreamed(key)) return false;

    const load = this.readCluster(key, file, pinned).finally(() => this.loads.delete(key));
    this.loads.set(key, load);
    return load;
  }

  /** The read itself, which is what `loads` holds while it is happening. */
  private async readCluster(key: string, file: ClusterFile, pinned: boolean): Promise<boolean> {
    const bytes = await this.source.read(file.file);
    if (!bytes) return false;
    this.resident.set(key, bytes);
    if (!pinned) {
      this.openSections.push(key);
      while (this.openSections.length > SWORD1_MAX_OPEN_SECTION_CLUSTERS) {
        const evicted = this.openSections.shift();
        if (evicted) this.resident.delete(evicted);
      }
    }
    this.log?.(
      `${key}.${file.file.toLowerCase().endsWith('.clm') ? 'CLM' : 'CLU'} loaded, ${bytes.length} bytes`,
    );
    return true;
  }

  private touch(key: string): void {
    const at = this.openSections.indexOf(key);
    if (at >= 0) {
      this.openSections.splice(at, 1);
      this.openSections.push(key);
    }
  }

  /** The cluster label a resource id lives in, or null when the id is not addressable. */
  clusterLabelFor(id: number): string | null {
    const cluster = this.index.clusters.find((candidate) => candidate.cluster === clusterOf(id));
    return cluster ? cluster.label.toUpperCase() : null;
  }

  /**
   * A resource's bytes, synchronously, or null.
   *
   * Null is one of three things and the caller usually needs to know which, so
   * `describeMissingResource` exists: the index has no such slot, the cluster is
   * not in this folder, or the cluster is not resident yet. Only the third is
   * recoverable, and it is the one `wanted` collects.
   */
  fetch(id: number): SwordResource | null {
    const located = locateResource(this.index, id);
    if (!located) return null;
    const label = located.cluster.label.toUpperCase();
    const bytes = this.resident.get(label);
    if (!bytes) {
      this.missing.add(id);
      return null;
    }
    const { offset, length } = located.resource;
    if (offset + length > bytes.length) {
      throw new SwordResourceError(
        `${formatResourceId(id)} is at offset ${offset} for ${length} bytes in ${label}, which ` +
          `only has ${bytes.length}. The cluster is truncated or does not match swordres.rif.`,
      );
    }
    const slice = bytes.subarray(offset, offset + length);
    return {
      id,
      header: readSwordHeader(slice, this.bigEndian),
      bytes: slice,
      payload: slice.subarray(20),
    };
  }

  /** Loads a resource, making its cluster resident first. */
  async load(id: number): Promise<SwordResource | null> {
    const label = this.clusterLabelFor(id);
    if (!label) return null;
    if (!this.resident.has(label)) {
      if (!(await this.loadCluster(label))) return null;
    }
    return this.fetch(id);
  }

  /**
   * A resource read by range, for the clusters that are never held.
   *
   * Speech and music. The bytes come back without going through the resident
   * map, so a 45 MB cluster costs one seek rather than 45 MB of memory.
   */
  async loadStreamed(id: number): Promise<SwordResource | null> {
    const located = locateResource(this.index, id);
    if (!located) return null;
    const file = this.files.get(located.cluster.label.toUpperCase());
    if (!file) return null;
    const { offset, length } = located.resource;
    const bytes = await readRangeFrom(this.source, file.file, offset, offset + length);
    if (!bytes || bytes.length < 20) return null;
    return {
      id,
      header: readSwordHeader(bytes, this.bigEndian),
      bytes,
      payload: bytes.subarray(20),
    };
  }

  /** Ids a synchronous fetch could not answer, so the engine can load them. */
  get wanted(): number[] {
    return [...this.missing];
  }

  /** Drops the wanted set, after the engine has loaded what it can. */
  clearWanted(): void {
    this.missing.clear();
  }

  /** Loads every cluster a wanted resource lives in. Returns how many arrived. */
  async satisfyWanted(): Promise<number> {
    const labels = new Set<string>();
    for (const id of this.missing) {
      const label = this.clusterLabelFor(id);
      if (label && !this.resident.has(label)) labels.add(label);
    }
    this.missing.clear();
    let loaded = 0;
    for (const label of labels) {
      if (await this.loadCluster(label)) loaded++;
    }
    return loaded;
  }

  /**
   * Why a fetch answered null, in a sentence.
   *
   * A resource id is a *path* — cluster, then group, then index — so "not in
   * swordres.rif" has three different meanings and they call for three
   * different actions. This used to collapse all three into one sentence that
   * offered a single reason: "a localised build has six subtitle groups where
   * another has seven". That reason is about the `TEXT` cluster's language
   * groups and is true there; said about `0x04000004`, the Czech game font, it
   * is simply not what happened — `GENERAL` is present, its group 0 is present,
   * and what is absent is index 4 inside it, because this release is not the
   * Czech one. The message now walks the path and names the step that failed,
   * and it says how far the level that did exist goes, which is what tells a
   * reader whether they are holding the wrong id or the wrong release.
   */
  describeMissingResource(id: number): string {
    const located = locateResource(this.index, id);
    if (!located) {
      const cluster = this.index.clusters.find((candidate) => candidate.cluster === clusterOf(id));
      if (!cluster) {
        return (
          `${formatResourceId(id)} names cluster ${clusterOf(id) + 1}, and swordres.rif lists ` +
          `${this.index.clusters.length} clusters (${this.index.clusters
            .map((candidate) => candidate.label)
            .join(', ')}). The id is wrong rather than the install being short.`
        );
      }
      const group = cluster.groups.find((candidate) => candidate.group === groupOf(id));
      if (!group) {
        return (
          `${formatResourceId(id)} names group ${groupOf(id)} of ${cluster.label}, which has ` +
          `${cluster.groups.length} group${cluster.groups.length === 1 ? '' : 's'} with ` +
          `anything in ${cluster.groups.length === 1 ? 'it' : 'them'} ` +
          `(${cluster.groups.map((candidate) => candidate.group).join(', ')}). A group is a ` +
          `section, and a release ships the sections its own script tables name — so this is ` +
          `either an id from another release or an id built from the wrong section number.`
        );
      }
      return (
        `${formatResourceId(id)} names index ${indexOf(id)} of ${cluster.label} group ` +
        `${groupOf(id)}, which declares ${group.declared} slot${group.declared === 1 ? '' : 's'} ` +
        `and has ${group.resources.length} of them filled` +
        (indexOf(id) < group.declared
          ? `. That slot is a hole in this release's index, which is normal: a localised build ` +
            `fills slots an English one leaves empty.`
          : `. The index does not go that far, so this is an id from a release that ships more ` +
            `than this folder does.`)
      );
    }
    const label = located.cluster.label.toUpperCase();
    if (!this.files.has(label)) {
      return (
        `${formatResourceId(id)} is in ${label}.CLU, which is not in this folder. On a retail ` +
        `install that cluster is on the other disc.`
      );
    }
    if (SwordResources.isStreamed(label)) {
      return (
        `${formatResourceId(id)} is in ${label}.CLU, which this project never holds whole — it ` +
        `is read by range (45 MB a disc). Ask for it with \`loadStreamed\`.`
      );
    }
    if (!this.resident.has(label)) {
      return `${formatResourceId(id)} is in ${label}.CLU, which is not resident yet.`;
    }
    // Every reachable reason is exhausted: the index has the slot, the file is
    // here, and the cluster is loaded. `fetch` only answers null in the three
    // cases above, so reaching this line means the caller asked about a
    // resource that is not in fact missing — and saying "not resident yet"
    // about a resident cluster is the wrong answer to give a reader who is
    // trying to work out what went wrong somewhere else.
    return (
      `${formatResourceId(id)} is in ${label}.CLU, which is resident, and the index has the ` +
      `slot — so this resource is not missing and whatever failed, failed after the fetch.`
    );
  }

  /** Every id the index holds, for a sweep or an export. */
  allIds(): number[] {
    return allResourceIds(this.index);
  }

  /** One line for the log. */
  describe(): string {
    const resident = [...this.resident.keys()].sort().join(', ');
    return (
      `${describeRif(this.index)}; resident: ${resident || 'none'}` +
      `${this.absentClusters.length > 0 ? `; absent: ${this.absentClusters.join(', ')}` : ''}`
    );
  }
}
