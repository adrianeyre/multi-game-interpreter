# Sky is a fourth Engine family, and it is worth having for one game

Revolution Software's Beneath a Steel Sky (1994) runs on the engine ScummVM
calls **Sky**. It fails all three of `CONTEXT.md`'s sharing tests at once — no
shared bytecode, no shared resource layout, no shared renderer — against SCUMM,
against AGI and against SCI. So "is it a family" is not a question anybody has
to argue, and this ADR does not argue it.

The question worth recording is whether a family is worth having for **one
game**, because that is what Sky is. SCUMM brought twenty-odd titles, AGI seven,
SCI a catalogue. Sky brings Beneath a Steel Sky and its demos, and nothing else
this project will ever load. Three of the four notes in `.out-of-scope/` refuse
work on grounds that sound like they should refuse this one too.

## The test that refused the others, applied here

`.out-of-scope/agi-booter-and-apple-ii.md` refuses AGI's booter and Apple II
releases because they are "a second way to load the same titles, not a way to
load new ones". `.out-of-scope/scumm-non-dos-releases.md` refuses v0 and v1 on
the same ground and says so explicitly. `.out-of-scope/sci-non-dos-releases.md`
calls that argument "verbatim, and it was right there too".

Sky is the case those notes were distinguishing themselves from. Beneath a Steel
Sky has no SCUMM release, no AGI release and no SCI release. Every hour spent on
Sky buys a game that is otherwise unreachable, which is precisely the thing the
three refusals said they were preserving effort for.

## The test that should have refused it, and does the opposite

The other recurring objection is verification cost.
`docs/processes/verifying-version-support.md` is blunt that **Completable**
cannot be asserted by CI, because "real game data is copyrighted and cannot live
in this repository". Every out-of-scope note leans on this. Fifty Humongous
titles is fifty people playing fifty games to the end.

Sky inverts it. **Beneath a Steel Sky has been freeware since 2003**, released
by Revolution and distributed from ScummVM's own downloads page. It is the only
game this project supports whose data a build machine may legally fetch.

So Sky is not merely affordable to verify — it is the first and probably only
family where the Tier 2 bar can be reached by something other than a person with
a disc.

**Corrected by ADR 0024's amendment.** This paragraph was written before anybody
looked inside the freeware archives. Neither ships `SKY.EXE`, so under ADR 0024
as originally written the free Sky data could not have booted at all and this
argument would have been empty. It survives only because that ADR was amended to
accept `sky.cpt` for the 2003 Release — and it survives with a qualification:
the freeware **floppy** release ships neither an executable nor `sky.cpt`, so it
cannot supply Compacts and is refused. The CD release is the one this argument
actually rests on.

ADR 0026 notes that Lure "strengthens rather than dilutes" this case. That turns
out to be the load-bearing half: Lure's free release ships Revolution's own
executable and no ScummVM artefact, so it needed no amendment at all. That is worth more than a fourth of a catalogue. It gives this project
its first end-to-end check against **real shipped bytes rather than a fixture
that encodes our own reading of the format**, which is the trap Tier 1 has
carried since it was written.

That does not make the Completable claim automatic. A game played to its last
screen by a script is still a game played to its last screen, and building that
script is real work tracked as its own issue. The point is only that the door is
open here and is bolted shut everywhere else.

## Why here rather than beside

Unchanged from ADR 0011 and restated by ADR 0015: one deploy, one issue tracker,
no published-package seam between a shell and the engines that need to share a
screen. Nothing about Sky reopens it.

## The seam's fourth test

`AdventureEngine` was written for two families, survived a third, and ADR 0011
set a ceiling: "if it grows past roughly thirty the seam is in the wrong place
and the ADR should be revisited rather than the interface widened." It has
seventeen members.

**Sky requires no new member.** It is 320x200 in 256 colours, so `resolution`
reports the degenerate pair SCUMM and AGI report and SCI2 does not. It drives
its world from a pointer over an inventory and a small verb surface of its own,
so it brings its own `EngineInput` object exactly as the other three do and the
shell interprets nothing. It has music, sound and — in the CD release — speech,
which is `EngineSound` unchanged. It saves, so it has a `saveFormat` and a
`saveNote` of its own.

This is the strongest evidence the seam has yet produced, and it is worth
writing down as evidence rather than as a boast: a fourth unrelated engine
landing on an interface designed against two, without widening it, is the
result that would have falsified ADR 0011 had it gone the other way.

