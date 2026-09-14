# Released Games

## Every engine family, and the Versions or Releases each one claims

Eight Engine families have an interpreter under this app shell
(`IMPLEMENTED_FAMILIES` in `src/engine/resource/families.ts` is the list the
refusal messages are generated from, and this table is the same eight spelled
out). The axis is a different shape in each family, which is why they are
separate sections below rather than more rows in one list: SCUMM has Versions
that each fix an instruction encoding, AGI has packaging majors crossed with
interpreter builds, SCI has Versions finer than any resource map, AGOS has
Versions that are titles, and the **four** one-game families — Revolution's two
Virtual Theatre games and Revolution's two Broken Swords — have no Version at
all, so their Target arms carry a **Release**.

The two Broken Swords are **two families, not one with two Releases** (ADR
0036). They share a publisher, a title and a naming scheme, and they share no
bytecode, no resource layout and no renderer — which is `CONTEXT.md`'s whole
test for an Engine family, failed on all three counts.

| Engine family | Maker               | Axis                      | The whole axis                                                                                                                                | Where to read it                                                                            |
| ------------- | ------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **SCUMM**     | LucasArts           | Version                   | v2, v3, v4, v5, v6, v7, v8                                                                                                                    | [SCUMM](#lucasarts--scumm-v2-to-v8-run-here)                                                |
| **AGI**       | Sierra On-Line      | Packaging major           | v2, v3 — over six interpreter builds                                                                                                          | [AGI](#agi--adventure-game-interpreter-198489)                                              |
| **SCI**       | Sierra On-Line      | Version                   | SCI0 early, SCI0 late, SCI01, SCI1 EGA-only, SCI1 early, SCI1 middle, SCI1 late, SCI1.1, SCI2, SCI2.1 early, SCI2.1 middle, SCI2.1 late, SCI3 | [SCI](#sci--sierras-creative-interpreter-198898)                                            |
| **AGOS**      | Adventure Soft      | Version, named as a title | Elvira1, Elvira2, Waxworks, Simon1, Simon2, Feeble, PuzzlePack                                                                                | [AGOS](#adventure-soft--simon-the-sorcerer-plays-its-opening-agos-reads-and-edits-the-rest) |
| **Sky**       | Revolution Software | Release                   | demo, floppy, cd                                                                                                                              | [Sky](#sky--virtual-theatre-v2-1994--reaches-a-room-nothing-plays-yet)                      |
| **Lure**      | Revolution Software | Release                   | demo, floppy                                                                                                                                  | [Lure](#lure--virtual-theatre-v1-1992--reads-and-edits-its-world-no-scripts-yet)            |
| **Sword1**    | Revolution Software | Release                   | demo, cd, psx                                                                                                                                 | [Sword1](#sword1--broken-sword-the-shadow-of-the-templars-1996--runs-draws-and-edits)       |
| **Sword2**    | Revolution Software | Release                   | demo, cd, psx                                                                                                                                 | [Sword2](#sword2--broken-sword-ii-the-smoking-mirror-1997--runs-draws-and-edits)            |

**A row in that table is a claim about which files the engine answers for, and
nothing more.** What each family can actually do with them differs enormously,
and the difference is the point of every section below:

| Engine family | What it does with a game today                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SCUMM**     | v4, v5 and v6 have real games behind them — Loom CD, Fate of Atlantis and Day of the Tentacle. v7 boots and renders and is not playable. v2, v3 and v8 have a synthetic fixture and nobody who has run one. **Loom CD starts at a difficulty menu, and a click on it starts the game.** That is worth saying because a report of "the player cannot be moved" in Loom was this: the menu is its own room 69, it has three buttons and no player character anywhere, and it hands control straight over — so every "is this interactive yet" test answered yes on frame 1 and then measured a floor click against a character who was not in the room. With a click on STANDARD the game proper opens: Bobbin on the cliff at frame 1,020, a floor click walking him 828,61 → 756,107, and a click on the sky changing 36,164 pixels as he walks to it. **The empty distaff there is the game's own state, not a missing interface.** All 61 verbs exist and none is on, because Loom's Subroutine 17 takes the branch it takes when `Bit[1]` is clear — the flag that also swaps Bobbin's costume animation set from 1,2,3,4,5 to 8,9,10,14,15, which is to say the flag for whether he is holding the distaff. Starting Subroutine 18 by hand, as an experiment and nothing the game did, lights verbs 1 to 8 as image verbs with real rectangles (16,144,48,168 and seven more) and draws the staff and its eight note letters, 2,603 pixels of it. **Day of the Tentacle's inventory panel is built correctly when it is empty**, which is the other question a report of this shape raises: verbs 201 to 205, 208, 209, 1 and 103 to 105 sit at `enabled = false` with a zero rectangle at the opening, and putting two of room 34's objects into Bernard's hands turns 201 and 202 on with rectangles 200,152,240,176 and 240,152,280,176 and draws both icons. An empty slot is what an empty slot looks like.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **AGI**       | Reads, runs, renders, parses and edits both majors. King's Quest III is walked out of Manannan's entrance hall into five rooms under player control — the study, the dining hall, the mountain path, the manor's clifftop exterior with its chicken pen, and the hall itself — each drawn and looked at, and its parser answers a typed command. No AGI game has been played through.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **SCI**       | Reads, identifies its own Version from its own bytes, draws Pictures and Views, and edits. King's Quest IV, answered at its copy-protection prompt, walks past it and draws its opening throne room with the cast animating. King's Quest VII, a retail SCI2.1 install, boots and is clicked through four screens — the Sierra logo, its main menu, its on-screen name-entry keyboard, and its chapter selector. No game is played through.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **AGOS**      | **Simon the Sorcerer plays its intro through, reaches its first room and walks about in it.** A retail Windows copy boots, runs its own code out of `GAMEPC` _and_ its thirty table files, plays the whole opening sequence — sixteen thousand frames, a nested chain of eight Subroutines, each animation waited for — and hands control to the player in the wizard's study, fire lit and verb bar drawn. **A player can now reach that**: Escape skips the opening, a bare floor click walks because Simon 1 always has a verb live, and every strip verb pointed at a room object answers in the game's own words — **drawn in letters**, since the font scan stopped choosing a pointer table in `Simon1.exe` over the font behind it. **A click moves him where it lands and out of the room**: 280,120 and 40,125 give different routes from `os1_getPathPosn` and put him at opposite ends of the study, and clicks at the doorway take him 91 → 160 → 161. **That held only for the game's first minute until this run**, and this row said so without knowing it: the drawing bytecode's bit flags were a bank per zone where the reference shares one bank with the game bytecode, so bit 11 — raised in zone 11 and lowered in zone 1 — stuck, and at frame 3,300 the walk's own stop script armed a `WAIT_SYNC` that fired on the player's first turn and killed the walk before a step. One bank now, and the same click walks him at 6,000 and 12,000 frames where before 3,400 was already too late. **And he is drawn in front of the fire he walks to.** Sprites were painted zone by zone, which made the zone the outer sort key and let a priority-30 fire in zone 64 paint over a priority-40 Simon in zone 11 — so a walk that ended at the fireplace looked like a character who had stopped existing. The reference keeps one priority-ordered sprite list for the whole game (`draw.cpp:202`, `vga.cpp:1275`); this now does too, with creation order as the tie-break. Measured unaided by `bin/play-probe.ts` on the retail talkie copy, with one Escape at a scene the game itself marks skippable: interactive at frame 2,993, a floor click walking him 136,61 → 56,69 (80px), and verb 205 pointed at box 12 changing 1,184 pixels after he walked 56,69 → 24,73 to reach it. Music renders, speech and per-scene effects are read, and it is editable with `Unrecovered: 0`. Not `Completable`: the stance he walks out of is left on screen beside him, a long line shows only its tail in a one-row window, and nobody has played it through. **Simon the Sorcerer 2 now plays its opening through too**, on a retail Windows talkie copy: sixteen scenes, 1,163 game instructions, the opening Subroutine running to completion rather than timing out, and Simon drawn standing in the street outside Calypso's with the game's nine verb boxes live. **Escape skips the opening**, and the permission is the game's: bit 9 is set, which is the flag the reference tests before honouring an Escape at all. Left alone the opening is still running thirty thousand frames in; with that one press a player is in the street at frame 2,538. **A click then walks him where it lands** — clicks at x 300, x 80 and x 220 put him at 216, 56 and 208 pixels, along the routes the game's own drawing scripts hand out. **And every verb answers**: clicking the strip and then the street's poster gives the game's own words for eight of its nine verbs, "Look at" reading the poster rather than refusing. **Both of those have since been measured unaided**, by `bin/play-probe.ts` on a boot with nothing but that one Escape: a floor click at 240,101 walks him 104,66 → 232,66, 128 pixels, and verb 202 followed by the poster changes 1,948 pixels and prints the game's answer in the panel after he walks 232,66 → 144,73 to reach it. The earlier figure on this row, "13,66 → 29,66", was the same walk read in the wrong units — AGOS holds a walker's x in eighths of a pixel column and its y in pixels, and reporting the raw pair made an eighty-pixel walk look like a walk that barely happened. **And he can leave the room**: a click at the shop door walks him off the street into Calypso's Magic Emporium and back out again, room 53 to 171 and home, through the engine's own step loop. **The inventory bar draws**: `ICON.DAT` is read and the item Simon carries appears in the icon window, the band going from 0 of its 20,800 pixels to 216 for one icon and 897 for seven. **The verb bar draws too, and survives a room**: its nine verb icons are part of the interface panel drawn into the screen's window 0, and a room is now cut to window 4 — the reference's 134-row play area — so its backdrop no longer paints over them; in room 53 the interface band holds 8,626 drawn pixels where before the room wiped it to nothing. **Wide rooms scroll**: a backdrop wider than the 320-pixel display is kept whole and the visible window cut from it at the scroll position, clamped to `width / 8 − 40` columns, and a click in a scrolled room is put back into room space before a route is chosen. **A save reloads into its own room**: it is re-entered through the reference's restore path — subroutine 100 with the redraw bit set — with the scheduled timers carried across rebased onto the loading clock, where before a save in room 53 reloaded into room 171. It is still **not** playable: nothing moves the scroll as a player walks — the rooms scroll and the driver that drives them does not exist — a loaded save comes back with one hit area rather than twelve and so is not yet interactive, and two of the game's sixty-seven rooms have been reached by anybody. **It is not black.** A run's report claimed a palette gap left Simon 2's rooms rendering black and its own screenshots rebuilt around it; measured on the plain `npm run shot:agos` path with nothing rebuilt, **218 of 256 palette entries carry colour and 28 of 49,147 lit pixels land on a black one**. Its music reads, all forty XMIDI tracks, and 26 of the 27 sound effects the opening asks for play. |
| **Sky**       | Reads both freeware releases whole, applies a Release's starting state, enters a room, runs the game's scripts and draws them. **A hover-then-click on the floor walks Foster, and a click on a thing walks him to it and runs its action to the end** — all six hotspots on the opening screen, measured, with screenshots. The route is a straight line and says so: the table naming which walk grid a screen uses is refused under ADR 0033, so a mega walks through scenery rather than around it. **That refusal now has a measured edge.** The reference's table is a dense numbering, so the map would derive from nothing but the set of screens that have a grid; reading `screen` off all 3,258 Compacts gives 74 distinct screens, and seventy grids ship. The Compacts name the grid-bearing screens and four others, and nothing in the container separates those four from the seventy. What is missing is the membership of four screens, not the ordering. A character's lines are counted and not drawn: Sky's text is compressed against a tree that is not in the shipped bytes. Nothing plays through.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Lure**      | Reads all eight containers and the world state a new game starts from, and holds that world as a typed, editable object table. Its bytecode is a separate system this project does not run yet.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

**Two Releases on this page are `Completable`** (`CONTEXT.md`), and both are
**demos**: Broken Sword's DOS demo and Broken Sword II's DOS demo, each played
from its first screen to its own ending film with a save and a restore in the
middle by `npm run play:sword`. The two sections below record the routes, the
saves and the screenshots. **No retail title on this page is `Completable`**,
in any family — that bar is a claim about a game's last screen, and for a
retail Broken Sword it would need the eight clusters this folder does not ship.

The distinction is the point rather than a hedge. "A demo has no last screen"
was the reason this page gave for not claiming it, and it was wrong on the
facts: both demos ship an ending film (`SMACKSHI/ENDDEMO.SMK` and
`Enddemo.smk`) and both reach it. A Release's last screen is the last screen
_that Release has_.

## LucasArts — SCUMM v2 to v8 run here

Every DOS Version LucasArts shipped the engine as, from Maniac Mansion to The
Curse of Monkey Island. v0 and v1 are out of scope — disk images and a
cartridge ROM rather than files
([`.out-of-scope/scumm-non-dos-releases.md`](../.out-of-scope/scumm-non-dos-releases.md))
— and so are the FM Towns, Amiga, Atari ST, Macintosh, PC-Engine and Sega CD
packagings of the titles that do run.

**Every title on this page has a folder in [`games/`](../games).** The folder is
named after the title — lower case, hyphens between the words — and carries a
`README.md` and the game's box art. Drop your own copy of the data in beside
them and the player lists it under that name. What those READMEs are worth, and
what they deliberately do not claim, is settled by
[ADR 0031](architectural-decision-record/0031-a-game-folder-readme-is-built-from-a-cited-source-and-is-never-a-support-claim.md):
the factual half is transcribed from a cited source, and the status half is
this page's own claim, repeated per game so it cannot be read past.

**Running is not finishing, and the difference is recorded rather than
smoothed over.** `docs/processes/verifying-version-support.md` carries a table
of what each Version's claim actually rests on: v4, v5 and v6 have real games
behind them, v7 boots and is not playable, and v2, v3 and v8 have a synthetic
fixture and nobody who has run one. **Completable** (`CONTEXT.md`) is claimed
for no title in the list below.

## SCUMM v0 (1987) — out of scope

- Maniac Mansion — C64, Apple II (original release)

## SCUMM v1 (1988) — out of scope

- Maniac Mansion — NES, and the Apple II/C64 revisions
- Zak McKracken and the Alien Mindbenders — C64, Apple II

## SCUMM v2 (1988–89) — runs; no game played through here

- Maniac Mansion — DOS/Amiga/Atari ST "enhanced" version
- Zak McKracken and the Alien Mindbenders — DOS, Amiga, Atari ST

## SCUMM v3 (1989–90) — runs; no game played through here

- Indiana Jones and the Last Crusade: The Graphic Adventure (incl. FM Towns/VGA 256)
- Loom — EGA floppy
- Zak McKracken — FM Towns enhanced (256-colour)

## SCUMM v4 (1990–92) — runs; Loom CD played to the distaff and plays drafts

- The Secret of Monkey Island — EGA and VGA floppy
- Loom — CD/talkie, FM Towns, PC-Engine/TurboGrafx
- Passport to Adventure (demo compilation: Indy 3, Loom, Monkey Island)

### Two things about Loom's opening that look like a dead game, and are not

Both were re-measured with `npm run shot`, which now hovers before it clicks
and renders every frame it steps.

**Control arrives ninety seconds in.** The skill-level screen wants a click —
there is no key that gets past it — and clicking STANDARD starts an opening
that runs as a cutscene: `userPut` goes false six seconds in and comes back at
ninety. Every click in between is correctly ignored, because the game is
playing its own scene. A probe that runs the usual twenty or forty seconds
therefore finds a game that will not move, and the reason is the clock rather
than the engine. After ninety seconds a floor click walks Bobbin, and clicking
along the cliff path takes him room 2 → room 3 → room 10 — the ledge
transitions on the way are Loom's own script 45, which watches the ego's walk
box and pans the camera when it changes.

**The empty band under the picture is Loom's decision, not a blank
interface.** The distaff's sixty-one verbs are created on entry, out of room
1's objects, and left off; the only script that turns them on is global script
18, and every call site of it is gated. Script 3 (control returning) and
script 6 (the mouse loop) need bit variable 1 set or `Global[150]` already at
2 — a redraw, not a first draw — and bit variable 1 is written in exactly one
place: script 120, the chapter-start setup, which the boot script runs only
when it is started past the beginning. On a new game Bobbin does not have the
distaff yet, so nothing draws one. The renderer underneath is not in doubt:
forcing all sixty image verbs on draws the staff at the foot of the screen
with correct bounds, and `hitTest` answers on it. Playing to the point where
Bobbin picks the distaff up — which an earlier run did, cliff to the great
hall — is what makes it appear on its own.

### What a click on a thing in Loom does, and why its scenery looks silent

Loom's own scripts resolve a click. `VAR_VERB_SCRIPT` is 5, so
`scriptsOwnInput` is true: the engine hands the press to the game rather than
composing a sentence of its own, which is the per-family input rule ADR 0011
sets. Traced with control in hand, on the leaf and on the sky in room 2, a
click runs script 5, then scripts 6 and 8, then **entry 55** on the object
clicked, then `startWalkActor`, then script 7, then **entry 56** on the same
object.

So a thing answers a click when it carries entry 55 or 56, and gets the walk
and nothing else when it does not. Which things do is a property of the tables
the game shipped, and those were read out of every room rather than sampled:
**78 rooms, 935 objects, and 239 of them carry a verb table at all.** Entry 56
is on 131 of those, 54 on 127, 57 on 113, 86 on 97 — and **entry 55 on twelve
objects in the whole game**.

The named scenery is on the wrong side of that. The `clam` and the four `gull`s
in room 10 carry entries 54, 57, 58, 59 and 86; `leaf` carries 54, 57, 65, 66,
86; `sky` carries 54, 57, 58, 59, 64, 86. Not one of them carries 55 or 56, so
a click walks Bobbin over and stops there — which is the game's design and not
a dropped response. Loom has no verb bar: its verbs are the drafts played on
the distaff, those other entries are what a draft reaches, and Bobbin has no
distaff yet in the opening (above).

What does carry entry 56 is the exits, and they answer. From the cliff at room
10, object 210 walks him out to room 5, object 126 from there to room 7, and
object 177 to room 8, each with the room drawn on arrival. The engine's side of
it is `findObjectVerbCode`, which looks an entry up in the table the room
shipped and falls back to entry `0xFF`: Loom's scenery defines neither, so it
correctly finds nothing to run and says so rather than inventing a reply.

## SCUMM v5 (1991–92) — runs; Fate of Atlantis played through five rooms

- Monkey Island 2: LeChuck's Revenge
- Indiana Jones and the Fate of Atlantis
- The Secret of Monkey Island — CD/FM Towns/Sega CD re-releases

## SCUMM v6 (1993) — runs; Day of the Tentacle plays

- Day of the Tentacle (bundles the v1 Maniac Mansion inside it)
- Sam & Max Hit the Road
- Early Humongous titles: Fatty Bear's Birthday Surprise, Putt-Putt Joins the Parade, Putt-Putt Goes to the Moon, plus their Fun Pack spin-offs

## SCUMM v7 (1995) — boots and renders; not playable, see the README

- Full Throttle
- The Dig

## SCUMM v8 (1997) — runs; no game played through here

- The Curse of Monkey Island — the last SCUMM game LucasArts shipped (Grim Fandango moved to GrimE)

## Humongous Entertainment (HE 60–100, forks of v6)

Same engine lineage, versioned separately as HE 60 through HE 100. Rough progression — the exact game→HE-number mapping is fuzzier than the LucasArts list above, so treat these groupings as approximate:

- HE 60–73: Putt-Putt Joins the Parade / Goes to the Moon / Saves the Zoo, Fatty Bear's Birthday Surprise, Freddi Fish and the Case of the Missing Kelp Seeds
- HE 80–90: Putt-Putt Travels Through Time, Freddi Fish 2, Pajama Sam 1, Big Thinkers, the Let's Explore/Junior Field Trip titles
- HE 95–98: Putt-Putt Enters the Race, Freddi Fish 3: The Case of the Stolen Conch Shell, Spy Fox 1: Dry Cereal, Pajama Sam 2: Thunder and Lightning Aren't So Frightening, Putt-Putt & Pep's Balloon-o-Rama / Dog on a Stick, Pajama Sam's Sock Works / Lost & Found
- HE 99: Freddi Fish 4: The Case of the Hogfish Rustlers of Briny Gulch, Spy Fox 2: Some Assembly Required, Pajama Sam 3: You Are What You Eat From Your Head to Your Feet, Blue's Clues: Blue's Birthday Adventure
- HE 100: Freddi Fish 5: The Case of the Creature of Coral Cove, Spy Fox 3: Operation Ozone, Putt-Putt: Pep's Birthday Surprise, Backyard Baseball/Football/Basketball (2001–2003), Moonbase Commander (2002) — the last shipped SCUMM-derived game

## Sierra — AGI is supported; SCI reads, identifies, draws, packs and plays back

Everything above is SCUMM. Sierra's lineage ran in parallel for a decade, and
this project implements both halves of it: **AGI runs here, and SCI is no
longer only a design.**

SCI0 through SCI3 were designed first — one Engine family, one instruction
encoding, a Version axis finer than the six names below, and a resource layer
that reads Volumes by offset rather than whole. The reasoning is in ADRs
0015–0021, and what is deliberately left out is in
[`.out-of-scope/sci-non-dos-releases.md`](../.out-of-scope/sci-non-dos-releases.md).

**What is built, stated at the granularity a reader can check.** The resource
layer, the PMachine, the SCI16 renderer and the SCI32 compositor, cel and vector
Pictures, EGA/VGA/V56 Views, the parser, sound, saves, the class graph and the
linker. Over the 25 freely distributed Sierra demos this project can point at,
every one identifies its Version from its own bytes — 16 by probe and 9 narrowed
only to a bucket, which play and are refused for editing (ADR 0013). Version
identification is a measurement published by `editableVersionGap`, not a claim.

**A SCI game now goes back out as a game.** `exportSciGame` has always answered
"what are this game's resources now"; nothing turned that map into files, so a
SCI project pressing Export game fell through to the SCUMM builder and was told
it had no rooms. `packSciGame` writes the `RESOURCE.MAP` and the Volume, in the
map structure read from the folder rather than guessed from the Version (ADR
0020 — a map's structure is the one thing about a SCI container that is never a
guess), and Save, Export game and Play all go through it. Play runs exactly the
install Save writes, over the re-supplied folder so the audio Volumes are read
where they already are (ADR 0010, #227). The editing surface gained the shared
Audio section and a PNG out of every View, Picture, font and cursor.

**What that is worth is Tier 1, and the page says so rather than implying more.**
`npm run reexport:sci` packs a game with nothing edited and reads the install
back through `SciResources` — the engine's own reader, run against 4,157
resources from seventeen Sierra demos — and over the four fixture layouts every
resource returns byte-identical and the map structure survives. **No packed
install has been loaded by ScummVM or by a Sierra interpreter**, and none of
this was run against a shipped game, because none was on the machine it was
measured on. That single check is what would move it off Tier 1.

It found one fault worth recording, of exactly the kind a packer checked against
itself cannot find: `detectMapVersion` infers a directory map's entry width from
the gaps between directory offsets, and a gap divisible by thirty is divisible
by both five and six — so a SCI1-late install whose every type block held a
multiple of five entries packed into a map this project reads back as SCI1.1,
parsed five bytes at a time, every resource lost rather than moved. It is
refused by name now, by handing the map just written back to the reader.

**The Kernel gap is a published number rather than an impression.**
`npm run sweep:sci -- --kernel-coverage` prints, per Version, four columns:
calls with behaviour, calls that answer the same value whatever a game passes
them, calls answered by the stub for the slots Sierra shipped and no retail game
makes, and calls that are absent. The constant column is the one that changes
the reading — `DoSound`, `Parse`, `Said`, `SaveGame` and `RestoreGame` were each
`() => int(0)` when that column was first measured, and only `Said` still is —
because a missing call reports itself the first time a game makes it and a
constant is silent. At SCI2, 80 of 150 named calls have behaviour and 28 more
answer a constant, so **the distance to a game that runs is larger than the
missing count and always was**.

**Nothing is absent from any SCI0 or SCI1 table.** Their file calls, and the
four SCI1 calls that each needed a hook into the engine — a palette loader, a
cel's pixels and its clear key, the resource map, the text-code font store —
are answered, so no script in any of those Versions can name a call this engine
has never heard of. **SCI1.1 has one left**, `Portrait` — the talking-head
surface, with its own resource kind and its own audio sync. SCI2 through SCI3
have between 33 and 35, which is the SCI32 compositor and little else.

**Two of those numbers came down without any code being written, and that is
worth saying.** Seventeen names counted as absent at SCI32 are `MAP_DUMMY` in
`kernel_tables.h` — placeholders Sierra shipped that no retail game calls — and
counting them made the published gap larger than the work in it. They sit in the
stub column now, where SCI16's equivalents already sat.

**A SCI game now reaches its first screen, and it is King's Quest VII.** A
retail 2.00b install boots, runs its main loop, plays the Sierra logo, animates
its title screen and draws its main menu — "Watch Intro", "Start New Game" and
"Quit" — at 640×480 out of the game's own resources. The same boot used to end
in a stack overflow with one distinct colour on the screen. **It is not
playable**: no video has played, no line of text has been drawn, no room has
been entered, and `Completable` is claimed for no title on this page.

It is also the first SCI2.1 game that may be **edited** — 218 Script resources,
2,821 objects, 4,104 Selectors, 158 classes, two Unrecovered. Its probes narrow
it to SCI2.1 middle and SCI2.1 late and can never do better, because nothing
structural this project reads moves at that seam; the two decode identically,
so which of them it is cannot change a byte an edit would write back. ADR 0013
refuses a _guess_, and Versions that decode identically are not one.

**What a real game found, which nothing here could have.** A retail King's Quest
VII was pointed at this engine and its boot produced ten faults in ten rounds,
every one invisible to the 4,800 tests and the 25 demos: `ScriptID` answering
nought for a script the class table did not name, `List`'s three walking
sub-functions never walking, `String`'s formatters, a transition that never
completed, a bad send ending the whole run rather than being stepped over — and
one that is not a SCI32 fault at all.

**Eight more followed, and the pattern held.** A list node keyed with nought so
nothing could ever be deleted from a list; a screen item that was never removed
and never updated in place; a Plane rebuilt by the call that was meant to update
it; a Plane's Picture read with a call that never fetches; a View drawn in
whatever colours the last Picture left behind; a position and a size scaled out
of one resolution when they belong to two; a Plane picture _code_ read as a
resource number; and a debug file-name opcode told apart by guessing whether the
bytes after it looked like text, which swallowed five bytes of live code and
desynchronised **execution** rather than merely a disassembly. Every one of
them is a bookkeeping error a game only pays for once it is doing several things
at once, which is exactly what a fixture is not.

**`-super-` was never resolved from a class number to the class it names.** The
property holds a number in the file and an address at run time, and turning one
into the other is the interpreter's job (`Object::initSuperClass`). Until it was
done, **every script in every SCI game that walked a class chain walked into an
integer** — `isKindOf` sends to its own superclass, so it sent to the number 82
and halted four layers from the cause. It took a game that walks the chain on
its boot path to show it; no fixture here does.

**Zero missing is not "SCI0 runs", and the gap that is left is the quiet one.**
Thirty of SCI0's calls still answer a constant whatever a game passes them, so a
SCI0 game reaches every name it asks for and gets silence from several that
matter. `SaveGame` and `RestoreGame` left that column when the object-graph
capture this project already had was finally reached from a game's own save
menu; `Parse` left it when the parser this repository already had was finally
called from the machine, and `Said` has not, so a typed line is now understood
and still matches no said-spec.

**`DoSound` left that column too, and it is the one worth being precise about.**
It is a real sub-function dispatcher now — the four sound-version numberings, so
the same integer names the call the Version means by it — and it keeps the
`Sound` object's own properties: `Play` writes the `handle` the scripts test,
`UpdateCues` writes `signal`, `min`, `sec` and `frame` back, `Stop` and
`Dispose` clear them. **There is still no synthesiser** (#219), so every slot is
one ScummVM would treat as having no data for the selected device, and its own
third branch of `processUpdateCues` is what this follows: the cue reports
finished. That is a call with behaviour and it is not sound. Nothing here plays
a note, and a game whose timing depends on how long a tune actually lasts is
being told the tune is over.

**What is not.** Nothing below is a `Completable` claim, which is the bar
`CONTEXT.md` sets for support, and none is close to one. Sixteen of the 25 demos
run without halting, twelve draw a Picture from the running game, and three
rooms have been looked at and confirmed by a person. **The first retail SCI
game has now been read too** — King's Quest IV 1.000.111, SCI 0.000.274, whose
190 scripts sweep clean and which draws its title screen — and, answered
correctly, it plays its opening.

**A second retail game has been read, and it is the first SCI32 one.** King's
Quest VII: The Princeless Bride — 3,112 resources, a `sci2` `RESOURCE.MAP`, a
Version its own bytes narrow to SCI2.1 middle or late and no further — boots,
loads all 218 of its scripts before the first send, and **on no input at all
plays its Sierra logo through and arrives at its own main menu**: `global13`
reads 15 at cycle 67 and 30 at cycle 139. It used to stop at 15 and stay there
for the remaining 1,731 cycles, because `doTheLogo::changeState` state 2 sets no
timer and the only cue left is the sound finishing — and `DoSound` was one of the
constants above, so `Sound::check` never saw the signal. Measured as an A/B,
same command, only that handler differing. Clicks take it through **four
screens**: the logo, its own **main menu** at room 30, the **"Name Your Game"
on-screen keyboard** at room 20, and that room's **chapter selector, "Which
Chapter?", 1 to 6**; that is where it still ends, and the cue chain moved the
start of the path rather than the end of it. The
keyboard answers clicks on individual keys — a click on `W` puts a `W` in the
name field — which is the first time a control in a SCI32 game here has answered
a click aimed at it rather than at the screen.

```
npm run diagnose:sci -- <path> 30 --play --click=161,117
```

What that is worth is one rung below the King's Quest IV rows: it is a command's
reading of a room number and a framebuffer, not a person's, so it is **not Tier
2 and not `Completable`**. Nothing past the first room has been reached.

**The SCI subtitles no longer say "not supported here", and that is a correction
rather than a promotion.** The chip is the engine family and Version (ADR 0031),
and every other supported family's is exactly that; "not supported here" had
come to mean the opposite of what a reader takes from it, because a SCI install
now boots, plays six screens into a retail game, draws 88 of that game's 108
rooms, and opens as a fully editable project. What is _not_ claimed is unchanged
and is where it belongs — in each file's `## How it runs here`, which says in as
many words that the title has not been run and that nothing here is
`Completable`.

**The menu was never broken; the game was refusing.** A previous round of this
page said the click "dispatches `doVerb` zero times" and named
`Feature::handleEvent` as the next question. That was wrong, and the correction
is the finding. `kFileIO` was one constant answering all twenty of its
sub-functions — and nought is the failure word of almost every one. "Start New
Game" asks `FileIO(17, 3, path)`, `FileIOCheckFreeSpace`, and on being told
nought it builds a warning and stays put. Measured as an A/B with the same
clicks and only the handler differing: `doVerb` dispatches in **both** runs; the
room changes in only one.

**The blank screen was the game quitting, not the engine stalling, and that
correction is the finding.** A previous round of this page said the interface
was undrawn; the round after that corrected it — `NewWindow`, `DrawControl` and
`EditControl` are implemented, a keystroke reaches the field — but then read the
`--play` diagnosis as a "pacing problem", a game "waiting for a clock that is
not advancing". It is not waiting for anything. `--play` presses Enter at the
copy-protection dialog **without typing an answer**, so the game compares a
blank string against Sierra's expected word, finds it wrong, and does exactly
what King's Quest IV does on a wrong answer: it sets its quit global and
`Game::play` returns. "Ran out of frames on a blank screen" is the game having
quit to what would be DOS.

Measured on King's Quest IV, which identifies itself as SCI0 early from its own
resources. The third column is the one the old readings could not produce,
because you cannot answer a manual question without knowing the answer — here
`--type=BOBALU` supplies it (recovered by logging the `StrCmp` the dialog makes):

|                            | No events          | `--play` (blank Enter)                            | `--type=BOBALU --play`                       |
| -------------------------- | ------------------ | ------------------------------------------------- | -------------------------------------------- |
| Where it ends              | in the dialog loop | `nothing running — the machine ran out of frames` | running, in the intro (`Game::play` intact)  |
| Dialog                     | open, unanswered   | closed on a **wrong** answer, game quits          | closed on a **right** answer, `StrCmp` `0`   |
| `GetTime` (mode 0, ticks)  | 1                  | ~140,000                                          | busy-loop, continuing                        |
| Pictures drawn by the game | 991 (title)        | 991                                               | 991 → 700 → 96 → 698 → **201** (throne room) |
| Distinct colours on screen | 2                  | 1 (quit, cleared)                                 | **26**, 82% not the commonest                |

So the copy-protection question is not merely **answerable** — answered, the
game walks past it and into its opening: the throne room draws, ten to twelve
cast members animate on it, and the magic mirror appears on the wall. A person
looking at the framebuffer sees King's Quest IV's first scene, not a blank
screen. What stops it _there_ is not settled, and two further runs narrowed the
question rather than answering it. Under `--play`, held for forty-five seconds,
no scene-advancing call fires — `DrawPic` stays at five and `NewWindow` at three
while `Animate`, `Wait` and `GetTime` each climb about fivefold — so the room
animates but does not change. Part of that, though, is the tool disturbing what
it measures: `--play` keeps pressing Enter and clicking every forty cycles
_after_ the dialog has closed, which the throne room reads as sixty-one calls to
`RestartGame` (a no-op stub here, silently dropped). Left silent instead after
the answer, that count is zero, one narration window opens (`NewWindow` two →
three) and the cast grows from ten to twelve — the scene is alive and slowly
populating, not spinning on a clock. So the honest reading is narrower than "a
long scripted sequence" simply playing out over wall-clock time: the scene is
drawn, coloured and animating; the `--play` harness disturbs it after the dialog
closes; and whether its cutscene ever completes is the next thing to instrument —
the scene's own state object, and whether it waits on an animation-completion cue
or on a sound cue. `DoSound` answers the second of those now; whether this game's
sound version is read correctly for SCI 0.000.274 has not been measured.

**What the `GetTime` count was, and was not.** It is not a stall. Those reads
are the `Wait` and cast-animation loop turning over while the dialog is open —
normal work, not a clock the game is stuck on. One real `GetTime` fault did
surface next to it and is now fixed: the call ignored its **mode** argument and
always returned ticks, but King's Quest IV asks mode 1 once at boot, which is
the wall-clock _time of day_ packed into sixteen bits, not a tick count. The
handler now reads all four of Sierra's modes (0 ticks, 1/2 time of day, 3 date);
it was never the blocker, and saying so is the point — no Kernel call was
missing in any of the three runs above.

`npm run diagnose:sci -- <path> --type=BOBALU --play` reproduces the third
column. SEQ difference frames do not decode either. See
[`processes/verifying-version-support.md`](processes/verifying-version-support.md)
for what has and has not been confirmed against real data, per Version and per
game.

`CONTEXT.md` calls the two an **Engine family**, and the split below is where
that word earns its keep — a SCUMM v3 and an AGI v3 are unrelated engines, so
neither is ever written as a bare "v3".

### Hi-Res Adventure (1980–84) — pre-AGI

Sierra On-Line's first adventures, before there was a reusable interpreter
worth naming.

- Mystery House (1980) — the first graphical adventure game
- Wizard and the Princess (1980), Cranston Manor (1981), Ulysses and the Golden Fleece (1981)
- Time Zone (1982), The Dark Crystal (1983)

### AGI — Adventure Game Interpreter (1984–89)

160×200 EGA, a two-word text parser over a `WORDS.TOK` vocabulary, and pictures
stored as _vector drawing commands_ rather than bitmaps. Resources live in
`VOL.n` data files indexed by `LOGDIR` / `PICDIR` / `VIEWDIR` / `SNDDIR`.

**AGI v1 (1984)** — PCjr-era, the format barely settled. **Out of scope.**

These are DOS self-booting floppy images and Apple II disks: a booter has no
filesystem at all, just sectors where Sierra put them, so reading one is a disk
format problem rather than an interpreter one. Every title in scope has a DOS
release with a `LOGDIR`, so supporting these would be a second way to load games
that already play. Recorded in full in
[`.out-of-scope/agi-booter-and-apple-ii.md`](../.out-of-scope/agi-booter-and-apple-ii.md).

- King's Quest: Quest for the Crown (1984)
- Donald Duck's Playground (1984)

**AGI v2 (1985–88)** — **supported.** The bulk of the catalogue; separate `*DIR`
index files over `VOL.n`, with no compression.

**Room 3 is not "pure navigation", and three measured attempts say so.** It had
been recorded as the cheapest of King's Quest III's unreached exits on the
grounds that its gate is a `posn` box and no flag. The box is real — the
entrance hall's north doorway is `new.room(3)` at `posn(0,93,42,109,44)` — and
so is the obstacle beside it: the study's stairs door is `posn(0,93,116,110,118)`,
the same x-column, lower down. So going north crosses the study's threshold
first, and the stated route was to clear y≈118 while outside x 93–110.

That route does not exist. Walking the ego from its start at (96,164) with
`npm run shot:agi -- <path> <out> --keys=13@1 --walk=…`:

| Walk held                     | Ended                  | Ego      |
| ----------------------------- | ---------------------- | -------- |
| east, north, west, north      | **room 5** — the study | —        |
| east (6s), north, west, north | room 7                 | (97,134) |
| west (6s), north, east, north | room 7                 | (98,127) |

**The ego's x moved 96 → 97 → 98 across all three, whichever horizontal
direction was held.** Vertical travel works — y went 164 → 134 → 127 — so this
is not the walk being ignored. It is that the walkable area at that height is a
column, and an ego that cannot leave x 93–110 cannot be outside it when it
crosses y 118.

So room 3 needs the game state that suppresses the study exit — `isset(222)`,
var 44 — and not a better route. Whoever takes it next should read room 7's
control and priority lines rather than keep walking, and the "cheapest, no
flag" label is withdrawn. **`Unimplemented: none` on every attempt**, so nothing
here is an engine gap.

King's Quest III is the first AGI game here with Tier 2 evidence: it reaches the
entrance hall of Manannan's house with the player in control, reports no
unimplemented opcode, and all 125 of its Logics decompile and re-emit
byte-identically. A copy that ships no `AGIDATA.OVL` now has its arity table
**probed** against its own bytecode rather than assumed, which rules out the
tables the game contradicts and names the ones it does not.

**Gwydion now walks out of that hall, and the parser answers him.** Driven
headlessly with `npm run shot:agi -- <path> --keys=13@1 --walk=<dir>@<sec>`, the
ego leaves room 7 through three of the four exits its own `look` names — "the
front door is to the south, creaky stairs go upstairs, and doorways lead north
and east": up the creaky stairs into Manannan's study (room 5, where the
wizard's Logic sees the intrusion and scowls "Boy, you know I don't like you to
enter my private study"); east through a doorway into Manannan's dining hall
(room 8, `--walk=2@2,3@6` — a long pine table and benches under a winged emblem,
whose own `look` reads "This is where Manannan eats his meals ... benches large
enough to seat at least ten people"); and south through the front door onto the
mountain path outside the house (room 33) — and from that path, walking north
again reaches the exterior of Manannan's house itself (room 34), a blue-roofed
manor with a fenced chicken pen and a figure wandering beside it (view 205). The
fourth exit `look` names, the hall's north doorway, is not taken, and Logic 7's
own exit boxes say why it cannot be by walking. The doorway to room 3 fires on
`posn(ego, 93,42, 109,44)` and the stairs to the study on `posn(ego, 93,116,
110,118)` — the same x-column (93–109), the study's band a full column-width
below room 3's. The ego enters at `(95,165)`, inside that column; walking north
it reaches the study box at `y≈118` and transitions (measured: `(95,120)` on one
tick, room 5 the next), long before `y=44`. The only northbound floor is that
column — walking west jams against a wall at `(75,146)`, with no floor above it —
so room 3's threshold is an arrival point, reachable only by coming _down_ into
the hall, not a walkable way out. Each of the five
rooms was drawn to a PNG and looked at — the staircase hall, the shelved study
with its map and cat, the benched dining hall, the vector-drawn cliffs, and the
manor with its coop — and each is recognisable and correctly coloured, with the
priority bands placing the ego in front of the floor and behind the scenery. The
parser path is exercised the same way: `--say="look"` returns the authored room
description, `--say="look at portrait"` returns the game's own `I don't know the
word "portrait"`. This is exploration and parsing on a real AGI game, not a
playthrough — no puzzle is solved and no score is earned.

- King's Quest II: Romancing the Throne (1985)
- King's Quest III: To Heir Is Human (1986)
- Space Quest: The Sarien Encounter (1986)
- Space Quest II: Vohaul's Revenge (1987)
- Leisure Suit Larry in the Land of the Lounge Lizards (1987)
- Police Quest: In Pursuit of the Death Angel (1987)
- The Black Cauldron (1986)
- Mixed-Up Mother Goose (1987)
- Mickey's Space Adventure (1984), Winnie the Pooh in the Hundred Acre Wood (1985)

**AGI v3 (1988–89)** — **supported.** One combined `<GAMEID>DIR` index, and
LZW-compressed volumes. Packaging only: v2 and v3 share an instruction encoding
outright, so one Logic interpreter covers every Target between them (ADR 0012).

- King's Quest IV: The Perils of Rosella (1988) — shipped in _both_ AGI and SCI versions
- Manhunter: New York (1988), Manhunter 2: San Francisco (1989)
- Gold Rush! (1988)

### SCI — Sierra's Creative Interpreter (1988–98)

Replaced AGI's fixed interpreter with a real object system: classes, a message
dispatch, and 320×200 (later 640×480) graphics. Resources are indexed by
`RESOURCE.MAP` over `RESOURCE.000`/`.001`… volumes.

**SCI0 (1988–90)** — 320×200 EGA, still parser-driven

- King's Quest IV: The Perils of Rosella (1988) — the first SCI game
- Leisure Suit Larry 2: Goes Looking for Love (1988), Larry 3: Passionate Patti (1989)
- Space Quest III: The Pirates of Pestulon (1989)
- Police Quest II: The Vengeance (1988)
- Hero's Quest / Quest for Glory I: So You Want to Be a Hero (1989)
- Codename: ICEMAN (1989), The Colonel's Bequest (1989)
- Conquests of Camelot: The Search for the Grail (1989)
- Quest for Glory II: Trial by Fire (1990) — SCI01, EGA and still parser-driven

**SCI1 / SCI1.1 (1990–93)** — 256-colour VGA, the parser replaced by an icon bar

- King's Quest V: Absence Makes the Heart Go Yonder! (1990) — the first VGA SCI
- Space Quest IV: Roger Wilco and the Time Rippers (1991)
- Leisure Suit Larry 5 (1991), Larry 6: Shape Up or Slip Out! (1993)
- EcoQuest: The Search for Cetus (1991), Castle of Dr. Brain (1991)
- King's Quest VI: Heir Today, Gone Tomorrow (1992)
- Quest for Glory III: Wages of War (1992)
- Space Quest V: The Next Mutation (1993)
- Freddy Pharkas: Frontier Pharmacist (1993)
- Gabriel Knight: Sins of the Fathers (1993)
- Pepper's Adventures in Time (1993), Mixed-Up Mother Goose VGA remake (1991)

**SCI2 / SCI2.1 (1994–96)** — 640×480, full-motion video, the SCI32 line

- King's Quest VII: The Princeless Bride (1994)
- Quest for Glory IV: Shadows of Darkness (1994)
- Phantasmagoria (1995), Phantasmagoria: A Puzzle of Flesh (1996)
- Gabriel Knight 2: The Beast Within (1995)
- Space Quest 6: Roger Wilco in the Spinal Frontier (1995)
- Torin's Passage (1995), Shivers (1995)
- Leisure Suit Larry 7: Love for Sail! (1996)

**SCI3 (1996)** — the last of the line

- Lighthouse: The Dark Being (1996)
- RAMA (1996)

## Revolution Software — the Virtual Theatre families, Sky and Lure

Revolution called their engine **Virtual Theatre**, after the layer that lets
background characters go about their business independently of the player. It
ran exactly two games, and **both are in scope** — as two Engine families, not
one.

That is the decision worth knowing before reading the list. Virtual Theatre is
Revolution's name for a lineage; it is not a family name here, because a family
is one interpreter and this is two of them under a marketing name. The families
are **Sky** and **Lure**, which is what ScummVM calls the two interpreters, and
ScummVM implements them as separate engines sharing no code (ADRs 0023, 0026).

"The Virtual Theatre families" is the correct phrase. "The Virtual Theatre
family" is not.

Non-DOS releases of both — Amiga, Atari ST, Amiga CD32 — are out of scope, and
for a sharper reason than the other families' ports:
[`.out-of-scope/virtual-theatre-non-dos-releases.md`](../.out-of-scope/virtual-theatre-non-dos-releases.md).

### Lure — Virtual Theatre v1 (1992) — reads and edits its world; no scripts yet

- Lure of the Temptress — DOS floppy, and the demo

**Its bytecode now has a reader, and no entry point.** Lure's script encoding
is read: one byte whose **low bit is a has-parameter flag**, the opcode being
what is left after shifting that bit off, and a 16-bit little-endian operand
where the flag is set. So the same opcode appears as two different bytes
depending on whether it carries an operand, and reading the byte as the opcode
gives a listing that is wrong while still decoding — every value doubled and
every length one. The 26 opcode names are generated by
`npm run gen:lure-tables`, on ADR 0029's rule that such a table is never
transcribed.

**What is missing is where the scripts are, and the reason is ADR 0024 again.**
ScummVM reads Lure's script data from resources `0x3f0c` and `0x3f0d`, and
those ids are its **generated `lure.dat`**, not anything Revolution shipped.
Measured over the four VGA disks of the freeware release, the ids the game
actually carries are:

| Disk | Resources | Id range          |
| ---- | --------- | ----------------- |
| 1    | 39        | `0x0001`–`0x0049` |
| 2    | 103       | `0x4008`–`0x7901` |
| 3    | 118       | `0x86ff`–`0xa414` |
| 4    | 77        | `0xc008`–`0xff11` |

Nothing in `0x3f00`–`0x3fff` exists on any of them. The numbering is simply a
different one — note that `0x400e` is resource **16398**, the world state ADR
0024's third amendment found on disk 2, so the shipped ids are the ones this
project already reads successfully elsewhere.

So the disassembler is **checked against a fixture and not against the game**,
which is Tier 1 and says so. Finding the script blob in shipped data is the
open question, and it is the same shape as Queen's: the only directory anybody
has is ScummVM's, and reading it is refused. That is now three famous engines
waiting on one decision — see
[`scummvm-parity-roadmap.md`](scummvm-parity-roadmap.md).

### Sky — Virtual Theatre v2 (1994) — reaches a room; nothing plays yet

- Beneath a Steel Sky — DOS floppy, DOS CD (with recorded speech), and the demo

### What is decided, and what is built

**Neither family has a Version axis**, and the gap is the finding rather than an
omission. Each is one game with one engine lineage under it, so both Target arms
carry a **Release** — demo, floppy, CD — where the other three carry a Version
(`CONTEXT.md`). Two families with no Version between them is what a one-game
family looks like.

**What is decided.** That Sky is a fourth Engine family and worth having for one
game (ADR 0023); that Lure is a fifth rather than a second Sky Release, because
Virtual Theatre fails two of `CONTEXT.md`'s three sharing tests where SCI failed
one (ADR 0026); that each game's object table is extracted from its own DOS
executable — since amended twice, and both ways: `sky.cpt` is **accepted** for
Sky because Revolution gave ScummVM the game's source and that file ships as
part of the freeware CD release, and Lure's table turned out not to be in its
executable at all but to be resource 16398, which the executable loads into the
buffer a save is restored into (ADR 0024, first and third amendments).
ScummVM's generated `lure.dat` stays refused, and more comfortably than before:
there is now no reason to want it. And that
a Project for either holds that object table as its primary editable surface
while its bytecode starts as Disassembly (ADR 0025).

**What is built. The resource layers, and nothing above them.** Both families
read their own files, checked against the shipped games rather than against a
fixture:

|      | Read                                                      | Checked against         | Result                                                                                                                                                                     |
| ---- | --------------------------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sky  | `sky.dnr` addressing `sky.dsk`, RNC ProPack v1 unpacking  | Both freeware releases  | 1,445 and 5,097 resources read, 5,907 unpacked and CRC-checked, **nothing unreadable**                                                                                     |
| Sky  | The Compact table in `sky.cpt`                            | The freeware CD release | 3,258 records with named, typed fields, 76 aliases, a starting state for seven Releases, **nothing Unrecovered**, rewrite byte-identical                                   |
| Sky  | Every script, as a read-only instruction listing          | Both freeware releases  | **1,768 of 1,768 scripts** across 7 modules and 65,061 instructions, listed to an exit without the listing once having to stop                                             |
| Sky  | The world state a save holds and a new game starts from   | The freeware CD release | The seven starting states in `sky.cpt`, **all seven read and rewritten byte-identically**, at a length the Compact table predicts exactly                                  |
| Sky  | Pictures and palettes                                     | Both freeware releases  | **961 pictures whose geometry describes them exactly and none that disagrees**, 33 full 320×200 screens, 29 palettes — and three screens written out and looked at (below) |
| Lure | The eight disk containers, their directories and palettes | The freeware release    | **626** resources across 8 containers, **every rewrite byte-identical**                                                                                                    |

`npm run sweep:vt` is that check and CI runs it on every pull request, which is
the only place in this project where CI meets a real game (#266).

**Both families have an Engine now.** `SkyEngine` loads the game, applies its
Release's starting state, enters the section that state names, and runs its
scripts: **766 script runs over 200 ticks** on the freeware CD release, and
**11,452 over 3,000**.

It runs those scripts at the game's own rate now, and used to run them at 40%
of it. `ticksPerStep` read twelve sixtieths — five logic cycles a second —
where `_systemVars->gameSpeed` is 80 milliseconds (`sky.cpp:406`, used as the
delay at the foot of the main loop at `sky.cpp:285`), which is twelve and a
half. It shows up in the walk because that is where the rate is most visible:
Sky advances a mega by exactly one entry of its walk table per logic cycle
(`Logic::mainAnim`, `logic.cpp:388-400`), so the cycle rate _is_ the walking
speed. Foster crossing screen 0 from the bar to the floor hotspot takes the
same 36 cycles and the same 132 pixels either way, and **7.20 seconds before
against 2.88 after — 18.3 pixels a second against 45.8**. Nothing in the
routing was wrong, and no other family's timing is touched: `ticksPerStep` is
per engine. So Sky left
`src/engine/resource/engineSignatures.ts` — the rule AGI followed at #125, SCI
at #216 and AGOS at ADR 0027 — and **Lure has now left it too**, the fifth
family out by the same door: `LureEngine` reads the eight containers and the
initial world state, which is the foundation an interpreter is built on rather
than a finished one. It runs no scripts, because Lure's bytecode is a separate
system from Sky's (ADR 0026) and this project reads neither yet, and it says so
rather than showing a black screen.

**Those first two numbers used to be roughly ten times larger, and the
difference was a bug.** `Logic::engine` skips a Compact whose `status` lacks
ST_LOGIC — "check the id actually wishes to be processed" — and nothing here
read `status`. Since `fnKillId` works by clearing it, a Compact had no way to
stop existing: about thirty-seven of the CD release's opening list killed
themselves on their first tick and were run again every tick afterwards. A
script-run count is a measure of work done, so the larger figure was not a
better result; it was the same idle world, counted many times over.

**It reaches a room on the freeware CD release**, and `npm run play:vt` reports
the Stage as `room` for that release and no other. The rung is earned by a
measurement rather than by an engine existing: a background is drawn,
`MOUSE_STATUS` says the pointer is live, and the pointer engine finds hotspots
on that screen. On the opening screen it finds **seven** — `menu_bar`, `door`,
`fire_notice`, `bar`, `floor`, `upstairs`, `low_floor` — hovering one sets
`SPECIAL_ITEM` and clicking it sets `BUTTON` and runs the game's own script.

Getting there took four corrections, and each of them hid the next:

| What was wrong                                   | What it cost                                                            |
| ------------------------------------------------ | ----------------------------------------------------------------------- |
| Nothing read a Compact's `status` for `ST_LOGIC` | `fnKillId` never stuck; ~37 Compacts a tick killed themselves and reran |
| Applying a state entered no section              | No section's grids, music or sound were ever asked for                  |
| `fnDrawScreen` was read as `(screen, palette)`   | It takes one argument, the palette; the background is `LAYER_0_ID`      |
| `fnAddHuman`/`fnNoHuman` wrote `MOUSE_STOP`      | `MOUSE_STATUS` — the variable a booted game polls — was never written   |

Two of those are about pictures rather than logic. A room is **320x192**, not
the display's 320x200, so the engine's own screen test never matched one; and a
room's bytes are **tiles**, a 20x24 grid of 16x8 cells, because the game redraws
only the cells its grid marks dirty. Reading it as rows gives a picture of the
right size in the right colours and banded horizontally, which looks like a
palette fault and is not one.

What is still missing is named rather than guessed at: the **sprites** that
would stand in the room (#256). The **walk grid** used to sit in this list too —
`Logic::engine` brackets every Compact's logic with `objectToWalk`, and for a
long time nothing read a grid here, so nobody routed anywhere. That gap is
closed: the 70 grids are read into a per-cell accessor and the router walks on
them (below).

**A floor-click now reaches that gap instead of being swallowed before it.**
The click runs three scripts in the order the game runs them — the object the
pointer leaves (its `getOff`), the one it lands on (`mouseOn`), then the click
itself (`mouseClick`) — and the first of those puts the cursor back to normal.
So the cursor mcodes had to exist before the click could be read at all:
`fnNormalMouse` and its seven siblings (`fnBlankMouse`, `fnDiskMouse`,
`fnCrossMouse`, the four `fnCursor*`s) and the two hand cursors
(`fnOpenHand`/`fnCloseHand`). Each is a `spriteMouse` in the game and nothing
else — it picks which frame the pointer shows and returns — so with no renderer
to blit it (#256), recording the chosen sprite is the whole behaviour rather
than a stub, the way `drawnScreen` records a background nothing paints. Then the
click's own script runs: `fnSaveCoods` writes the pointer into `SAFEX`/`SAFEY`
— where the player asked to walk — and `fnAssignBase` hands the player the walk
script.

**`fnAssignBase` had a correctness bug that hid all of this.** The game sets
`logic = L_SCRIPT` there, and this engine did not — so a Compact that had idled
itself with `fnIdle` (`logic = 0`) was handed the walk script and left switched
off, keeping it and never running it. Foster took his click, sat on `logic = 0`,
and ignored it; the whole path looked absorbed. With `logic` set (and the base
script's offset carried from the high word, which was also dropped), Foster runs
the base on the next tick and reaches **`fnGetTo`** — the routing itself, the
mcode that finds the get-to script for a place.

**The click now travels get-to → interact → action → a routed walk.** `fnGetTo`
and `fnInteract` are the two-step dispatch that carries a click from the walk
script to the action it was for. `fnGetTo` reads the place the mega is standing
at — its `place` names a Compact whose `getToTableId` is a table pairing a
destination place with the script that reaches it — advances the script slot the
way `fnStartSub` does, and drops the get-to script in. `fnInteract` then runs the
_target's_ `actionScript` **on the mega**, one script slot up, the way
`fnStartSub` runs a subroutine. That last point was wrong here until this run
and it cost the whole walk: the script was installed on the target instead, and
`floor`'s `status` is 16 with no logic bit, so it is not in the logic list and
nothing ever ran it. The click completed, the mcode returned, and nobody moved.
Two facts in the shipped data settle it — that status, and `floor`'s action
script number 31, whose first instruction reads `downFlag` and whose sixth calls
`fnAr(SAFEX, SAFEY)`, both of them the mega's own fields.

That interaction reaches **`fnAr`**, which records the target
(`arTargetX`/`arTargetY`), snaps both ends to an 8-pixel cell and drops the mega
onto **logic 2** ("make a route"); **`fnArAnimate`** drops it onto **logic 3**
("follow a route"), which steps it along. What a leg costs is read out of the
mega's own animation set rather than assumed: four words an entry — a distance,
a frame and a signed step — and the four programs Foster's second set names
carry `(0,-2)`, `(0,+2)`, `(-4,0)` and `(+4,0)`, which is what fixes the
direction numbering as up, down, left, right. The standing programs agree
independently: their frames are 44, 40, 42 and 46 against walk frames 0–9,
10–19, 20–29 and 30–39.

### The router was built, measured working, and then removed

**This is a regression, taken deliberately, and it is recorded rather than
quietly reverted.**

A router was written and it worked. Measured on the freeware CD release before
the change: clicking the floor at (152,80) routed the player, who walked from
(288,216) to (280,216) and arrived in the clicked cell. That is the only time
anything in Sky has answered a player action here.

It rested on `_gridConvertTable`, a constant array transcribed from ScummVM's
C++ source, which maps a screen number onto which of the seventy grid
resources applies. The branch that wrote it argued the array was engine logic
rather than world data, on the same footing as the mcode names already shipped.

**That argument does not survive ADR 0033**, and the ADR is explicit about the
route rather than only the destination: a directory is "not copied out of a
support file and it is not transcribed out of a reimplementation's source,
which is the same act with an extra step". A screen-to-grid-slot map is
addressing — it says which resource to use — so it is a directory, and the ADR
says derive it from the shipped bytes or refuse it by name. Three derivations
were tried and all three measured negative, which is recorded above.

So the table is refused and the router went with it. `npm run play:vt` now
reports `fnAr is not implemented` at word 2303 of Foster's script, and the row
at the top of this page says the same.

**The cost is the point.** An ADR that only ever forbids things nobody wanted
is not being tested. This one removed a working feature, and that is what it
looks like when a rule about provenance has teeth. The router is not lost — it
is at the tag `working/sky-router-with-convert-table` — and it becomes
mergeable the moment the screen-to-slot mapping is derived from bytes
Revolution shipped rather than read out of somebody else's source.

**The walk grid is read and checked; nothing routes on it, and that follows from
the refusal rather than from missing work.** Both freeware releases ship the 70
grids as resources **60000–60069**, contiguous, 120 bytes each — the same count
as ScummVM's `TOT_NO_GRIDS` — decoded as 40×24 cells of 8×8 pixels through the
dword bit-mirror the format uses (`SkyGrids`, `tests/sky-grid.test.ts`). What the
test suite checks is the property that holds without a running game: the
bit-index maths is a bijection onto the grid's 960 bits. What it cannot check is
any single cell's meaning, because with the screen→slot map refused there is no
way to say which grid a screen is using, and the per-cell reader has no consumer
in gameplay. `SkyGrid.ts` records that in the module doc rather than in a
changelog.

### The route is a straight line, and the module doc says so

`fnAr` lands, and **a floor-click walks Foster**. Measured on the freeware CD
release with `npm run probe -- /home/agent/games/sky`, hovering twenty frames
before pressing: a click on the floor hotspot at screen (24,72) walks him from
(288,216) to (152,208), and a click on the door at (272,32) walks him from
(152,208) to (384,224). Screenshots of both are the evidence, and the run stops
on nothing.

**What it does not do is walk around anything.** `routeDirection` picks one axis
at a time from the live position — horizontal, then vertical — and consults no
grid, because the map naming which grid a screen uses is refused (above). Foster
walks through scenery rather than around it. That is stated in the code at the
one place a reader would look, in the engine's own status line, and here; it is
not a routing algorithm waiting to be tuned, it is the absence of one, and the
thing that would replace it is the derivation ADR 0033 asks for.

**A walking mega used to paint itself into the room.** `paintBackground`
returned early whenever the room had not changed, so sprites accumulated on a
background nobody restored, and a walk across a screen left a row of Fosters
behind it. The background is now laid down every frame from a decoded copy kept
for the purpose — the decode once per room, the copy once per frame.

**Two things that looked like they were stopping Sky, and are not.** Both were
measured on the freeware CD release rather than reasoned about:

- **Variable 111**, the top of the "read and never written" list the stall
  report prints, has exactly **one** reader: the `lazer_s4` Compact, reading it
  once a tick across 1,200 ticks and finding 0. Its writers are five
  `pop_variable 444` sites in the script module that holds that same Compact,
  inside a branch the opening never enters. One scenery script idling is not a
  player who cannot move — the floor click walks Foster with that read happening
  every tick — and the report's wording now stops short of calling a poll a
  fault.
- **`fnStartMenu`** is reached **once** per booted run, takes one argument, and
  is called from eight sites in script module 0. The call the opening reaches
  writes `MENU` = 1 immediately before it, so it starts the game's menu; what it
  then does is not established here, because the name is all this repository
  has — ScummVM's Sky engine is not among the sources this work had to read, and
  guessing at a menu's behaviour would be inventing one. It gates nothing a
  player needs first: the run is interactive with the pointer live, and the walk
  and the door click both happen, with `fnStartMenu` unimplemented and named.

Nothing plays. The editing surface is the Compact table, with the bytecode a
read-only listing beside it (ADR 0025).

**Which Sky Release can be played is now a real distinction rather than a
theoretical one.** The freeware **CD** release ships `sky.cpt` and can supply
Compacts; the freeware **floppy** ships neither that nor `SKY.EXE` and cannot,
so it is refused with a message saying exactly that. Reading Compacts out of
`SKY.EXE`, which the original 1994 discs carry, is **not implemented**: no
original release has been available to check such a reader against, and the
Compact table is the structure the entire game world lives in.

**Sky saves and restores.** A save round trip on a world that has actually run
survives — room, script variables and the Compact table's mutable fields — and
a save tagged for another game is refused rather than half-applied (ADR 0012).
Both are checked by `npm run play:vt` against the shipped game, not a fixture.

**Neither game plays, and neither is Completable.** `npm run play:vt` reports
the stage a run reached: Sky reaches **`room`** and Lure reaches **`loaded`**. A
room is not a playthrough. But the first thing a player asks of a room — to go
somewhere — now happens: the harness hovers, clicks the floor, `fnGetTo` picks
the get-to script and `fnAr` walks Foster to the point clicked — in a straight
line, on no grid, for the reason above.

### A click on a thing now does the thing, and one line of it was swallowed

**Every hotspot on the opening screen used to walk Foster over and then stop
dead.** Measured on the freeware CD release, hovering twenty rendered frames
before the press: a click on `fire_notice` ran `fnGetTo`, walked him from
(288,216) to (384,224), ran `fnLeaving`, `fnArAnimate` and `fnSetToStand` — and
that was the end of it. `mode` stayed 4 and the `fnInteract` that sits after the
walk in the clicking script never ran. The walk worked and the action was
swallowed, which from outside is a game that goes where you point and does
nothing when it gets there.

It was one missing ending. **An animation that ignores coordinates never told
its Compact the program had run out.** The coordinate-carrying kind does —
`stepAnimation` clears `downFlag`, puts the Compact back on logic 1 and the
engine runs its script in the same tick — and its sibling returned instead,
leaving the Compact on logic 16 re-reading an exhausted program every tick
forever. That matters far beyond animation, because `fnSetToStand` puts _every
arriving mega_ on that logic: the end of a stand-up program is the moment a walk
hands the script back to whatever asked for the walk.

With the ending in place the rest of the chain runs, and what it reaches is the
game's speech. Three mcodes stood between a click and a complete action, and all
three are now counted gaps rather than stops:

- **Speech.** `fnSpeakMe`, `fnSpeakMeDir`, `fnSpeakWait` and `fnSpeakWaitDir` —
  339, 650, 280 and 35 call sites across the shipped modules, three arguments
  every time, which makes speech the most-called thing Sky's scripts do. The
  words cannot be produced here: the text is compressed against a tree that is
  not among the bytes Revolution shipped, so the only place to get one is a
  reimplementation's source, which ADR 0033 refuses. What settled the argument
  for carrying on rather than stopping is what stopping cost, measured: an
  action script brackets its line with `fnNoHuman` before and `fnAddHuman`
  after, so a stop on the line meant the control taken away for the line was
  never given back. Every object in the game locked the game up. Who was asked
  to speak and which line is recorded on the world; the pause a line should
  cost is **not** reproduced, because its length is a function of the characters
  and the recording, one refused and the other #257. That is the pacing
  divergence `CONTEXT.md` warns about, stated rather than hidden.
- **Sound.** `fnStartFx` (381 sites), `fnStopFx` (67), `fnStartMusic` (60),
  `fnStopMusic` (10) and the pause pair are counted the way an animation
  program's own effect requests already were. Nothing in the bytecode reads back
  what is playing, so passing them over leaves no state a script will find
  missing.
- **The walk grid.** `fnToggleGrid` flips the one grid bit `SKY_STATUS` carries
  and counts the plotting nobody does — the same shortfall `fnKillId` already
  records, and it follows from ADR 0033's refusal rather than from missing work.

Two more were derived from the shipped call sites rather than stubbed:
`fnForeground`, `fnBackground` and `fnSort` move a Compact between the three
drawing layers the renderer already walks. The argument is a Compact id — 42 and
61 sites for the first and last, one argument each, most pushing `ID` and the
rest a literal id — and `fnBackground`'s 38 argument-less sites mean the Compact
whose script is running. The three bits are exclusive, so setting one clears the
others.

**What that buys, on the opening screen of the freeware CD release.** All six
hotspots now run their action to the end with nothing stopped: `door`,
`fire_notice`, `bar` and `upstairs` walk Foster over, take the pointer away, ask
for Foster's lines, give the pointer back and stand him up; `floor` walks him;
and `low_floor` walks him to the head of the stairs, puts him in the foreground
layer, toggles the grid, asks for a music track and runs the climb-down
animation that leaves him on the floor below. Photographed: screen 0 before the
click, and Foster stood in front of the fire notice after it.

**The words are still not on screen and nothing is claimed to have been said.**
A spoken line here is a number the report can name, not a sentence a player can
read. What is still missing for a playthrough is the rest of the room's life —
the sprites that would stand in it, the game's own words, and the subsystems
above (#256, #257).
`room` is not `last-screen`, and the harness will not print `last-screen` until
a run reaches the game's ending with the player in control.

**Three Sky screens have been drawn and judged by eye**, with
`npm run shot:sky` against the freeware CD release: the Virgin Interactive
publisher screen (resource 60110), the Revolution logo (60112) and two of Dave
Gibbons' intro panels (59502, 59522). All four are recognisable and correctly
coloured. That is a stronger check than it looks — a wrong index reading, a
wrong RNC decompression, a wrong geometry word or a wrongly widened palette all
give noise or the wrong colours rather than a picture.

What that mode is **not** showing is a room. Those are drawn by a script
choosing a palette and compositing sprites over a background, and the palette
the browser picks is a heuristic about resource numbering that it says so about.
Sprites decode at the right size and the wrong colours for exactly that reason.

**A running room has now been photographed too.** `npm run shot:sky -- <game>
--run` boots the game through `loadAdventureEngine`, steps _and renders_ every
frame, and writes out the framebuffer the browser would paint — which is what
this family had no way to do until now, and a screenshot is the evidence a
playability claim needs. It takes `--at=<s>,…` for when to shoot and
`--click=<x>,<y>@<s>` for a click, and it holds the pointer over the target for
twenty rendered frames before delivering it, because `SkyEngine.runMouse` only
notices a click on whatever the pointer is _already_ over. It prints the
hotspots it found with their coordinates, so the next click can be aimed at one.

The floor walk above was photographed with it on the freeware CD release: screen
0 before the click, Foster mid-walk, and Foster stopped at the clicked point.
The background, the palette and the composited sprites in those pictures are all
the running game's own choices rather than this tool's, which is the difference
between the two modes.

**No Decompilation is claimed for either.** Whether either encoding makes
instruction boundaries certain is answered independently for the two families
(ADR 0025). Until each answers, each ships Disassembly — a read-only listing —
and holds its bytecode as Preserved bytes.

**Sky's half of that question now has an answer, and it is not a promotion.**
A Sky instruction's length follows from its opcode alone, so boundaries are
derived rather than measured — the property SCI's encoding has and AGI's does
not. The evidence is every script in the game: 1,768 of them list to an exit
with the listing never once having to stop. That makes the listing exact; it
does not make Decompilation available, because knowing where instructions begin
is not knowing what the control flow means. Promotion needs its own ADR, and
nothing here says "decompile".

### Why two families are worth the effort for two games

**Both games have been freeware since 2003**, released by Revolution and
distributed from ScummVM's downloads page.

Every other title on this page is copyrighted data that cannot live in this
repository, which is why `docs/processes/verifying-version-support.md` says
**Completable** "is not something CI can ever assert" and why no title above
claims it. These two are the only titles here where that is not true — the only
real shipped bytes a build machine may legally fetch, and therefore the only
place this project can escape Tier 1's trap of a fixture that encodes its own
reading of the format.

**What the archives actually contain**, checked rather than assumed:

| Release               | Ships                                                            |
| --------------------- | ---------------------------------------------------------------- |
| `BASS-Floppy-1.3.zip` | `sky.dnr`, `sky.dsk` — **no executable, no `sky.cpt`**           |
| `bass-cd-1.2.zip`     | `sky.dnr`, `sky.dsk`, **`sky.cpt`** — **no executable**          |
| `lure-1.1.zip`        | `Disk1–4.vga`, `disk1–4.ega`, **`Lure.exe`** — **no `lure.dat`** |

That splits the two families, and ADR 0024's amendment has the detail. Lure's
free release carries Revolution's own executable, so it needs nothing else. The
freeware **BASS floppy** carries neither an executable nor `sky.cpt`, so it
cannot supply Compacts and is refused — the free Sky claim rests on the CD
release.

Two of them rather than one is the part that matters most: a bug in the shared
app shell gets two independent chances to show itself against real game data.
That is a stronger argument for taking Lure than the one for taking Sky.

It opens the door; it does not walk through it. Playing a game to its last
screen under a script is real work, and it is tracked as its own issue rather
than assumed here.

**Where that stands now.** The door is open and one step through it has been
taken: CI fetches both games and sweeps them on every pull request, so the
claim that these two escape Tier 1's trap is banked rather than argued. The
playthrough harness exists (`npm run play:vt`) and reports `refused` for both,
which is the whole of what is true today — no engine, so no last screen, so no
**Completable**.

The Sky half also got easier than this page expected, twice. `sky.dnr`'s
resolution to `sky.dsk` was thought to need `SKY.EXE`, and it does not: the rule
lives in the game's code and leaves enough evidence in the data to be recovered
and checked, which ADR 0024's fourth amendment records. And the Compacts were
never blocked at all for the freeware CD — ADR 0024's _first_ amendment accepts
`sky.cpt` for that Release, and this page and several source comments went on
saying otherwise for months. What still needs an original disc is the Compact
table of the **original** Releases, which is a smaller claim again.

## SLUDGE — reads and disassembles; no interpreter, so nothing runs

The seventh Engine family, and the only one on this page with **no support
claim at all**. It is here because a family with a reader and no interpreter is
invisible otherwise, which is the drift `families.ts` was written to prevent —
and `README.md` names it for the same reason.

**SLUDGE is not like the other six, and the difference decides everything about
this section.** The others are each a _publisher's_ engine, so each has a
Version axis or a Release axis and a fixed catalogue. SLUDGE is an _authoring
system's_ engine: its games are named after whatever their authors called them,
there is no Version to name, and the fourteen games below share nothing but a
runtime. So this section has no axis column, because there is no axis.

**What is built.** The container reader — the header, its four indices, and
every resource located — and the compiled-function disassembler, plus the 42
command names, generated by `npm run gen:sludge-tables` on ADR 0029's rule that
such a table is never transcribed.

**What is not.** An interpreter. So SLUDGE data stays in
[`engineSignatures.ts`](../src/engine/resource/engineSignatures.ts) and out of
`IMPLEMENTED_FAMILIES`, and a dropped SLUDGE game is refused by name rather
than run. The bar for joining the six is having an interpreter's foundation,
which five families crossed in turn, and a reader is not one.

**What it was checked against, which is unusually strong for a new family
here.** Above The Waves, a freeware SLUDGE 2.2 game — so a real shipped game
rather than a fixture, on a machine that owns nothing:

| Measurement            | Result                                                             |
| ---------------------- | ------------------------------------------------------------------ |
| Resources located      | **124**, reading to 27,759,425 bytes, none empty, none overlapping |
| Functions read         | **217**, over 10,248 instructions, none overlapping                |
| Distinct commands used | **24**, and **none unnamed**                                       |
| Where the listings end | byte 45448 — exactly where the Object block's header begins        |

That last row is the load-bearing one. A wrong header size or instruction width
would not land on it.

### The releases — fourteen games, all freeware

Their authors released them freely and ScummVM distributes them, which makes
SLUDGE one of the few families here whose reading CI could check against a real
game rather than against this project's own reading of the format.

- Above The Waves — the one every measurement above was taken from
- Cubert Badbone, P.I.
- Frasse and the Peas of Kejick
- Full Moon
- The Interview
- Lepton's Quest
- Life Flashes By
- Mandy Christmas Adventure
- Nathan's Second Chance
- Out Of Order
- Robin's Rescue
- Sam and Max Flintlocked
- The Game That Takes Place on a Cruise Ship
- The Secret of Tremendous Corporation

**Only the first has been read here.** The other thirteen are what the family
exists to reach and are listed so the gap is a number rather than an
impression; a release nobody has pointed the reader at establishes nothing.
Note also that the roadmap moved this family **off** the critical path once the
scope became the famous games — these are indie adventures, not the catalogue
that scope names — so the reader stands and nothing further is owed it. See
[`scummvm-parity-roadmap.md`](scummvm-parity-roadmap.md).

## Revolution Software — the two Broken Swords, Sword1 and Sword2

Revolution's third and fourth engines here, and the **seventh and eighth
families** overall (ADR 0036). The publisher is the same one behind Sky and
Lure and the engines are not: Broken Sword is a clean break from Virtual
Theatre, and Broken Sword II is a second clean break from Broken Sword.

### Why these are two families and not one game with two Releases

`CONTEXT.md` says two families "share no bytecode, no resource layout and no
renderer". The two Broken Swords fail all three tests, and it is worth being
specific because the titles invite the opposite assumption:

|                    | Sword1                                                     | Sword2                                                                           |
| ------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Bytecode           | 32-bit words throughout; operands are words                | Byte opcodes with 8-, 16- and 32-bit operands                                    |
| Machine-code calls | 100 mcodes, argument count in the instruction              | 118 opcodes, parameter count in the instruction                                  |
| Index              | `swordres.rif`, one nested cluster/group/resource tree     | `resource.inf` + `resource.tab`, flat, with each cluster's index in its own tail |
| Object             | One 3,085-word compact, fixed layout                       | A header, a hub, a variable block and eight typed structures                     |
| Room               | A table in the interpreter naming separate layer resources | One `SCREEN_FILE` resource holding nine things                                   |
| Cycle              | Walk 150 sections, skip the dead ones                      | Walk a `RUN_LIST` of the objects that are alive                                  |
| Sprites            | RLE7, RLE0, "Tony", HIF                                    | RLE256, RLE16                                                                    |
| Display            | 640x400 of script space inside a 640x480 display           | 640x480, no inset                                                                |

The one thing they do share is the **audio**: both keep samples as RIFF/WAVE and
both compress speech with the same 16-bit RLE, so `swordAudio.ts` is shared
between them — at the level of a pure codec, never at the level of an engine.
(Codec since this run: it reads the RLE and now writes it.)

### Editing goes back out again

Both families have an **exporter**, so an edit becomes a modified install rather
than only a project document. The principle is the one `CONTEXT.md` states for
every Resource layout here — "copy what was not touched, substitute what was,
rebuild the index" — and it is checked: an export with no edits in it is
**byte-identical** to the install it came from, which is what makes a diff of an
exported game the author's changes and nothing else.

The two rebuilds are not the same rebuild, which is one more place the families
differ. Sword1 rewrites `swordres.rif`, because that file holds every resource's
offset and length. Sword2 leaves `resource.tab` alone — it holds neither, only
which cluster and which index a resource is at, and an edit changes neither — and
rebuilds each cluster's own tail index instead. Sword2 also recomputes the byte
sum beside every script block, because its interpreter checks it.

Both refuse rather than write a misreading: a script module or object that did
not round-trip on import is named and the export stops. Both need the original
clusters, which a project does not carry (ADR 0010: an install is hundreds of
megabytes), so the editor asks for the game folder again.

### Neither game is freeware, so both rest on a fixture

`docs/processes/verifying-version-support.md` sets the bar and
`docs/scummvm-parity-roadmap.md` predicted this outcome for every famous engine
that is not Sky or Lure: CI can only meet a real game where the game is lawfully
fetchable, and neither Broken Sword is. So both families are **Tier 1** — a
synthetic fixture built from the format (`tests/fixtureSword.ts`) — with
`npm run sweep:sword -- /path/to/game` as the Tier 2 route for somebody who owns
the data. That command reads every resource, decompiles every script, checks
every round trip and prints the counts.

The fixture's own trap is stated in its header and worth repeating: a fixture
encodes our reading of the format, so a wrong reading makes the fixture and the
engine agree with each other and disagree with the game. Where the builders
could choose, they chose what the shipped games do — a cluster with holes in its
presence tables, a text resource with a zero offset, an object whose checksum is
computed rather than stubbed — because those are exactly the cases a reader
written against a tidy fixture gets wrong.

### Sword1 — Broken Sword: The Shadow of the Templars (1996) — runs, draws, edits, and its demo plays through

[`games/broken-sword-the-shadow-of-the-templars/`](../games/broken-sword-the-shadow-of-the-templars/README.md)

**What runs.** The cluster index is read, the objects are opened, the logic
engine walks all 150 sections each cycle and runs their bytecode, the router
finds walks through the walk grids, animations step, the renderer draws
backgrounds, mask layers, parallax and scaled sprites, subtitles are rendered
from the game's own font, effects, music and recorded speech play, both menu
bars work, and saves are written and restored.

Measured rather than asserted: `npm run probe -- /path/to/game` reaches an
interactive state on the demo on screen 1 with 12 pointer targets and a router
holding 47 bars and 36 nodes; a hover-then-click on the floor walks George 110
pixels; and the frame it photographs is 82% non-black in 212 colours — the
bombed Cafe de la Chandelle Verte, with George standing in it.

**Escape now gets out of the opening, and it used to take 2,365 frames to
reach that state.** That is about 197 seconds of a program that looks hung.
Measuring where the frames went rather than guessing found no defect at all:
1,909 of them were `intro.smk` playing out at 12 frames a second, which is the
engine doing its job. The gap was the keypress — the engine honoured Escape
already and nothing in this project had ever pressed it, so the probe sat
through the whole film. Frames to interactive: **2,365 before, 454 after, one
Escape press**; 197.1s to 37.8s. The frame is a sample and not a constant —
382, 408 and 454 across runs, because the engine's `random` is `Math.random`
and the clusters arrive asynchronously. This page used to give 2,432 as though
it were fixed, and with it "the opening narration legible across two centred
lines": what the photograph catches is when it was taken and not what the
engine can draw.

The draw buffer is re-laid from layer 0 every frame, as `Screen::draw` does;
laying it once per room instead left every sprite ever drawn on the screen and
buried both the picture and the subtitles under them.

It plays its **cutscenes**, too. `fnPlaySequence` names a Smacker under
`smackshi/` or `video/`, and the reader AGOS already had reads them: the film
takes the screen, the logic stops while it runs, Escape skips it, and the room's
palette is restored afterwards. A sequence this install does not ship is counted
by name and the scripts carry on.

**Both walk animators** are implemented. Revolution's router has two: _slidy_,
which slides to the exact target, and _solid_, which takes whole steps and stops
where the last one lands. A walk with a specified end direction uses slidy; a
plain click about the room uses solid, and falls back to slidy when the route it
actually walked turns out to cross a bar — which is the original's own
arrangement. Solid is what gives George his three-frame slow-in and his
slow-out.

**What is editable.** Eight surfaces, in order of how strong the claim is:
scripts (decompiled to instructions that re-emit byte-identically), compacts
(Preserved words with the fields the bytecode addresses by offset), text (every
language the release ships), palettes, pictures, sound — and the two that live
in the interpreter rather than in any cluster, the **room table** and the
**start positions**.

Those last two were recorded as editable and **not writable back** for years,
on the reasoning that the room table "lived in Revolution's interpreter rather
than in the game's files, so there is nowhere to write it". Half of that was
true and the other half was never tested: the interpreter is _in the install_.
`SWORD.EXE` sits beside the clusters, with `WINSWORD.EXE` and `RUNSWORD.EXE`
next to it. Both tables are in it, and both are now written back.

The numbers, from `src/authoring/sword1/executable.ts` against the DOS demo:

| file                           | room table                                                                  | start positions             |
| ------------------------------ | --------------------------------------------------------------------------- | --------------------------- |
| `SWORD.EXE` (609,363 bytes)    | at `0x84578`, 100 screens, **94 of 100** word-for-word the built-in table's | **52**, writing to `0x7f24` |
| `WINSWORD.EXE` (213,504 bytes) | at `0x24ed4`, 100 screens, 94 of 100                                        | 45, writing to `0x4288d4`   |
| `RUNSWORD.EXE` (150,528 bytes) | none                                                                        | none                        |

The room table is _data_ and is found by voting: every 60-byte window that
decodes as a plausible `RoomDef` votes for the base a table containing it would
start at, and the base with the most votes wins. A start position is not a
table at all — it is _code_, four `mov dword ptr [abs], imm32` instructions
(ten bytes each) writing x, y, direction and place into one object's fields —
so it is found by the shape of those four writes and a row is addressed by its
ordinal among the runs.

Six screens differ between `SWORD.EXE` and the built-in table, and that is the
demo numbering its clusters' resources differently rather than a bad read
(screens 18, 20, 35, 39, 87, 88). So a project opened from a real install reads
the **install's own** table and not the built-in one; otherwise an export that
changed nothing would rewrite six screens. `RUNSWORD.EXE` holds neither table
and is carried through an export byte for byte, because a file the export was
handed is a file the export is responsible for putting back.

An edit goes back into the file it was read out of and nowhere else: the two
builds place different numbers of characters (52 against 45), so placement 3 is
a different place in each and writing one into the other would move a character
the edit never named. `npm run reexport:sword` proves both halves against the
real install — **identical 11 of 11 files** with nothing edited, and with one
start position moved, `SWORD.EXE: 609363 -> 609363 bytes, 2 bytes differ at
0x4ba10..0x4ba11; the edit names: start position 0's x at 0x4ba10 481 -> 545`,
with `WINSWORD.EXE` and `RUNSWORD.EXE` at 0 bytes differing. The moved position
reads back out of the _installed_ executable through the engine's own import as
x 545.

The sidebar folds into named sections, as SCUMM's does and for SCUMM's reason:
a retail install is 150 screens and 1,500 compacts, and a column that draws
them all at once and cannot be closed buries the section you want. An
**Actors** section is derived from `o_type` — `MEGA` and `PLAYER` are the two
the interpreter walks and scales — with George first and his screen, position,
facing and both his sprite words on the pane. Every picture a player sees is
exportable and importable from where it is used: the background from the
screen, an object's `o_resource` art from the object, and a character's own
sprite from the character. That last one is newly true, and this page had it
wrong: a character is drawn from `o_walk_resource`, not `o_resource`.
`Logic::fnStand` and `Logic::logicArAnimate` both open by assigning
`o_resource = o_walk_resource`, so `o_resource` is run-time state and is 0 on
all five of the demo's megas in a project nothing has run — the section showed
no picture for any character, George included. George's `o_walk_resource` is
`0x4060000`: 346 frames at 83×151. Two of the demo's five megas are drawable
that way, and that is a fact about the **demo**: the other three point at
`0x8010000`, `0x8020000` and `0xc010000`, and the demo's own `swordres.rif`
gives each a real slot — paris3 at 2549910 for 230339 bytes, paris3 at 2989932
for 275420, syria at 2056440 for 337427 — because that index declares all
fourteen clusters of a two-disc game whichever disc it was read from. The
folder ships six. A retail install has PARIS3.CLU and SYRIA.CLU and draws all
five. Each of those three panes names the cluster and says which kind of
absence it is: a cluster the index names and this install does not ship, or a
resource in a cluster this install does have that the importer's picture budget
passed over. `o_mega_resource` is still named and not
drawn, for a corrected reason: `Router::setupWalkData` reads frame counts and
an x/y step per direction out of it and there is no resource id in it at all,
so it is walk geometry rather than a table of animation resources.

`RoomCanvas` was neither widened nor forked for this, because `sceneCanvas.ts`
is already the seam both this family and SCUMM's room view draw through.

Pictures are no longer Preserved bytes, and no longer stop at the editor's
edge. `swordEncode.ts` writes RLE7, RLE0 and Tony, `npm run sweep:sword`
reports all 7,113 of the demo's sprite frames and both its parallax layers
re-encoding to the bytes the game shipped, and the exporter now substitutes
them: a background goes in whole because it _is_ its pixels and carries no
header, a parallax layer goes in whole because its own twenty-byte header
overlaps the generic one exactly, and a sprite goes in behind its resource
header with `comp_length` and `decomp_length` recomputed, because a re-encoded
frame may change size. `npm run reexport:sword`, which now makes a picture edit
beside its script edit, reads the painted pixel back out of the rebuilt cluster:
`edit picture 100728834 (784x400 background) pixel 156800: 149 -> 1 (wanted 1)`.

One limit was named rather than closed and is now closed with a smaller claim
than the others carry: **HIF**, the PlayStation conversion's LZ77 scheme, which
no PC release uses. It has an encoder now — matches of 3 to 18 bytes over a
4,096-byte window, written against `decompressHIF` rather than against
Revolution's encoder — and it is the one encoder here not held to byte
identity, because there is no shipped PC stream to be identical to. It is held
to pixels instead: `npm run sweep:sword` encodes all 7,113 of the demo's
decoded frames as HIF and decodes them again, and **7,113 of 7,113 give back
the pixels that went in** (53,238,548 pixels in 11,519,148 bytes). That no PSX
install is reachable here to read them is said in `docs/editor-parity.md` §10b
rather than left for a reader to assume otherwise. A **mask layer** was the second one and is not any more: a mask is a bag
of 16x8 blocks whose placing grid lives in another resource, so the importer
now carries the grid with the mask — 140.7 KB for the demo's fifteen grids,
against a 24 MB picture budget that ends at 18.59 MB with them in — and the
editor composes the blocks into the room-sized picture the grid describes,
takes an imported one apart the same way, and refuses by name when two cells
share one block and the pixels given for them differ. All fifteen of the demo's
masks compose and decompose back to the bytes Revolution shipped. **Sound is editable and written back**, which it was not
before. The speech RLE has an **encoder**, and `npm run sweep:sword` re-encodes
every line of a real install and counts — **799 of the demo's 808 lines come
back as the bytes Revolution shipped**, and the nine that do not are ties that
decode to the same samples. No rule reproduces all 808, because the container
itself does not: a lone sample at the end of a stream costs two words either
way, and `COWS.MAD` writes 64 of them as a literal of one and three as a repeat
of one. The other end of the trip is now built too, and it is three different
ends: speech lives in `SPEECH/COWS.MAD` or `SPEECH*.CLU` and the container is
**rebuilt** around a replaced line, index patched and every other payload copied
byte for byte; a tune is a `.WAV` beside the install addressed by name, so it is
written as a file; an effect is an ordinary cluster resource and is substituted
whole. `npm run reexport:sword` replaces one of each and reads all three back
out of the **installed** folder — speech screen 0 line 1, 104,534 → 22,098
bytes, 11,027 samples with a worst difference of 0 and the other 807 lines
untouched; tune 1, 846,792 → 11,070 bytes; effect 2 (`0x06000012` in
`PARIS1.CLU`), 31,144 → 5,556 bytes. One layout is refused rather than guessed
at: two lines sharing a byte offset with two different lengths cannot both keep
their length in a rebuilt container, so it is named and refused. The demo has no
such pair — 808 entries at 808 distinct offsets, no gaps, no tail.

**What exports.** A whole install: `npm run reexport:sword -- <folder>` rebuilds
`swordres.rif` and every cluster it indexes, and against the demo all **eight**
files come back **byte-identical** — 1,000 resources rewritten, 484 copied, the
43.9 MB speech container included. A
cluster the index declares and the folder does not hold is carried through
unchanged rather than refused, which is what a two-disc game needs; an _edit_
that lands in one is refused by name. After a script edit the export boots
through `openGame` to the room the original boots to, and the editor's Play
button runs that same export with the rebuilt clusters overlaid on the
re-supplied folder.

**What the editor does not do**, next to SCUMM's, is a table rather than a
paragraph: [`docs/editor-parity.md`](editor-parity.md) walks the SCUMM surface,
this one and Sword2's row by row — thirty-two of them — and names and explains
every No. Sword1's one remaining No is adding or deleting records, which is the
one the data forces; the page says why.
Walk-grid editing was a third until this branch — the demo's nine grids are
carried, drawn over the screen, edited by pointer or keyboard and written back,
with 9 of 9 re-encoding byte-identically in `npm run sweep:sword` (Sword2: 4 of 4) — and a **brush** was the fourth: both surfaces paint one pixel at a time
now, by pointer or by key, through the encoder Import already uses. It reaches
7,143 of 7,143 Sword1 frames across 468 pictures, and 10,895 of 10,895 Sword2
animation frames plus 12 of 12 screen layers.

**Animation preview** was the fifth, and it is now a count rather than a claim.
A sprite resource carries frames and no timing, so the rate and the order both
come from the script: `fnAnim(cdt, spr)` names a `cdt` table whose frame column
is the order, and `SwordLogic`'s driver walks it one entry a game cycle —
`SWORD1_TICKS_PER_STEP` sixtieths of a second, twelve frames a second, read out
of the engine rather than chosen. **145 of the demo's 438 sprites** have a
player this can name, and the rest say so where the button would be instead of
looping at an invented speed. §18a of the parity page has the arithmetic.

**Completable — the demo Release, and that Release only.** This is the first
`Completable` claim on this page, and the Release it is made for matters more
than the word: the **demo**, not the retail game. `CONTEXT.md` sets the bar as
"it can be played from its first screen to its last, saving and resuming along
the way", and `npm run play:sword -- <sword1>` does exactly that and reports
every step:

```
Steps: 19, of which 0 did not do what the route says.
Screens, in order: 1 → 3 → 1 → 4 → 1 → 2 → 6 → 7
Final state: /home/agent/reports/sword1-ending.png
The demo reached its ending.
```

The route is the demo's own: watch the intro, walk into the café, talk the
conversation out, take the newspaper the barman leaves, go back out, show the
workman the paper, open his toolbox while he reads it — **save there**, walk
away from the save so a restore has something to undo, **restore**, and finish
from the restored state: back down the street, the towel on the drainpipe, down
into the alley, open the manhole, and into the chamber the demo ends in, where
`ENDDEMO.SMK` plays and the scripts ask to quit. The save is 40,393 bytes of
world at screen 4, 353,408 carrying items 18 and 27, and the restore comes back
to the same place with the same rucksack.

**The retail game is not claimed and cannot be**, for a reason this page can
state precisely rather than hedge: the data is not here. The demo ships six of
the fourteen clusters `swordres.rif` names, and George's journey after the
sewer is in the eight it does not. The same absence is why three of the demo's
five megas have no art to draw — `0x8010000`, `0x8020000` and `0xc010000` live
in PARIS3 and SYRIA, which this folder does not ship. A retail install would
draw all five; nobody here has one, and **that is a fact about the folder, not
a gap in the engine**, so it is written down rather than worked around.

### Sword2 — Broken Sword II: The Smoking Mirror (1997) — runs, draws, edits, and its demo plays through

[`games/broken-sword-ii-the-smoking-mirror/`](../games/broken-sword-ii-the-smoking-mirror/README.md)

**What runs.** The three index files are read, the globals come out of the
game's own `GLOBAL_VAR_FILE` (so nothing is reconstructed), sessions are walked
as run lists, the bytecode runs with all three script levels, animations step,
the renderer draws backgrounds, mask layers, four parallax depths and scaled
sprites, recorded speech plays, the line being spoken is drawn from the game's
own font, characters hold a conversation with each other, the player picks an
answer off the chooser bar, and saves are written and restored.

**Spoken lines are on screen now, and this page said they were not.**
`Sword2Text` is this family's own font reader and its own text sprite — a
separate one from Sword1's `SwordText`, which is what ADR 0036 asks for — so
`fnISpeak` draws the line it is handed instead of logging it. Both ends of a
conversation run: `fnSpeechProcess` takes delivery of a command posted through
the seven speech globals and hands it back to the opcode that performs it, and
the six opcodes around it — `fnStartConversation`, `fnEndConversation`,
`fnWeWait`, `fnTheyDoWeWait`, `fnTheyDo` and `fnAddSequenceText` — carry a line
from the character who says it to the character who answers. The probe reports
`text: font 341, 4 lines built, 1 on screen` and photographs Sacco's reply —
"I don't know. The dog went berserk for no apparent reason." — wrapped over two
centred lines above him.

**A conversation can have a choice in it now, and this page said it could
not.** `fnAddSubject` (12), `fnChoose` (14), `fnAddMenuObject` (23) and
`fnRemoveChooser` (112) were names in a table and nothing else; `Sword2Menu` is
the module behind them, holding both bars — the chooser along the bottom and the
inventory along the top — and `Sword2Screen` draws them over the picture after
the text, as `processMenu` runs after `buildDisplay`. Greying an icon is a
different _image_ rather than a palette trick: an `ICON_FILE` is two 35x30
pictures, greyed then coloured. `fnChoose` packs the player's answer into its
return value — `IR_CONT | (response << 3)`, the one place `CP_JUMP_ON_RETURNED`
is used — and a click on the chooser is no longer also a click on the floor
behind it, because the engine now honours "if the mouse is not visible, do
nothing" the way `mouseEngine` does.

The measurement is a disassembly, not a playthrough. Across the demo's 905 game
objects the scripts call `fnAddSubject` 567 times, `fnChoose` 57,
`fnAddMenuObject` 66 and `fnRemoveChooser` 9 — object 349 "Speech script" adds
subjects at bytes 332, 360 and 388 of script 0 and chooses at 729 — and **no
playthrough of this demo reaches one**: the only named thing the probe can click
ends in a session change and a cutscene. That is why the tests drive the four
opcodes directly.

**The inventory opens now, and this page used to say it could not.** The bar's
_contents_ were always built, from `menu_master`'s own script through
`fnAddMenuObject`, but nothing could put the pointer into menu mode, so pushing
it to the bottom of the screen did nothing. `Sword2Pointer` is `Mouse::mouseEngine`:
`MOUSE_normal`, `MOUSE_menu` and `MOUSE_drag`, run every cycle the human is
available rather than only on a cycle with a click, because two of the three are
entered by the pointer _moving_. An icon can be picked up, examined through
`menu_master`, combined with a second or put down again, and `fnSetObjectHeld`
— opcode 93, which had no implementation — locks the mode while a script holds
something for the player. Measured on the demo: the bar opens with eight
objects, and `/home/agent/reports/` has the picture.

**The system menu and the luggage icon, which this page said did not work.**
Both do now. `MOUSE_system_menu` is the fourth mode: the panel opens by pushing
the pointer to the top of the screen, and its save and restore icons reach the
shell's own save menu — the other three stay greyed, which is the game's own way
of saying "not that one". The dragged object is drawn as well: a `MOUSE_FILE` is
neither of the two compressions the rest of this game's graphics use, so it has
a decoder of its own, and the frame is stamped onto the display by its hotspot
rather than composed into a cursor sprite, because the pointer here is the
browser's own. Measured on the demo: pocket 0 picks up icon 60, whose luggage
149 decodes to 35x30 and is drawn at the pointer, and it is still drawn after
the pointer carries it up into the room. And
`fnAddSequenceText` records the subtitle lines for a
Smacker film that nothing then draws over one. The guard that makes
it harmless on this install belongs to the engine rather than to this project —
ScummVM's `fnAddSequenceText` carries the same `if (!readVar(DEMO))` — so the
eight calls the demo's scripts reach are a legitimate no-op rather than a gap,
which is why the engine no longer lists the opcode as unimplemented.

**There is a character on screen now, and this page did not know there was
not.** `fnSetValue` gives the player mega its megaset resource and wrote eight
bytes short of the field: `ObjectMega::setMegasetRes` is `_addr + 48` and the
write landed on `cur_dir` at 40, so the start script set George's direction to
a resource id and left his megaset at zero. Everything below behaved correctly
on the zero — `fnStandAt` copied it into `anim_resource` as `Router::standAt`
does, and `Sword2Screen.frame()` returned null on `if (!animResource)` as it
should — so the game ran, walked, scrolled and answered clicks with nobody in
it. No measurement this project takes caught it, because a probe reads
positions and pixel counts and a missing character has a position. The proof is
a photograph: `/home/agent/reports/sword2-player-visible.png` and
`sword2-player-after-walk.png`.

**It walks, and the room scrolls under it.** `npm run probe` reaches an
interactive state on session 11 — at frame 84, 114 and 131 across runs, the
number moving with the same asynchronous loading and `Math.random` that moves
Sword1's — a hover-then-click on the floor walks the player 750,500 ->
479,311, and a click on a named object (593) walks
them to it and changes the screen. That is a correction to what this page said
before, which was that a floor click left the player where they were and the
router refused the point: the router was right and three engine defects were
between the click and it. The mouse list sorted by priority _descending_, so
the full-screen floor sorted first and took every click (0 is the highest
priority in this family, not the lowest); `fnInitFloorMouse` sized the floor
from whatever the room was when it ran, which under asynchronous cluster
loading is the 640x480 fallback and not the 960x597 room, leaving the player's
own start position outside their floor; and nothing chased the camera, so a
room wider than the display never scrolled and a third of it could not be
reached. Those are fixed and measured.

**It walks.** `Sword2Router` is this family's own pathfinder over its own
walk-grid format, and the differences from Sword1's are real ones: the grid is a
_list_ of resources scripts add and remove with `fnAddWalkGrid`, so a room can
gain and lose walkable area while the player stands in it; and the frame layout
— stand frames, standing turns, walking turns, slow-in, slow-out — is derived
from the mega's own walk data rather than hardcoded. Sword1's router has
George's frame numbers written into it; this one names no character at all.

**Cutscenes** play through the same Smacker reader. Sword2 carries its film
names as pushed strings rather than as numbers, so this family needs no sequence
table. The demo ships **two** films and its scripts ask for three: the opening
title card plays, and `eye` and `intro` are retail films this release does not
ship, reported absent by name.

This paragraph said the demo "ships one film" and that all three of `eye`,
`demo` and `intro` were absent, which was true of the folder's names and not of
its bytes. The demo's opening is on disc as **`demo.smdk`** — the same 289,700
bytes the folder's own `files.txt` lists as `demo.smk`, at the same 21/08/1997
09:31 — and the lookup was refusing it on the extension. It now offers the odd
name _after_ the right one and lets `openSequence` decide from the Smacker
signature, so the film that plays is the one whose first four bytes say so.

**What is editable.** Screens, an **Actors** section, objects (Preserved bytes
with the structure boundaries named), their scripts (decompiled, re-emitting
byte-identically), the globals, text (each line with the wav id `fnISpeak`
plays it by), palettes, animations, sound and **run lists** — that last surface has no SCUMM analogue and is the most direct
edit this family has: a session _is_ a run list, so adding an object to one puts
it in the room.

Sound is the one of those that stops at playing. Sword 1's export now rebuilds
its speech container, writes a replaced tune as a file and substitutes a
replaced effect's resource; Sword II's cannot, and the reason is this demo
rather than the family. `resource.inf` names fourteen clusters and **not one of
them is a speech or music cluster** — the engine says so on every boot, and the
probe's own last line is `sound: music 69 is not plain WAVE, so it is not
played`. There is no container here to rebuild and nothing to check a rebuild
against, so the Audio section lists what the scripts ask for, plays what the
folder holds, and an export carries none of it. A retail copy ships those
clusters and the work is the same shape as Sword 1's; it has not been written
against a container nobody here can open.

Screens and animations are no longer Preserved bytes either, and no longer
editable-and-not-writable: `sword2Encode.ts` writes all three of the family's
schemes, the sweep reports 14,085 of the demo's 14,088 frames and 17 of 17
parallax layers coming back byte-identical (the three exceptions are ties the
format allows and decode identically), and the exporter now rewrites each
edited screen and animation in place, offsets and CDT entries included. A
palette goes out with them rather than on its own, because it is not a resource:
it is the 1,024-byte block a screen's multi-screen header points at. Run lists
are written back into the payload they already have, and one too long for its
resource is refused by name — there is no index entry to grow. `npm run
reexport:sword` reads the repainted pixel back: `edit screen 22 (960x597
background) pixel 958: 103 -> 1 (wanted 1)`.

The limit left on those two is the **picture budget's** rather than the
format's: a screen or an animation too big for the project on import is named in
`editable.reasons` and copied through untouched.

The sidebar folds into named sections, as Sword1's and SCUMM's do. The
**Actors** section is the one place the two Sword families visibly differ in
how the same question is answered, which is ADR 0036 showing through: Sword1
reads `o_type`, and Sword II has no type word an editor can reach, so the
evidence is the code — the sixteen opcodes that take a pointer to an
`ObjectMega` and can be pointed at nothing else. Art on an object is read the
same way, from `// params:` arguments the table calls a resource id and that
are pushed as literals; a resource chosen from a variable at run time is not
followed, and the pane says so rather than drawing another character's walk
cycle. A mega whose megaset is set for it by another object's script is that
case, and its page names the opcodes and offers no frame — a refusal on the
surface, next to where the button would be, rather than a footnote here.

George was named here as that case, and he is not. A character's megaset is the
one resource those `// params:` blocks hide: Revolution's comment on
`fnSetValue`'s second parameter reads "value to set it to", but `fnSetValue`
writes exactly one field — `ObjectMega::megaset_res` — and `Router::standAt`
copies it straight into the graphic's `anim_resource`, so the number it writes
is what the renderer draws. Measured on the demo: all 52 `fnSetValue` calls
push a literal and every value names a held animation. Following it takes the
cast with art from 135 objects to 163 and gives George his four — `GeoMega`,
`GeoMegaB`, `NicMegaB` and `NicMegaC`, 1,730 frames that the project held and
his own page said did not exist.

**What exports.** `npm run reexport:sword -- <folder>` rebuilds each cluster and
its tail index, and against the demo all five present clusters come back
**byte-identical** — 1,619 resources rewritten, 216 copied, and the nine
clusters `resource.inf` declares and the demo does not ship reported by name
rather than refused. A cluster is matched by its line in `resource.inf` and not
by where its file sits, because `resource.tab` addresses it by that line number.
After a script edit the export boots through `openGame` to the room the original
boots to, and Play runs that same export rather than a second code path.

**Completable — the demo Release, and that Release only.** The same bar and the
same command, `npm run play:sword -- <sword2>`:

```
Steps: 33, of which 0 did not do what the route says.
Screens, in order: 11 → 12 → 14 → 12 → 14 → 13 → 14 → 12 → 14 → 12 → 11
Final state: /home/agent/reports/sword2-ending.png
The demo reached its ending.
```

The demo's own puzzle chain, played through: over the fence off the quay, ask
at the window, up the steps, the hook off the wall, the hook on the bottle, the
bottle up the chimney for the cloth, the trapdoor into the cellar, the dog
biscuits, the biscuits on the platform, the hook to haul the platform out of
the dog's reach — and when the yard is clear, **save** (37,136 bytes of world
at run list 14, 218,313), walk 192 pixels away, **restore**, check the rucksack
survived it (eleven objects), and finish from there: down to the alley and over
the fence the dog was guarding, which starts `Enddemo.smk` and ends on
`fnPlayCredits`. `fnPlayCredits` is where this demo stops; there is no screen
after it.

**The retail game is not claimed**, for the same kind of reason and a
different one: nine of the fourteen clusters are absent from this folder, and
the demo's `resource.inf` names no speech or music cluster at all, which no
retail index omits. See §27a — the write path for Sword II's speech and music
containers is **written and unverified**, because there is no container in this
folder to verify it against; `npm run reexport:sword` still prints
`containers 0`.

## Caveats

- Version numbers are ScummVM's classification, not official LucasArts labels — LucasArts itself only ever talked about "SCUMM" generically.
- Re-releases can sit in a different version bucket than the original (Loom EGA is v3, Loom CD is v4; Monkey Island 1 floppy is v4, CD is v5).
- The special editions of Monkey Island 1 & 2 (2009/2010) run the original v4/v5 SCUMM data under a new renderer, so they're arguably still on this list.
- A handful of licensed/educational Humongous SKUs (Backyard Sports variants, Blue's Clues, Big Thinkers editions) are omitted; including every regional and platform variant would roughly double the HE section.
- The Sierra list is no longer here for comparison only: AGI is implemented, and SCI reads, identifies, draws and edits — see the note above the Sierra section for what is and is not claimed.
- "Virtual Theatre" is Revolution's own name for the engine and covers both their adventures, so it is not used as a family name here: "Sky" and "Lure" are ScummVM's names for the two interpreters, and each denotes exactly one (ADR 0026).
- Sierra's AGI/SCI sub-version boundaries are ScummVM's classification, same as the SCUMM ones, and a few titles sit awkwardly between buckets — King's Quest IV shipped as both AGI v3 and SCI0, and the SCI1 vs SCI1.1 split in particular is finer than this list shows. Treat the groupings as approximate.

## What "AGI support" does and does not claim

The same discipline `docs/processes/verifying-version-support.md` applies to
SCUMM versions, applied here.

**What is implemented.** The v2 and v3 resource layers, including v3's combined
index and its LZW volumes; the Picture renderer with both buffers and the
priority bands; View cels with mirroring and priority clipping; the Logic
interpreter with all 183 action commands and 20 test commands; the cycle,
motion and animation; `WORDS.TOK`, the parser and `said`; the `OBJECT` file and
inventory; four-voice sound; saves; and the editor's Logic, Picture and View
surfaces with a byte-identical round trip.

**What is verified, and how.** Everything above is tested against a synthetic
fixture built in `tests/fixtureAgi.ts`, including a full import → edit → export →
load → boot round trip. Every format layout in that fixture is transcribed from
the AGI Specification and from ScummVM's own readers rather than from what our
code expects — because the trap
`docs/processes/verifying-version-support.md` names is a fixture that "encodes
our reading of the format", and AGI walks into it harder than SCUMM does.

**What is not verified.** No AGI game has been played through here. The
renderer's correctness is judged by eye and its sound by ear — and **the eye
half has now been done against a real game**: three King's Quest III rooms drawn
with `npm run shot:agi` and looked at, each recognisable and correctly coloured
(above). The **sound** half has not: nothing has listened to a real AGI game,
only to the fixture. `npm run fetch:agi` exists to make more of this possible
locally, and CI stays on the fixture because no game data is ever committed. So
an AGI game is worth trying rather than relied upon, and **Completable**
(`CONTEXT.md`) is not claimed for any title.

**What the Unrecovered count means.** ADR 0013 makes it a published number with
a target of zero, and it is meaningless without saying how the interpreter
version was established: a game decoded with the wrong arity table scores zero
while its tree is nonsense. The count is zero over every Logic in the fixture,
whose interpreter version is known by construction. Over a real game it is
reported beside the evidence for the version, and a game whose version could
only be guessed **plays** on that guess and is **refused for editing**.

## Adventure Soft — Simon the Sorcerer plays its opening; AGOS reads and edits the rest

AGOS — Adventure Soft's engine, carried from Horrorsoft's Elvira through to The
Feeble Files — is a sixth Engine family, decided in ADRs 0027–0030. **No AGOS
game is `Completable`**, and nothing below is such a claim — including Simon the
Sorcerer, which now draws its opening, says its own lines and answers a click,
and which nobody has played through.

**What is built.** The packaging readers and `GAMEPC` end to end — the item
tree, the pooled strings and every Subroutine — plus the resource archive's
offset table. The Version probe, which settles what file names can and finishes
structurally where four Versions share a bare `gamepc`. The argument and opcode
name tables for all seven Versions, generated from ScummVM rather than
transcribed. A disassembler that names opcodes, `npm run sweep:agos` to check
**Structural agreement** over a whole game, byte-identical re-emission, an
editing gate that refuses unless all three of ADR 0029's conditions hold, an
interpreter that runs the opcodes common to every Version and **reports the rest
by name**, saves, and the editor Project. AGOS data routes to the engine rather
than to the foreign-engine table.

**Subroutines are editable rather than a listing.** Operand values can be
retyped, and instructions can be added and removed. The second of those was
held back for a reason that turned out to be false: it was thought to need jump
renumbering, since moving an instruction would strand every jump target after
it. That is true of the **VGA** bytecode, which measures `JUMP_REL` and
`END_REPEAT` in bytes. It is not true of the **game** bytecode, which refers to
nothing by offset — a line runs until one of its conditions fails, and
`o_goto`, the one opcode that reads like a jump, moves the _player_ rather than
the program counter. So nothing needed renumbering and the gate was imaginary.

An operand edit preserves its operand's kind and refuses a value too wide for
the field it arrived in, which keeps it a pure substitution; an inserted
instruction gets blank operands of the shapes its opcode takes, from the same
generated table the reader dispatches on. An opcode the Version has no entry
for is refused before anything is written, because one with no length decodes
as whatever follows it — the cost of that mistake is a whole unreadable line
rather than one wrong instruction.

**Art is now read, drawn and painted — and cannot yet be saved.** A zone's
images are listed in the Project, opened onto a canvas, and painted a pixel at
a time, with each edit recorded as **intent** rather than as bytes: ADR 0030 has
an AGOS Project hold what the author meant and ask for the game folder again at
export, because a zone resource is far past the size at which keeping originals
is reliable. `applyPaintedImages` replays that intent onto the re-supplied
bytes.

**A retail Simon 1 is editable, and used to be refused.** The 7,909 bytes that
release appends after its Subroutine block are a development build's symbol
table — `AddSPTRs`, `StripTPTRs`, a `;END 0 0.` marker — and the shipped
interpreter never reads a byte of them either. ADR 0035 makes them
`CONTEXT.md`'s **Preserved bytes**: carried out of the file and back into it
unchanged, so byte-identity holds over the whole file and the count is
`Unrecovered: 0`. Before that decision the project called a game whose entire
runtime database had decoded correctly a re-emission failure, and showed its
owner a list of _Sierra_ interpreter builds to choose from — ADR 0013's route,
which is AGI's, and which ADR 0029 records that AGOS deliberately does not
have. The route is now a capability on the seam rather than a family check in
the shell, which is what ADR 0011 asks for.

**Nothing calls it, because AGOS export writes only `GAMEPC`.** ADR 0030
requires the two artefacts together — the rebuilt base file _and_ the rebuilt
archive — "one operation that either produces both or produces neither", and
the archive half does not exist. So a painted image survives in a saved project
and does not yet reach a game folder, and a partial archive writer would be a
wrong artefact rather than a missing one. That writer is the remaining work on
this half, and it is a subsystem rather than a wiring job: an offset table
rebuilt per packaging layout, loose `.VGA` files for the old bundle and a
packed `.gme` for the rest.

The canvas is also greyscale, and deliberately: an AGOS image's colours come
from a bank a _script_ chooses at draw time, so an image on its own has no one
right palette and inventing one would show colours the game never uses.

The VGA script machine, which is what places a game's sprites — a game
Subroutine's whole contribution to the screen is to start one of its scripts.
Text, drawn in the direction the loaded release declares, read out of its own
words rather than out of a Target (ADR 0028). And The Feeble Files' and the
Puzzle Pack's video: the Smacker container, its four Huffman trees, its four
block kinds, its palette and its audio, played **at** the screen by the Engine
the way SMUSH is rather than composited by the VGA script.

**Two of those carry a condition worth stating rather than discovering.** AGOS
keeps its **font in the interpreter executable**, so a folder of game data alone
draws no words at all — the font is read out of an interpreter beside the game
where there is one, and where there is not the status line says so rather than
drawing boxes (ADR 0032). And the video read is **Smacker**, which is what the
discs carry; a folder of ScummVM's DXA re-encodes is recognised by name and not
decoded, on ADR 0024's rule that a Target reads what the publisher shipped.

**Measured, because "the opcodes common to every Version" was a phrase where a
number belongs.** `tests/agos-opcode-coverage.test.ts` reports two figures per
Version, and they say opposite things:

| Version    | Game opcodes  | VGA script opcodes |
| ---------- | ------------- | ------------------ |
| Elvira1    | **142 / 142** | 38 / 56            |
| Elvira2    | **153 / 153** | 49 / 63            |
| Waxworks   | **145 / 145** | 49 / 63            |
| Simon1     | **133 / 133** | **62 / 62**        |
| Simon2     | **132 / 132** | 60 / 73            |
| Feeble     | **149 / 149** | 62 / 83            |
| PuzzlePack | **142 / 142** | 62 / 83            |

**The game opcodes are complete on every Version**, and the **VGA script
machine** is now complete on Simon 1 and between 68% and 78% elsewhere. A game
Subroutine's only contribution to the screen is to start one of these scripts,
so the number in the right-hand column is the ceiling on what an AGOS game can
put in front of a player, whatever the left-hand column says.

**Two things that number does not mean.** The first is that a right-hand column
reading `62 / 62` makes a game playable. About a third of Simon 1's VGA opcodes
ask about things a renderer does not own — items, hit areas, speech, the
animation table — and they reach them through a **host seam**
(`gfx/vgaHost.ts`). Under a running game that seam is answered by
`world/engineVgaHost.ts`, and **nine of its eleven methods are real**: the three
item queries read the interpreter's own world, the two hit-area operations move
and enable real boxes, `CHAIN_TO` reads the graphics resource's animation table,
and the three route calls reach a real pathfinder. `speechActive` is real
wherever there is sound.

**The two that are not are numbered sound effects.** AGOS keeps them in their
own resource and nothing here opens it, so there is no sample to play. Both add
an entry to the Engine's `vgaUnsupported` by name, on the standing rule that a
silent no-op is worse than a named gap — a door that creaks silently is a bug
somebody has to find, and a recorded opcode is one already found.

**`world/pathfinder.ts` is deliberately not a router**, and the distinction is
worth stating because the word invites the wrong thing. AGOS's routes are
_authored_: the points arrive in the bytecode as a `q` operand the VGA decoder
already reads as a list of pairs. So the pathfinder holds those lists, answers
which one a script selected, and steps a position along one. A search-based
router would send an actor along a path the author never drew, through scenery
nobody tested, and would do it plausibly — which is the worst way to be wrong.

So the honest sentence is that Simon 1's drawing bytecode runs and its actors
can be walked along the routes its scripts draw. What it still cannot do is make
a sound effect, which is one resource reader rather than an opcode gap.

The second is that the denominator is right. These tables are generated from
ScummVM's **debugger** header, which names an opcode for every slot, while
behaviour lives in a **dispatch** table assembled per Version — and the two
disagree. Simon 1's dispatch has no entry at opcode 28, which the debugger names
`PLAY_SOUND`; only Elvira 2 and Waxworks install it. So a Version's real
instruction set is smaller than its row's denominator, by an amount nobody here
has counted yet.

Simon 1 was the cheapest of the seven by a small margin, and is now the one
Version with no VGA opcodes left. It is also the Version with real data to check
against, since its DOS demo is freely redistributable.

**And the sweep now covers whole games rather than a fifth of them.** It used to
check `GAMEPC` alone, which for Simon 1 is 75 Subroutines out of the game's
1,655 — and the 75 with no room logic in them. Reading the table files as well
(`resource/tableSource.ts`) takes the retail Windows release to **1,655
Subroutines and 69,676 instructions with nothing disagreeing**, the DOS CD demo
to 272 across its thirty table files, and the DOS floppy demo to 275 across
four. The tool is still careful about what that means: "a falsifier passing, not
a proof the table is right" — and it is now a falsifier with the whole game under
it rather than its opening.

## Simon 1 now plays its opening, and what that took

The row above changed on one game, and this section is the honest version of it.
Everything below was found against a **retail Windows copy of Simon the
Sorcerer**, which is the first real AGOS game this project has been pointed at
rather than a demo.

**Six things were wrong or missing, and every one of them produced a plausible
nothing.** No unimplemented opcode, no exception, no short read — the engine
reported a clean run and drew a black rectangle. That is the failure mode this
family's documentation spends the most words on, met in the worst possible form,
and it is why `npm run shot:agos` now exists: all six were found by looking at a
picture rather than at a count.

| What was wrong                                                                | What it looked like                          |
| ----------------------------------------------------------------------------- | -------------------------------------------- |
| Table Subroutines were not read at all, and the game's first line is in one   | 0 instructions executed, reported honestly   |
| A graphics resource's header is not at offset zero                            | every zone reported no images, no animations |
| `o_animate` and `o_picture` went through one of a resource's two tables       | every draw request answered false            |
| Sprites are drawn from their own fields once a frame; that pass did not exist | scripts ran, framebuffer untouched           |
| Simon's palette encoding is not the general one                               | correct pixels, black palette                |
| Backdrops are **five** bits a pixel, not four                                 | the right picture behind vertical stripes    |
| **A script could not suspend**, and an AGOS script blocks                     | the intro finished before it was drawn       |
| `o_done` did nothing, where it ends a Subroutine                              | an idle timer that ran during the intro      |
| `o_process` recursed instead of pushing a frame                               | a blocking callee returned at once           |
| A sync is global; only the raising zone's sprites were woken                  | the intro deadlocked on its first animation  |
| `NEW_SPRITE`'s zone is the id's hundreds column                               | nineteen intro sprites never created         |
| `RESET` clears **every** zone's sprites                                       | four scenes on screen at once                |
| A picture clears its window to its own entry's colour                         | each scene drawn over the last               |
| A word operand of 30000 + _n_ is variable _n_                                 | a floor click asked for point (30001, 30002) |
| `oe2_doTable` runs an item's own Subroutine, not its number                   | a room's behaviour never reached             |

**The one that was worth all the others.** An AGOS script _blocks_ —
`o_waitSync` stops until the drawing bytecode raises an id, `o_picture` stops
until the screen has been copied — and the reference expresses that by calling
`delay` from inside the script engine, which runs the drawing machine and comes
back. Running a Subroutine to completion inside one host frame is not a
slightly-too-fast version of that; it is a different program. Simon 1's intro is
eleven pictures and a dozen synchronised animations, and it ran between two
frames of the renderer: every wait fell through, every picture but the last was
overwritten before it was drawn, and a player saw the last frame of an intro
that had already happened. `AgosTask` is a Subroutine with a stack of frames and
a wait; `begin` starts one and `advance` runs it until it suspends. Seven of the
faults in the table above were found by building it.

**What plays.** Subroutine 101 opens the game and Subroutine 1 is queued as its
heartbeat, both out of `TABLES01`. Seven graphics zones load. The wizard's study
is drawn, "Adventure Soft presents" over it, then the Simon the Sorcerer logo in
gold. **The intro then plays through** — a nested chain of eight Subroutines
across sixteen thousand frames, every animation waited for and arriving — and
hands control to the player in the wizard's study: fire lit, doorway to the
outside, Simon standing in the middle, verb bar below. The verb bar draws its twelve verbs — Walk to, Look at, Open, Move,
Consume, Pick up, Close, Use, Talk to, Remove, Wear, Give — out of the game's own
strings, in the font read from the interpreter beside it. Clicking a verb chooses
it and clicking a thing issues the command: "Look at" on the object at (28, 98)
answers _"That's not part of a balanced diet."_, which is Simon 1's own line.
The game says its own words throughout — "It's my little dog - Chippy.", "It must
be Calypso's junk." — which are local strings out of the `TEXT` resources.

**And the player can now reach all of that, which is separate from its being
drawn.** The first report from somebody holding a copy was that the game "plays
but I cannot interact with it" — no way past the opening, no way to move, no way
to touch anything — and it was three faults, none of which drew anything wrong
or reported anything:

- **Keys never arrived.** `AgosInput` listened for `keydown` on the canvas,
  which never holds focus; `InputSurface.keys` exists and says why in its own
  documentation, and AGI and SCI both use it. Nothing errored, so this looked
  like an engine with no keyboard rather than one whose keyboard was wired to
  the wrong object.
- **No verb was ever live.** Simon 1 always has one: `resetVerbs` takes box
  101's verb over the room and box 102's over the panel, and
  `AGOSEngine_Simon1::handleMouseMoved` swaps between them as the pointer
  crosses y 136. Box 101 carries "walk to", which is why a bare floor click
  walks in the original. The bar here started empty, so every click on the floor
  or on a thing returned "idle" — the verb bar was drawn and inert, and the game
  looked like one whose scripts were not running.
- **Nothing read a request to skip.** Neither `_exitCutscene` nor the right
  button's speech skip existed, so the opening ran to its end whatever the
  player did.

With those three fixed, on the retail talkie copy swept here: a bare click on
the floor installs verb 201 and dispatches a walk, and every one of the twelve
strip verbs pointed at a room object answers in the game's own words — _"A large
Goblin guard is blocking the passage."_, _"I'd prefer chicken."_, _"My sense of
fashion dictates otherwise."_, and nine more, one per verb. The opening on that
copy is 3,288 frames — fifty-five seconds, most of it one forty-five-second
narration — and Escape brings it down to under two.

**How Escape skips, and where that diverges.** The reference has two ways out of
a sequence and neither reaches this opening. Escape is honoured only where the
game has set bit flag 9; six of Simon 1's Subroutines set it and the opening is
not one of them. The right button's route is refused because it tests bit flag
14 — "nobody is talking" — which Subroutine 101 sets at boot and which nothing
in the game or in the reference ever clears. Both checked against this copy's
own bytecode and at runtime.

So both reference routes are implemented as the reference has them, and Escape
does one more thing when neither applies: it **cuts the wait short rather than
the script**. Every instruction still runs, in order; only the waiting between
them is shortened. That is what makes it safe to do without the game's
permission — abandoning a sequence leaves instructions unexecuted, which is why
the reference asks the game first, whereas declining to wait cannot leave the
world half built. Measured both ways, the skipped ending and the watched ending
are the same screen, and the game is idle and answering clicks after either.

Music renders: thirty-four tracks through the OPL2 core, in the bundle-of-MIDI
format the Windows releases replaced GMF with. Speech reads: 3,623 recorded
lines. Sound effects read per scene, one bank per table file, as that release
ships them.

**What is not, stated as plainly.** `Completable` is **not** claimed and nothing
here is close to claiming it: nobody has played this game through, and the bar
is its last screen. What a player can do, and what is still wrong, measured on
the retail Windows copy with Escape past the opening and control in hand at
frame 14,628:

- **Simon walks where the click lands, and he does leave the room.** A floor
  click reaches variables 1 and 2, `os1_getPathPosn` answers with a route and a
  point, the room's own Subroutine is reached through `oe2_doTable`, and his
  walking sprite starts. Different clicks give different answers and different
  places: 280,120 gives route 3 point 4 and puts him at the right-hand end of
  the study, 40,125 gives route 1 point 0 and puts him over by the fire. Clicks
  at the doorway take him out of the study and on: the item he is in goes
  91 → 160 → 161, a zone loading on each arrival (31 → 32 → 33). An
  earlier reading here said a floor click walks to the same place whatever the
  player does, from a trace of Subroutine 21 and variable 60; the positions
  measured since contradict it, and the trace is withdrawn rather than kept
  beside them.
- **That claim used to be true only for about the first minute of the game**,
  and this entry said so without knowing it. The measurements above were taken
  early; a player who watches the opening and then clicks gets nothing, which
  is what the owner of this repository reported. Simon's position is variables
  15 and 16, and clicking (230,115) after _n_ frames of settling moved him from
  17,61 to 27,68 for _n_ up to about 3,300 and moved him nowhere at all for any
  _n_ above it. The cause was one line in `VgaMachine`: the bit flags were a
  private bank **per zone**, where `_bitArray` in the reference is one bank the
  whole engine shares. Simon 1's opening raises bit 11 from a zone-11 sprite and
  lowers it from a zone-1 sprite, so with a bank each the lower never reached
  the raise; at frame 3,300 the walk's _stop_ script (#1122, which guards itself
  with `IF_BIT_CLEAR 11`) read the stuck bit, skipped its own jump and armed a
  `WAIT_SYNC 1104`. That stale waiter then fired on the first turn of the
  player's first walk and ran 78 `STOP_ANIMATE`s over the three scripts the walk
  needs. Fixed; the same click now walks him at 6,000 and at 12,000 frames.
- **A click that arrives while one of the game's own scripts is running is
  ignored, and that is the reference's arrangement rather than a fault.** Hit
  areas are dispatched only when no Subroutine is mid-flight. Around frames
  3,260–3,540 a time event has Subroutine 160 blocked on `WAIT_SYNC 1198`, and
  a single click in that window does nothing — `os1_getPathPosn` is never
  reached, so variables 6 and 7 keep their old answer. A second click once the
  sequence ends walks him, measured at 3,300, 3,400 and 3,500.
- **A copy of him stays where he was.** The stance he walks out of is never
  killed: after a click the zone-11 sprite list holds #1198 at 17,61 and #1199
  below it _and_ the walking sprite #1102 at the new place, and a screenshot
  shows two Simons in the study. The walk is right and the erase is missing, and
  it is the most visible thing wrong with this game now. (The sprite numbers
  differ from the pair this entry named before, which were read at a different
  point in the opening.)
- **The room answers when pointed at, in letters.** Its objects are clickable —
  the boxes its own script defines — and "Look at" on the bookcase answers _"It
  must be Calypso's junk."_ and on the picture _"A strange picture with strange
  symbols around it."_, drawn in the game's own font. Until this run they were
  collected and drawn in shapes that were not letters: the font scan was
  choosing a pointer table in `Simon1.exe` over the font six kilobytes behind
  it, and what fixed it is in `agosFont.ts` — a letter is one unbroken stroke
  in a box with a blank row left over, which a sparse table is not. What that
  has not been checked against is a full room's worth of verbs on a full game's
  worth of rooms.
- **A line longer than the window shows only its tail.** The window Simon 1
  puts its answers in is one row of forty columns, and a longer line wraps to
  two of which only the last is drawn — _"A strange picture with strange
  symbols around it."_ arrives as _"around it."_ if it is read too early. The
  reference does not scroll here either: `windowNewLine` scrolls for Elvira and
  Waxworks and leaves the row alone for Simon (`charset.cpp:382`), so the
  overflow is drawn a row lower, over the panel. Neither shows a player the
  whole line, and nothing here waits for them to have read it.
- **Nobody has played this game through**, which is the whole of what
  `Completable` asks and the reason it is not claimed.
- **The other six Versions have not moved.** They read, decompile, re-emit
  byte-identically and run every game opcode, and their drawing tables are
  between 68% and 78% covered. Everything in this section is Simon 1's.

**What is still missing family-wide.** The Elvira menus and Feeble's interface,
beyond the plumbing that would carry their events. The remaining VGA opcodes on
six Versions.

**What it has now been tested against.** Adventure Soft's demos are freely
redistributable and ScummVM collects them, so `npm run fetch:agos` fetches them
and `npm run sweep:agos` sweeps them. Eight releases across four Versions —
Elvira 1, Waxworks, Simon 1 in both release kinds, Simon 2 in three builds and
two languages — decode whole with **nothing disagreeing**, which is ADR 0027's
remaining tripwire tested rather than merely written down (#291, and the second
amendment to ADR 0027). The Smacker reader has been run over the 71 `.smk` files
The Feeble Files' demo ships: 15,961 frames, and the frame table walks to the
exact end of the file in every one.

**What that still does not cover.** Demos are subsets, and the retail Simon 1
now swept here shows by how much: a demo Simon 1 reaches 272 Subroutines where
the retail game has 1,655, so an opcode no demo reaches is one those sweeps say
nothing about. **Elvira 2 and the Puzzle Pack have
no demo anywhere** and rest on the fixture alone, which is
`docs/processes/verifying-version-support.md`'s trap exactly: a fixture encodes
our reading, so it and the reader agree with each other and may both disagree
with the games. The one guard there is that the argument tables are generated
from the reference rather than typed out.

The scope is the whole catalogue, playable and editable: seven Versions, where
an AGOS Version is a **title** rather than a number, because Adventure Soft
never versioned the engine and the opcode table changes between games and
nowhere else (ADR 0027). Simon the Sorcerer 3D is out of scope permanently — it
shares a name and a protagonist with the list below and is a different,
hardware-accelerated engine that ScummVM does not implement either.

**How much to trust the release lists below.** They are transcribed from
ScummVM's detection tables and from secondary sources, not read off data in
hand. Every one of them is a claim the Version probe will either confirm or
correct, and where a release is reported but unconfirmed it says so. This is the
same trap `docs/processes/verifying-version-support.md` names for fixtures: a
list that encodes our expectations agrees with our code and disagrees with the
games.

### AGOS Elvira1 — Elvira: Mistress of the Dark (1990)

Horrorsoft's first, and the engine's. Menu-driven and first-person; graphics as
loose numbered files rather than a packed archive.

- DOS — **in scope**; Amiga and Atari ST out of scope

### AGOS Elvira2 — Elvira II: The Jaws of Cerberus (1991)

- DOS — **in scope**; Amiga and Atari ST out of scope

### AGOS Waxworks — Waxworks (1992)

- DOS — **in scope**; Amiga out of scope

### AGOS Simon1 — Simon the Sorcerer (1993)

The game this family was scoped for, and the one with the widest spread of
releases — which makes it the test of ADR 0028's claim that platform and
language sit outside each other.

- DOS floppy, and DOS CD talkie — **in scope**
- Windows — **in scope**
- Amiga floppy (ECS and AGA), Amiga CD32, Acorn Archimedes, Macintosh — out of
  scope (`.out-of-scope/agos-non-dos-releases.md`)
- Playable demos, DOS
- Languages including English, German, French, Italian, Spanish, Polish, Russian
  and Hebrew; the Hebrew release is laid out right to left and is what
  **Text direction** (`CONTEXT.md`) exists for
- GOG, Steam and 25th Anniversary Edition data, and fan translations, are all
  admitted (ADR 0028) — the re-encoded speech in those decodes through WebAudio

### AGOS Simon2 — Simon the Sorcerer II (1995)

- DOS floppy, and DOS CD talkie — **in scope**
- Windows — **in scope**
- Macintosh, and an Amiga release that is reported and unconfirmed here — out of
  scope

### AGOS Feeble — The Feeble Files (1997)

AGOS 2: 640x480, full-motion video, and an interface that is not the verb bar
its predecessors used. ADR 0027 keeps it in this family rather than splitting it
off, on the bytecode and the packaging rather than on the renderer — a family
with two renderers is still one family.

- Windows — **in scope**; Amiga (AmigaOS) and Macintosh out of scope
- Released in German as _Floyd — Es gibt noch Helden_
- Its videos are **Smacker**, read here — confirmed against the DOS demo, which
  turns out to ship no game data at all: it is 71 `.smk` files and RAD's own
  `SMACKDOS.EXE`, so it exercises the video reader and nothing else

### AGOS PuzzlePack — Simon the Sorcerer's Puzzle Pack (1998–2001)

Four Windows puzzle games shipped as one release on the AGOS 2 engine: Swampy
Adventures, NoPatience, Jumble, and Demon in my Pocket. Held as one Version
because they ship as one release on one opcode table; if the data says otherwise
they become four Versions and nothing else changes.

### Out of scope

- **Simon the Sorcerer 3D** (1998) — a different engine, recorded in
  [`.out-of-scope/agos-simon-3d.md`](../.out-of-scope/agos-simon-3d.md) rather
  than deferred
- **Every non-DOS, non-Windows packaging** of the games above, in
  [`.out-of-scope/agos-non-dos-releases.md`](../.out-of-scope/agos-non-dos-releases.md)
