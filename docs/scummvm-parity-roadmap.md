# What "everything ScummVM plays" would mean here

This file exists because the request behind it — _read ScummVM and implement
everything in it, so this project plays every game ScummVM plays_ — reads like
one job and is about a hundred and twenty of them. That is not a reason to
refuse it. It is a reason to sequence it, and to sequence it against numbers
somebody can check rather than against a feeling about how big the job is.

**Nothing here is a decision.** Decisions live in
[`architectural-decision-record/`](architectural-decision-record/). This map is
what you would need before taking one — and the first two it recommended have
since been taken:
[**ADR 0036**](architectural-decision-record/0036-the-two-broken-swords-are-a-seventh-and-eighth-engine-family.md)
adds `sword1` and `sword2` as the seventh and eighth Engine families, for the
reasons this page gives below and for one it did not anticipate. It expected a
single family and found two: the two Broken Swords share no bytecode, no
resource layout and no renderer, which is `CONTEXT.md`'s whole test.

## The measurement

Taken from a sparse checkout of `scummvm/scummvm` at `master`, counting `.cpp`
and `.h` under `engines/` only — so no `common/`, `graphics/`, `audio/`,
`backends/` or `video/`, all of which this project also has to have its own
answer for.

|                                                                  | Count     |
| ---------------------------------------------------------------- | --------- |
| Engine directories under `engines/`                              | 126       |
| Lines of C++ in them                                             | 6,052,980 |
| Lines corresponding to the six families implemented here         | 547,180   |
| Lines for the two added since (`sword1` 33,380, `sword2` 25,968) | 59,348    |
| Lines of TypeScript in `src/` today                              | 114,766   |

**The ratio is the useful part, and it is not 53:1.** This project is not a
port: `README.md` says it is written "from scratch against the formats, using
ScummVM as the reference for how the originals behave", and 115k lines of
TypeScript already stand where 547k lines of C++ do — because a from-scratch
reader carries none of ScummVM's thirty platform backends, its five renderers
or its own history. What the ratio does establish is the shape of the
remainder: **5.5 million lines of reference material for engines with no
counterpart here at all.**

The licence is not the obstacle, which is worth saying once so nobody
re-checks it. This project is `GPL-3.0-or-later` and ScummVM is
`GPL-2.0-or-later`, so ScummVM's code may lawfully be incorporated here. The
reason not to transliterate it is design, not law, and it is ADR 0011's reason:
a family here is expected to earn its own reading of its own formats.

## The count of _games_ is not spread across the 126

This is the single finding that changes how the job should be ordered, and it
is invisible if you only look at the engine list.

Most of ScummVM's 126 engines run one game, or a handful. Four of them are
**generic interpreters** — engines for authoring systems rather than for
titles — and between them they account for most of the number in "all the games
ScummVM plays":

| Engine       | What it interprets                                  | Detection entries     |
| ------------ | --------------------------------------------------- | --------------------- |
| `ags`        | Adventure Game Studio games                         | 5,334                 |
| `wintermute` | Wintermute Engine games                             | 2,256                 |
| `director`   | Macromedia / Adobe Director titles                  | — (11,173-line table) |
| `glk`        | Interactive-fiction VMs (Z-machine, Glulx, TADS, …) | — (multi-format)      |

So there are two quite different goals hiding inside one sentence, and they
have almost nothing to do with each other:

- **"Plays the games ScummVM is famous for"** — the bespoke engines. Sierra,
  LucasArts, Revolution, Westwood, Adventure Soft, Delphine, Coktel. This is
  the list below, and this project is six families into it.
- **"Plays the number of games ScummVM claims"** — dominated by `ags`,
  `wintermute` and `director`. One AGS interpreter would add more titles than
  every bespoke engine in ScummVM combined, and it is a scripting VM plus a
  room format, not a hundred separate readers.

**The second is now out of scope, by decision.** Asked which of the two this
work is for, the answer was "just the famous games". So `ags`, `wintermute`,
`director` and `glk` are declined — together about 727,000 lines of reference
and the large majority of the number ScummVM quotes — and what remains is the
bespoke engines: the games a player would recognise by name.

