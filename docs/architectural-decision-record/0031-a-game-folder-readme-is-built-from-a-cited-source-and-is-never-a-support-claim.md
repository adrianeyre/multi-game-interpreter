# A game folder's README is built from a cited source, and is never a support claim

`games/<slug>/README.md` is a documented surface, not a scratch note. The player
reads its first line for the game's name, its second for a chip, and renders the
rest when a row is clicked (`games/README.md`, `src/ui/markdown.ts`). That makes
every one of these files a thing a user sees, and `docs/released-games.md` now
names 106 titles that each want one.

Two failure modes follow from writing 106 of them, and this ADR exists to close
both.

**The first is invented detail.** A README with a release date, a composer and a
plot summary reads as authoritative whether or not anyone checked it. Written at
this volume, from memory, some of it will be wrong, and nothing in the file will
say which parts.

**The second is an implied claim of support.** A polished page for _Phantasmagoria_
sitting in `games/` alongside a polished page for _Day of the Tentacle_ suggests
the two are equally playable here. They are not: one plays, and the other belongs
to a family where **no SCI game reaches its first screen yet**. The whole point of
`docs/processes/verifying-version-support.md` is that running is not finishing and
the difference gets recorded rather than smoothed over. A folder of confident
READMEs smooths it over.

## The decision

**Every factual claim in a generated game README is transcribed from one cited
public source, and the citation is in the file.** In practice that source is the
game's English Wikipedia article: the lead section, the infobox, and the lead
image. The article is linked under `## Elsewhere`, so a reader who doubts a date
has somewhere to go.

**Every README carries a `## How it runs here` section, and it is written from
this repository rather than from the source.** It is the honest status of the
Engine family and Version the title sits in — what is built, what has actually
been run, and what has not. It says "out of scope", "boots and renders, and is
not playable", or "no AGOS game reaches a screen" where those are true, in the
same words `docs/released-games.md` and
`docs/processes/verifying-version-support.md` use.

**No game README claims `Completable`.** That bar is defined in `CONTEXT.md` and
`docs/released-games.md` claims it for no title; a per-game file is not where it
gets claimed by implication either.

**The second line is the chip and nothing else.** `games/README.md` reads it as
one, and it must stay under sixty characters or it is treated as prose and no
chip is shown. Where a title's whole **Engine family** is out of scope, the chip
says so, because the chip is the first and sometimes only thing a reader takes
in.

**What the chip must not do is say that about a family this project supports**,
and the SCI chips did for a round after it stopped being true. `Sierra SCI2.1 —
not supported here` sat on a title whose family boots a retail install, plays
six screens into it, draws 88 of its 108 rooms and opens the whole of it as an
editable project. A reader takes "not supported here" to mean this project does
nothing with the format, and that was the false half. Per-title honesty — this
one has not been run, nothing here is `Completable` — belongs in
`## How it runs here`, which is the section this ADR gives it to, and the chip
stays the family and the Version.

## The shape of the file

Fixed, so 106 of them can be read the same way and regenerated without a diff
that is all noise:

```markdown
# <title> <- the name the player lists it under

                              <- blank

<chip> <- engine family + version, under 60 chars
<- blank
![Box art: <caption>](image.jpg)

<lead paragraphs, from the source article>

## At a glance <- infobox fields as a two-column table

## How it runs here <- this repository's honest status; ours, not theirs

## Where it sits in this project

## Elsewhere <- the citation, plus released-games.md and ScummVM
```

`image.jpg` is the article's lead image, fetched once and committed beside the
README. It is box art, and box art is **documentation, not game data**:
`games/README.md` already promises that a README and the images beside it are
kept out of the file list handed to the interpreter and out of the size the
player quotes. `.gitignore` encodes the same split — `games/*/*` is ignored and
`README.md`, `image.jpg` and `image.png` are negated back in, so a game's data
cannot be committed by accident while its documentation always can.

## Why generated rather than written

Because 106 hand-written pages would be 106 chances to be confidently wrong, and
because the interesting half of each file — `## How it runs here` — is the half a
generator cannot invent. Splitting them makes the boundary visible: the prose
above the fold is transcription and carries a link to check it against; the prose
below it is this project's own claim and is held to this project's own standard.

**A hand-written README is still allowed and still better.** `games/fate` is one,
and it is the reference: it says what release the copy is, what to expect from
this interpreter, and which iMUSE commands are missing. Nothing here forbids
that, and where somebody has actually played a game the generated file should be
replaced by what they learned. The generated shape is the floor, not the ceiling.

## Consequences

- A README can be regenerated when its source article changes, and the diff is
  confined to the transcribed half.
- Wikipedia is a single point of failure for the factual half. That is accepted:
  it is cited, so a reader can see exactly what the claim rests on, which is
  strictly better than the same sentences with no source at all.
- Titles with no article of their own — _Passport to Adventure_ is one — get a
  README that says so rather than one padded out to match its neighbours.
- The status sections duplicate `docs/released-games.md` by family. When that
  page changes, the generated READMEs are regenerated from it; the page stays
  the single source and the READMEs stay downstream of it.
