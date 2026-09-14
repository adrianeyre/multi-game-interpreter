/**
 * The SCI Version axis, written against ScummVM's own `SciVersion` enum.
 *
 * #214's job. ADR 0016 claimed the seams where decoding changes are finer than
 * the catalogue's six names and listed them from memory; this file is that list
 * checked against `engines/sci/detection.h:118-133`, where ScummVM declares
 * fourteen enumerators — `SCI_VERSION_NONE` and the thirteen below, in this
 * order, with the same game lists.
 *
 * **The axis is confirmed.** ADR 0016 needed no amendment beyond recording, per
 * seam, what actually moves there — which is the part the ADR left out and the
 * part a probe has to test (ADR 0020).
 *
 * Every note below says where the evidence is. The ones that name a ScummVM
 * file and function were read; the ones marked *asserted* are this project's
 * reading of the format rather than a line somebody pointed at, and they are
 * the ones a probe should be built against real data first
 * (`docs/processes/verifying-version-support.md`).
 */

/**
 * A SCI Version: the granularity at which decoding actually changes.
 *
 * Written with the family, never bare, and never as a catalogue bucket —
 * `CONTEXT.md` is firm that `SCI1` names three of these and `SCI2.1` another
 * three. The strings are ScummVM's enumerators lower-cased and hyphenated so
 * that a Target read back from JSON is readable by a person.
 */
