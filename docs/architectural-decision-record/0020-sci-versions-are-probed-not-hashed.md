# SCI Versions are established by probing the game, not by hashing known releases

ADR 0016 puts a Version on every SCI Target, and ADR 0013's rule rides along
unchanged: a Target arrived at by guess is safe to play on and not safe to edit
on. SCI makes that rule bite harder than either sibling, because **SCI stamps
its version nowhere**.

## The mismatch this ADR exists to solve

The evidence that is easy to read is coarser than the axis that has to be
filled in.

`RESOURCE.MAP`'s own structure — entry width, whether a type directory sits at
the front, how the volume number is packed — cleanly separates SCI0, SCI1,
SCI1.1 and SCI2. It cannot separate SCI1 early from middle from late, or SCI2.1
early from late. Those are exactly the seams ADR 0016 says the axis needs.

Left there, most SCI1 and SCI2.1 games land on `guess` and are refused for
editing, which guts the point of supporting them.

## Probes, not a hash table

The finer seams **are** visible in a game's own resources, just not in its map:
whether `vocab.999` is present, whether scripts have a separate heap resource,
how wide a View's cel header is and whether it carries a compression field,
where the well-known Selectors sit in `vocab.997`. Each is a fact about shipped
bytes, so a game answering them is identified by `index-structure` and edits
freely.

**A hash table of known releases is rejected as the mechanism**, and the reason
is about verification rather than taste. It can never cover **fan-made games**,
and fan games are going to be this project's only free SCI data — SCI Companion
produced them the way AGI Studio did for AGI, and
`docs/processes/verifying-version-support.md` already records that fan data is
what finds the reading-the-format faults a synthetic fixture structurally
cannot. A detection scheme that works on Sierra's two dozen titles and fails on
every fan game is the wrong shape for how this project actually gets tested.

A hash stays available as a tiebreaker for genuine ambiguity. It is not the road.

**The declared path stays too.** AGI's `InterpreterIdentification` already has a
value for a version stated by the person doing the editing, explicitly not a
guess, and SCI takes the same escape: someone who knows their copy is SCI1 late
says so and edits.

## Consequences

**The set of Versions this project can edit will lag the set it can play**, at
least until the probes are worked out. That gap should be a published number the
way `Unrecovered` is — not something a user meets as a refusal in the editor
with no explanation.

An issue adding a SCI Version names which probes distinguish it from its
neighbours, and a Version with no distinguishing probe is not supported for
editing however well it plays.
