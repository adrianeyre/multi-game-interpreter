// @vitest-environment jsdom
/**
 * Both Virtual Theatre editing surfaces mount and render.
 *
 * Written after a report that neither game was editable in the app while every
 * CLI harness said both were. The harnesses call `toEditableGame` and stop
 * there; the app then *mounts a surface*, and a surface that throws on render
 * is indistinguishable from a game that cannot be edited. So this is the check
 * that was missing rather than a second copy of one that already existed.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { SkyEditor } from '../src/editor/sky/SkyEditor.js';
import { LureEditor } from '../src/editor/lure/LureEditor.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { scanGamesFolder } from '../src/hosting/gamesFolder.js';
import { LoadProgressTracker } from '../src/engine/resource/progress.js';
import type { DataSource } from '../src/engine/resource/DataSource.js';
import type { Project } from '../src/authoring/project.js';

/**
 * A game from the folder the app lists, or null when it is not on this machine.
 *
 * The same contract `HttpDataSource` gives the loader — `list()` returns
 * exactly the names the server reported — so detection sees what the browser
 * sees. Skipped rather than failed when the folder is empty: these games are
 * fetched, never committed.
 */
/**
 * A file each game must ship, which is what "is this game here?" really asks.
 *
 * Not the folder: `games/<slug>/` is tracked for its README and cover art, so
 * it exists on every checkout while its contents are gitignored. Not the
 * listing's file count either — a folder holding only the game's manual and
 * licence has files in it and no game, which is exactly the state a partial
 * extraction leaves behind.
 */
const REQUIRED: Readonly<Record<string, string>> = {
  'beneath-a-steel-sky': 'sky.dsk',
  'lure-of-the-temptress': 'Disk1.vga',
};

async function gameFromFolder(slug: string): Promise<DataSource | null> {
  const root = join(process.cwd(), 'games');
  const required = REQUIRED[slug];
  if (!required || !existsSync(join(root, slug, required))) return null;
  const entries = await scanGamesFolder(root);
  const entry = entries.find((candidate) => candidate.id === slug);
  if (!entry || entry.files.length === 0) return null;

  const dir = join(root, slug);
  return {
    label: entry.name,
    list: () => entry.files,
    read: async (name: string) => new Uint8Array(await readFile(join(dir, name))),
  } as unknown as DataSource;
}

async function projectFor(slug: string): Promise<Project | null> {
  const source = await gameFromFolder(slug);
  if (!source) return null;
  const engine = await loadAdventureEngine(source);
  expect(engine.describeEditRefusal()).toBeNull();
  const editable = await engine.toEditableGame({ progress: new LoadProgressTracker() });
  return editable?.project ?? null;
}

/** Whether a game's data is on this machine, decided once and reported. */
function have(slug: string): boolean {
  const required = REQUIRED[slug];
  return Boolean(required) && existsSync(join(process.cwd(), 'games', slug, required));
}

describe('the Virtual Theatre editing surfaces mount', () => {
  // Skipped rather than passed when the games are absent. A test that returns
  // early reports green on a machine where it checked nothing, which is how a
  // sibling test here came to assert against zero on CI and be believed.
  it.skipIf(!have('beneath-a-steel-sky'))(
    'renders Sky’s Compact table and its bytecode listing',
    async () => {
      const project = await projectFor('beneath-a-steel-sky');
      if (!project) throw new Error('the game is present and yet no project was built');

      let current = project;
      const editor = new SkyEditor({
        project: () => current,
        update: (mutate) => {
          current = mutate(current) ?? current;
        },
      });

      expect(() => editor.render()).not.toThrow();
      const text = editor.element.textContent ?? '';
      expect(text).toContain('compacts');
      // The listing is a section of its own, and it is reachable.
      expect(text).toMatch(/Module \d+ — listing/);

      const scripts = [...editor.element.querySelectorAll('button')].filter((button) =>
        /^script \d+$/.test(button.textContent ?? ''),
      );
      expect(scripts.length).toBeGreaterThan(0);
      expect(() => scripts[0].click()).not.toThrow();
      expect(editor.element.textContent).toContain('read-only');
    },
    120_000,
  );

  it.skipIf(!have('lure-of-the-temptress'))(
    'renders Lure’s palette surface',
    async () => {
      const project = await projectFor('lure-of-the-temptress');
      if (!project) throw new Error('the game is present and yet no project was built');

      let current = project;
      const editor = new LureEditor({
        project: () => current,
        update: (mutate) => {
          current = mutate(current) ?? current;
        },
      });

      expect(() => editor.render()).not.toThrow();
      expect(editor.element.textContent ?? '').toMatch(/palette/i);

      // And the typed half of the object table, which is the reason this family
      // has more than a palette surface.
      const positions = [...editor.element.querySelectorAll('button')].find((button) =>
        /positions, editable/.test(button.textContent ?? ''),
      );
      expect(positions).toBeDefined();
      expect(() => positions!.click()).not.toThrow();

      const x = editor.element.querySelector<HTMLInputElement>('input[aria-label$=" x"]');
      expect(x).not.toBeNull();

      // A move goes through the project rather than the DOM: the input's value is
      // re-derived from what a rewrite would put back, so the two cannot drift.
      const before = Number(x!.value);
      x!.value = String(before + 4);
      x!.dispatchEvent(new Event('change'));
      const moved = editor.element.querySelector<HTMLInputElement>('input[aria-label$=" x"]');
      expect(Number(moved!.value)).toBe(before + 4);
    },
    120_000,
  );
});