export type SciVersion =
  /**
   * KQ4 early, LSL2 early, the 1988 Christmas card.
   *
   * **What moves here:** `lofsa`/`lofss` operands are *absolute* offsets into
   * the script rather than relative — `GameFeatures::autoDetectLofsType`
   * (`features.cpp` ~245-345) bounds-checks the operand both ways to tell this
   * seam from SCI1 middle. `kDrawPic` takes three arguments rather than four
   * (`autoDetectGfxFunctionsType` ~350-470), and `op_callk` still reads the old
   * script header (`vm.cpp` ~620). Sound resources are a different format
   * again (`detectEarlySound`).
   */
  | 'sci0-early'
  /**
   * KQ4, LSL2, LSL3, SQ3.
   *
   * **What moves here:** the `nodePtr` selector appears, which is
   * `autoDetectSoundType`'s own test for this seam (`features.cpp` ~162), and
   * `kDrawPic` gains its fourth argument.
   */
  | 'sci0-late'
  /**
   * KQ1 and the multilingual releases (`S.old.*`).
   *
   * **What moves here:** the Kernel table grows, and `vocab.999` — the one
   * resource that names Kernel calls — is present here and gone from SCI1 on.
   * *Asserted*: the resource map is still SCI0's flat 6-byte list, so this seam
   * is invisible to the map and has to be probed in the game's own resources.
   */
  | 'sci01'
  /**
   * SCI1 with the parser still in it: Quest for Glory II and nothing else.
   *
   * **What moves here:** the resource layout is SCI1's — a type directory at
   * the front of the map — while the View format is still EGA and the parser is
   * still the input path. *Asserted*: the pair is what identifies it, since
   * neither half alone is unusual.
   */
  | 'sci1-ega-only'
  /**
   * KQ5 floppy, SQ4 floppy, the 1990 Christmas card, Fairy Tales, Jones floppy.
   *
   * **What moves here:** the map is still read with SCI0's volume-in-the-top-6
   * -bits packing — `readResourceMapSCI0` uses `bShift = 26, bMask = 0xFC`
   * below SCI1 middle (`resource.cpp` ~1345). `PseudoMouse` support is
   * inconsistent only here (`detectPseudoMouseAbility`, `features.cpp` ~790).
   */
  | 'sci1-early'
  /**
   * LSL1, Jones CD, the multilingual Amiga LSL3 and SQ3.
   *
   * **What moves here:** the volume number moves to the top *4* bits of the
   * map's offset field — `bShift = 28, bMask = 0xF0` — and `detectMapVersion`
   * tells this seam from SCI1 early by whether the 6-bit reading names a volume
   * that exists (`resource.cpp` ~855). `lofs` operands become relative
   * (`autoDetectLofsType`).
   */
  | 'sci1-middle'
  /**
   * Dr. Brain 1, EcoQuest 1, Longbow, PQ3, SQ1, LSL5, KQ5 CD.
   *
   * **What moves here:** the map's directory types are OR-ed with `0x80`, which
   * is what `detectMapVersion` uses to separate every SCI1 late map from
   * SCI32's — "Only SCI32 has directory type < 0x80". `kDoSound`'s subfunction
   * numbering changes, and late SCI1 games call `kIsObject` before it
   * (`features.cpp` ~116). `MESSAGE` resources, where present, are version 2
   * and reached by `kGetMessage` rather than `kMessage`
   * (`detectMessageFunctionType` ~475).
   */
  | 'sci1-late'
  /**
   * Dr. Brain 2, EcoQuest 1 CD, EcoQuest 2, KQ6, QFG3, SQ4 CD, XMAS 1992.
   *
   * **What moves here:** map entries shrink to **5 bytes** — a 16-bit number
   * and a 24-bit offset that is then *doubled*, because SCI1.1 volumes are
   * word-aligned (`readResourceMapSCI1`, `resource.cpp` ~1425). The Script
   * resource splits into a code and heap pair (`script.cpp`, `load()`). Views
   * are VGA. `MESSAGE` is reached by `kMessage`.
   */
  | 'sci1-1'
  /**
   * GK1, PQ4 floppy, QFG4 floppy.
   *
   * **What moves here:** a numbered `RESMAP.000` over `RESSCI.000` — one pair
   * per disc, rather than the single `RESOURCE.MAP` every earlier Version
   * ships — with entries back to 6
   * bytes with a plain 32-bit offset and **no volume nibble** — "in SCI32 it's
   * a plain offset". Volume headers are 13 bytes with 32-bit sizes
   * (`detectVolVersion` ~950). Planes and screen items replace the priority
   * buffer; Pictures become arrangements of bitmaps.
   */
  | 'sci2'
  /**
   * GK2 demo, KQ7 1.4/1.51, LSL6 hires, PQ4 CD, QFG4 CD, SQ6 early demos.
   *
   * **What moves here:** the Kernel table only — these titles keep SCI2's
   * shuffled table, and `autoDetectSci21KernelType` tells the seam by which
   * ordinal `Sound::play` uses for `kDoSound`: `0x40` is SCI2's table, `0x75`
   * the standard SCI2.1 one (`features.cpp` ~512-590).
   */
  | 'sci2-1-early'
  /**
   * GK2, Hoyle 5, KQ7 2.00b, MUMG Deluxe, Phantasmagoria, PQ:SWAT, Shivers,
   * SQ6, Torin.
   *
   * **What moves here:** the standard SCI2.1 Kernel table. *Asserted*: this is
   * the SCI2.1 the rest of the family's tooling should be written against,
   * because it is where the titles are.
   */
  | 'sci2-1-middle'
  /**
   * Demos and Macintosh releases of LSL7, Lighthouse and RAMA.
   *
   * **What moves here:** *asserted* — nothing structural this project reads.
   * ScummVM's own comment distinguishes the last three tiers "mainly by which
   * builds — full releases, demos, or Mac ports — of the same late-era titles
   * belong to each", which is a statement that the seam is not in the data. A
   * game landing between `sci2-1-middle` and here is a candidate for ADR 0020's
   * declared path rather than for a probe.
   */
  | 'sci2-1-late'
  /**
   * LSL7, Lighthouse, RAMA, Phantasmagoria 2, the interactive Lighthouse demos.
   *
   * **What moves here:** the Script resource, and not the instruction encoding
   * — see `SCI3_ENCODING_EVIDENCE` below. A 22-byte fixed header with the code,
   * string and relocation offsets as 32-bit words at 0, 4 and 8; objects
   * located arithmetically past a dword-aligned export table and locals array;
   * a 10-byte-entry relocation table; and no separate heap resource, so scripts
   * may exceed 64K (`script.cpp`, `identifyOffsets`/`getSci3ObjectsPointer`/
   * `relocateOffsetSci3`).
   */
  | 'sci3';

