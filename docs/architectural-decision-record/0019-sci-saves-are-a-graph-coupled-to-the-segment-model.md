# SCI saves are a graph, and they are coupled to our segment model on purpose

ADR 0002 gave this project its own save format rather than LucasArts' or
Sierra's. That premise holds for SCI. What does not hold is the shape ADR 0002
assumed, and the departure is deliberate enough to record.

## A SCUMM save is a schema; a SCI save is a heap

A SCUMM save is named engine state — room, ego, inventory, variables — and you
can write a schema for it. SCI has no such layer. The game world lives in
dynamically allocated objects with references between them; "the inventory" is
not a field but a list of objects reachable from another object. **The VM's
object graph is the game state**, and there is nothing above it to serialise.

The distinction that decides the format is between two kinds of object:

- **Static objects**, baked into a Script resource, restored by reloading that
  script and re-applying whichever properties changed.
- **Clones**, made at runtime by `kClone` with no backing in any resource, which
  must be recreated whole along with every reference into them.

Confuse the two and a save loads a world that looks entirely right and whose
actors are not the ones the running scripts hold pointers to. That failure has no
error and no visible symptom until something much later behaves oddly.

## So the format is graph-shaped, and that couples it to us

Segments with declared types — script, clone, list, node, hunk — and references
written as segment-plus-offset pairs.

**The cost, stated rather than discovered: this couples SCI saves to our own
segment model.** Any change to that model bumps the SCI save format. ADR 0002
chose an own format partly to avoid being hostage to an implementation's
internals, and SCI leaves no alternative, because the layer at which a save
could be described independently of the VM does not exist in this engine.

Rejected: snapshotting the heap as opaque bytes, which is close to what Sierra
did and is cheap. It breaks the instant a Project has been edited and offsets
move — which is the entire point of this project.

## Consequences

The shell needs nothing. `AdventureEngine` already carries `readonly
saveFormat: number` per engine and `SavedGameEnvelope` already carries `format`,
`gameId` and `room`, so SCI declares its own number and the existing envelope
holds it. That the seam absorbs a family this different without widening is
evidence for ADR 0011's placement of it.

Cross-family and cross-Target refusal is already correct and needs no SCI work:
the save guards check the engine family first, then the game id, then the format,
then `sameTarget`. A King's Quest IV AGI save cannot reach a SCI0 King's Quest
IV, and it is rejected two checks before the one that would have been
load-bearing.
