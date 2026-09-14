# A large game is exported against re-supplied originals

The editor keeps a whole imported game in IndexedDB beside its Project, because
export rewrites the original files rather than compiling a new game, and a
Project is not a complete description of the game it came from — art, sound and
every resource no importer understands live only in those files. At v6 sizes
that is tens of megabytes and works. Full Throttle is around 148 MB of data
before its videos and audio bundles, and The Dig is several hundred; with the
Project beside it, an edited v7 game wants roughly two copies of a CD in browser
storage. IndexedDB quota is a browser policy, not a machine specification, so
there is no desktop big enough to make this reliable.

So above a size threshold the originals are not stored. The Project holds intent
— instructions, imported strings, Preserved bytes — and the game folder is
requested again at export, which becomes original plus diff. Below the
threshold, v5 and v6 imports keep today's one-step export unchanged.

## Consequences

Export can fail for a reason that is not the editor's fault: the author no
longer has the files, or supplies a different release than the one imported.
The Project records enough about its origin to refuse a mismatched folder by
name rather than writing a corrupt game.

The threshold is a real seam, and two export paths exist behind one button. The
one that stores nothing is the one under test least often, because it is the one
that needs a large game to exercise.

Rejected: persisting a File System Access directory handle so the folder is read
and written in place, which is the best experience where it works and Chromium
only — so the re-supply path would have to exist anyway, and two paths is worse
than one. Also rejected: keeping the current model with a quota warning, which
turns "edit an imported v7 game" into something that works on some machines and
not others, after a long import, for reasons the author cannot see.
