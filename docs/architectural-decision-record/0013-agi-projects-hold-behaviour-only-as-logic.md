# AGI projects hold behaviour only as Logic, and never fall back to bytes

The SCUMM editor holds behaviour three ways, and the count is rising. ADR 0005
settled that an imported v6 script is edited as instructions while an author's
new behaviour is `Action`s, and named the consequence plainly: "a v6 project
therefore has two ways to hold behaviour, and the editor has to make which is
which obvious." ADR 0009 then added a third for v7 — displayable text lives in
an external language bundle and a script refers to a line by index, so strings
became first-class Project content "that neither owns but both point at".
Underneath all of it sits **Preserved bytes**, bytecode carried through unchanged
because no importer can turn it into editable steps.

Each of those was the right call for the game data in front of it. None of them
is forced on AGI, and taking them anyway would be the mistake.

## One representation

An AGI Logic resource decompiles to near-source: conditions, commands, nested
blocks and a message table. Free tools have round-tripped it for twenty-five
years — given the right arity table, which is the qualification the next section
is about. So a Logic resource is held as a **decompiled tree**, and that tree is the
truth for both halves of the editor — what was imported and what an author
writes from nothing. Authoring an AGI game means writing Logic.

The message table is the part worth naming, because it is where AGI escapes
ADR 0009's problem rather than merely not having it yet. A Logic's messages are
stored **inside that Logic**, so a room's text lives with the code that shows
it. There is no shared string pool, so there is no edit whose reach an author
cannot see: changing a message changes one Logic, and the editor does not have
to explain otherwise. v7 had no such option — the bundle is external and one
line genuinely is referenced from many scripts.

Source text is a _view_ over the tree, not the stored form. Storing text would
be diffable and would match the dialect the AGI community already types, but it
makes byte-identity a property of a text round trip, and it needs a full parser
before anything can be edited at all. With the tree as truth, re-emission is
deterministic and byte-identity is a testable property of one resource.

The existing `Action` set and `ActionEditor` therefore do not apply to AGI
projects. Rejected: `Action`s as sugar lowering to Logic — a friendlier
authoring path, but every Action needs an AGI lowering and "expand to Logic" is a
one-way door the UI has to explain, for a convenience AGI authors have never
had and are not asking for. It stays available as a later addition precisely
because there is one representation underneath it.

## Byte-identity is necessary and not sufficient

ADR 0005 could lean on byte-identity as the property that made v6 editing safe,
because "v6's stack discipline makes every instruction boundary measurable". AGI
has no such discipline. An AGI instruction's argument count is not in the
bytecode at all — it comes from a table in `agidata.ovl` that varies by
interpreter build and platform (ADR 0012).

That produces a failure this project has not had to think about before. Decode a
Logic with the wrong arity table and every boundary after the first mismatch is
wrong: an instruction swallows the opcode that follows it, and the tree is
nonsense. Re-emit with the same wrong table and it writes that nonsense back
**byte for byte**. The check passes. The structure is wrong. And an author edits
it believing otherwise.

So byte-identity remains an acceptance criterion and stops being the whole
claim. The Interpreter version must be **positively identified** — by hashing the
shipped interpreter, or better, by reading the game's own `agidata.ovl`, which is
the authoritative arity table and ships with the game. Where identification falls
back to a guess, the game **plays** on that guess and is **refused for editing**.

Rejected: accepting the guess and editing anyway, which is where ScummVM's
default lands and is correct for a player — a wrong arity on an opcode no script
calls costs nothing to play. It costs everything to edit, because the author's
change is written into a structure that was misread. Rejected: relying on
plausibility checks alone (every opcode in range, no jump landing mid-instruction,
`if` blocks well-nested). Those are worth having and they lower the odds; they do
not make the guarantee, and a heuristic presented as a guarantee is worse than
neither.

### Amendment: a version the author states is not a version the engine guessed

