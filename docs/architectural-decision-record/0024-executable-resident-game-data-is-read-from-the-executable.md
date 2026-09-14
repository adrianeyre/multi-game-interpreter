# Executable-resident game data is read from the executable, never from a reimplementation's support file

This is the decision the Virtual Theatre families exist around, and it is the
first time this project has met games whose data files do not contain the game.

## The problem

`CONTEXT.md` used to define a **Published game** as "the compiled files a player
loads — an index and its data files, as a release shipped them". Every family so
far fitted: a SCUMM index and its container, an AGI `*DIR` and its volumes, a
SCI `RESOURCE.MAP` and its volumes. In each case the interpreter is generic and
the game is data.

Neither of Revolution Software's adventures is built that way, and it is the
same break in both.

Beneath a Steel Sky's `sky.dsk` and `sky.dnr` hold its graphics, sound, text and
logic bytecode. They do **not** hold the object table that bytecode operates on
— every object's position, state, animation, and the script pointers that drive
it. Revolution compiled those structures, which their sources call **Compacts**,
into the game executable. Lure of the Temptress does the same thing with its own
equivalent, held in its own executable.

ScummVM's answer in both cases is a generated support file: **`sky.cpt`** for
Sky and **`lure.dat`** for Lure, neither of which Revolution ever shipped. Both
are reverse-engineered out of the executables by ScummVM's own tooling and
distributed alongside their engines, and both are mandatory — their engines will
not start without them.

That the same problem appears twice, in two engines a decade of this
repository's other families never hit once, is what makes this a rule rather
than a Sky quirk. Writing it as Sky's decision and then rediscovering it for
Lure would have been the mistake.

## The decision

**Read executable-resident data out of the game's own executable. Do not accept
`sky.cpt` or `lure.dat`.**

`CONTEXT.md`'s definition of a Published game widens by one clause to cover it:
the files a release shipped, **including its interpreter**, rather than an index
and its data files. That is not a loophole — it is the accurate description of
what Revolution shipped, and Virtual Theatre is what makes the old wording's
assumption visible.

The rule this must not break is
`.out-of-scope/scumm-non-dos-releases.md`'s: "a release this project reads is
one whose resources are files." A DOS executable is a file. The rule survives
intact, which is worth checking rather than assuming, because it is the rule
that keeps disk images and cartridge ROMs out.

## Why the support files are refused

The licence is not the objection. This project is GPL-3.0-or-later and ScummVM
is GPL-2.0-or-later; reading their files would be lawful.

**A Target built on them would be derived from ScummVM's reading of the game
rather than from the game.** Every other family here decodes what the publisher
shipped, and the whole value of a second independent implementation is that it
_can_ disagree with the first. An engine that starts from someone else's
extraction cannot disagree about the half of the game most worth checking. Where
ScummVM misread an executable, this project would misread it identically and
byte-identically — which is ADR 0013's failure exactly: "re-emit with the same
wrong table and it writes that nonsense back byte for byte. The check passes.
The structure is wrong."

**It makes the editing half incoherent.** ADR 0025 puts this data at the centre
of what a Virtual Theatre Project holds. If it arrived from `sky.cpt`, editing
Beneath a Steel Sky would mean editing ScummVM's file, and export would write
something no interpreter Revolution shipped could load. Export producing a game
a real interpreter accepts is the property ADR 0010's entire model rests on.

**And it is not the promise the front page makes.** The README says the project
"ships no game data: it reads the files of a game you own." A required input
that neither this project ships nor the player's release contains sits in
neither category. Options that need a paragraph of explanation are usually the
wrong option.

## Rejected

**Accept the support files, with the executable as a later improvement.** The
cheapest path and the one most likely to be taken under time pressure. Rejected
because the fallback never gets removed: ADR 0010 already found that "two paths
is worse than one" and named the reason — "the one that stores nothing is the
one under test least often". A `sky.cpt` path would be the one under test _most_
often, which is worse, because it would be the path that works while the
executable reader rotted beside it.

**Transcribe the tables into this repository.** Contradicts "ships no game data"
outright, and these tables are the games' worlds rather than format
descriptions. Not a close call.

