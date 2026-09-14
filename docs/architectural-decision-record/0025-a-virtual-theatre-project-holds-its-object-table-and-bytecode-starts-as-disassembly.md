# A Virtual Theatre Project holds its object table, and its bytecode starts as Disassembly

Three families, three Project shapes. A SCUMM Project holds behaviour three ways
and ADR 0013 counted them: `Action`s, imported instructions, an external
language bundle, over a floor of **Preserved bytes**. An AGI Project holds
exactly one thing — a decompiled Logic tree — and ADR 0013 was written to stop
SCUMM's three being inherited by a family that did not need them. A SCI Project
holds a class graph, and ADR 0018 made Source view a projection over it rather
than the stored form.

Sky and Lure share a fourth shape, and the reason is ADR 0024's: in both games,
the world is not in the bytecode.

## The object table is the editable surface

In SCUMM, AGI and SCI, changing what a game does means changing code. Rooms hold
objects, objects hold handlers, handlers are script. Edit the script.

Revolution put the interesting state one level out. A Sky **Compact** carries an
object's position, its current mode, its animation, its screen, and the pointers
to the logic that drives it; Lure holds its own equivalent the same way. The
bytecode is the verbs; the object table is the nouns and where they are
standing. Most of what a person means by "edit this game" — move that, change
what it is doing, point it at different behaviour, change what it looks like —
is a field in that table, not an instruction.

So a **Virtual Theatre Project holds its object table as first-class editable
content**: named records with typed, named fields, not a byte array with an
offset map. That is the primary authoring surface and the one the editor leads
with.

This has a consequence worth stating loudly, because it separates two things the
original request bundled together:

> **Editing these games does not depend on decompiling them.**

A person can move objects, change states, relink behaviour and retext dialogue
through the object table and the text resources with the bytecode never decoded
past a listing. That is a real and deliverable half, and it is not gated on the
hardest unknown in either family.

## Bytecode is Disassembly until each encoding says otherwise

`CONTEXT.md` draws the line and this ADR does not move it. **Disassembly** is
reading bytecode back as a listing to be understood but not edited, stopping
rather than guessing when a length cannot be measured. **Decompilation** is
reconstructing editable structure, "only attempted where the encoding makes
instruction boundaries certain".

Whether either engine's encoding makes them certain is **not known**, and this
ADR refuses to assume it either way, for either game. SCUMM's Stack encoding
derives length from the opcode alone and earned Decompilation (ADR 0005). SCI's
PMachine derives it from the low bit of the opcode byte and earned it (ADR
0017). AGI's does not derive at all — the arity table lives outside the bytecode
— and ADR 0013 had to buy the claim a different way, by identifying the
interpreter.

Sky's encoding lands in one of those three cases, Lure's lands in one of them
independently, and both answers are spike outputs. **Neither answer licenses the
other**, which is the point of saying it twice: these are two interpreters that
happen to share a publisher.

Until each answers, that family ships:

- **Disassembly.** A listing, in the editor, read-only.
- Script bytecode held as **Preserved bytes**, round-tripping byte-identical.
- No claim of Decompilation, in the README, in `released-games.md` or in an
  issue title.

Promoting either to Decompilation later is an ADR of its own, with that
encoding's evidence in it. Doing it without one is how a guarantee becomes a
heuristic wearing a guarantee's clothes, which ADR 0013 spent two sections
refusing.

## Preserved bytes exist here, and that is not a defect

ADR 0013 made a strong claim for AGI — full round-trip with no Preserved bytes,
an **Unrecovered** count with a target of zero. Neither Virtual Theatre family
inherits it and neither should be measured against it.

`CONTEXT.md` already separates the two: Preserved bytes are "byte-identical by
design", Unrecovered is "a defect with a target of zero". Bytecode carried
through untouched is the first kind — deliberate, because this project has
decided not to claim more than it can prove. A record that could not be read
into typed fields, or that re-emits differently than it arrived, is the second
kind, and it is counted.

The Unrecovered count for these families is therefore **a count over the object
table**, not over scripts. That is a different measurement from the other three
and the difference is the information: it says where this project believes it
understands each game.

## Text is its own surface again

ADR 0009 made v7 text first-class Project content because a language bundle sits
outside the scripts and one line is referenced from many. ADR 0013 noted AGI
escapes the problem because a Logic carries its own messages. SCI splits by
Version — inline strings before SCI1.1, keyed Messages after.

Both Virtual Theatre games keep their text in their resource files, addressed by
number: an external pool, referenced by index, editable without touching a
single instruction. It is Project content, per ADR 0009's reasoning applied
unchanged.

Both shipped in several languages, and Beneath a Steel Sky's CD release adds
recorded speech. `CONTEXT.md` is already firm that **language is not part of a
Target** — "it changes which resources a game ships, not how any byte decodes" —
and these games confirm the rule rather than testing it. A Project holds **all**
the languages it found; importing one and dropping the rest is the silent data
loss `CONTEXT.md` names as Unrecovered.

## Rejected

**`Action`s for either family.** ADR 0013 rejected them for AGI and the argument
carries verbatim: every Action would need a lowering per engine, "expand to
script" is a one-way door the UI has to explain, and it is a convenience nobody
working on these games is asking for.

**Holding the object table as raw bytes with an overlay of names.** Cheaper, and
it makes byte-identity trivially true while making the editor useless — the
whole claim is that a field is a thing a person edits by name. It would also put
every size and signedness decision at the point of display rather than at the
point of import, which is where a misreading gets noticed.

**One Project shape covering both games' object tables.** Tempting, because the
shape of the _problem_ is identical. Rejected: ADR 0026 makes these two
families, and a shared record type would be the first place the two engines got
confused for one. What they share is this ADR's reasoning, which is what an ADR
is for.

**Waiting for the encoding spikes before designing either Project.** The
object-table half is independent of both answers, and holding it hostage would
mean shipping nothing until the hardest questions resolve.

**Claiming Decompilation now on the grounds that ScummVM interprets these
scripts fine.** Interpreting is not the same claim. An interpreter that walks
instructions forwards from a known entry point never has to answer where an
arbitrary byte's instruction begins, and that is the question Decompilation
turns on.
