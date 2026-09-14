/**
 * Beneath a Steel Sky's world state: what a save holds, and what a new game
 * starts from.
 *
 * **These are the same structure**, and that is the finding this file is built
 * on rather than a convenience. The game's own restart path reads the starting
 * state out of `sky.cpt` and hands it to the routine that loads a saved game —
 * so "start a new game" and "restore" are one operation with two sources, and a
 * reader that got the layout wrong would fail on both.
 *
 * ## The layout, and the arithmetic that confirms it
 *
 * | Field | Size |
 * | --- | --- |
 * | Declared size, save revision, build number | 3 × 32 bits |
 * | Two sound slots | 2 × 16 bits |
 * | Music, character set, cursor, palette | 4 × 32 bits |
 * | Script variables | 838 × 32 bits |
 * | Resources to reload on restore | 60 × 32 bits |
 * | Every Compact the table lists as saveable | its own word count, in order |
 *
 * Adding that up over the shipped Compact table's 854 save ids gives **56,730
 * bytes**, and each of the seven starting states in `sky.cpt` is 56,730 bytes
 * and **declares 56,730 in its own first field**. Three independent numbers
 * agreeing is what makes this a reading rather than a fit: the layout is
 * checked by a total it does not contain, by a total it does, and by the file's
 * own section length.
 *
 * ## Why this lands before the Engine that will use it
 *
 * Because it is checkable now. Seven real state images ship in `sky.cpt`, and
 * every one round-trips byte-identically through this reader and writer — which
 * is evidence about the format, from data nobody here wrote, available without
 * a renderer or a person playing anything.
 */

import type { SkyCompacts, SkyCompactRecord } from '../resource/skyCompacts.js';

/** The game's own script variables, all 838 of them, 32 bits each. */
export const SKY_SCRIPT_VARIABLES = 838;

/** Resource numbers the game reloads when a state is restored. */
export const SKY_RELOAD_SLOTS = 60;

/** The revision every shipped starting state declares. */
export const SKY_STATE_REVISION = 6;

export class SkyWorldStateError extends Error {}

/**
 * Everything a save carries, and everything a new game starts from.
 */
export interface SkyWorldState {
  /** What the image says about itself. Checked, not trusted. */
  readonly declaredBytes: number;
  readonly revision: number;
  /** The build this state belongs to: v0.0`build`. */
  readonly build: number;
  readonly sounds: readonly [number, number];
  readonly music: number;
  readonly characterSet: number;
  readonly cursor: number;
  readonly palette: number;
  readonly variables: Uint32Array;
  readonly reload: Uint32Array;
  /**
   * Each saveable Compact's words, **in the order the save-id list gives them**.
   *
   * A list rather than a map keyed by id, and that is not a detail: the shipped
   * table's 854 save ids hold only 853 distinct ones, so one Compact is written
   * into a state twice. A map loses the first copy, and a writer built on one
   * round-trips the shipped states only because the two copies happen to be
   * equal — which is a coincidence to depend on rather than a property.
   */
  readonly compactWords: readonly Uint16Array[];
  /** The same words by id, for lookup. A repeated id resolves to its last. */
  readonly compacts: ReadonlyMap<number, Uint16Array>;
}

/** How many bytes a state is, for a given Compact table. Not a guess. */
export function skyWorldStateBytes(compacts: SkyCompacts): number {
  const fixed = 3 * 4 + 2 * 2 + 4 * 4 + SKY_SCRIPT_VARIABLES * 4 + SKY_RELOAD_SLOTS * 4;
  let compactWords = 0;
  for (const id of compacts.saveIds) compactWords += requireRecord(compacts, id).words.length;
  return fixed + compactWords * 2;
}

function requireRecord(compacts: SkyCompacts, id: number): SkyCompactRecord {
  const record = compacts.records.find((candidate) => candidate.id === id);
  if (!record) {
    throw new SkyWorldStateError(
      `The Compact table lists ${id.toString(16)} as saveable and holds no such record, so ` +
        `a state's length cannot be worked out. The table and its own save list disagree.`,
    );
  }
  return record;
}

/**
 * Reads a state image, or refuses.
 *
 * Refuses rather than half-applying, which is `AdventureEngine`'s own rule and
 * matters more here than anywhere: this structure *is* the world, so a state
 * read half way is a game where some objects are where the save left them and
 * the rest are where a different save left them. The length is checked before
 * a single field is applied.
 */
