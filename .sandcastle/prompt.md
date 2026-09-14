<!--
  This file is the **worked example**, and it is what a run reads when no
  `prompt-<name>.md` is beside it. It is a real prompt rather than a skeleton:
  the job below was measured on the host and launched from a copy of this file.

  To write your own: copy this to `.sandcastle/prompt-<name>.md` (gitignored),
  delete this comment, and replace every measurement with one you took today.
  `docs/processes/running-sandcastle.md` — "What the worked runs taught" — is
  why each section below is shaped the way it is. The short version:

    1. Lead with measurements, not a task list.
    2. Name the one mistake behind several symptoms, where there is one.
    3. Hand over a named queue rather than a mystery.
    4. Say what an improvement is not allowed to claim.
    5. Mark an open question as a question, not a task.
-->

# Context

This repository is MGI, a from-scratch interpreter and editor for several
classic adventure engine families. This run is about the **AGOS** editing
surface — Simon the Sorcerer 1 and 2 — and about one reported complaint:
nothing in it can be downloaded.

Read these before you change anything. They fix the vocabulary and the rules,
and using the wrong word for a thing is a review comment every time:

- `CONTEXT.md` — Engine family, Engine, Script engine, Target, and in
  particular **Preserved bytes** and **Unrecovered**
- `docs/architectural-decision-record/` — decisions already taken. **ADR 0034**
  (art lives beside the game, so the editor asks for the folder) and **ADR
  0030** (the Project records intent, not a copy of the game) are the two this
  job turns on. Do not re-litigate one and do not contradict one silently.

Recent commits:

!`git log --oneline -10`

Game data mounted read-only for this run:

!`ls -d /home/agent/games/*/ 2>/dev/null || echo 'none mounted'`

**Never commit game data**, and never read a game from anywhere but a mount or
a folder a fetch hook wrote. If no Simon data is mounted, `--setup=freeware`
fetches the freely redistributable Simon 1 DOS demo, and the report has to say
on every row which of the two it was measuring — a demo is a weaker claim than
a retail copy and the numbers below came from retail copies.

# What was measured, on the host, before this run

Four symptoms were reported: Rooms shows a room image with no way to save it,
Art and Items download nothing, and Audio is empty. Three of the four are one
mistake, and the fourth is a separate hard-coded `[]`.

## The one mistake: a download is treated as something the Project contains

AGOS art and audio live **beside** the game, not in the Project (ADR 0034) —
which is why the Art tab reads pixels through the opened folder handle and why
`toEditableGame` records an `origin` rather than the bytes. The Art tab already
works this way. Rooms, Items and Audio were never given the same route, so each
has a picture or a list on screen and no file behind it.

## Art — the one download that exists is cancelled before it starts

`AgosEditor.doExportImage` (`src/editor/agos/AgosEditor.ts:2592`) ends:

```ts
const url = URL.createObjectURL(blob);
const link = document.createElement('a');
link.href = url;
link.download = name;
link.click();
URL.revokeObjectURL(url); // ← same tick
```

The link is never put in the document and the object URL is revoked in the same
tick. `downloadBlob` in `src/editor/storage.ts:158` does both correctly and
carries the comment that says why — *"Revoking immediately can cancel the
download in some browsers"* (`storage.ts:167`). **This is the literal reason
Art downloads nothing.** Use `downloadBlob`; do not write a fourth copy of this
five-line dance.

Two more faults ride along on the same method, and both only become visible
once the download works:

- **It exports greyscale.** It writes `index * 255 / 15` into r, g *and* b,
  ignoring `paletteFor(zone)` — the palette the on-screen canvas is already
  using. Measured over 400 sampled images per game:

  | Game    | Palette entries that are not grey | Mean worst-channel error | Peak |
  | ------- | --------------------------------- | ------------------------ | ---- |
  | Simon 1 | 5,606 of 6,384                    | 214.6 of 255             | 247  |
  | Simon 2 | 6,356 of 6,400                    | 254.0 of 255             | 255  |

- **It is inert unless an image is selected.** With a zone selected it alerts
  "Pick an image from the list in the right column" — and it lives on the art
  *toolbar*, not where the reporter looked.

## Rooms — 145 backdrops that paint, 0 that can be saved

`renderRoom` (`AgosEditor.ts:937`) already renders the backdrop and hands
`roomBackdropUrl(drawn)` to an `<img>`. Nothing offers it as a file.

| Game    | Rooms | Paint a backdrop | Name no picture | Refused | Widest |
| ------- | ----- | ---------------- | --------------- | ------- | ------ |
| Simon 1 | 92    | 90               | 0               | 2       | 320px  |
| Simon 2 | 67    | 55               | 2               | 10      | 640px  |

A backdrop is read-only by nature — it is composed by a script, so there is no
single resource a paint could be written back to (`roomBackdrop.ts` says so).
Saving one is therefore the *only* thing this surface can offer for a room.

## Items — no export exists at all

`inspectItem` (`AgosEditor.ts:1980`) has no download of any kind.

## Audio — the section is wired to an array that is always empty