That is a scope decision rather than a technical one and it is recorded here
because it changes the ordering completely, not marginally. It also moves
`sludge` **off** the critical path: SLUDGE is an authoring system's engine and
its fourteen games are indie, so its best-ratio-in-ScummVM argument no longer
buys anything the decision wants. Its container reader and disassembler are
built and stay built — they cost nothing to keep and nothing further is owed
them — and the interpreter that was next is not being written.

## Ordering criterion this repo already has

[`processes/verifying-version-support.md`](processes/verifying-version-support.md)
sets the bar: Tier 1 is a synthetic fixture, Tier 2 is a person with the data,
and CI can only meet a real game where the game is lawfully fetchable. Today
that is true for exactly two families — Sky and Lure — and it is the reason
`npm run sweep:vt` is the only CI job in this repository that touches a real
game.

That makes **"are its games freeware?"** the strongest _verification_ criterion
available, because it decides whether a new family can ever be held to more
than its own fixture. It is not the same thing as the ordering criterion, and
after the decision above the two have to be crossed rather than confused: fame
says which engines are in scope, freeware says which of those can be checked
against a real game. Most famous engines are not freeware, so most of the queue
below rests on a fixture and says so. Taken from ScummVM's own downloads page rather than from
memory — the first draft of this table guessed and got it wrong in both
directions, listing a game the page no longer offers and missing five engines
it does:

| Engine         | Freeware game(s) their publishers released | LOC in ScummVM  |
| -------------- | ------------------------------------------ | --------------- |
| `sludge`       | **Fourteen** SLUDGE-engine games           | 16,813          |
| `adl`          | Hi-Res Adventure #1: Mystery House         | 10,004          |
| `got`          | God of Thunder                             | 20,115          |
| `cge`          | Sołtys, Sfinx                              | 8,580           |
| `parallaction` | Nippon Safes, Inc.                         | 23,604          |
| `queen`        | Flight of the Amazon Queen                 | 23,252          |
| `drascula`     | Dráscula: The Vampire Strikes Back         | 11,461          |
| `dreamweb`     | DreamWeb                                   | 17,329          |
| `griffon`      | The Griffon Legend                         | 10,146          |
| `sword25`      | Broken Sword 2.5                           | 24,776          |
| `wage`         | The WAGE games collection                  | 10,119          |
| `sky`          | Beneath a Steel Sky                        | **implemented** |
| `lure`         | Lure of the Temptress                      | **implemented** |

Eleven engines with no counterpart here, ~176k lines of reference, and every
one of them a family whose claim CI could check against a real game on every
pull request rather than a family resting on a fixture that agrees with the
reader by construction. No other group of eleven has that property.

**Two of those rows stand out for different reasons.**

`sludge` is the best ratio anywhere in ScummVM: 16,813 lines of reference for
fourteen games a build machine may fetch. Every other engine on this page buys
one or two games with comparable work.

`adl` is the one that fits this repository's existing shape without asking a
question of it. Hi-Res Adventure is **already on
[`released-games.md`](released-games.md)** — listed under Sierra as the
pre-AGI lineage, with Mystery House named as the first graphical adventure
game — and it is currently there for context rather than as a support claim.
It is 10,004 lines, it is Sierra, its first title is lawfully fetchable, and
it would be a seventh family that reads a documented format and draws vector
pictures, which is a thing this project has done twice already.

## The queue, after the decision

Famous bespoke engines, in the order this map recommends. **Freeware** is what
CI could check; **blocked** means the engine needs a support file its publisher
never shipped, which ADR 0024 declines — those need a decision before they need
code, and Queen is the worked example above.