/**
 * Every Version, in the order ScummVM declares them.
 *
 * Order is load-bearing: `atLeast` compares by index, and a probe that narrows
 * a game to "SCI1 middle or later" is expressing exactly that comparison.
 */
export const SCI_VERSIONS: readonly SciVersion[] = [
  'sci0-early',
  'sci0-late',
  'sci01',
  'sci1-ega-only',
  'sci1-early',
  'sci1-middle',
  'sci1-late',
  'sci1-1',
  'sci2',
  'sci2-1-early',
  'sci2-1-middle',
  'sci2-1-late',
  'sci3',
];

/** "SCI1 late", "SCI1.1", "SCI2.1 middle" — how the docs and the UI write it. */
export function describeSciVersion(version: SciVersion): string {
  const names: Record<SciVersion, string> = {
    'sci0-early': 'SCI0 early',
    'sci0-late': 'SCI0 late',
    sci01: 'SCI01',
    'sci1-ega-only': 'SCI1 EGA-only',
    'sci1-early': 'SCI1 early',
    'sci1-middle': 'SCI1 middle',
    'sci1-late': 'SCI1 late',
    'sci1-1': 'SCI1.1',
    sci2: 'SCI2',
    'sci2-1-early': 'SCI2.1 early',
    'sci2-1-middle': 'SCI2.1 middle',
    'sci2-1-late': 'SCI2.1 late',
    sci3: 'SCI3',
  };
  return names[version];
}

/** True when `version` is `floor` or anything later on the axis. */
export function atLeast(version: SciVersion, floor: SciVersion): boolean {
  return SCI_VERSIONS.indexOf(version) >= SCI_VERSIONS.indexOf(floor);
}

/** True when `version` is strictly earlier than `ceiling` on the axis. */
export function before(version: SciVersion, ceiling: SciVersion): boolean {
  return SCI_VERSIONS.indexOf(version) < SCI_VERSIONS.indexOf(ceiling);
}

/**
 * Whether a Selector number's low bit is a read/write toggle rather than part
 * of the number.
 *
 * **SCI0 early's Selector numbering is doubled.** Sierra's earliest builds put
 * a read/write flag in the low bit of a Selector ID, so the ID a script sends
 * is `index * 2` — sometimes `index * 2 + 1` — into `vocab.997`. ScummVM
 * compensates by pushing every name into its table twice (`kernel.cpp`,
 * `loadSelectorNames`, with the comment "Early SCI versions used the LSB in
 * the selector ID as a read/write toggle"), and this does the same.
 *
 * **What it looked like before.** King's Quest IV 1.000.111 ships a 255-entry
 * `vocab.997` and its own game object's method dictionary names Selectors 444
 * and 446, which no 255-entry table can hold. The class dictionaries say the
 * same thing more plainly: every SCI0 class begins `species`, `superClass`,
 * `-info-`, `name`, and King's Quest IV's first class lists those four as 0, 2,
 * 4 and 46 — Sierra's indices 0, 1, 2 and 23, doubled. Read undoubled, the
 * game object answers no `play`, the boot has nothing to send to, and the
 * engine correctly reports that and stops.
 *
 * A predicate here rather than a flag threaded through the reader, for
 * `isSci16`'s reason: the Version knows, and one place should answer for it.
 */
export function selectorIdCarriesReadWriteBit(version: SciVersion): boolean {
  return version === 'sci0-early';
}

/**
 * The SCI16 half of the family: a priority buffer painted from a Picture.
 *
 * A predicate rather than a stored flag, because ADR 0015 keeps the two
 * renderers one compositor and this is the only question it asks — whether a
 * Plane carries a mask. Anything that starts asking it *outside* the visibility
 * test is the tripwire in ADR 0015 firing.
 */
