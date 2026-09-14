# A SCI Target carries a Version and a platform, and nothing like AGI's interpreter field

ADR 0012 made `Target` a discriminated union because AGI broke a version number
twice: once because AGI's majors are not points on SCUMM's scale, and once
because an AGI major does not determine the encoding at all — the arity table
lives in `agidata.ovl` and varies by build, by platform and for three titles by
game.

A reader who knows that story will expect SCI's arm to look like AGI's. It does
not, and the reason is worth recording because "Sierra, therefore an interpreter
version field" is exactly the wrong inference.

## SCI ships its own meaning-tables

A SCI script names Selectors and classes by index into tables that are in the
game: `vocab.997` for Selector names, `vocab.996` for the class table. There is
no external arity table, no per-build drift and no per-title correction list —
nothing that would make this arm grow AGI's `gameId?` field.

Instruction lengths are self-describing too. The low bit of the opcode byte
selects 8-bit or 16-bit operands, so boundaries are **derived** rather than
measured. That single fact is why `CONTEXT.md`'s Decompilation is available for
SCI and not for AGI, and it is load-bearing for ADR 0018.

What SCI does not carry is the **Kernel table**. Kernel calls are by number into
a table that lives in Sierra's interpreter, and `vocab.999` names them only in
SCI0 and SCI01. From SCI1 on it is gone. That is the whole reason a SCI Target
has to name a Version.

## The Version axis is finer than the catalogue's six

`SCI0 | SCI1 | SCI1.1 | SCI2 | SCI2.1 | SCI3` are the names the catalogue uses
and they are not Versions. The seams where decoding actually changes are finer:
SCI0 early/late, SCI01, SCI1 EGA-only, SCI1 early/middle/late, SCI1.1, SCI2,
SCI2.1 early/middle/late, SCI3 — roughly ScummVM's own split, and it splits
there because the map format, the View format and the Kernel table move there.

> **Checked by #214, and confirmed unamended.** That list was written from
> memory. It is exactly ScummVM's `SciVersion` enum
> (`engines/sci/detection.h:118-133`): thirteen enumerators in that order, with
> the same titles against each. The axis needed no correction — what it was
> missing was the _reason_ per seam, which the ADR asserted in one sentence for
> all thirteen at once. Those are now recorded one per Version, with the ScummVM
> function that tells the seam apart, in `src/engine/sci/sciVersion.ts`.
>
> Three of the thirteen carry a note that the reason is **asserted** rather than
> read: `sci01`, `sci1-ega-only` and `sci2-1-late`. The last is the interesting
> one — ScummVM's own comment separates the late SCI2.1 tiers by _which build_
> of the same titles they are, which is a statement that the seam is not in the
> data at all. A game landing there is a candidate for ADR 0020's declared path
> rather than for a probe, and #228 should not go looking for one.

Prose, issues and branch names write `SCI1 late`, never bare `SCI1`. This is the
same discipline ADR 0012 imposed for bare `v3`, for the same reason: the short
name silently names three different things.

## The definition of Target moved

`CONTEXT.md` said a Target was everything needed "before its **bytecode** can be
read". That always understated it — a SCUMM Version fixes the Resource layout as
much as the encoding — and SCI made the gap visible, because SCI's platform
changes View cel encoding, palettes and packaging while leaving the bytecode
untouched. The definition now reads _bytes_, instructions and resources alike.

Without that change, `platform` on this arm is smuggled in by analogy with AGI's,
where it belongs for a reason that does not apply here: on Apple IIgs an AGI
instruction changes length and one changes opcode number. No SCI platform does
anything of the kind.

## What is deliberately not on it

**Language.** It changes which resources ship, not how a byte decodes. SCI0's
parser vocabulary is language-specific and looks like a counterexample; it is
not, because `vocab.000` is a resource and arrives with the game.

**The Windows hi-res flag.** SCI1.1 and later "Windows" releases are the same
DOS-loadable data with an alternate palette or hi-res variant chosen at runtime.
That is a display option inside a supported game and belongs to the resource
layer.

## Consequences

```ts
| { engine: 'sci'; version: SciVersion; platform: SciPlatform;
    identification?: SciIdentification }
```

`SciIdentification`'s name was left open here and is settled in
`src/engine/sci/sciVersion.ts`: it follows `ScummIdentification` rather than
`GameDetector.ts`'s `VersionIdentification`, because it lives beside
`ScummIdentification` and `InterpreterIdentification` in `src/authoring/target.ts`
and both of those are prefixed by the axis they identify. A third one there
called `VersionIdentification` would read as the general case of the other two.

`SciPlatform` exists with only `dos` implemented, exactly as `AgiPlatform` did
before it. Non-DOS releases are out of scope and recorded in
`.out-of-scope/sci-non-dos-releases.md`.

`identification` carries ADR 0013's rule unchanged — play on a guess, refuse to
edit on one — and ADR 0020 decides how a Version is established, because SCI
stamps one nowhere.

A re-release in a different Version is a different Target and therefore a
different Project. King's Quest IV shipped as AGI v3 and as SCI0; they are two
games that share a name. There is no cross-Version game identity concept, and
none is needed: the save guards already refuse across engine families before
they compare a game's id at all.
