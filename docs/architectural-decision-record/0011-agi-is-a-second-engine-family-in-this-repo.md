# AGI is a second engine family in this repo, behind a narrow host interface

Sierra's AGI shares nothing with SCUMM — not the bytecode, not the resource
layout, not the renderer. It is a second Engine family, not a wider Version
range. Two questions follow: where does it live, and what do the two families
share.

## It lives here, and the repo keeps its name

AGI goes in this repository rather than a sibling one. A separate repo would
give cleaner boundaries and a truthful name, at the price of two deploys, two
issue trackers and a published-package seam between the shell and the engines —
paid permanently, to avoid a naming embarrassment paid once.

So the package stays `scumm-web` and the repo stays `adrianeyre/scumm`. The name
becomes historical rather than descriptive, which is a thing software names do.
Renaming is still available later and gets no cheaper or dearer by waiting; what
would have been expensive is discovering mid-way that the two engines needed to
share more than a package boundary allows.

> **Superseded on this point.** The rename was taken later: the repo is now
> `adrianeyre/multi-game-interpreter`, the package `mgi-web`, and the app is
> branded MGI — _Multi Game Interpreter_. The reasoning above still holds for
> _where_ AGI lives — one repository, one deploy, one issue tracker — which is
> what this ADR was actually deciding. Only the naming clause is out of date.

`CONTEXT.md` is where the vocabulary stops assuming SCUMM: **Engine family** is
new, **Engine** is no longer a synonym for `ScummEngine`, and **Version** is now
only ever read inside a family, because AGI v3 and SCUMM v3 are unrelated
engines and a bare "v3" names both.

## The seam is the host surface, not the script surface

The obvious reading — that `ScummEngine` must give up everything
version-specific it owns — is wrong, and the code says so. Of `ScummEngine`'s
~110 methods, all but about twenty exist for `ScriptEngine` to call. Those stay
exactly where they are; a second family never touches them.

What both families do face is the shell: `src/main.ts` loads files, lists the
`games/` folder, tracks progress, takes consent, drives a fixed-step loop and
owns saving. It reaches the engine through roughly twenty members — `create`,
`boot`, `step`, `render`, `screen.present`, `saveState`, `loadState`, `hasQuit`,
`frame`, `currentRoom`, `sound.setEnabled` — and those are the interface.

**Input is deliberately not in it.** Three of the twenty are SCUMM-shaped, and
all three are input: the verb-bar hit test (`screen.verb.top`, `verbs.hitTest`,
`handleVerbClick`), and `VAR.CUTSCENEEXIT_KEY`. SCUMM builds a sentence from
clicks; AGI matches a line the player types against a fixed vocabulary.

ADR 0007 supplies the test for whether that should be generalised or separated:
it generalised the camera because the versions "differ by degree in a way one
model can hold", and v5's one-screen-tall y range became the degenerate case of
v7's two-dimensional camera rather than the other side of an `if`. A verb bar
and a typed parser do not differ by degree. There is no model that holds both
without becoming a bag of flags, so each Engine exposes its own input object and
the shell feeds it from device events. A unified `handlePointer`/`handleKey` pair
was rejected on exactly ADR 0007's grounds, read the other way.

Screen geometry is not in it either, because it turns out not to differ. AGI
displays 320x200 in sixteen colours; its Pictures are stored at 160x200 and
doubled horizontally on output. `Screen` — 320x200, hardcoded in 52 places
across ten files — is reusable unchanged, and `Palette` narrows to sixteen
entries, which it can already do.

v7 improved this position rather than complicating it. ADR 0007 made the camera
two-dimensional unconditionally and moved the band layout behind a data-driven
`setLayout`, so that a v7 game is simply one that sets a full-height room band
and nothing asks which version it is. AGI's screen is a band layout too — a
status line at the top, a Parser input line at the bottom, room in between — so
it is already expressible in the model v7 left behind, without a family branch.
That is the second time this seam has been asked to hold something it was not
designed for, and the answer both times was to widen the data, not the code.

## Consequences

The shell extraction lands as its own step, with no AGI code in it, proved by
SCUMM continuing to work. This follows ADR 0001's precedent: do the enabling
refactor deliberately rather than let the second implementation shape the seam
around its own accidents.

Twenty members is small enough that the interface is not much abstraction, and
that is the point — it is a description of what a shell needs from a game, not a
framework. If it grows past roughly thirty, the seam is in the wrong place and
this ADR should be revisited rather than the interface widened.
