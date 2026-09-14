# The editor, family by family: SCUMM, Broken Sword, Broken Sword II, Sierra SCI

The owner's sentence for the two Broken Sword families was that the editor
"must have the same functionality as the SCUMM editor in this application,
including the accordion options on the left column", and the same sentence was
then asked of Sierra SCI. This page is the answer, measured row by row rather
than asserted, and it is written so that a **No** is as readable as a Yes:
every one of them says what is missing and why, and the difference between
"this format cannot" and "nobody has written it yet" is never blurred.

The standard being applied is ADR 0013's: the same _capabilities_, in the
family's own terms, and never a pretend SCUMM room. ADR 0036 is why there are
four columns and not one — a Sword 1 compact, a Sword II object, a SCUMM room
and a SCI object share no record, so parity is a question about what an author
can **do**, not about whether two surfaces look alike.

Counts below are from the games this branch measures against
(`/home/agent/games/sword1`, `/home/agent/games/sword2`,
`/home/agent/games/kq7`); where a count is a property of a _demo_ or of _one
release_ rather than of the family, the row says so.

**The SCI column is one column and the family is eight Versions.** SCI0
through SCI3 differ in the layout of almost every resource the table names, so
a row that holds for King's Quest VII may not hold for King's Quest IV. "Row by
row, Version by Version" below is that breakdown, and it is what the SCI cells
should be read against — the cells themselves are King's Quest VII's, because
that is the only SCI release this branch has bytes for.

**Where the SCI column stands, counted.** 25 Yes, 5 No, 3 that are a Yes for
part of the family or part of the format and say which, and 1 n/a. The three
mixed cells are rows 10, 11 and 17, and each says in its own section what half
it answers and why the other half is not a decision. It was 21 Yes and 11 No
before this branch.

## Measured against the SCUMM editor, which is what was asked for

The tally above counts the SCI column on its own — how many capabilities it
answers. That is the useful number for the editor's own progress and it is
**not** the question "does SCI have the same functionality as the SCUMM editor",
which is a comparison between two columns.

Row by row, against the SCUMM column:

**SCI matches or exceeds SCUMM on 28 of the 34 rows.** It is behind on six:

| #   | Capability                                           | SCUMM | SCI    |
| --- | ---------------------------------------------------- | ----- | ------ |
| 10  | Paint pixels straight into the room canvas           | Yes   | partly |
| 11  | Edit walk areas on the canvas                        | Yes   | partly |
| 12  | Add or delete a room, an actor or an object          | Yes   | No     |
| 17  | Import a PNG over the open frame                     | Yes   | partly |
| 19  | Edit the screen's background art where the screen is | Yes   | No     |
| 27  | Replace a recording and have the export carry it     | Yes   | No     |

The rows that are **No for SCI and also No for SCUMM** are not gaps in parity
and had been reported as though they were. Row 9 is a grid overlay, which SCUMM
has no grid worth drawing either; row 20 is mask and priority layers, which a
SCUMM project carries as `zPlanes` with no surface that edits them. Counting
those two as outstanding measured the editor against an ideal rather than
against the thing it was asked to match.

Three of the six are **partly** rather than absent, and each says in its own
section which half it answers: 10 and 19 are the same underlying absence — a
Picture is edited as a list of items and not painted into — so closing one
largely closes the other.

## The table

