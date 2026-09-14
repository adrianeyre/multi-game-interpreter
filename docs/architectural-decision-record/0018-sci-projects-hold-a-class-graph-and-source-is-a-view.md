# SCI Projects hold a class graph, and Sierra Script is a view rather than a storage form

ADR 0005 settled that v6 scripts are edited as instructions, and ADR 0013 that
AGI projects hold behaviour only as Logic. SCI needs a third answer, because a
SCI Script resource is not a bag of handlers the way a SCUMM object is, and not a
self-contained script the way an AGI Logic is. It is a **linked unit**: class
definitions with their Selector tables and method dispatch, object instances,
code, locals, a strings and `said` table, and a relocation list.

## Instructions, plus the class graph, is what a Project stores

Method bodies are instruction lists — ADR 0005's model, and it applies cleanly
here for the reason ADR 0016 gives: SCI instruction boundaries are derived from
the opcode byte, so `CONTEXT.md`'s Decompilation is available rather than merely
Disassembly.

What is new is that the Project must hold **classes, their Selectors, their
methods and their instances, by name**, as first-class structure. Neither
sibling needed that, and the cost is concentrated in one place: **a SCI
assembler is a linker, not an emitter.** Adding a Selector to a class relays out
every instance of it and every entry in the relocation table; adding a method
changes the dispatch table. A new Selector must extend the game's own table
without renumbering the ones untouched Script resources still index by number.

That is real work and it has no precedent in this repo. Recording it here so it
is budgeted rather than discovered.

## Sierra Script is a view, and storing it would break Unrecovered

The obvious ambition is to decompile to Sierra Script, edit the source, and
recompile — what SCI Companion does. Taken as the **storage** form it is
disqualified by this project's own vocabulary, not by effort.

`Unrecovered` is defined as a resource that "could not be Decompiled into
editable structure, **or that re-emitted as different bytes than it arrived
as**", with a published count and a target of zero. Reconstructing `if` and
`while` from jumps and recompiling them is exactly the transform that cannot
guarantee the original byte layout. Store source and every Script resource in
every game is permanently Unrecovered, and a defect count with a target of zero
becomes a number nobody can read. That is not recoverable later by trying
harder.

Taken as a **view** it costs nothing, and this is the distinction the ADR turns
on: `Unrecovered` is an import-time check. Bytes are meant to change once
someone edits. So a **Source view** is rendered from the instruction list on
demand, edited, and parsed straight back into instructions — and the byte-identity
invariant is untouched, because the stored form never stopped being instructions.
Where control flow cannot be reconstructed with certainty the view degrades to
the instruction list rather than guessing at an `if`.

`Preserved bytes` remains the third leg and is unchanged: a defect counted by
`Unrecovered`, never a mode a user chooses.

## Pictures are two resource kinds, not one with a mode

SCI0 and SCI1 Pictures are vector drawing commands. SCI1.1 Pictures carry
embedded cels alongside them. By SCI2 they are arrangements of bitmaps. A vector
drawing tool and a bitmap composition tool share no editing operation at all, so
they are two kinds that happen to share a resource type number — ADR 0011's
verb-bar-versus-parser reasoning applied to content rather than to input. One
editor with half its buttons greyed out by Version is the bag of flags ADR 0007's
test exists to prevent.

## Text follows ADR 0009 unchanged

SCI1.1's `MESSAGE` resource is the same move SCUMM v7 made, and gets the same
answer: Messages are Project content, edited as themselves. SCI0 and SCI1 text
stays inline in the Script resource where the game put it.

A release shipping several languages holds all of them — importing one and
dropping the rest is data loss, and by the definition above that is `Unrecovered`.

## Consequences

"Edit this game's words" names two different places depending on Version, and
the editor says which rather than offering one surface that silently works for
half the catalogue. It also does not reach translated wording baked into Views
and Pictures, which is a limitation to state rather than to discover.
