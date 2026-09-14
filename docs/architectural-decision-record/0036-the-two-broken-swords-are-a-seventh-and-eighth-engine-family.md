# 0036 — The two Broken Swords are a seventh and an eighth Engine family

## Status

Accepted.

## Context

`docs/scummvm-parity-roadmap.md` ends with a queue of ten famous bespoke
engines and a recommendation: `sword1` first, `sword2` third. The reasons it
gives are that Revolution Software is "the one publisher whose engines this
project has already read twice", that Broken Sword's `swordres.rif` cluster
index "is self-describing so no support file is needed", and that it is
"plainly a game somebody would name".

That map was explicit that it was not a decision: "**Nothing here is a
decision.** Decisions live in `architectural-decision-record/`, and no decision
has been taken to add a seventh Engine family." This is that decision, and it
takes two families rather than one.

Three questions had to be answered before any code.

### 1. Are these one family or two?

The titles say one. `CONTEXT.md` says a family is "a wholly separate
interpreter lineage" and that two families "share no bytecode, no resource
layout and no renderer". So the question is answerable by reading the formats,
and the answer is unambiguous — they share none of the three:

|                      | Sword1                                                     | Sword2                                                                             |
| -------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Instruction encoding | 32-bit words throughout; every operand is a word           | Byte opcodes with 8-, 16- and 32-bit operands                                      |
| Machine-code calls   | 100 mcodes                                                 | 118 opcodes, differently numbered and differently named                            |
| Index                | One nested cluster/group/resource tree in `swordres.rif`   | `resource.inf` and `resource.tab`, flat, with each cluster's index in its own tail |
| Object               | One 3,085-word compact of fixed layout                     | A header, a hub, a variable block and eight typed structures                       |
| Room                 | A table in the interpreter naming separate layer resources | One `SCREEN_FILE` resource holding nine things                                     |
| Cycle                | Walk 150 sections and skip the dead ones                   | Walk a `RUN_LIST` of the objects that are alive                                    |
| Sprite compression   | RLE7, RLE0, "Tony", HIF                                    | RLE256, RLE16                                                                      |
| Display              | 640x400 of script space inside a 640x480 display           | 640x480 with no inset                                                              |

This is a **wider** gap than the one ADR 0026 found between Sky and Lure, which
that ADR already judged sufficient for two families. Treating the Broken Swords
as one family with two Releases would mean one `Target` arm whose Release
decided the bytecode, which is precisely the conflation `CONTEXT.md`'s "never a
bare v3" rule exists to prevent.

### 2. Does either need something its publisher never shipped?

No, and this is the reason the roadmap put `sword1` first. ADR 0033 refuses a
directory that exists only in a support file, which blocks Queen, Dráscula and
Kyra and which stopped Lure's bytecode. Neither Broken Sword is in that
position:

- Sword1's `swordres.rif` holds, for every resource, its cluster, its offset
  and its length. Nothing is reconstructed.
- Sword2's `resource.inf`, `resource.tab` and `cd.inf` are all files the game
  ships, and each cluster carries its own index in its tail.

What _is_ interpreter knowledge — and therefore ours, on ADR 0029's rule — is
the mapping from a section to its resources, the room table, the opcode names,
the inventory table and the sound-effect table. Those are generated from
ScummVM by `npm run gen:sword1-tables` and `npm run gen:sword2-tables`, which is
the fourth and fifth generator of that kind here.

Sword2 is the better case still: its **globals come out of the game**. Resource
1 is a `GLOBAL_VAR_FILE` and the variable block inside it is the globals, so
this project carries no table of them at all — where Sword1 needs 1,179 names
generated, Sword2 needs none.

### 3. Can the claim be checked?

Only partly, and this is the cost. Neither game is freeware, so CI cannot meet a
real install the way `npm run sweep:vt` does for Sky and Lure. The roadmap
predicted exactly this: "Most famous engines are not freeware, so most of the
queue below rests on a fixture and says so."

So both families are **Tier 1** on
`docs/processes/verifying-version-support.md`'s scale, with `tests/fixtureSword.ts`
building both installs from the formats, and `npm run sweep:sword` as the Tier 2
route for somebody who owns the data.

