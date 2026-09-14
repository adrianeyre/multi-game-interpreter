/**
 * A synthetic `sky.cpt`, built from the format.
 *
 * Built section by section from what the format says each one is — a version
 * word, a list of list lengths, a word count, the compact data, a name pool,
 * aliases, per-Version patches, save ids, and a starting state — rather than
 * from what the parser happens to accept. `verifying-version-support.md` names
 * the difference and the trap: "a fixture encodes our reading of the format. If
 * that reading is wrong, the fixture and the engine agree with each other and
 * disagree with the game."
 *
 * The escape from that trap is not this file. It is `npm run sweep:vt`, which
 * reads the shipped 419,427-byte `sky.cpt` and checks that its sections consume
 * it exactly. What this file is for is the failures that real data does not
 * contain: a truncated header, a word count that disagrees with the records, a
 * name pool that does not come out even.
 */

/** Grows as sections are appended, so no length has to be worked out twice. */
class Writer {
  private readonly bytes: number[] = [];

  u8(value: number): this {
    this.bytes.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff);
    return this;
  }

  u32(value: number): this {
    this.bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >>> 24) & 0xff);
    return this;
  }

  name(text: string): this {
    for (const character of text) this.u8(character.charCodeAt(0));
    return this.u8(0);
  }

  get length(): number {
    return this.bytes.length;
  }

  done(): Uint8Array {
    return new Uint8Array(this.bytes);
  }
}

export interface FixtureCompact {
  readonly name: string;
  /** 1 compact, 2 turn table, 3–7 the array kinds. 0 is not a type. */
  readonly type: number;
  readonly words: readonly number[];
}

export interface SkyCompactFixtureOptions {
  readonly compacts?: readonly FixtureCompact[];
  /** Slots left empty, which the format uses to keep ids stable. */
  readonly emptySlots?: number;
  readonly aliases?: readonly { readonly name: string; readonly targetId: number }[];
  readonly saveIds?: readonly number[];
  readonly resetWords?: number;
  readonly builds?: readonly {
    readonly build: number;
    readonly changes: readonly [number, number][];
  }[];
  /** Declare a word count that disagrees with the records, to exercise the check. */
  readonly declareWrongWordCount?: boolean;
  /** Leave a byte after the last section, to exercise the final check. */
  readonly trailingByte?: boolean;
  readonly fileVersion?: number;
}

/** A Compact with every named field present, plus one animation set. */
export const FIXTURE_FULL_COMPACT: FixtureCompact = {
  name: 'foster',
  type: 1,
  // 55 named fields then 14 more for one animation set.
  words: [
    ...Array.from({ length: 55 }, (_, i) => 100 + i),
    ...Array.from({ length: 14 }, (_, i) => 200 + i),
  ],
};

/** A Compact shorter than the field list, as 200-odd shipped ones are. */
export const FIXTURE_SHORT_COMPACT: FixtureCompact = {
  name: 'joey_park',
  type: 1,
  words: Array.from({ length: 29 }, (_, i) => 300 + i),
};

/** Five directions, five frames each. */
export const FIXTURE_TURN_TABLE: FixtureCompact = {
  name: 'joey_turnTable0',
  type: 2,
  words: Array.from({ length: 25 }, (_, i) => 400 + i),
};

export function buildSkyCompactFixture(options: SkyCompactFixtureOptions = {}): Uint8Array {
  const compacts = options.compacts ?? [
    FIXTURE_FULL_COMPACT,
    FIXTURE_SHORT_COMPACT,
    FIXTURE_TURN_TABLE,
  ];
  const emptySlots = options.emptySlots ?? 1;
  const aliases = options.aliases ?? [{ name: 'foster_alias', targetId: 0 }];
  const saveIds = options.saveIds ?? [0, 1, 2];
  const resetWords = options.resetWords ?? 8;
  const builds = options.builds ?? [
    { build: 348, changes: [[0, 0x1111] as [number, number]] },
    { build: 372, changes: [] },
  ];

  // The compact data and the name pool are two streams read in step, so they
  // are built together rather than reconciled afterwards.
  const source = new Writer();
  const names = new Writer();
  let words = 0;

  for (const compact of compacts) {
    source.u16(compact.words.length).u16(compact.type);
    for (const word of compact.words) source.u16(word);
    names.name(compact.name);
    words += compact.words.length;
  }
  // An empty slot is a size of zero and nothing else: no type, no name, no
  // words. It is what keeps ids stable across a record nobody needed.
  for (let i = 0; i < emptySlots; i += 1) source.u16(0);
  for (const alias of aliases) names.name(alias.name);

  const out = new Writer();
  out.u16(options.fileVersion ?? 0);
  out.u16(1);
  out.u16(compacts.length + emptySlots);
  out.u32(options.declareWrongWordCount ? words + 1 : words);

  const sourceBytes = source.done();
  out.u32(sourceBytes.length / 2);
  for (const byte of sourceBytes) out.u8(byte);

  const nameBytes = names.done();
  out.u32(nameBytes.length);
  for (const byte of nameBytes) out.u8(byte);

  out.u16(aliases.length);
  aliases.forEach((alias, i) => out.u16(0x0800 + i).u16(alias.targetId));

  // The per-Version patch list the format carries for one 1994 build, which
  // nothing here applies. Two lengths and then that many words.
  out.u16(0).u16(0);

  out.u16(saveIds.length);
  for (const id of saveIds) out.u16(id);

  out.u16(resetWords);
  for (let i = 0; i < resetWords; i += 1) out.u16(0xaaaa);

  out.u16(builds.length);
  for (const build of builds) {
    out.u16(build.build).u16(build.changes.length);
    for (const [where, what] of build.changes) out.u16(where).u16(what);
  }

  if (options.trailingByte) out.u8(0);
  return out.done();
}