export function isSci16(version: SciVersion): boolean {
  return before(version, 'sci2');
}

/**
 * How a SCI Version was established.
 *
 * The same distinction `ScummIdentification` draws and for the same reason (ADR
 * 0013): a Version arrived at by guess is safe to *play* on and not safe to
 * edit on. SCI needs it more than either sibling, because SCI stamps its
 * version nowhere at all and ADR 0020 rules out a hash table of known releases
 * as the mechanism — a hash cannot cover the fan-made games that are this
 * project's only free SCI data.
 *
 * **On the name.** #216 asked for this to be settled rather than minted
 * quietly: the concept already exists twice, as `ScummIdentification` in
 * `src/authoring/target.ts` and as `VersionIdentification` in
 * `src/engine/resource/GameDetector.ts`. This follows the first, because it is
 * the name used in the file this type has to live beside — `target.ts` holds
 * `ScummIdentification` and `InterpreterIdentification`, both prefixed by the
 * axis they identify, and a third called `VersionIdentification` there would
 * read as the general case of the other two rather than as SCI's.
 */
export type SciIdentification =
  /**
   * Read from the structure of `RESOURCE.MAP` itself.
   *
   * Separates SCI0, SCI1 early, SCI1 middle, SCI1 late, SCI1.1 and SCI32, and
   * no further — everything ScummVM's `detectMapVersion` can tell apart. The
   * finer seams are not in the map.
   */
  | 'map-structure'
  /**
   * Narrowed by a probe over the game's own resources (ADR 0020).
   *
   * What takes a game from a map-structure bucket to a Version: whether
   * `vocab.999` is present, whether a Script resource has a heap beside it,
   * which ordinal `Sound::play` uses for `kDoSound`.
   */
  | 'probe'
  /** Matched a known release. A tiebreaker only, never the mechanism. */
  | 'known-release'
  /**
   * Stated by the person doing the editing.
   *
   * Not a guess, and the distinction is ADR 0013's: a wrong guess is the
   * engine's fault and silent, a wrong declaration is the author's, made
   * deliberately against a warning, and is recorded in the Project where the
   * mistake stays visible.
   */
  | 'declared'
  /**
   * Nothing narrowed it past the bucket the map named.
   *
   * Plays; refused for editing, with the reason on screen. ADR 0020 requires
   * the count of Versions in this state to be published rather than discovered
   * in the editor.
   */
  | 'guess';

/**
 * The platforms a SCI release shipped on.
 *
 * Only `dos` is implemented, exactly as `AgiPlatform` began. The others are out
 * of scope and recorded in `.out-of-scope/sci-non-dos-releases.md`: unlike AGI,
 * no SCI platform touches the bytecode, so they are a second way to load games
 * that already play rather than a second decoder.
 *
 * **Windows is deliberately absent.** SCI1.1+ "Windows" releases are the same
 * DOS-loadable data carrying a hi-res or palette variant behind a flag, which
 * is a display option in the resource layer rather than a platform.
 */
export type SciPlatform = 'dos';

export const SCI_PLATFORMS: readonly SciPlatform[] = ['dos'];

/**
 * #214's answer to ADR 0017's three questions, kept as data so it can be cited.
 *
 * The verdict is that **the assumption holds** and SCI3 stays a per-Version
 * delta on one PMachine. Recorded here rather than only in the ADR because the
 * SCI3 issue (#229) has to be re-scoped against it, and a reader of the code
 * should be able to find out why there is no second Script engine without
 * leaving the code.
 */
