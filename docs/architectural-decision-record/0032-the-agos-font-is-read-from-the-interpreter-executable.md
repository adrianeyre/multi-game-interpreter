# The AGOS font is read from the interpreter executable, and never transcribed

Every other family in this repository draws its text with a font the player
owns: a SCUMM `CHAR` resource, an AGI font in the interpreter's own tables, a
SCI `FONT` resource in a Volume. AGOS has none. Adventure Soft compiled the
glyphs into the interpreter executable, so a folder holding `GAMEPC`, a `.GME`
archive and a speech file contains every word the game says and no way to draw
one of them.

`src/engine/agos/gfx/drawText.ts` was written before this was decided and took a
`GlyphSource` rather than reading one, on the grounds that a caller with a font
supplies it and a caller without gets nothing drawn and a truthful answer about
why. That deferred the question. This answers it.

## The decision

**Read the font out of the game's own interpreter executable, locate it by
structure, and refuse to transcribe one into this repository.**

This is ADR 0024's rule a third time, and it is worth saying that it is the same
rule rather than a similar one. ADR 0024 met executable-resident _game data_ in
Beneath a Steel Sky and Lure of the Temptress and decided to "read executable
resident data out of the game's own executable" rather than accept ScummVM's
`sky.cpt` or `lure.dat`. A font is executable-resident data. Nothing about it
being pixels rather than object records changes which side of that line it falls
on.

It also widens the same clause. ADR 0024 widened `CONTEXT.md`'s **Published
game** to mean the files a release shipped "including its interpreter". AGOS is
the second family to need that clause and the first outside Virtual Theatre,
which is the evidence that the widening was a rule and not a Revolution quirk.

## The three options, and why the other two lost

**Read it from the interpreter.** Taken. It is what the release contains, it
needs nothing this project ships, and — the part that matters for a second
implementation — it can _disagree_ with ScummVM about what the bytes say.

**Ship nothing and let a caller supply a substitute font.** This is what the
code did before this decision, and it survives as the seam rather than as the
answer: `drawTextRun` still takes a `GlyphSource`, so a person with a font of
their own can pass one and an editor can preview with anything. What it cannot
be is the only route, because "bring your own font" is not an interpreter — it
is a way of not having written one.

**Transcribe the glyphs into source.** This is what ScummVM does:
`engines/agos/charset.cpp` carries `english_video_font`, `hebrew_video_font` and
their siblings as byte arrays. Refused here, and the refusal is the one worth
arguing rather than assuming.

The licence is not the objection, exactly as in ADR 0024: this project is
GPL-3.0-or-later and ScummVM is GPL-2.0-or-later, so copying would be lawful.
The objections are the same three that ADR 0024 raised, and they all survive the
change of subject:

- **It is content rather than format.** The README says this project "ships no
  game data: it reads the files of a game you own." A font table is not a
  description of how bytes are laid out; it is a picture of ninety-six letters
  that Adventure Soft drew. Every other decoding rule here reads a format.
- **A transcription cannot disagree.** The whole value of a second independent
  implementation is that it can be wrong differently. Starting from someone
  else's extraction of a binary means inheriting their reading of it — which is
  ADR 0013's failure exactly: the check passes, the structure is wrong, and
  nothing says so.
- **It would be the path under test.** ADR 0010 found that "two paths is worse
  than one", and named which one rots: the one exercised least. A shipped font
  would work for everybody and the executable reader would be exercised by
  nobody.

Rejected separately: **a table of per-release offsets keyed by hash.** That is
the artefact ADR 0020 argued against for SCI Version identification, and
adopting it here through the back door would be worse than adopting it
deliberately. An offset a person supplies for their own copy is admitted as an
override, and none is shipped.

## Finding it by structure, which is the gate ADR 0024 set

ADR 0024's gate asks one question of each family: are the bytes findable **by
structure** — a signature, a header, a layout the binary carries — or only by
offsets hardcoded per release? If the answer is the second, the decision was
taken wrongly and reopens.

For a bitmap font the answer is structure, and the properties are not shared by
anything else an executable contains:

- the space is blank, always, and it anchors the scan;
- every printable character is not blank;
- the outer columns carry a small fraction of the ink the middle ones do,
  because glyphs leave a gap so letters do not touch;
- the bottom row is quiet, because only descenders reach it;
- no glyph is solid.

`scoreFontTable` is those measures as a number between zero and one, and
`findAgosFont` takes the best-scoring offset above a floor. A score rather than
a set of hard tests, because a real font breaks any single one of them somewhere
— a box-drawing character is solid, a full-width glyph touches both edges — and
a scan that rejected a whole table for one awkward glyph would find nothing.
What no non-font survives is all of them at once.

**The score is reported rather than hidden.** A caller is told where the table
was found and how well it matched, because "the font was found" and "something
font-shaped was found" are different claims and a player debugging a garbled
screen needs to know which they have.

## What is proved and what is not

Tier 1, in CI: the scan, the scoring, the glyph decoding, the drawing, the
wrapping into a window, and right-to-left laid out end to end against a
synthetic executable built to be hostile — a run of zeros, a solid block, a
gradient, and bytes with no column structure.

**Tier 2, needing the discs:** whether a real `SIMON.EXE` yields the font that
release actually draws with. This ADR does not claim it does. The claim it makes
is narrower and testable: a release carrying a font in this shape is read, and a
release that does not is _told about_ rather than drawn with boxes.

## The tripwire

**If the structural scan does not find the font in real interpreters, this
decision is not yet earned.** The honest failure would be to add per-release
offsets quietly and keep the ADR as written. Reopen it instead, because a table
of offsets and ScummVM's transcription are then the same kind of artefact —
somebody's prior reading of a specific binary — and theirs is the better
maintained one. That is ADR 0024's own tripwire, and it is inherited here word
for word.

## Consequences

**A folder of game data alone draws no text**, and says so. This is a real limit
and it belongs stated rather than discovered: a player with a `GAMEPC` and a
`.GME` and nothing else has a game that runs, saves, moves through its world and
shows no words. `describeStatus` and `describeStall` both carry the sentence and
both name what would fix it.

**`CONTEXT.md`'s Published game keeps ADR 0024's widening**, now for a second
family, and gains AGOS as the example that made it a rule.

**Text direction gets exercised for the first time.** ADR 0028 put direction on
the release and `textLayout.ts` could only ever test where glyphs _would_ go.
With a font there are glyphs, and the property ADR 0028 is about — the two
directions filling the same box from opposite ends — is testable in ink.

**The `GlyphSource` seam stays.** Nothing above `drawTextRun` learns where a
font came from, which is what lets an editor preview with a substitute without
that becoming a second way for a game to be drawn.