| #   | Engine     | Games a player would name                | LOC     | Note                                                                                                                                               |
| --- | ---------- | ---------------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| —   | `sword1`   | Broken Sword: The Shadow of the Templars | 33,380  | **Implemented** (ADR 0036) — runs, draws, edits and exports byte-identically                                                                       |
| —   | `sword2`   | Broken Sword II: The Smoking Mirror      | 25,968  | **Implemented** (ADR 0036) — runs, draws, walks, scrolls, speaks, chooses, edits and exports the same way; the pointer has three of its four modes |
| 1   | `cine`     | Future Wars, Operation Stealth           | 20,277  | Delphine; the smallest famous engine here, and now the top of the queue                                                                            |
| 4   | `groovie`  | The 7th Guest, The 11th Hour             | 18,288  | Mostly video                                                                                                                                       |
| 5   | `tinsel`   | Discworld, Discworld II                  | 50,570  |                                                                                                                                                    |
| 6   | `mohawk`   | Myst, Riven                              | 56,713  | Self-describing archives; Riven is the large half                                                                                                  |
| 7   | `cruise`   | Cruise for a Corpse                      | 19,516  | Delphine, beside #2                                                                                                                                |
| 8   | `queen`    | Flight of the Amazon Queen               | 23,252  | **Freeware, and blocked** — needs `queen.tbl`                                                                                                      |
| 9   | `drascula` | Dráscula                                 | 11,461  | **Freeware, and blocked** — needs a generated `.dat`                                                                                               |
| 10  | `kyra`     | Legend of Kyrandia 1–3, Lands of Lore    | 139,697 | **Blocked** — needs a generated `.dat`                                                                                                             |

`sword1` **was** the recommendation for first, and the reason was not its size.
Revolution Software is the one publisher whose engines this project has already
read twice — Sky and Lure are ADRs 0023 through 0026, and the vocabulary for
"one game, one lineage, a Release rather than a Version" is already written
down. Broken Sword is a third engine from that publisher, its `swordres.rif`
cluster index is self-describing so no support file is needed, and it is
plainly a game somebody would name. #2 and #7 are Delphine's two and share
whatever the first of them establishes.

The three blocked rows are worth keeping visible rather than dropping. Each is
a famous game and each is refused for the same reason, and that reason is now a
decision rather than an observation:
[**ADR 0033**](architectural-decision-record/0033-a-directory-that-exists-only-in-a-support-file-is-derived-from-the-shipped-bytes.md)
covers what this project does when the only directory anybody has is ScummVM's.
It says the directory is **derived from the shipped bytes**, that a file the
publisher shipped is not a support file however it reaches you, and that
refusal attaches to the purpose rather than to the Target. The three rows
unblock together or not at all, which is why it is one ADR and not three.

Lure arrived at that wall from a third direction after the table above was
written: its bytecode now has a reader and no entry point, because the resources
ScummVM reads scripts from are its generated `lure.dat`'s numbering and exist
nowhere on the shipped disks.

## The rest, by weight

Bespoke engines with no counterpart here, grouped by the size of the reference
rather than by publisher, because the size is what predicts the work.

**Over 100k lines each — each one a project on the scale of this whole
repository.** `hpl1`, `glk`, `mads`, `ultima`, `bagel`, `m4`, `ags`,
`bladerunner`, `kyra`, `director`, `tsage`, `titanic`, `mm`, `lastexpress`,
`wintermute`, `saga2`.

**25k–100k lines.** `icb`, `nancy`, `gob`, `qdengine`, `grim`, `pegasus`,
`mtropolis`, `freescape`, `mohawk`, `tetraedge`, `tinsel`, `watchmaker`,
`startrek`, `sherlock`, `neverhood`, `chewy`, `harvester`, `stark`, `ngi`,
`twp`, `asylum`, `saga`, `twine`, `crab`, `access`, `dgds`, `buried`, `sword1`,
`hdb`, `gnap`, `dm`, `hopkins`, `illusions`, `macs2`, `sword2`, `tony`.