**Both, chosen by which files are present.** ADR 0010's rejected option wearing
a different hat.

**Deciding it for Sky now and for Lure later.** Rejected on the grounds this ADR
opens with: the problem is identical in both, and two ADRs would invite two
answers.

## The gate, and the tripwire

This ADR records a decision and is honest about resting on a fact not yet
established. **How the tables are located inside each executable is a spike
output, not an assumption here.** The spike answers one question, per family:

> Are the tables findable by structure — a signature, a header, a layout the
> binary itself carries — or only by offsets hardcoded per release?

If the answer is _by structure_, this ADR stands as written and each family gets
the equivalent of ADR 0020's **Version probe**: a structural test on the game's
own bytes.

**If the answer is _only by hardcoded offsets_, this decision was taken
wrongly.** A table of known releases keyed by hash is exactly what ADR 0020
argued against for SCI Version identification, and adopting it here through the
back door would be worse than adopting it deliberately. In that case the choice
reopens, because a per-release offset table and `sky.cpt` are then the same kind
of artefact — somebody's prior reading of a specific binary — and ScummVM's is
the better maintained one. **Reopen this ADR rather than quietly shipping
offsets.**

The two spikes are the first pieces of Virtual Theatre work and nothing else in
either family starts until its own answers. That ordering is deliberate: it puts
the largest unknown in front of the cheapest work rather than behind it. The
answers may differ between the two games, and one family proceeding does not
license the other to assume.

## Amendment: what the spike found, and where this ADR was wrong

The spikes above were run. They answered, and the answer **splits the two
families** — which is the one outcome this ADR did not anticipate, having been
written to cover both with one rule.

### The evidence

The freeware releases were fetched from ScummVM's downloads page and their
contents listed:

| Release               | Ships                                                            |
| --------------------- | ---------------------------------------------------------------- |
| `BASS-Floppy-1.3.zip` | `sky.dnr`, `sky.dsk`, readme — **no executable, no `sky.cpt`**   |
| `bass-cd-1.2.zip`     | `sky.dnr`, `sky.dsk`, readme, **`sky.cpt`** — **no executable**  |
| `lure-1.1.zip`        | `Disk1–4.vga`, `disk1–4.ega`, **`Lure.exe`** — **no `lure.dat`** |

`Lure.exe` is a genuine DOS MZ executable dated 1995-06-23, 136,956 bytes, with
no appended overlay.

### Lure: confirmed

The rule holds exactly as written. The only freely distributable Lure data
**ships Revolution's own executable and does not ship ScummVM's `lure.dat`**, so
extracting from the executable is not merely the principled route, it is the
only one available. Nothing about the Lure half of this ADR changes.

### Sky: falsified in practice

**Neither freeware Beneath a Steel Sky release ships `SKY.EXE`.** Under this
ADR as written, the freely distributable Sky data therefore cannot boot at all —
there is no executable to read Compacts from, and `sky.cpt` is refused.

That is not a small correction. ADR 0023's headline argument is that Sky is
worth a family partly because it is the only one whose **Completable** claim can
be checked without somebody owning a disc. This ADR, unamended, takes that
away: the free data would be unusable and only an original 1994 disc would
serve.

### Why the reasoning changes rather than merely the conclusion

The `readme.txt` in both Sky archives records something this ADR did not know.
Revolution did not merely permit redistribution in 2003 — per the readme, they
gave ScummVM **the original source code** for Beneath a Steel Sky, and the
freeware release was made with their support.

That undercuts this ADR's central objection where Sky is concerned. The
objection was that a Target built on `sky.cpt` "would be derived from ScummVM's
reading of the game rather than from the game", and could not disagree with a
misreading of a binary. But `sky.cpt` is not a reading of a binary. It is
derived from the authors' own sources and published, with the rights-holder's
blessing, **as part of the release**. There is no misreading to inherit.

By this project's own definition, then, `sky.cpt` is not a foreign artefact
bolted onto a release: for the 2003 freeware release, it is one of "the compiled
files a player loads, as a release shipped them". The 1994 disc and the 2003
freeware package are two different Releases, and they carry the Compacts in two
different places.