## Decision

**Broken Sword is a seventh Engine family, `sword1`, and Broken Sword II is an
eighth, `sword2`.** Each carries a **Release** rather than a Version, for ADR
0023's reason: one game, one engine lineage, and what varies is the packaging.

Four consequences follow, and each is a decision in its own right.

### Both arms carry an `identification`, unlike Sky's and Lure's

ADR 0023 gave Sky's Target arm no `identification` field on the ground that "the
Release is not a decoding decision in the way a Version is". For Broken Sword it
**is** one: the demo ships a different number of script variables from the
retail release and renumbers its sound samples, so decoding depends on which
Release a folder holds. ADR 0013's rule then applies — a Release arrived at by
guess plays and does not edit — which is why `fallback` is a value both arms can
carry.

### The two families share exactly one module, and it is a pure decoder

`swordAudio.ts` reads RIFF/WAVE and expands the 16-bit speech RLE, and both
families use it. That is not a crack in the separation: the _audio format_ is
genuinely the same, and sharing it at the level of a decoder with no engine
state is the same standing on which every family here shares `Palette` and
`Screen`. Nothing else crosses between them — not a record type, not an edit
function, not an editor class.

### Their project sections are separate, and so are their editors

ADR 0026 forbade Sky and Lure a shared project shape on the ground that "a
shared record type is the first place a Steel Sky object and a Temptress hotspot
get confused for one". The same rule applies here with more force, because these
two families' records have _no field in common_: `Project.sword1` and
`Project.sword2` are separate sections, `Sword1Editor` and `Sword2Editor` are
separate classes, and `sword1/edits.ts` and `sword2/edits.ts` are separate
modules.

### Export stays refused, and the refusal names the route

`projectToGame.ts` refuses both by naming what an export would actually be — a
cluster rewrite, and _not the same_ cluster rewrite for the two of them. That is
a missing writer rather than a wall: both families' scripts, objects and text
round-trip byte-identically, so the edits themselves are checked.

## Consequences

**`AdventureEngine` gains no member**, for the seventh and eighth time. Sword1
is the first family here whose display is not 320x200 — it is 640x480 with the
game area inset by forty pixels — and it still fits, because ADR 0015 had
already widened `resolution` into a script/display pair for SCI32's sake. A
member added for one family two years earlier is what absorbed this one.

**Both engines walk, and both play their cutscenes.** Sword1 implements both of
Revolution's walk animators — slidy for a walk with a specified end direction,
solid for a plain click — and Sword2 has its own router over its own walk-grid
format, where the grid is a list scripts add to and the frame layout is derived
from the mega's walk data rather than hardcoded. Cutscenes play through the
Smacker reader AGOS already had, which is a _codec_ shared across families in
the same way `Palette` and `Screen` are.

What neither has is an exporter. Both engines say so, on their own status lines
and in `released-games.md`, rather than in a footnote.

**`engineSignatures.ts` loses two entries and one of them was wrong.** Broken
Sword II was matched on `general.clu`, a file _both_ games ship — so a folder
holding either game matched the Sword2 signature, and a folder holding both
matched whichever entry came first. `looksLikeSword2` keys on the two index
files instead, which is evidence only that game has.

**The roadmap's queue shortens by two and its recommendation stands.** `cine`
is next by that map's own ordering, and nothing here changes it.

## Alternatives considered

**One family with a Version axis.** Rejected on the table in the Context above:
a Version fixes an instruction encoding, and calling these two Versions of one
family would mean a Version that also fixes the index format, the object shape,
the cycle and the renderer. That is a family boundary wearing a Version's name.

**Refusing Sword2 until its router is written.** Rejected on the bar every
family here has cleared: AGOS joined without drawing, Sky joined stopping at an
unimplemented mcode, and Lure joined running no scripts at all. "The bar for
leaving the foreign-engine table is having an interpreter, not having a finished
one." An engine that reads, runs, draws, edits and saves and does not walk is
well past it — and saying so is better than a dead end.

