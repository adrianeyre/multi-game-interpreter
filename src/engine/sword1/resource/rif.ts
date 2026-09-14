/**
 * Broken Sword's cluster index — `swordres.rif` — and the addressing it defines.
 *
 * ## Why this family needs no support file
 *
 * `docs/scummvm-parity-roadmap.md` recommended `sword1` as the seventh family
 * partly on this file: "its `swordres.rif` cluster index is self-describing so
 * no support file is needed". That is the claim this module makes good on, and
 * it is worth being precise about what it means, because three other engines on
 * that page are blocked for the opposite reason (ADR 0033). A RIF holds, for
 * every resource the game ships, the cluster it lives in, its offset and its
 * length. Nothing has to be reconstructed, nothing is derived from a generated
 * table, and no numbering lives outside the shipped bytes.
 *
 * ## The layout
 *
 * Little-endian throughout, on every platform — including the Macintosh
 * release, whose *cluster* files are big-endian while this index is not. That
 * asymmetry is ScummVM's note and it is load-bearing: reading the index with
 * the cluster's endianness produces a plausible-looking wrong answer rather
 * than a failure, which is the shape of bug this project treats as worst.
 *
 * ```text
 * uint32   clusterCount
 * uint32[] clusterPresent        one per cluster; zero means "not in this build"
 * for each present cluster:
 *   char[32] label               NUL-padded, no extension: "GENERAL", "SCRIPTS"
 *   uint32   groupCount
 *   uint32[] groupPresent        one per group; zero means "no such group"
 *   for each present group:
 *     uint32   resourceCount
 *     uint32[] resourcePresent   one per resource
 *     for each present resource:
 *       uint32 offset            into the cluster file
 *       uint32 length
 * ```
 *
 * The absent entries are **not** skipped in the index — their presence word is
 * zero and no offset/length pair follows — so a reader that skips the word
 * instead of the pair desynchronises at the first hole. Holes are normal: a
 * localised build ships six subtitle groups where another ships seven.
 *
 * ## The resource id
 *
 * A resource is named by a single 32-bit number, and the number *is* the path:
 *
 * ```text
 * bits 31..24   cluster + 1     (so 0 is never a valid id)
 * bits 23..16   group
 * bits 15..0    index within the group
 * ```
 *
 * Which is why `sectionAlive`, `TOTAL_SECTIONS` and the compact ids all work in
 * multiples of 0x10000: a section *is* a group, and `ITM_PER_SEC` is the width
 * of the index field. The one-based cluster field is why `clusterOf` subtracts.
 */

/** One resource: where it sits in its cluster, and how long it is. */
export interface RifResource {
  /** Index within the group. The low 16 bits of the id. */
  readonly index: number;
  readonly offset: number;
  readonly length: number;
}

/** One group (a "section") inside a cluster. */
export interface RifGroup {
  /** Index within the cluster. The middle byte of the id. */
  readonly group: number;
  /** How many slots the group declares, holes included. */
  readonly declared: number;
  /** The slots that are actually present, in index order. */
  readonly resources: readonly RifResource[];
  /** The group's own presence table, word for word. See `RifIndex.presence`. */
  readonly presence: readonly number[];
}

/** One cluster file, named without its extension. */
export interface RifCluster {
  /** Zero-based position in the index. The id's top byte is this plus one. */
  readonly cluster: number;
  /** `GENERAL`, `SCRIPTS`, `TEXT`, … — as the index spells it. */
  readonly label: string;
  readonly groups: readonly RifGroup[];
  /** The cluster's own group presence table, word for word. */
  readonly presence: readonly number[];
}

/** A parsed `swordres.rif`. */
export interface RifIndex {
  readonly clusters: readonly RifCluster[];
  /** Total resources with an offset and a length, across every cluster. */
  readonly resourceCount: number;
  /**
   * The cluster presence table, word for word as the file holds it.
   *
   * Kept because "present" is all anything *reads* from it and not all it
   * *holds*. ScummVM tests each word for truth and so does the reader below,
   * but the shipped index does not write ones: the demo's fourteen words are
   * 7939444, 7965808, 8003388 and so on — offsets into something the build
   * tool knew about and no reader here does.
   *
   * An export that wrote ones back would be a file every reader accepts and
   * no diff calls identical, which loses the only property that makes an
   * exported install checkable. So the words are carried through untouched:
   * nothing in the RIF's own layout moves when a resource changes size.
   */
  readonly presence: readonly number[];
}

/** Raised with something a person can act on, never a bare assertion. */
export class RifError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RifError';
  }
}

/** The label field's width, NUL padding included. */
const LABEL_SIZE = 32;

/**
 * A sanity ceiling on the counts, so a non-RIF file is refused rather than
 * asking for a gigabyte of array.
 *
 * The shipped indexes declare 21 clusters and at most a few hundred groups, so
 * this is three orders of magnitude of headroom and still small enough that a
 * JPEG read as a RIF fails on the first word instead of on allocation.
 */
const SANE_MAX = 0x10000;

function readLabel(bytes: Uint8Array, at: number): string {
  let end = at;
  while (end < at + LABEL_SIZE && bytes[end] !== 0) end++;
  return new TextDecoder('latin1').decode(bytes.subarray(at, end));
}

/**
 * Reads `swordres.rif`.
 *
 * Refuses rather than guessing: every count is checked against the bytes
 * remaining before it is trusted, because the failure mode of a wrong read here
 * is an index that parses and addresses the wrong bytes. A RIF is a few tens of
 * kilobytes, so a length that walks off the end is conclusive evidence this is
 * not one.
 */