export function parseSkyWorldState(bytes: Uint8Array, compacts: SkyCompacts): SkyWorldState {
  const expected = skyWorldStateBytes(compacts);
  if (bytes.length !== expected) {
    throw new SkyWorldStateError(
      `This world state is ${bytes.length} bytes and this game's Compact table needs ` +
        `${expected}. The two must agree exactly: a state of the wrong length belongs to a ` +
        `different release, and applying it would put objects where another game left them.`,
    );
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 0;
  const u32 = (): number => {
    const value = view.getUint32(at, true);
    at += 4;
    return value;
  };
  const u16 = (): number => {
    const value = view.getUint16(at, true);
    at += 2;
    return value;
  };

  const declaredBytes = u32();
  if (declaredBytes !== bytes.length) {
    throw new SkyWorldStateError(
      `This world state declares ${declaredBytes} bytes and is ${bytes.length}. It says its ` +
        `own size in its first field, so the two disagreeing means it is truncated.`,
    );
  }

  const revision = u32();
  const build = u32();
  const sounds: [number, number] = [u16(), u16()];
  const music = u32();
  const characterSet = u32();
  const cursor = u32();
  const palette = u32();

  const variables = new Uint32Array(SKY_SCRIPT_VARIABLES);
  for (let i = 0; i < SKY_SCRIPT_VARIABLES; i += 1) variables[i] = u32();

  const reload = new Uint32Array(SKY_RELOAD_SLOTS);
  for (let i = 0; i < SKY_RELOAD_SLOTS; i += 1) reload[i] = u32();

  const ordered: Uint16Array[] = [];
  const state = new Map<number, Uint16Array>();
  for (const id of compacts.saveIds) {
    const record = requireRecord(compacts, id);
    const words = new Uint16Array(record.words.length);
    for (let i = 0; i < words.length; i += 1) words[i] = u16();
    ordered.push(words);
    state.set(id, words);
  }

  return {
    declaredBytes,
    revision,
    build,
    sounds,
    music,
    characterSet,
    cursor,
    palette,
    variables,
    reload,
    compactWords: ordered,
    compacts: state,
  };
}

/**
 * Writes a state image back.
 *
 * Byte-identical for anything read and not changed, which is the property that
 * makes it checkable: the seven starting states in `sky.cpt` go through this
 * and come out as the bytes they went in as.
 *
 * The size field is written from the actual length rather than carried, because
 * it is the one field that is derived: carrying a stale one would produce a
 * state that refuses itself on the next read.
 */
export function writeSkyWorldState(state: SkyWorldState, compacts: SkyCompacts): Uint8Array {
  const bytes = new Uint8Array(skyWorldStateBytes(compacts));
  const view = new DataView(bytes.buffer);
  let at = 0;
  const u32 = (value: number): void => {
    view.setUint32(at, value >>> 0, true);
    at += 4;
  };
  const u16 = (value: number): void => {
    view.setUint16(at, value & 0xffff, true);
    at += 2;
  };

  u32(bytes.length);
  u32(state.revision);
  u32(state.build);
  u16(state.sounds[0]);
  u16(state.sounds[1]);
  u32(state.music);
  u32(state.characterSet);
  u32(state.cursor);
  u32(state.palette);

  for (let i = 0; i < SKY_SCRIPT_VARIABLES; i += 1) u32(state.variables[i] ?? 0);
  for (let i = 0; i < SKY_RELOAD_SLOTS; i += 1) u32(state.reload[i] ?? 0);

  compacts.saveIds.forEach((id, position) => {
    const record = requireRecord(compacts, id);
    // By position rather than by id, so the Compact the save list names twice
    // is written twice from the two copies it was read into.
    const words = state.compactWords[position];
    if (!words) {
      throw new SkyWorldStateError(
        `This state holds nothing at position ${position} of the save list, where Compact ` +
          `${id.toString(16)} belongs. Writing a zero for it would silently move an object.`,
      );
    }
    if (words.length !== record.words.length) {
      throw new SkyWorldStateError(
        `Compact ${record.name} is ${record.words.length} words and this state holds ` +
          `${words.length} for it. A state's shape follows the table's, not the other way.`,
      );
    }
    for (const word of words) u16(word);
  });

  return bytes;
}

/**
 * Whether a state may be applied to a game, with the reason when it may not.
 *
 * The build check is the game's own: a state from a different build has its
 * variables in the same places but means different things by some of them, and
 * the three CD builds are interchangeable while the floppy ones are not. That
 * is a rule about *releases* rather than about file formats, which is why it is
 * here and not in the parser.
 */
export function describeSkyStateRefusal(state: SkyWorldState, build: number): string | null {
  if (state.revision > SKY_STATE_REVISION) {
    return (
      `This saved game is revision ${state.revision} and this interpreter reads up to ` +
      `${SKY_STATE_REVISION}. It was written by something newer.`
    );
  }
  if (state.build === build) return null;

  // The three CD builds share a layout, which is why the shipped starting
  // states for 365, 368 and 372 all declare 368.
  const cd = (candidate: number): boolean => candidate >= 365;
  if (cd(state.build) && cd(build)) return null;

  return (
    `This saved game was written by Beneath a Steel Sky v0.0${state.build} and this is ` +
    `v0.0${build}. Refused rather than half-applied: the variables land in the same places ` +
    `and some of them mean different things, so the game would keep playing and be wrong.`
  );
}