The rule above says "positively identified", and named two ways to get there:
hashing the shipped interpreter, or reading the game's own `agidata.ovl`. Both
require the release to _be there_. A great many dumps in circulation are the
resources and nothing else — `LOGDIR`, `PICDIR`, `VIEWDIR`, `SNDDIR`, `VOL.n`,
`OBJECT`, `WORDS.TOK` — and for those there is no evidence to read and there
never will be. Under the rule as written they are permanently uneditable, however
much their owner knows about them. That is not a guarantee being upheld; it is a
guarantee refusing a case it was not thinking about.

So a third identification is admitted: **declared**, stated by the person doing
the editing. It is not the guess this ADR rejects, and the difference is in how
the two fail rather than in how confident either is.

A guess fails _silently and anonymously_. The engine picks 2.917 because nothing
said otherwise, nothing on screen distinguishes a right assumption from a wrong
one, and the author has not been told there was a question. A declaration fails
_visibly and attributably_. A person was shown what a wrong table does, chose a
build, and the Target records `identification: 'declared'` — so the project
carries the provenance of its own decoding, and a tree that reads oddly has a
first place to look rather than being unfalsifiable.

That last part is what keeps the consequence below honest. "AGI is fully
editable" still reduces to an Unrecovered count of zero on games **whose
Interpreter version was positively identified**, and a declared version does not
count towards it: a published number that anyone could improve by asserting a
version would measure nothing. Declared exists so a person can work on their own
copy, not so the project can claim a game.

Still rejected, unchanged: the engine inferring a version from the bytecode by
decoding under each candidate table and keeping whichever fits. That is the
plausibility check above wearing a better disguise, and it would be the engine
guessing again — with the added harm that it would look like a measurement.

## No escape hatch, only a defect

When a Logic resource re-emits as different bytes than it arrived as, that
resource becomes read-only and is counted. `CONTEXT.md` calls it
**Unrecovered**, deliberately not Preserved bytes: Preserved bytes are
byte-identical _by design_ and will always exist in SCUMM, whereas an
Unrecovered Logic is a bug with a target of zero. The fix is a better
decompiler, never a wider fallback.

Rejected: refusing the whole game on any failure, which is the strongest
guarantee and would block all progress on one odd resource in King's Quest 1.
Rejected: accepting the difference and letting re-emission win, which is a
silent behaviour change on export — the thing ADR 0005 rejected for v6.

## Consequences

The Unrecovered count per game is a published number, tracked the way version
support is. "AGI is fully editable" is a claim that reduces to that count being
zero on a named set of games **whose Interpreter version was positively
identified**, so it can be true or false rather than aspirational. Without that
second half the number is unfalsifiable: a game decoded with the wrong table
scores zero.

This narrows what #115 claimed. AGI still clears a bar SCUMM cannot — full
round-trip with no Preserved bytes — but not because AGI is structurally safer
to decode. It is structurally _less_ safe, and buys the stronger editing claim by
identifying the interpreter rather than by measuring boundaries the way v6 can.

An AGI project and a SCUMM project are different enough inside that the editor
has two behaviour surfaces. That is not the problem ADR 0005 and ADR 0009
describe: those are about one project holding several kinds of behaviour at once.
Within an AGI project there is exactly one way behaviour is held, and within a
SCUMM project there are three — the split is between project types, where the
Target already tells you which you have.

Nothing in `authoring/` that assumes an `Action` graph is reusable for AGI. The
reusable parts are the canvas patterns (`RoomCanvas`, `SpriteCanvas`,
`ObjectArtCanvas`) as shapes to copy, and the project file plumbing.

Export is simpler than v7's, and for the same structural reason. ADR 0009 notes
that exporting v7 means rewriting a set of files rather than a pair, and that a
language bundle which fails to write leaves "a game full of missing dialogue
rather than a game that fails to load". AGI has no file outside the volumes to
keep in step, so its export stays the narrower problem ADR 0010 was written to
handle.