export function parseRif(bytes: Uint8Array): RifIndex {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;

  const need = (count: number, what: string): void => {
    if (at + count > bytes.length) {
      throw new RifError(
        `swordres.rif ends after ${bytes.length} bytes, in the middle of ${what}. This is not a ` +
          `Broken Sword cluster index, or it is a partial copy.`,
      );
    }
  };

  const u32 = (what: string): number => {
    need(4, what);
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };

  const clusterCount = u32('the cluster count');
  if (clusterCount === 0 || clusterCount > SANE_MAX) {
    throw new RifError(
      `swordres.rif declares ${clusterCount} clusters, which is not a number a Broken Sword ` +
        `index carries. The shipped releases declare around twenty.`,
    );
  }

  const clusterPresent: number[] = [];
  for (let i = 0; i < clusterCount; i++) clusterPresent.push(u32('the cluster presence table'));

  const clusters: RifCluster[] = [];
  let resourceCount = 0;

  for (let cluster = 0; cluster < clusterCount; cluster++) {
    if (!clusterPresent[cluster]) continue;

    need(LABEL_SIZE, `cluster ${cluster}'s label`);
    const label = readLabel(bytes, at);
    at += LABEL_SIZE;

    const groupCount = u32(`cluster ${cluster}'s group count`);
    if (groupCount > SANE_MAX) {
      throw new RifError(
        `Cluster ${cluster} ("${label}") declares ${groupCount} groups in swordres.rif, which is ` +
          `not a number a Broken Sword index carries.`,
      );
    }

    const groupPresent: number[] = [];
    for (let i = 0; i < groupCount; i++) groupPresent.push(u32(`cluster ${cluster}'s group table`));

    const groups: RifGroup[] = [];
    for (let group = 0; group < groupCount; group++) {
      if (!groupPresent[group]) continue;

      const declared = u32(`group ${group}'s resource count`);
      if (declared > SANE_MAX) {
        throw new RifError(
          `Group ${group} of cluster "${label}" declares ${declared} resources, which is not a ` +
            `number a Broken Sword index carries.`,
        );
      }

      const resourcePresent: number[] = [];
      for (let i = 0; i < declared; i++) {
        resourcePresent.push(u32(`group ${group}'s resource table`));
      }

      const resources: RifResource[] = [];
      for (let index = 0; index < declared; index++) {
        // The hole case: the presence word is zero and **no** offset/length pair
        // follows. ScummVM writes 0xFFFFFFFF into its own offset array here and
        // reads nothing from the file, which is the detail a reader that skips
        // eight bytes per hole gets wrong — and it gets it wrong silently, by
        // reading the next group's counts as this group's offsets.
        if (!resourcePresent[index]) continue;
        const offset = u32(`resource ${index} of group ${group}`);
        const length = u32(`resource ${index} of group ${group}`);
        resources.push({ index, offset, length });
        resourceCount++;
      }

      groups.push({ group, declared, resources, presence: resourcePresent });
    }

    clusters.push({ cluster, label, groups, presence: groupPresent });
  }

  if (clusters.length === 0) {
    throw new RifError(
      `swordres.rif declares ${clusterCount} clusters and none of them is present. A Broken ` +
        `Sword index always has at least GENERAL and SCRIPTS.`,
    );
  }

  return { clusters, resourceCount, presence: clusterPresent };
}

/** The cluster a resource id names, zero-based. The id's top byte, less one. */
export function clusterOf(id: number): number {
  return (id >>> 24) - 1;
}

/** The group (section) a resource id names. */
export function groupOf(id: number): number {
  return (id >>> 16) & 0xff;
}

/** The index within the group a resource id names. */
export function indexOf(id: number): number {
  return id & 0xffff;
}

/** Builds a resource id from its three parts. The cluster is zero-based here. */
export function resourceId(cluster: number, group: number, index: number): number {
  return (((cluster + 1) & 0xff) << 24) | ((group & 0xff) << 16) | (index & 0xffff);
}

/** `0x01060001` — how the game's own scripts and this project's logs spell one. */
export function formatResourceId(id: number): string {
  return `0x${id.toString(16).toUpperCase().padStart(8, '0')}`;
}

/** Finds a resource's location, or null when the index has no such slot. */
export function locateResource(
  index: RifIndex,
  id: number,
): { cluster: RifCluster; resource: RifResource } | null {
  const cluster = index.clusters.find((candidate) => candidate.cluster === clusterOf(id));
  if (!cluster) return null;
  const group = cluster.groups.find((candidate) => candidate.group === groupOf(id));
  if (!group) return null;
  const resource = group.resources.find((candidate) => candidate.index === indexOf(id));
  return resource ? { cluster, resource } : null;
}

/** Every resource id the index holds, ascending. For a sweep or an export. */
export function allResourceIds(index: RifIndex): number[] {
  const ids: number[] = [];
  for (const cluster of index.clusters) {
    for (const group of cluster.groups) {
      for (const resource of group.resources) {
        ids.push(resourceId(cluster.cluster, group.group, resource.index));
      }
    }
  }
  return ids.sort((a, b) => a - b);
}

/** A one-line summary for a log: what the index holds. */
export function describeRif(index: RifIndex): string {
  const labels = index.clusters.map((cluster) => cluster.label).join(', ');
  return `${index.clusters.length} clusters (${labels}), ${index.resourceCount} resources`;
}