**The tripwire.** If Sky does force a member, the member is the finding. Add it
and note it here; do not add it quietly.

## Named Sky, not Virtual Theatre

Revolution's own name for the system is **Virtual Theatre** — the
character-simulation layer that lets background actors go about their business
independently of the player. It is the better historical name and it is the
wrong name for a family, because Virtual Theatre also covers **Lure of the
Temptress**, which is a separate interpreter.

Sky is what ScummVM calls this one, what this repository's own refusal message
already says, and what names exactly the thing being built. Precedent agrees:
SCUMM, AGI and SCI are all the names in common use rather than the ones on the
box.

**Amended by ADR 0026.** The first draft of this section added "and which this
project refuses by name" — Lure was out of scope when this was written and is
now in scope as a fifth family. The conclusion is unchanged and the reason
moved: Virtual Theatre is not a family name because it names **two** families,
not because one of them was unsupported. ADR 0026 has the detail.

`CONTEXT.md` gets Virtual Theatre as an _Avoid_ against either family name and
as a term of its own for the pair, so the next person to reach for it finds the
reason instead of the term.

## The Version axis is degenerate, and that is the finding

Every family so far has a Version — SCUMM v2–v8, AGI v2–v3, SCI0–SCI3 — and
`CONTEXT.md` defines one as "a major version within one Engine family,
identified from the game's index". Sky has no such axis. There is one game and
one engine lineage under it.

What does vary is the **release**: a demo, a floppy release and a CD release
with recorded speech. Those are releases of one game, not versions of an engine,
and calling them Versions would put a word in `CONTEXT.md` doing two different
jobs in two different families — the exact ambiguity the "never bare v3" rule
exists to prevent.

So the Sky arm of `Target` carries a **Release**, not a Version. ADR 0012 made
`Target` a discriminated union with deliberately asymmetric arms precisely so a
family could carry what it actually needs; this is the third time that has paid
and the first time an arm has needed _less_ than SCUMM's rather than more.

The exact set of releases and how they are told apart is a spike output, not a
guess to be written here. See ADR 0024 and issue tracking.

## Platform

`SkyPlatform` exists with only `dos` implemented, following
`.out-of-scope/sci-non-dos-releases.md` exactly: "adding one later is a value
and a resource-layer implementation, not a change of shape."

Sky's non-DOS releases have a sharper reason than SCI's to stay out, and it is
ADR 0024's. The Compacts are read from the game's own DOS executable. An Amiga
release has no such executable and would need a second extraction against a
second binary format, for a release of a game that already plays. Recorded in
`.out-of-scope/virtual-theatre-non-dos-releases.md`, which applies the same rule
to Lure.

## Consequences

**The Sky signature leaves `engineSignatures.ts`,** the way AGI's did at #125 and
SCI's did at #216, and for the same stated reason: an engine stops being
_foreign_ when it gains an interpreter here. It routes to `looksLikeSky` in
`src/engine/loadEngine.ts` instead. The comment in that file recording why AGI
and SCI left gains a third paragraph rather than being rewritten — the sequence
is the useful part.

**`describeForeignEngine` is already wrong and this makes it wronger.** Its
message ends "This project implements SCUMM only", which stopped being true when
AGI landed and is now false three times over. That is a live defect independent
of this ADR and is filed as one.

**Detection claims on both data files.** `sky.dsk` beside `sky.dnr`, never
either alone — the rule `loadEngine.ts` already states, that a family answers on
positive evidence it owns and never on another family's absence. A lone
`sky.dsk` from half an extracted archive is not evidence of a game, and claiming
it takes SCUMM's good failure message away from a dump that has one.

**Sky is asked before SCUMM and after nothing in particular.** SCUMM stays last
because it is the catch-all with the messages worth keeping.

## Rejected

**Refusing on the ground that one game is not worth a family.** It is the
honest objection and it loses to the freeware argument twice over — once because
the game is otherwise unreachable, and once because it is the only real data
this project can test against without asking somebody to buy something.

**Waiting for a second Virtual Theatre game to justify the family.** Rejected
when written, on the ground that Lure is a separate engine whose implementation
would share no code with this one. That is still true, and it turned out not to
be a reason to wait: Lure was taken as a fifth family in ADR 0026, and it
strengthens rather than dilutes the argument above — two freely distributable
games give a shared shell two independent chances to be caught out against real
shipped bytes, where one gives it one.
