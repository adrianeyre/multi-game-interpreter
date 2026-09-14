# MGI — Multi Game Interpreter

A browser-based interpreter for classic adventure games, plus an editor for
authoring and modifying them. It ships no game data: it reads the files of a
game you own.

## Language

**Engine family**:
A wholly separate interpreter lineage — SCUMM, AGI, SCI, AGOS, Sky, Lure,
Sword1 or Sword2. Two families share no bytecode, no resource layout and no
renderer; they sit side by side in this project rather than one extending the
other.

Sword1 and Sword2 are Broken Sword and Broken Sword II, and they are the
sharpest test this definition has been put to (ADR 0036): one publisher, one
title, one naming scheme, and **no** shared bytecode, resource layout or
renderer. A family is decided by the formats and never by the box art.

AGOS is Adventure Soft's, carried from Horrorsoft's Elvira through Simon the
Sorcerer. It is the first family here that never versioned itself, which is why
a Version below is allowed to be a title.

SCI is one family and not two, despite the SCI32 break. The claim rests on
shared bytecode and on a resource layout that drifts rather than breaks — not on
the renderer, which is a separable question. One family with two renderers would
still be one family.

Sky, Lure, Sword1 and Sword2 are one game's families each and stay families
anyway — four of the eight, all from one publisher, all under one marketing
name, and no two of them sharing a format.
`.out-of-scope/` refuses three things for being "a second way to load games that
already play"; these two are the opposite case, and they are also the only games
here whose data is freely distributable, so they are the only families whose
Completable claim can be checked without somebody owning a disc (ADRs 0023,
0026). That holds fully for Lure, whose free release ships Revolution's own
executable, and only for Beneath a Steel Sky's freeware **CD** release — see the
amendment to ADR 0024.
_Avoid_: engine on its own for this (ambiguous with Engine below), platform,
SCI16/SCI32 as families (they are one family's two renderers), Virtual Theatre
as a family name (it names two of them — see below)

**Virtual Theatre**:
Revolution Software's own name for the engine behind **all four** of their
adventures, and the word for that group of families rather than for any one of
them. Useful for what Lure and Sky genuinely share — background characters
acting independently of the player, and game data compiled into the executable
(ADR 0024) — and never usable as a family name, because a family is one
interpreter lineage and this is four of them under a marketing name (ADRs 0026
and 0036).

**It was two and is now four, and the correction is worth keeping.** This entry
said "both their adventures" while Sky and Lure were the only two read here.
Wikipedia's infobox names Virtual Theatre as the engine of Broken Sword and
Broken Sword II as well — which is Revolution's own usage and not an error. What
it means is that the marketing name spans a wider range than this glossary
assumed, and that the rule below was right for a stronger reason than the one
first given: the four games share the name and share no bytecode, no resource
layout and no renderer between any two of them.

"The Virtual Theatre families" is the correct phrase. "The Virtual Theatre
family" is not.
_Avoid_: Virtual Theatre engine (there are four), VT

**Engine**:
The runtime for one Engine family that owns actors, rooms, the screen, sound and
the input loop — everything a script can ask for. `ScummEngine` is the SCUMM
family's; AGI has its own.
_Avoid_: interpreter (that is the whole project), VM

**Script engine**:
The bytecode interpreter for one instruction encoding, driving its family's
Engine. There is one per encoding rather than one per Target: SCUMM has two — the
Classic encoding across v2–v5 and the Stack encoding across v6–v8, each a shared
base with a per-Version delta — and AGI v2 and v3 share an encoding outright, so
one engine covers every Target between them. Earlier AGI releases — the DOS
booter and Apple II disk images — use a smaller, separate instruction set and are
out of scope.

Sword1 and Sword2 have one each, and the two are not a base and a delta either.
Sword1's is words all the way down — every token and every operand is 32 bits —
and Sword2's is byte opcodes with 8-, 16- and 32-bit operands. Both are
self-describing in instruction length, which is what puts both families at
Decompilation rather than Disassembly.

AGOS has two, and they are not a base and a delta — they are two languages. One
is the Subroutine bytecode a game's logic is written in, which draws nothing;
the other is the VGA script below, which is what draws. They share no opcode
numbering, no operand encoding, and not even the rule for how wide an opcode is.
So the "one per encoding" count is met by two engines in one family, which is
the first time that has happened here.

SCI has one, the PMachine encoding, across SCI0 to SCI3. That is a wider claim
over a wider range than SCUMM's, and it is deliberately falsifiable: see the
tripwire on PMachine encoding below.
_Avoid_: VM, virtual machine, script runner

**Classic encoding**:
The SCUMM instruction encoding that packs operand modes into the opcode byte,
used by v2 through v5. An instruction's length depends on its operands, so
boundaries are measured rather than derived.
_Avoid_: old encoding, v5 encoding (it is four Versions', not one's)

**Stack encoding**:
The SCUMM instruction encoding in which operands are pushed by instructions of
their own, used by v6 through v8. An instruction's length follows from its
opcode alone, which is what makes a script splittable into editable
instructions.
_Avoid_: v6 encoding, bytecode (that is any encoding's)

**PMachine encoding**:
The single SCI instruction encoding, used by every Version from SCI0 to SCI3 and
named after Sierra's own word for the VM. An instruction's length comes from the
low bit of its opcode byte, which selects 8-bit or 16-bit operands — so
boundaries are derived rather than measured, and Decompilation is available here
in a way it is not for AGI.

What varies across the family varies outside this encoding: the Kernel table,
the object layout, and a handful of SCI3 reassignments carried as a per-Version
delta. **The tripwire:** one encoding across four Versions is a stronger sharing
claim than SCUMM makes across v6–v8, and it is true of instruction _length_
rather than of semantics. If SCI3's delta grows past the size of the v6→v8
deltas, SCI3 is a second encoding and this was decided wrongly.
_Avoid_: SCI encoding (there is only one, so the family name adds nothing),
p-code, SCI3 encoding (it is a delta, until the tripwire says otherwise)

**Selector**:
The name a SCI script sends to an object to reach a method or a property, held
as an index into the game's own table of them rather than as an address. What
makes SCI object-oriented in a way neither sibling is: nothing in the bytecode
says which code will run — the object's class decides at the moment of the send.
Both a call and a field read are selector sends, which is why the one word
covers both.
_Avoid_: method, property (a Selector may resolve to either), message, symbol

**Kernel call**:
A call out of the PMachine into the interpreter itself — drawing, sound, input,
saving. Numbered rather than named, and the table those numbers index lives in
Sierra's interpreter rather than in the game from SCI1 on. So it is the one
thing a SCI game does not carry the meaning of, and therefore the reason a SCI
Target has to name a Version at all.
_Avoid_: syscall, builtin, primitive, kernel function on its own (that is one
entry; the Kernel table is the set)

**Resource layout**:
How a Published game's files are arranged — one room per `LFL` file, `LEC` disk
containers, or a single `LECF` container — and therefore what a reader walks and
a writer rebuilds. A Version fixes it, but it varies independently of the
instruction encoding: v4 and v5 share almost an encoding and share no layout.
One writer per layout, and one principle across all three — copy what was not
touched, substitute what was, rebuild the index.
_Avoid_: container (that is one layout of the three), file format

**Version**:
A major version within one Engine family — SCUMM v2–v8, AGI v2–v3, SCI0–SCI3 —
identified from the game's index rather than its file names. Always read inside a
family and always written with it: "SCUMM v6", "AGI v3". Never bare, because "v3"
names two unrelated engines.

**Sky and Lure have no Version**, and the gap is the information rather than an
omission: each is one game with one engine lineage under it. What varies is the
Release. Two families with no Version between them is a pattern rather than an
oddity, and it is what a one-game family looks like.

What a Version determines differs by family. A SCUMM Version fixes both the
instruction encoding and the resource layout. An AGI Version fixes only the
resource layout — separate `*DIR` files or one combined index, LZW volumes or
none. It does not fix the encoding, which is the Interpreter version's job.

A SCI Version is written at the granularity where decoding actually changes,
which is finer than the six names the catalogue uses. "SCI1" is not a Version:
`SCI1 early`, `SCI1 middle` and `SCI1 late` are, because the map format, the
view format and the kernel table move at those seams and not at the marketing
one. The full axis is SCI0 early/late, SCI01, SCI1 EGA-only, SCI1
early/middle/late, SCI1.1, SCI2, SCI2.1 early/middle/late, SCI3. Untidier than
the six, and the untidiness is the information.
An AGOS Version is a title, not a number: `AGOS Elvira1`, `AGOS Elvira2`,
`AGOS Waxworks`, `AGOS Simon1`, `AGOS Simon2`, `AGOS Feeble`,
`AGOS PuzzlePack`. Adventure Soft shipped no version stamp and no version line,
and the seams where decoding actually changes are the games themselves — the
opcode table, the item tree's layout and the packing of the graphics move
between titles and nowhere in between, each table a delta over the last. So the
axis is non-numeric here, and that is a fact about the engine rather than a gap
in the model. Written with the family like every other Version, and never
bare.
_Avoid_: bare "SCI1" or "SCI2.1" where a Version is meant (they name three
Versions each), a bare game title where an AGOS Version is meant

**Release**:
One packaging of a single game — Beneath a Steel Sky's demo, its floppy release
and its CD release with recorded speech; Lure of the Temptress's floppy release
and its demo. What the Sky and Lure arms of a Target carry where the other three
carry a Version, because releases of one game are not versions of an engine and
one word doing both jobs is the ambiguity the "never bare v3" rule exists to
prevent (ADRs 0023, 0026).
_Avoid_: version (that is the engine axis these two do not have), edition

**Interpreter version**:
The build of Sierra's interpreter a game shipped against — 2.089, 2.917,
3.002.149 and a dozen others. What actually determines how AGI bytecode decodes,
because the number of arguments an instruction takes is not written in the
bytecode: it comes from a table outside it, and that table changed between
builds, between platforms, and for three games between titles. Two games sharing
an AGI Version can disagree about how long an instruction is.
_Avoid_: version on its own for this (that is the major), revision, build number

**Target**:
Everything about a game that has to be known before its bytes can be read or
written — its instructions and its resources alike — held as one inseparable
value. What a Project is built for, and what selects an Engine, an instruction
encoding and an assembler.

The wording used to say _bytecode_, and that always understated it: a SCUMM
Version fixes the Resource layout as much as the encoding. SCI is what made the
gap visible, because SCI's platform changes View cels, palettes and packaging
while leaving the bytecode alone.

For SCUMM that is the Engine family and Version. For AGI it is the family, the
Interpreter version and the platform — because the AGI major says nothing about
the encoding, and platform changes both instruction lengths and, in one case, an
instruction's opcode number. A Target that leaves out any of that is not a
Target: it is a guess about how to decode.

For SCI it is the family, the Version and the platform. SCI needs less than AGI
because the tables that give a byte its meaning ship inside the game — a script
names Selectors and classes by index into the game's own `vocab.997` and
`vocab.996`, so there is no external arity table and no per-title correction
list. What a SCI Target must still carry is the Version, because the Kernel
table lives in Sierra's interpreter rather than in the game, and the platform,
because Mac and Amiga releases changed the View cel encoding and the packaging.

For AGOS it is the family, the Version, the **release kind** and the platform.
The Version is a title; the release kind is whether the release is a floppy or a
Talkie, and it is on the Target because it changes instruction lengths — Simon 1
and Simon 2 each decode two of their opcodes differently between their two
releases, so a title alone does not fix the encoding. The platform is what
changes the graphics encoding and the packaging.

That makes AGOS the second family, after AGI, whose major says almost but not
quite how its bytecode decodes. Both were found by writing down what would
falsify the simpler reading rather than by a game misbehaving.

For Sky and for Lure it is the family, the Release and the platform, and these
are the families that show the phrase "before its bytes can be read" was already
too narrow. Neither game's bytes can be read into a _world_ at all without its
object table, and that is in the executable rather than the data files — so
these Targets name a Release partly because that is what says which executable's
layout to expect (ADR 0024).

**Language is not part of a Target either.** It changes which resources a game
ships, not how any byte decodes, so it is a selection made over a loaded game
rather than a property of the Project. The apparent counterexample — SCI0's
parser vocabulary being language-specific — is not one: `vocab.000` is a
resource and arrives with the game.

AGOS is where that rule was actually tested, and it held only after something
was lifted out of it. A Simon release is _built_ per language rather than
assembled from language resources — the text sits inside `GAMEPC`, so there is
no selection to make over a loaded game — and the Hebrew release is laid out
right to left. Neither changes how a byte decodes, so neither enters the Target;
the direction becomes Text direction below, declared by the release and read by
the renderer.

A re-release across Versions is simply a different Target and therefore a
different Project. King's Quest IV shipped as AGI v3 and as SCI0; Quest for
Glory I as SCI0 EGA and a SCI1.1 VGA remake. Those are different games that
share a name, and there is no cross-Version game identity concept — the save
guards already refuse across families before they ever compare a game's id.

**Windows is not one of those platforms.** SCI1.1 and later "Windows" releases
are the same DOS-loadable data carrying an alternate hi-res or palette variant
chosen by a flag — King's Quest VI's Windows portraits are the familiar case.
That is a display option inside a supported game, and it belongs to the resource
layer rather than to the Target.

**Published game**:
The compiled files a player loads, as a release shipped them — **including its
interpreter**, where the release put part of the game there.

The wording used to say "an index and its data files", and that quietly assumed
what SCUMM, AGI and SCI all happen to do: a generic interpreter over data that
contains the whole game. Sky breaks the assumption rather than bending it.
Beneath a Steel Sky's `sky.dsk` and `sky.dnr` hold its graphics, sound, text and
bytecode, and none of its Compacts — those were compiled into the executable, so
a release without it has no world to run. Lure of the Temptress breaks it the
same way, which is what makes it a rule rather than a quirk (ADR 0024).

**AGOS is the third, and the first outside Virtual Theatre.** Adventure Soft
compiled the _font_ into the interpreter, so a folder holding `GAMEPC`, a `.GME`
archive and a speech file contains every word the game says and no way to draw
one of them (ADR 0032). Pixels rather than object records, and the same side of
the same line — which is what turns the widening above from a Revolution quirk
into a clause this project needs.
_Avoid_: real game, shipped game, ROM

**Compact**:
Sky's per-object record — position, state, animation, screen, and the pointers
to the logic that drives it. The nouns and where they are standing, where the
bytecode is only the verbs, which is why the Compact table rather than the
bytecode is what a Sky Project puts first and what its Unrecovered count is
measured over (ADR 0025).

Compacts live in the game's executable rather than in its data files, and this
project extracts them from there. Which file that is depends on the Release:
the original 1994 discs carry `SKY.EXE`, and the 2003 freeware CD carries
`sky.cpt` instead — accepted, unusually, because Revolution gave ScummVM the
game's **source code** and that file ships as part of that release rather than
as somebody's reading of a binary. The freeware floppy carries neither and
cannot supply Compacts at all.

Lure's own object table has no such split: its free release ships Revolution's
executable, so ScummVM's `lure.dat` stays refused (ADR 0024).

The word is **Sky's**. Lure's equivalent is its object table and is not called a
Compact, because the two are separate formats in separate families and one word
across both is where they would first get confused.
_Avoid_: object (that is any family's), entity, compact data on its own for the
table (a Compact is one record; the Compact table is the set), `sky.cpt` (that
is ScummVM's artefact and is not read here), Compact for Lure's records

**Project**:
The editable form of a game: JSON holding intent (objects with verb handlers,
boxes with scale ramps) rather than bytes. Tagged with the Target it builds
for.

A SCI Project holds one thing its siblings never needed: the **class graph** —
classes, their Selectors, their methods and their instances, by name. Method
bodies are instruction lists, as ADR 0005 settled for the Stack encoding. The
consequence is that a SCI assembler is a _linker_ rather than an emitter: adding
a Selector to a class relays out every instance of it and every entry in the
relocation table, and a new Selector must extend the game's own table without
renumbering the ones untouched Script resources still index by number.

A Sky or Lure Project holds its **object table** as its primary editable
content — named records with typed, named fields — and its bytecode only as a
listing. That inverts the other three: for SCUMM, AGI and SCI, changing what a
game does means changing code, and for these two most of it means changing a
field in that table. So editing either game does not depend on Decompiling it,
and the two are sequenced rather than coupled (ADR 0025).

**Script resource**:
SCI's compiled unit, and the reason bare "script" stays ambiguous. Not a list of
handlers but a whole linked object: class definitions with their Selector
tables and method dispatch, object instances, code, locals, a strings and `said`
table, and a relocation list. SCI0 and SCI1 hold the object data inline with
relocations; SCI1.1 splits it into a code and heap pair; SCI3 changes it again.
_Avoid_: script on its own (that is any family's), Logic (that is AGI's), room
script

**Clone**:
A SCI object made at runtime by copying a class, with no backing in any Script
resource. The distinction that shapes a SCI save: a static object is restored by
reloading its script and re-applying the properties that changed, while a Clone
has to be recreated whole, along with every reference into it. Get the two
confused and a save loads a world that looks right and whose actors are not the
ones the scripts hold pointers to.
_Avoid_: instance (a static object is an instance too), copy

**Source view**:
A Script resource's instructions rendered as Sierra Script, for a person to read
and edit, and parsed straight back into instructions. A projection of the
Project and never the stored form — which is the whole point, because storing
reconstructed source would put every Script resource permanently Unrecovered and
make a count with a target of zero unreadable. Degrades to the instruction list
where control flow cannot be reconstructed with certainty, rather than guessing
at an `if`.
_Avoid_: decompiled source (it is a view, not an artefact), Sierra Script on its
own for the feature (that is the language)

**Preserved bytes**:
Bytecode carried out of a Published game and back into one unchanged, because
no importer can turn it into editable steps. Byte-identical by design.
_Avoid_: raw code, original code

**Unrecovered**:
A resource that could not be Decompiled into editable structure, or that
re-emitted as different bytes than it arrived as. Held as-is and shown as
read-only. A defect with a target of zero, not an escape hatch: the count is
tracked per game and the fix is a better decompiler, never a wider fallback.

A count of zero is not on its own proof that a game decoded correctly. Where
instruction lengths come from outside the bytecode, as AGI's do, a wrong length
table misreads every boundary and then re-emits its own misreading byte for
byte — passing the check while the structure it produced is wrong. Byte-identity
establishes that nothing was lost, not that anything was understood.
_Avoid_: preserved bytes (that is deliberate and this is not), unsupported

**Disassembly**:
Reading bytecode back as a listing of instructions, to be understood but not
edited. Stops rather than guessing when an instruction's length cannot be
measured. Where the Sky and Lure encodings fall is not yet known, and the two
are answered independently, so each ships this and claims no more until its own
encoding says otherwise.

**Decompilation**:
Reconstructing bytecode into editable structure a Project can hold and an
assembler can re-emit. A stronger claim than Disassembly, and only attempted
where instruction boundaries are certain — which is not the same as the encoding
making them so. Certainty comes either from the encoding, as SCI's does from the
low bit of an opcode byte, or from an arity table that has been positively
identified and then checked by Structural agreement, as AGI's and AGOS's are.
The second route is weaker and is named rather than hidden: a family that takes
it says so.

**Structural agreement**:
The whole-game check that an arity table is the right one: every unit of
bytecode decodes to land exactly on its own end, with nothing overrunning it and
no jump arriving mid-instruction. What stands in for a derivable instruction
length where the length comes from outside the bytecode. Not a proof — a table
can be wrong in a way that happens to stay in step — but a falsifier that runs
over an entire game before any of its behaviour is implemented, and the reason
AGOS's silent-misdecode risk is smaller than AGI's.
_Avoid_: validation, sanity check, plausibility check (that is the weaker set of
tests ADR 0013 declined to rely on)

**Version probe**:
A structural test on a game's own bytes that narrows its Version — whether
`vocab.999` is present, whether scripts have a separate heap resource, how wide
a View's cel header is, where the well-known Selectors sit in `vocab.997`,
whether a game's data file is `GAMEPC` beside a `SIMON.GME` or an Amiga
release's own arrangement. What SCI and AGOS have instead of a version stamp,
and what keeps identification at `index-structure` rather than dropping to a
guess.

Preferred over a table of known releases by hash, because hashes cannot cover
fan-made games and those are the only free SCI data this project will have to
test against. A hash stays available as a tiebreaker, not as the mechanism.
_Avoid_: heuristic (it is a fact about shipped bytes, not an inference),
fingerprint, detection entry

**Completable**:
The bar for supporting a game: it can be played from its first screen to its
last, saving and resuming along the way. Weaker claims — it boots, it renders a
room — are not support.

**Talkie**:
A release with recorded speech, keeping it in an external file (`MONSTER.SOU`)
addressed by offset rather than as an indexed resource.

In AGOS this is not only a fact about which files ship: an AGOS talkie decodes
two of its opcodes differently from the same game's floppy release, so the
distinction is part of the Target under the name **release kind**. The two words
are kept apart deliberately — Talkie describes a release, release kind says
decoding depends on it.

**Logic**:
An AGI script resource, one per room plus shared ones. Holds its own message
table, so a room's text lives with the code that shows it rather than in a
central string pool.
_Avoid_: script (that is any family's), room script

**Subroutine**:
AGOS's unit of behaviour: a numbered list of instructions, called by number.
Not owned by a room and not owned by an item — the two places a sibling family
would put it — which is why behaviour has to be found through the item tree
rather than by opening a room. A game's Subroutines are split across its
`GAMEPC` and its table resources, and where one lives is a packaging fact rather
than a meaningful one.
_Avoid_: script (that is any family's), Logic (that is AGI's), handler

**VGA script**:
The second AGOS bytecode: the one that draws. Held in a game's graphics
resources rather than in `GAMEPC`, and it is what places sprites, fades
palettes, waits frames and loops animations — a game Subroutine's whole
contribution to the screen is to start one.

Named for the resources it lives in rather than for what it does, because that
is what the games call them. The reason it needs a name at all is that "AGOS
bytecode" is ambiguous in a way no other family's is: an instruction, an opcode
table and a disassembly all mean two different things here depending on which
of the two is meant, and the two disagree about how wide an opcode is.
_Avoid_: video script (nothing here is video), animation script (it does more),
bytecode on its own for either of AGOS's two

**Item tree**:
AGOS's world: one global tree of items — rooms, objects, the player, and
abstractions that are none of those — each linked to a parent and to siblings,
each carrying typed sub-structures. What AGOS has instead of SCUMM's rooms with
objects in them, and the structure an AGOS Project must hold by name for its
instructions to be readable: an instruction names item 217, and only the tree
says what that is.
_Avoid_: object (SCUMM's, and it is not a tree), inventory (that is one subtree),
room graph

**Script coordinates**:
The space a game's scripts position things in, which is not always the space the
screen displays. SCI32 decouples the two — scripts commonly still work in
320x200 while the display composites at 640x480 — so an Engine declares both and
the shell maps clicks through the first and sizes the canvas by the second. For
SCUMM and AGI the two are equal, which makes them the degenerate case rather
than the rule.
_Avoid_: resolution on its own (it is ambiguous between the two), virtual
screen (that is SCUMM's band layout)

**Text direction**:
The direction a release lays its text out in, declared by the loaded game and
read by the renderer when it places a run of glyphs. Left-to-right is the
degenerate case rather than the default-with-an-exception, which is what keeps
Hebrew Simon from becoming a branch in the drawing code or an entry in a Target.
Concerns layout only: it says nothing about which words a game holds, and a
right-to-left release is not otherwise a different game.
_Avoid_: RTL support (that is a feature name, not a property of a release),
locale, language (that is neither in a Target nor drawn)

**Plane**:
SCI's unit of compositing: a rectangle with a priority, holding screen items — a
View cel, a text bitmap — each with a priority of its own. The compositor sorts
plane, then item, then insertion order.

A Plane may also carry a **priority buffer**, the per-pixel mask SCI16 paints
from a Picture so that scenery can occlude the middle of an actor while its head
shows above. SCI32 Planes never carry one and occlude by ordering alone. The
buffer is optional _data_ on a Plane rather than a branch in the compositor,
which is what lets one compositor serve both. **The tripwire:** if its presence
starts being asked about outside the visibility test — in dirty-rect tracking,
in cel clipping, in hit-testing — it is not optional data, it is a second
renderer, and the renderer should split. The family survives that split either
way.
_Avoid_: layer, surface, sprite (a screen item may be text), z-order (that is
one of three sort keys here)

**Robot**:
Pre-rendered actor footage that SCI2 composites into a Plane as a screen item —
Phantasmagoria's protagonist is one. Not a video: it is drawn into the scene,
sorted and occluded like a View cel, rather than played at the screen the way
VMD, SEQ and DUK are. Holding it as a screen-item kind is what keeps one
compositor honest; needing a second drawing path for it is the Plane tripwire
firing.
_Avoid_: video, cutscene, FMV (those are the played formats), sprite

**Priority band**:
One of AGI's fifteen horizontal strips, baked into a Picture, that decides what
draws in front of what and what blocks walking. Does the job SCUMM splits
between z-order and walk boxes, but as a property of the picture rather than of
the room's geometry — so it is edited by editing the picture.
_Avoid_: z-order, layer, walk box (that is SCUMM's and behaves differently)

**Parser input**:
A line the player types, matched against the game's vocabulary to a verb and
noun. AGI's whole means of acting on the world, where SCUMM has a verb bar and
a sentence line built from clicks. Not a chat box: the vocabulary is fixed and
authored.

SCI0 and SCI01 are parser-driven too, and SCI1 replaced the parser with an icon
bar — but in SCI neither is an interpreter mode. The icon bar is a class the
game's own scripts build, the input window is a control the game creates, and
the parse is a Kernel call over the game's vocabulary. So SCI's input surface is
the thinnest of the three families rather than the widest: events in, nothing
else. What it does need that the others do not is a **queue** — SCI scripts poll
for the next event matching a type mask rather than being handed one.
_Avoid_: command line, sentence line (that is SCUMM's, and it is assembled not
typed)

**Device arrangement**:
One sound card's rendering of a SCI sound resource. A single resource carries
several — AdLib, MT-32, PC speaker, Amiga — and the interpreter picks one at
play time. The same split SCUMM ships as separate `ADLIB.IMS` and `ROLAND.IMS`
files, folded inside one resource, which is why a SCI sound resource must never
be modelled as having a body.
_Avoid_: track (that is one voice within an arrangement), channel, driver

**Message**:
A line of authored dialogue in SCI1.1 and later, keyed by a (noun, verb, cond,
seq) tuple. One thing with three faces — its text in the `MESSAGE` resource, its
recorded speech in the audio volumes, its mouth timing in `sync36` — all under
the same key. Held by a Project as one authored item rather than as three
parallel tables that happen to share a key.

SCI0 and SCI1 have no Messages: their text lives inline in the Script resource.
So "edit this game's words" names two different places depending on Version, and
the editor says which rather than offering one surface that works for half the
catalogue.

A release shipping several languages holds several Messages under one key, and a
Project holds **all** of them. Importing one and dropping the rest is silent data
loss, and by this project's own definitions that is Unrecovered. What editing
Messages does _not_ reach is translated wording baked into Views and Pictures,
which is a limitation to state rather than to discover.
_Avoid_: string, line (ambiguous with a line of code), text resource

**iMUSE**:
The music system in which scripts drive transitions between musical states
rather than starting and stopping fixed tracks. v6 transitions between
synthesised scores, v7 between streams of digital audio.

**Speech wait**:
A script pausing until the current line of speech finishes. Its timing comes
from the recorded audio in a Talkie release, so an interpreter that ignores
speech must still produce the same pause or the script's pacing breaks.

**SMUSH**:
The full-motion video format v7 introduced, played by the Engine rather than
decoded to a resource. Not on the version axis: nothing before v7 uses it.
_Avoid_: cutscene (a cutscene is a script state, and most SMUSH is one but not
all of it), movie, FMV

**Played video**:
SCI's side of the line SMUSH draws — SEQ at SCI1.1, VMD at SCI2, DUK at SCI3.
Played full-screen to the end or skipped, nothing a Project reconstructs, and
therefore not a resource: a played video has no number in `RESOURCE.MAP` and is
read as a file beside the Volumes. The three are containers rather than one
format, and **DUK names the codec rather than the container**: a `.duk` file is
a RIFF/AVI carrying Duck TrueMotion 1, and the `DUCK` four-character code that
appears in it is the video stream's handler inside the header list, not the
file's first bytes.
_Avoid_: cutscene, FMV, movie resource (it is not one), Robot (that is
composited, not played)

**Interactive sequence**:
A SMUSH sequence the game's scripts drive and draw over rather than play to the
end — Full Throttle's bike combat and derby. Playable, so a Completable claim
depends on it. SCI's answer is that only a Robot qualifies: it is composited
into a Plane the scripts are still changing, and SEQ, VMD and DUK are played at
the screen with the interpreter stopped behind them.

**Smacker**:
The full-motion video format The Feeble Files and the Puzzle Pack play, and the
third format in this repository on the played-at-the-screen side of the line
SMUSH and Robot draw. Played by the AGOS Engine rather than composited by the
VGA script: that machine schedules sprites, and a video is not one.

The word names what Adventure Soft shipped and never ScummVM's **DXA** re-encode
of the same videos, which this project recognises by name and does not decode —
ADR 0024's rule, that a Target reads what the publisher shipped rather than
another implementation's derivation of it. A folder of DXA files is a complete
ScummVM install rather than a mistake, so it is named rather than reported as a
fault.
_Avoid_: FMV, cutscene (that is a script state), AGOS video (there is one
format, so the family name adds nothing), DXA as a synonym for it

**Volume**:
A SCI data file holding resources end to end, addressed through `RESOURCE.MAP`
by offset rather than enumerated. Nothing in a Volume is found by walking it,
which is what makes the largest ones tractable: a SCI2 game's video and audio
Volumes run to hundreds of megabytes, and a player only ever needs the bytes at
one offset. Reading a Volume whole is a property of small games, not of the
format.
_Avoid_: archive, container (that is SCUMM's `LECF`), data file

**Bundle**:
A v7 container of digital audio addressed by offset, holding a game's speech or
its music. The successor to a Talkie's single speech file, and read the same
way: nothing to enumerate, only asked for.

**Language bundle**:
The external file holding a v7 game's displayable text, which its scripts
reference by index rather than carrying inline. Editing a v7 game's words means
editing this, not its instructions.