### The amended decision

- **Lure** — extract from `Lure.exe`. Unchanged.
- **Sky, 2003 freeware Release** — **`sky.cpt` is accepted**, because it is part
  of that release and is source-derived rather than binary-derived.
- **Sky, original 1994 floppy or CD** — extract from `SKY.EXE`, which is what
  those releases carry.
- **Sky freeware floppy** — ships neither, so it cannot supply Compacts and must
  be refused with a message saying exactly that.

The "two paths is worse than one" objection above still bites, and it is
accepted here rather than argued away: Sky now has two Compact sources. What
makes it tolerable is that they are two _Releases_, distinguished by what the
folder contains, rather than a preference and a fallback. The Sky arm of
`Target` already carries a Release, and this is what it is for.

**What is not reopened.** ScummVM's `lure.dat` stays refused, because Lure's
free data ships the real executable and there is no equivalent argument for it.
If it ever emerges that `lure.dat` is likewise source-derived and that no free
Lure release ships an executable, that is this section's argument again and
should be applied the same way.

### Consequence for ADR 0023

Its freeware argument is **correct for Lure and overstated for Sky**, and
ADR 0026's observation that Lure "strengthens rather than dilutes" the case
turns out to be the load-bearing one. Corrected there.

## Second amendment: has the tripwire fired?

**Recommendation: no — but the first amendment has become load-bearing, and
that is a different thing worth recording.**

The structural work continued after the first amendment and reached an endpoint.
For Sky, seven distinct hypotheses about how `sky.dnr` addresses `sky.dsk` were
eliminated by measurement, the last being that no offset table exists anywhere
in the data file — tested by sliding a window across all 8.8 MB at two widths.
One survivor remains: the resolution lives in the game's own code. For Lure,
#247 reached the same shape by a different route — the object table is not
reachable by any data-side analysis and needs its consuming routine read.

**Why the tripwire has not fired.** It is written narrowly and deliberately: it
fires if the tables are findable _only by offsets hardcoded per release_. That
has not been established. What has been established is weaker and different —
that the answer is not in the data. An answer that lives in code may still be
derived structurally once the code is read; it may equally collapse into
hardcoded offsets. Firing the tripwire now would be acting on the second
possibility before anyone has looked, and the ADR's whole point is not to do
that.

So: **do not reopen this ADR on present evidence.** Reopen it if and when
reading a consuming routine yields an address per release rather than a
derivable structure.

**What has changed instead.** The first amendment accepted `sky.cpt` for the
2003 freeware CD as a narrow concession about Compacts. It is now structural.
If resource resolution is also code-resident, then no freeware Beneath a Steel
Sky release contains enough to load the game by this ADR's original rule — none
ships `SKY.EXE` — and the freeware path depends on `sky.cpt` more broadly than
the amendment supposed.

That is not a reason to widen the concession pre-emptively, and this amendment
does not widen it. It is a reason to stop describing it as narrow.

**A pattern, recorded as one rather than twice as an accident.** Both Virtual
Theatre families resist data-only analysis, by measurement rather than by
assumption. That is a fact about how Revolution built these games — engine and
game data are genuinely entangled in the executable, which is what the
`Published game` widening at the top of this ADR was reaching for. It is the
strongest evidence yet that the widening was right, arrived at from the
opposite direction.

**Consequence for sequencing.** No implementation issue behind this — #252,
#253, #262, and both editor issues — should proceed on a guessed field name. The
`sky.dnr` reader on the branch deliberately exposes unnamed words for exactly
this reason, and that call has now been vindicated twice: once when a 24-bit
field nearly fit and was wrong, and once here.

## Third amendment: Lure's world state is a resource, not executable-resident

**This ADR's premise was wrong for Lure.** Not its reasoning — its factual
assumption about where the data lives. Recorded here rather than quietly fixed,
because the assumption was inherited rather than checked, and that is the part
worth not repeating.

### Where the assumption came from

ScummVM ships a generated `lure.dat`, and this ADR reasoned from its existence
that Lure, like Sky, must have game data compiled into its executable. Nobody
verified it. `lure.dat` may hold other things entirely, and its existence never
implied what this ADR took it to imply.

