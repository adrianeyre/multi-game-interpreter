# A `GAMEPC` tail outside the runtime database is preserved, rather than making the game uneditable

`GAMEPC` has no index. ADR 0030 settled the consequence — the file is rebuilt
whole or not at all — and ADR 0029 made byte-identical re-emission one of three
conditions for offering an AGOS game for editing at all. Together those two
decisions say something sharper than either says alone: **one unmodelled byte
anywhere in the file makes the whole game read-only.**

Three releases have such bytes, and they are not bytecode. The Elvira 1 and
Waxworks demos carry them (#291), and so does the retail Windows release of
Simon the Sorcerer — 7,909 bytes of them, appended after the Subroutine block:

```
... 7f 00 05 "sting0" 00 00 00 00 00 00 00 00 80 00 05 "AddSPTRs"
00 00 00 00 00 00 00 00 c3 00 05 "StripTPTRs" 00 ... c4 00 05 ";END 0 0."
```

A development build's **symbol table**: a name, a number, and a `;END 0 0.`
marker. The `AddSPTRs` and `StripTPTRs` entries are the compiler's, not the
game's.

Before this decision the project called that region a re-emission failure. The
report was accurate — a rebuild really did come out 7,909 bytes short — and the
conclusion drawn from it was wrong. Somebody who dropped a legally owned retail
copy of Simon 1 into the editor was told "the game did not re-emit byte for
byte" about a game every byte of whose runtime database had been decoded
correctly.

## The decision

**Read the bytes after the Subroutine block as `CONTEXT.md`'s Preserved bytes,
carry them on the model, and write them back unchanged.** The region is then
part of the rebuild, byte-identity holds over the whole file, and the game is
editable on the same three conditions as any other.

`AgosGamePc.trailing` is that region. It is empty for most releases, so the
common case contributes nothing and there is no branch: the writer appends it
either way.

## Why this is preservation and not a widened fallback

`CONTEXT.md` is deliberately hostile to fallbacks here. **Unrecovered** is "a
defect with a target of zero, not an escape hatch", and the fix for one "is a
better decompiler, never a wider fallback". So the case for this has to be that
the region is **Preserved bytes** — "carried out of a Published game and back
into one unchanged, because no importer can turn it into editable steps" — and
not an Unrecovered region relabelled.

It is, on the test the two definitions actually differ on: _does the running
game read it?_ Preserved bytes are bytes with meaning this project declines to
model. Unrecovered is structure this project failed to recover. This region has
no runtime meaning to fail at. `AGOSEngine::readGamePcFile` reads the header,
the text, the items and the Subroutine block, and returns; the file handle
closes. Nothing in the reference ever seeks past the block, in any Version. The
appended bytes are not data the game needs, not bytecode a decompiler could get
better at, and not a resource the interpreter addresses — they are a region the
shipped interpreter also ignores.

That is the load-bearing claim and it is the one to attack if this is wrong. If
some Version turns out to read past the Subroutine block, this decision is
wrong, and the symptom will be a game that misbehaves in a way no instruction
explains.

## The three options, and why the other two lost

**Preserve the region and re-emit it.** Taken.

**Go on refusing to edit.** This was the standing decision, and its argument was
real: a region the model cannot produce means the model is incomplete, and
`GAMEPC` is all or nothing. What sank it is that it makes the _whole_ of a
retail game read-only over a region the game does not use — and the count it
produced said `Unrecovered: 1`, which by `CONTEXT.md`'s own definition is a
defect somebody is supposed to fix by writing a better decompiler. There is no
decompiler to write. The number was pointing at nothing.

**Model the symbol table as structure.** Refused, and this is the option worth
arguing rather than assuming. The format is legible — the excerpt above was read
in an afternoon — so this is not a "too hard" refusal.

It loses on scope and on honesty. On scope: the table names the compiler's own
internals, so modelling it means holding a build tool's symbol table in a
Project that describes a game, and keeping the two consistent through every edit
a person makes. On honesty: a modelled symbol table would be _stale_ the moment
somebody adds a Subroutine, and a stale symbol table that the project claimed to
understand is worse than an opaque region it claims nothing about. Preserved
bytes make the claim the project can actually stand behind — _these bytes came
out of your file and went back into it unchanged._

## What this changes

- `AgosGamePc` gains `trailing`, and `writeGamePc` appends it.
- Simon 1's retail Windows release, the Elvira 1 demo and the Waxworks demo
  become editable, with `Unrecovered: 0`.
- The `partial` identification in `resource/agosDetect.ts` stays. It answers a
  different question — _did any Version read this file at all?_ — and is still
  the right answer for a file no Version can read whole. What it no longer has
  to cover is an appended tail, because there is no longer anything partial
  about reading one.
- `docs/released-games.md`'s AGOS section no longer says a demo "plays and is
  refused for editing".

## What it does not change

Nothing about the other two of ADR 0029's conditions. A Version still has to be
probed rather than narrowed, and **Structural agreement** still has to hold over
the whole game. This decision widens what counts as re-emitting the file, and
only for a region with nothing in it to get wrong.
