# AGOS Projects hold instructions and an item tree, and the opcode table is ours

ADR 0005 settled that v6 scripts are edited as instructions, ADR 0013 that AGI
projects hold behaviour only as Logic, and ADR 0018 that SCI projects hold a
class graph with source as a view. AGOS needs a fourth answer, and it also needs
something none of those three did: an honest account of where its instruction
lengths come from, because they do not come from the game.

## Instructions, the item tree, and pooled strings

A Subroutine is a numbered list of instructions and is edited at that level —
ADR 0005's model, unchanged. Three things are worth recording beyond that.

**The item tree is first-class, by name.** AGOS has no rooms-with-objects-in-them
the way SCUMM does. It has one global tree of items — rooms, objects, the player,
and abstractions that are none of those — each linked to a parent and to
siblings and carrying typed sub-structures, and instructions refer to items by
number. An instruction that says _item 217_ is unreadable until the tree says
what 217 is, so the Project holds the tree as named structure. This is AGOS's
answer to SCI's class graph (ADR 0018): the structure without which the
instructions are noise.

**Text is pooled and referenced by index**, which is ADR 0009's shape rather than
AGI's. An AGI Logic carries its own messages, so an edit's reach is visible; an
AGOS string lives in a shared table that many Subroutines point at, exactly like
a v7 language bundle. So strings are first-class Project content "that neither
owns but both point at", and the editor has to show reach rather than pretend
there is none.

**Where a Subroutine lives is packaging, not meaning.** Some sit in `GAMEPC` and
some in table resources pulled in per room. A Project holds Subroutines by
number; which file they came from is the exporter's problem (ADR 0030).

Rejected: **a decompiled tree, as AGI has.** Cleaner to edit and AGOS scripts are
structured enough to make it tempting. ADR 0018 disqualified exactly this as a
_storage_ form on `Unrecovered` grounds — reconstructing control flow cannot
guarantee the original byte layout — and AGOS has no in-game arity table to make
the decode trustworthy in the first place. A source view over the instructions
stays available later, as a view.

Rejected: **instructions with the item tree left opaque.** Smaller surface,
faster to something playable, and it makes "edit the game" mean editing code
that manipulates items nobody can name — which is most of what an AGOS script
does.

Rejected: **Preserved bytes only, editing deferred.** `CONTEXT.md` reserves
Preserved bytes for what no importer _can_ recover, not for what has not been
written yet.

## The opcode table is ours, and that is a new kind of risk

ADR 0013 established the failure mode: where an instruction's length comes from
outside the bytecode, a wrong table misreads every boundary after the first
mismatch and then re-emits its own misreading byte for byte. The check passes,
the structure is wrong, and an author edits it believing otherwise.

AGOS has that shape and a different provenance. AGI's arity table ships **with
the game** in `agidata.ovl`; AGOS's shipped inside a bundled executable, so the
table this project decodes with is **its own**, transcribed per Version from the
formats and from ScummVM's readers. That removes AGI's identification problem —
two games sharing a Version cannot disagree, because the Version _is_ the game
(ADR 0027) — and replaces it with a transcription problem: the table can simply
be wrong, uniformly, for a whole Version.

So the bar for offering an AGOS game for editing is three things:

1. **The Version is probed** from the game's own bytes, ADR 0020's mechanism at
   its fourth family.
2. **Structural agreement across the whole game**: every Subroutine in every
   table resource decodes to land exactly on its end marker, with no instruction
   overrunning it and no jump landing mid-instruction.
3. **Byte-identity**: an imported and untouched game re-emits as the bytes it
   arrived as.

The second is the one that earns its place. A wrong arity desynchronises and
overruns — loudly, across hundreds of Subroutines — where AGI's equivalent
failure is silent. It is not a proof, and it is not offered as one: it is a
falsifier that is cheap to run over an entire game before a single opcode's
behaviour exists.

Rejected: **ADR 0013's rule verbatim, including its declared-by-the-author
hatch.** That hatch exists because an AGI dump can be missing the evidence
entirely. AGOS games are not missing evidence — the bytes say which game they
are — so a declaration would let a person assert their way past a check that can
actually be run.

Rejected: **hashing the release, as ScummVM does.** Accurate for shipped
releases and it also yields the language. ADR 0020 rejected hashes as the
mechanism, and ADR 0028 admits fan translations and repackaged data, which is
precisely the input a hash table cannot cover.

Rejected: **byte-identity alone.** ADR 0013 spent a section on why it is
necessary and not sufficient. Reopening that knowingly would be worse than
having never argued it.

## Consequences

`CONTEXT.md`'s **Decompilation** entry said Decompilation is "only attempted
where the encoding makes instruction boundaries certain". That was already
untrue of AGI, which decompiles with an external arity table and buys certainty
by identifying the interpreter, and AGOS makes the gap plain. The entry is
corrected rather than worked around: certainty may come from the encoding, or
from an identified table plus a check that the whole game agrees with it.

`Unrecovered` applies unchanged and per Subroutine. A Subroutine that re-emits
differently is read-only and counted, with a target of zero and a fix that is
always a better importer.

The published claim is per Version, never per family. "AGOS is editable" is
seven claims, each reducing to an Unrecovered count of zero over a named game
whose Version was probed — and each needing the whole-game sweep to have passed
on real data, which CI cannot do because no game data is ever committed
(`docs/processes/verifying-version-support.md`).

Nothing in `authoring/` that assumes an `Action` graph applies, exactly as ADR
0013 found for AGI. What is reusable is the canvas patterns and the project file
plumbing — and, newly, whatever the SCI work built for editing a named graph of
game structure, which is the nearest thing in the repo to an item tree editor.
