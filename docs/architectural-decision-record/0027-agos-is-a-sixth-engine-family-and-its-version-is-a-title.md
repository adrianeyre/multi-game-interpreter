# AGOS is a sixth Engine family, one family across AGOS 1 and 2, and its Version is a title

Simon the Sorcerer runs on AGOS — Adventure Soft's engine, carried from
Horrorsoft's Elvira through to The Feeble Files, and named AGOS by ScummVM
rather than by Adventure Soft. It shares nothing with SCUMM, AGI or SCI: its own
bytecode, its own packaging, its own renderer. So it is a fourth Engine family,
and it lands in this repository for the reasons ADR 0011 settled for the second
and ADR 0015 for the third — one deploy, one issue tracker, no
published-package seam between a shell and the engines that share a screen.

Simon was already in this repo as a _foreign_ engine
(`src/engine/resource/engineSignatures.ts`, matching `gamepc` / `simon.gme`).
AGI left that table when it gained an interpreter (#125) and SCI when it gained
one (#216); AGOS leaves it the same way and for the same reason, which is a
structural change rather than a string edit.

## Scope is the whole catalogue

Every game the engine shipped, all of them playable and all of them editable:

- **Elvira: Mistress of the Dark** (1990)
- **Elvira II: The Jaws of Cerberus** (1991)
- **Waxworks** (1992)
- **Simon the Sorcerer** (1993)
- **Simon the Sorcerer II: The Lion, the Wizard and the Wardrobe** (1995)
- **The Feeble Files** (1997)
- **Simon the Sorcerer's Puzzle Pack** (1998–2001) — Swampy Adventures,
  NoPatience, Jumble, Demon in my Pocket

**Simon the Sorcerer 3D is not in this** and never will be. It shares a name and
a protagonist with the catalogue above and nothing else: a hardware-accelerated
3D engine that ScummVM does not implement either. It is out of scope
permanently rather than provisionally, and belongs in `.out-of-scope/`.

## One family, not two, and this time the renderer is the hard part

The obvious reading says two. Elvira through Simon 2 is **AGOS 1**: 320x200,
graphics in loose numbered files or a packed archive, a verb list drawn by the
interpreter. The Feeble Files and the Puzzle Pack are **AGOS 2**: 640x480, a
different packaging, full-motion video, and an interface that is not a verb bar
at all. That is SCI's SCI16/SCI32 split with the serial numbers filed off, and
ADR 0015 already worked out how to answer it.

Its test is `CONTEXT.md`'s: two families "share no bytecode, no resource layout
and no renderer". AGOS 2 fails the first two.

**The bytecode continues rather than restarts.** Every game in the list sets up
an opcode table that is a delta over the previous game's, which is why ScummVM
models all seven as subclasses of one engine rather than as two engines. The
Feeble Files' table is further from Simon 2's than Simon 2's is from Simon 1's,
and it is recognisably the same table.

**The packaging drifts rather than breaks.** Loose numbered graphics files, then
a packed archive addressed by an offset table, then a wider archive — each step
is the previous one moved, and a reader that walks one is recognisably the
reader that walks the next. The item tree, the subroutine table and the pooled
strings sit in `GAMEPC` throughout.

**The renderer differs, and this ADR deliberately does not rest on it** — the
correction ADR 0015 had to make about SCI, applied first time here. One family
with two renderers is still one family. If 640x480 compositing and full-motion
video want a separate drawing path from the 320x200 band layout, they should
have one, and finding that split later does not reopen this decision.

Rejected: **AGOS 1 and AGOS 2 as two families.** It would be defensible on the
renderer alone and indefensible on the other two tests, and it would duplicate
an opcode table that is genuinely continuous — the exact mistake ADR 0015 talks
a future reader out of making about SCI32.

## The Version axis is non-numeric, and that is a fact about the engine

`CONTEXT.md` defined a Version as "a major version within one Engine family —
SCUMM v2–v8, AGI v2–v3, SCI0–SCI3". Adventure Soft shipped no such number: no
version stamp, no version line, and no interpreter build to probe in the way
AGI's `agidata.ovl` can be read. What AGOS has instead is a game-type split,
which is how ScummVM models it too — the opcode table is set up per game
(`AGOSEngine_Simon1`, `AGOSEngine_Simon2`, `AGOSEngine_Feeble`, and the rest).

So **the game is the Version**: `AGOS Elvira1`, `AGOS Elvira2`, `AGOS Waxworks`,
`AGOS Simon1`, `AGOS Simon2`, `AGOS Feeble`, `AGOS PuzzlePack` — written with
the family like every other Version and never bare. The seams where decoding
actually changes — the opcode table, the item tree's layout, the packing of the
graphics — fall between titles and nowhere in between, which is exactly the job
a Version is asked to do. Each table being a delta over the last is the shape
SCUMM's Classic encoding already has across v2–v5 (ADR 0014), so the model
needs widening rather than replacing.

The Puzzle Pack is four games under one Version, because they ship as one
release built on one table. If that turns out to be false when the data is read,
it splits into four Versions and nothing else changes.

Rejected: **AGOS 1 versus AGOS 2 as the axis.** It matches how the engine
evolved, and it would put Simon 1 and Simon 2 inside one Version while their
opcode tables differ — the one thing a Version must not do.

Rejected: **no Version for this family, with the Target naming a release
outright.** Honest about AGOS never versioning itself, but it breaks the
cross-family sentence that a Target always names a Version, and leaves nothing
for a per-Version delta to hang off.

Rejected: **the interpreter build, as AGI has.** Faithful in principle. AGOS
games shipped as bundled executables with no stamp and no shipped arity table,
so it is unidentifiable in practice — a Target nobody can fill in.

## Amendment: the family needs two Script engines, not one

Recorded after the graphics resources were read, because it changes what this
ADR's "one family" claim commits the project to.

`CONTEXT.md` defines a **Script engine** as one per instruction encoding, and
AGOS has **two encodings**. The Subroutine bytecode in `GAMEPC` holds the game's
logic and draws nothing. A second language — the **VGA script**, held in the
graphics resources — is what places sprites, fades palettes, waits frames and
loops animations; a Subroutine's entire contribution to the screen is to start
one.

They share no opcode numbering, no operand encoding, and not the rule for how
wide an opcode is: the Subroutine bytecode reads a 16-bit opcode only in
Elvira 1, while a VGA script reads one in every Version **except** Simon 2, The
Feeble Files and the Puzzle Pack. The two rules are near-opposites, so a reader
that borrows the wrong one is wrong for exactly the Versions where the other is
right.

This does not disturb the one-family decision — a family is a lineage, not a
count of its languages — but it does mean "AGOS is understood when its bytecode
round-trips" was an understatement of the work, and the renderer is a second
interpreter rather than a decoder and a blit. Written down here so the next
reader meets it before the estimate does.

## Consequences

`CONTEXT.md`'s Version entry gains a third answer to "what a Version
determines", and the admission that the axis need not be numeric. That is the
entry's fourth widening and the first to change its _kind_ rather than its
contents.

**Seven Versions is the largest catalogue any family has arrived with here**,
and they are not equally close together. Simon 1 and Simon 2 are near-neighbours;
Elvira 1 and The Feeble Files are the two ends of a decade. Work is therefore
sequenced by Version with evidence per Version (ADR 0029), and "AGOS is
supported" is never a single claim.

**The interface is not one interface.** Elvira and Waxworks are menu-driven and
first-person; Simon 1 and 2 use a verb list and an inventory grid in a bottom
band; The Feeble Files uses neither. ADR 0011 kept input out of the shared host
seam precisely so a family could do this, so each is an input surface within the
AGOS Engine rather than a branch in the shell. The band layout ADR 0007 left
behind covers the Simon shape without a family branch; the other two shapes are
new work inside the family.

Sound reuses what is already device-level: the OPL2 core, the AdLib driver and
the MIDI sequencer in `src/engine/sound/` are chip- and format-level rather than
SCUMM-level, so AGOS parses its own music out of its own packaging and plays it
through them — the shape `src/engine/agi/sound/` already has. Amiga module
playback and the AGOS 2 video formats are new work with no sibling to borrow
from.

**The tripwire.** If two releases of the _same_ game turn out to disagree about
an opcode's length, then the title is not the Version on its own — the Target
would have to carry which release it is, as AGI's carries the interpreter build.

## Amendment: the tripwire fired, and the Version survived it

It fired immediately, before any of this was built, on the reference rather than
on data: **Simon 1's floppy and talkie releases decode two opcodes differently.**
Opcode 67 is `BT` on floppy and `BTS` in the talkie, and opcode 162 is `BBT`
against `BBTS` — the talkie carries a speech id the floppy has no room for.
Simon 2 differs in the same two places. Those two entries out of 256 are the
entire disagreement, which is what makes it easy to miss and total when missed:
every instruction after the first opcode 67 in a Subroutine is read at the wrong
offset.

So a **release kind** — floppy or talkie — joins the Target (ADR 0028). What
this ADR decided is unchanged and is worth separating from what it got wrong:

- **Unchanged:** the Version is a title, non-numeric, one per game. Nothing
  about Simon 1 and Simon 2 collapsed into one Version, and nothing about the
  family split in two.
- **Corrected:** a Target is not the family, the Version and the platform. It is
  the family, the Version, the **release kind** and the platform, because the
  title alone does not fix the instruction encoding.

That makes AGOS the second family whose major says _almost_ how its bytecode
decodes — AGI is the first, and the rest of its Target comes from the
interpreter build. The shape recurring twice is worth noticing: `CONTEXT.md`'s
Target entry says a Target that leaves anything out "is not a Target: it is a
guess about how to decode", and this is the second time the missing piece was
found by writing the tripwire down rather than by a game misbehaving.

**The tripwire that remains.** If two releases of one game and one release kind
disagree — a Simon 1 floppy against another Simon 1 floppy — then the release
kind is not enough either, and the axis drops to the release. The whole-game
sweep in ADR 0029 is what would find it, and it is worth running against every
release that can be obtained rather than one per Version.

## Second amendment: the remaining tripwire was tested, and did not fire

The paragraph above asked for the whole-game sweep to be run "against every
release that can be obtained rather than one per Version". It has been (#291).
This records what happened, because a tripwire nobody ever tests is a comfort
rather than a check.

### What could be obtained

No AGOS game data lives in this repository and none ever will
(`docs/processes/verifying-version-support.md`). What is freely redistributable
is the **demos**, which Adventure Soft gave away and ScummVM collects. All
seventeen were fetched with `npm run fetch:agos` and swept. Eight carry a
runtime database this project can read:

| Release                                                  | Version  | Release kind | Subroutines | Instructions |
| -------------------------------------------------------- | -------- | ------------ | ----------: | -----------: |
| Elvira 1, DOS demo (`DEMO`)                              | Elvira1  | floppy       |           6 |           44 |
| Waxworks, DOS demo (`DEMO`)                              | Waxworks | floppy       |           5 |          376 |
| Simon 1, DOS floppy demo (`GDEMO`)                       | Simon1   | **floppy**   |          68 |        1,334 |
| Simon 1, DOS CD demo (`gamepc`)                          | Simon1   | **talkie**   |          74 |        1,697 |
| Simon 1, DOS CD alternative demo (`GAMEPC`)              | Simon1   | **talkie**   |          74 |        1,697 |
| Simon 2, DOS CD demo, English (`GSPTR30`)                | Simon2   | talkie       |         102 |        2,867 |
| Simon 2, DOS CD demo, German (`GSPTR30`)                 | Simon2   | talkie       |         102 |        2,873 |
| Simon 2, DOS CD non-interactive demo, German (`GSPTR30`) | Simon2   | talkie       |         103 |        2,978 |

**Structural agreement: nothing disagreed, in any of the eight.**

### Why that is an answer and not a shrug

The tripwire needed _two releases of one game and one release kind_. There are
two such pairs here, and both are the awkward kind rather than the easy one:

- **Simon 1 talkie against Simon 1 talkie** — the CD demo and the "alternative"
  CD demo, two separate builds Adventure Soft shipped, decoding to the same 74
  Subroutines and 1,697 instructions under one table.
- **Simon 2 talkie against Simon 2 talkie, three ways** — English, German, and a
  German non-interactive build with a Subroutine the others do not have. Three
  different `GSPTR30` files, three different games' worth of text, one table.

The German pair is the stronger evidence of the two, because ADR 0028 argued
that language changes no byte's meaning and put it outside the Target on that
basis. Here a German build and an English build of one game decode identically
under one table, which is that argument holding up against data rather than
against reasoning.

**And the first half of the tripwire is re-confirmed rather than assumed.**
Simon 1's floppy demo and its CD demos are in the table above under _different_
release kinds, and each reads whole only under its own — which is the fired half
of this tripwire, reproduced against real releases instead of against the
fixture that first found it.

### What this does not establish

**These are demos, not retail releases.** A demo is a genuine build with a
genuine `GAMEPC`, but it is a subset: 68 Subroutines against a retail Simon 1's
several hundred. An opcode no demo reaches is an opcode this sweep says nothing
about.

**Elvira 2 and the Puzzle Pack were not swept at all**, because no demo of
either exists anywhere. Two of seven Versions therefore rest on the fixture and
on ScummVM's tables, exactly as before.

**The Feeble Files was not swept either**, and for a more interesting reason:
its demos ship no game data. Both are reels of Smacker video played by RAD's own
`SMACKDOS.EXE` — 71 `.smk` files and no `GAME22`. That is a fact about the demos
rather than about the game, and it is why the AGOS 2 evidence in this repository
is about video rather than about bytecode.

### The recommendation

**Do not reopen this ADR. The Version axis stands**, now on evidence rather than
on argument, for the five Versions a demo exists for. The tripwire stays armed
for the two that have none and for the retail releases nobody here can obtain —
and `npm run fetch:agos` plus `npm run sweep:agos` is now the two-command way for
somebody with a disc to test it in an afternoon.

### One finding, which was neither the Target nor the table

The Elvira 1 and Waxworks demos did not read at first, and the sweep could not
say why: ADR 0029's check is read _and_ re-emit, and a failure of the pair does
not say which half failed. Trying every Version and release kind against both
files separated them. Each **read** under exactly one Version — 51 items and 5
Subroutines for Waxworks, 6 Subroutines for Elvira 1 — and each **re-emitted
short**, by 3,129 and 1,677 bytes.

The tail is a table of opcode names: `Abort`, `AddVerb`, `AddNoun`, `AddAdj`,
`AddPrep`, `AddPron`. A development build's symbols, appended to a `GAMEPC` and
read by nothing at runtime.

So neither the Target nor the opcode table was wrong. What was wrong was this
project refusing to **load** the file, which was stricter than its own ADRs:
ADR 0013 settled that a game whose Version can only be guessed "plays on that
guess and is refused for editing", and ADR 0030 already refuses this edit
because a region the model cannot produce makes the whole game uneditable.
Detection now reports `partial` for that case — it plays, it says so, and it is
refused for editing — which is what made the two rows at the top of the table
above possible.