### The evidence

The executable's save routine gives a slot size of 37,504 bytes, computed as the
span of a buffer at `ds:0x5D90` (#264).

Reading the containers with the verified directory format finds exactly two
resources of that size among all 613 across all eight containers: **id 16398**,
in `Disk2.vga` and `disk2.ega`, first resource in each, identical opening bytes.

That was suggestive. What settles it is the executable's only reference to that
id: it loads resource 16398 to **`ds:0x5D90`** — the same destination address,
for the same length, as a restored save slot. The block immediately before it
sets the current-slot variable to its no-slot sentinel, which is the new-game
path.

A resource loaded into the identical buffer a save is restored into, at
identical length, is the initial world state. That is not a size
correspondence; it is the same address.

### What changes

**Lure's object table ships in the data files.** It is read with the container
reader rather than extracted from a binary. The issue asking for an extractor is
the wrong shape, and the search inside `Lure.exe` that eliminated five
techniques was looking in the wrong place — which is now explained rather than
merely unresolved.

**`lure.dat` stays refused**, and more comfortably than before: there is now no
reason to want it.

### What does not change

**Everything this ADR argues.** The rule is to read what the publisher shipped
rather than another implementation's derivation of it, and a resource inside
`Disk2.vga` is exactly what Revolution shipped. The conclusion is easier to
satisfy than expected, not harder.

**Sky is untouched.** Its Compacts are still not in `sky.dsk`, and the first
amendment stands. The two families differ here as they differ in compression —
one more instance of ADR 0026's point that they are two families and not one.

### The lesson worth keeping

The premise came from a third party's artefact rather than from the game, and
survived four ADR revisions unchecked. **An inherited assumption should be
labelled as one**, so a later reader can tell which claims carry evidence and
which are inference from someone else's tooling.

## Fourth amendment: Sky's resource addressing did not need the executable

**The second amendment's surviving hypothesis was right about where the answer
lives and wrong about what that implied.** It concluded that `sky.dnr`'s
resolution to `sky.dsk` "lives in the game's own code", and drew from that the
consequence that #252 and everything behind it waited on an original disc,
because no freeware release ships `SKY.EXE`.

The rule does live in the code. It is also **checkable from the shipped data
alone**, which is the step that was missed, and it is now implemented and
verified in `src/engine/sky/resource/SkyResources.ts`.

### What the reading is

An eight-byte entry is a 16-bit resource number, a 24-bit offset whose top bit
says its low 23 bits count 16-byte units rather than bytes, and a 24-bit field
whose low 22 bits are the size on disk and whose top two bits say whether the
22-byte prefix is part of the unpacked result and whether the resource is to be
unpacked at all.

### Why this is measured rather than believed

Three independent checks, each of which a wrong reading fails:

1. **Coverage.** All 6,542 entries across both shipped releases land inside
   their file, no entry overlaps another, and the last resource of each ends on
   its file's final byte — 8,830,435 and 72,395,713 exactly. The unit flag is
   not optional in this: without it, 148 floppy entries address past the end.
2. **Markers.** Every `RNC\x01` marker in either file sits at an entry's
   `offset + 22`, and every entry the index calls packed has one. Neither file
   holds a single unaccounted marker.
3. **Content.** Each packed resource carries a CRC of its own _unpacked_ bytes.
   **5,907 of 5,907 unpack to their declared length with the declared CRC.**

The third is the one that matters most, because it checks the bytes rather than
the arithmetic, and it does so without anything being drawn, played, or looked
at by a person.

### The honest account of where the hypothesis came from

The offset/size split was found by measurement — the arithmetic in (1) is what
produced it. The **unit multiplier** was not: two 1994 floppy builds ship 1,445
entries each and differ in it, and ScummVM's `Disk::determineGameVersion` is
where the tie-break on `sky.dsk`'s length comes from. That is a third party's
artefact, which the third amendment's lesson says to label as one, so it is
labelled: the freeware release's multiplier is verified by (1) and (2) directly;
the other build's is inherited and unverified, and `SkyResources` says which
release it thinks it has so a wrong inheritance is visible rather than silent.

### What changes

**#252 is done, from freeware data, on a build machine.** So are the nine issues
the tracking issue listed as waiting on a purchase — as far as _this_
dependency goes. They are not unblocked in general: #253 still needs the
Compacts, which are still executable-resident, and `sky.cpt` is still refused.

**The recommendation to acquire an original release stands**, and its scope
shrinks: it is now the unblock for the Compact table alone rather than for the
resource layer as well.

### The lesson worth keeping

"The answer is in the code" and "the answer needs the code" are different
claims, and the second does not follow from the first. A rule implemented in an
executable can leave enough evidence in the data it addresses to be recovered
and — the part that matters — **checked**. Before concluding that a format needs
a binary nobody has, it is worth asking what the data would have to look like if
a candidate reading were true, and then looking.

## Consequences

**Export patches the executable in place.** ADR 0010's principle is unchanged —
"copy what was not touched, substitute what was, rebuild the index" — and
applies to a binary as readily as to a container. Edits are written back at the
offsets they were read from.

**Size-changing edits are refused, not relocated.** Adding a record, or growing
one past its slot, would relocate everything after it and invalidate every
pointer the executable's own code holds into the table — code this project does
not decompile and will not be rewriting. So the editor allows values to change
and refuses the shape to change, and it says which _before_ the work rather than
after it, the way `describeEditRefusal` already does for AGI.

That is a real limit on "edit these games" and it belongs on the front page
rather than being discovered. What it costs is authoring genuinely new objects;
what it leaves is every existing object's position, state, behaviour link and
appearance.

**A dump without the executable plays nothing.** Unlike AGI — where ADR 0013
lets a game play on a guessed interpreter and refuses only to edit it — a
Virtual Theatre game with no executable has no world. It cannot boot. The
failure message must say so plainly and name the file, because "resources only"
dumps circulate for every engine and these are the families where they are
useless.

**No declared fallback.** ADR 0013 admits a _declared_ interpreter version
because a person can know something the bytes do not say. Nothing analogous
exists here: nobody can type in an object table.

## Fifth amendment: a release that ships `SKY.EXE` is fetchable after all

The fourth amendment removed the addressing consequence of the second's
premise. **The premise itself is also wrong**, and it took pointing a run at
every Virtual Theatre Release to find that out — the Virtual Theatre matrix in
[`docs/processes/verifying-version-support.md`](../processes/verifying-version-support.md)
is where it surfaced.

The claim was that #252 and the executable-resident Compact table waited on an
original disc, "because no freeware release ships `SKY.EXE`". No freeware
release **of the full game** does. ScummVM's demo mirror carries DOS demos of
Beneath a Steel Sky that do: `sky-dos-v0267-demo-en.zip` is 730 KB and ships
`SKY.DNR`, `SKY.DSK`, `SKY.RST` and a **172,588-byte `SKY.EXE`**, under the same
freeware terms as the two full releases. `npm run sweep:vt` reads it cleanly —
247 index entries, 151 unpacked and CRC-checked, 275 scripts listed to an exit —
and `describeMissingCompacts` classifies it, correctly, as an original release
whose table is in its executable.

**Nothing about this decision changes.** The table is still read from the
executable, `sky.cpt` is still the first amendment's concession, and no reader
for `SKY.EXE` exists. What changes is what the refusal is allowed to say. It
used to rest its case on there being no release to check a reader against, and a
tool that names its own missing evidence has to be right about whether that
evidence exists — otherwise the refusal argues for itself out of a fact nobody
rechecked. `describeMissingCompacts` and `bin/vt-sweep.ts` now say the work is
missing rather than the data.

### The lesson worth keeping

It is the third amendment's lesson at one remove. That one said an inherited
assumption should be labelled as one. This one adds: **a premise about what data
exists in the world decays**, and it decays silently, because nothing in a test
suite goes red when a mirror gains a file. The premise here survived from the
second amendment to the fifth, through a fourth that overturned its consequence
without rechecking it — and what found it was not a new idea but a run that
enumerated every Release instead of the ones already known to work. A matrix
over the whole axis is worth having for exactly that.
