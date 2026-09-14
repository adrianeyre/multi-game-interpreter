# Virtual Theatre on Amiga, Atari ST and CD32

**Decision: not in scope.** Settled while scoping the Virtual Theatre families
(ADRs 0023, 0026).

Both of Revolution's Virtual Theatre adventures shipped beyond DOS. Lure of the
Temptress saw Amiga and Atari ST releases; Beneath a Steel Sky saw Amiga and
Amiga CD32. **The DOS releases are in scope and the others are not.**

This note used to argue that Lure of the Temptress itself was out of scope. That
was overtaken: Lure is now in scope as a fifth Engine family (ADR 0026), and
what survives from the old note is only the platform half.

## Why it is declined

**The ordinary reason.** They are other releases of games that already play, not
new games. That argument has now refused AGI's booter and Apple II releases,
SCUMM v0/v1 and its ports, and SCI on Amiga, Macintosh and Atari ST. It refuses
these too, and being the fourth and fifth families to hear it does not weaken
it.

**The reason particular to Virtual Theatre, which is sharper.** ADR 0024 reads
each game's executable-resident data — Sky's Compacts, and Lure's equivalent —
out of the game's own **DOS executable**, because that is where Revolution
compiled it. An Amiga or Atari ST release has no such file.

So this is not the usual "a second resource layer under an interpreter that
would not notice" that `.out-of-scope/sci-non-dos-releases.md` describes.
Supporting a non-DOS Virtual Theatre release means writing a second extractor
against a second binary format, to recover a table this project can already
recover, for another release of a game already in scope. The resources are not
the work here and neither is the bytecode: the **world** is, and it lives in a
file those platforms do not have.

That makes it the strongest platform refusal in `.out-of-scope/` rather than the
weakest, and worth stating as such: for SCUMM and SCI a port is deferred work,
whereas here it is a second solution to the family's hardest problem.

## What is kept

`SkyPlatform` and `LurePlatform` exist in the Target type with only `dos`
implemented, following `SciPlatform` and `AgiPlatform` before them. Adding one
later is a value and a resource-layer implementation — plus, for these two, an
executable extractor, which is the larger half.

## What would change this

A reason a DOS release does not serve, and an answer to where the non-DOS
release's executable-resident data comes from. ScummVM's `sky.cpt` and
`lure.dat` are not that answer, for ADR 0024's reasons.