`AgosEngine.toEditableGame` builds the Project with a literal `audio: []`
(`src/engine/agos/AgosEngine.ts`, in the returned `project`). The section
itself is fine — it is the shell's `AudioSection`, the same one SCUMM uses.

The readers the engine already uses find plenty to list:

| Game    | Speech file  | Speech entries | Effects                        | Music              |
| ------- | ------------ | -------------- | ------------------------------ | ------------------ |
| Simon 1 | `SIMON.mp3`  | 3,624 (47.7MB) | 3,413 across 28 `SFXXXX*` banks | 36 in the archive |
| Simon 2 | `SIMON2.mp3` | 11,998 (69.2MB)| in the archive at base 1660/4   | in the archive     |

`readSpeechIndex` (`sound/speech.ts`), `readEffectsIndex` (`sound/effects.ts`)
and the archive bases in `agosVersion.ts` are all already there and already
used by the running engine.

**Do not copy SCUMM's `importSounds` shape.** `src/authoring/importGame.ts`
inlines sound bytes into the Project under a 24 MB `SOUND_IMPORT_BUDGET`, and
both speech files here exceed it on their own — 47.7 MB and 69.2 MB. A Project
that swallowed them would not survive being autosaved. This is the same ADR
0034 fact as the rest of the job: **list what is there, read bytes from the
folder on demand.**

# Task

Four pieces, in this order. Each is a commit.

1. **Fix the download mechanism.** Route `doExportImage` through
   `downloadBlob`, and give it the zone's palette instead of the greyscale
   ramp. This alone makes Art work.
2. **Put a download at the top of the right-hand column**, where the reporter
   looked and where the SCUMM editor puts one. The folder bar
   (`renderFolderBar`) is currently first; the download belongs with it, above
   the per-selection properties, and it should say what it will save and be
   disabled with a reason when there is nothing to save.
3. **Give Rooms and Items something to save.** A room saves its backdrop as
   rendered — the `RoomBackdrop` already carries pixels and palette. Decide
   what an item's file is from what the game actually has; if the honest answer
   is that an item has no artwork of its own, **say so in the UI and in the
   report rather than inventing one**.
4. **Fill the Audio section.** List the game's speech, effects and music as
   entries with their own numbers, reading bytes from the folder when one is
   played or saved rather than inlining them into the Project.

## What this is not allowed to claim

- **Do not put game bytes in the Project.** ADR 0030 and the budget above.
- **Do not claim a game or a Version is supported.** That claim has a process
  and it is `docs/processes/verifying-version-support.md`.
- If a piece turns out to be wrong-headed once you are in the code, **stop and
  report that as the result** with what you found. A wrong fix shipped is worse
  than a piece reported as refused.

## One open question, which is a question and not a task

Piece 3's item artwork. Simon 2 blits inventory icons from a loose `ICON.DAT`
(`src/engine/agos/gfx/icons.ts`, `decompressIcon`), and Simon 1 ships an
`ICON.DAT` too — but nothing here has established that an *item number* maps to
an icon index, and guessing produces a download that hands an author the wrong
picture with no way to tell. Either establish the mapping against
`/home/agent/scummvm` if it is mounted, or leave items without an image export
and say in the report that the mapping is unestablished. **Do not ship a guess.**

# Gates

These all have to pass before you commit:

    npm run format:check
    npm run lint
    npm run typecheck
    npm test
    npm run build

Report failures with the output rather than describing them.

Add tests for what you change. The editor surface is testable without a
browser — see the existing tests under `tests/` for how an AGOS surface is
exercised.

Commit with [Conventional Commits](https://www.conventionalcommits.org) —
`fix:`, `feat:`, `docs:` — because semantic-release reads the messages to
decide the next version. One commit per coherent change.

# Open the pull request yourself

When the work is committed and every gate passes, merge `main` in, push, and
open the pull request with `gh`. Title it as the change, and write a body that
says what was measured before, what each commit does, and what is still open.
End it with the attribution line this repository uses.

If the merge, the push or the `gh` call fails, **say so in the report with the
error** and finish anyway — an unpushed branch is still on disk, and a run that
dies trying to open a review has thrown away the work it did. If a conflict is
genuinely beyond you, leave the merge uncommitted, say which files and why, and
push the branch without it rather than committing a resolution you do not
believe.

# What to write, and where

Write the report to **`/home/agent/reports/<this run's name>.md`**.

That path is a writable mount outside the workspace. Nothing under
`/home/agent/workspace` survives an iteration boundary — an early run learned
that by writing its report into the worktree, finishing the work, and losing
the file when a second iteration rebuilt the tree.

The report contains, in this order:

1. A table with one row per piece: `Piece | Before | After | Evidence`. Put
   actual numbers in it. A number is the evidence; "works" is not.
2. A paragraph per piece that did not come out clean, quoting the command and
   the output.
3. A section headed `What this run cannot establish`, naming anything left
   unmeasured — the item-icon mapping above, if it stayed unestablished, and
   the fact that no test here proves a browser actually saves a file.

# Done

When all four pieces are through, the gates pass, the pull request is open and
the report is written, **the last thing in your final message must be the line**

<promise>COMPLETE</promise>

That tag is what ends the run. A summary without it starts another iteration,
which rebuilds the worktree and repeats the whole job.
