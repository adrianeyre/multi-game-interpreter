# A directory that exists only in a reimplementation's support file is derived from the shipped bytes, or the Target waits

ADR 0024 decided that game data living in an interpreter's executable is read
from that executable and never from a reimplementation's generated support
file. Five amendments have since sharpened where the data actually is, and none
of them touched the rule itself.

This ADR is about the case ADR 0024 did not anticipate: not data that is
inconveniently placed, but a **directory** — the table saying where every
resource is — that exists nowhere in what the publisher shipped, so that
without it the container cannot be indexed at all. Three famous engines have
now arrived at that wall, and each time the temptation is the same file.

## The problem

Three engines, one shape:

| Engine   | What is missing                                 | Where a reimplementation gets it                               |
| -------- | ----------------------------------------------- | -------------------------------------------------------------- |
| Queen    | The whole resource table for a retail `queen.1` | ScummVM's `queen.tbl`, or a table compiled into ScummVM itself |
| Lure     | Where the script bytecode is                    | ScummVM's generated `lure.dat`, resources `0x3f0c`/`0x3f0d`    |
| Dráscula | Assorted tables                                 | ScummVM's generated `drascula.dat`                             |

Each is measured rather than assumed:

**Queen.** The freeware release ships the original `queen.1`, 22,677,657 bytes,
not a rebuild. It has no `QTBL` signature and no table anywhere in it — ScummVM
identifies the version by the file's _size_, then reads offsets from a table it
supplies. For the English floppy it carries roughly a thousand entries in its
own source.

**Lure.** The four VGA disks of the freeware release carry 39, 103, 118 and 77
resources, over id ranges `0x0001`–`0x0049`, `0x4008`–`0x7901`,
`0x86ff`–`0xa414` and `0xc008`–`0xff11`. **Nothing in `0x3f00`–`0x3fff` exists
on any of them**, so the ids ScummVM reads script data from are its support
file's numbering and not the game's.

The wall is not that the data is hard to find. It is that the _addressing_ is
somebody else's work product, and reading it would make a Target depend on a
file no publisher ever pressed.

## The decision

**A directory that exists only in a reimplementation's generated support file
is derived from the shipped bytes. Until it is derived, the Target is refused
for the purpose that needed it — and refused by name, saying which directory is
missing.**

Three clauses, because the interesting part is what each excludes:

1. **Derivation is the answer, not acceptance.** The directory is recovered
   from what the publisher shipped: the container's own structure, the game's
   executable, or a resource inside the container. It is not copied out of a
   support file and it is not transcribed out of a reimplementation's source,
   which is the same act with an extra step.

2. **A file the publisher shipped is not a support file, however it reaches
   you.** This is ADR 0024's fifth amendment generalised. `sky.cpt` is accepted
   because Revolution gave ScummVM the game's source and that file is part of
   the freeware CD release — it is Revolution's file, distributed by ScummVM.
   `lure.dat` is refused because ScummVM's own tooling makes it. **The test is
   who authored the bytes, never who hosts them.**

3. **Refusal is per purpose, not per Target.** Lure reads its containers, its
   world state, its pictures and its hotspots, and now cannot locate its
   scripts. It is not thereby an unreadable game. The refusal attaches to the
   thing that needed the directory, and the status line names it — the same
   discipline every family already follows for an unimplemented opcode.

## Why derivation is credible rather than aspirational

Because it has already worked twice, both times against the expectation
written down at the time.

**ADR 0024's third amendment.** Lure's world state was assumed to be compiled
into its executable. It is not: it is resource **16398** — `0x400e`, inside
disk 2's range above — the snapshot the executable restores into for a new
game. The ADR records that as a correction rather than absorbing it quietly,
and the derived answer was better than the assumed one.

**ADR 0024's fourth amendment.** Sky's resource addressing was assumed to need
the executable. It did not; `sky.dnr` addressing `sky.dsk` was enough, and that
reading is measured over 1,445 and 5,097 resources with every packed one
CRC-checked against its own unpacked bytes.

Two for two, on the two occasions this project looked. That is a small sample
and it is the sample there is, and it points the same way both times: the
shipped bytes had the answer and the assumption did not.

## Rejected

**Read the support file.** It is the cheapest route and it is the one ADR 0024
exists to refuse. A Target that needs `lure.dat` claims a folder containing
ScummVM's artefact, which may not contain the game — `lureDetect.ts` already
declines to detect on that file for exactly this reason. It also makes this
project's reading of a format contingent on another project's tooling, which is
the opposite of reading the format.

**Transcribe the table out of the reference's source.** A thousand entries of
offsets and lengths copied by hand or by script is still that project's
extraction of the game's layout, and it fails clause 1 by a route rather than
on the merits. Note the contrast with an **opcode name table**, which ADR 0029
has generated from the reference three times over and this ADR does not
disturb: a name is a label this project chooses for its own listings and
changing it breaks nothing but a listing. An offset is a claim about where the
game's bytes are, and a wrong one is silent.