| #   | Capability                                                                   | SCUMM                                                                                                   | Broken Sword                                                                                                                              | Broken Sword II                                                                                                                                           | Sierra SCI                                                                                                                                                                                                   |
| --- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Left column is an accordion of sections, each remembering whether it is open | Yes — Rooms, Actors, Objects, Audio                                                                     | **Yes** — 11: Screens, Start positions, Actors, Objects, Scripts, Text (one per language), Palettes, Pictures, Walk grids, Effects, Audio | **Yes** — 10: Screens, Actors, Run lists, Objects, Globals, Text, Palettes, Animations, Walk grids, Audio                                                 | **Yes** — 11: Rooms, Scripts, Vector Pictures, Cel Pictures, Messages, Views, Fonts, Cursors, Vocabulary, Carried through, Audio                                                                             |
| 2   | Each section counts its records in the header, and lists them                | Yes                                                                                                     | Yes                                                                                                                                       | Yes                                                                                                                                                       | Yes                                                                                                                                                                                                          |
| 3   | Picking a row opens that record in the centre pane                           | Yes                                                                                                     | Yes                                                                                                                                       | Yes                                                                                                                                                       | Yes                                                                                                                                                                                                          |
| 4   | Re-open the game's own folder for the session, so large media can play       | n/a — a SCUMM project carries its own resources                                                         | **Yes** — folder bar above the Audio rows (ADR 0034)                                                                                      | **Yes** — same bar, same reason                                                                                                                           | **Yes** — the folder bar above everything else in the column, and it gates Save and Play (ADR 0034)                                                                                                          |
| 5   | A room or screen drawn from the game's own art and palette                   | Yes                                                                                                     | Yes                                                                                                                                       | Yes                                                                                                                                                       | **Yes** — the Rooms section, above Scripts: 99 of King’s Quest VII’s 108 rooms draw the Picture their room instance names; see 5s                                                                            |
| 6   | The things on the screen outlined over that art, hit-tested topmost-first    | Yes                                                                                                     | Yes — every compact with a mouse box or a position                                                                                        | Yes — every object in the screen's run list whose own code states its `ObjectMouse`; 268 of the demo's 973                                                | **Yes** — 989 instances outlined over that art and hit-tested topmost-first; 512 of them draw their own cel and the rest a marker; see 5s                                                                    |
| 7   | Drag one of them to move it, mouse or keyboard                               | Yes                                                                                                     | Yes — writes `o_mouse_x1…y2` and `o_xcoord`/`o_ycoord` together                                                                           | **Yes** — 268 of the demo's 973 objects; the other 705 refused by name on the panel (see 7a)                                                              | **Yes** — 989 of 989, by mouse or by arrow key, writing the instance’s own `x` and `y` property words; still editable as words too (row 25)                                                                  |
| 8   | A walk-to point that moves with the thing it belongs to                      | Yes                                                                                                     | Yes — `o_xcoord`/`o_ycoord` is the anchor                                                                                                 | **Yes** — drawn and dragged on its own handle for 57 of the demo's 268 movable objects; 28 more refused by name, and it does not follow the box (see 8a)  | **Yes** — 929 of King’s Quest VII’s 989 placed things declare `approachX` and `approachY`; all 929 are writable, and 345 of them are not 0, 0. Drawn on the selected thing and edited as two numbers; see 8s |
| 9   | A grid overlay over the screen                                               | No — SCUMM has no grid worth drawing                                                                    | **Yes** — the 16×8 mask grid                                                                                                              | No — Sword II has no screen grid                                                                                                                          | No — SCI has no screen grid. The walkable area is a colour in the Picture’s control plane (11s)                                                                                                              |
| 10  | Paint pixels straight into the room canvas                                   | Yes — Paint, Rectangle, a palette and a colour picker                                                   | **Yes** — a brush on the picture panel, the screen's background included; 7,143 of 7,143 frames take one                                  | **Yes** — same brush, same widget; 10,895 of 10,895 animation frames and 12 of 12 screen layers                                                           | **Fonts and cursors yes, artwork no** — a pixel grid per glyph and per cursor state; see 10s                                                                                                                 |
| 11  | Edit walk areas on the canvas                                                | Yes — Walk box and Walk-to tools                                                                        | **Yes** — bars and nodes drawn over the screen, moved and deleted; 9 grids on the demo, 9 of 9 re-emit byte-identically                   | **Yes** — same tool, same seam; 4 grids on the demo, 4 of 4 re-emit byte-identically                                                                      | **From SCI2 yes, before it no** — 395 polygons and 3,891 points on King’s Quest VII, drawn on the room canvas and editable point by point; 43 more refused by name; see 11s                                  |
| 12  | Add or delete a room, an actor or an object                                  | Yes — + Room, + Actor, Object tool, Delete                                                              | Yes — + Object appends a compact to a section, Delete removes the last; never inserts (12a)                                               | Yes — + Object appends a copy at the next resource id, Delete removes one this editor appended; never inserts (12a)                                       | No — nothing here appends or deletes a resource; see 12s                                                                                                                                                     |
| 13  | Characters listed as a cast, derived from the game rather than typed in      | Yes — the Actors list                                                                                   | **Yes** — compacts whose `o_type` is `MEGA` or `PLAYER`; 5 on the demo                                                                    | **Yes** — objects whose own code calls a mega opcode; 653 on the demo                                                                                     | **Yes** — 147 on King's Quest VII, derived by walking `-super-` to `Actor`; see 13s                                                                                                                          |
| 14  | A character's own art on the character's pane                                | Yes                                                                                                     | **Yes** — from `o_walk_resource`; 2 of the demo's 5, 5 of 5 on a retail install (see "Two of five")                                       | **Yes** — from the animation ids its script pushes; 163 of the demo's 653 name one this project holds and 142 of those draw, the other 21 refused by name | **Yes** — 117 of King’s Quest VII’s 147 cast draw the View their own `view` property word names, on a pane of their own; the other 30 are refused by name; see 14s                                           |
| 15  | Pick a frame of a multi-frame sprite                                         | Yes — the sprite strip                                                                                  | Yes — the frame strip                                                                                                                     | Yes — the frame strip                                                                                                                                     | **Yes** — a loop picker and a cel strip on the View pane and on a cast member’s, over 1,527 Views, 9,027 loops and 53,711 cels; 3,885 of those loops hold more than one cel; see 15s                         |
| 16  | Export the open frame as a PNG                                               | Yes                                                                                                     | Yes                                                                                                                                       | Yes                                                                                                                                                       | **Yes** — a View’s cels one at a time, fonts, cursors, vector Pictures, cel Pictures, **a room as it is drawn**, and **anything selected on that room**                                                      |
| 17  | Import a PNG over the open frame, quantised to the game's colours            | Yes                                                                                                     | Yes — colour 0 stays transparent and stays reachable on purpose                                                                           | Yes — including an RLE16 frame's own sixteen colours                                                                                                      | **Fonts, cursors and a re-encodable cel yes; V56 and Pictures no** — King’s Quest VII is V56, so 10 fonts and 3 cursors take one and none of its 53,711 cels does; see 17s                                   |
| 18  | Play an animation back at speed                                              | Yes — "Play the pose at its real speed"                                                                 | **Yes** — 145 of the demo's 438 sprites, at the rate the script implies                                                                   | **Yes** — 185 of the demo's 509 animations; the rest refused by name (see 18a)                                                                            | **Yes** — the picked loop, stepped at the instance’s own `cycleSpeed` where it declares one — 117 of 117 that draw do — and at SCI’s default of one cel a cycle otherwise (15s)                              |
| 19  | Edit the screen's background art where the screen is, not only in a list     | Yes                                                                                                     | Yes — Import/Export under the drawn screen                                                                                                | Yes — each of the five layer slots                                                                                                                        | No — the room canvas _draws_ the Picture and does not paint into it; a Picture is still edited only as a list of items (10s)                                                                                 |
| 20  | Edit mask / priority layers                                                  | No — a SCUMM project carries `zPlanes` and no surface edits them                                        | **Yes** — composed through their Grid, per screen, since this branch                                                                      | n/a — Sword II has no mask resource                                                                                                                       | No — a cel Picture item’s own priority is a number field (748 items on King’s Quest VII), and there is no layer to draw on                                                                                   |
| 21  | Scripts decompiled to instructions, operands editable in place               | Yes — `ActionEditor` and instruction editing                                                            | Yes — per script module, with named parameters                                                                                            | Yes — per object, with named parameters                                                                                                                   | **Yes** — 218 scripts, 2,821 objects, 3,929 methods and 369,174 instructions on King’s Quest VII, operands editable in place, with a Source view beside them                                                 |
| 22  | A round-trip guarantee stated per record before an edit is allowed           | Yes                                                                                                     | Yes — `roundTrips`, and export refuses a module that does not                                                                             | Yes — same                                                                                                                                                | **Yes** — which bodies may change length is said when the method opens, per script, since this branch; see 22s                                                                                               |
| 23  | Text editable, in every language the release ships                           | Yes                                                                                                     | Yes — one accordion section per language                                                                                                  | Yes — with each line's speech id kept beside it                                                                                                           | **Yes** — the Messages section, one row per line, with every language the release ships named; King’s Quest VII ships none (23s)                                                                             |
| 24  | Palettes editable colour by colour                                           | Yes                                                                                                     | Yes — six-bit VGA triples                                                                                                                 | Yes — the screen's own 256 RGBA quads                                                                                                                     | **Yes** — a colour grid per resource, patched in place; 9 palettes and 2,224 colours on King’s Quest VII, all 9 byte-identical unedited                                                                      |
| 25  | The game's own variable block editable as a table                            | No — a SCUMM script's variable references are edited in the instruction, and there is no variables pane | No — Sword 1 keeps its state in the compacts, which are edited word by word                                                               | **Yes** — Globals, the game's own resource 1                                                                                                              | **Yes** — script 0’s 401 globals, 1,560 locals across 218 scripts, and 96,384 property words on 2,821 objects, every one of them named; see 25s                                                              |
| 26  | Audio listed, played and saved out                                           | Yes                                                                                                     | Yes — music, effects and speech, read from the re-supplied folder                                                                         | Yes                                                                                                                                                       | Yes — 65 audio maps on King’s Quest VII, read from the re-supplied folder                                                                                                                                    |
| 27  | Replace a recording and have the export carry it                             | Yes                                                                                                     | **Yes** — all three kinds: speech re-encoded and `COWS.MAD` rebuilt, a tune written, an effect substituted                                | **Effects yes, measured; speech and music written and unverified** — see 27a                                                                              | **No** — a replacement changes the project and what plays here, not the install: SCI audio Volumes are carried through unrebuilt (#227)                                                                      |
| 28  | Undo and Redo across every edit                                              | Yes                                                                                                     | Yes — the same `EditorState` history                                                                                                      | Yes                                                                                                                                                       | Yes — the same `EditorState` history                                                                                                                                                                         |
| 29  | Save the project, export the project, export a playable game                 | Yes                                                                                                     | Yes — rebuilds `swordres.rif` and the clusters                                                                                            | Yes — rebuilds each cluster's own tail index                                                                                                              | Yes — `packSciGame` on the Save route and the Export one; King’s Quest VII packs to a SCI2 install that reads back as one                                                                                    |
| 30  | An unedited export is byte-identical to the game it came from                | Yes                                                                                                     | Yes — 11 of 11 files on the demo (`npm run reexport:sword`), the speech container and all three executables included                      | Yes — 5 of 5                                                                                                                                              | **Yes** — 3,188 of 3,188 resources (`npm run reexport:sci`), with 0 scripts rebuilt by the linker                                                                                                            |
| 33  | Edit the screen table the interpreter holds, and have the export write it    | n/a — a SCUMM room's size and layers are in the room resource, which row 29 already covers              | **Yes** — read out of `SWORD.EXE` and written back into it; see 33a                                                                       | n/a — Sword II's screens are resources, covered by rows 5 and 19                                                                                          | n/a — SCI ships no interpreter table this project reads. A room is a Script object, which rows 5, 21 and 25 edit                                                                                             |
| 34  | Edit where a character is placed when a script sends them somewhere          | No — a SCUMM `putActorAt` is an instruction, edited in the script by row 21                             | **Yes** — 52 placements read out of `SWORD.EXE`'s own code and written back; see 33a                                                      | No — Sword II sets a mega's position from its object's own local variables, which row 7 edits on the screen instead                                       | **Yes**, in two places and neither of them is a table; see 34s                                                                                                                                               |
| 31  | Play the project from the editor                                             | Yes                                                                                                     | Yes — runs the install this project would export                                                                                          | Yes                                                                                                                                                       | Yes — and what it reaches today is the game’s first room, six screens in; see 31s                                                                                                                            |
| 32  | Every canvas, list and picker reachable from the keyboard                    | Yes                                                                                                     | Yes — `rovingGroup`/`groupItem`, `canvasKeyboard`                                                                                         | Yes                                                                                                                                                       | Yes — buttons, number fields, the accordion’s own disclosure semantics, and the room canvas, which takes Tab, arrow keys and Shift+arrows                                                                    |

## The rows that need more than a cell

Mostly the **No** rows, each named and explained. 7a, 8a and 18a are the
exceptions: all three used to be Noes, all three are Yeses with a count now, and
all three keep their old numbers so the links to them still land and so the
reasons they were wrong stay readable. 8a keeps something else as well — the
measurement that made it a No is still there and still true, because it was
never an argument against editing the point, only against moving it by
accident.

### 33a. The two tables that are in the interpreter, and the interpreter is in the box

**These were a No, and the reason given for the No was an assumption.** The
room table was recorded as editable-and-not-writable because it "lived in
Revolution's interpreter rather than in the game's files, so there is nowhere
to write a change". The first half is true. The second half was never checked,
and it is wrong: **`SWORD.EXE` is in the install**, in the folder with the
clusters, beside `WINSWORD.EXE` and `RUNSWORD.EXE`. What "in the interpreter"
means is _in a file this project is already reading the folder of_.

`src/authoring/sword1/executable.ts` finds both tables, and the two are found
by different means because they are different kinds of thing:

- The **room table** is data: 100 definitions of fifteen little-endian 32-bit
  words (`totalLayers`, `sizeX`, `sizeY`, `gridWidth`, four layers, three
  grids, two palettes, two parallax). Found by voting — every 60-byte window
  that decodes as a plausible definition votes for the base a table containing
  it would begin at, and the base with the most votes wins.
- A **start position** is not a table at all. It is code: four
  `mov dword ptr [abs], imm32` instructions (`C7 05`, ten bytes each) writing
  x, y, direction and place into one object's fields at base+0, +4, +12, +8.
  Found by the shape of those four writes, grouped by the base they address,
  and a row is addressed by its **ordinal among the runs**.

Against the DOS demo:

| file                           | room table                                                              | start positions                 |
| ------------------------------ | ----------------------------------------------------------------------- | ------------------------------- |
| `SWORD.EXE` (609,363 bytes)    | at `0x84578`, 100 screens, 94 of 100 word for word the built-in table's | 52, into the object at `0x7f24` |
| `WINSWORD.EXE` (213,504 bytes) | at `0x24ed4`, 100 screens, 94 of 100                                    | 45, into `0x4288d4`             |
| `RUNSWORD.EXE` (150,528 bytes) | none                                                                    | none                            |

Three consequences, each of which is a decision rather than a detail:

1. **A project reads the install's own table, not the built-in one.** Six
   screens differ (18, 20, 35, 39, 87, 88) because the demo numbers those
   screens' resources differently from the retail game the built-in table was
   written from. Reading the built-in one would show an author a screen this
   install does not have — and would make an export that edited nothing rewrite
   six screens.
2. **An edit goes back into the file it came out of.** `SWORD.EXE` has 52
   placements and `WINSWORD.EXE` has 45, so placement 3 is a different place in
   each; writing one into the other would move a character the edit never
   named. A placement carries the compact id the executable's own bytes give
   it, and a patch is refused outright if that id has changed under it.
3. **`RUNSWORD.EXE` is carried through untouched.** It holds neither table, and
   a file the export was handed is a file the export is responsible for putting
   back.

Measured by `npm run reexport:sword -- <sword1>`, which now covers 11 files
rather than 8: `identical 11 of 11 files` with nothing edited, and with one
start position moved,

```
exe         SWORD.EXE: 609363 -> 609363 bytes, 2 byte(s) differ at 0x4ba10..0x4ba11; the edit names: start position 0's x at 0x4ba10 481 -> 545
exe         WINSWORD.EXE: 213504 -> 213504 bytes, 0 byte(s) differ; the edit names: (nothing)
exe         RUNSWORD.EXE: 150528 -> 150528 bytes, 0 byte(s) differ; the edit names: (nothing)
edit        start position 0 (place 65536): x 481 -> 545 (wanted 545), y 413 -> 413, direction 4 -> 4
```

481 is `0x1e1` and 545 is `0x221`, so two of the field's four bytes change
value — and the assertion in `tests/sword1-executable.test.ts` is the stronger
one: every byte that moved is inside a field the edit named. The read-back is
through the engine's own import of the **installed** folder, not out of the
buffer the exporter returned.

What this does **not** make writable is a folder with no executable in it. A
project imported from clusters alone still reports `rooms:
editable-not-writable` and has no start positions at all, and the editor's own
heading says which of the two a given project is.

### 7a. What can be dragged on a Sword II screen, and what cannot

**This row used to be a No, and the reason given for it was wrong.** It said:

> Sword II puts it in an `ObjectMega` inside that object's **own local
> variables**, at an offset only that object's code knows — the script pushes
> the address and the opcode reads through it — and those locals are Preserved
> bytes. There is no table of positions to move something in, so a drag would
> have to guess an offset per object.

Measured across the demo's 973 objects, nothing has to be guessed, because the
object pushes the offset itself. An object's rectangle is written by its own
code, as constants, immediately before it registers it:

```
CP_PUSH_INT32 340 ; CP_POP_LOCAL_VAR32 96    ; mouse.x1 = 340
CP_PUSH_INT32 275 ; CP_POP_LOCAL_VAR32 100   ; mouse.y1 = 275
CP_PUSH_INT32 475 ; CP_POP_LOCAL_VAR32 104   ; mouse.x2 = 475
CP_PUSH_INT32 405 ; CP_POP_LOCAL_VAR32 108   ; mouse.y2 = 405
CP_PUSH_LOCAL_ADDR 96 ; CP_CALL_MCODE fnRegisterMouse 1
```

The `CP_PUSH_LOCAL_ADDR` operand _is_ the `ObjectMouse` offset, as a literal in
the instruction stream. "An offset only that object's code knows" was an
argument for reading that object's code, not against dragging. Two further
things the old text got wrong: it pointed at **`fnPlaceMega`**, which is not in
Sword II's opcode table at all, and the thing an author drags is the mouse area
— the rectangle the game itself tests a click against — not an `ObjectMega`.

The old conclusion was right about one thing, for a sharper reason than it
gave: all 973 of the demo's variable blocks ship as zero bytes, so there is no
position in the shipped _resource_ to read. The script is not a workaround for
that. It is where the game keeps the answer.

**The count, which is the result.** 268 of the demo's 973 objects state a
rectangle their own code can be made to restate, and those 268 drag with the
mouse or with Enter and Alt-arrow, exactly as a Sword 1 compact does. The other
705 are refused **by name, on the panel under the canvas**, in six kinds:

| Refused                                                            | Demo | Why                                                                                                    |
| ------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------ |
| registers no mouse area                                            | 577  | scenery drawn by `fnRegisterFrame` alone, placed by its animation's own coordinates                    |
| at least one coordinate computed rather than written as a constant | 96   | there is no number in the script to change                                                             |
| registers more than one `ObjectMouse`                              | 24   | no single rectangle to drag                                                                            |
| writes its coordinates more than one way                           | 4    | the rectangle depends on which branch ran, and a drag would silently pick one                          |
| registers the rectangle through `fnRegisterFrame`                  | 4    | the sprite's own bounds overwrite it every cycle, so moving the words would change nothing             |
| hands its mouse structure to `fnRegisterMouse` from a variable     | 0    | which structure it means is decided at run time — commit `0600015`'s rule, and no demo object trips it |

The last row is zero on this demo and the refusal is in the code anyway: the
rule is "never follow an address pushed from a variable", and a rule that is
only written when it fires is a rule that fails the first time it matters. A
literal `0` mouse pointer is _not_ refused as a variable — it is Revolution's
own "no write to mouse list", and counts in the first row.

Per screen, on the demo: 10 of 24 on screen 22, 4 of 23 on 33, 12 of 20 on 302,
3 of 12 on 303, 0 of 1 on 2062, and screen 1739 has no run list joining it to
any object at all — the panel says that rather than outlining nothing.

A drag is written with `editSword2Operand`, one ordinary script edit per word:
undoable, visible in the object's own instruction listing, and carried by the
exporter that already re-emits 973 of 973 objects byte-identically. The code is
`src/editor/sword2/screenBoxes.ts`.

### 8a. A Sword II walk-to point is shown, moved on its own handle, and does not follow the box

Sword 1's anchor is `o_xcoord`/`o_ycoord`, a field of the same compact as the
mouse box, so the two are one record's idea of where a thing is and they move
together. Sword II has no such field. The nearest thing is
`fnSetStandbyCoords(x, y, dir)`, and what it writes is not the object's
anything: it sets the **router's three global standby words**
(`_standbyX`/`_standbyY`/`_standbyDir` in ScummVM's `walker.cpp`), which
`fnWalkToAnim`, `fnStandAtAnim` and `fnStandAfterAnim` use as their target only
when the animation being played has a `feetStartX`/`feetStartY` of (0,0).

Every object that sets one sets it immediately before its own walk or stand
call, which is why it reads as "stand here to use me". So it **is** drawn, as
the picked object's second point, and it is **editable on its own**: the x and
y are two `CP_PUSH_INT32` operands in the object's own code, written back
through `editSword2Operand` — the same one-operand-at-a-time route row 7's four
rectangle words go through, undoable and visible in the instruction listing.
The handle is hit-tested before the object's body, so a point sitting inside its
own rectangle can still be grabbed; Enter picks it and Alt with an arrow moves
it, one pixel or eight, which is the keyboard equivalent row 7's drag already
had (`docs/accessibility.md`).

What it is not is a **field** of the rectangle, and the measurement is why. Of
the 57 movable objects that set one literal point, 49 put it inside their
rectangle or within 100px of it on both axes, and 8 put it as far as 636px away
(`exit_34`'s rectangle is at (0,190)-(90,399) and its standby point at
(726,192); the gap is the Chebyshev one — the larger of the two per-axis gaps
from the point to the rectangle). Shifting all 57 by a drag's delta would be
right about most of them and quietly wrong about the rest, and "quietly wrong
about the rest" is the thing this page exists to avoid. So the box drag leaves
the point exactly where it was, and an author who wants both moved drags two
handles — two edits they can see and undo separately. There is no "move it with
the box" option, not even off by default: those 8 are not a minority to be
handled by a checkbox, they are the evidence that the relationship the checkbox
would claim does not exist.

**The count, and what the rest are refused for.** 225 of the demo's 973 objects
call `fnSetStandbyCoords`, and 268 objects are movable at all (row 7). Of those
268: **57 have both operands as literals and one consistent point, so they are
editable**; 183 make no such call and have no second handle to show; and **28
set more than one distinct point** and are refused by name on the panel, because
an object whose two branches stand the player in two places has no single answer
to draw and moving one of them would silently pick it. Across all 973, one
object pushes its coordinates from variables — `passing_train_72`, from globals
141 and 142 — and is refused under commit `0600015`'s rule, never follow a value
pushed from a variable; it registers no mouse area, so it never reaches a canvas
anyway. A coordinate the script computes rather than pushes is refused the same
way; no object on this demo does it, and the rule is written before it is
reached rather than after.

The reader, the writer and the refusal sentences are in
`src/editor/sword2/screenBoxes.ts` (`moveSword2Standby`,
`SWORD2_STANDBY_REFUSALS`); the handle itself is the shared canvas's
(`sceneAnchorAt`/`sceneAnchorNudge` in `src/editor/sceneCanvas.ts`), which is
what makes it the same handle Sword 1's anchor gets rather than a second
implementation of one.

### 10a. The brush, and where it reaches

This row used to be a No, and it was the one No in the table that was a missing
**tool** rather than a missing format. Nothing in either format stopped it:
`swordEncode.ts` and `sword2Encode.ts` write every compression these games use
as well as reading them, and `npm run sweep:sword` re-encodes 7,113 of 7,113
Sword 1 sprite frames and 14,085 of 14,088 Sword II animation frames to the
bytes the games shipped.

So the brush was written where both families already meet: `swordPictureView.ts`
is one widget serving both surfaces, and it was **widened** rather than forked,
which is the same decision the previous round made with `sceneCanvas.ts`. A
fourth canvas class beside SCUMM's `SpriteCanvas` and `ObjectArtCanvas` would
have been two copies of the same twenty lines, one per family, and ADR 0036
allows a widget to cross where a record may not.

|                          | Broken Sword                                     | Broken Sword II                        |
| ------------------------ | ------------------------------------------------ | -------------------------------------- |
| frames the brush reaches | 7,143 of 7,143                                   | 10,895 of 10,895 animation frames      |
| across                   | 468 pictures                                     | 509 animations                         |
| by kind                  | 7,113 sprite, 15 mask, 13 background, 2 parallax | 12 of 12 screen layers, over 6 screens |

Those counts are the panel's own answer — a frame is counted only where it
decodes **and** `sword1PictureRefusal`/`sword2PictureRefusal` has nothing to
say about writing it back. A frame that cannot be written still draws and still
says why, next to the controls that would have changed it.

**What a stroke does.** The pixels are copied when the panel is built, painted
into as the pointer moves, and written back through the same encoder Import
uses — once, when the pointer lifts or a key is pressed, rather than once per
pixel. That is one re-encode and one undo step per stroke. Writing back
deliberately does **not** re-render the surface: the canvas being painted on is
the one that would be rebuilt, and a canvas rebuilt after a keystroke is a
canvas the keyboard has just lost.

**Keyboard.** Required, not optional, and the keys are `canvasKeyboard.ts`'s so
they are the same ones every other canvas here answers to:

| Key                      | What it does                        |
| ------------------------ | ----------------------------------- |
| Arrows                   | move the drawing cursor a pixel     |
| Shift + arrows           | move it eight                       |
| Home / End / PgUp / PgDn | to the edges                        |
| Enter or Space           | paint the chosen colour             |
| Delete or Backspace      | erase to colour 0                   |
| P                        | pick up the colour under the cursor |

The pointer has the same three gestures: drag to paint, right-drag to erase,
Alt-click to pick up. The colours themselves are a radio group the arrow keys
move through, and they are the **frame's own** — an RLE16 Sword II frame offers
the sixteen its resource carries and no others, and a background that has no
transparent pixel is offered no eraser.

Whole-frame replacement is still there beside it, and is still the gesture an
artist replacing a hand-painted Revolution background usually makes: Export the
frame as a PNG, paint it anywhere, Import it back.

### 10b. HIF, written against the decoder and measured in pixels

HIF was the one compression in either family with no encoder, and the reason
given was: an LZ match-finder chooses between equally valid matches, so a
re-encode would not reproduce the bytes Revolution shipped. That is true, and it
was an answer to the wrong question. Every other encoder here is held to byte
identity because there is a shipped stream to be identical _to_ and an unedited
export has to be a copy. **No PC release carries a HIF frame at all** — the
scheme belongs to the PlayStation conversion, which selected it by platform and
left the original `RLE7`/`RLE0`/`JIM ` tags in the headers — so for HIF there is
no original stream, and "the same bytes" is not a property that exists to check.

The property that does exist is that the decoder already in this project reads
back what the encoder wrote. `compressHIF` is a greedy match-finder over hash
chains: matches of 3 to 18 bytes, distances of 1 to 4,096, big-endian
`(length - 3) << 12 | (distance - 1)`, eight flags to a control byte, `0xFFFF`
to end. Two rules come off `decompressHIF` rather than off any documentation.
A match may overlap what it copies, because the decoder copies a byte at a time
from a moving source — distance 1 is a run, and a frame of transparency is a
handful of bytes because of it. And length 18 at distance 4,096 _is_ the word
that ends the stream, so that one pair is written a byte shorter; a stream that
wrote it would decode as a frame that stops at that match with the rest
transparent.

Measured on the demo by `npm run sweep:sword`, in pixels:

| what                                    | number     |
| --------------------------------------- | ---------- |
| frames encoded as HIF and decoded again | 7,113      |
| giving back the pixels that went in     | **7,113**  |
| giving back different pixels            | 0          |
| pixels round-tripped                    | 53,238,548 |
| bytes those 7,113 HIF streams occupy    | 11,519,148 |

The frames are the demo's own, decoded from the RLE7, RLE0 and Tony streams
Revolution wrote, so what is round-tripping is real sprite data rather than
generated patterns. **This is not a claim that a PlayStation Broken Sword would
read these frames**: no PSX install is reachable from this project, the sweep
above runs against the PC demo, and the only encoder this has been checked
against is this project's own decoder. It is a valid HIF stream by that
decoder's reading of the format, and that is the whole of the claim.

### 11a. Walk areas, and what is editable about them

This row used to be the largest **No** in the table. It is a Yes now, and what
follows is what that covers and what it does not.

SCUMM's walk boxes are a table in the room resource. Sword 1's routing is bars
and nodes in a **walk-grid resource** that the mega's floor object names through
`o_resource`; Sword II's are resources a script adds and removes with
`fnAddWalkGrid` and `fnRemoveWalkGrid`, concatenated into one set of bars and
nodes per room. Both are carried into the project now, drawn over the screen on
the canvas seam both families already share, and written back:

|                          | Broken Sword | Broken Sword II |
| ------------------------ | ------------ | --------------- |
| grids on the demo        | 9            | 4               |
| bars / nodes carried     | 204 / 109    | 36 / 12         |
| bytes                    | 5,656        | 1,120           |
| re-emit byte-identically | 9 of 9       | 4 of 4          |

The counts are `npm run sweep:sword`'s, re-run against both demos, and the
byte-identical column is the sweep re-encoding every grid from the bars and
nodes the project holds rather than from the bytes it read.

**Where a grid is found.** Sword 1's join is a table: a compact whose `o_type`
is `FLOOR` names its grid in `o_resource` and its screen in `o_screen`, and the
demo's 9 grids are named by 21 floor compacts across 21 screens — 13 of those
screens share one 10-bar grid with no nodes at all. Sword II has no such table, so the join is by name and by literal — a run list called "Run list for
11" belongs to the screen called "Screen 11", the run list holds object ids, and
those objects' own code pushes the grid id into `fnAddWalkGrid`. All four of the
demo's grids resolve that way: `grid11` to screen 22, `grid12` to 33, `grid14`
to 303 and `walkgrid128` to 2950.

**What an author can do.** Move a node, move either end of a bar, slide a whole
bar, delete a bar. On the canvas: `W` turns walk editing on, Enter picks what is
under the cursor, Alt with an arrow moves it (Shift for 8 pixels), Delete
removes a bar — and there is a Walk grids accordion section with numeric fields
for every endpoint and a Delete button per bar, so none of it needs a pointer.

**What it cannot do, and why.** A node cannot be deleted and neither can be
added. Both routers address a node by its index — Sword 1 reserves slot zero for
the walking mega and numbers the stored nodes from one — so removing one
renumbers every node after it and changes routes nobody edited. The canvas says
that sentence rather than offering a key that corrupts a route. (The 47 bars and
36 nodes this page used to quote for the demo's screen 1 were the router's
numbers: the resource stores 47 bars and **35** nodes, and the router's
thirty-sixth is that reserved slot.)

Coordinates are clamped to what a 16-bit field holds and not to the screen: the
demo's own grids run off the edge of a scrolling screen, and clamping to the
picture would silently rewrite the game the first time a grid was opened.

### 12a. Records are appended and deleted, never inserted

**This row used to be a No in both Sword families, and the reason given for it
was half true.** It said:

> A Broken Sword project is an edit of a shipped one, and its records are
> addressed by offsets other records hold: a Sword 1 section's own table gives a
> word offset per compact — sometimes out of order, and kept verbatim for that
> reason — so a compact that grew or a section that gained one would move every
> record after it and leave every script that addresses them pointing at the
> wrong object.

Growing a record does move every record after it, and inserting one does too.
**Appending one does not**, and the difference is what the row now means. It is
Yes for both families for _append_ and for _delete from the end_, and it stays
No — permanently, and on the arithmetic below — for _insert_.

#### Sword 1: the index is a subscript, not an offset

A script names a compact by `section * 0x10000 + index`. `SwordLogic.engine`
builds exactly that id and `SwordObjects.fetch` splits it again, and the index
is a **subscript into the section's own offset table**, never a byte offset. So
every record in a section can move, provided the table moves with them, and the
game cannot tell.

Measured across all 96 sections of the demo:

|                                                                              |                                                       |
| ---------------------------------------------------------------------------- | ----------------------------------------------------- |
| sections whose table is packed tight against the first record                | 96 of 96                                              |
| sections whose tables are out of order                                       | 3 of 96 (section 16's four offsets are 5, 52, 30, 74) |
| sections whose **highest-indexed** compact is also at the **highest offset** | 96 of 96                                              |
| sections whose last compact is named by nothing in the project               | 15 of 96                                              |

The third row is what makes deleting safe and the second is why it had to be
checked: a section whose last index sat in the middle of the payload would need
every record after it moved to close the hole. None does.

So an append is four numbers: the table gains an entry, every record shifts one
word later, every offset in the table goes up by one, and the new record lands
one word past where the payload used to end. `export.ts` needed no change at
all — a compact section's `comp_length` and `decomp_length` both hold the whole
resource's length, which `rewriteResource` already rewrites. A delete is the
same four numbers backwards.

Measured end to end by `npm run reexport:sword -- <sword1>`, which appends to
section 1 every run:

```
append      section 1: 16 objects in 652 words -> 17 in 678; object 16 reads
            back as a copy of object 0: true; 16 of 16 existing objects unmoved
```

#### Sword II: both tables grow at the end

`resource.tab` is a flat array indexed by resource id — four bytes an entry,
`(cluster line, index within that cluster)` — and every cluster carries its own
`(offset, length)` table in its tail. The demo's index declares **4,147** ids,
**20** of which are `0xffff` and hold nothing, and every present cluster's tail
table holds exactly as many entries as there are ids pointing into it, dense
from 0. There is no spare slot anywhere, so a new resource needs a new entry in
both tables — and both go on the end, at id 4,147 and at one past the cluster's
last index, where they displace nothing.

The next free id is the table's **length**, not one past the highest object:
those 20 holes are inside the range, and taking one would put a resource where
the game has already decided there is none.

Two things the copy needs that are not obvious:

- **Its hub's script ids are rewritten** from `source * 0x10000 + n` to
  `copy * 0x10000 + n`. `Sword2Logic.runObject` compares the object half of a
  script id against the id it is running for, so a copy that kept its source's
  hub would run the original's code against the original's structures every
  cycle and be a second name for one object rather than a second object.
- **Its session has to grow.** None of the demo's thirteen run lists has a
  single spare word — they are packed tight against their terminator — so a run
  list that gains an id is a resource that got longer. That used to be refused
  on the grounds that "there is no index entry to grow here", and the refusal
  was wrong: the cluster's tail table carries a length per resource and the
  export rewrites it, so `Sword2Resources.fetch` reads exactly the new length.

Measured end to end by `npm run reexport:sword -- <sword2>`:

```
append      resource.tab 16588 -> 16592 bytes, its first 16588 unchanged: true
append      object 4147 (right_hand_wheel_41_COPY) copied from 3: 973 objects ->
            974, round-trips true, same code as its source true; run list 2
            2 -> 3 objects; 972 of 972 existing objects unmoved
```

#### What a new record _is_

A copy of an existing one, in both families, and that is a decision rather than
a shortcut. Neither format has a blank record: a Sword 1 compact of zeroes has
`o_type` 0, `o_logic` 0 and an `o_tree` pointing at script 0, and what the logic
engine does with it is undefined rather than nothing. A copy of a record the
game itself ships is the only starting point this project can call legal, and
every word of it is then editable on the object's own pane.

#### What stays No

**Inserting**, in both families, and deleting anything but the last record.
An index is a name here — `section * 0x10000 + index` in one family, a flat
resource id in the other — so a record put in the middle renames every record
after it, and there is no renumbering pass that could follow it: a Sword 1 id
is pushed as a bare `IT_PUSHNUMBER` operand and a Sword II id is a bare integer
too, both indistinguishable from any other number a script pushes.

And **deleting a shipped Sword II object**, which is a measurement rather than a
policy: of the 973 objects in the demo, exactly **one** is the highest index in
its cluster, and a run list names it. **0 of 973** can go. An object appended
here is the last entry of both tables by construction, so it can — the editor
offers exactly that, and refuses the rest by name.

### 18a. Playing an animation back, and the animations nothing plays

**This row used to be a No in both Sword families, and half of the reason given
for it was right.** It said:

> A Sword 1 sprite resource and a Sword II animation resource carry frames and
> no timing at all — the speed a mega walks at is in the script that animates it
> (`fnAnim`, `fnMegaTableAnim`) and in the compact's own `o_frame`/`o_anim_pc`
> bookkeeping, not in the picture. So a preview loop would have to pick a rate,
> and a preview playing at an invented speed teaches an author something false
> about their own game.

Every sentence of that is true of the **resource**. None of it is true of the
**game**: the rate is in the script, the frame order is in the script, and both
are already in this project. So the preview is driven by the script that plays
the animation, exactly as the old note said the honest version would have to be,
and the result is a count rather than a claim.

#### The rate is read, not chosen

Both engines step an animation one frame a _game cycle_.
`SWORD1_TICKS_PER_STEP` and `SWORD2_TICKS_PER_STEP` are both 5, and a tick is a
sixtieth of a second, so a frame is held for 83⅓ ms — **twelve frames a second**
in both families. Those two constants are now exported from the engines and read
by `src/editor/sword1/playback.ts` and `src/editor/sword2/playback.ts`. No
number on this surface was picked by the editor.

#### What a player is, in each family

Broken Sword needs **two resources and a script line**. `fnAnim(cdt, spr)` sets
the compact's `o_resource` to the sprite and `o_anim_resource` to the `cdt`
table; `SwordLogic`'s animation driver then reads entry `o_anim_pc` of that
table once a cycle and takes its third word as the frame. So the sprite gives
the pictures and the `cdt` table gives the **order** — a table this project did
not hold until now, and which `importSword1Project` now reads (frame column
only, unbudgeted, the same arithmetic the walk grids get). `fnAnim(cdt, 0)` is
the third case: `cdt` then names an eight-entry direction set, and all eight are
offered because which one plays is decided by the mega's heading at run time.

Broken Sword II needs **one**. A Sword II animation header carries
`noAnimFrames`, and `Sword2Logic.doAnimate` walks 0…n−1 for `fnAnim` and n−1…0
for `fnReverseAnim`. So the script's job there is only to say _whether_ the
animation is played, and in which direction.

#### The counts

|                            | Total | With a player the editor can name |
| -------------------------- | ----: | --------------------------------: |
| Broken Sword sprites       |   438 |                           **145** |
| Broken Sword II animations |   509 |                           **185** |

Measured through the production code against the two demos. What the scripts
name is much larger than what the demos hold — Sword 1's scripts name 764
distinct sprites and Sword II's objects name 1,392 distinct animation resources
— because both demos ship the full game's bytecode and a slice of its art. The
counts above are the intersection: resources this project holds _and_ a script
in it plays.

#### What is refused, and why the numbers are not larger

- **`fnMegaTableAnim` and `fnReverseMegaTableAnim`** (Sword II) are handed a
  _table_ of animations and pick one by the mega's current direction. That is
  595 of the demo's play calls, and it is the single largest reason the Sword II
  count is 185 and not most of 509. The direction is a run-time fact and this
  project will not pick one.
- **Anything pushed from a variable** is never followed, in either family —
  commit `0600015`'s rule. Previewing it would show a resource decided while the
  game runs, which is to say some other animation.
- **`fnSetFrame`, `fnFullSetFrame`, `fnStandAfterAnim`** park a single frame.
  They are not players and imply no rate, so they are not counted as one.
- A Sword 1 sprite whose `cdt` table is on a disc this install does not have has
  no order to play, and is refused the same way.

Where a resource has no player, the panel says so **in the place the button
would have been**, naming `fnMegaTableAnim` for Sword II and the missing `fnAnim`
for Sword 1, rather than offering a loop at a rate this editor invented.

The buttons are `<button>` elements, so they are keyboard-operable by being what
they are; each carries an `aria-label` naming the script that plays the frames
and the rate it implies, and the status line says how many frames are playing
and how fast.

### 27a. Sword II: an effect is measured, a line is written and unproven

Broken Sword's half of this row is Yes on all three kinds. Sword II's half is
two answers, because this family keeps a recording in two places and only one of
them is in the box.

Sword 1 keeps its recordings in three unrelated places, and an export reaches
all three. Speech is Revolution's own 16-bit RLE inside `SPEECH/COWS.MAD` (the
demo) or `SPEECH*.CLU` (retail): a replaced line is re-encoded and the container
is rebuilt around it, index patched, every other payload copied byte for byte.
Music is not a resource at all — `MUSIC/1M2.WAV` beside the install, addressed
by name (ADR 0029) — so a replaced tune is written as a file. An effect is an
ordinary cluster resource beginning `RIFF` with no Sword1 header, like a
palette, so it is substituted whole and its cluster relaid. Measured on the
demo by `npm run reexport:sword`: speech screen 0 line 1 goes 104,534 → 22,098
bytes and reads back as the 11,027 samples that were written with a worst
sample difference of 0, the other 807 lines identical; tune 1 goes 846,792 →
11,070 bytes; effect 2 (`0x06000012` in `CLUSTERS/PARIS1.CLU`) goes 31,144 →
5,556 bytes. All three are read back through the engine's own reader over the
_installed_ folder, not out of the exporter's buffer.

One layout is refused rather than written. Where two lines share a byte offset
with two different lengths — one a prefix of the other — a rebuilt container
would have to give both a single length, so `rebuildSword1Speech` throws and
names both lines instead of silently changing one. The demo's container has no
such pair: its 808 entries sit at 808 distinct offsets with no gaps and no
tail, which is why an unedited rebuild is byte-identical.

**A Sword II effect is a resource, and replacing one is measured.** `fnPlayFx`
takes a `WAV_FILE`'s id, `resource.tab` says which cluster holds it, and the
payload behind its 44-byte header is already a RIFF WAVE — so a replacement is
a payload substituted behind the header the release wrote, and the cluster is
relaid the way every other Sword II edit relays it. `npm run reexport:sword`
does it against the demo: effect 244, 20,652 samples, comes back out of the
_exported_ install through `loadStreamed` as 41,348 bytes identical to what was
written, with its header still a `WAV_FILE`.

**A Sword II line of speech or tune is not a resource at all, and that half is
written but unverified.** This page used to say the containers were clusters
`resource.inf` names, and that was wrong: ScummVM's `engines/sword2/music.cpp`
reads `speech<cd>.clu` and `music<cd>.clu` as files opened by name, and the two
layouts are mutually exclusive — a cluster's first word is the byte offset of
its own tail table, a container's first word is the number of entries in its
index. Those files hold, per entry, one byte of Revolution's delta compression
per sample: `delta = (b & 7) << ((b >> 4) & 15)` truncated to sixteen bits,
added or subtracted by bit 3, over a running 16-bit value that wraps, after a
two-byte first sample; 22,050 Hz mono; an entry whose offset and length are
both zero is a line the release never recorded.

That reader and the writer that inverts it are both here —
`src/engine/sword2/sound/sword2Clu.ts` and
`src/authoring/sword2/soundContainer.ts` — and `exportSword2Game` carries a
replaced entry through the rebuild the same way `exportSword1Game` carries
`COWS.MAD`: copy what was not touched, substitute what was, patch the index.
The editor's Audio section lists container entries beside resources, reads one
back as a decoded WAVE, and takes a replacement for one.

**What is not proven is that a retail disc reads it back, and nothing here can
prove it.** Both Broken Sword II installs this project can reach are the DOS
demo. `resource.inf` names fourteen clusters, not one of them is a speech or
music container, the folder holds five `.clu` files and all five are ordinary
resource clusters — `npm run reexport:sword` prints `containers 0 speech or
music containers beside the clusters` for exactly this reason. So the container
path has been exercised against containers this project's own writer built, and
that proves the reader and the writer agree with each other. It is "written,
not verified", and it is not to be read as anything else; the Audio section
says so on the surface, in the note above the rows.

What _could_ be measured without a container is the compression, which is the
part a container would not have told us anyway. `npm run reexport:sword` encodes
and decodes 32 of the demo's own recordings — 1,416,900 samples — and reports a
mean absolute error of 16.86 and a worst of 1,969 against a full scale of
65,536. Reported as samples and not as bytes, because eight amplitudes and
sixteen shifts cannot express every step and byte identity is the wrong
question: what matters is that the error stays bounded rather than drifting over
a long recording, which is the failure a greedy encoder measuring itself against
the sample it _wanted_ would have.

## Two of five: what a demo can and cannot show

Sword 1's Actors section draws a character from `o_walk_resource`, the sprite a
mega stands and walks in. On the demo, two of the five megas draw:

| compact                           | `o_walk_resource` | what happens                             |
| --------------------------------- | ----------------- | ---------------------------------------- |
| `0x00800000` (George, the player) | `0x04060000`      | draws, 83×151, exportable and importable |
| `0x00810000`                      | `0x04070000`      | draws, 83×151                            |
| `0x00820000`                      | `0x08020000`      | refused by name: PARIS3                  |
| `0x00830000`                      | `0x08010000`      | refused by name: PARIS3                  |
| `0x00860000`                      | `0x0c010000`      | refused by name: SYRIA                   |

That is a property of the **demo**, and the demo's own index proves it.
`swordres.rif` declares all fourteen clusters of a two-disc game whichever disc
it was read from, and looking each missing resource up in it returns a real
slot:

```
0x08010000: cluster paris3, offset 2549910, length 230339
0x08020000: cluster paris3, offset 2989932, length 275420
0x0C010000: cluster syria,  offset 2056440, length 337427
0x04060000: cluster general, offset 3178092, length 743245   (George, for comparison)
```

The folder ships COMPACTS, GENERAL, MAPS, PARIS1, SCRIPTS and TEXT. PARIS3.CLU
and SYRIA.CLU are on the disc this demo is not. A retail install has those
clusters and draws all five.

So the refusal names the cluster rather than shrugging. Each of the three panes
now says which cluster the resource lives in, that `swordres.rif` names it and
this install does not ship it, that a one-disc demo keeps it on the other disc,
and that a retail install has that cluster and this same resource with it. The
_other_ kind of absence — a resource in a cluster this install does have, which
the importer's picture budget passed over — gets a different sentence saying so,
because an author can fix that one and cannot fix the first.

## The SCI rows that need more than a cell

Numbered with an `s` so they cannot be confused with the Broken Sword notes
above, which keep their own numbers. 5s keeps its number for the same reason 7a
and 8a keep theirs: it was the No that eight other rows were recorded as
following from, three of those are Yeses with a count now, and what that No got
wrong about the other five is worth more than a tidy renumbering. Every count here is King's Quest VII's,
measured by `npm run sweep:sci -- /home/agent/games/kq7` and
`npm run reexport:sci -- /home/agent/games/kq7`, which is the only SCI release
this branch can read bytes from.

### 5s. The canvas that was missing is the room, and three of the eight rows it held down are Yes

This row was a **No** whose stated reason was that there was no `<canvas>`, no
`<img>` and no `toDataURL` anywhere in `src/editor/sci/SciEditor.ts`: artwork
was rendered in exactly one place — inside the `produce` callback of an
**Export PNG** button — and went straight into a file. Eight rows were recorded
as following from that one absence.

Three of them do, and they are Yes now. A **Rooms** section opens above
Scripts, and a room on it is drawn: the Picture its room instance names, with
every instance that declares both an `x` and a `y` property word drawn over it
at its authored position, outlined, hit-tested topmost-first, and moved by
pointer drag or by arrow key. What a move writes is that object's own two
property words, through the same `update` every other edit on this surface
goes through, so it is one entry in Undo and it is what the export carries.
ADR 0037 is the decision behind it — a room is a **view** over a Script and the
Picture it names, and not a fourth resource invented to look like a SCUMM room.

Measured by `npm run sweep:sci -- /home/agent/games/kq7`, which reports these
through `sciRoomBackdrop` and `sciRoomPieces` — the same two functions the
panel draws with, so the count is a count of what an author sees:

| On King's Quest VII                                                     |                                                                                                     |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Rooms derived — Scripts defining an instance whose chain reaches `Room` | **108** of 218 Scripts                                                                              |
| Rooms whose Picture draws                                               | **99** — 98 at 640×480 and one at 320×190                                                           |
| Rooms that draw no backdrop                                             | 9 — 7 name no Picture at all, and Pictures 2480 and 3150 are named by a room but not shipped        |
| Instances placed on those rooms                                         | **989**                                                                                             |
| Instances that draw their own cel                                       | **512** — 455 declare no View, 10 name a View this release does not ship, 12 a loop or cel it lacks |
| Instances that can be moved                                             | **989 of 989** — every one, because movability is where the words live and not what art resolves    |

The 477 with no cel are not a gap in the drawing: an instance that declared no
View inherits its class's default, and drawing View 0 for each of them would
put art on the screen the game never puts there. They are drawn as a marker,
and the table beside the canvas says of each one which of the three reasons it
is.

**What this surface shows is authored state**, and the panel says so on every
room. The property words are as the game shipped them, before the room's `init`
has run; on King's Quest VII 755 of the 989 are authored where they appear, and
3 of the 101 rooms that name a Picture have everything still at the origin —
room 30's menu buttons among them, which `init` positions. The note is
unconditional rather than shown only on those three, because a note that
appears conditionally teaches an author that its absence means something, and
here it would not.

The other five rows turn out not to have been waiting on a canvas at all:

- **8, 9, 11 and 20** were waiting on 11s. SCI keeps where-you-may-walk as a
  colour in a control plane before SCI2 and as a `Polygon` its script builds at
  run time from SCI2 on, and neither is an authored record to draw or drag.
- **14, 15, 18 and 19** were waiting on 13s and 10s: a character's pane and a
  frame strip need row 13's cast section, which is a query nobody has written;
  and painting into a Picture is 10s's problem, which the room canvas does not
  touch because it draws a Picture rather than editing one.

So the honest arithmetic is: one missing widget, from which eight rows were
said to follow; the widget is written, three of the eight are Yes with counts,
and the remaining five were leaning on 10s, 11s and 13s the whole time.

### 10s. A font and a cursor are editable pixel by pixel; a View and a Picture are not

The one artwork row that is not a flat No. `SciEditor` builds a
`div.sci-glyph-grid` of `button.sci-glyph-dot` — one button per pixel, each
carrying `aria-pressed` — for every glyph of a font and for each of a cursor's
states, and a click toggles the bit and calls `writeSciFont` or
`writeSciCursor`. On King's Quest VII that is 10 fonts and 3 cursors, and it is
a real pixel editor reached from the keyboard by being buttons.

It stops there because a glyph is one bit deep and small enough that a grid of
buttons is a reasonable widget for it. A V56 cel is up to 640×480 of 8-bit
indices, and a grid of 307,200 buttons is not an editor. That needs a paint
surface, which is a different widget from the room canvas 5s is about: the room
canvas draws a Picture and moves things over it, and nothing on it writes a
pixel.

**And a paint surface alone would be an editor that cannot save.** The second
half of this row is in `SciView.ts` rather than in the interface, and whoever
takes the row should read it first: `writeSciView` **rebuilds** a pre-V56 View
from its cels, pixels and all, and **patches a V56 View in place** — writing
back the four bytes of displacement in each cel record and nothing else.
`describeSciViewInPlace` says why: re-encoding a run-length cel body changes its
length and moves every record after it, and a V56 cel record carries scaling
fields, a compression method and two stream offsets this reader does not model,
so rebuilding one would have to invent them.

So the row splits by Version, and the split is worth having before any widget is
built:

- **Pre-V56 Views are already writable pixel by pixel.** `writeSciView` builds
  their cel bodies from `cel.pixels`, so a paint surface over those games would
  work end to end today.
- **V56 Views — SCI1.1 and every SCI32 game, King's Quest VII among them —
  need a cel encoder.** `packSci11Cel` is now that encoder: the inverse of
  `unpackSci11Cel`, choosing skip, repeat and literal runs and capping each at
  the 63 pixels six bits hold. It round-trips 17 shapes in
  `tests/sci-cel-encode.test.ts` and **319 of King's Quest VII's own cels
  exactly** — 2,757,286 pixel bytes, every one back as it went in, encoding to
  32.5% of raw.

What the encoder does **not** yet do is put the result back in the resource. A
V56 record addresses two streams by offset, so a body that re-encodes longer
than the one it replaces moves every record after it, and the record also
carries scaling fields and a compression method this reader does not model.
Patching in place is available whenever the new body fits the old space, and
that is the next step rather than a new unknown.

What a View **does** offer is its geometry: every cel's origin (`displaceX`,
`displaceY`) is a number field, written back into the cel record in place —
1,527 Views, 9,027 loops and 53,711 cels on King's Quest VII, and the loops
that are mirrors of other loops say so rather than offering fields that would
be written into the loop they mirror. A cel Picture's items likewise carry
editable `x`, `y` and `priority`: 168 Pictures, 748 items.

### 8s. A thing's walk-to point is not a room's walkable area

Row 8's No said only that "a SCI walk target is a `Polygon` a room's script
builds as it runs". That sentence is about a room's walkable **area** (11s) and
row 8 is about a different thing: **where a script sends the ego before acting
on one object**. SCI32 keeps that in two property words on the instance,
`approachX` and `approachY`, with `approachVerbs` saying which verbs use them —
the same place and the same kind of word as the `x` and `y` the canvas has
dragged since row 7.

|                                              | King's Quest VII |
| -------------------------------------------- | ---------------: |
| things placed on a room                      |              989 |
| that declare a walk-to point                 |              929 |
| of those, points that are not 0, 0           |              345 |
| of those, points this project can write back |              929 |

**Null and "the point is 0, 0" are different facts**, and the table keeps them
apart because 345 of the 929 really are somewhere and the rest really are the
origin. An object declaring neither word gets an em dash and a reason, not a
zero in a box.

**Drawn on the selected thing only**, as a ring rather than a cross. A room
where every Feature showed one would be a field of marks over the artwork, and
the ring is deliberately not the cross that marks the thing's own anchor: the
two are different points and are often far apart — one is where the thing _is_,
the other where the ego is sent.

It does **not** follow the box when the thing is dragged, which is the same
answer Sword II's 8a gives and for a sharper reason here: the two are
independent property words, and moving one because the other moved would rewrite
a number the author did not name.

### 11s. A SCI walkable area is not a resource, and one of its two halves is still in the script

Sword 1 and Sword II keep routing in a **walk-grid resource** that a table or a
script names, which is what made row 11 a Yes for both. SCI keeps it in two
places and neither is a record this project could list. One of the two is now
read anyway.

- **Before SCI2**, the walkable area is a _colour_, and this is still a No. A
  Picture is drawn into three buffers at once — visual, priority and
  **control** — and the control buffer's colour index at a pixel is what
  `kCanBeHere` tests. The walkable area is not stored as an area at all; it is
  a property of the pixels, and editing it means painting the control plane,
  which needs the paint surface 10s is about plus a way to show a plane that
  was never meant to be looked at. The room canvas draws the _visual_ buffer,
  and the walkable area is not in it.
- **From SCI2**, rooms add `Polygon` objects, and a polygon is built by the
  room's own code as it runs. That was read as "cannot be read" and it is the
  same shape as Broken Sword II's mouse boxes (7a): **the object pushes the
  answer itself, as literals, in the instruction stream this project already
  decodes.**

King's Quest VII's `pyramidDoor` is the plainest case:

```
pushi setPolygon  push1
  pushi type      push1  push0        ; type: 0
  pushi init      pushi 8             ; init: with eight arguments
    pushi 876  pushi 79
    pushi 875  pushi 29
    pushi 920  pushi 27
    pushi 919  pushi 82               ; four points
  pushi yourself  push0
  pushi new       push0
  class 34                            ; the Polygon class
  send 4                              ; (Polygon new:)
  send 30                             ; type:, init:, yourself:
```

**Read backwards from the `class`, never by searching for a selector.** A
selector number and a coordinate are the same kind of word, so a search for
`pushi <init>` finds the _point_ whose x happens to equal `init`'s number before
it finds the send — a three-point polygon whose first coordinate is 1, in a game
where `init` is selector 1, read as a one-point one. The block's shape is fixed,
so walking back over it cannot make that mistake, and the `pushi <2n>` that
closes the coordinate run is confirmed against the run's own length.

|                                              | King's Quest VII |
| -------------------------------------------- | ---------------: |
| walk polygons read from literals             |              395 |
| points, every one of them an editable number |            3,891 |
| Script resources that hold at least one      |               65 |
| polygons refused by name                     |               43 |

By kind: 190 total access, 12 nearest access, 93 barred, 100 contained. The
kinds are **named on the panel and not numbered**, because a barred polygon is a
hole in the floor and a total-access one is the floor, and "type 2" says
neither.

**What an author can do**, and where the two halves of it live. The room canvas
draws every polygon under the cast, coloured by kind, with a node at each point.
A **Walk areas** panel under it holds a number field per coordinate, and an edit
writes the **instruction's own operand** — the same word row 21 edits, through
the same linker, with row 22's guarantee unchanged. The canvas draws and does
not drag, and the panel says so: a drag would have to decide which of several
overlapping polygons a click meant and which point of it, and two number fields
need neither decision nor a pointer (row 32).

**A panoramic room's polygons run off the canvas, and that is not hidden.** The
canvas draws the single Picture a room instance names, and a room whose scenery
is several Pictures placed side by side has a script space wider than that one —
King's Quest VII's room 1100 has points at x 894, which is past the right-hand
edge of the 640-pixel Picture drawn under them. Those points are clipped by the
canvas and their numbers are still in the panel, which is where they can be
changed. Drawing the whole panorama is what row 5 would need for the same
rooms, and neither has been done.

**The 43 refusals are by name**, in two kinds: a polygon whose coordinates are
computed rather than written (there is no number in the script to change, which
is 7a's rule in SCI's terms), and a polygon built some way other than this
block. `featureCheck` and `debugHandler` are Sierra's own debugging code and are
most of them.

Row 9 stays a No, for a smaller reason that has not changed: there is no grid in
SCI at all, at any Version.

### 12s. Nothing is appended or deleted, and the arithmetic is not the Swords'

`+ Room` has no SCI equivalent on this surface. Unlike 12a, the reason is not
that an index is a name: a SCI resource is addressed by `(type, number)` in the
map, and a new Script resource could take an unused number without renumbering
anything. What stops it is that a Script resource is not a blank that can be
filled in — a new room needs a `Room` subclass, a method dictionary, a property
table and an entry in `vocab.996`'s class table, and the linker that would lay
those out is the one that refuses every SCI1.1 and SCI3 script already (22s).

So this is a No that follows the linker, not a No about the format. It is
recorded that way rather than as "SCI cannot".

### 13s. A SCI game has no cast table, so the cast is a question put to the class graph

Row 13's Yes in the other three families comes from a table: SCUMM has actors,
a Sword 1 compact declares `o_type` `MEGA`, a Sword II object calls a mega
opcode. SCI has none of those. What plays an actor is **class membership** —
an object whose superclass chain reaches `Actor` — and King's Quest VII's 2,821
objects across 158 classes include every prop, every door, every sound and
every inventory item alongside them.

Reaching the cast is therefore a walk up `-super-` through `vocab.996`, which
this project already does: `nameInstanceProperties` walks exactly that chain to
name 96,384 property words. This row was recorded as "a **No that is one query
away**"; `sciCast` is that query, and the row is a Yes.

**147 on King's Quest VII**, and the first two are `rosella` and `valenice` —
the game's two protagonists — which is the check that the derivation found
people rather than props. The header says which classes the answer came
through, so a reader can see why a row is in the section at all.

**Matched by class name, never by species number.** `Actor` is species 2 in one
release and something else in the next, so a number here would be a per-title
table — the thing `CONTEXT.md` says a SCI Target should not need, since the game
ships `vocab.996` and its own names. The consequence is stated rather than
hidden: a release whose classes are unnamed yields **no** cast, and the section
header says that is why, because "this game has no actors" and "this project
cannot tell" are different facts and an empty list looks identical for both.

A member opens a **pane of their own**, with the Script they are defined in one
button away — ADR 0037's point one layer down: a SCI cast member is an object in
a Script seen as a character, and both halves of that sentence are reachable.

### 14s. What a cast member wears, from three property words and no guessing

Row 14 was a No that followed row 13 — "this is a _character's_ pane, and there
is no cast section to hang one on". The cast section exists, so the No was only
ever about the pane not being written.

A SCI instance carries `view`, `loop` and `cel` as three property words, and a
`cycleSpeed` where it declares one. The pane draws what those say and nothing
else. On King's Quest VII:

| Of the 147 cast                                                  |     |
| ---------------------------------------------------------------- | --: |
| draw the View their own `view` word names                        | 117 |
| ship 65535, SCI's own "no View"                                  |  18 |
| ship 0, the class default of an instance that never declared one |   2 |
| name a View this release does not ship                           |  10 |

**The 30 are refused by name on the pane**, in the sentence that says which of
the four cases they are, because an empty pane and "this release names no
artwork for them" are different facts and must not look alike. The 18 and the 2
are ordinary SCI: a room commonly dresses its actors in `init`, and the shipped
default is what an author can edit and an export can write back — the same thing
the room canvas already says about positions (5s).

The 10 are a fact about this install rather than about the reader: Views 1,
4350, 6600, 6800 and 6900 are named by `rosella`, `myBoogeyMan`, `edAndRose`,
`edger`, `graham` and `valenice`, and `resources.read('view', n)` answers absent
for every one of them. They are placeholders the shipped scripts kept.

All 117 that draw carry a `cycleSpeed` of their own, which is what row 18 plays
them at.

### 15s. A frame strip, and the speed it is played at

Rows 15 and 18 were two Noes for one reason, and the reason was not a fact about
SCI: **nothing on this surface ever drew a frame.** Every kind of artwork left it
as a PNG (row 16) and none of it appeared in the pane, so there was no frame to
pick and nothing to step.

`SciCelStrip` is one widget on two panes — the View pane and a cast member's —
because a View is the only animated thing SCI ships and a cast member is a View
seen as a person. A loop picker, one radio per cel of that loop, the cel drawn
on a checkerboard so its transparent pixels read as transparent, and a Play
button. It is a radio group with a roving tabstop, which is what keeps a
1,000-cel View one tab stop rather than a thousand (row 32).

Over King's Quest VII: **1,527 Views, 9,027 loops, 53,711 cels**, and **3,885 of
those loops hold more than one cel** — which is the number row 18 is really
about, since a one-cel loop has nothing to play and the button says so rather
than starting a timer that redraws the same pixels.

**A SCI View carries no frame rate, and the panel says so.** What an animation
runs at is the `cycleSpeed` the _instance_ is given, in the interpreter's own
60-a-second cycles; a View on its own has no rate at all. So a cast member's
pane plays at that instance's own number and names it, and a View opened from
the Views section plays at SCI's default of one cel a cycle and names _that_.
Neither is invented, and the label always says which of the two is running —
the same rule the View pane's export note follows about colours.

What this does **not** add is a pixel editor for a cel. 10s still stands: a V56
cel is up to 640x480 of 8-bit indices and a grid of 307,200 buttons is not an
editor. Drawing a frame and painting into one are different capabilities, and
rows 10 and 19 are still No.

### 17s. A PNG comes back in where there is an encoder for it, and nowhere else

Row 17 was a single No, and the note under it said the two halves were a
different size. They were, and the smaller half is done.

**A font glyph and a cursor take an import.** `writeSciFont` and
`writeSciCursor` are what the pixel grids already call, so the only thing
between them and a PNG was a picker — one on the glyph pane and one on the
cursor pane, quantising through the same `quantise` the other three families
import with. "Quantised to the game's colours" means two of them here: a SCI
glyph is one bit deep, and a cursor is black, white and the transparency the
pointer shows the room through. **The cursor's transparency is read from the
source's own alpha and not from the index it quantised to**, because index 0 is
_black_ — a reader that took the index for transparency would punch a hole
through every black pixel of the pointer.

**A SCI0 or SCI1 View cel takes one too**, and that was already true of the
writer before this branch: `writeSciView` rebuilds an EGA or VGA View from its
cels and `writeSciCelPixels` re-encodes the run-length body from the pixels. So
the import button appears on the cel the frame strip is showing, quantised
against the same colours the export note names.

**A V56 cel does not, and the reason is not a decision.** `writeSciView`
patches `displaceX` and `displaceY` in place and **does not re-encode a V56
body at all** — a cel there is two run-length streams whose length would change,
and every record after it points at a fixed offset. So the import button is
behind exactly the sentence `describeSciViewInPlace` already puts on the panel,
and a V56 View grows none: a button that wrote a cel back unencoded would be
worse than the No it replaced. Both kinds of Picture are the same case.

King's Quest VII is a V56 release, so **none of its 53,711 cels takes an import
and all of its 10 fonts and 3 cursors do.** The older half of the family is the
other way round, which is the second time this page has had to say that the
block-chain Versions are better off than the SCI32 ones (22s is the first).

So the row is: fonts and cursors everywhere, View cels where there is an
encoder, and no Picture. That is the same shape as row 10, and the same reason
— this project can write the formats it has encoders for, and says which.

### 22s. Same length only — for SCI3 now, and no longer for the family

The round trip for a SCI method body has two answers and they are decided by
the script's **layout**, not by what an author types:

- A script with a SCI0 block chain is relaid out by `linkSciScript`: bodies may
  grow or shrink, the dispatch tables, the export table and the relocation list
  are all rewritten.
- A **SCI1.1 heap pair** is relaid out by `linkSci11Script`, which is new: a
  body may grow or shrink, and the method dictionaries, the export table's
  procedure entries, the relocation table's positions and — the half that is
  easy to miss — the **heap's** `-propDict-` and `-methDict-` words all move
  with it.
- A **SCI3 script** is still refused by both, so a body there may be changed
  but not lengthened or shortened. An equal-length edit goes through
  `rewriteInPlace` and is written over the original bytes.

Every SCI release from 1992 on used to be in the refused group, King's Quest
VII's 218 scripts included; SCI3's handful is what is left. That refusal used
to arrive at **Apply**, after the method had been retyped;
`describeSciRelinking` says it on the method panel when the method is opened,
which is what row 22 actually asks for.

**The SCI1.1 linker is held to two gates, because the first alone proves less
than it looks.** A no-edit relink must be byte-identical — 218 of King's Quest
VII's 218 scripts and 3,929 of 3,929 methods are, which proves `emitSciMethod`
round-trips every body and nothing else, since with no length change the linker
writes bodies where they already are. The second gate lengthens a body so every
byte after it moves, and demands every _untouched_ method still decode to
exactly the instructions it did before: 58 of 58 scripts.

The second gate is what caught the real fault. An object's `-propDict-` and
`-methDict-` are **code** offsets held in the **heap**, and a first round of
checking read the dictionary's position from the project's own copy — which is
right whether or not the heap was written — and so passed while every object
pointed at where its dictionary used to be.

**SCI3 is what is left**, and it is a smaller piece than the pair was: its code,
strings and relocations sit behind a fixed 22-byte header that neither linker
reads.

**Its bodies are decompiled now, which they were not.** Row 21 used to be a No
for SCI3 alone, for one reason: the importer read SCI3 objects and their
property words and emitted `methods: []`. SCI3 keeps no method dictionary — a
16-byte object header is followed by a **256-byte selector bank**, one byte per
group of 32 selectors holding a one-based index into the 64-byte groups after
it, where a set bit in the group's type mask makes a word a property and a
clear one makes it a method's offset, measured from the code rather than from
the resource. `readSci3Methods` reads it, and the bodies come out.

That is **Tier 1 and stays there**: the reader and the fixture it is held
against are transcribed from the same source, so they prove the documented
shape is implemented and read back, not that a Sierra SCI3 release matches it.
Lighthouse, RAMA or Phantasmagoria 2 would settle it and nothing short of one
will.

### 23s. King's Quest VII ships no Messages, and that is a fact about the release

The Messages section is real and editable, and King's Quest VII has **0** rows
in it and one language. Its words are in its audio and in its Views, not in a
`MESSAGE` resource — the surface says so in the column ("Wording baked into
Views and Pictures is artwork, and is not reachable from here") rather than
showing an empty section and letting it read as a missing reader.

So row 23's Yes for SCI is carried by `tests/sci-messages.test.ts` and by the
synthetic fixture, at Tier 1, and not by a count from a mounted game. A SCI1.1
release that ships `MESSAGE` resources would populate it; none is mounted here.

### 25s. The half of a SCI game that is not code

This row was a **No** for SCI until this branch, and the reason it was a No is
worth keeping: the panel said "56 properties" and showed none of them.

A SCI object's properties are its state — the view an actor wears, the room a
door leads to, the priority a prop draws at, the x and y it starts at — and
they are the half of the class graph that is not instructions. Broken Sword's
compacts have been editable word by word since that surface existed; this is
the same capability in SCI's own terms, and the terms differ in one way worth
saying: a word here has a **name**, because a SCI class carries a Selector
table for its properties and a compact carries nothing.

|                                          | King's Quest VII |
| ---------------------------------------- | ---------------: |
| objects with an editable property table  |            2,821 |
| property words, every one of them named  |           96,384 |
| script 0's locals, which are the globals |              401 |
| locals over all 218 scripts              |            1,560 |

**No linker is involved and none is needed.** An object's size is a word in its
own header, a property is two bytes in a fixed place, and nothing an author can
do here moves either — which is exactly why this writes back for every Version
while a method body that changed length still writes back for none of the heap
layouts (22s).

Where the word goes is the part that had to be right, and it is not the same
place at every Version. Before SCI1.1 the objects are blocks inside the Script
resource; from SCI1.1 they are in the **heap** resource beside it and the code
resource must come back untouched; SCI3 puts them back in the Script resource
again. The reader records which, per object, and the writer follows it —
`tests/sci-heap-scripts.test.ts` asserts that a changed property moves exactly
two bytes of the heap and none of the code.

A value that does not fit in sixteen bits is refused on the field and the field
put back, rather than being truncated into a number the author did not type.

### 31s. Play runs, and what it reaches is four screens in

Row 31 is a Yes in the sense the other three columns mean it: the SCI arm of
`familySurface()` has a `play`, it packs the project through `packSciGame` and
runs the install underneath the open folder, and it is the same button.

What that install does when it runs is part one of this branch's report and not
this page's subject, but the row should not be read as more than it says: King's
Quest VII boots, loads all 218 scripts, reaches **room 15, the Sierra logo**, and
plays it through to its **main menu** (room 30) on no input. Clicks take it four
screens further — the **"Name Your Game" on-screen keyboard** (room 20), that
room's **chapter selector**, the **chapter-one title card** (room 35) and, past
its Continue button, **the desert that is the game's first room** (room 1250),
drawn in its own art with Rosella standing in it. Nothing past that first room
has been reached, no puzzle has been solved, and none of it is Tier 2: it is a
command's reading, not a person's.
`/home/agent/reports/kq7-playable-and-editable.md` has the measurements and the
faults behind them.

### 34s. Where a script puts a character, in two places and neither is a table

Sword 1 answers this row from `SWORD.EXE`'s 52 start positions (33a). SCI has
no such table and does not need one, because a SCI actor's position is reachable
two ways and both of them are now editable:

- **As a property.** An instance of `Actor` or `Prop` carries its own `x` and
  `y` (and `z`, and `posn`-adjacent words) as property words, named from its
  class's Selector table, and row 25 edits them.
- **As an operand.** A room's `init` typically does `(theActor posn: 140 90)`,
  which is two `pushi` operands in a method body, and row 21 edits those in
  place — an equal-length edit, so it writes back under 22s for every Version.

Since the Rooms section there is also somewhere to **see** the first of those
two: an instance's `x` and `y` are what the room canvas draws it at, and
dragging it is the same edit to the same two words arrived at from the other
end. The second stays a number — an operand inside `init` is a placement the
canvas cannot show, because the canvas draws authored property words and not
what a method would do to them (5s).

## Row by row, Version by Version

The SCI column above is King's Quest VII's, which is SCI2.1 middle. The family
is eight Versions across four resource layouts, and what differs between them
is exactly the thing most of these rows depend on. This table says which rows
are answered by a **measurement against real bytes** and which by a **Tier 1
synthetic fixture**, using `docs/processes/verifying-version-support.md`'s
tiers.

| Version         | Script layout    | Rows measured against real bytes | Rows at Tier 1 only                     | Rows that differ from the column above                                                                                                                                                    |
| --------------- | ---------------- | -------------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SCI0 early      | block chain      | none — no game mounted           | 5, 6, 7, 14, 15, 17, 18, 21, 22, 25, 30 | 22 is a **fuller Yes**: the linker reaches these scripts, so a body may change length. 11 is a **No**: a walkable area before SCI2 is a colour in the control buffer, not a Polygon (11s) |
| SCI0 late       | block chain      | none — no game mounted           | 5, 6, 7, 14, 15, 17, 18, 21, 22, 25, 30 | as SCI0 early                                                                                                                                                                             |
| SCI1 early      | block chain      | none — no game mounted           | 5, 6, 7, 14, 15, 17, 18, 21, 22, 25, 30 | as SCI0 early                                                                                                                                                                             |
| SCI1 late       | block chain      | none — no game mounted           | 5, 6, 7, 14, 15, 17, 18, 21, 22, 25, 30 | as SCI0 early                                                                                                                                                                             |
| SCI1.1          | code + heap pair | none — no game mounted           | 5, 6, 7, 14, 15, 17, 18, 21, 22, 25, 30 | 23 may be a **counted** Yes: SCI1.1 is where `MESSAGE` resources begin; 11 is still a **No**, as for every Version before SCI2                                                            |
| SCI2            | code + heap pair | none — no game mounted           | 5, 6, 7, 14, 15, 17, 18, 21, 22, 25, 30 | as the column above                                                                                                                                                                       |
| SCI2.1 (middle) | code + heap pair | **1–34, as measured above**      | —                                       | this is the column above (King's Quest VII)                                                                                                                                               |
| SCI3            | SCI3 layout      | none — no game mounted           | 5, 6, 7, 14, 15, 17, 18, 21, 25, 30     | 22 is **same-length only**: the SCI1.1 linker does not reach a SCI3 layout (22s)                                                                                                          |

Five things that table is saying, which are worth saying in words:

1. **Only one SCI release is mounted on this branch.** Every row in the SCI
   column is King's Quest VII's or is a Tier 1 fixture's. Nothing here is a
   claim about King's Quest IV or Gabriel Knight, and the four fixtures in
   `tests/fixtureSci.ts` — SCI0, SCI1.1, SCI2/2.1 and SCI3 — are what carries
   the rows across the family.
2. **The block-chain Versions are better off on row 22 and worse off on row 23.** `linkSciScript` reaches SCI0 and SCI1 scripts and refuses everything
   from SCI1.1 on, so the oldest games are the ones where a method body may
   change length. That is the opposite of the usual direction and is why the
   Version breakdown exists.
3. **SCI3 is the one Version where a row in the column above is weaker, and it
   is row 22 rather than row 21.** Its importer used to emit `methods: []`,
   which made row 21 a No there; `readSci3Methods` reads the 256-byte selector
   bank and the bodies come out, so row 21 holds at every Version. What is
   still narrower is row 22: neither linker reaches a SCI3 layout, so a body
   there may be changed and not lengthened (22s).
4. **Rows 14, 15, 17 and 18 cross the family the same way rows 5 to 7 do, and
   for a sharper reason.** All four read a **View**, a **font** or a **cursor**,
   and those three resource formats are the ones that barely drift across the
   family — `readSciView` takes EGA, VGA and V56 through one reader, and
   `readSciFont` and `readSciCursor` take every release this project has seen.
   So a frame strip, a playback, a cast member's art and a PNG import are
   answered by the resource rather than by the Version. Row 14 is the one with
   a real Version-shaped caveat and it is not about the format: the cast is
   derived by **class name** through `vocab.996`, so a release whose classes
   are unnamed yields no cast and therefore no pane (13s).
5. **Rows 5, 6 and 7 cross the family by construction, and that is a claim
   about the derivation and not about a game.** `sciRooms` reads the authored
   `SciProject` and never a resource, so the four layouts reach it having
   already been flattened by `importSciGame`; `tests/sci-rooms.test.ts` holds
   that at Tier 1 for SCI1.1, for SCI3 with every `methods: []`, and for SCI0
   early, whose Selector ids are doubled and whose rooms place nothing at all
   if that is read raw. What is **not** measured anywhere is whether a real
   SCI0 or SCI1 release names its room class `Room` or `Rm` and its position
   properties `x` and `y`. Those two names are what the derivation matches on,
   they are the names King's Quest VII uses, and a release that used others
   would derive zero rooms rather than wrong ones. Mounting one SCI16 game is
   what would turn that from an assumption into a row.

## Where the SCI rows are measured

- `npm run sweep:sci -- /path/to/game` — scripts, objects, methods,
  instructions, Views, Pictures and the per-format counts quoted above, and
  the room counts in 5s: rooms derived, backdrops drawn and at what size,
  instances placed, instances that draw a cel and why the rest do not, and
  instances that can be moved. It reports those through `sciRoomBackdrop` and
  `sciRoomPieces`, which are the panel's own two functions, so the numbers on
  this page are the numbers on the screen.
- `tests/sci-rooms.test.ts` — the room derivation and the canvas, including
  the three Versions 5s's rows are held at Tier 1 by.
- `tests/sci-polygons.test.ts` — the walk-polygon derivation, including the
  backwards read that a selector-number search gets wrong, and the refusals.
- `npm run rooms:sci -- /path/to/game --fresh` — every room the game declares,
  entered by `newRoom` on a freshly booted engine and run for four seconds, with
  how much of the framebuffer each one lit and how many colours it holds. On
  King's Quest VII: 108 asked for, 104 entered, 4 sent elsewhere; of the 104, 93
  drew. That is row 31's evidence and not row 5's — row 5 is the **editor**
  drawing a room's Picture, and this is the **engine** running a room's own
  `init`.

  Both numbers per room and not one, because each flatters the engine on its
  own: a chapter card is meant to be mostly black, and a room filled with one
  flat colour is 100% lit and has drawn nothing. Seven of King's Quest VII's
  are exactly that, and an earlier rule counted every one of them as a room
  that drew.

- `npm run reexport:sci -- /path/to/game` — byte-identity of an unedited
  export, and the packed install being read back as one.
- `tests/sci-editor-surface.test.ts` — the surfaces, the accordion, the
  property and locals tables, and the refusal sentences in this page.
- `tests/sci-heap-scripts.test.ts`, `tests/sci-editing.test.ts` — the round
  trip for a property and a local, in both places a SCI object can live.

## Where this is measured

- `npm run sweep:sword -- /path/to/game` — the per-format counts quoted above.
- `npm run reexport:sword -- /path/to/game` — byte-identity of an unedited
  export, and an edited one booting. The edits it makes are a script word, a
  picture pixel, and — for Sword 1 — a line of speech, a tune and an effect,
  each read back out of the installed folder.
- `tests/sword-editor.test.ts` — the surfaces, including every refusal sentence
  in this page.
