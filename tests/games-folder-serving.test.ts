import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isInsideFolder } from '../src/hosting/gamesFolder.js';
import { gamesFolder } from '../src/hosting/gamesFolderPlugin.js';

/**
 * Serving a file out of the `games/` folder.
 *
 * The failure this pins down is quiet and total: when the handler declines a
 * path it calls `next()`, and what is next is Vite. Vite sees an extensionless
 * name — which is exactly what Sierra's AGI index files are called, `LOGDIR`,
 * `PICDIR`, `VIEWDIR`, `SNDDIR` — decides a URL with no extension must be a
 * module, and reports the bytes of a 1986 resource directory as invalid
 * JavaScript syntax. So a handler that quietly stops serving does not look
 * like a server fault at all. It looks like the game is corrupt.
 */
let root = '';

/** The plugin's handler, taken the way a dev server would install it. */
function handlerFor(folder: string) {
  let handler: ((req: IncomingMessage, res: ServerResponse, next: () => void) => void) | undefined;
  gamesFolder(folder).configureServer({
    middlewares: {
      use(fn) {
        handler = fn;
      },
    },
  });
  if (!handler) throw new Error('the plugin installed no middleware');
  return handler;
}

/** One request through the handler, said as what the client would observe. */
async function request(
  folder: string,
  url: string,
): Promise<{
  fellThrough: boolean;
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}> {
  const handler = handlerFor(folder);
  const headers: Record<string, string> = {};
  const chunks: Buffer[] = [];

  return await new Promise((settle) => {
    let fellThrough = false;
    const res = {
      statusCode: 200,
      setHeader(name: string, value: string | number) {
        headers[name.toLowerCase()] = String(value);
      },
      end(chunk?: Buffer) {
        if (chunk) chunks.push(Buffer.from(chunk));
        settle({ fellThrough, status: res.statusCode, headers, body: Buffer.concat(chunks) });
      },
      write(chunk: Buffer) {
        chunks.push(Buffer.from(chunk));
        return true;
      },
      on() {
        return res;
      },
      once() {
        return res;
      },
      emit() {
        return false;
      },
    };

    handler({ url, headers: {} } as IncomingMessage, res as unknown as ServerResponse, () => {
      fellThrough = true;
      settle({ fellThrough, status: 0, headers, body: Buffer.alloc(0) });
    });
  });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'scumm-serving-'));
  await mkdir(join(root, 'kings3'));
  // The bytes of an AGI resource directory: three-byte entries, no header a
  // parser of anything else would recognise, and no extension on the name.
  await writeFile(
    join(root, 'kings3', 'LOGDIR'),
    Buffer.from([0x00, 0x02, 0x9d, 0xff, 0xff, 0xff]),
  );
  await writeFile(join(root, 'kings3', 'VOL.0'), Buffer.from('volume'));
  // Documentation: skipped as game data, and still served, because the player
  // fetches both of these by name to show what the game is.
  await writeFile(join(root, 'kings3', 'README.md'), Buffer.from('# King\u2019s Quest III\n'));
  await writeFile(join(root, 'kings3', 'image.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('serving a game file', () => {
  /**
   * The regression. Declining this path is not a 404 — it hands an AGI index
   * to Vite's module pipeline, and the page says the file is invalid JS.
   */
  it('serves an extensionless AGI index rather than passing it to Vite', async () => {
    const answer = await request(root, '/games/kings3/LOGDIR');

    expect(answer.fellThrough).toBe(false);
    expect(answer.body).toEqual(Buffer.from([0x00, 0x02, 0x9d, 0xff, 0xff, 0xff]));
    // Bytes, said as bytes: anything else invites a client to parse them.
    expect(answer.headers['content-type']).toBe('application/octet-stream');
  });

  it('serves a file under a folder that a game keeps beside its index', async () => {
    const answer = await request(root, '/games/kings3/VOL.0');

    expect(answer.fellThrough).toBe(false);
    expect(answer.body.toString()).toBe('volume');
  });

  it('lists the folder for a browser that cannot list one itself', async () => {
    const answer = await request(root, '/games/index.json');

    expect(answer.fellThrough).toBe(false);
    const listing = JSON.parse(answer.body.toString()) as {
      entries: { id: string; files: string[] }[];
    };
    expect(listing.entries.map((entry) => entry.id)).toContain('kings3');
    expect(listing.entries[0].files).toContain('LOGDIR');
  });

  /**
   * A game's README is not game data — the listing leaves it out of the files
   * it offers the engine — but it is the thing the player shows when someone
   * clicks the game rather than its play button, so it has to be fetchable.
   */
  it('serves a game’s README as markdown', async () => {
    const answer = await request(root, '/games/kings3/README.md');

    expect(answer.fellThrough).toBe(false);
    expect(answer.body.toString()).toContain('King');
    expect(answer.headers['content-type']).toBe('text/markdown; charset=utf-8');
  });

  /**
   * And its pictures. Served as an octet-stream instead, whether an `<img>`
   * renders it is left to the browser's own content sniffing.
   */
  it('serves a picture a README shows as an image', async () => {
    const answer = await request(root, '/games/kings3/image.jpg');

    expect(answer.fellThrough).toBe(false);
    expect(answer.headers['content-type']).toBe('image/jpeg');
  });

  it('declines a path that climbs out of the folder', async () => {
    const answer = await request(root, '/games/../package.json');

    expect(answer.fellThrough).toBe(true);
  });

  it('leaves a path outside `/games/` to whatever serves it', async () => {
    expect((await request(root, '/index.html')).fellThrough).toBe(true);
  });
});

/**
 * A resolved path is spelled in the platform's separator, so a containment
 * test written against a literal `/` answers "outside" for every file in the
 * folder on Windows. Building the root with `resolve` and joining with `sep`
 * is the shape the plugin itself uses, which is what makes this fail there and
 * pass here rather than passing everywhere by construction.
 */
describe('containment, in the platform’s own spelling', () => {
  it('accepts a file under a root spelled the way the plugin resolves it', () => {
    const base = resolve(root);
    expect(isInsideFolder(base, `${sep}kings3${sep}LOGDIR`)).toBe(true);
    expect(isInsideFolder(base, '/kings3/LOGDIR')).toBe(true);
  });

  it('still refuses a sibling whose name merely starts the same', () => {
    expect(isInsideFolder(resolve(root), '/../games-private/secret')).toBe(false);
  });
});