**Declare the three engines out of scope.** They are three of the ten famous
engines the parity roadmap has left, and two of them — Queen and Dráscula — are
freeware, which makes them among the few whose reading CI could ever check
against a real game. Declining them would be declining the best-verifiable work
available.

**Guess the directory structurally and ship it.** Deriving a table by probing a
container is legitimate work; shipping it without a check that the derived
table agrees with the game is not. Where derivation lands, it needs the same
tripwire ADR 0024's gate has: an independent measurement that would fail if the
derivation were wrong.

## The gate

Derivation is done when a decoded resource can be checked against something
the game itself asserts. Three examples of what that looks like, in descending
strength:

1. **The container's own extent.** A table is right if its resources tile the
   file without overlapping and the last ends where the file does. SLUDGE's
   resource count is established this way, and the same check caught a walk that
   reported one resource too many.
2. **A game-authored artefact.** A picture that renders, a string the parser
   returns, a script whose listing reaches an exit. AGI's fifth King's Quest III
   room was confirmed by the game's own authored text, which a wrong decode
   cannot produce.
3. **A checksum the game carries.** Sky's packed resources CRC-check against
   their own unpacked bytes.

A derivation with none of these is a hypothesis, and it is reported as one.

## Consequences

- Queen gains no interpreter until its table is derived. `docs/scummvm-parity-roadmap.md` keeps it in the queue and marked blocked, which is now a decision rather than an observation.
- Lure's script disassembler stands, verified against a fixture, with no entry point. Its tests say Tier 1 and its own file declines to offer a "read every script" function, because the entry points are not in the script data.
- Dráscula is blocked on the same clause and needs no separate finding.
- `engineSignatures.ts` continues to detect on publisher-shipped files only, which it already did for Lure.
- The three rows unblock together or not at all, which is the reason this is one ADR and not three.

## The lesson worth keeping

The wall looked like three separate missing files and is one missing category:
**an addressing table that only a reimplementation has.** Naming it as a
category is what turns "Queen is awkward" into a decision the next engine can
be held to — and the two amendments above suggest the shipped bytes usually
have the answer, which is worth remembering before reaching for somebody
else's.

## Amendment: this ADR removed a working feature, and it exposed a line it does not draw

Recorded because the cost landed on a real feature within a day of the
decision, and because the question underneath is genuinely open.

### What happened

A Sky router was written and measured working: clicking the floor at (152,80)
on the freeware CD release routed the player, who walked from (288,216) to
(280,216) and arrived in the clicked cell. It was the only player action
anything in the Virtual Theatre families had ever answered.

It rested on a constant array transcribed from ScummVM's C++ source, mapping a
screen number onto which of the seventy walk-grid resources applies. On the
clauses above that is a directory — it says which resource to use — and clause
1 refuses the route as well as the destination: not copied from a support file,
and not transcribed from a reimplementation's source, "which is the same act
with an extra step". Three derivations from shipped bytes were tried and all
three measured negative.

So the table was refused and the router went with it. `npm run play:vt` reports
`fnAr is not implemented` again. The router is preserved at the tag
`working/sky-router-with-convert-table`.

**That cost is not an argument against the decision.** An ADR that only ever
forbids what nobody wanted is not being tested. But it is an argument for
saying precisely where the line falls, which the decision above does not.

### The line this ADR does not draw

`src/engine/sky/script/skyMcodes.ts` is transcribed from the same source, and
it ships. So does the AGOS argument table, and the SLUDGE and Lure opcode-name
tables — those three are _generated_ under ADR 0029 rather than typed, but
generation is transcription with a script holding the pen, and ADR 0029 says as
much when it calls a hand-typed table one "with a typo in it".

If transcribing a reimplementation's constants were refused outright, four
shipped things would have to go. They do not, so the refusal is narrower than
"constants from their source" — and the decision above never says what makes
this array different from those.

The distinction that seems to be doing the work is **what a wrong entry costs**:

- A wrong **opcode name** makes a listing lie. It is visible, it breaks nothing,
  and re-running the generator is the check.
- A wrong **offset or slot** is silent. It reads the wrong bytes and presents
  them as the game's, which is the failure ADR 0024 and this ADR both exist to
  refuse.

By that reading the grid map is refused because it is _addressing_, not because
it is transcribed — and the mcode names are fine because they are _labels_.
That is a coherent line and it is **not** the one clause 1 states: clause 1
refuses the act of transcription, which would also condemn the mcode names.

### What is not decided

Whether clause 1 should be narrowed to addressing, leaving labels transcribable;
or kept as written, in which case the four shipped tables above are
inconsistent with it and something has to give.

This amendment does not settle it. It records that the two readings disagree,
that a working feature sits on the wrong side of the stricter one, and that a
router is waiting at a tag for whichever way it goes. Deciding it silently in
either direction — by transcribing the next array, or by refusing the next
label — is the outcome worth avoiding.