**Under 25k lines — the tractable end.** `sword25`, `mediastation`, `hypno`,
`parallaction`, `queen`, `colony`, `myst3`, `supernova`, `dragons`, `cine`,
`got`, `hadesch`, `zvision`, `cryomni3d`, `darkseed`, `cruise`, `eem`,
`trecision`, `alcachofa`, `vcruise`, `waynesworld`, `groovie`, `fool`,
`avalanche`, `pelrock`, `tot`, `sludge`, `chamber`, `bolt`, `alg`,
`toon`, `hugo`, `prince`, `teenagent`, `kingdom`, `cryo`, `bbvs`,
`mutationofjb`, `tucker`, `agds`, `drascula`, `mortevielle`, `awe`, `pink`,
`voyeur`, `private`, `gamos`, `efh`, `touche`, `griffon`, `wage`, `phoenixvr`,
`macventure`, `draci`, `adl`, `made`, `lab`, `petka`, `cge2`, `cge`, `toltecs`,
`lilliput`, `immortal`, `composer`, `playground3d`, `plumbers`. (`testbed` is
ScummVM's own test harness and not a game engine.)

**A line count is not an estimate.** It says how much reference material there
is to read, not how long a from-scratch reader takes to write — AGOS is 54k
lines in ScummVM and took this project six ADRs and a font read out of an
interpreter executable. Treat the groups as an ordering, never as a schedule.

## What this project would have to grow to hold them

Six families have added no member to `AdventureEngine` (ADR 0011), and that
ceiling is the load-bearing fact about whether this list is even shaped like
this repository. Several of the engines above would not fit under it:

- **3D engines.** `grim`, `stark`, `myst3`, `icb`, `tetraedge`, `watchmaker`,
  `hpl1`, `playground3d`, `freescape` need a renderer this project does not
  have and has never needed. A browser has WebGL; that is a different project
  under the same shell, not a sixth kind of room.
- **Generic interpreters.** `ags`, `wintermute`, `director`, `glk` are not
  games-with-formats but languages-with-runtimes, and a Target for one of them
  names an authoring system, not a Version or a Release. `CONTEXT.md`'s Target
  vocabulary would need a third arm shape.
- **Full-motion-video engines.** `bladerunner`, `alg`, `hypno` and
  `cryomni3d` are mostly codec and mostly not bytecode. This project has met
  that shape once already and knows what it costs: AGOS needed a whole Smacker
  reader, and SCI32's own video is one of the subsystems still open.

Those three bullets are where an ADR would be needed before any code, and they
are the reason this file stops at a map.

## The honest summary

Eight of 126 engines are implemented and a ninth reads and disassembles its
games without running them. None of their games is `Completable`.

The two added are the two this page recommended, and the recommendation it made
alongside them is unchanged: **finishing the existing families comes first.**
Both of those sentences have been overtaken and are corrected here rather than
deleted: Broken Sword plays its cutscenes and uses both of Revolution's walk
animators, and Broken Sword II walks, scrolls, puts the spoken line on screen
and now lets the player pick a subject off the chooser bar. The two gaps this
paragraph used to name are closed — `fnChoose` and the three opcodes around it
have a menu module behind them, and both exporters carry their pictures out, so
a painted background in Sword1 and a repainted screen or animation in Sword2
reach the install. Sword1's export now carries its **recordings** out as well —
the speech container is rebuilt around a replaced line, a replaced tune is
written as its own `.WAV` beside the install, and a replaced effect's cluster
resource is substituted — while Sword2's does not, because this demo's
`resource.inf` names fourteen clusters and none of them is a speech or music
cluster, so there is no container here to rebuild. The gap this paragraph named after them — Broken Sword II's
**inventory mouse mode** — is closed as well: `Sword2Pointer` is the mouse
engine the bottom bar was always waiting on, so the bar opens by pushing the pointer to the bottom of the screen, an
icon can be picked up, examined, combined with a second or put down again, and
`fnSetObjectHeld` locks the mode while a script holds something for the player.
Both of the pieces this paragraph used to say were missing are now there.
`MOUSE_system_menu` is the fourth mode: pushing the pointer to the top of the
screen opens the panel, and its save and restore icons reach the shell's save
menu and its ten slots — options, quit and restart stay greyed, because this
shell's page is where those three live. And the dragged luggage **is drawn**:
`sword2Mouse.ts` decodes the `MOUSE_FILE` the icon's `luggage_resource` names
and the renderer stamps it on the display by its own hotspot. It is stamped
rather than composed into a cursor sprite because this family's pointer is the
browser's own and there is no sprite to compose with, which is `drawMouse`'s own
branch for exactly that case.

Two more things were true of the pair when this paragraph was written and are
not now. Broken Sword II drew **no player character at all** — `fnSetValue`
wrote the megaset resource eight bytes short of the field, onto `cur_dir`, and
every layer below it behaved correctly on the zero it was handed, so the game
ran and walked and scrolled with nobody in it. And Broken Sword took **2,365
frames** to reach an interactive state, which is 197 seconds: 1,909 of them
were the opening Smacker playing out, and the engine honoured Escape while
nothing in this project ever pressed it. Both are fixed and measured — one
keypress gets to interactive in the several hundreds of frames rather than the
several thousands (615, 787, 525 and 786 on four runs here; the figure moves
with how fast the host decodes the film, so a single number would be a
fiction), and two photographs of George in `/home/agent/reports/`. Neither was caught by any measurement here, and both
are the same lesson: a probe reads positions and pixel counts, so a character
nobody can see has a position and a wait nobody can skip is a frame count that
looks like patience.

A third thing this page had wrong, and it is the same kind of mistake: it said
Broken Sword II's demo ships no film of its own. It ships one. `demo.smdk`
begins `SMK2` and is sixty frames of the demo's title card at 640x400, and the
folder's own `files.txt` lists those exact 289,700 bytes under the name
`demo.smk` — the disc has a typo in a filename that the shipping `game.exe`,
which asks only for `%s.smk`, would have been refused by too. This project was
refusing it on the extension and reporting it absent. The sequence lookup now
offers an ordered list of candidates and lets the **bytes** decide which one is
a film, so a correctly-named file still wins and a misspelt one is still
opened; the demo plays its own opening, and the films it genuinely does not
hold — `eye` and `intro` — still complete immediately rather than stall.

Both Sword editors now **play an animation back at the rate the game plays it**,
which is the one editor capability on that table whose answer was a design
question rather than a format limit. Neither family's art carries a frame rate;
both engines step one frame a game cycle, and the script that plays a given
resource is what says the order and whether it runs at all. So the editors read
it: 145 of Broken Sword's 438 demo sprites and 185 of Broken Sword II's 509
demo animations have a player they can name, and every other resource says so
where the button would be rather than looping at an invented speed.
[`editor-parity.md`](editor-parity.md) §18a has the counts and the refusals.

Both Sword editors' left columns now fold into named sections, as SCUMM's and
AGOS's do, and each has an **Actors** section derived from the game's own data
— `o_type` in Sword1, and in Sword II the sixteen opcodes that can only be
pointed at an `ObjectMega`, because that family has no type word an editor can
reach. Each engine's status line still names every opcode a script reaches
and it does not implement, which is this project's standard for a known gap;
the demo's scripts reach none of the menu opcodes, so on that install the list
is empty and this page and the games' own READMEs are where the gap is written
down. That job is still smaller than a ninth family.

One more thing this page and two others had wrong, and it was a refusal rather
than a bug: Broken Sword's **room table** was recorded as editable and not
writable back because it "lived in Revolution's interpreter rather than in the
game's files, so there is nowhere to write a change". The interpreter is in the
install. `SWORD.EXE` sits beside the clusters, with `WINSWORD.EXE` and
`RUNSWORD.EXE` next to it, and it carries both the room table (at `0x84578`,
100 screens, 94 of them word for word the table this project had built in) and
52 **start positions**, which are not a table at all but four
`mov dword ptr [abs], imm32` instructions each. Both surfaces are now read out
of the install's own executable and written back into it, and an unedited
`npm run reexport:sword` covers 11 files rather than 8 — all three executables
byte-identical. [`editor-parity.md`](editor-parity.md) §33a has the addresses,
the counts and the one-edit diff.

The generalisable part is not about Broken Sword. It is that "there is nowhere
to write it" had never been searched for, and five refusals on this branch fell
the same way. A capability declined on a reason nobody measured is a capability
declined on a guess.

The scope is now the famous bespoke engines and not the number ScummVM quotes,
so the four generic interpreters are declined and the queue above is ten
engines rather than a hundred and twenty. That is still more work than the six
already here, and the recommendation this map makes is unchanged by the
decision: **finishing the existing six comes first.** The subsystems standing
between them and a game somebody can play through are named in
[`processes/verifying-version-support.md`](processes/verifying-version-support.md)
and [`released-games.md`](released-games.md) rather than guessed at — SCI stops
in one place for every game it reads, Sky reaches a room and no further — at
the game's own 80ms cycle now rather than at 200ms, which had it walking at 40%
speed — AGOS implements the common opcodes and names the rest — and each of those is a
smaller job than a new family for games a player already recognises.
