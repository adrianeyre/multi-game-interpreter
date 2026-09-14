# The editor asks for a game folder rather than storing its art

**Status: accepted.** Everything below the Consequences was an argument before
it was a decision; it is kept as written because the argument is the reason the
shape is what it is. What changed is the last section, which now records what
was built rather than what was recommended.

## The problem is a serialisation boundary, not a missing parameter

An AGOS game's art is not in `GAMEPC`. It lives in the zones a `ZoneSource`
reads, and ADR 0030 has the Project carry **intent** rather than bytes, so a
Project records which image an author painted to which bitmap and nothing more.
That is the right shape and it is already built.

What is not built is how the editor gets the _original_ pixels in order to show
an author an image before they paint it. `AgosEditor` takes a `readZonePixels`
callback and today only tests pass one, and the reason is structural: the shell
hands the editor a game by calling `putImportedProject`, which **serialises the
Project into IndexedDB** for the editor to read back as data. No live object
crosses that boundary. A callback therefore cannot cross it either, and neither
would a `DataSource` threaded down to `EditorState` — the boundary is
serialisation, not scope.

So the question is not how to pass a function. It is where the bytes come from
on the editor's side of a store-and-reload.

## Two shapes, and what each costs

**Store the zone resources beside the Project.** The editor then has everything
it needs with no second gesture from the player, and the paint surface works
exactly as its tests already exercise it.

This is what ADR 0010's threshold exists to refuse. A talkie release's
resources run to tens of megabytes and its speech far beyond that; an edited
Full Throttle "would want roughly two copies of a CD in IndexedDB", and quota
is a browser policy rather than a machine specification. Storing art for AGOS
would be carving an exception into the rule for the family whose resources are
among the largest, which is the wrong family to make the exception for.

**Have the editor re-open the game folder.** ADR 0010 already sends _export_
back to the player for the folder. This moves that same gesture earlier, from
export to load, for the one surface that needs bytes the Project does not carry.

The cost is a second gesture, and it is not free: a player who opened a game to
play it is asked for the folder again to edit its art, and a folder picked at
load has to be checked as being _the same game_ rather than trusted — a
different game's zones would render as plausible nonsense, which is worse than
an error.

## The recommendation, and the reason it is not a close call

**Re-supply.** Not because the second gesture is pleasant, but because the
alternative contradicts a decision this repository has already taken and
applied elsewhere, and it would do so in the family with the largest resources.
A rule with an exception for its hardest case is not a rule.

It also keeps one property that matters more than convenience: an author's
edits stay small enough to be a document. A Project remains something that can
be saved, moved and inspected, rather than a copy of a game with edits in it.
That is the same argument ADR 0030 makes for intent, and this is that argument
applied one layer out.

## Consequences

Whichever is taken, the image view says why it cannot draw rather than showing
an empty canvas — a blank canvas reads as a blank image, which is a different
claim about the game.

If re-supply is taken, it needs a same-game check with teeth. Comparing the
base file's bytes against what the Project was built from is the obvious one,
and it is cheap: the base file is small and already read at detection.

If storage is taken instead, ADR 0010's threshold has to be amended rather than
worked around, and the amendment should say what happens when the quota is
refused mid-import — because a half-stored archive is the failure mode that
produces a project which opens and then cannot draw.

Nothing here blocks the rest of AGOS editing. Items, strings and Subroutines
are unaffected: they are all in `GAMEPC`, which the Project does carry.

## What was built

Re-supply, as recommended. `src/editor/agos/resupply.ts` asks for the folder,
reads the base file and the archive the Project's `origin` names, checks them,
and hands back a reader for a zone's pixels. The editor's Art tab offers the
gesture when it has no reader, and says why rather than showing a blank canvas.

**The teeth are a fingerprint of the base file**, computed over the bytes at
import and stored on the Project as `agos.baseFingerprint`
(`src/authoring/agos/fingerprint.ts`). The Consequences above call the
byte-comparison "the obvious one, and it is cheap"; a fingerprint is that
comparison without keeping a second copy of the file to compare against, which
would have been the same storage cost this ADR exists to refuse, in miniature.

FNV-1a rather than a cryptographic digest, and the length travels beside the
hash rather than folded into it. Neither is a shortcut: nothing here is
defending against a forged `GAMEPC`, and a mismatch that can say _which_ thing
differs — "that file is 4 KB shorter" — is a sentence a person can act on where
"the hashes differ" is not.

The archive is checked by **size** against what the origin recorded, not by
fingerprint. A talkie's archive is tens of megabytes and hashing it would stall
the gesture, while the base file beside it already identifies the release
exactly. A folder holding the right `GAMEPC` and a differently-sized archive is
refused on the size, and told that it is a folder with one file swapped rather
than a different release.

The folder is **held for the session and never persisted**. A directory handle
does not serialise, and storing the bytes it leads to is the thing this ADR
refuses. Losing it on reload costs one gesture.

### What it unlocked, beyond the paint surface

The same bytes are what an export needs. ADR 0030 rebuilds `GAMEPC` whole and
the archive beside it, together or not at all, and the archive half had nowhere
to come from until now — so an AGOS project could be edited and not written out.
Save, Export and Play all take the re-supplied archive, and all three refuse by
name when there is none rather than producing half a game.
