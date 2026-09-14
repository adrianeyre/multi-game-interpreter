# Self-hosted game data, for a static build

**For local development, use the `games/` folder in the project root instead.**
It needs no manifest, takes zips, and the player lists what is in it. This
directory is for the case that folder cannot serve: a build deployed to static
hosting, where there is no server to list a directory.

Put a game you own in a folder here and it is served with the app:

```
public/games/monkey2/
  MONKEY2.000
  MONKEY2.001
  manifest.json
```

`manifest.json` is required here, because a browser cannot list a directory over
HTTP and there is no dev server to ask:

```json
{
  "name": "Monkey Island 2",
  "files": ["MONKEY2.000", "MONKEY2.001"]
}
```

Then open <http://localhost:5160/?game=monkey2>, or the same query on the
deployed site.

Everything under `public/games/` except this file is git-ignored, so game data
never ends up in the repository. Anything you put here is **published with the
build** — that is the point of it, and the reason to prefer the root `games/`
folder for data you only want locally.
