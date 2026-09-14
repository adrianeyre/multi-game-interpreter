# Volumes are read by offset, and the seam lands before any SCI code

This project reads games whole. `src/main.ts` does
`new Uint8Array(await files[0].arrayBuffer())` and `src/hosting/openGame.ts`
does the same server-side. That is correct for everything supported today — the
README calls Sam & Max's talkie "thirteen megabytes" and treats that as large.

SCI32 is not a larger version of that problem, it is a different one.
Phantasmagoria shipped on seven discs, Gabriel Knight 2 on six; King's Quest VII,
Lighthouse and RAMA run to hundreds of megabytes each, nearly all of it video and
audio. Buffering a game that size into `Uint8Array`s in a browser tab does not
work slowly — it fails to allocate.

## The seam

```ts
interface VolumeReader {
  read(volume: string, offset: number, length: number): Promise<Uint8Array>;
}
```

SCUMM and AGI get an implementation backed by the buffers they already hold, so
**nothing about their behaviour changes** — and that is the point. It lands as
its own step, proved by the existing games continuing to work, which is the
discipline ADR 0011 set for the shell extraction and ADR 0001 before it: do the
enabling refactor deliberately rather than let the new implementation shape the
seam around its own accidents.

SCI gets one backed by `File.slice()`, which browsers serve lazily without
materialising the file.

The split falls out of the format rather than being imposed on it. Nothing in a
Volume is found by walking it — `RESOURCE.MAP` addresses every resource by
offset — so reading a Volume whole was always a property of small games rather
than of the format. `RESOURCE.000` and its siblings are modest and could be
buffered; the video and audio Volumes are the enormous ones and are streamed by
nature, because nobody wants a 400 MB VMD in memory, they want the next frame.

## Why before, not after

Retrofitting this costs every reader in the family, and the failure it prevents
is not a slow path — it is a tab that dies on a game we claimed to support.

## Consequences

**A stated limit rather than a pretence:** a browser tab will not hold a
seven-disc game's worth of anything, so playability for the largest SCI2 titles
depends on this seam being real from the first commit. If it turns out not to be
enough, the honest response is to declare specific titles out of scope on size
grounds — not to buffer harder.

The alternative considered and rejected was to support SCI2 and SCI2.1 through
their smaller titles and drop Phantasmagoria and Gabriel Knight 2. Cheaper, and
it concedes the two games most people mean by "SCI2".
