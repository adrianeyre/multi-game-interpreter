# Your games folder

Drop a game you own in here and the player lists it, so you do not pick files
through the browser dialog on every reload. That matters once the games get
big: Day of the Tentacle's data is about a megabyte and Sam & Max's talkie is
thirteen.

Three shapes work, and all three are what people actually have on disk:

```
games/
  dott/                  a folder per game — the tidy way
    DOTTDEMO.000
    DOTTDEMO.001
    MONSTER.SOU
  samnmax.zip            a zip, unpacked in your browser
  MONKEY2.000            loose files, offered as one entry
  MONKEY2.001
```

Then `npm start` and the games appear under the drop zone. `?game=dott` in the
URL loads one straight away, which is what you want while working on a fault.

## Name a game with its own README

Each game's row has a square play button on the right; clicking anywhere else
on the row opens what the folder says about the game. That comes from a
`README.md` inside it:

```
games/
  indy/
    README.md            what this game is, shown when the row is clicked
    image.jpg            a picture the README points at
    ATLANTIS.000
    ATLANTIS.001
```

The first two lines of that README do the work:

```markdown
# Indiana Jones and the Fate of Atlantis

SCUMM v5
```

- **The first line names the game.** `# Indiana Jones and the Fate of Atlantis`
  becomes the title in the list, in place of the folder name. A README with no
  heading at all is read for its first line of text instead, and a folder with
  no README is listed exactly as it always was.
- **The second line says what it runs on.** A short line of its own — `SCUMM v5`
  — is shown as a chip beside the name, so which interpreter a folder is for is
  visible before anything is loaded. It is what you wrote and nothing more:
  no index is opened to check it, and the loader's own detector still decides
  what the files actually are. A README that opens straight into prose gets no
  chip, which is what a paragraph longer than sixty characters means here.
- **The rest is shown when you click the row.** Headings, lists, quotes, fenced
  code, pipe tables, and inline emphasis, code, links and images are rendered.
  There is no markdown dependency here — `src/ui/markdown.ts` reads what a
  README is written in, and anything it does not read shows as its own text.
- **Pictures work, and relative paths are relative to the game's folder.**
  `![Box art](image.jpg)` finds `games/indy/image.jpg`.
- **Documentation is not game data.** A `README.md` and the images beside it are
  kept out of the file list handed to the interpreter and out of the size the
  player quotes before loading, so box art is never counted as part of a game.

The dialog carries the same play button at the bottom, so reading first costs
nothing: nothing is fetched until you ask for it.

**Loose files are handed over together.** The engine's own detector picks the
index and data pair out of them, exactly as it does for a folder you choose in
the browser — so two games loose in here means one of them loads and the log
says which. Give each a folder.

**Zips must be Deflate or stored.** Browsers decompress nothing else. The demo
zips on scummvm.org are original 1993 archives compressed with PKWARE's
Implode, so extract those and load the folder; the player says so rather than
leaving you to guess.

Nothing here is uploaded anywhere, and game data cannot end up in the
repository: `.gitignore` excludes `games/*/*` and negates exactly three names
back in — `README.md`, `image.jpg` and `image.png`. Documentation is tracked;
everything beside it is not.

## A folder per title, named after the title

Every game in [`docs/released-games.md`](../docs/released-games.md) has a folder
here, and the folder name is the game's title in lower case with hyphens between
the words:

```
games/
  day-of-the-tentacle/
  indiana-jones-and-the-last-crusade-the-graphic-adventure/
  quest-for-glory-ii-trial-by-fire/
```

Drop the game's data files into the matching folder and it loads under the name
its README already gives it. A folder with only a `README.md` and an `image.jpg`
is documentation for a game nobody here has a copy of, which is most of them —
the row is there to be read, and there is nothing to play until you supply the
data yourself.

**What is in each of those READMEs, and what it is worth**, is settled by
[ADR 0031](../docs/architectural-decision-record/0031-a-game-folder-readme-is-built-from-a-cited-source-and-is-never-a-support-claim.md).
The short version: the factual half is transcribed from the game's Wikipedia
article and links to it, so a date you doubt has somewhere to be checked; the
`## How it runs here` half is this project's own honest status for that Engine
family and Version, and says "out of scope" or "not playable" where those are
true. `games/fate` is hand-written and is the better thing — where somebody has
actually played a game, the generated file should be replaced by what they
learned.

## AGI games

The player runs Sierra's AGI as well as SCUMM (`CONTEXT.md` calls them two
**Engine families**), and an AGI game goes in here the same way. Its files look
different, which is how the loader tells them apart:

```
games/
  somegame/              an AGI v2 game
    LOGDIR
    PICDIR
    VIEWDIR
    SNDDIR
    VOL.0
    WORDS.TOK
    OBJECT
  anothergame/           an AGI v3 game — one combined index, prefixed volumes
    AGDIR
    AGVOL.0
    WORDS.TOK
    OBJECT
```

**Include `AGIDATA.OVL` if the game has one.** It is the interpreter's own
argument-count table, and it is what lets the version be _read_ rather than
assumed. A game whose version was assumed still plays — on a documented default,
with the fallback logged — and is refused for editing, because decoding with the
wrong table misreads every instruction boundary after the first mismatch and
re-emitting with the same wrong table writes that misreading back byte for byte
(ADR 0013).

### Fetching one

```
npm run fetch:agi
```

with no arguments prints where freely redistributable AGI games can be found —
there are over 180 fan games made with AGI Studio and WinAGI, and unlike
Sierra's own releases they may be redistributed. Give it a URL, an id and the
licence to fetch one:

```
npm run fetch:agi -- https://example.org/somegame.zip somegame \
    "Freeware fan game, released by its author"
```

The licence is a required argument rather than an optional note, because stating
it is the act of having checked it.

### Nothing here is ever committed

Game data in `games/` is gitignored and stays that way — the folders and their
`README.md`/`image.jpg` are tracked, and nothing else in them can be. So is
`public/games/`, which
deploys to the live site — committing there would redistribute someone else's
game from our own domain. The README's "It ships no game data" is load-bearing
and does not get qualified.

The consequence is accepted rather than worked around: CI runs on a synthetic
fixture, so AGI has the same blind spot SCUMM does. `docs/processes/verifying-version-support.md`
is where that trap is described, and the escape from it is running
`npm run diagnose` against a real game locally:

```
npm run diagnose -- games/somegame
```
