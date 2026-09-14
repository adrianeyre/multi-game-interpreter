# AGOS splits packaging from encoding, and GAMEPC is rebuilt whole

Two reading-and-writing decisions for AGOS, recorded together because they pull
in opposite directions and it is the pair that is worth remembering.

## Packaging gets a reader each; encoding is data

The repo has two precedents for platform variation and they disagree.
`CONTEXT.md`'s Resource layout says "one writer per layout"; ADR 0007, ADR 0011
and ADR 0015 say "widen the data, not the code", three times. AGOS takes both,
because the two things vary independently.

**Packaging gets a reader per layout.** Loose numbered graphics files beside a
`GAMEPC`, a packed archive addressed through an offset table, and the AGOS 2
arrangement are three shapes, and a reader that tries to be all three is a
disguised switch. This is the SCUMM precedent applied unchanged, and the writers
follow the same principle their siblings do: copy what was not touched,
substitute what was, rebuild the index.

**Cel encoding, palette depth and colour count are declared by the release and
read by one decoder.** DOS, Windows and Macintosh releases of one game differ in
packaging only; Amiga changes the pixels as well as the packaging. Branching the
decoder on platform would duplicate it three ways to express a difference that
is two numbers and an encoding kind.

The test for whether this was right is the one ADR 0015 wrote down for the Plane:
if the platform starts being _asked about_ inside the decoder — in clipping, in
masking, in palette handling — then it is not data any more and the decoder
should split rather than grow flags.

## GAMEPC has no index, so it is parsed end to end and rebuilt whole

`GAMEPC` holds the item tree, the Subroutines and the pooled strings in one file
with nothing to address them through. There is no index to substitute a resource
into, and a longer line of dialogue relays everything after it. So the exporter
does not copy-and-substitute here: it re-emits the file from the Project's own
model, with byte-identity on an untouched import as the gate.

**The consequence is coarser than any other family's and is stated rather than
discovered: a region of `GAMEPC` that cannot be parsed makes the whole game
uneditable, not one resource read-only.** Everywhere else `Unrecovered` is
per-resource and a single bad script costs a single script. Here the granularity
is the file, because the file is the granularity the format offers.

Rejected: **rebuild what is modelled and copy unparsed regions verbatim.** It
would get a game editable sooner and preserve bytes nobody understands. Any edit
that changes a size shifts those regions, and the offsets inside them — which by
definition are not understood — are then wrong, silently. Preserved bytes are
for data nothing points into; this is data everything points into.

Rejected: **size-preserving edits only.** Perfectly safe, needs no full parse,
and forbids the first edit anyone will try: making a line longer.

Rejected: **splice and fix up the offsets, treating the rest as opaque.** Needs
to know where every offset in the file is, which is most of what parsing it end
to end means — so it pays the cost of the chosen option while keeping the risk of
the rejected one.

## Consequences

Export follows ADR 0010's re-supply path for the larger releases. A talkie
release with its speech is far above the threshold at which storing the
originals in IndexedDB stops being reliable, so an AGOS Project holds intent and
asks for the game folder again at export.

Two artefacts are written where SCUMM writes one: the rebuilt `GAMEPC` and the
rebuilt archive. They must agree — a Subroutine moved between them, or a string
index that no longer resolves, is a game that loads and then misbehaves — so
export is one operation that either produces both or produces neither.
