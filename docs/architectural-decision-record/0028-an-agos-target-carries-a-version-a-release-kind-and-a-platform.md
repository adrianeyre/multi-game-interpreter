# An AGOS Target carries a Version, a release kind and a platform, and language stays out of it

ADR 0016 fixed what a SCI Target holds; this is the same question for AGOS, and
it is worth its own record because AGOS is the family that tested
`CONTEXT.md`'s language rule and came within one lift of breaking it.

## The Target is the family, the Version, the release kind and the platform

The Version is a title (ADR 0027). The **release kind** — floppy or talkie — is
here because ADR 0027's tripwire fired: the title does not fix the instruction
encoding on its own. Simon 1 and Simon 2 each decode two opcodes differently
between their floppy and talkie releases, so the pair of them is what selects an
argument table. The platform is what changes the graphics encoding and the
packaging: DOS, Windows, Amiga, Atari ST, Acorn and Macintosh releases of one
game differ in both while agreeing about every instruction.

That is AGI's shape rather than SCI's. AGI carries an Interpreter version
because its major says nothing about the encoding; AGOS carries a release kind
because its title says _almost_ everything about it. Both are the same lesson:
what a Target must hold is whatever decoding actually depends on, which is
discovered rather than assumed.

**The release kind is not the same claim as `CONTEXT.md`'s Talkie**, though it
picks out the same releases. Talkie describes what a release ships — recorded
speech in an external file. This says that fact participates in decoding, which
is a stronger and less obvious statement, and it is why the release kind sits on
the Target rather than being read off the files at load time.

**Only DOS and Windows are in scope**, and the platform stays on the Target
anyway. Amiga, Amiga CD32, Atari ST, Acorn and Macintosh packagings are declined
in `.out-of-scope/agos-non-dos-releases.md`, on the argument this repo already
makes for SCUMM, AGI and SCI: they are a second way to load games that already
play. Every AGOS game has a DOS or Windows release, so declining them costs no
game — and it costs the family's scope nothing either, because ADR 0030's split
between packaging and encoding is what makes adding one later additive.

## Language is not in it, and Hebrew is why that had to be argued

`CONTEXT.md` says language "changes which resources a game ships, not how any
byte decodes, so it is a selection made over a loaded game rather than a
property of the Project". AGOS breaks the second half of that sentence and not
the first.

An AGOS release is **built** per language rather than assembled from language
resources: the text lives inside `GAMEPC`, so there is no selection to make over
a loaded game — a German Simon is a different `GAMEPC`, not a different resource
picked from the same one. And the Hebrew release of Simon 1 is laid out right to
left, which ScummVM handles with language checks in its drawing code.

The rule still holds, because neither fact is about decoding. A German `GAMEPC`
decodes byte for byte like an English one, and a right-to-left release's
instructions are identical to a left-to-right one's. What had to be lifted out is
the layout: **Text direction** becomes a property the loaded release declares,
read by the renderer when it places a run of glyphs, with left-to-right as the
degenerate case rather than the default-with-an-exception. That is ADR 0007's
move a fourth time — widen the data so nothing asks which release it is.

Rejected: **language joins the Target for this family.** Truthful about
per-language builds, and it would make every AGOS Project carry something the
other three families deliberately excluded, turning a cross-family sentence into
a family-specific one for a fact that changes no byte's meaning.

Rejected: **Hebrew out of scope.** One release, cheaply excluded, and "all
versions" would then quietly mean "all left-to-right versions". Recording an
exclusion is only honest when the thing excluded is genuinely unreachable; this
one is a property on a release.

## Which releases are admitted

Original releases **and** the forms these games ship in today: GOG and Steam
builds, the 25th Anniversary Edition's data, fan translations, and speech
re-encoded to MP3, Ogg or FLAC by ScummVM's tools — which the browser decodes
through WebAudio at no cost to us.

This follows ADR 0020's reasoning rather than contradicting it. Probing beats
hashing **because** fan-made and modified data exists; a release list built from
known md5s would refuse the copies most owners actually have. A hash stays
available as a tiebreaker, never as the mechanism.

## Consequences

`CONTEXT.md` gains **Text direction** as a term, and its Target entry gains the
AGOS composition plus a paragraph recording that the language rule was tested
here and survived only because direction was liftable out of it. A future reader
who finds the rule under pressure again should know it has already bent once.

Accepting repackaged data means the Version probe must survive input Adventure
Soft never produced. That is a stronger requirement than "identify the shipped
releases", and it is deliberate: the probe reads structure, so it should not
care — and if it turns out to care, that is a finding about the probe rather
than about the data.

One consequence is not paid here. `CONTEXT.md`'s claim that a Project holds
**all** of a release's languages, written for SCI's Messages, has nothing to
bite on in AGOS: a release ships one language and an AGOS Project holds that
one. Two languages means two Projects, which is a true statement about the games
rather than a limitation of the editor.
