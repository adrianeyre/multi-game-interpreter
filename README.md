# MGI — Multi Game Interpreter

A web-based interpreter for classic adventure engines, written in TypeScript. It
runs in the browser on a `<canvas>`, with no plugins, no WebAssembly and no
server-side component.

**Eight Engine families have an interpreter here.** None of the games below is a
program: each is a set of data files containing rooms, sprites and **bytecode**,
run by an interpreter. This project is such an interpreter, written from scratch
against the formats, using [ScummVM](https://github.com/scummvm/scummvm) as the
reference for how the originals behave.

| Engine family                                                                        | Whose, and what it ran                                                  | The whole axis                            |
| ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ----------------------------------------- |
| [**SCUMM**](https://en.wikipedia.org/wiki/SCUMM)                                     | LucasArts — _Script Creation Utility for Maniac Mansion_                | v2 through v8                             |
| [**AGI**](https://en.wikipedia.org/wiki/Adventure_Game_Interpreter)                  | Sierra — King's Quest, Space Quest, Leisure Suit Larry                  | v2 and v3                                 |
| [**SCI**](https://en.wikipedia.org/wiki/Sierra_Creative_Interpreter)                 | Sierra — what replaced AGI                                              | thirteen Versions, SCI0 early to SCI3     |
| [**AGOS**](https://en.wikipedia.org/wiki/Adventure_Soft)                             | Adventure Soft — Elvira, Waxworks, Simon the Sorcerer, The Feeble Files | seven Versions, each named after its game |
| [**Sky**](https://en.wikipedia.org/wiki/Revolution_Software)                         | Revolution Software — Beneath a Steel Sky                               | three Releases: demo, floppy, CD          |
| [**Lure**](https://en.wikipedia.org/wiki/Revolution_Software)                        | Revolution Software — Lure of the Temptress                             | two Releases: demo, floppy                |
| [**Sword1**](https://en.wikipedia.org/wiki/Broken_Sword:_The_Shadow_of_the_Templars) | Revolution Software — Broken Sword: The Shadow of the Templars          | three Releases: demo, cd, psx             |
| [**Sword2**](https://en.wikipedia.org/wiki/Broken_Sword_II:_The_Smoking_Mirror)      | Revolution Software — Broken Sword II: The Smoking Mirror               | three Releases: demo, cd, psx             |

**How far each of the eight actually gets differs enormously, and
[`docs/released-games.md`](docs/released-games.md) is the page that says so
per family rather than hiding it behind the word "supported".** SCUMM v4, v5 and
v6 have real games behind them and v7 boots without playing; SCI answers King's
Quest IV's copy-protection prompt and reaches its throne room, and packs an
edited game back into its own container to play it; AGI walks King's
Quest III through five rooms; AGOS runs the opcodes common to every Version and
names the rest; Sky reaches a room; Lure reads and edits its world without
running its bytecode; Broken Sword runs, draws and edits and skips its
cutscenes; Broken Sword II runs, draws and edits and does not walk. **`Completable`
(`CONTEXT.md`) is claimed for no title in any family.**

A ninth family is part-built and deliberately not on that list. **SLUDGE** —
the engine behind fourteen freeware indie adventures — has a container reader
and a disassembler checked against a real shipped game, and **no interpreter**,
so it is still refused by name rather than run. The bar for joining the eight is
having an interpreter's foundation, which seven families have crossed in turn,
and a reader is not one.

`CONTEXT.md` calls each an **Engine family**, and the word matters: they share
no bytecode, no resource layout and no renderer. They are separate engines side
by side under one app shell, not one engine with a wider version range. The two
Broken Swords are the sharpest case: same publisher, same title, same naming
scheme, and not one byte of format in common — which is why they are two
families rather than one game's two Releases (ADR 0036).
That is what the name now says: **MGI** — _Multi Game Interpreter_ — is the app
shell, and each engine family sits under it. The package is `mgi-web` and the
repository is `adrianeyre/multi-game-interpreter`. ADR 0011 argued for keeping
the old `scumm` name as a historical one and deferring the rename; the rename
has since been taken.

## What this is, and what it is not

**This is an interpreter. It ships with no game data.**

To play something you need the data files from a game you own — an original
disc, or a copy from GOG or Steam. Point the engine at them and it runs them.
Nothing is uploaded anywhere: the files are read in your browser and stay on
your machine.

Writing an interpreter for a documented file format is not the same thing as
distributing the games, and this repository contains none of their content.

## Quick start

```bash
npm ci
npm start          # dev server on http://localhost:5160
```

Then click **Open game folder…**, or drag the game's files onto the page.

Three other buttons in the title bar are worth knowing. **Releases** opens
[`docs/released-games.md`](docs/released-games.md) in a dialog — every SCUMM and
Sierra release by Version, and which of them run here. **Boot** switches between
the file section and the game, either way round. And **Load** opens your saved
games: the games this browser holds saves for, then that game's ten slots.

**Save** pauses the game and shows the same board of ten slots, each one named
by you rather than numbered — the room you are standing in is offered as a
starting point. Saves live in this browser and nowhere else: they are not files,
[ScummVM](https://github.com/scummvm/scummvm) cannot read them, and clearing
this site's data deletes them.

Picking a save for a game that is not running loads it first where it can — a
game in your `games/` folder — and otherwise says which game to open and
restores the save the moment its files arrive. Game data is never kept between
visits; it is far too big, and this project never copies it anywhere.

What a game's files look like depends on its version, and the engine works out
which from their shape rather than their names:

| Game                                   | Files                                  |
| -------------------------------------- | -------------------------------------- |
| Loom (CD)                              | `000.LFL`, `DISK01.LEC`, `901–904.LFL` |
| Monkey Island 2: LeChuck's Revenge     | `MONKEY2.000`, `MONKEY2.001`           |
| Indiana Jones and the Fate of Atlantis | `ATLANTIS.000`, `ATLANTIS.001`         |
| Day of the Tentacle                    | `TENTACLE.000`, `TENTACLE.001`         |
| Full Throttle                          | `FT.LA0`, `FT.LA1`                     |

Some releases name them `.LA0` / `.LA1`; both are handled. A `.zip` can be
dropped in as-is — it is unpacked in the browser, as long as it is Deflate or
stored; browsers decompress nothing else, and the original 1993 archives on
[scummvm.org](https://scummvm.org) are PKWARE Implode, so those need extracting
first. The player says which compression it could not read rather than reporting
a missing index file.

### The `games/` folder

Picking a folder through the browser dialog on every reload gets old once the
games get big — Sam & Max's talkie is thirteen megabytes. So `npm start` also
serves a `games/` folder next to `package.json` and lists what is in it under
the drop zone:

```
games/
  dott/                  a folder per game
    README.md            names the game and describes it
    image.jpg            a picture the README points at
    DOTTDEMO.000
    DOTTDEMO.001
    MONSTER.SOU
  samnmax.zip            a zip, unpacked in your browser
  MONKEY2.000            loose files, offered as one entry
  MONKEY2.001
```

Each game gets a square play button and a row beside it. The button loads the
game; the row opens the game's own `README.md`, rendered, with a **Play game**
button at the bottom of it. That README's first two lines are the name and the
interpreter:

```markdown
# Day of the Tentacle

SCUMM v6
```

so a folder called `dott` is listed as _Day of the Tentacle_ with **SCUMM v6**
beside it, and a folder without a README is listed exactly as it always was.
The interpreter line is the author's label rather than a detection — nothing
opens the index to check it. `games/README.md` describes the convention; a
README and its images are never treated as game data.

`?game=dott` in the URL loads one straight away. The whole folder is
git-ignored, so game data cannot end up in the repository, and a game loaded
this way can be handed to the editor with **Edit** exactly like a picked one.

The listing needs the dev server, because a browser cannot list a directory over
HTTP. A static build shows no list and the picker is the only route — there,
`public/games/<id>/` with a `manifest.json` still works and is documented in
`public/games/README.md`.

### Which games this runs

**SCUMM v2 through v8** — every DOS Version LucasArts shipped the engine as.
v2 is Maniac Mansion and Zak McKracken; v3 is Indy 3 and Loom floppy; v4 is
Monkey Island 1 and Loom CD; v5 is Monkey Island 2 and Fate of Atlantis; v6 is
Day of the Tentacle and Sam & Max; v7 is Full Throttle and The Dig; v8 is The
Curse of Monkey Island. All seven are read, played and edited by the same
shell, and each is a delta on one of two script engines rather than an
interpreter of its own.

**What that sentence does not say is how far each has been played**, and the
difference is worth more than the range. v5 has been played from its first
screen through five rooms; v4 boots, renders and plays into its first room;
v6 and v7 have real games behind them. v2, v3 and v8 have a synthetic fixture
and no more — nobody here has a copy of Maniac Mansion, Indy 3 or The Curse of
Monkey Island, so what is claimed for those three is that they load and run,
not that they finish.
[`docs/processes/verifying-version-support.md`](docs/processes/verifying-version-support.md)
records exactly which evidence each Version has, and is the honest version of
this paragraph.

**Sierra AGI v2 and v3.** v2 is the bulk of the catalogue — King's Quest 1–3,
Space Quest 1–2, Leisure Suit Larry 1, Police Quest 1 — with four `*DIR` index
files over `VOL.n`. v3 is the later releases, with one combined `<GAMEID>DIR`
index and LZW-compressed volumes; it changes packaging only, so both share one
Logic interpreter. Drop an AGI game's folder in and it is recognised, loaded and
run — see [the games folder](#the-games-folder) for what an AGI game looks like
on disk and why `AGIDATA.OVL` is worth including.

Earlier AGI releases — the DOS self-booting floppies and the Apple II disk
images — are **out of scope** and say so in
[`.out-of-scope/agi-booter-and-apple-ii.md`](.out-of-scope/agi-booter-and-apple-ii.md).
Every title in scope has a DOS release with a `LOGDIR`, so those would be a
second way to load games that already play rather than a way to load new ones.

ScummVM supports around eighty _different_ engines, and
most of the games it plays are not SCUMM at all. Data for another engine is
detected and named rather than failing with a vague error:

> Beneath a Steel Sky is not a SCUMM game — it runs on ScummVM's "Sky" engine,
> which is a completely different interpreter with its own bytecode and file
> formats.

Engines leave that list when they gain an interpreter here, and four already
have: AGI at #125, SCI at #216 — King's Quest IV onward, Gabriel Knight — after
ADRs 0015–0021 settled it as a third family, AGOS at ADRs 0027–0030, and Sky at
#255.

**Revolution Software's two adventures have both left it now.** ADRs 0023–0026
settle Beneath a Steel Sky and Lure of the Temptress as a fourth and fifth
Engine family — **Sky** and **Lure**, two interpreters and not one — and each
has an Engine: `SkyEngine` boots the freeware CD release, enters its opening
section and runs its scripts; `LureEngine` reads the eight disk containers and
the initial world state. Both are editable, in the sense ADR 0025 defines and
no wider: the **object table** is the editable surface, and each game's
bytecode is **Disassembly** — a read-only listing — because whether either
encoding makes instruction boundaries certain is not yet known, and that is a
question each family answers for itself.

Neither is finished, and the two are not equally far along. **Sky reaches a
room** on the freeware CD release — the opening screen drawn, seven hotspots the
pointer finds, a click running the game's own script — and what is still missing
is the walk grid, so nobody walks anywhere, and the sprites that would stand in
it (#256). **Lure runs no scripts at all** — its bytecode is a separate system from Sky's
and this project reads neither yet — but it reads its world and edits part of
it: 49 palettes, and where each of 125 hotspots stands, read out of the game's
own executable. Export is refused for both. See
[`docs/released-games.md`](docs/released-games.md) for what is decided, what is
built, and the numbers behind each.

Three things about them are worth knowing even before they run.

Revolution's own name for the engine is **Virtual Theatre**, and it is
deliberately not used as a family name, because it names _two_ interpreters —
ScummVM implements them as separate engines sharing no code, and so does this
project. "The Virtual Theatre families" is the correct phrase.

**Sky's world is not in its data files, and Lure's turned out to be.** ADR 0024
assumed both games compiled their object table — Sky's records are called
**Compacts** — into the executable. That was right about Sky and wrong about
Lure, and the ADR records the correction rather than quietly absorbing it: the
premise came from ScummVM shipping a generated `lure.dat` and nobody had checked
what that file actually held.

For **Sky** it holds. The original 1994 discs ship `SKY.EXE` — but **neither
freeware BASS release does**, and the freeware CD ships `sky.cpt` instead. That
file is accepted, unusually: Revolution gave ScummVM the game's source code in
2003, so it is part of that release rather than somebody's reading of a binary.
The freeware **floppy** ships neither and is refused by name; so is the DOS
demo, which ships `SKY.EXE` whose reader is not written (#246, #252).

For **Lure** it does not. Its world state is resource **16398** inside
`Disk2.vga`, 37,504 bytes — the same length as a save slot, loaded by the
executable into the very buffer a restored save goes into, which is what settled
it. So it is read with the container reader rather than extracted from a binary,
and ScummVM's `lure.dat` stays refused with no reason left to want it.

**Both are freeware**, released by Revolution in 2003, which makes them the only
games here whose data a build machine may legally fetch — and therefore the only
place this project can check itself against real shipped bytes instead of
against a fixture built from its own reading of the format.

That is worth stating plainly because the
[ScummVM freeware page](https://www.scummvm.org/games/) offers fourteen games
and **none of them are SCUMM** — Beneath a Steel Sky is Sky, Flight of the
Amazon Queen is Queen, Dráscula and Sołtys and Lure each have their own engine.
Supporting any of them would mean writing that engine, which is a different
project.

For something free that _does_ run here, the LucasArts demos at
[scummvm.org/demos](https://www.scummvm.org/demos/) are real SCUMM. The
**Indiana Jones and the Fate of Atlantis DOS demo** is v5 and is the best thing
to test with.

## Scripts

| Script                  | What it does                                             |
| ----------------------- | -------------------------------------------------------- |
| `npm start`             | **Runs the web server** (Vite) on port 5160              |
| `npm run dev`           | Same as `npm start`                                      |
| `npm run build`         | Type-checks and builds the app into `dist-web/`          |
| `npm run build:lib`     | Builds the engine as an importable ES module in `dist/`  |
| `npm run build:demo`    | Compiles the bundled example game to `public/games/demo` |
| `npm run build:game`    | Compiles any authored game (see below)                   |
| `npm run serve`         | Serves a production build on port 4173                   |
| `npm test`              | Runs the test suite                                      |
| `npm run test:coverage` | Tests with coverage                                      |
| `npm run typecheck`     | `tsc --noEmit`                                           |
| `npm run lint`          | ESLint                                                   |
| `npm run format`        | Prettier                                                 |

## Developing with Sandcastle

Some of the work here is done by an agent rather than by a person, and
[Sandcastle](https://github.com/mattpocock/sandcastle) is what runs it: a
coding agent, in a container, against a checkout of this repository, with the
commits it makes landing on a branch you can open a pull request from. The
configuration is committed in `.sandcastle/`, so setting it up is a matter of
supplying tokens and building the image.

```bash
cp .sandcastle/.env.example .sandcastle/.env   # then fill in the tokens
claude setup-token                             # for CLAUDE_CODE_OAUTH_TOKEN
npx sandcastle docker build-image              # build the sandbox image
npx tsx .sandcastle/main.ts                    # run it
```

You need Docker running, a Claude credential — an OAuth token from
`claude setup-token`, or `ANTHROPIC_API_KEY` — and a fine-grained `GH_TOKEN`
with **Issues: read and write** so the agent can read the queue and comment on
what it picks up. `.sandcastle/.env` is git-ignored and stays that way.

| Path                     | What it is                                                     |
| ------------------------ | -------------------------------------------------------------- |
| `.sandcastle/Dockerfile` | The sandbox image — Node 26, git, `gh`, the Claude Code CLI    |
| `.sandcastle/main.ts`    | Which agent, which sandbox, which branch strategy, which hooks |
| `.sandcastle/prompt.md`  | What the agent is asked to do — blank until you write it       |
| `.sandcastle/.env`       | The tokens, never committed                                    |

Two things are worth knowing before the first run. The image installs no
project dependencies on purpose — `npm ci` belongs in a sandbox hook, where it
runs against the checkout the agent is actually looking at. And Docker is a
bind-mount provider, so Sandcastle's default branch strategy is `head`, which
means an agent editing the files you have open; name a branch instead if you
intend to review the result.

An agent working in here has to be told the same rules a person follows:
Conventional Commits, because [semantic-release](#releases) reads them;
`format:check`, `lint`, `typecheck`, `test` and `build` all passing before a
commit; `CONTEXT.md` for the vocabulary and
`docs/architectural-decision-record/` for the decisions already taken; and the
one rule this project does not bend — **no game data, ever**, in a commit or
anywhere else.

There is a limit worth being clear about: a sandbox has no games in it, so an
agent cannot run the sweep, diagnose or shot scripts unless you mount a game
folder read-only, and it cannot see a rendered frame at all — the test
environment is `node` and the image has no browser.

[`docs/processes/running-sandcastle.md`](docs/processes/running-sandcastle.md)
is the full account: the prompt syntax, the branch strategies, dependency hooks,
mounting a game folder, and a worked prompt that picks up this repository's
agent queue.

## How it works

A SCUMM game ships as two files: an index (`*.000`) and the data (`*.001`),
both obfuscated with a single-byte XOR. The data file is a tree of chunks —
four-character tag, big-endian size, payload — holding one block per room, and
inside each room the background image, walk boxes, palette, objects and scripts.

```
LECF                            the data file
├── LOFF                        room number -> file offset
└── LFLF                        one block per room
    ├── ROOM
    │   ├── RMHD                dimensions, object count
    │   ├── CLUT                256 colour palette
    │   ├── CYCL                colour cycling ranges
    │   ├── BOXD                walk boxes
    │   ├── SCAL                perspective scaling ramps
    │   ├── RMIM → IM00         background image (SMAP + z-planes)
    │   ├── OBIM / OBCD         object appearance / behaviour
    │   └── ENCD / EXCD / LSCR  entry, exit and local scripts
    └── SCRP / COST / CHAR / SOUN
```

### Module map

| Module                        | Responsibility                                                 |
| ----------------------------- | -------------------------------------------------------------- |
| `resource/Chunk.ts`           | Chunk tree traversal                                           |
| `resource/xor.ts`             | Obfuscation, and detecting which key a release uses            |
| `resource/GameDetector.ts`    | Finding the file pair and identifying the SCUMM version        |
| `resource/ResourceManager.ts` | Directories, LOFF, and resolving ids to byte ranges            |
| `gfx/BitmapCodec.ts`          | The background image codecs                                    |
| `gfx/RoomGraphics.ts`         | Decoding a room's background and z-planes                      |
| `gfx/Costume.ts`              | Sprite parsing and the per-limb animation machine              |
| `gfx/CostumeRenderer.ts`      | Drawing sprites with scaling, mirroring and masking            |
| `gfx/Charset.ts`              | Bitmap fonts, wrapping and speech placement                    |
| `gfx/Palette.ts`              | Palette handling and colour cycling                            |
| `room/Room.ts`                | Room chunk parsing                                             |
| `room/BoxMatrix.ts`           | Walk box geometry and route finding                            |
| `actor/Actor.ts`              | Position, facing and the walk state machine                    |
| `script/ScriptState.ts`       | What is running: slots, locals and open cutscenes              |
| `script/ScriptScheduler.ts`   | Slots, freezing and delays: the half that has no encoding      |
| `script/ScriptArrays.ts`      | Script arrays, which v6 added and v5 has none of               |
| `script/v5/ScriptEngine.ts`   | The v5 bytecode interpreter and its opcode set                 |
| `script/v6/ScriptEngine.ts`   | The v6 stack machine and its opcode set                        |
| `gfx/costume/akos.ts`         | v6 costumes, which are a different format from v5's            |
| `save/SaveState.ts`           | What a save carries, and putting it back                       |
| `save/SaveStore.ts`           | Ten slots per game, and what the browser holds across games    |
| `verbs/Verbs.ts`              | The verb interface                                             |
| `sound/SoundEngine.ts`        | Digitised audio via Web Audio, and the project's audio library |
| `sound/opl2/Opl2.ts`          | The YM3812 (OPL2) FM synthesiser AdLib music was written for   |
| `sound/midi.ts`               | Standard MIDI File reading                                     |
| `sound/AdLibDriver.ts`        | MIDI notes to OPL2 voices, with instruments and voice stealing |
| `sound/scummAdl.ts`           | Finding the AdLib score inside a SCUMM sound resource          |
| `sound/renderMusic.ts`        | Sequencing a score through the chip into samples               |
| `ScummEngine.ts`              | World state and the frame loop                                 |
| `AdventureEngine.ts`          | What a shell needs from a game, whichever family runs it       |
| `loadEngine.ts`               | Which Engine family a set of files belongs to                  |

AGI's half is a sibling of all of that rather than a layer under it. Nothing in
the table above is shared with the table below except `Screen`, `Palette`,
`DataSource` and `ByteStream`.

| AGI module                     | Responsibility                                                  |
| ------------------------------ | --------------------------------------------------------------- |
| `agi/resource/agiDetect.ts`    | Recognising AGI data and identifying its interpreter version    |
| `agi/resource/AgiResources.ts` | The `*DIR` indexes over `VOL.n`, and v3's combined index        |
| `agi/resource/lzw.ts`          | v3's adaptive LZW, and the separate scheme Pictures use         |
| `agi/resource/words.ts`        | `WORDS.TOK`, the authored vocabulary, and the parser            |
| `agi/resource/objects.ts`      | The `OBJECT` file: inventory items and where each one is        |
| `agi/gfx/AgiPicture.ts`        | Vector draw commands into a visual and a priority buffer        |
| `agi/gfx/AgiView.ts`           | Loops of cels, mirroring, and priority-clipped drawing          |
| `agi/gfx/agiPalette.ts`        | The sixteen EGA colours and the priority band arithmetic        |
| `agi/gfx/AgiFont.ts`           | 8x8 text, because AGI's font is in the interpreter not the data |
| `agi/script/opcodes.ts`        | The instruction set, built per Target rather than hardcoded     |
| `agi/script/AgiState.ts`       | 256 flags, 256 vars, and the reserved ones documented           |
| `agi/script/LogicEngine.ts`    | The Logic interpreter: conditions, commands, `said`             |
| `agi/ScreenObject.ts`          | AGI's animated objects — nothing to do with `Actor`             |
| `agi/sound/AgiSound.ts`        | Three tone channels and a noise channel. No OPL2 anywhere       |
| `agi/save/AgiSaveState.ts`     | The AGI save payload, Target-tagged                             |
| `agi/AgiInput.ts`              | The Parser input line, owned by a visually hidden `<input>`     |
| `agi/AgiEngine.ts`             | The cycle, the world, and everything a Logic can ask for        |

### A few details worth knowing

**Bitmap codecs.** Backgrounds are split into vertical 8-pixel strips, each
compressed independently. The first byte selects one of about forty codec
variants; its low digit is the bit width of a literal colour. Most are
variations on "walk the image emitting a bit per pixel that says keep, step, or
read a new colour".

**Z-planes.** Each room carries up to four 1-bit masks. A set bit means the
background is in front, which is how an actor walks behind a pillar.

**Walk boxes.** Floors are convex quadrilaterals with adjacency implied by
shared edges. Routes are recomputed with Floyd–Warshall on load rather than read
from the room's stored matrix — the stored matrix is a compressed form of the
same result, and recomputing avoids both the compression format and a few
shipped rooms whose matrix is wrong.

**Scaling.** Distant actors are shrunk by _dropping_ rows and columns against an
ordered-dither table, not by resampling. That is what the original did, and why
scaled sprites look sharp rather than blurry.

**The interpreter.** One opcode byte, whose top three bits say whether each of
the first three operands is a literal or a variable. Scripts run cooperatively:
each runs until it blocks on `breakHere`, `wait` or `delay`, and the engine
round-robins them once per frame.

## Making a game in the browser

There is a visual editor at **`/editor.html`** — or the "Make a game →" link in
the player. No build step, no TypeScript required.

```bash
npm start   # then open http://localhost:5160/editor.html
```

- **Paint rooms** directly on the canvas: freehand, rectangles, a 256 colour
  palette.
- **Place objects** by clicking, drag them around, and set the spot the player
  walks to before interacting. Draw their artwork on the "Object art" tab, one
  image per state, with transparency.
- **Import a picture** as a room background or object art — PNG, JPEG, GIF,
  anything the browser decodes. It is mapped to the 256 colour palette, with
  optional dithering to avoid banding.
- **Pick a colour off the artwork** — right-click the room, or alt-click any of
  the three canvases, and that colour becomes the brush.
- **Read off coordinates** as you move over the room, so placing walk-to points
  and box corners by eye is not guesswork.
- **Set the perspective** so characters shrink into the distance: two rows and
  two sizes per room, shown as dashed guides on the canvas. Individual walk
  boxes can opt out and keep a fixed size.
- **Draw walk boxes** and shape them corner by corner. A walk box is a convex
  quadrilateral, not a rectangle, so a receding corridor is a trapezoid and a
  sloping path a slanted quad. Areas that are not convex are built from several
  boxes side by side. They're listed in the inspector with a delete button each,
  so a box hidden under an object is still reachable.
- **Add a cast**: up to 19 actors, each with their own costume, colours, walk
  speed and starting room. NPCs get verb handlers exactly as objects do, so
  "Talk to the barman" is a step list.
- **Import a picture as a sprite cel** — the costume's colour table is built
  from the image automatically.
- **Draw the player** on the "Player sprite" tab: standing, walking and talking,
  with the costume's own 31 colour palette, each slot chosen from the full 256
  colour game palette. Each pose is a **sequence of cels**
  with a per-cel hold, so a walk actually animates — add, reorder and delete
  cels in the strip, and preview at the real speed. New projects start with a
  four-cel walk cycle rather than a placeholder block.
- **Import audio and audition it** — drop in `.mp3`, `.wav`, `.ogg`, `.flac`,
  `.aiff`, a Creative `.voc`, or a sound resource pulled out of a game, and
  press play on any track in the sidebar. Files are identified by their
  contents, not their extension, which matters because extraction tools name
  things `.fla`, `.ims`, `.nut` or `.rom` regardless of what is inside. Anything
  that cannot be played — a SMUSH file, a synthesiser ROM, a sound-card driver
  program — is listed and labelled with the reason, rather than failing
  silently. AdLib music _is_ played, through the emulated OPL2. Each track gets
  a sound number, and a _Play sound_ step picks from the library by name.
- **Give things behaviour** with a list of steps: _say_, _set object state_,
  _go to room_, _give item_, _set flag_, _play sound_, _if flag is…_. No code.
- **Drop to code** when the steps run out. A `Custom code` step hands you the
  assembler as `s`, with every opcode available.
- **Play it immediately**, in the editor, in the real engine — the actual
  compiled game, not a preview that behaves differently.

### Editing an AGOS game — Simon the Sorcerer and its siblings

An imported AGOS game gets the same editor, with the same sidebar, tabs,
properties pane, tools and keyboard, over the four things an AGOS game is made
of rather than over rooms and actors:

- **Items**, as a tree. Rename one — which points its noun at a new string
  rather than editing the shared one, so nothing else in the game changes with
  it — move it to a new parent, set its state, and edit the values in its typed
  sub-structures. Moving an item to item 0 is how these games destroy something.
- **Strings**, as one shared pool. Every string says how many Subroutines an
  edit would reach **before** you make it, because AGOS refers to strings by
  index and one line of dialogue can belong to a dozen scripts.
- **Subroutines**, as listings with editable operand values. Instructions can be
  added and removed: AGOS bytecode refers to nothing by offset, so a line that
  changes length does not renumber anything.
- **Art**, on a canvas with the same tools as the SCUMM one — paint, rectangle,
  fill, pick up, sixteen colours, zoom, import a picture, export a PNG, and the
  arrow keys throughout. The colours are the zone's own: a palette bank is
  chosen by whichever script draws an image, so the banks the zone carries are
  offered on the toolbar and you pick. A zone with no palette of its own — its
  colours come from a bank another zone loads — is shown in greys, and says so.
  Colour index zero is drawn as a checkerboard, because the game draws it as
  transparent.

**The art needs the game folder.** An AGOS game's pixels are not in `GAMEPC`;
they are in the resource archive beside it, which is far too large to keep a
second copy of in the browser. So the Art tab asks for the folder once per
session and checks it is the same game — the base file is fingerprinted at
import, and a folder that does not match is refused with the reason, because a
different release's art would open as plausible nonsense rather than fail
(ADR 0034).

The same folder is what **Save**, **Export game** and **Play** need: an AGOS
export rebuilds `GAMEPC` whole and the archive beside it, together or not at all
(ADR 0030). Without the folder all three say so by name rather than writing half
a game. An unedited game comes back out byte for byte.

### Saving your work

Three tiers, because they solve different problems:

|                 | What it is                                        | When                    |
| --------------- | ------------------------------------------------- | ----------------------- |
| **Autosave**    | Browser local storage                             | Continuously, debounced |
| **Save**        | Project JSON + compiled game, written to a folder | Ctrl/Cmd-S              |
| **Export game** | A zip of just the playable game                   | Sharing it              |

**Save** uses the File System Access API where it exists (Chrome, Edge): you
pick a folder once and every later save writes straight into it, no dialogs.
Firefox and Safari have no such API, so Save downloads a zip containing the same
files.

Audio is the one thing that will push a project past that 5 MB cap quickly. It
is stored inside the project JSON, like room art, so a project stays a single
file — but a few minutes of music is larger than an entire hand-drawn game, and
once local storage is full the editor falls back to IndexedDB automatically.
Two consequences worth knowing: importing and deleting audio are **not
undoable** (the undo stack deliberately does not copy megabytes of it, so the
editor asks before removing a track), and importing a published game caps how
much of its sound it will carry across.

Autosave is a convenience, not a home — local storage is per-browser, capped
around 5 MB, and disappears when site data is cleared. The status bar says when
you have changes that have never been exported, and the tab warns before closing
on unsaved work. The **project `.json` is the real save**: back it up, commit it,
re-import it anywhere.

Saving writes four files:

```
my-game.scummproj.json   the project — this is the source of truth
MYGAME.000               compiled index
MYGAME.001               compiled data
manifest.json            so ?game=… can load the folder
```

Drop that folder into `public/games/` and it plays at `?game=<folder>`.

### A note on custom code

`Custom code` steps are JavaScript. Your own are compiled without ceremony, but
opening a project file from **someone else** asks before running theirs — a
project is data, and data should not execute just because it was opened.

## Making your own game in TypeScript

The engine is only half of it. The other half compiles a game **you** write into
a real SCUMM v5 container — the same format a commercial game ships in, loaded
through the same code path. There is no separate "authored game" mode: if a game
built here runs, the interpreter is correct.

```bash
npm run build:demo    # compiles examples/demo/game.ts
npm start             # then open http://localhost:5160/?game=demo
```

A game is a TypeScript module that default-exports a `GameBuilder`:

```ts
import { defineGame, createImage, rect, pixels } from '../../src/authoring/index.js';

const game = defineGame({
  name: 'Nightfall',
  start: { room: 1, x: 80, y: 126 },
});

game.verb({ id: 1, text: 'Look at', x: 12, y: 152, key: 'l' });

game.actor({
  id: 1,
  name: 'Foster',
  talkColor: 11,
  costume: {
    palette: [0, 6, 14, 2, 1, 8],
    frames: [{}, { all: { image: hero } } /* walk, stand, talk… */],
  },
});

const street = game.room({
  id: 1,
  background: streetArt,
  boxes: [{ x: 0, y: 108, width: 320, height: 36 }],
});

street
  .object({ id: 100, name: 'door', x: 40, y: 58, width: 24, height: 44 })
  .on(1, (s) => s.sayEgo('A red door. It has seen better decades.'))
  .on(3, (s) => s.loadRoomWithEgo(201, 2, -1, -1));

export default game;
```

Then build it and play:

```bash
npm run build:game games/mygame/game.ts -- --name mygame
npm start   # http://localhost:5160/?game=mygame
```

`--name` sets the 8.3 file stem; `--out <dir>` overrides the output directory,
which defaults to `public/games/<name>/`.

Two things that catch people out:

- Changing room from a room or object script must use `loadRoomWithEgo`, not
  `loadRoom`. The room change kills the calling script, so anything after a
  `loadRoom` silently never runs.
- Object ids are global and must be unique across every room, because saved
  state is keyed on them.

### What the compiler generates for you

Writing a SCUMM game normally means writing the boot script by hand. The
compiler emits three scripts so you don't have to:

- **Boot** — screen split, font, actors, the verb panel, and the first room.
- **Sentence** — walks the player to whatever they clicked, then dispatches to
  that object's verb handler, or says your fallback line.
- **Verb** — records the selected verb.

### Scripts are typed

Verb handlers receive an `Assembler` that emits real v5 bytecode. The
addressing-mode bits are derived from the argument types, so the two forms of
every instruction are impossible to confuse:

```ts
s.move(global(10), 5); // 0x1A — operand is a literal
s.move(global(10), global(11)); // 0x9A — operand is a variable
```

Jumps go through labels and are back-patched, so nothing counts bytes:

```ts
s.ifEqual(WARNED, 0, (body) => {
  body.sayEgo('It sticks a little.');
  body.move(WARNED, 1);
});
```

### Art without an art program

Rooms and sprites are built in code, so a first room needs no external tools:

```ts
const image = createImage(320, 144, 0);
verticalGradient(image, 0, 80, BLUE, DARK_GREY);
rect(image, 0, 102, 320, 6, GREY);

const key = pixels(
  `
  ..###..
  .#...#.
  ..###..
  ...#...
  ...##..
  `,
  { '#': 14, '.': 0 },
);
```

`maskRect` builds the 1-bit z-planes that let an actor walk behind scenery.

### Authoring module map

| Module                        | Responsibility                                     |
| ----------------------------- | -------------------------------------------------- |
| `authoring/GameBuilder.ts`    | The declarative surface: rooms, objects, actors    |
| `authoring/Assembler.ts`      | Bytecode emission, labels, addressing modes        |
| `authoring/compile.ts`        | Generated scripts, and the whole container         |
| `authoring/ImageEncoder.ts`   | Backgrounds and z-planes to `SMAP` / `ZPnn`        |
| `authoring/CostumeBuilder.ts` | Sprite frames to a `COST` resource                 |
| `authoring/CharsetBuilder.ts` | The built-in font to a `CHAR` resource             |
| `authoring/draw.ts`           | Drawing helpers and text-art pixels                |
| `authoring/actions.ts`        | The structured action vocabulary and its bytecode  |
| `authoring/project.ts`        | The saved project format, and its validation       |
| `authoring/audio.ts`          | Identifying audio by its bytes, and storing it     |
| `editor/AudioLibrary.ts`      | Auditioning tracks in the editor                   |
| `authoring/projectToGame.ts`  | Project to compiled game                           |
| `editor/state.ts`             | Undo, selection, autosave                          |
| `editor/RoomCanvas.ts`        | Painting, object placement, walk boxes             |
| `editor/ActionEditor.ts`      | The step list and the code escape hatch            |
| `editor/save.ts`, `files.ts`  | Saving to a folder, or to a zip                    |
| `editor/shell.ts`             | The sidebar accordion and list row, shared         |
| `editor/agos/AgosEditor.ts`   | The AGOS surface: items, strings, scripts, art     |
| `editor/agos/resupply.ts`     | Re-opening an AGOS game folder, checked (ADR 0034) |
| `bin/scumm-build.ts`          | The CLI                                            |

One deliberate simplification: backgrounds are written with codec 1
(uncompressed). The engine reads every codec, but only one needs _writing_ — the
compressed variants exist to fit a game on floppies, and their bugs would be
invisible until one specific strip rendered wrong. A room costs 46 KB.

## Current state

Implemented:

- SCUMM **v5** resource loading, decryption and chunk parsing, and the full v5
  opcode set
- SCUMM **v6** resource loading — `PALS` palettes, `AARY` script arrays, `DOBJ`
  class data — and the full v6 opcode set, all 160 instructions
- Room backgrounds, objects, z-plane masking, palette cycling, scrolling
- Costume rendering with per-limb animation, scaling and mirroring, in both v5's
  format and v6's `AKOS`
- Walk box pathfinding, actor movement, turning and animation
- Text rendering, speech placement and the verb interface
- Digitised sound effects and speech via Web Audio, from the game's own
  resources or from audio files imported into a project
- Recorded speech from a talkie release's `MONSTER.SOU`, with lines that last as
  long as their audio
- **AdLib music**, synthesised through an emulated OPL2 — the `ADL ` score is
  read as MIDI and played on the chip it was written for
- **Saved games**, in this project's own format, kept between sessions — ten
  named slots per game, and a Load menu that lists every game you have saves for
- Loading games from a `.zip`, and naming non-SCUMM data instead of failing
- **Authoring**: compiling a game written in TypeScript to a v5 container
- **A visual editor** with room painting, object placement, walk boxes, a
  structured action editor, instruction-level editing of an imported v6 script,
  in-editor play, and saving to disk — and the same surface over an AGOS game's
  items, strings, Subroutines and art

### What "v6 support" does and does not claim

Verified at **Tier 1** by a synthetic game built in the tests, and at **Tier 2**
against LucasArts' own freely distributed demos
(`docs/processes/verifying-version-support.md`). What that establishes:

- **Day of the Tentacle's demo** boots, loads its first room, draws its actors,
  reaches all of the room's objects, and plays its intro cutscene forward.
- **Sam & Max's CD demo** boots into the office with every object named and
  eighteen of nineteen reachable.

What it does **not** establish is _completable_, which is a claim about a game's
last screen. Neither retail game has been played through here, and a demo cannot
stand in for that. The remaining known gaps a playthrough would meet are listed
below — floating objects in particular, which are how Sam & Max carries some of
its inventory.

Not implemented:

- **Roland MT-32 and PC speaker synthesis.** Only the OPL2 is emulated. A score
  that shipped without an AdLib arrangement is still played on it, labelled
  "no AdLib version", which gives the right notes with the wrong timbre — worth
  much more than refusing to play it. A Roland `.rom` is instrument data for a
  synthesiser that is not here, not a piece of music.
- **iMUSE sequencing.** A score is rendered to samples up front and played, so
  the commands that need a live sequencer cannot be served. The ones that can be
  are: starting and stopping music, volume, and the markers a score carries, so
  music follows the game rather than looping obliviously. The rest are named in
  the log once each rather than dropped.
- **Shadow palettes**, used for a handful of translucency effects, and objects
  a script asks to be drawn straight over the room. Both are named in the log
  rather than silently skipped.
- **Floating objects** — objects a script adds to a room at runtime.
- **SCUMM v7** (Full Throttle, The Dig) beyond booting. A v7 index, its
  directories and its rooms are read, a v7 interpreter runs its scripts on the
  stack machine it shares with v6, SMUSH video plays, and iMUSE Digital's script
  commands are read at v7's own numbering rather than v6's — but _which_
  recording a musical state or sequence names comes out of a table built into
  the original interpreter, one per game, and those tables are not here. A state
  whose number happens to name a bundle cue plays; the rest are named in the log
  once. So v7 is not playable and is not claimed to be.
- **A named checkpoint in v2, v3 or v8.** All three load, run and edit, and all
  three rest on a synthetic fixture: nobody here has Maniac Mansion, Indy 3 or
  The Curse of Monkey Island. A fixture encodes this project's reading of a
  format, so it and the engine agree with each other and may both disagree with
  the game — which is not a hypothetical, it is how four v6 faults and six v5
  ones survived a passing suite. Those three Versions are where that gap is
  open today.
- **SCUMM v0 and v1** (Maniac Mansion on C64, Apple II and NES, Zak on C64 and
  Apple II). Disk images and a cartridge ROM rather than files, and out of
  scope in `.out-of-scope/scumm-non-dos-releases.md`.
- **Other ScummVM engines.** Out of scope _of the SCUMM family_, which is what
  this list is about — each is a separate interpreter and not a variation on
  SCUMM. That is not the same as out of scope of the project, and this bullet
  used to name Sky and SCI as examples when both had since become families in
  their own right. ScummVM has 126 engines;
  [`docs/scummvm-parity-roadmap.md`](docs/scummvm-parity-roadmap.md) measures
  what the rest would cost and which ten are worth having.

A version this engine has no interpreter for is _detected_ and refused by name
rather than loaded and left to fail: `detectGame` throws before the resource
layer sees the file. Nothing in the SCUMM family reaches that refusal any more
— every Version from v2 to v8 has an interpreter — and the seam stays because
the next one to arrive will land there first. For v5 and later the version
comes from the size of the index's `MAXS` block, which every version changed —
26 bytes for v5, 38 for v6, 138 for v7, 176 for v8. Before v5 there is no
`MAXS`, so it comes from the shape of the index instead: three digits in its
name for a v4 install, two for v2 or v3, and then the width of the global
object table — one byte per object at v2 and four at v3 — which is the only
place the two differ. None of it depends on file naming, which varies between
packagings.

Loading a version anyway would be worse than an error — every stage succeeds
except running the game, and the result is a black screen with nothing in the
log, or an opcode cascade that reads as a missing opcode rather than the wrong
format entirely.

## Accessibility

Both pages target **WCAG 2.2 Level AA**: everything is operable from the
keyboard — including the drawing canvases, where arrow keys move a cursor and
Enter applies the current tool — every control has a name that says what it
does and which thing it does it to, dialogs hold focus and give it back, colour
is never the only signal, targets are at least 24 by 24, and the whole interface
reflows into a 320 pixel column.

The three places the claim stops are named rather than glossed: a running game's
own artwork and text are that game's content and cannot be described here, the
AGI cel grid uses 12-pixel cells because a cell there _is_ a pixel of the
drawing, and the AGI typing line has not yet been checked with a real screen
reader.

`docs/accessibility.md` is the criterion-by-criterion record. The same statement
written for a reader is in the application: the **Accessibility** link in the
footer of either page. The suite in `tests/accessibility-*.test.ts` renders the
real interface and asserts its roles, names, states, focus behaviour and
contrast.

## The hosted site

`main` deploys to <https://adrianeyre.github.io/multi-game-interpreter/> — the player at the
root, the editor at `/editor.html`.

The deploy is the last stage of the release workflow rather than a workflow of
its own, and it checks out `main` again before building. semantic-release bumps
`package.json` during that same run and the footer shows the version, so
anything that builds earlier — or from the commit that triggered the run —
would publish a site labelled with the previous release's number every time.

Only the interpreter is published. Game data is yours and stays on your
machine: `public/games/` is git-ignored, and nothing is ever uploaded.

## Releases

Merging to `main` triggers
[semantic-release](https://github.com/semantic-release/semantic-release), which
reads the commit messages since the last tag and then bumps the version, updates
`CHANGELOG.md`, creates the git tag and publishes the GitHub release.

Commits follow [Conventional Commits](https://www.conventionalcommits.org):

| Prefix                         | Release |
| ------------------------------ | ------- |
| `fix:`                         | patch   |
| `feat:`                        | minor   |
| `feat!:` or `BREAKING CHANGE:` | major   |
| `docs:`, `chore:`, `test:`     | none    |

No secrets need configuring: the workflow uses the `GITHUB_TOKEN` that Actions
provides. npm publishing is off (`npmPublish: false`); turn it on by setting an
`NPM_TOKEN` secret and flipping that flag in `.releaserc.json`.

## Licence

GPL-3.0-or-later, matching ScummVM, which this implementation was written
against.
