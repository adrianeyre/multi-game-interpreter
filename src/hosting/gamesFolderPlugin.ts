/**
 * Serves the project's `games/` folder to the app in dev and preview.
 *
 * Two things the browser cannot do for itself:
 *
 * - **List a directory.** `GET /games/index.json` answers with what is in the
 *   folder, so self-hosted game data no longer needs a hand-written
 *   `manifest.json` beside it.
 * - **Read outside the served root.** `games/` sits next to `package.json`
 *   rather than inside `public/`, so game data is not something a production
 *   build could sweep up and publish by accident.
 *
 * On a miss it calls `next()`, so `public/games/<id>/` keeps working exactly as
 * it did — including in a static production build, where there is no server to
 * ask and `manifest.json` is still the only way.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

import { isInsideFolder, scanGamesFolder } from './gamesFolder.js';

/**
 * MIME types worth naming; everything else is bytes to the browser anyway.
 *
 * The images are here because a game's `README.md` can show one — box art
 * beside the description — and a picture served as an octet-stream is at the
 * mercy of the browser's own sniffing.
 */
const CONTENT_TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function contentTypeFor(path: string): string {
  const dot = path.lastIndexOf('.');
  return (
    (dot >= 0 ? CONTENT_TYPES[path.slice(dot).toLowerCase()] : undefined) ??
    'application/octet-stream'
  );
}

/**
 * A `Range` header, as a byte interval, or null when there is nothing to honour.
 *
 * Only the single-interval form, which is the only one anything here sends and
 * the only one worth answering: a multi-part range response is a MIME document,
 * and a client that asked for one would rather have the whole file.
 *
 * An unsatisfiable range — past the end of the file — comes back null so the
 * caller answers with the whole file rather than with an error. The reader on
 * the other side treats a 200 as "ranges are not available here" and slices
 * what it needs, so a whole file is a slow answer and never a wrong one.
 */
export function parseByteRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;

  const [, fromText, toText] = match;
  if (fromText === '' && toText === '') return null;

  // `bytes=-500` means the last 500 bytes, not "up to 500".
  const start = fromText === '' ? Math.max(0, size - Number(toText)) : Number(fromText);
  const end = fromText === '' || toText === '' ? size - 1 : Math.min(Number(toText), size - 1);

  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end };
}

interface Middleware {
  use(handler: (req: IncomingMessage, res: ServerResponse, next: () => void) => void): void;
}

/**
 * The handler, separated from the plugin so both the dev server and the
 * preview server get identical behaviour rather than a near-copy each.
 */
function serveGamesFolder(root: string) {
  return (req: IncomingMessage, res: ServerResponse, next: () => void): void => {
    const url = req.url ?? '';
    if (!url.startsWith('/games/') && url !== '/games') return next();

    // Query strings and fragments are not part of the path on disk.
    const path = decodeURIComponent(url.split(/[?#]/)[0]).slice('/games'.length) || '/';

    if (path === '/index.json') {
      void scanGamesFolder(root).then(
        (entries) => {
          res.setHeader('Content-Type', 'application/json');
          // Always fresh: the whole point is that dropping a game in the folder
          // and reloading the page finds it.
          res.setHeader('Cache-Control', 'no-store');
          res.end(JSON.stringify({ root, entries }));
        },
        () => next(),
      );
      return;
    }

    if (path === '/' || !isInsideFolder(root, path)) return next();

    const file = join(root, path.slice(1));
    void stat(file).then(
      (info) => {
        if (!info.isFile()) return next();
        res.setHeader('Content-Type', contentTypeFor(file));
        res.setHeader('Cache-Control', 'no-store');
        // Said whether or not this request asked for a range, because a client
        // decides whether to range-read at all from what the server advertises.
        res.setHeader('Accept-Ranges', 'bytes');

        // Ranges are the whole point of `DataSource.readRange`, and without
        // them here that machinery silently reads whole files instead — which
        // is the failure it exists to prevent, on the one path a maintainer
        // would use to try a retail game: a v7 bundle is hundreds of megabytes
        // and is addressed by offset, so reading it whole to take a few
        // kilobytes out of it is what makes a v7 game unreliable in a browser.
        const range = parseByteRange(req.headers.range, info.size);
        if (range) {
          res.statusCode = 206;
          res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
          res.setHeader('Content-Length', String(range.end - range.start + 1));
          createReadStream(file, { start: range.start, end: range.end }).pipe(res);
          return;
        }

        res.setHeader('Content-Length', String(info.size));
        createReadStream(file).pipe(res);
      },
      // Not in `games/` is not an error: `public/games/` may still have it.
      () => next(),
    );
  };
}

/**
 * @param folder Where to look, relative to the working directory.
 */
export function gamesFolder(folder = 'games') {
  const root = resolve(process.cwd(), folder);
  const handler = serveGamesFolder(root);

  return {
    name: 'scumm:games-folder',
    configureServer(server: { middlewares: Middleware }) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server: { middlewares: Middleware }) {
      server.middlewares.use(handler);
    },
  };
}
