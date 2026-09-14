# Humongous Entertainment (HE 60–100)

**Decision: not in scope.** Settled while scoping SCUMM v2–v8.

`docs/released-games.md` lists HE 60 through HE 100 as "same engine lineage,
versioned separately" — Putt-Putt, Freddi Fish, Pajama Sam, Spy Fox, Big
Thinkers, the Backyard Sports titles, Moonbase Commander. Around fifty games,
more than every LucasArts SCUMM title combined.

They are a **fork of v6**, which is what makes them worth writing down rather
than assuming: "SCUMM v6 is supported" reads as though it includes them, and it
does not.

## Why it is declined

**It is a second version axis, not a wider range on ours.** HE numbers are not
points on SCUMM's scale; they are a parallel scale that starts at v6 and runs
for a decade past it. ADR 0012 made `Target` a discriminated union precisely
because a second lineage breaks a single version number, and HE would be a third
arm with its own detection, its own bytecode extensions and its own resource
layout — Windows-era containers, Smacker video, `HE` opcode blocks. That is a
project the size of this one.

**The mapping is not known.** `docs/released-games.md` says so itself: "the exact
game→HE-number mapping is fuzzier than the LucasArts list above, so treat these
groupings as approximate." Support cannot be claimed per-Target against an
approximate table, and `CONTEXT.md`'s bar is **Completable** — a claim about a
specific game reaching its last screen.

**Nothing in scope needs it.** No LucasArts title requires an HE code path. The
one place HE appears in the codebase today is a comment in
`src/engine/gfx/costume/akos.ts`; there is no HE handling anywhere.

**The verification cost is the real one.** `docs/processes/verifying-version-support.md`
already establishes that Completable cannot be asserted by CI and needs a person
with the data playing a game to its end. Fifty more titles is fifty more of
those, on data that cannot live in the repository.

## What would change this

A concrete want for a specific HE title, scoped as its own Target arm with its
own detection and its own tiered acceptance — not as a widening of v6.