**Writing a second Smacker reader for these two families.** Rejected: the
format is Smacker's, not Adventure Soft's, so `src/engine/agos/video/smacker.ts`
is shared the way `Palette` and `Screen` are. Sharing a _codec_ is not sharing
an engine, and a second reader would be the duplication ADR 0011 warns about
rather than the separation it asks for.

**Sharing one router between the two families.** Rejected, although the
_algorithm_ is the same — Revolution carried their polygon router forward, so
`scan`, `newCheck` and `lineCheck` are recognisably one piece of geometry. What
each router touches is wholly different: Sword1 reads one floor object's grid
resource and has George's frame numbers in it; Sword2 concatenates a list of
grids scripts maintain and derives every frame base from the mega's own walk
data. A shared class would be one object with two loaders and a flag, which is
the shape this project avoids — and `CONTEXT.md`'s family test is about formats,
not about algorithms.

## Amendment: "exactly one module" is now four, and the export is no longer refused

Two sections above were true when they were written and are not now. Both are
left standing rather than rewritten, because what changed is worth seeing.

### The crossings are four, and every one is a codec or a widget

"The two families share exactly one module, and it is a pure decoder" named
`swordAudio.ts`. Three more have joined it, and the line this ADR was drawing
holds for all four — none of them is a record type, an edit function, or a
thing that knows which family it is looking at:

- `src/engine/sword1/gfx/swordEncode.ts` exports `compressTony` and
  `pushLiterals`, which `sword2/gfx/sword2Encode.ts` imports. Revolution carried
  the Tony compressor across, so this is one codec with two callers rather than
  one format with two readings — the same standing as the Smacker reader below.
- `src/editor/swordPictureView.ts` and `src/editor/swordAudioPane.ts` are
  _widgets_. A picture picker and an audio list are the same interaction in both
  games, and ADR 0013 asks a non-SCUMM surface to be as good as the SCUMM one
  rather than to be built twice. Each takes the family's own records as its
  input and holds none of its own.

So the rule is sharper than "one module", and is what it always meant: **a
widget or a codec may cross; a record may not.** `Project.sword1` and
`Project.sword2` are still separate sections with no field in common.

Two modules that look like further crossings are not.
`src/engine/resource/singleByteText.ts` and
`src/engine/resource/overlaySource.ts` sit beside `DataSource.ts` and `zip.ts`
because they are neither family's: the first builds a byte-to-code-point table
by asking a `TextDecoder` what it decodes, which is the only way to write
windows-1252 back out correctly; the second puts a set of in-memory files in
front of another `DataSource`, which is what Play needs to run an export it is
not writing to disc, and which knows nothing about clusters. Shared
infrastructure is not a crossing.

AGOS keeps its own `agos/previewSource.ts` and that is the distinction drawn
exactly: an AGOS preview has to advertise a talkie's speech names or the
detector reads the wrong release, which is family knowledge. An overlay has
none.

### The export is written, and it was never run

"Export stays refused, and the refusal names the route" ended: "That is a
missing writer rather than a wall." The writers existed by then and had simply
never been run against a game, which is a worse state than missing — a refusal
is honest and an untested writer is not.

`npm run reexport:sword -- <folder>` is the check that closes it: it re-exports
an install through the editor's own path, diffs every file it wrote against the
file it read, then makes one script edit and boots the result. Against the two
demos every file comes back byte-identical — seven of seven for Sword1, five of
five for Sword2 — and both edited exports boot to the room their originals boot
to.

It found nine faults between the two families that no fixture had, of which the
two worth recording here are the ones this ADR's own separation predicted:
Sword2 identified a cluster by its position among the files present rather than
by its line in `resource.inf`, and Sword1 refused every install there is because
`swordres.rif` names both discs' clusters whichever disc it was read from. Each
family's index is its own, and each was wrong in its own way.

`projectToGame.ts` still refuses both, and that refusal is correct: it is the
SCUMM v5 builder, and a Broken Sword export is a cluster rewrite it does not
emit. What changed is only that the route it names now exists and is measured.