export const SCI3_ENCODING_EVIDENCE = {
  /**
   * Q1 — does instruction length still come from the low bit of the opcode
   * byte for every SCI3 opcode? **Yes.**
   *
   * `readPMachineInstruction` (`engines/sci/engine/vm.cpp` ~400-470) is one
   * function for every Version, with no `getSciVersion()` in it. The operand
   * width switch keys on `extOpcode & 1` for the whole variable, property,
   * local, temp, global, param and offset group; `Script_Byte`/`Script_Word`
   * are fixed by the format table rather than by the Version. There is no
   * prefix byte and no fixed-width exception at SCI3.
   */
  lengthStillFromLowBit: true,
  /**
   * Q2 — how many opcodes change meaning between SCI2.1 and SCI3? **Two, plus
   * one semantic change.**
   *
   * `op_info` (0x26) and `op_superP` (0x27) error with "Dummy opcode 0x%x
   * called" when `getSciVersion() < SCI_VERSION_3` and are real instructions at
   * SCI3 (`vm.cpp` ~700-720). `op_super` (0x2b) additionally leaves the
   * superclass pointer in the accumulator at SCI3 only (~750).
   *
   * Against the v6→v8 delta this repo already carries: `V8_FROM_V6` in
   * `src/engine/script/v8/ScriptEngine.ts` is 118 renumbered opcodes, 24 new
   * ones, and every immediate widening from 16 bits to 32. Two reassignments is
   * not close to that, and ADR 0014 already calls v6-v8 one encoding.
   */
  opcodesChangingMeaning: 2,
  /**
   * Q3 — do any operands change kind? **One resolution changes; no operand's
   * kind does.**
   *
   * The question that hides, so it gets the long answer. `findOffset`
   * (`vm.cpp` ~472-498) switches on `detectLofsType()` and calls
   * `scr->relocateOffsetSci3(pcOffset - 2)` for SCI3, where every other Version
   * adds a base. So a `lofsa`/`lofss` operand is *resolved* through the script's
   * own 10-byte-entry relocation table at SCI3 rather than by addition.
   *
   * That is not an operand changing kind in the sense the question asks. The
   * operand is still the same width, read the same way, at the same place in
   * the instruction; what changed is what the *reader of the Script resource*
   * does with the value afterwards — and `detectLofsType` already returns four
   * different answers across SCI0 early, SCI1 middle, SCI1.1 and SCI3, so lofs
   * resolution was never a property of the encoding to begin with. ScummVM's own
   * comment on the SCI3 case is that it is "same as pre-SCI1.1, really, as
   * there is no separate heap".
   *
   * The one caveat, recorded because it is the shape of the two faults ADR 0017
   * names: ScummVM carries a note beside that case that the one-byte-argument
   * variant of `lofs` may break. So the byte-operand form of `lofsa` under SCI3
   * is the single place in the family where this project should expect to be
   * wrong, and it should be checked against real data before SCI3 is claimed.
   */
  operandsChangingKind: 0,
  /** The conclusion, so nothing has to re-derive it. */
  verdict: 'ADR 0017 confirmed: one PMachine encoding, SCI0 to SCI3',
} as const;

/**
 * How big the Kernel table work actually is — #214's last question.
 *
 * The reason a SCI Target names a Version at all is that the Kernel table lives
 * in Sierra's interpreter rather than in the game (ADR 0016), so "how much does
 * that cost per Version" decides how much of the family is affordable. The
 * answer is better than the thirteen-Version axis suggests: there are **three**
 * name tables, not thirteen, and the per-Version movement inside them is a
 * handful of slots each.
 *
 * Read off ScummVM's `engines/sci/engine/kernel_tables.h`.
 */
