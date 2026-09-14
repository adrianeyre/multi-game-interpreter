# Verifying support for a Target

Real game data is copyrighted and cannot live in this repository, so
`tests/fixture.ts` builds a synthetic but structurally valid game in memory
instead. That means "Day of the Tentacle is Completable" is not something CI can
assert **for any family but one**. Every issue adding support for a Target
therefore names which of three tiers proves it done.

> **Amended by #266.** This paragraph used to end "is not something CI can ever
> assert", and _ever_ was one family too strong. Revolution Software released
> both their adventures as freeware in 2003, so Beneath a Steel Sky and Lure of
> the Temptress are data a build machine may lawfully fetch — the only such
> games here. What that changes, and what it does not, is
> [the Virtual Theatre section](#the-virtual-theatre-families--the-one-place-ci-can-check-a-game)
> below. It does not change the rule that no game data is committed: the CI job
> fetches into a gitignored folder and fails the run if anything lands anywhere
> tracked.

## Tier 1 — synthetic fixture, in CI

For anything structural: index parsing, costume decoding, the disassembler,
round-trip byte-identity of Preserved bytes. A synthetic game for the version
exercises the same code paths as a real one, with content we control.

**The trap:** a fixture encodes our reading of the format. If that reading is
wrong, the fixture and the engine agree with each other and disagree with the
game. Tier 1 passing is not evidence that the game runs.

## Tier 2 — a named in-game checkpoint, by hand

For anything behavioural. The issue names a specific place in a specific game —
"the intro cutscene runs to completion", "Bernard can use the Chron-o-John" —
and a person with the data confirms it. Not automatable, and the acceptance
criteria say so rather than substituting a unit test that proves less.

## Between the tiers — the standing sweep

Tier 1 is synthetic and Tier 2 is a person, and there is a gap between them that
neither reaches. `npm run sweep` fills it.

```
npm run sweep -- games/fate
```

It boots a real game, lets it settle, and then runs **every verb handler on
every object in every room** — for Fate of Atlantis, around 2650 handlers across
around 745 objects in 96 rooms — watching for unimplemented instructions and sub-opcodes,
scripts that read past the end of their own code, resources that could not be
found, and rooms that could not be entered. That is the bytecode a player
triggers, without having to solve the puzzles that reach it.

It was a one-off first, and it found the pseudo-room fault below that play alone
had not. Making it a command is what turns it from an anecdote into something a
later Version can be held to.

**A spun script is not a finding.** The sweep drops into each room cold, with
the ego standing wherever it was left, so a handler that waits for a walk the
ego has no reason to make waits forever. Those are reported in their own
paragraph and do not fail the run; `--strict` promotes them. A script that read
_past the end of its code_ is the opposite and is always a finding: it means the
engine consumed the wrong number of operands somewhere upstream.

`--room=42` sweeps one room, for chasing a finding back to the handler that
produced it. `--verbose` prints a line per handler. `--settle=` and `--frames=`
change how long the game gets to boot and how long each handler gets to run.

**Against a real game it cannot run in CI**, for the reason nothing with real
data can: `games/` is gitignored and stays that way. It is a local tool, and its
output is what an issue quotes as evidence. It also cannot establish
_Completable_ — that is a claim about a game's last screen, and only Tier 2 can
make it.

**Against a fixture it does run in CI**, and that is a different and weaker
claim worth keeping separate. The sweep itself is `src/engine/sweep.ts` and
`npm run sweep` is the command line over it, so `tests/sweep.test.ts` points the
same code at a synthetic install of every supported Target on every run. What
that proves is that the tool _reaches_ each Target — boots it, walks its rooms,
finds objects with verb tables and runs their handlers. What it cannot prove is
that any Target reads its game correctly, because a fixture encodes this
project's reading of the format and so agrees with the engine by construction.

The counts are asserted before the findings are, deliberately. A sweep that
entered nothing reports no findings, and "no findings" from a tool that ran
nothing is the one result worse than a failure.

## What each Version's claim actually rests on

The one table worth keeping current, because "supported" is a word that hides
the difference between a game somebody played and a fixture that passed.

**This table is SCUMM's.** AGI and SCI have their own axes and their own
sections —
[every AGI build and every SCI Version through one run](#every-agi-build-and-every-sci-version-through-one-run)
— and they are separate tables rather than more rows here because the axis is a
different shape in each family: SCUMM has seven Versions that each fix an
instruction encoding, AGI has six arity tables crossed with two packaging
majors, and SCI has thirteen Versions that no resource map can tell apart. One
table pretending those are one axis is how three different things acquire one
claim.

The **Sweep** column has two halves, because they are two claims. _Fixture_ is
`tests/sweep.test.ts` and runs in CI; it says the tool reaches that Target.
_Game_ is `npm run sweep` against real data on somebody's machine; it says the
Target's reader survived a shipped game's own bytecode. Only the second is
evidence about a game.

| Version | Tier 1                                        | Sweep — fixture | Sweep — game                                                                                                          | Tier 2                              |
| ------- | --------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| v2      | `fixtureClassic` (`classic-fixtures.test.ts`) | CI, no findings | not run — no data here                                                                                                | **none**                            |
| v3      | `fixtureClassic`                              | CI, no findings | not run — no data here                                                                                                | **none**                            |
| v4      | `fixtureClassic`                              | CI, no findings | `games/loom`, no findings                                                                                             | Loom CD, below                      |
| v5      | `fixture.ts`                                  | CI, no findings | `games/fate`, no findings — 2,644 handlers, [below](#all-seven-scumm-versions-through-one-run-and-the-fault-it-named) | Fate of Atlantis, below             |
| v6      | `fixtureV6`                                   | CI, no findings | `games/dott`, no findings — 3,044 handlers, [below](#all-seven-scumm-versions-through-one-run-and-the-fault-it-named) | Day of the Tentacle                 |
| v7      | `fixtureV7`                                   | CI, no findings | not run — no retail data here                                                                                         | boots; not playable, see the README |
| v8      | `fixtureV8` (`v8-fixture.test.ts`)            | CI, no findings | not run — no data here                                                                                                | **none**                            |

The three "none" rows are the honest state of v2, v3 and v8: they are read,
played and edited by the same code every other Version goes through, and what
nobody has done is run one. Per Tier 1's trap, that means the fixture and the
engine agree with each other about Maniac Mansion, Indy 3 and The Curse of
Monkey Island, and neither has met the game. A person with a copy and a named
checkpoint is the whole of what is missing, and the v5 and v4 sections below
are what that produces when it happens.

**One more gap, and it is not a Version's.** `npm run shot` is how the
framebuffer fault class gets checked, and no EGA room has been through it: the
only pre-v5 install on this machine is Loom CD, which is 256-colour. The EGA
codec, the sixteen-colour palettes and the pre-`AKOS` costumes are covered by
fixtures and by nothing that has been looked at. Monkey Island 1 EGA, Indy 3 or
Loom floppy would settle it, and #199 asks for exactly that: one real EGA room
compared against the game and recorded here.

**The fixtures sweep too, and now they sweep in CI.** Pointing the sweep at
synthetic installs is a cheap check that the tool reaches every Target rather
than only the ones with data behind them, and it found two fixture faults and
one engine fault the first time it was run that way — a fair return for a tool
pointed at a game nobody wrote. It was a manual exercise: seven installs
written to a temporary folder by hand. `tests/sweep.test.ts` is that exercise as
a test, across all seven Targets, so a Version that stops being reachable by the
sweep now fails a run rather than waiting for somebody to repeat the exercise.

**What would fill each row.** For v2, Maniac Mansion or Zak reaching a named
room with the player in control. For v3, Indy 3 or Loom floppy doing the same.
For v8, The Curse of Monkey Island booting past its opening and drawing a room
— the largest title in scope, and the one whose reading has the furthest to
fall, since every field in its index, its rooms and its images is a width this
project chose from ScummVM rather than measured.

## All seven SCUMM Versions through one run, and the fault it named

Run 2026-09-07 in a Sandcastle sandbox — `docs/processes/running-sandcastle.md`
has the wiring, including why the two games arrive as read-only mounts. It is
worth recording as a section rather than a table cell for one reason: it is the
first time every Version went through the same four commands on the same day,
and doing that found something that had been passing quietly.

The two questions asked of each Version were **does it play** (`npm run
diagnose`, then `npm run sweep`) and **does it Decompile into something
editable and re-emit unchanged** (`npm run unrecovered`, then `npm run
reexport`).

| Version | Data                            | Boots to | Sweep                       | `unrecovered`                                                    |
| ------- | ------------------------------- | -------- | --------------------------- | ---------------------------------------------------------------- |
| v2      | fixture — `fixtureClassic({2})` | room 0   | 1 handler, 1 object, 1 room | 3 scripts, 0 Unrecovered, 0 jumps to follow                      |
| v3      | fixture — `fixtureClassic({3})` | room 0   | 1 / 1 / 1                   | 3 scripts, 0 Unrecovered, 0 jumps to follow                      |
| v4      | fixture — `fixtureClassic({4})` | room 0   | 1 / 1 / 1                   | 3 scripts, 0 Unrecovered, 0 jumps to follow                      |
| **v5**  | **real — Fate of Atlantis**     | room 4   | **2,644 / 742 / 96**        | **2,200 scripts, 0 Unrecovered, 25,518 jumps, 0 off a boundary** |
| **v6**  | **real — Day of the Tentacle**  | room 1   | **3,044 / 499 / 89**        | **1,251 scripts, 0 Unrecovered**                                 |
| v7      | fixture — `fixtureV7`           | room 0   | 1 / 1 / 1                   | 6 scripts, 0 Unrecovered                                         |
| v8      | fixture — `fixtureV8`           | room 0   | 1 / 1 / 1                   | 4 scripts, **0 Unrecovered — after a fix; 4 before it**          |

No findings anywhere in the sweep column, and `npm run reexport` came back
byte-identical for all seven. The two real rows are the only ones that say
anything about a game: five Versions had a fixture and nothing else, which is
Tier 1's trap and not a smaller version of Tier 2.

**The jump check is a Classic-encoding claim only.** `npm run unrecovered`
prints its `Jump targets:` line for v2–v5 and not for v6–v8, because a Stack
encoding measures every instruction from its opcode alone and the tool follows
nothing. So v5's 25,518 jumps with none off a boundary is the single strongest
piece of decode evidence in the table, and there is no equivalent number for
v6, v7 or v8 by design rather than by omission.

### What it found: v8 re-emitted through v6's writer

Every one of the v8 fixture's four scripts came back as different bytes —
`Unrecovered: 4` against a target of zero, with the command exiting non-zero.
The cause was in the tool and not in the decompiler: `bin/scumm-unrecovered.ts`
read each script with `disassembleV8` and wrote it back with `assembleV6`. v8's
stream operand is four bytes where v6's is two, which is exactly why
`assembleV8` exists as its own entry point, so every v8 script was re-emitted
at the wrong width and the decompiler was blamed for a pair the tool chose.

**Why nothing caught it.** Three checks all looked like they covered this and
none did. `tests/sweep.test.ts` sweeps v8 and reports no findings, because the
sweep runs bytecode and never re-emits it. `v8-script-engine.test.ts`
round-trips a v8 script and passes, because it calls the correct pair on one
hand-built sample. And `npm run unrecovered` is a local command with no test
behind it at all — the fixture sweep was made a CI check for precisely this
reason and the round trip never was.

`tests/v8-fixture.test.ts` now asserts what #206 set as the editing bar and
nobody had asserted for v8: every script the fixture ships re-emits as the
bytes it arrived as. It fails with the wrong writer and passes with the right
one, which is the property worth having in CI.

**What it still does not cover.** The reader-writer pairing is chosen
independently in `src/editor/ActionEditor.ts`, `src/authoring/decompile.ts` and
`bin/scumm-unrecovered.ts`. Two of those three were right before this run and
one was wrong, which is the failure mode a duplicated decision has. A shared
selector keyed on the Version would make the mistake untypeable; until there is
one, a fourth call site can repeat it.

### What the run could not establish

- **Five Versions had only a fixture: v2, v3, v4, v7 and v8.** A fixture row
  says the tool reaches that Version — it boots the install, enumerates rooms,
  finds objects with verb tables, runs their handlers. It says nothing about a
  shipped game, because the fixture encodes this project's reading of the
  format and so agrees with the engine by construction.
- **Nothing rendered a frame anybody looked at.** `npm run shot` wrote
  framebuffer PNGs for both real games and no person judged one, so the whole
  framebuffer fault class — an object stamped in the wrong place, a room drawn
  with stale state — is as unchecked after this run as before it.
- **_Completable_ was not approached.** It is a Tier 2 claim about a game's
  last screen and no command in this repository can make it. Nothing above
  changes any Version's support status; that remains this document's process.

One caveat recorded rather than counted: Day of the Tentacle logs `iMUSE
command 255 (scope 255) is not implemented` and `iMUSE command 1 (scope 1) is
not implemented` while booting. Those are music transitions, they do not stop
the game reaching a room, and the sweep of 3,044 handlers found nothing — so
they are a caveat and not a play-blocking finding.

## The Virtual Theatre families — the one place CI can check a game

Beneath a Steel Sky and Lure of the Temptress are the only complete commercial
games in `docs/released-games.md` whose data a build machine may lawfully fetch:
Revolution released both as freeware in 2003, through ScummVM and with their own
blessing. ADR 0023 leans on that as a principal reason the Sky family is worth
having for one game, and ADR 0026 notes Lure doubles it in the way that matters
most — two independent games, so a bug in the shared shell has two chances to
show itself against real shipped bytes rather than one.

**This section is where that argument gets cashed** (#266). Until it did, the
argument was unbanked.

### What runs, and what each run is worth

| Command                      | Tier                                   | What it establishes                                                                                                              |
| ---------------------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `npm run fetch:vt`           | —                                      | Pulls a release. Nothing is committed or cached; `games/*` is gitignored and the CI job fails if anything reaches a tracked path |
| `npm run sweep:vt -- <game>` | **Between 1 and 2, against real data** | Reads every resource of a real game and reports what it could not read                                                           |
| `npm run play:vt -- <game>`  | Tier 2, when there is an engine        | Says how far a playthrough reached, by name                                                                                      |

The sweep is the one that is worth something today, and it is worth more here
than the SCUMM sweep is anywhere, because these formats check themselves:

- **Sky, resources.** Every packed resource carries a CRC of its own _unpacked_
  bytes. A wrong index reading fails the packed CRC; a wrong decompressor fails
  the unpacked one; the two are told apart in the message. Current state:
  **1,445 resources read on the floppy release and 5,097 on the CD, 5,907 of
  them unpacked and CRC-checked, nothing unreadable.**
- **Sky, the engine.** `npm run play:vt` boots the shipped game, runs its logic
  list, saves, restores, checks that a save tagged for another game is refused,
  and — once a room is reached — clicks a hotspot the way a player would.
  Current state: **reaches `room`** on the CD release, and over 3,000 ticks runs
  **11,453 scripts**, the world unchanged for 2,998 of them. Reaching a room is
  not playing through one: **clicking the floor stops on the get-to chain**
  (`fnNormalMouse`, then `fnSaveCoods`), which is walking (#256) — the first
  thing a player cannot do, and now the harness names it rather than absorbing
  the click. It distinguishes a resting room from a stall: the status line says
  the world has not changed for N ticks, which is a different complaint from a
  script calling out of the interpreter, and the one a player would otherwise
  have to guess at.
- **Sky, pictures.** A picture's geometry has to describe the resource it sits
  in exactly. A wrong reading shows up as a resource whose length fits and
  whose width times height does not. Current state: **961 that describe
  themselves and 0 that do not**, on both releases — plus three screens written
  out with `npm run shot:sky` and looked at, which is the one piece of evidence
  for this family that a person judges by eye.
- **Sky, world state.** A save and a new game's starting point are the same
  structure, and seven starting states ship inside `sky.cpt`. Their length is
  predicted by the Compact table rather than read from them, and each one
  declares its own size as a third check. Current state: **7 of 7 read and
  rewritten byte-identically**, before there is an engine to save from.
- **Sky, scripts.** Every script in the game is listed as instructions. A
  listing that had to guess a boundary would drift and stop somewhere in the
  middle of a script rather than at its exit, so "it never stopped" is a
  measurement of the encoding rather than of the tool. Current state: **1,768
  of 1,768 scripts, 65,061 instructions, no stops**, on both releases.
- **Sky, Compacts.** Every section of `sky.cpt` is described by a length that
  the next section checks, and the last one has to end on the file's final
  byte. Current state, on the freeware CD release: **3,258 records typed and
  named, 42,395 bytes of names consumed exactly, 419,427 bytes consumed
  exactly, nothing Unrecovered, rewrite byte-identical.**
- **Lure.** Every container is parsed and rewritten and the rewrite compared
  byte for byte. Current state: **8 containers, 613 resources, every rewrite
  byte-identical.**

Neither result depends on this project's own reading of anything, which is
exactly what Tier 1's trap costs every other family.

### What is still not claimed

**Completable, for either game.** `npm run play:vt` reports the stage a run
reached — `refused`, `loaded`, `booted`, `room`, `last-screen` — and only the
last supports the claim. The best any Release reaches today is **`room`**, on
the freeware CD release of Beneath a Steel Sky; Lure's floppy release reaches
**`loaded`**, and Sky's other two Releases are `refused`, each for a reason the
tool names. ADR 0023's line is the rule: "That opens the door; it does not walk
through it" — and a room where the player cannot yet walk is exactly the door
open and unwalked-through.

So the honest summary is that CI can check that these two games are **read**
correctly against their own bytes, and that one Release of one of them reaches a
**room**. It cannot check that either is **played**, because clicking to go
somewhere stops on the get-to chain (#256) — reaching a room is not `Completable`
and this file will not let the two be confused. The matrix below is where those
sentences get their numbers.

## All five Virtual Theatre Releases through one run, and what it named

Run 2026-09-07 in a Sandcastle sandbox — `docs/processes/running-sandcastle.md`
has the wiring, including why this run **fetches** its four releases where the
SCUMM one mounts two. It is worth a section for a reason the SCUMM matrix
cannot claim: **every row here is a real shipped release.** These are the two
games a build machine may lawfully fetch, so Tier 1's trap costs this matrix
nothing where it costs the SCUMM matrix five rows out of seven.

The two questions asked of each Release were **how far does it play** (`npm run
play:vt`, which prints a Stage by name) and **what of it is editable** (`npm
run sweep:vt`, read against ADR 0025's split — the object table is the editable
surface, the bytecode is Disassembly).

| Release       | Data                                        | Plays      | Resources read                            | Object table                                                                       | Bytecode listing                                       |
| ------------- | ------------------------------------------- | ---------- | ----------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Sky `demo`    | real — `sky-dos-v0267-demo-en.zip`, v0.0267 | `refused`  | 247 entries, 151 unpacked, 2.7 MB         | none reachable — the table is in `SKY.EXE`                                         | 275 scripts / 2 modules / 14,029 instructions, 0 stops |
| Sky `floppy`  | real — `BASS-Floppy-1.3.zip`, v0.0348       | `refused`  | 1,445 entries, 1,135 unpacked, 27.6 MB    | none shipped — neither `sky.cpt` nor `SKY.EXE`                                     | 1,768 / 7 / 65,061, 0 stops                            |
| **Sky `cd`**  | **real — `bass-cd-1.2.zip`, v0.0372**       | **`room`** | **5,097 entries, 4,764 unpacked, 110 MB** | **3,258 records typed, 76 aliases, 0 Unrecovered, rewrite byte-identical**         | **1,768 / 7 / 65,061, 0 stops**                        |
| Lure `floppy` | real — `lure-1.1.zip`                       | `loaded`   | 8 containers, 613 resources, 49 palettes  | not typed — the records ship as resource 16398 and the sweep does not extract them | not listed — the Lure sweep reads no scripts           |
| Lure `demo`   | **no in-scope data** — see below            | —          | —                                         | —                                                                                  | —                                                      |

Nothing failed. Every `ok` line in every sweep came back zero: resources that
could not be read, pictures whose geometry disagreed, scripts a listing could
not walk, calls landing outside the mcode table, compacts the reader could not
type, compact tables whose rewrite differed, starting states that did not
round-trip, containers that would not parse, containers whose rewrite differed.
`npm run play:vt` on the CD release reached the `room` Stage, ran **767 scripts
over 200 ticks**, saved and restored with room 0 either side, and refused a save
tagged for another game; at `--ticks=3000` it ran **11,453 scripts** with the
world unchanged for 2,998 of them and the engine saying so in as many words
rather than looking busy. (Those counts were roughly ten times larger before the
`ST_LOGIC` fix stopped killed Compacts being rerun every tick — a smaller number
is the better result here.) The idle run reaches one mcode it cannot do —
`fnStartMenu`, once, because the pointer at rest sits over the menu bar and runs
its `mouseOn` — and clicking the floor stops on the get-to chain
(`fnNormalMouse`), which is the first thing a player cannot do: walk (#256). Both
were being swallowed until `runMouseScript` was made to report a stop the way
`runScript` does.

The picture counts are the other side of the same reading: **961 pictures whose
geometry describes them exactly and none that disagrees** on each full Sky
release and 138 on the demo, with 33 full 320×200 screens on the CD, 8 on the
floppy and 1 on the demo. A wrong reading shows up here as a resource whose
length fits and whose width times height does not, so a zero in that column is
the geometry checking itself.

**Three of the four refusals are the tool working.** A Stage of `refused` is
not a failure when the tool names the file it needs and why, and each of these
does: the Sky floppy release ships neither `sky.cpt` nor `SKY.EXE`, so there is
no object table and therefore no world; the Sky demo ships `SKY.EXE`, and
reading a Compact table out of an executable is not implemented; and Lure has
no interpreter, which is #263 and not news. The distinction matters, because a
matrix that counted those as four failures would be measuring this project's
honesty rather than its state.

### Editable, split the way ADR 0025 splits it

**Decompilation is claimed for neither family and this run does not change
that.** Both ship a read-only listing, and what the numbers above support is
narrower and more useful than a verdict: a listing that had to guess an
instruction boundary would drift and stop somewhere in the middle of a script
rather than at its exit, so **1,768 of 1,768 scripts listed to an exit** is a
measurement of Sky's encoding rather than of the tool. So is **14,532 calls
reaching 111 of 115 mcodes with none landing outside the table**. Neither
licenses the word Decompilation, which ADR 0025 gates behind an ADR of its own,
per family.

**Export is refused for both families, and still is.**
`describeUnbuildableTarget` in `src/authoring/projectToGame.ts` returns a
refusal for `sky` and `lure` naming the route that would work — rewriting the
resource files and patching the object table back into the game's executable
(ADR 0024). A round-tripping reader is not an export path, and the
byte-identity above is Preserved bytes rather than an export.

**So "editable" is a one-Release property today**, and the seam is not where
anybody would guess. It is not a Sky-versus-Lure split and it is not a
demo-versus-retail split: exactly one of the five Releases ships an object
table this project can reach, and it is the freeware CD. It is a `sky.cpt`
split, and it falls in the middle of one family.

**Lure's half was not measured at all, which is worth a sentence of its own.**
The sweep round-trips its eight containers byte-identically and stops there;
Lure's object table ships as resource 16398 (ADR 0024) and nothing extracts it
into records, and no Lure script is listed. So the Lure row carries the
Preserved-bytes floor and **no Unrecovered count over an object table** — which
is the count ADR 0025 says means something for these families. A blank there is
not a zero.

### What it found: the release that could check the `SKY.EXE` reader is fetchable

`npm run sweep:vt` refuses the Sky demo in these words:

    This looks like an original Beneath a Steel Sky release: it ships SKY.EXE,
    which is where those Releases keep the Compact table. Reading it out of the
    executable is not implemented — no original release has been available to
    check such a reader against, and an unchecked reading of the structure the
    whole game world lives in would be worse than this message.

The last clause is no longer true, and this run is how that surfaced. ScummVM's
demo mirror carries DOS demos of Beneath a Steel Sky;
`sky-dos-v0267-demo-en.zip` ships a 172,588-byte `SKY.EXE` and is as freely
fetchable as the two full releases. `bin/fetch-vt.ts` said the same thing more
strongly — that `SKY.EXE` is what "**no freeware release ships**" — and both
are corrected in this change, because a tool that names its own missing
evidence has to be right about whether the evidence exists, or the refusal
argues for itself out of a fact nobody rechecked.

This is not a claim that reading the table out of `SKY.EXE` works, and nothing
in this run implemented any of it. It moves one blocker on #246/#252 from "no
data to check against" to "data, and the work" — and which of those a thing is
blocked on is the difference between an issue somebody can pick up and an issue
nobody can. ADR 0024 carried the same premise in its second amendment and its
fourth overturned the consequence without rechecking it, so it gains a **fifth
amendment** rather than being contradicted quietly; `describeMissingCompacts`,
which is the message a player actually sees, is corrected with it.

### Lure's `demo` Release has no in-scope data, and cannot get any

`LURE_RELEASES` names `demo` and `floppy`, and ScummVM's mirror carries exactly
one Lure demo: `lure-st-demo-en.zip`, a single 1,520,928-byte `.stx` — an Atari
ST floppy image, with no DOS executable and no `disk1.vga`.
[`.out-of-scope/virtual-theatre-non-dos-releases.md`](../../.out-of-scope/virtual-theatre-non-dos-releases.md)
puts non-DOS releases out of scope, for the reason ADR 0024 makes sharper here
than anywhere else: the object table is read out of the DOS executable, so an
Atari ST release means a second extractor against a second binary format to
recover a table this project can already recover.

So that row is empty for a reason that will not change by fetching harder, and
it is recorded as a row rather than dropped. A matrix missing a row looks
complete.

### Four entries every Sky sweep calls unusual rather than unreadable

Resources 2134, 2135 and 2136 on all three Sky releases, and 10347 on the two
full ones, are marked _stored_ in the index and begin with a packer's marker
anyway. The sweep passes them through unpacked, which is what the game does
with them, and reports them apart from its failure counts — three on the demo,
four on each full release. They are named here so that a later run seeing three
or four of them does not go looking for a regression.

### What this run could not establish

- **No Release reached `last-screen`.** Sky's CD release reaches `room`; Lure's
  floppy reaches `loaded`; Sky's demo and floppy are `refused` and Lure's demo
  has no in-scope data to run. `last-screen` means the game's ending with the
  player in control — the only rung that supports `Completable` — and the first
  step between a room and it is walking, which stops on the get-to chain
  (`fnNormalMouse`, `fnSaveCoods`), #256.
- **Decompilation, for either family.** Unchanged, deliberately, and gated
  behind an ADR of its own per ADR 0025.
- **Export, for either family.** Refused by name for both.
- **Nothing over Lure's object table.** No records typed, so no Unrecovered
  count, so nothing about the surface ADR 0025 calls Lure's primary one.
- **A frame was judged by eye — by an agent, not a person.** Two PNGs were
  written from the CD release with `npm run shot:sky` and looked at: 60110 is
  the Virgin Interactive logo screen and 59502 a letterboxed intro comic panel,
  both with correct geometry and palette. That is more than the SCUMM run could
  do and less than [Tier 2](#tier-2--a-named-in-game-checkpoint-by-hand) asks
  for, which wants a person. Recorded as what it is.
- **_Completable_ was not approached.** It is a Tier 2 claim about a game's
  last screen and no command in this repository can make it. Nothing above
  changes any Release's support status; that remains this document's process.

One thing the run found about itself, since a fault nobody writes down is a
fault found twice: `.sandcastle/.gitignore` named one run's report and nothing
else, so this run's report and its PNGs showed up as untracked rather than
ignored. The agent reported that instead of editing a tracked file, which is
what "commit nothing" is supposed to produce. The AGI/SCI run had already found
the sharper version of the same problem from the other side — a report inside
the worktree does not survive an iteration boundary at all — and its answer
covers both: reports go to a writable mount outside the workspace, and
`.sandcastle/reports/` is ignored wholesale. This run's prompt was moved onto
that path.

The run was then repeated against the fixed wiring and reproduced every number
above with a clean `git status` and zero commits, which is what makes the table
a standing check rather than one afternoon's readings.

## Tier 3 — ScummVM and `descumm` as reference

A debugging tool, never an acceptance criterion: it needs game data and a local
ScummVM, so it cannot be a gate. Used to answer "what should this script have
done?" when a Tier 2 checkpoint fails.

> **Corrected by #217.** This paragraph used to end "Every script engine keeps a
> ring buffer of recently executed opcodes and a trace hook for exactly this
> comparison." The trace hook was true — `ScummEngine.trace` and `traceScripts`
> — and the ring buffer was not: no engine in this project had one, and the
> sentence described an intention rather than a facility. The `PMachine` is the
> first to have one (sixty-four instructions, `recentOpcodes()`), so what is
> true now is: **every script engine has a trace hook, and SCI's also keeps a
> ring buffer of recently executed opcodes.** SCUMM's and AGI's should gain one
> too, and that is a separate change rather than something to claim here.

## Where the free demos fit

LucasArts' own demos are freely distributed from
[scummvm.org/demos](https://www.scummvm.org/demos/) and several of them are real
game data for versions this engine supports — including two v6 ones,
`dott-dos-ni-demo-en` and `samnmax-dos-cd-demo-en`. They are not the retail
games and they cannot establish _Completable_, which is a claim about a game's
last screen. What they can do is a lot:

```
npm run diagnose -- /path/to/dott-dos-ni-demo-en 60
```

They boot a real index, run real scripts, draw real costumes and load real
rooms — so they find the class of fault Tier 1 structurally cannot, the one where
a fixture and the engine agree with each other. Four such faults in v6 turned up
in the first hour of trying, all of them invisible to a passing test suite:

- `jump` landed two bytes early, so every loop in a real script missed. The
  conditional jumps were written differently and were correct, and the only
  backward-jump test used a conditional one.
- Costume format was inferred from the version rather than read from the
  resource, and the inference was wrong by one version. No costume in a v6 game
  resolved at all.
- `CDHD` was read with v5's byte fields, where v6 uses 16-bit ones. Both layouts
  are fifteen bytes, so every object came out somewhere else with a height of
  zero — and a zero-height object can never be clicked.
- `PALS` offsets were counted from the wrong base by eight bytes, in the fixture
  as well as the reader, so no real room's palettes were found.

A fifth turned up in v7, and it is the cleanest example of the class. Recorded
speech was read from eight bytes past where it starts: the reader assumed `Crea`
was a chunk tag with a size beside it, when it is the first four characters of
`Creative Voice File` and the audio begins right there. Every synthetic fixture
had been written to match the assumption, so they agreed; the reader is designed
to return "no speech here" rather than throw, so the symptom was silence with
nothing logged. Reading one real `MONSTER.SOU` turned 0 of 106 lines into 105.
The comment above the two offsets had said, for months, "if speech is silent on
a real game, start here" — a note like that is worth writing, and worth acting
on sooner.

**Treat a demo as Tier 2 evidence for what it actually reaches, and name that.**
"Day of the Tentacle's demo boots to its first room with three actors drawn" is
a fact worth recording. "Day of the Tentacle is completable" is not something a
demo can support.

The data is not redistributable and never lives in this repository — the same
rule as any other game. Download it, point `diagnose` at it, and record what it
reached.

## Faults that only have a shape

`diagnose` answers "what is the game doing". A second class of fault does not
show up in that answer at all: the game is doing exactly the right thing and the
picture is wrong. An object stamped where the last one stood, a verb icon padded
out to the wrong size, a room drawn with an old state of a door still in it —
every one of those has a correct-looking report behind it, because nothing about
engine state is out of place.

```
npm run shot -- games/tentacle out/ --at=0,10,60 --play --scale=2
```

writes the same framebuffer the browser paints, at each of those numbers of
seconds of game time, as a PNG. It is the cheap version of "watch it in a
browser": no playing to the point of the fault, no copying text out of a log
pane, and the output is something a reviewer can look at rather than take on
trust. `--play` presses escape at a skippable scene, the way a player who has
already seen the intro would, which is usually the difference between the logo
and the first playable room.

Three of the faults behind this document's v6 notes were found this way and
could not have been found any other: the EMS warning screen the game sat on
because a variable the interpreter owns was never set, the object states that
reverted because they were recorded on the room's copy of an object rather than
in the global table, and verb pictures measured by the object's box instead of
by its image header.

## What Atlantis reached, and what found it

Tier 2 evidence for SCUMM v5, named the way this document asks for it.

**Indiana Jones and the Fate of Atlantis (DOS talkie) plays from its first
screen through the attic, the fall through the trapdoor, and the four rooms
after it, with the player in control in each.** It is not a claim that the game
is _Completable_ — nothing here has seen its last screen — and it is not a claim
about anything past those rooms.

What is worth recording is the shape of the faults it found, because every one
of them was invisible to a passing test suite and none of them looked like a
failure:

- `DOBJ` read as interleaved records rather than two columns. Every object came
  back owned by the room with a class field of 0x0f0f0f — plausible, and wrong
  in a way that made all fifteen objects in the opening room untouchable.
- `Untouchable` numbered 20 rather than 32.
- Clicks resolved by the interpreter instead of by the game's input script.
  Atlantis's attic has no verb panel at all and is played entirely through
  `VAR_VERB_SCRIPT`, so there was nothing for the interpreter's own handling to
  do.
- Verb entry points counted from the `OBCD` rather than the `VERB` chunk. Every
  fixture encoded the same misreading, so the engine and the fixtures agreed.
- `startScript`'s flag bits read after its argument list, which ends on 0xFF —
  so every script in the game started freeze-resistant and no cutscene ever
  froze anything.
- Sound blocks inside `SOUN` walked with the ordinary chunk rule, when their
  sizes exclude their headers. The AdLib arrangement was never found, and v5 had
  no path from `startSound` to the renderer at all.

A second pass went wider than play could: **every verb handler on every object
in every room** — 2675 handlers across 750 objects in 96 rooms — run from a
settled game, watching for unimplemented instructions, runaway scripts and
resources that could not be found. That is the bytecode a player triggers,
without having to solve the puzzles that reach it.

It found one more, and a large one. A room number of 128 or more is a
_pseudo-room_: a name for a place whose artwork is shared with another room,
resolved through the table `pseudoRoom` fills in. The table was being written
and never read, so every one of them was a room the data file did not have.
Atlantis leans on them — walking through a door in a dozen rooms asks for 130,
132, 141, 144 and on up to 226, and each was a dead end.

Afterwards the same sweep reports nothing but two of the game's own wait-loops
spinning, both because the sweep drops into a room cold with an actor already
standing on the spot the script asks it to walk to. Saving and resuming was
checked on the real game too: a 62 KB save restores the room, the ego, the
inventory and the verb panel byte for byte, and the game keeps running.

The pattern is worth more than the list: five of the first six are a _reading of
a layout_ that produces a well-formed result, and the fixture was written to
match the reading. The one thing that settles a question like that is a shipped game's
own bytes — decoded one way they are instructions, decoded the other they are
the letters of a chunk tag.

## What Loom CD reached, and what found it

Tier 2 evidence for SCUMM v4, named the way this document asks for it.

**Loom (CD, DOS) boots, renders its skill-level screen, accepts a click on it,
and plays on into its title sequence and first room with its actors drawn.** It
is not a claim that the game is _Completable_ — nothing here has seen its last
screen — and it is not a claim about anything past that.

Four faults stood between "the resource layer reads" and that screenshot, and
every one of them is the class this document says only a picture finds:

- **The palette had a two-byte count in front of it.** A v2-v4 palette opens
  with a sixteen-bit byte count and then the triples, where v5's `CLUT` is
  triples from its first byte. Read without skipping it, every colour in the
  room is shifted by two thirds of a colour: the game renders, and renders in
  the wrong hues.
- **Charsets were numbered by their position in the folder.** v4 names them
  `900 + n`, so `901.LFL` is charset **1**. An install shipping 901 through 904
  and no 900 put its first file at index 0 and every font came out one too low —
  the game asked for the font it wanted and got the one before it. On screen
  that read as text drawn upside down, which is not a thing a font can be, and
  is what sent the search in the right direction.
- **Object images went through the v5 reader.** A v2-v4 object picture is the
  same strip table its room's background is and is _not_ a `SMAP`, so the v5
  reader found no chunk and drew nothing. Every object in the game was simply
  absent.
- **Redrawing a room used the v5 reader too.** `refreshRoomBackground` had
  diverged from the room-entry path and kept `decodeImage`, so a v4 room entered
  correctly and then redrawn by any script that set an object's state came back
  blank. That reads as a room whose art is missing rather than as a room whose
  art was thrown away.

The first two are invisible to every automated check this project has. The
report was correct throughout: rooms parsed, objects resolved, scripts ran.

Afterwards:

```
npm run unrecovered -- games/loom
SCUMM v4 "loom" — 1032 scripts
Unrecovered: 0
Read short: 0
Jump targets: 4655, of which 0 miss an instruction boundary

npm run sweep -- games/loom
Swept 697 verb handlers across 249 objects in 78 rooms.
No findings.
```

### Writing the game back out — `npm run reexport`

`CONTEXT.md` makes byte-identity a property of **unmodified** resources, and
four issues turn that into the same criterion: an exported, unedited v2, v3, v4
or v8 game is byte-identical to its input. That was asserted against synthetic
fixtures and against nothing else — Tier 1, with Tier 1's trap.

```
npm run reexport -- games/loom --sweep
```

imports a real install, exports it with nothing edited, compares every file to
the one it came from, and — with `--sweep` — loads the result and sweeps it. It
found three faults in a path with full coverage and no failing test:

- **The container writer could not export a shipped game at all.** Every buffer
  was a `number[]` filled by spreading, and a spread passes each element as an
  argument, so a `LFLF` block of a few hundred kilobytes exceeded the call
  stack. Fate of Atlantis is 9MB in one block: `RangeError: Maximum call stack
size exceeded`. Every fixture is a few kilobytes and none of them could reach
  it.
- **LOFF has two conventions and the writer knew one.** An entry points either
  at the `LFLF` chunk or at the `ROOM` block eight bytes inside it. Atlantis and
  Day of the Tentacle both do the second; the fixtures do the first. So a
  re-exported container came back with every room numbered 255 and every offset
  eight bytes short — and it still _loaded_, because `roomNumberForOffset` had
  always matched either convention on the way in. The writer's disagreement with
  the game existed only in the bytes.
- **A v4 export was not an install.** It wrote `000.LFL` and `DISK01.LEC` and
  stopped, leaving `901.LFL`–`904.LFL` behind. Nothing addresses a charset by
  offset, so no directory was wrong and nothing failed; the exported game loaded
  and could not draw a letter. The sweep of the export is what said so, with
  `Resources that could not be found (1): charset 4`.

Afterwards, all six files of Loom CD and both files of Atlantis and Day of the
Tentacle come back byte-identical, and every exported game sweeps with no
findings. Loom CD and Day of the Tentacle sweep to the same counts as their
originals (697 handlers across 249 objects in 78 rooms, and 3044 across 499 in
89). Atlantis's _room_ count is stable at 96 and its handler and object counts
are not — the sweep runs handlers that change what is in a room, so what the
next room presents depends on what the last one did. Treat the counts as a
scale rather than as a fingerprint; **no findings** is the assertion.

`npm run shot` grew a `--click=x,y@seconds` switch for this. Some games open on
something a keypress cannot get past — Loom CD asks for a skill level and waits,
and Monkey Island's copy protection waits too — and without a click there is one
screenshot to be had of those games and it is the menu, which is the frame that
says least about whether the renderer works.

```
npm run shot -- games/loom out/ --at=12,32,70 --click=160,95@12 --scale=2
```

### What the menu itself found, once somebody tried to read it

A screenshot of the skill-level screen was taken as evidence that the renderer
worked, and it was — but nobody read the screen. It was flickering through the
palette, its three buttons were empty, and its prompt was drawn twelve rows
above where the game put it. Three more pre-v5 facts, and again none of them
fails, reports anything or shows up in a sweep:

- **A pre-v5 room's colour cycles are a table, not a list.** v5's `CYCL` is a
  run of records terminated by a zero index; v2-v4's `CC` is sixteen fixed
  four-byte slots of a big-endian rate and an inclusive range, and an unused
  slot holds the rate **0x0AAA** rather than zero. Read as v5's layout, Loom's
  opening room — whose table is `0A AA 01 0E` and then thirteen empty slots, so
  it cycles nothing at all — parses as a cycle over colours 0 to 10 at six
  rotations a second. The menu's background is colour 0, so the screen flickers
  blue, green, teal and red, and the prompt vanishes each time its own colour
  comes round to the background's. (`ScummEngine::initCycl`, which branches on
  `GF_SMALL_HEADER` and skips that value by name.)
- **`print`'s actor operand is a slot number three times over.** 252, 253 and
  254 are not actors: they select the system, debug and _painted_ text slots,
  where 254's line is written into the picture and left there rather than
  spoken and timed out (`ScummEngine_v5::decodeParseString`, then
  `printString`). Read as speech, each line replaces the one before it — so
  Loom's menu drew PRACTICE, replaced it with STANDARD, replaced that with
  EXPERT and then with the prompt, leaving three empty boxes. The same
  instruction draws the dots between the distaff's notes, so this is not a
  menu-only fault: it is half of Loom's interface.
- **An image verb below v5 forgets where its picture is.** `verbOps`'s image
  sub-opcode names an object and no room, and the original copies that object's
  picture out of the _room resource_ into a resource of the verb's own
  (`setVerbObject(_roomResource, a, slot)`). Nothing is copied here, so the room
  has to be recorded and the lookup deferred; left unrecorded it defaulted to
  the room on screen. Every piece of Loom's distaff is an object in room 1 and
  the game is never in room 1, so the whole interface drew nothing — and the
  picture, once found, then had to go through the pre-v5 image reader rather
  than v5's, for the same reason room and object art does.

The first is a _reading of a layout that produces a well-formed result_, which
is the class this document says only a picture finds. The second and third are
worse than that: they are readings that produce a well-formed result **and a
plausible screen**. A menu with empty buttons looks like artwork that has not
loaded, and an interface that draws nothing looks like an interface the game
has not switched on yet.

### What playing to the distaff found

Loom is not playable in any useful sense until Bobbin has the distaff, and
nothing short of playing there finds out whether it works: the menu is drawn by
one script in one room, and the distaff is drawn by two more, from a different
room, over a hundred game-seconds later. Playing to it — cliff, village, shore,
tent, the great hall, the Loom, and then taking the distaff off the floor —
found three more, and all three are about _keeping_ something rather than
reading it.

- **A verb image below v5 keeps the picture it has when the current room
  cannot supply one.** `setVerbObject` copies the object's picture out of the
  room resource, and only when the object is one of that room's; found nowhere,
  it returns having done nothing and the verb goes on showing what it was
  showing. Loom defines its distaff once, out of room 1, and then re-positions
  those same verbs from wherever the player is — twenty-odd times a game, each
  time naming the room-1 objects again. Recorded unconditionally, the second
  definition points the staff at a room that has never heard of it: the
  interface goes blank, and unclickable with it, because a verb that draws
  nothing has no bounds to hit.
- **A painted string outside the picture survives a room change.** A room
  change redraws the main virtual screen and nothing else, so a string drawn
  into the band above or below it is still there afterwards — `drawString`
  writes into whichever virtual screen holds the row it was given. Loom's note
  names sit at row 169, under a picture that ends at 144. Cleared with the
  room, they went the first time the player walked through a door and there was
  no way to get them back.
- **The verb table and the painted strings are part of a save.** Nothing
  rebuilds either: the script that built Loom's interface has run, in a room
  the player left long ago. A save without them restored into a game with no
  distaff at all — not an interface drawn wrongly, an interface that is not
  there. Both are optional fields, so a save written before they were kept
  still loads.

The lesson the first pass had already half-learned, stated properly: a
screenshot answers _does this frame look right_, and an interface is not a
frame. It is a thing that has to survive the next room, the next hour and the
next session, and each of those is a separate question that only playing asks.

### The one no tool here could have found

Then a player said the three buttons did nothing. Everything above had been
checked: the menu drew, the labels were in their boxes, `findObjectAt` answered
with the right object, and a click walked the game into its title sequence.
Every one of those checks passed, and the player was right.

`VAR_MUSIC_TIMER` is the position of the piece that is playing, and games wait
on it. The test for "can this engine say where the music has got to" was **is
there an audio context** — a different question, which answers _yes_ in every
browser and _no_ in every tool in this repository. So where a player was, the
variable was pinned at nothing for ever; where a test was, it ran freely and
everything worked.

Loom CD is where that bites hardest, because its score is not in the game at
all: the CD release pressed it as audio tracks, so nothing is ever playing and
there is never a position to read. Its opening menu prints the prompt, waits
for the timer to pass 26, and only then arms the three buttons. The menu draws,
the prompt appears, and the game is over before it starts.

The variable now reports a position when there is one and keeps counting when
there is not, which is the invariant the original has whatever is driving it —
a sound driver's tick, iMUSE, or the position of a disc. **A timer never
stops.**

What this costs the process is worth writing down, because it is not a bug that
better test data would have caught. Every tool here — `diagnose`, `shot`,
`sweep`, `unrecovered`, `reexport`, and `vitest` — runs in Node. Anything that
behaves differently because a browser gave it a capability is, by construction,
invisible to all six at once. The two regression tests for this stub the
capability in, and that is the only shape of check that would have caught it:
not a better fixture, not more coverage, but a test that pretends to be a
browser. Where the engine asks whether it _can_ do something, the question has
to be about the thing, not about the environment that might supply it.

## What AGI has been checked against, on a retail game

Tier 2 evidence for AGI v2, named the way this document asks for it, and the
first for the family: everything else about AGI here rests on fan-made games and
the synthetic fixture.

**King's Quest III boots, runs its title, and one keypress takes it to room 7 —
the entrance hall of Manannan's house — with the player in control.** Looked at
through `npm run shot:agi` and correct: the staircase, the portrait on the
landing, the bookcase, Gwydion, the score line, the typed input line. It reports
**Unimplemented: none**. It is not a claim that the game is `Completable` —
nobody has played it to an end here.

`npm run shot:agi` is new and is what made that checkable. `render:agi` draws a
Picture _standalone_, which answers whether the decoder works; the priority
bands, the objects a Logic placed, the status line and the menu are things only
the running interpreter assembles. `--keys=13@3` is the part that mattered: a
Sierra title screen waits for a keypress and nothing else moves it on, so
without a way to press one the tool could only ever photograph the title.

### The three faults it found, none of which a test would have caught

- **The menu bar did not exist.** `submit.menu` was logged as unimplemented on
  the argument that "every controller a menu would fire is also reachable from
  `set.key`". True of some games and not this one: its File menu is the only
  route to Save, Restore, Restart and Quit. `Save  <F5>` names a key beside the
  entry, but the binding belongs to the _menu_, so the key does nothing on its
  own and a player could reach none of the four.
- **Message format codes were drawn literally.** Every AGI message is a
  template and none of `%v`, `%s`, `%m`, `%g`, `%0` or `%w` was expanded. This
  game's status line runs `display(0, 20, "%v117:%v116|2:%v115|2 ")` — the clock
  its Special menu switches on — and its twenty-two characters ran across
  `Sound:on` beside it, so the score line read
  `Score:0 of 210    So·nd·o·15]`. The clock was not wrong; it had never been
  expanded. The awkward parts are only written down in ScummVM's
  `TextMgr::stringPrintf`: `%v`'s field width counts from the _right_ of a
  fifteen-digit zero-padded number, `%0` is the digit zero rather than the
  letter o, and `%s` and `%m` expand recursively while the others do not.
- **An `else` that was not one made three Logics Unrecovered.** All three
  reported "an if jumps past the end of the block it is inside", and in every
  one the block it was said to be inside had been invented one step earlier. An
  `else` in AGI is the _shape_ where a then-block ends with a forward `goto`
  past the `if`'s own target — and that is also what an ordinary `goto` leaving
  a block looks like; the two are identical instructions. Logic 66's `if` at 678
  is a plain `if` whose block ends with `goto 718`, and read as an else it
  claimed 698-717, inside which the `if` at 701 jumps to 767. The else reading
  is now a candidate the bytecode can refute: tried, and kept only if the region
  it claims structures.

`npm run sweep:agi` is the static counterpart of `sweep:sci` and is what found
the third. It decompiles every Logic and reports what could not be read, which
attacks AGI's characteristic failure directly: a misread instruction boundary
produces a listing that looks like instructions, a tree that looks like code,
and bytes that match on re-emit — because the emitter shares the wrong table.
Over this game: **20,883 instructions, 2,069 top-level statements, 0
Unrecovered**, every Logic re-emitting to the bytes it arrived as.

### The arity table, probed rather than assumed

ADR 0013 refuses to edit on a _guessed_ interpreter version and set the bar as
reading one out of the game. This copy ships no `AGIDATA.OVL` and no
interpreter, so it was permanently uneditable.

There is a second way to clear that bar and it is ADR 0020's reasoning applied
here. The candidate space is tiny — three possible tables on DOS v2, two on v3,
because every other difference `opcodeSetFor` knows about belongs to a platform
rather than a build — and a wrong table is not quietly wrong: an opcode falls
outside the table, a code section stops decoding before its end, or an `if`
lands _inside_ an instruction rather than on one. The game's bytecode disagrees
with itself, and nothing external is consulted.

Measured on this game:

| table | instructions | unknown opcodes | Logics truncated | jumps into an instruction | not ending on `return` |           |
| ----- | ------------ | --------------- | ---------------- | ------------------------- | ---------------------- | --------- |
| 2.072 | 20,011       | 5               | 7                | 20                        | 0                      | ruled out |
| 2.089 | 20,883       | 0               | 0                | 0                         | **1**                  | ruled out |
| 2.917 | 20,881       | 0               | 0                | 0                         | 0                      | possible  |

**One survivor, so this copy is `bytecode-probe` and editable with nothing
declared.** The fifth column is what made that true and it was the last one
added: for a round this table had four columns, 2.089 and 2.917 both came out
_possible_, and the section said so — "two survivors is a narrowing and not an
identification", with the refusal standing and the editor offering a choice
between two named alternatives.

The reason no jump or opcode could separate them is not a gap in the checks. It
is a fact about the bytes: `quit`'s operand decodes as a valid instruction
either way, so both readings are internally consistent — `quit(1); goto` under
one and `quit(); increment(254); decrement(0)` under the other — and every jump
lands correctly in both.

**What is not consistent is where a Logic ends.** Sierra's compiler ends every
one on `return`, and the interpreter needs it: a Logic that runs off the end of
its code section has nothing to stop it and would execute its own message table
as instructions. Under 2.917 all 125 of this game's Logics end on `return`.
Under 2.089 logic 98 does not — its three bytes `86 01 00` read as `quit()` then
`increment(0)`, and then the section simply stops. 125 of 125 against 124 of 125
is the whole difference, and it is enough.

Recorded with its history rather than as a finished number, because the shape
generalises: a probe that leaves two candidates is not evidence that the bytes
cannot separate them, only that the criteria in hand could not. The next
two-survivor case is a prompt to look for a fifth column, not a reason to stop.

## Every AGI build and every SCI Version through one run

Run 2026-09-07 in a Sandcastle sandbox, `npx tsx .sandcastle/main.ts agi-sci` —
`docs/processes/running-sandcastle.md` has the wiring. The sibling of the SCUMM
run above and the first time either Sierra family went through one set of
commands across its whole axis on one day.

**The two axes are not shaped like SCUMM's, and the tables below are shaped
accordingly.** SCUMM has seven Versions and each fixes an instruction encoding.
An AGI major fixes packaging only — what fixes decoding is the interpreter
build — so the AGI axis is `DECLARABLE_INTERPRETERS`, the six arity tables
`opcodeSetFor` tells apart, each paired with the major `agiMajor` derives from
it. And SCI's thirteen Versions are finer than any resource map, which is the
whole of ADR 0020, so a Version is named rather than detected.

Three commands answer the two questions per row: `shot:agi` or `diagnose:sci`
for **does it play**, `sweep:agi` or `sweep:sci` for **does it decompile**, and
`reexport:agi` or `reexport:sci` for **does it come back as the bytes it
arrived as**. The last two are new — SCI had no re-export command at all, and
AGI's evidence was `sweep:agi`, which re-emits each Logic in isolation and
cannot see a resource written to the wrong offset.

**How the two play columns were filled, because it is not how the rest were.**
The sandbox produced every decode and re-export number below in one pass. It
could not produce the play columns per Target, and said so in its own report:
`shot:agi` took no `--interpreter=` and `diagnose:sci` took no `--version=`, so
AGI's boot could only be asked of whichever table the probe settled on and SCI's
of whichever Version detection chose. Nine SCI rows and three AGI rows came back
with a dash.

Both flags were added afterwards — the run's most useful output was the shape of
its own gap — and the play columns were filled on this checkout with the
commands that then existed. So those cells are a later measurement than the rest
of the table, taken by the same tools against the same data, and the run that
found the hole is not the run that filled it.

### AGI — six builds, two of them against a real game

The axis is `DECLARABLE_INTERPRETERS` — 2.089, 2.272, 2.440 and 2.917 on v2,
3.002.086 and 3.002.149 on v3. 2.072 is a candidate the probe _tests_ and not a
build a Target may name, so it appears in the probe table below and not here.

| Build     | Major | Data                    | Plays      | Decompiles                                            | Re-exports    |
| --------- | ----- | ----------------------- | ---------- | ----------------------------------------------------- | ------------- |
| 2.089     | v2    | real — King's Quest III | room 7     | 125 Logics, 20,883 instr, 0 Unrec                     | 472 / 472     |
| 2.272     | v2    | real — King's Quest III | room 7     | 125 Logics, 20,881 instr, 0 Unrec                     | 472 / 472     |
| 2.440     | v2    | real — King's Quest III | room 7     | 125 Logics, 20,881 instr, 0 Unrec                     | 472 / 472     |
| **2.917** | v2    | real — King's Quest III | **room 7** | 20,881 instr, 2,069 statements, 174 commands, 0 Unrec | **472 / 472** |
| 3.002.086 | v3    | fixture — `agi-v3`      | room 1     | 2 Logics, 11 instr, 0 Unrec                           | 5 / 5         |
| 3.002.149 | v3    | fixture — `agi-v3`      | room 1     | 2 Logics, 11 instr, 0 Unrec                           | 5 / 5         |

King's Quest III boots to room 45, and one Enter takes it to room 7 — the
entrance hall — with the player in control, the menu bar built and
**Unimplemented: none**. 472 resources is 125 Logics, 97 Pictures, 216 Views and
34 Sounds, each read back out of a full export through the reader the engine
uses. 2.917 is the build the probe identifies, and this copy is therefore
`bytecode-probe`: editable with nothing declared.

**The rows worth staring at are the three that pass and should not.** 2.089 is
ruled out by the probe — logic 98 does not end on `return` under its table — and
2.272 and 2.440 are wrong for this game too. All three decompile 125 of 125
Logics with zero Unrecovered, all three re-export 472 of 472 resources
byte-identically, and all three boot to room 7 reporting `Unimplemented: none`.
The framebuffer under 2.089 is **byte-identical** to the one under 2.917.

So on this game, at this checkpoint, every check in the toolchain agrees across
four tables of which three are wrong. The only signal anywhere is the
instruction count — 20,883 against 20,881 — and the only thing that rejects
them is the probe. That is `CONTEXT.md`'s warning under **Unrecovered** measured
on a shipped game rather than argued: _byte-identity establishes that nothing
was lost, not that anything was understood_.

The v3 rows are a fixture and say only that the tool reaches those builds. Their
probe narrows to two rather than one — 3.086 and 3.149 differ only in the arity
of `hold.key` and `hide.mouse`, which the fixture never exercises in a way that
separates them — which is expected of a fixture and not a fault. A v2 build over
v3 packaging is refused by name, so there are six rows and no more.

### SCI — thirteen Versions, one of them against a real game

| Version        | Data + layout              | Identified by | Plays               | Decodes                  | Re-exports    |
| -------------- | -------------------------- | ------------- | ------------------- | ------------------------ | ------------- |
| **SCI0 early** | **real — King's Quest IV** | **probe**     | its question screen | **159,015 instructions** | **951 / 951** |
| SCI0 late      | fixture — `sci0`           | detection     | 180 cycles          | 2 instructions, 0 Unrec  | 5 / 5         |
| SCI01          | fixture — `sci0`           | declared      | 180 cycles          | 2 instructions, 0 Unrec  | 5 / 5         |
| SCI1 EGA-only  | fixture — `sci0`           | declared      | 180 cycles          | 2 instructions, 0 Unrec  | 5 / 5         |
| SCI1 early     | fixture — `sci0`           | declared      | 180 cycles          | 2 instructions, 0 Unrec  | 5 / 5         |
| SCI1 middle    | fixture — `sci0`           | declared      | 180 cycles          | 2 instructions, 0 Unrec  | 5 / 5         |
| SCI1 late      | fixture — `sci0`           | declared      | 180 cycles          | 2 instructions, 0 Unrec  | 5 / 5         |
| SCI1.1         | fixture — `sci1-1`         | probe         | 180 cycles          | 2 instructions, 0 Unrec  | 7 / 7         |
| SCI2           | fixture — `sci32`          | declared      | 180 cycles          | 2 instructions, 0 Unrec  | 6 / 6         |
| SCI2.1 early   | fixture — `sci32`          | declared      | 180 cycles          | 2 instructions, 0 Unrec  | 6 / 6         |
| SCI2.1 middle  | fixture — `sci32`          | detection     | 180 cycles          | 2 instructions, 0 Unrec  | 6 / 6         |
| SCI2.1 late    | fixture — `sci32`          | declared      | 180 cycles          | 2 instructions, 0 Unrec  | 6 / 6         |
| SCI3           | fixture — `sci3`           | probe         | 180 cycles          | 2 instructions, 0 Unrec  | 5 / 5         |

King's Quest IV is the only row that says anything about a game. Its sweep reads
190 scripts, 604 code blocks, **159,015 instructions**, 805 objects and 1,331
methods against 510 Selector names and 98 shipped Kernel names, with zero
unknown opcodes, zero code blocks overrun, zero Kernel numbers past SCI0 early's
table, zero unresolved Selectors and zero Unrecovered. Its re-export compares
951 resources — 413 Views, 155 Scripts, 150 Pictures, 139 texts, 80 Sounds, 8
vocabs, 4 fonts, 2 cursors — and every one comes back byte-identical, with the
linker never running and four Volumes carried through unrebuilt.

**"180 cycles" is a reach check and not a play.** A fixture is one script; it
loads, resolves the game object, sends `play`, turns its main loop for three
seconds with every Kernel call a script makes implemented, and draws no Picture
and enters no room, because there is no room in it. The column says the Version's
tables were built and its decoder ran. It does not say a game did anything.

**Nine of the thirteen rows are a Version declared over a layout belonging to
another Version**, and the distinction is the point rather than a footnote. Four
fixture builders cover four of the six map structures `detectMapVersion`
separates, so SCI1 middle's row is that Version's Kernel table and decoder asked
to read a SCI0-shaped map. It checks the half of a Version that lives in the
tables. It is not a reading of a SCI1 middle game. The four that are native to
their layout — SCI0 late, SCI1.1, SCI2.1 middle, SCI3 — are marked `detection`
or `probe` rather than `declared`, because naming the Version detection had
already chosen is not a declaration, and the tools decline to count a no-op as a
decision.

### What this run found

**`declared` existed as a value and no code produced it.** ADR 0020 lists it as
one of the ways a SCI Version is established, and `describeUneditableTarget`
tells an author to use it when the probes leave more than one Version standing.
Nothing in the codebase could. The identification was reachable in the type and
by no path, so the refusal named a remedy a person could not take — which is
why `--version=` now exists on three commands and `declaredVersion` on
`SciEngine`.

**AGI's export had no whole-install check.** `sweep:agi` re-emits each Logic
against its own bytes, which cannot see a Logic written to the wrong offset,
indexed under the wrong volume, or obfuscated with the wrong key. The first
version of `reexport:agi` compared _files_ and reported King's Quest III as a
catastrophe — 78,782 bytes of `VOL.0` in, 650,064 out — which is not a fault
but the export doing what it documents: a game that shipped four volumes is
repacked into one. Comparing resources instead gives 472 of 472, and the
lesson is in the tool's header so the next reader does not repeat the half-hour.

**A fixture failed a check a real game passes.** `vocab.997` in `fixtureSci.ts`
declared two Selectors and supplied one — the count field is a short count and
the second offset ran off the end — while the object in `sci0Script` names
Selector 1. Every SCI layout reported `FAIL unresolved Selectors: 1`, and
King's Quest IV, with 510 names, reported none. Tier 1's trap running backwards:
the fixture was teaching that the tool was wrong.

**And the documentation was a round behind the code.** The probe gained a fifth
criterion in `04adb9f` — whether every Logic ends on `return` — which rules out
2.089 for King's Quest III and settles it to one table. Two places still
described the round before: this document's four-column table, and
`InterpreterIdentification`'s own comment, which used the game as its example
of a probe that _cannot_ decide. Both are corrected above. Running the matrix
and comparing the output against what was written down is the only check that
finds this class, and nothing automates it.

### What this run could not establish

- **Seventeen of the nineteen rows had only a fixture**, and a fixture row says
  the tool reaches that Target and nothing about a shipped game — the fixture
  encodes this project's reading of the format, so it and the engine agree by
  construction. Only King's Quest III and King's Quest IV are evidence about
  games.
- **Twelve SCI rows are a declared Version over a foreign layout**, named per
  row above. A Kernel table checked against real-shaped bytes is worth having
  and is not a Version reading its own game.
- **Two commands did not exist when the run needed them**, so nine SCI rows and
  three AGI rows had no play evidence in the report itself. Both flags exist now
  and those cells are filled above, but by a later measurement on a different
  checkout — noted rather than smoothed over, because a table whose cells come
  from two occasions should say so.
- **One frame was looked at, and it was AGI's.** King's Quest III's room 7 was
  rendered and inspected against the description recorded earlier in this
  document — staircase, portrait, stained glass, bookcase, Gwydion, the score
  line reading `Score:0 of 210` with `Sound:on` beside it rather than running
  over it. That is a frame checked by eye in the weak sense: an agent compared
  it against prose in this repository. It is **not** a person with the game
  confirming a Tier 2 checkpoint, and it does not move King's Quest III's
  status.
- **King's Quest IV can be taken past its copy protection headlessly, and the
  blank screen was the game quitting.** The claim that "the accepted words are
  in the printed manual and not in the data" was half wrong: the expected word
  is the second operand of the `StrCmp` the dialog makes, so logging that call
  recovers it — `BOBALU` for the question this copy poses. Fed it with
  `--type=BOBALU --play`, `StrCmp` returns `0`, the dialog closes on a right
  answer, and the game draws Pictures 700 → 96 → 698 → 201 — its opening throne
  room, 26 distinct colours, ten to twelve cast members animating, the magic
  mirror appearing on the wall. The earlier "went blank under `--play`" was not
  the continued clicking: `--play` with no typed answer presses Enter on a blank
  field, the game compares blank against `BOBALU`, and on a wrong answer script
  701 sets the quit global (`ldi 1; sag 4`), so `Game::play` returns and the
  machine runs out of frames. That is King's Quest IV quitting to DOS, measured
  and named rather than guessed at. It does **not** move the game's status: this
  is a screen reached under a script, not a person confirming a Tier 2
  checkpoint. What the intro does past it was measured further: over forty-five
  seconds the throne room animates (`Animate`/`Wait`/`GetTime` climb ~5×) but
  draws no new Picture (`DrawPic` stays at five), and part of even that reading is
  the tool disturbing the scene — `--play` keeps clicking after the dialog closes,
  which the game reads as sixty-one no-op `RestartGame` calls where a silent run
  makes it zero and lets the cast grow from ten to twelve. Whether the cutscene
  completes on its own is unresolved and is the next thing to instrument.
- **_Completable_ was not approached**, for either family. It is a Tier 2 claim
  about a game's last screen and no command in this repository can make it.
  Nothing above changes any Target's support status; that remains this
  document's process.

## Where AGI's free data comes from

AGI has more of it than SCUMM, and from a different place. Sierra's own AGI
games are not freely distributable, but AGI Studio and WinAGI produced hundreds
of **fan-made games** over twenty-five years that are, several of them listed on
ScummVM's freeware page. They are real AGI data: real `*DIR` indexes and `VOL`
volumes, real Logic bytecode, real vector Pictures. For the fault class Tier 1
structurally cannot find, that is worth more than a demo.

**They are still never committed.** `games/*` and `public/games/*/` stay
gitignored, and `public/games/` in particular deploys to the live site, so
committing anything there would be redistributing someone else's game from our
own domain. The rule does not bend for a permissive licence: this project ships
no game data, full stop, and that sentence in the README is load-bearing.

So a script fetches them into `games/` on request, for local diagnosis only, and
CI stays on the synthetic fixture. The consequence is accepted rather than
worked around: **AGI keeps exactly the blind spot SCUMM has** — a fixture and an
engine that agree with each other — and Tier 2 for AGI still means a person with
a copy of King's Quest 1 confirming a named checkpoint.

A fan game cannot establish _Completable_ for a Sierra title either. What it can
do is find the reading-the-format faults before a human with real data wastes an
evening on them.

## Where SCI's free data comes from

Better than AGI's, and the brief for #215 was wrong about the important half.

**Sierra's own SCI demos are freely distributed, and they cover the whole
family.** ScummVM offers around seventy of them at
[scummvm.org/demos](https://www.scummvm.org/demos/), and between them they reach
every Version on the axis — including the three that #215 recorded as having no
free data at all:

| Version            | Freely distributed demo                                 |
| ------------------ | ------------------------------------------------------- |
| SCI0 early         | Christmas Card 1988, King's Quest IV                    |
| SCI0 late          | Space Quest III, Leisure Suit Larry 2                   |
| SCI01              | King's Quest I (SCI)                                    |
| SCI1 EGA-only      | Quest for Glory II                                      |
| SCI1 early         | Christmas Card 1990 (VGA), Mixed Up Fairy Tales         |
| SCI1 middle        | Leisure Suit Larry 1 (SCI)                              |
| SCI1 late          | Conquests of the Longbow, Police Quest 3, EcoQuest      |
| SCI1.1             | King's Quest VI, Freddy Pharkas, Quest for Glory III    |
| SCI2               | Gabriel Knight, Police Quest IV, Quest for Glory IV     |
| SCI2.1 early       | King's Quest VII, Gabriel Knight 2                      |
| SCI2.1 middle      | Space Quest 6, Torin's Passage, Phantasmagoria, Shivers |
| SCI2.1 late / SCI3 | Leisure Suit Larry 7, Lighthouse, RAMA                  |

So the standing limitation #215 asked to record — "no free data for half the
family" — **is not the situation**, and recording it as though it were would
have left #225 through #229 building against a fixture on purpose. What is true
is narrower and still worth saying: there are no _fan-made_ SCI32 games, because
no fan toolchain targets SCI32, so for SCI2 and later the free data is Sierra's
own demos and nothing else. A demo is a smaller game than a release and a
non-interactive one is smaller still, so it exercises less — but it is real data
written by the interpreter this project is reading, which is the whole property
Tier 1 cannot have.

**Fan-made games matter for SCI0 and SCI1.1.** SCI Companion produced them the
way AGI Studio did for AGI, and they are the only free data for those Versions
that is a _whole_ game rather than a demo slice.
[sciprogramming.com](https://sciprogramming.com/fangames.php) has the archive.

**Nothing is ever committed.** `npm run fetch:sci` writes `games/*.zip` and
`games/LICENCES.txt`, and both are gitignored. `public/games/` deploys to the
live site, so committing there would be redistributing someone else's game from
our own domain, and the rule does not bend for a permissive licence.

> **A finding worth acting on separately.** The `games/*` line in `.gitignore`
> is commented out, and real game data is tracked in this repository —
> `games/dott/TENTACLE.000`, `games/fate/ATLANTIS.000`, `games/loom/*.LFL`.
> That contradicts the README's "It ships no game data", which is described
> above as load-bearing. #215 only asked that what its own script writes be
> covered, and that is what has been changed here; putting `games/*` back would
> hide the tracked data rather than remove it. Removing it is a decision about
> this repository's history and belongs to whoever owns it.

A demo cannot establish _Completable_ for a Sierra title, and neither can a fan
game — the same rule AGI already carries. What they can do is find the
reading-the-format faults before a person with a real copy wastes an evening on
them, and for SCI that is a larger share of the work than for either sibling,
because SCI stamps its Version nowhere and every probe in ADR 0020 is a claim
about real bytes.

## What SCI has actually been checked against

Written as a record rather than a claim, because this document's own warning
applies hardest here: a fixture and an engine that agree with each other prove
nothing, and for SCI2 and later there is no fan toolchain to disagree with them.

Everything below is `npm run sweep:sci`, `npm run shot:sci` and
`npm run diagnose:sci` over the 25 freely distributed Sierra demos listed
above. The third is new: `sweep:sci` is static and decodes every Script
resource without running one, `shot:sci` renders a Picture standalone, and
neither answers what a game is doing after it has been running for a while.
That gap is why this document could publish "the events are not reaching the
scripts" and be wrong about it for a round. **None of it is Tier 2.** No SCI
game has a named checkpoint confirmed by a person with a copy, so no SCI Version
is `Completable` and none is supported in the sense `CONTEXT.md` means.

### The first retail SCI game, and what three faults it named

**Everything above this heading was measured against demos.** King's Quest IV
1.000.111 — SCI 0.000.274, September 1988, the first build of the engine that
ever shipped — is the first _retail_ SCI game this project has been pointed at,
and it is worth its own section because a demo is a subset and a retail game is
not: 190 Script resources against a demo's fifteen to forty, 1,578 resources
across nine volumes, and 159,015 instructions.

It booted to **"The game object answers no `play` method"**, which was true and
was three faults deep. All three are the same fact seen from different places:
**SCI0 early spends the low bit of a Selector ID on a read/write toggle.**
ScummVM's `kernel.cpp` says so in one comment — "Early SCI versions used the LSB
in the selector ID as a read/write toggle. To compensate for that, we add every
selector name twice" — and the consequences are in three separate files.

1. **The numbering is doubled.** The game ships a 255-entry `vocab.997` and its
   own game object's method dictionary asks for Selectors 444 and 446, which no
   255-entry table can hold. The class dictionaries say it more plainly: every
   SCI0 class begins `species`, `superClass`, `-info-`, `name`, and this game's
   first class lists those four as 0, 2, 4 and 46 — Sierra's 0, 1, 2 and 23,
   doubled. Read undoubled, no `play` exists to send.
2. **A lookup has to mask the bit off.** The dictionaries hold only the even
   form, so a _write_ arrives as the odd one: script 994 sends 413 to a class
   whose dictionary lists 412. ScummVM masks it in `lookupSelector`; so does
   this, in `resolveMethod` and `resolveProperty` rather than at one call site
   that would leave the others wrong.
3. **`callk` must not spend the `&rest` adjustment here.** Every other consumer
   of a parameter block has to, and ScummVM's `op_callk` guards all three of
   its `r_rest` lines with `if (!oldScriptHeader)`. `firstTrue` in script 999 is
   built on that: `push0 · rest 2 · push1 · lats 0 · callk NodeValue · send 4` —
   the `&rest` belongs to the `send`. Spending it early handed `NodeValue` the
   word `&rest` had pushed instead of the node, and the game halted on "send to
   0:0" three instructions downstream of the fault.

Each was found by measuring rather than by reading: the first from the method
dictionary's own numbers, the second from the halt message, the third from a
`--trace` of the six instructions before the halt.

**Four more faults stood between the title screen and the game**, and each was
found by measuring the one before it.

- **`kDisposeClone` marks; it does not free.** Sierra's interpreter defers to
  the next garbage collection and scripts rely on the gap: script 989 reads
  `-info-`, ORs 2 into it, sends `dispose` to itself, calls `DisposeClone`, and
  _then_ writes the saved `-info-` back — `989:47 lat 0 · aTop 4`. Freeing at
  the call made that write land on nothing. ScummVM frees only when
  `(-info- & 3) == kInfoFlagClone`, with a comment naming this game.
- **Deferring without collecting is a leak with a stopwatch on it** — 50,121
  live Clones in twenty seconds. A mark and sweep over _marked_ Clones only
  fixed it: an unmarked Clone is live by definition, so the collector can never
  take something a script merely happens not to be holding this cycle.
- **`CanBeHere` answered no to everything.** `findPosn` tries a position, asks,
  and tries another, so a kernel that always says no never lets the loop end —
  the throne room spent 385,000 calls in it, which reads in a report as a game
  that is running.
- **An EGA cel's run is the high nibble and its colour the low one**, and this
  engine had them the other way round. So did the fixture: they agreed with
  each other and disagreed with every SCI0 game, which is this document's
  opening warning caught in the act. View 879's first cel is 46 pixels wide and
  opens `f0 f0 f0 10` — three runs of fifteen and one of one, exactly 46. Read
  the other way, `f0` is colour fifteen for a run of _nought_: every byte wrote
  nothing while the reader advanced, and every actor in every SCI0 game came
  out as a column of stripes.

**Where it stands.** The game boots and, on a keypress at each screen the way a
player gives one, walks its whole opening: Picture 991, the Sierra logo at 700,
96, its title screen at 698 — the two heralds — and then **Picture 201, its
opening throne room, with five cast members on it and Graham and Rosella
recognisable**. 82% of the framebuffer painted, the main loop turning with no
halt, 800 live objects rather than 50,876. `npm run sweep:sci` reports
**nothing at all**: no unknown opcodes, no code blocks overrun, no Kernel
numbers past the Version's table, no unresolved Selectors where there were 68,
nothing Unrecovered. It imports as a class graph of 805 objects and 1,331
methods with nothing Unrecovered and every method named from the game's own
table.

### Text, which took three readings and a measurement to get right

A control's label was empty and every window was a box with nothing in it.
Three faults, and the third is the one worth keeping.

**A SCI string is wherever the script put it, and there are three places.** The
heap, which is what the interpreter allocated. A script's own data, where every
literal lives — this game's buttons are `"Yes"` at `699:1748` and `"No"` at
`699:1752`. And a _variable bank_: `lea` hands out the address of a local, and
a string built at runtime is packed two characters to a word inside one. A
reader that knew only the heap answered `""` for the other two, so `TextSize`
measured nothing, every control's rect stayed 4,4,4,4, and `DrawControl` had
nothing to draw. `StrCmp` finding two empty strings equal is a different wrong
answer from the same cause.

**Reading widely everywhere was tried, measured and rejected.** The generic
string calls take whatever a script hands them, and in SCI0 that is routinely a
_word index_ into a bank rather than a byte pointer — which this register model
cannot tell from a byte pointer. `StrEnd` advances a reference by a string's
length, and doing that to a word index addresses the wrong variable: the game
went from its throne room back to a blank screen. So the wider reader goes to
the calls that are _documented_ to take text — a control's label, `TextSize`'s
measurement, `Display`'s line — and the calls that do arithmetic on a string's
address keep the narrow one until the address model carries the distinction.

**`Display`'s first argument is a string _or_ a pair.** ScummVM's `kDisplay`
branches on `textp.getSegment()`: a reference is the string, and a bare integer
is a `text` resource number with the line's index in the next argument. This
engine assumed the reference form always, so on the pair form it began the
attribute walk on the _line index_ — which is exactly the "Display attribute 0
is not implemented" this game reported and stopped on. Read properly, the
opening asks for `© 1988 Sierra On-Line, Inc.` at 170,70.

### The first screen is the copy protection, and it was invisible

**King's Quest IV opens on a manual check.** It formats a question, sizes a
window around it, opens the window with a text field in it and waits. The
engine ran that loop correctly — `EditControl` against `GetEvent`, thousands of
times — while a player saw a black screen with nothing to answer, which is the
worst version of this project's characteristic fault: the game doing exactly
the right thing and the screen showing none of it.

Seven faults between that and a dialog a person can read, type into and answer,
each found by measuring the one before it.

- **`Format` was a stub.** The question is formatted into a buffer whose
  address becomes a `DText`'s `text`, and the window is sized from `TextSize`
  of the result — so with `Format` writing nothing, every step after it was
  correct about nothing. It is Sierra's `sprintf`, from ScummVM's `kFormat`.
- **A `lea` address did not survive the frame that took it.** Which bank a
  _kind_ names depends on the frame, and this address is stored in an object
  and read back from another. The bank is resolved where `lea` runs now.
- **A `lea` address has to look like an address.** Scripts tell a pointer from
  a small number by magnitude — this game's `GetFarText` wrapper opens
  `if (param1 < 1000)` — so a bare index of 300 took the branch that asks for a
  text resource that does not exist. Addresses are byte offsets from
  `ADDRESS_BASE` now, which also makes `StrEnd` uniform.
- **A bank view was bounded by the array's length rather than the bank's
  capacity**, so a `Format` into index 300 of a 300-long bank wrote nothing.
- **The fonts were never pre-loaded**, so `TextSize` measured `null` for fonts
  the game ships — and the window it sized from that came out eight pixels
  wide.
- **A width of nought means the screen, not "do not wrap"** — Sierra's
  `GfxText16::Size` substitutes the screen width. Measured unwrapped, the
  refusal message came out 1,093 pixels wide at x = -386.
- **`Display`'s attribute codes were wrong**: font was recorded at 102, which
  is the pen colour, and the foreground at 103, which is the background.

And the two calls with nothing behind them at all — **`NewWindow` and the
port**. A window is a frame, a title bar and a port now, and a control's
rectangle is measured from that port rather than from the screen, which is what
a SCI16 game's entire interface rests on. **`EditControl`** inserts at the
cursor, backspaces, moves on the arrows, claims the key so the dialog does not
also act on it, and repaints the field the way `kernelTexteditChange` does.

**What that adds up to, and it is Tier 2.** King's Quest IV draws its question,
takes a typed answer and acts on it. A wrong one gets Sierra's own refusal —
"Sorry, what you just typed does not match the King's Quest IV manual" — laid
out and readable. A right one takes the game through the Sierra logo, its title
banner, the heralds and into **its opening throne room, with Graham and Rosella
on it**, looked at and correct.

`npm run diagnose:sci -- <game> --play --type=<word>` is how that is checked
from now on. A Sierra game of this period can open on a question, and clicks
and blank Enters cannot answer one — which is why every earlier round of this
document reported King's Quest IV as running and going nowhere.

### Booting, which is the honest answer to "does it play"

> **Superseded in part, and the correction is the point.** This section used to
> open "No SCI game reaches its first screen yet." **Four now draw a room, and
> two of those have been looked at.** What changed is recorded under "Four
> games reach a screen" below; the history is kept because the faults it names
> are the record of how the class was found, and because two of its claims had
> already been withdrawn once.

All 25 construct an engine, load
their scripts, resolve export 0 of script 0 to the game object and enter its
`play` method. What happens next was measured rather than assumed, and measuring
it found three faults, each hiding the next:

1. **Property access was not executing at all.** `pToa` and its siblings are
   opcodes 0x31 to 0x38; the branch that handles them was gated on
   `opcode < 0x20`. They fell through to the variable grid, where `family` is
   `(0x31 - 0x40) >> 4` — minus one — which reaches its `default` arm: a
   decrement. A property holding zero read back as `(0 - 1) & 0xffff`, and that
   0xffff is what every SCI16 game's boot then sent to and halted on.
2. **A SCI1.1 script's object exports are measured from the heap**, so export 0
   of script 0 — the game object every boot sends `play` to — resolved to
   nothing.
3. **SCI1.1 objects were built with no method dictionary at all**, so the first
   send resolved to nothing even once the object was found.

The first was diagnosed backwards from the halt and the first attempt named the
wrong cause, which is recorded above rather than quietly corrected: the halt was
three instructions downstream of the fault, so the receiver's property table did
not explain the value in the accumulator, and the honest answer for one commit
was "not established".

Two more followed once those three were out of the way:

4. **A plain `send` gave the callee the caller's `self`.** The three sends
   differ in two things — where the method is looked up, and what `self` is
   inside it — and only `super` decouples them. So a method found on another
   object ran with `self` still pointing at the caller, and its own `self` send
   looked for a Selector on the wrong class. The frame dump is what showed it:
   `self` species 62, method owner species 4, and no path between them.
5. **`render` cleared the screen before the dirty-rect redraw** — introduced in
   this same branch when `composite` became `compositeDirty` and the `clear(0)`
   above it was left. A dirty redraw repairs what changed and leaves everything
   else; clearing first throws away exactly the pixels it relies on.

**Where it stands now.** King's Quest IV and RAMA each execute **two million**
instructions continuously with no halt. Conquests of the Longbow reaches
`DrawPic` and its Picture is composited to the framebuffer — 60,800 of 64,000
pixels — which is the whole pipeline working end to end: script, Kernel call,
vector Picture, Plane, compositor, screen. That particular Picture is genuinely
near-blank (eight drawing operations), so the screenshot is a flat fill and
`shot:sci` renders the same thing standalone; it is the pipeline that is
demonstrated, not a room. Castle of Dr. Brain runs 2,422 instructions, Space
Quest 1 1,764, Fairy Tales 1,471.

**The sixth fault was four opcodes at once, and it made every earlier number
suspect.** The variable grid is opcodes 0x40 to 0x7f; reaching it with anything
below computes a negative `family`, lands on the switch's `default` arm and
_decrements a variable_ — sometimes pushing the result. So `call`, `callb`,
`calle` and `rest`, none of which had a case, each did something plausible
instead of nothing. The grid now refuses anything outside its range, by name,
which turned four silent corruptions into named failures — and revised the
headline downward and truthfully: **King's Quest IV's two million instructions
were an illusion**, it was looping on corrupted state.

**The seventh was `callk` not spending the `&rest` adjustment.** Every consumer
of a parameter block has to; the Kernel call popped only the arguments its own
byte count named, and the leftover shifted the _next_ send by one word. That is
what "299 arguments" for a send of three words was. All five block
misalignments went with it.

**The eighth was that object properties were numbers.** SCI's `reg_t` is a
segment and an offset, and a property holds one. Holding them as 16-bit numbers
meant a property could carry an object's offset and never its segment — so
`lea`, whose result is stored with `aTop` and used later, could not work at all.
An attempt at `lea` alone crashed Conquests of the Longbow and was reverted; the
model it needed was `variables: Reg[]`, which also required save format 2,
because format 1 could not restore a property holding an object pointer — the
thing ADR 0019 names as deciding correctness.

`info` and `superP` followed, and **every opcode the table decodes below the
variable grid is now implemented.**

Six more followed, all in the SCI1.1-and-later half:

- **No SCI1.1-or-later class was ever registered.** The test was "does it carry
  variable Selectors", true of an inline class and never of a heap object. The
  class table was empty for every SCI1.1, SCI2, SCI2.1 and SCI3 game, so `play`
  — which the game object inherits — resolved to nothing. **Ten games executed
  zero instructions because of one predicate.**
- **A SCI1.1 `lofs` operand is measured from the heap**, and the address it
  gives names an object's header, so it needs the four-byte translation the
  export table does.
- **A SCI1.1 class names its properties' Selectors in the code resource**, at
  the object's first variable.
- **SCI3 scripts were routed to the heap reader**, which returned them empty;
  their exports can be placeholders relocated through the table at the header's
  third word; and their object size word is in **bytes** where a heap object's
  is in words.
- **A script is routed by whether it ships a heap, not by its Version.**
  EcoQuest and Quest for Glory III are bucketed SCI1 late and ship one beside
  every script, and asking the Version sent them to the inline reader.
- **There are three Selector numberings, not one.** SCI1.1 dropped `species`,
  `superClass` and `-info-` from the front, so everything shifts down three —
  `play` is 39, not 42. SCI2 is not a shift at all: the compositor's own
  Selectors arrive at the front and displace the rest unevenly, putting `play`
  at 51 and `doit` at 69. Four demos ship no `vocab.997` and could not find
  `play` at all until each got the right one.

Both fallback tables are derived from games rather than transcribed: every index
where ten SCI16 demos agree (82 entries), and every index where four SCI32 demos
agree (79). The SCI32 one's check is Torin's Passage, which ships no table and
whose chain answers 51, 69, 73, 82 and 83 — the derived list exactly.

**Where it stands: twenty-three of the twenty-five demos execute**, against
fifteen when this work started. Four — King's Quest IV, Fairy Tales, Conquests of
the Longbow and RAMA — run two million instructions continuously without
halting. **Conquests of the Longbow reaches `DrawPic` and its Picture is
composited to the framebuffer**, which is the whole pipeline end to end: script,
Kernel call, vector Picture, Plane, compositor, screen.

> **A claim withdrawn.** Space Quest 1 was reported here as doing the same. It
> reaches a corrupted variable index at 3,709 instructions and drew its Picture
> _after_ that, through state a later guard stops on — the same shape as "King's
> Quest IV executes two million instructions", which this document also had to
> withdraw. Longbow's stands: it hits no bound.

The two that do not execute are named rather than lumped together. **Lighthouse**
needs the SCI3 method dictionary, which was derived as far as its group-location
array and 64-byte stride and no further; the evidence and the contradiction are
in `SciScripts.loadSci3`. **The Christmas Card 1988 has no `play` at all** — 111
objects and not one answers Selector 42, where King's Quest IV has two. That is
a fact about the card rather than a defect in the reader, and the engine's
message about it is correct.

**The four that do not halt are not stuck — they are waiting for the player.**
That was established by counting Kernel calls rather than assumed from the
instruction total: Conquests of the Longbow calls `GetEvent` 3,077 times in
thirty cycles, King's Quest IV `Animate` 4,475 times, and Mixed Up Fairy Tales
reaches `EditControl`, which is a text prompt. They are running their main loops.

Feeding keypresses and clicks into the queue does not advance any of them, and
the first reading of that — "the events are not reaching the scripts" — was
wrong. Instrumenting the queue shows King's Quest IV polling with mask `0x7fff`
8,939 times in sixty cycles and **consuming all twelve injected events**, its
queue empty at the end. The input path works; the game takes the input and does
not proceed.

So what stands between here and a room is further in than the event queue, and
this document does not yet know where. Recorded as a correction rather than
quietly replaced, because the wrong reading was published here for a round.

**No game reaches a playable screen**, so #219's "makes a SCI game playable",
#228's and #229's "reaches its first playable screen" are not met. Every halt
now names an instruction, an object or a resource, and the two reverted attempts
and two withdrawn claims are recorded above with their numbers.

### Four games reach a screen, and two have been looked at

`npm run diagnose:sci -- <game> [seconds] --play --png=FILE` boots a real game,
runs it, clicks and types, and writes the framebuffer the browser would paint.
That command is new and it is what everything below was measured with — the
previous round's evidence came from throwaway scripts, and a throwaway script
is an anecdote rather than something the next round can be compared against.

**Conquests of the Longbow's title screen renders correctly.** Robin Hood, the
bow, the forest, from the running game rather than from a Picture rendered
standalone: script, Kernel call, Picture, embedded cel, Plane, compositor,
palette, framebuffer. **Castle of Dr. Brain's title screen renders** — the
castle, the mountains, the bridge — with 25 screen items on its Plane and 2,194
`Animate` calls behind it. Space Quest 1 and Mixed Up Fairy Tales draw their
Pictures too and have not been looked at as closely.

**It is still not Tier 2 and it is not `Completable`.** A title screen is not a
playable room, nobody has played one of these games, and every one of the four
is a demo. What it is worth is the fault class: three of the four faults below
are ones where the game did exactly the right thing and the picture was wrong.

- **An export entry is two bytes or four, and the block size says which.**
  Conquests of the Longbow halted on `lat 36609` — a variable index no bank
  could hold — six instructions into a frame pushed at the wrong place by a
  `calle` resolved through an export table read at the wrong stride. The stride
  is not a Version's: the Christmas Card 1990 writes two bytes per export and
  Leisure Suit Larry 1 writes four, and both are `SCI1 early`. Only one stride
  reconciles a table's own count with its own size, which is ADR 0020's
  reasoning about probes applied to a table. Read narrow, a wide table gives
  the right offset for every even export and zero for every odd one — half
  plausible, half a frame pushed at offset zero, and nothing reporting
  anything. It moved four games: Castle of Dr. Brain, Space Quest 1 and Mixed
  Up Fairy Tales from halting before any Picture to drawing one, and Conquests
  of the Longbow from halting to not halting at all.
- **A SCI1 VGA Picture's background is an embedded cel, and it was dropped.**
  All 85 vector Pictures across the nine SCI1 VGA demos carry one and 81 are
  full screen: the vector half paints the priority and control buffers and the
  visual half _is_ that cel. It was collected into an array nothing consumed,
  so every VGA room rendered black with its actors floating on it. SCI0, SCI01
  and SCI1 EGA-only carry no embedded cel at all, which is why a renderer
  written against SCI0 draws those correctly and gave no hint. Castle of Dr.
  Brain went from 16.6% of its framebuffer painted to 68.8%.
- **The ten rows are at the top.** A SCI16 Picture is 320x190 on a 320x200
  screen and the rows it does not cover are the status bar. Placed at zero, a
  room renders complete with a black band along the bottom and every actor ten
  rows high — a picture nothing in a log disagrees with. Derived from the two
  heights rather than branched on the Version, so SCI32's full-size Planes land
  at zero by the same arithmetic.
- **A black PNG out of a framebuffer holding 187 colours** was the new
  command's own fault and is worth recording as the shape of it: the palette
  combines a base, a cycled copy and an intensity on demand, and a writer that
  does not call `flush` gets zeros. The engine was correct throughout and the
  picture was black.

### Sixteen of the twenty-five run, and three draw a room a person has checked

**Police Quest 3 reaches its opening car park scene**, **King's Quest IV its
throne room**, and **EcoQuest its underwater credits sequence** — 95.3% of the
framebuffer painted, seven cast members on the Plane. All three are drawn from
the running game rather than from a Picture rendered standalone, all three were
looked at, and all three are correct.

That is the evidence this document asks for — _"Treat a demo as Tier 2 evidence
for what it actually reaches, and name that."_ It is **not** a claim that any of
them is `Completable`: nobody has played one, nothing has seen a last screen,
and all three are demos.

|                                               | when this work started | now    |
| --------------------------------------------- | ---------------------- | ------ |
| demos that run without halting                | 3                      | **16** |
| demos drawing a Picture from the running game | 1                      | 12     |
| rooms a person has looked at and confirmed    | 0                      | **3**  |

**Four of the five SCI1.1 demos now run**, which they did not before, and none
of them draws a room. `Message` and `TextColors` were implemented on the
strength of their being the only unimplemented calls those games reached —
**and that closed the two gaps without producing a room**, which is recorded
because it removed two candidates rather than answering the question.

What the games are actually doing was then measured rather than assumed, and it
is not one thing:

- **Freddy Pharkas is sitting at a modal text-input control.** `EditControl` is
  called 1,089 times and the stack reads `showControls → show → dispatchEvent →
firstTrue`. The game is running its dialog loop correctly and waiting for the
  player. Nothing is on screen because **controls, windows and text are not
  rendered** — `DrawControl` is called once, `Display` once, and neither draws.
- **Island of Dr. Brain and King's Quest VI are running main loops** — 2,018
  and 6,548 `Animate` calls against as many `GetEvent`s — on a Picture that is
  genuinely near-blank. King's Quest VI's Picture 98 renders blank standalone
  through `shot:sci` too, so that is the artwork rather than the decoder.

So #221's remaining work is a **rendering subsystem** — the window, the control
and the text drawing a SCI1.1 game puts its interface in — and not a decoder or
a Kernel gap. The font reader built for #220 is what that would draw with; there
was none before this branch.

### The fault that did most of it: a heap class's property table

A SCI1.1 class names the Selector each of its properties answers to in a table
in the code resource, and **that table has an entry for every property including
the two in the object's header**. Its first two entries are `-objID-` and
`-size-`, which live at the object's first two words, and `variables` starts
past them — so the table holds `words` entries where `variables` holds
`words - 2`, and they line up only after the first two are dropped.

Reading `words - 2` entries from the front was wrong twice over: every Selector
resolved to a property **two slots too early**, and the **last two properties of
every class had no Selector at all**.

**The selector lists are what gave it away.** Class after class ending at 303,
304, 305 — and the number being asked for one or two past the end. Island of Dr.
Brain sends 306 to a class whose list ends at 304.

Naming those numbers needed a trick worth keeping: **seven of the demos ship no
`vocab.997` at all**, so a Selector number has nothing to resolve against. King's
Quest VI ships the standard 4,104-entry table, and reading the missing numbers
out of _its_ table named them — 306 `detailLevel`, 373 `iconBarInvItem`, 375
`selectIcon`, 166 `nextAction`. Every one a game-defined property, which is what
said the fault was in the class table rather than in the send.

Five games stopped halting: EcoQuest, Freddy Pharkas, Island of Dr. Brain,
King's Quest VI and Quest for Glory III.

### Eleven of the twenty-five ran, at the round before

**Police Quest 3 reaches its opening car park scene** — the car under the
streetlamp, the shop signs, the parking bays — and **King's Quest IV reaches its
throne room**. Both are drawn from the running game rather than from a Picture
rendered standalone, both were looked at, and both are correct. Police Quest 3
paints 79.5% of the framebuffer with two cast members on the Plane, a cursor
set, and its main loop turning: 5,656 `Animate` calls and 25,106 `GetEvent`
calls with every injected event consumed and the queue empty.

That is the evidence this document asks for — _"Treat a demo as Tier 2 evidence
for what it actually reaches, and name that."_ It is **not** a claim that either
game is `Completable`: nobody has played one, nothing has seen a last screen,
and both are demos.

|                                               | when this work started | now    |
| --------------------------------------------- | ---------------------- | ------ |
| demos that run without halting                | 3                      | **11** |
| demos drawing a Picture from the running game | 1                      | 8      |
| rooms a person has looked at and confirmed    | 0                      | 2      |

The eleven are Castle of Dr. Brain, the Christmas Card 1988, Mixed Up Fairy
Tales, King's Quest I, King's Quest IV, Lighthouse, Conquests of the Longbow,
Leisure Suit Larry 2, Police Quest 3, RAMA, Space Quest 1 and Space Quest III.

### The two faults that did it, and how each was found

Neither failed, logged anything, or could have been found by a test.

**An indexed store leaves its value in the accumulator.** An assignment is an
_expression_ and Sierra's compiler chains onto its value: `(send (= temps[i]
(Class new:)) init: x draw:)` emits the `new:`, a `push` of the object, the load
that puts `i` in the accumulator, the indexed store, and a `send` whose receiver
is the accumulator. Leaving the _index_ there sends to a small integer. Castle
of Dr. Brain at 255:5223 is exactly that — `push · lat 19 · sati 12 · send 16` —
and it was settled by instrumenting every write to temp19 and finding exactly
two, both the compiler zeroing it. Under every other reading the receiver of
that send is a counter. It unhalted Castle of Dr. Brain and Space Quest 1 and
took Space Quest 1's `Animate` count from 2,370 to 17,761.

**`DisposeClone` deleted static objects.** SCI's scripts call it on whatever a
`dispose:` was handed, which is routinely an object a Script resource defines;
Sierra's interpreter checks the Clone bit and returns. Deleting by key regardless
removed a _static_ object from the machine, and nothing said so until a later
send reported an offset that "is not an object". **It was found by the object
being present after boot and absent at the halt** — a resource that parsed
correctly, registered correctly, and then stopped existing. Six games stopped
halting: King's Quest IV, King's Quest I, Leisure Suit Larry 2, Space Quest III,
Police Quest 3 and Mixed Up Fairy Tales.

Two more were fixed on the way and **neither changed any game's outcome**, which
is worth saying rather than implying: a property walk that climbed `species`
before `superClass` (so a chain ended at the first class, and every property
inherited from a grandparent resolved to nothing), and an indexed store taking
its value from the accumulator rather than the stack (leaking a word per
execution; eight execute across six demos).

### What the remaining halts are, per cluster

- **Seven games ship no `vocab.997` at all** — EcoQuest, Mixed Up Fairy Tales,
  Island of Dr. Brain, King's Quest IV, Leisure Suit Larry 1, Quest for Glory
  III and Torin's Passage — and four of them halt on a Selector no object
  declares. The Selector numbers the scripts push run to 4103 and the objects
  declare 302 to 431 distinct ones, so the number asked for is in range and
  simply owned by nothing. That is the next thread in the SCI1.1 half.
- **King's Quest VI**: `lofsa 1716` lands on an object 1,100 bytes from either
  object whose chain carries the Selector it then sends. Not an off-by-N.
- **SCI2 and SCI2.1 all halt on the same thing, and it is the Kernel table.**
  All five — King's Quest VII, Space Quest 6, Torin, Leisure Suit Larry 7 and
  RAMA — now stop at `send to 0:0`, and the trace says why in full. Script
  64920 does `super 0, 4` into a method whose whole body is `push1 · pushSelf ·
callk 10, 2 · bnot · ret`, the caller does `bnot · sat 0`, and `bnot` is
  bitwise so the two cancel: **`temp0` is whatever Kernel 10 returned**. Sixty
  instructions later it does `lat 0 · send 6` to it.

  Kernel 10 is one of the unnamed SCI32 slots, and the engine says so —
  `Kernel call 0xa is not implemented at SCI2`, followed by what it did about
  it — which is #217's criterion doing exactly its job. The null it
  had to return became the receiver. (The rest of that message was reworded
  later; it used to claim it was "reported rather than returning zero", which
  was the one thing the machine was not doing.)

  So the SCI32 half is blocked on the **406 unnamed Kernel slots**, not on the
  decoder, the class graph or the compositor. That is already recorded below as
  the largest single piece of SCI work outstanding, and ADR 0020's reasoning
  rules out filling it from memory for the same reason it rules out a hash table
  of releases: it needs a reading of Sierra's own tables against real data.
  Naming this precisely is worth more than another attempt at it — the halt is
  not a defect to find, it is a table nobody has read.

  The historical wording, kept because the halts were three and are now one:
  King's Quest VII and Space Quest 6 on `send to 0:0`;
  Torin and Leisure Suit Larry 7 on an odd property offset — and that one is
  now measured rather than described. **Odd property operands occur only in
  those two games, once each**, against more than 500,000 always-even property
  operations across the other twenty demos. Both hit their odd one as the
  _first_ property access they ever execute, which is the shape of a decode
  desynchronising rather than of SCI2.1 encoding properties differently: a game
  that indexed properties instead of byte-offsetting them would show a mixture.
  Torin's ring at the halt reads `line 221 · pushSelf · lofsa 121 · lofsa 116 ·
aTop 109`, and two consecutive `lofsa` where the second clobbers the first is
  an instruction boundary in the wrong place. **Where that boundary goes wrong
  is the question, and it is upstream of the halt.**

  Reading the bytes rather than the disassembly says what those "instructions"
  are: `73 79 73 74 65 6d 2e 73 63 00` is `"system.sc"`. The machine is decoding
  a **string** as code, so the desync is a method running off its own end into a
  string table that lives inside the code resource.

  **One search along that line produced an artifact, and it is recorded because
  the artifact is the instructive part.** Counting how often `0x7c`/`0x7d`
  (`selfID`/`pushSelf`) is followed by a NUL-terminated string gives 0 of 198 in
  King's Quest VI, 0 of 143 in Police Quest 3 and 1 of 231 in Space Quest 6 —
  against **1,739 of 2,823 in Torin**. That looks exactly like a SCI2.1 opcode
  taking an inline string, and it is not: the walk decodes forward from each
  method entry, the SCI2.1 decode desynchronises, and a `0x7d` byte _inside_ a
  string table is the character `}` followed by more text. It counts how often
  SCI2.1 desyncs, which was already known. **A search whose input is produced by
  the fault it is searching for cannot be evidence about that fault**, and this
  is the second time on this branch a search had to be discarded for its input
  rather than its method.

- **Lighthouse** executes nothing, needing the SCI3 method dictionary.

### Where Castle of Dr. Brain used to stop, traced to the instruction

The furthest any SCI game gets, written down so the next attempt starts here
rather than repeating the trace.

It draws Picture 510 with 25 screen items and calls `Animate` 2,194 times, then
halts on `send to 0:0` in **script 255 at pc 5228**. The frame is a procedure —
no Selector — entered at 4386 with `link 1033`, a thousand-word buffer.

The send's receiver is `temp19`, and `temp19` is zero. Every write to it in that
frame was found by instrumenting the store: **there are two, and both are the
compiler zeroing it.** `4425: ldi 0 · 4427: sat 19 · 4429: sat 1030 · 4432: sat
1023 · …` is a run of `sat` initialising a batch of temporaries at the top of
the procedure. Nothing ever fills it.

What precedes the send is a chain of `dup · ldi N · eq? · bnt` — a switch,
testing 70, 25, 80, 67, 83, 41 and finally 81, whose arm builds an eight-word
parameter block and sends it to `temp19`. A thousand-word buffer and a switch
over small integers is a **variadic keyword parser**, which in a SCI game's
script 255 is `Print`.

So the fault is not in the send and not in the class graph: **an earlier arm of
that switch should have created the object `temp19` holds, and the switch is
reaching the arm for 81 without having taken it.** That is where to look next,
and it is a question about which keyword the game passed rather than about the
machine.

Two machine faults were found on the way to that trace and neither was the
cause, which is recorded because both are the kind that surface later as
something else:

- **A property walk climbed `species` before `superClass`.** A class's own
  species is itself, so the walk stepped from a class back to that same class
  and the chain ended at the _first_ class every time — every property
  inherited from a grandparent resolved to nothing. King's Quest VI's chain now
  reads `instance -> class 9 -> class 0` where it stopped at class 9.
- **An indexed store took its value from the accumulator.** For `sagi`, `sali`,
  `sati` and `sapi` the accumulator is the _index_, so the value comes from the
  stack — Sierra's compiler pushes it, and Castle of Dr. Brain's own sequence is
  `push · lat 19 · sati 12`. Storing the accumulator wrote the index into the
  variable and leaked a stack word. Eight of these execute across six demos.

**Neither changed any game's outcome**, and saying so is the point: a fix that
is right by the encoding and moves nothing is still worth having, and claiming
otherwise is how a record stops being usable.

### The largest thing left in SCI16 rendering, measured rather than described

**Compression method 4 — `lzw1-pic`, where a Picture is rebuilt out of an LZW
stream — produces a cel that does not decode.** Split by method over all 85
embedded cels, against a check that a decode must consume its stream exactly
and write exactly the cel's pixels:

| method     | cels decoding exactly |
| ---------- | --------------------- |
| 0, 1 and 2 | 46 / 46               |
| 4          | 1 / 32                |

The correlation is perfect, so this is `unpackPic` and not the cel reader.

**One of the two candidate causes has since been eliminated for real, and it
is worth separating from the guesses.** `lzw` returned the buffer it wrote
into rather than the bytes it wrote, and for the View and Picture variants
`unpackedSize` describes the _rebuilt_ resource rather than the stream — so
the buffer ran a few hundred bytes long and the rebuild read its trailing
block, and ran its run-length stream, into zero padding. The arithmetic pinned
it before the change: the Christmas Card 1990's first Picture gave 6,062
control bytes against 29,740 literals, which is 35,802 output bytes where the
cel declares 35,538, and the padding was 264 bytes to the shortfall's 264.
Bounded by what LZW actually wrote it is 5,798 and 29,740 — 35,538 to the byte,
and that game's Picture 4 now consumes 15,372 bytes of the 15,371 its cel
declares.

**The codec is still wrong, and the shape of the remaining fault is now
narrower.** The byte count is exact and the _pixel_ count is short — Picture 4
writes 59,744 of 60,800 — so a control byte is producing fewer pixels than it
should rather than the stream being misplaced.

Control tag `0x40` is **ruled out** as the cause. Eight readings of it were
tested against the decode-exactly check with the stream bounds corrected —
literal, fill and skip runs of the low six bits; the same three with the run
extended by a following byte; and two forms taking the run from the next byte
alone — and **all eight score identically**, 53 of 85. The 32 failures do not
turn on that tag.

**Twelve configurations have now been eliminated against correct bounds**, and
the list is worth keeping because every one of them is a thing the next attempt
would otherwise try first:

| candidate                                | readings tested                                                                                                                                 | result                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| control tag `0x40`                       | 8 — literal, fill and skip of the low six bits; the same three with the run extended by a following byte; two taking the run from the next byte | all identical at 53 / 85         |
| `decodeRle`'s literal count              | 2 — the whole control byte, or its low six bits                                                                                                 | identical                        |
| the order of the RLE and literal streams | 2                                                                                                                                               | current order 53, swapped **52** |

So the tag is not it, the literal count is not it, and the order is right. The
remaining fault produces an **exact byte count and a short pixel count** —
Picture 4 consumes 15,372 bytes of the 15,371 its cel declares and writes 59,744
pixels of 60,800 — which is a stream of the right length encoding too few
pixels rather than a stream in the wrong place.

Recorded rather than approximated, the way the SEQ difference frames are. An
earlier round of this search ran against the _uncorrected_ stream bounds and its
result meant nothing; that is why it was repeated rather than cited. It costs the Christmas Card 1990 all twelve of
its Pictures, Leisure Suit Larry 1 seven of eight, Space Quest 1 seven of
twelve and Police Quest 3 six of fourteen.

### Every game's static sweep, per game

979,241 instructions decoded across the 25 demos. The totals are the same as
the previous round's; what is new is that they are published per game, so a
change moves a row rather than a total.

| game          | instructions | unknown opcodes | past the table | Unrecovered | unresolved Selectors | code blocks overrun |
| ------------- | -----------: | --------------: | -------------: | ----------: | -------------------: | ------------------: |
| castlebrain   |       27,588 |               0 |              0 |           0 |                    0 |                   0 |
| christmas1988 |       13,241 |               0 |              0 |           0 |                   69 |                   0 |
| christmas1990 |        8,833 |               0 |              0 |           5 |                    0 |                   0 |
| ecoquest      |       18,671 |               0 |              2 |           0 |                    0 |                   4 |
| fairytales    |       31,270 |               0 |              0 |           0 |                    0 |                   0 |
| freddypharkas |       46,714 |               2 |              0 |           0 |                    0 |                   7 |
| gk1           |      100,867 |              11 |              0 |           1 |                    0 |                  17 |
| islandbrain   |       41,049 |               1 |              0 |           0 |                    0 |                  10 |
| kq1           |       19,031 |               0 |              0 |           0 |                    0 |                   0 |
| kq4           |       14,770 |               0 |              0 |           0 |                    0 |                   0 |
| kq6           |       29,990 |               4 |              0 |           0 |                    0 |                   4 |
| kq7           |       58,709 |               2 |              0 |           2 |                    0 |                  10 |
| lighthouse    |       15,818 |               0 |              0 |           1 |                    0 |                   2 |
| longbow       |       22,513 |               0 |              0 |           0 |                    2 |                   0 |
| lsl1          |       16,103 |               0 |              0 |           1 |                    0 |                   0 |
| lsl2          |       14,771 |               0 |              0 |           0 |                    0 |                   0 |
| lsl7          |      102,743 |               3 |              0 |           4 |                    0 |                  12 |
| pq3           |       24,571 |               0 |              0 |           0 |                    0 |                   0 |
| qfg2          |        9,335 |               0 |              0 |          20 |                    0 |                   0 |
| qfg3          |       13,196 |               0 |              0 |           0 |                    0 |                   1 |
| rama          |       44,603 |               0 |              0 |           2 |                    0 |                   3 |
| sq1           |       20,215 |               0 |              0 |           0 |                    0 |                   0 |
| sq3           |       15,758 |               0 |              0 |           0 |                    0 |                   0 |
| sq6           |       68,023 |               0 |              0 |           2 |                    0 |                   2 |
| torin         |      200,859 |               6 |              1 |           3 |                    0 |                  58 |
| **total**     |  **979,241** |          **29** |          **3** |      **41** |               **71** |             **130** |

Sixteen games sweep with **zero** of everything. `qfg2`'s twenty Unrecovered
are the largest single row and are not the SCI32 half, which is where the rest
of this document's attention has gone.

**The unnamed Kernel slots are unchanged and remain the largest single piece of
SCI work outstanding**: 406 slots called 4,942 times across the six SCI32
games, every one of them _inside_ its Version's table rather than past the end
of it — a gap in what this project has named, not a fault in what it read.
`kernel.ts` names only the entries there is positive evidence for, and filling
the rest from memory is what ADR 0020 rules out for Version detection, for the
same reason.

### Editing, checked by editing

Three SCI1 games — Police Quest 3, Conquests of the Longbow, Castle of Dr. Brain
— were imported, had one operand changed in a real method, and were exported.
Each produced **one** changed byte in the edited script and no change to any
other resource. Before this was checked, all three produced _zero_: `isUntouched`
compared method lengths rather than bytes, so any edit that kept an instruction's
width was written back as the original.

Peak memory during an export, which #227 asks for: Torin's Passage — 226 scripts,
562 resources, 11.9 MB written — peaks at 110 MB of heap and 367 MB RSS. Leisure
Suit Larry 7, which writes 20.4 MB, peaks at 96 MB heap and 436 MB RSS. Roughly
five to ten times the exported size, held at once, because an export builds every
resource before writing any. That is affordable for a demo and is the number to
re-measure before claiming a seven-disc game can be exported.

### Editing, and the four resource kinds that had no writer

`importSciGame`, `exportSciGame` and `sciLinker` were finished and covered by
27 tests while **nothing in `src/editor` imported any of them**. The editor
swapped between the SCUMM surface and `AgiEditor` and had no SCI arm, so every
criterion phrased as _editable_ was unmet however well the library worked, and
nothing said so. `SciEditor` is that arm.

Underneath it, there were **no SCI resource writers at all**. Each was built
and each is checked against every instance of it in the 25 demos rather than
against a fixture:

| kind           | evidence                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| vector Picture | 96 / 96 re-render to the same visual and priority buffers; 93 re-read to the same path; 50 byte-identical |
| View           | 363 / 363 non-V56 round-trip pixel-identically; 603 V56 refused **by name**                               |
| font           | 164 / 164 read whole — 21,994 glyphs — and round-trip **byte-identically**                                |
| cursor         | 51 / 51 round-trip identically, 46 byte-identically                                                       |
| `vocab.000`    | 5 / 5 round-trip word-identically                                                                         |

The V56 split is clean and worth recording: **every SCI0, SCI01 and SCI1 game
in the corpus has zero V56 Views, and every SCI1.1-and-later game is entirely
V56.** So the refusal never touches the Versions whose editing issues depend on
it.

**There was no font reader before this.** The format was derived from the games
and is self-checking — header, offset table and the sum of every character's
record add up to the resource length exactly, 6 + 256 + 1,486 = 1,748 for
Conquests of the Longbow's font 0 — which is why "164 of 164" is a claim worth
making rather than a count of things that did not throw.

**Two faults found by writing, which is the only way either could have been
found.** A reader that is never asked to produce what it consumed can be wrong
in ways nothing downstream notices.

- **A Picture step byte may never reach 0xf0.** A run ends when the next byte is
  an opcode, so a `shortLines` step at `dx === -7` (0x80 | 0x70) _is_ a
  terminator and ends the run it was meant to continue. Sierra's own encoder had
  the constraint and its data never violates it; this one did not, and a
  round-tripped Picture re-read as a quarter of its commands and then reported
  an unknown opcode at the byte after the truncation.
- **`readSciVocabulary` read each letter's run past the letter.** Not every
  letter's run carries a 0xff terminator, so a letter without one ran on into
  the letter after it, and every word from there to the end was read again once
  per preceding letter. Space Quest III reported **16,884 words out of 9,985
  bytes** — 0.59 bytes a word, where the floor is five. Bounded at the next
  letter's offset it is 1,430 words at 7.0 bytes each. `kParse` had roughly
  twelve copies of most of the vocabulary to match against, and nothing failed.

The second is the more useful of the two to remember: it was found by a _number
being impossible_, not by anything going wrong. The count had been in the
engine for as long as the parser had.

### The static sweep, over 25 real games

979,241 instructions decoded. The sweep reads three Script layouts — SCI0's
block chain, SCI1.1's code-and-heap pair, SCI3's fixed header — and hands all
three to one decoder, which is ADR 0017's claim standing up under about a
million instructions of real bytecode.

|               | games | instructions | unknown opcodes | unknown Kernel numbers | Unrecovered |
| ------------- | ----- | ------------ | --------------- | ---------------------- | ----------- |
| SCI0 – SCI1.1 | 19    | 488,486      | 18              | 2                      | 27          |
| SCI2 – SCI3   | 6     | 490,755      | 11              | 4,941                  | 14          |

**Those are the honest state of the SCI32 Kernel tables, not a decode fault**,
and the sweep now says which is which. A call _past the end_ of a Version's
table is a fault — a misread instruction, or the wrong Version — and a call to a
slot inside it that this project has not named is a gap. Split that way, Torin's
Passage's 2,090 becomes **one** fault and 2,089 calls to 72 unnamed slots, and
Lighthouse's 90 becomes zero faults and 90 calls to 31 slots. `kernel.ts` names only the SCI2 and SCI2.1 entries this project has
positive evidence for; the rest report themselves by number and Version, which
#217 makes an acceptance criterion in bold. Filling 322 slots from memory is
what ADR 0020 rules out for Version detection and the same reasoning applies
here. Closing that gap needs a reading of Sierra's tables against real data, and
it is the largest single piece of SCI work still outstanding.

The 29 unknown opcodes are 0.003% and cluster in SCI1.1-and-later games, where a
method's extent is bounded by the next entry point rather than by a size word.
The two unknown Kernel numbers in the SCI16 half are `0x3904` and `0x3500` in
EcoQuest — 16-bit operands read as calls after the same kind of overrun, not
Kernel numbers at all.

### What the sweep found, which is the point of having it

- **Castle of Dr. Brain never identified at all** — the detector _hung_. A
  Huffman node whose branch byte has a zero high nibble steps to itself, and the
  compression-era probe decodes resources under the wrong codec on purpose, so
  the path runs for half of every game detected.
- **King's Quest I's SCI demo was on the wrong Version.** It calls `FileIO` at
  0x74, which SCI0's table does not have, and `probeKernelRange` was sampling
  twelve scripts — a maximum is not something a sample finds. It reads every
  script now, and King's Quest I identifies as SCI01 by probe.
- **Six SCI32 demos were bare `sci2` buckets** until the View cel record probe.

### Version identification, published as ADR 0020 requires

15 of 25 games identify by probe and may be edited. 10 narrow only to a bucket:
they play, and the editor refuses them with the reason on screen. The number is
computed by `editableVersionGap` from what was actually identified, so it moves
when a probe improves rather than being a comment that rots.

The 10 are King's Quest VII and Space Quest 6 (SCI2 or SCI2.1 early — the SCI32
Kernel-table probe finds only two `callk` sites between them), Torin's Passage,
RAMA and Leisure Suit Larry 7 (SCI2.1 middle or late — ScummVM's own note says
that seam is not in the data, so no probe can exist), and five SCI16 demos whose
probes agree on a bucket and no further.

### The Kernel gap, measured from the code rather than from a grep

`npm run sweep:sci -- --kernel-coverage` walks `SCI_KERNEL` against
`kernelNamesFor(version)` for all thirteen Versions and prints four columns per
Version: implemented, answered with a constant, answered by the unused-call
stub, and missing. `tests/sci-kernel-coverage.test.ts` pins the same figures so
they cannot drift without somebody editing the assertion. **Tier 1, and the tier
matters here more than usual**: this measures the tables this repository carries
against the handlers this repository has, and no SCI game data was mounted on
the machine that took the figures. Below SCI1 most games ship their own
`vocab.999`, which `SciEngine.kernelNameFor` prefers over the built-in table, so
a release's real gap can differ from the row below.

| Version                            | slots           | named | implemented | constant | unused stub | missing |
| ---------------------------------- | --------------- | ----- | ----------- | -------- | ----------- | ------- |
| SCI0 early, SCI0 late, SCI01       | 110 / 110 / 139 | 112   | 76          | 30       | 6           | 0       |
| SCI1 EGA-only, early, middle, late | 139             | 137   | 86          | 40       | 11          | 0       |
| SCI1.1                             | 139             | 137   | 86          | 39       | 11          | 1       |
| SCI2                               | 160             | 150   | 80          | 28       | 13          | 29      |
| SCI2.1 early, middle, late         | 162             | 123   | 61          | 22       | 11          | 29      |
| SCI3                               | 162             | 122   | 60          | 21       | 11          | 30      |

**The count this replaces was wrong in four ways, and all four were artefacts of
measuring outside the code.** It was taken by matching handler keys against
table names with `awk` and `comm`. It counted SCI16's placeholder `Empty` slot
as a call, so it said 138 named where the table holds 137. It counted 137
handlers where `SCI_KERNEL` held 133 the day it was taken — 156 today, which is
why that half of it is written as a date rather than as a figure. It read SCI16
as the whole of the pre-SCI32
axis, when **SCI0 and SCI01 ship a different table** whose own missing set
included eight calls nobody had counted — `TimesSin` through `TimesCot` and
`FOpen` through `FClose`. And it reported one SCI1 gap when SCI1 late and SCI1.1
each renumber a slot and so have gaps of their own.

**A fifth way, which moving the count inside the code did not fix.** The
"implemented" column above used to read 120 for SCI1, read 72 the day the
constant column was introduced, and reads 86 today; nothing was deleted to make
the first of those moves happen, and nothing was faked to make the second. The
old column counted a _key_ in `SCI_KERNEL`, not a behaviour, and forty handlers
at SCI1 still answer the same value whatever a game passes them. `Said` is
`() => int(0)`. So are `Graph` and `Palette`, and `AvoidPath`, `InitBresen`,
`DoBresen` and the four menu calls return `NULL_REG` the same way. Each was
counted beside `Format` and `DrawPic`. `DoSound`, `Parse`, `SaveGame` and
`RestoreGame` were on that list when the column was first published and have
each since left it by gaining behaviour, which is the only way out.

What that made possible is the thing this table exists to refuse. Under the old
reading, `MergePoly: () => NULL_REG` closes a row of the missing column — six
characters of arithmetic in place of a five-hundred-line polygon algorithm, and
the figure goes up by the same one either way. The five hundred lines were
written; the point stands, because nothing in the count could have told the two
apart. The column is the guard against a number that can only improve.

**The constant column is probed, not declared.** Every handler is called with
ten arguments behind a recording proxy and a world behind another; one that
reads no argument and touches nothing goes in the column.
`tests/sci-kernel-coverage.test.ts` fails if `SCI_CONSTANT_KERNEL_NAMES` is not
exactly that set, so a call that gains behaviour has to leave the list and one
that loses it has to join, and neither is settled by argument.

**It is not a defect list, and saying so is not a hedge.** Some of the forty are
finished: `SetVideoMode` has a VGA planar mode to leave that no
renderer here has, `CanBeHere` and `CantBeHere` answer permissively on purpose
because a refusal spins `findPosn` — King's Quest IV's throne room made 385,000
of those calls — `HaveMouse` says there is a mouse, and `UnLoad`, `Lock` and
`FlushResources` manage a resource cache this interpreter does not keep. Others
are whole surfaces with nothing behind them. Sorting those apart is a judgement
per call and is deliberately not made in the count: the column reports what was
measured, and a call leaves it by gaining behaviour.

**Eleven calls are the unused stub**, which is a different kind of nothing and
keeps its own column: Sierra's own debugger's surface — `InspectObj`,
`ShowSends`, `ShowObjs`, `ShowFree`, `StackUsage`, `Profiler`, `Record`,
`PlayBack` — plus `ATan`, `ShiftScreen` and `ListOps`, which ScummVM's
`kernel_tables.h` maps to `MAP_DUMMY` with the note "never called?". That is a
defensible answer for a call no retail game makes and it is not an
implementation. A game genuinely reaching one is a finding rather than a
nuisance: either its Version is wrong or that list is.

**What an unimplemented Kernel call does today: it answers zero and says so
once.** `SciEngine.callKernel` returns null, `PMachine`'s `callk` logs
`describeUnknownKernel` the first time it sees each number and then writes
`NULL_REG` into the accumulator and carries on. That is a decision worth keeping
now that the SCI16 gap is four calls wide rather than twenty-three: halting would
lose every later finding in the same run, and the SCI32 trace recorded above —
where Kernel 10's null became a receiver and the game stopped at `send to 0:0`
sixty instructions later — is the reporting doing its job rather than an argument
against it.

The constant column sharpens what that decision does _not_ cover. A missing call
reports itself; a call answered with a constant is silent, because there is no
number the machine failed to resolve. `Said` returning zero looks from inside
the PMachine exactly like `Abs` returning zero. That silence is the reason the
column had to be published rather than left as a note: the runtime cannot tell a
reader which of the two it just did, so the count has to.

**`Intersections` left the missing list by being written**, one of the two
names that took SCI1 early's missing column from six to four. It was the only
name on that list needing
nothing from the renderer: ten arguments, two buffers the calling script already
owns, and integer arithmetic between them — where a query line crosses a polygon
and which edge it crossed. Transcribed from ScummVM's `kIntersections`
(`engines/sci/engine/kpathing.cpp`, fetched 2026-09-12) including the centipixel
scale and the round-half-away-from-zero slope, because a slope computed the tidy
way differs in the last pixel and the last pixel decides whether a crossing
lands on a segment. The five tests in `tests/sci-pmachine.test.ts` are geometry
rather than this engine's output — a horizontal line through a square crosses
its two upright sides, `y = x` meets the wall at `x = 50` at `(50, 50)` — so a
transcription that drifted disagrees with arithmetic a reader can do, which is
the one check a fixture built by the code it agrees with cannot give.

**And then checked against geometry rather than against itself.** Hand-worked
cases on axis-aligned shapes cannot exercise a slope rounded the wrong way or a
sign lost on a negative run, so a sixth test runs 4,000 pseudo-random query lines
against a convex hexagon with off-axis vertices and asserts two things that are
true of any crossing by definition. Every reported triple must lie on the
polygon edge it names — which is the only check that pins the edge index, the
third word, at all — and on the query segment. And the parity of the count must
be the topology: odd when one endpoint is inside the polygon and one outside,
even when both are outside, which is the Jordan curve theorem and contains
nothing about Sierra's centipixels.

Both hold exactly. The parity assertion excludes lines grazing a vertex, because
Sierra grows each segment's box by a pixel per axis before testing containment,
so a line passing within about √2 of a vertex is legitimately counted on both
edges meeting there — in Sierra's interpreter as much as this one. **That radius
was measured, not assumed**: over the same 4,000 lines the parity failures are
140 with no exclusion, 10 at 1.5 pixels, 2 at 2.0 and 0 at 2.5, which is the
predicted √2 plus the half pixel that rounding a crossing back to whole pixels
costs. The test was then mutation-checked — writing the adjacent edge's index
fails 4 cases, dropping the query segment's own extent fails 3 — so it is known
to have teeth rather than assumed to.

The command: `npx vitest run tests/sci-pmachine.test.ts`, 71 passing. Still Tier
1, because it is this engine measured against mathematics and not against a
game; what it rules out is a transcription error, not a misreading of what
Sierra's scripts expect.

**What is left at SCI16 is one boundary, not a list of calls**, and it is a
missing hook. `IsItSkip` needs a cel's pixels, `AssertPalette` a palette loader,
`TextFonts` the text-code font store, `ResCheck` resource presence, and
`FOpen`/`FPuts`/`FGets`/`FClose` a file surface — every one of them a new
`SciKernelWorld` hook wired in `SciEngine.ts`. Registering handlers that
answered a fallback would close the count and stop the engine reporting the gap,
which is the trade this table exists to refuse — and which the constant column
now makes visible rather than leaving to good intentions.

**`MergePoly` is the other name that left the missing list, and it took two
attempts to get there.** It extends one obstacle polygon to swallow the ones it
overlaps, so a pathfinder can route around the union rather than around each
piece; Quest for Glory I VGA calls it when a monster dies and its avoidance
polygon has to be folded back into the room's. It needs no hook: it walks a list
of polygon objects through `world.heap.list`, reads their `points`, `size` and
`type` by name through the game's own Selector table, marks each polygon it
swallowed by adding `0x10` to that `type`, and allocates the new outline on the
heap, closed by the word `0x7777`.

It was declined once, and the earlier version of this section argued the decline
at length: nothing would read the answer, because this engine's pathfinder is
`AvoidPath` and `AvoidPath` sits in the constant column as `() => NULL_REG`.
**That argument is recorded here because it was wrong, and wrong in a way worth
keeping visible.** It is a claim about sequencing, not about a boundary — and
the identical claim would have excluded `Intersections`, which was written in
the same run and whose answer nothing reads either. A call that answers
correctly and is not yet consumed is still a call this engine answers. The
handler says so in its own comment: it closes a name and moves no pixel, and
`AvoidPath` is the next thing to write.

Transcribed from ScummVM's `kMergePoly` and `mergeSinglePolygon`
(`engines/sci/engine/kpathing.cpp`, fetched 2026-09-12), which carries the
comment that it "matches qfg1new closely, and is a bit error-prone" — so the
transcription is checked against the definition of a union rather than against
itself. `tests/sci-pmachine.test.ts` works four unions of axis-aligned squares
on paper, including a chain where the third square touches the outline only
through the second, and then asserts the property that is the whole
specification of the call: **a point is inside the merged outline exactly when
it was inside either shape**, sampled over two hundred pseudo-random pairs of
convex hulls that properly cross. All two hundred hold. Points within two pixels
of any of the three boundaries are not sampled, because Sierra rounds each
crossing to a whole pixel and "inside" is genuinely undefined in that band.

Two things in the transcription are `float`-width rather than double-width on
purpose — ScummVM does the geometry in C `float`, and a half-ulp in a division
moves a vertex by a whole pixel once `toPoint()` truncates — and two are
deliberate divergences, both recorded on the handler: a zero-length polygon edge
is logged and skipped where ScummVM halts the interpreter, and a ninth patch is
logged and dropped where ScummVM calls `error()`. An outline is a usable answer
and a halt in the middle of a room script is not.

**Two questions the tables settle, recorded because both look like drift and
neither is.** `Sort` and `ListOps` are not one call under two names: ScummVM's
SCI16 table puts `ListOps` at 0x73 and marks it "never called?", and `Sort` at
0x78, where SCI01 instead reads `StrSplit`. This repository's `SCI16_NAMES`
agrees slot for slot across 0x6e–0x86, so `Sort` and `StrSplit` are implemented
and `ListOps` is in the unused column on ScummVM's evidence rather than on a
guess. And `GetMessage` belongs to the Kernel rather than to a second Message
reader: it is SCI1's spelling of the slot SCI1.1 sub-functions as `Message`, and
it goes through the `world.message` hook `sciMessage.ts` already answers, because
two readers of one resource is how the two come to disagree.

**SCI32's 58 are published, not closed**, in ADR 0020's sense: a number that
moves when the work happens rather than an impression. SCI32 was untouched here
by instruction, and the one figure that moved moved sideways: `MergePoly` is
named at SCI2 and SCI2.1 as well as at SCI16, so writing it for SCI16 took those
rows from 59 to 58 without any SCI32 work being done. SCI3 does not name the
call, which is why SCI3 is the row still reading 59. What the constant column
adds for SCI32 is that its implemented figure fell with everyone else's — SCI2
reads 55 where it read 87 — so the published gap is now 58 missing beside 33
answered with a constant, and the distance to a playable SCI32 is the larger of
those two numbers rather than the smaller.

### Rendering, judged by eye

`npm run shot:sci` renders both kinds of Picture through one compositor. A
person looked at: King's Quest VI's title screen (SCI1.1 cel Picture), Space
Quest 6's bridge with its thirteen screen items and a V56 actor (SCI2),
Lighthouse's mill room and its "New Game" button (SCI3), and Torin's Passage's
opening (SCI2.1). 314 cel Pictures across nine games decode with no failures.

### Video

Lighthouse's thirteen Robot files decode — 713 cels, two of them blank — and the
container is self-checking: for all thirteen, the aligned frame-data offset plus
the sum of the record sizes is the file length to the byte. A Robot composites
as an ordinary screen item; ADR 0015's tripwire did not fire.

All 22 SEQ files in the King's Quest VI and Gabriel Knight demos index exactly.

**Their difference frames now decode, and the previous round's search was over
the part that was right.** This section used to record 260 candidate schemes
tried against 314 difference frames with none satisfying the format's own
three-way check — consume the control stream exactly, consume the literal
stream exactly, write exactly the frame's pixels. None of the 260 could have
passed. A frame record's body size sits at offset 12 and its control-stream
size at offset 16, and **both are 16-bit**; offsets 14 and 18 hold other
fields. Read as 32-bit words, each folds its neighbour into the top half, so
every candidate began by splitting the body at the wrong byte. A control stream
cut short by a few hundred bytes fails all three checks, which is exactly what
was measured — and then attributed to the schemes.

Worth keeping as a record, because the shape recurs: a search that fails
completely is evidence about the search, not only about the space.

The codec itself is `SEQDecoder::SEQVideoTrack::decodeFrame`'s — three shapes of
control byte over a separate literal stream, all of it measured in screen rows
of 320 rather than in the frame's own width. **Checked at Tier 1 only.** The 22
demo files are not in this checkout, so re-running the three-way check against
them is the next thing anybody with the demos should do, and it is the check
that would catch this being wrong again.

**VMD decodes: header, frame table, all five block kinds and Coktel's own
LZ77.** Ported from `VMDDecoder` rather than derived, and audio is handed back
with the frame it arrived in — the container puts the slice for frame N inside
frame N, which is what makes sync a property of the file rather than something
the player maintains. Tier 1 only, for the same reason: no free SCI32 data
exists (#215).

**A DUK is a RIFF/AVI, and this project had it recorded backwards.** The reader
identified a DUK by a `DUCK` tag at offset zero. That tag is the video stream's
four-character handler _inside_ the header list; the file opens `RIFF`, which
is why ScummVM hands `.duk` straight to its AVI decoder. So no real DUK would
ever have been identified, and the fault was invisible because there is no DUK
here to fail against. The container is read properly now.

**Its TrueMotion 1 codec is not decoded, and the reason is not "not yet".**
TrueMotion 1 produces 16-bit RGB, and every surface in this renderer — cel,
screen item, Plane, framebuffer — is an 8-bit index into a palette. What is
missing is a _colour path_, from the codec through the compositor to the
screen, which is an architectural change with an ADR shape to it rather than a
decoder somebody has not written. It should be proposed as one. Until then a
DUK opens, streams, times and skips correctly, holds the frame that was on
screen, and says how many frames it did not draw.