export const KERNEL_TABLE_SHAPE = {
  /**
   * SCI0 through SCI1.1 share one table of 139 slots, `0x00`-`0x8a`.
   *
   * SCI0's own table ends at `0x6d` (`Joystick`) — ScummVM marks the line "End
   * of kernel function table for SCI0" — and `0x6e`-`0x8a` are SCI1 and SCI1.1
   * additions. About a dozen slots are *reused* across Versions rather than
   * appended, and those are the entries that make a wrong Version produce a
   * game that runs and does the wrong things: `0x71` is `Intersections`,
   * `MoveCursor` at SCI1 late and `PalVary` at SCI1.1; `0x7c` is `GetMessage`
   * and `Message` at SCI1.1; `0x51` is `Platform` and `DoAvoider` at SCI0;
   * `0x78` is `Sort` and `StrSplit` at SCI01.
   */
  sci16: { slots: 139, sci0EndsAt: 0x6d },
  /**
   * SCI2 renumbers wholesale into 160 slots, `0x00`-`0x9f`.
   *
   * Not a delta on SCI16's — `DoSound` moves from `0x40`... to `0x40`, and
   * `FileIO` from `0x5d` to `0x7c`, with the compositor's own calls
   * (`AddScreenItem` `0x15`, `FrameOut` `0x18`, `AddPlane` `0x19`) appearing at
   * numbers SCI16 used for something else. Two slots drift *inside* SCI2:
   * `0x23` is `Graph` and `Robot` in early SCI2.1 builds carrying a SCI2
   * table, `0x2e` is `DisposeTextBitmap` and `Priority` in the same builds —
   * which is exactly the seam `sci2-1-early` exists for.
   */
  sci2: { slots: 160 },
  /**
   * SCI2.1 renumbers again into 162 slots, `0x00`-`0xa1`, many of them dummies.
   *
   * SCI3's whole Kernel delta lives here as per-slot annotations rather than as
   * a fourth table: five entries become dummies at SCI3 (`SetScroll` `0x30`,
   * `ShowMovie` `0x39`, `AvoidPath` `0x64`, `MergePoly` `0x66`, `ScrollWindow`
   * `0x4c`), two dummies become real (`MessageBox` `0x8d`, `Minimize` `0x9b`),
   * and four are SCI3's own at `0x9e`-`0xa1` (`WebConnect`, `PlayDuck`,
   * `WinExec`). Eleven slots — which is the same shape of answer as the
   * two-opcode encoding delta, and for the same reason.
   */
  sci21: { slots: 162, sci3Delta: 11 },
  /**
   * The tables are *ranges*, not points, which is what makes this affordable.
   *
   * ScummVM expresses applicability as a from/to pair of Versions per entry —
   * roughly 18 range macros over ~210 entries — so an entry that does not move
   * is written once for the whole family. A per-Version table in this project
   * should be the same shape: one table with ranged entries, not thirteen
   * tables. Twenty subfunction tables sit under it, the largest being
   * `kDoSound` at ~54 rows across four sound eras.
   */
  entriesAreRanged: true,
} as const;

/**
 * How far the set of Versions we can edit lags the set we can play.
 *
 * ADR 0013 refuses to edit on a guessed Version, and SCI stamps its version
 * nowhere — so for SCI the gap is not an edge case, it is a standing property
 * of the family. ADR 0020 says the gap must be **a published number, not a
 * surprise in the editor**, and this is the function that publishes it.
 *
 * Takes what was actually identified rather than a hardcoded list, because the
 * number is a measurement and moves whenever a probe improves. The survey in
 * `docs/processes/verifying-version-support.md` is this function run over every
 * game the project can point at.
 */
export function editableVersionGap(
  identified: ReadonlyArray<{ id: string; version: SciVersion; identification: SciIdentification }>,
): {
  playable: number;
  editable: number;
  /** The games that play and are refused for editing, with their Versions. */
  playOnly: Array<{ id: string; version: SciVersion }>;
  summary: string;
} {
  const playOnly = identified
    .filter((game) => game.identification === 'guess')
    .map((game) => ({ id: game.id, version: game.version }));

  const versionsEditable = new Set(
    identified.filter((game) => game.identification !== 'guess').map((game) => game.version),
  );
  const versionsPlayable = new Set(identified.map((game) => game.version));

  return {
    playable: versionsPlayable.size,
    editable: versionsEditable.size,
    playOnly,
    summary:
      `${identified.length - playOnly.length} of ${identified.length} games identified by probe ` +
      `and may be edited; ${playOnly.length} narrowed no further than a bucket and play but are ` +
      `refused for editing (ADR 0013). That covers ${versionsEditable.size} of the ` +
      `${versionsPlayable.size} Versions seen.`,
  };
}
