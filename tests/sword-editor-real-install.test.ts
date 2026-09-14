/**
 * @vitest-environment jsdom
 */
/**
 * The editor surface, built from a **real install** rather than from a fixture.
 *
 * Every other Sword editor test builds its project with `fixtureSword.ts`, and
 * every Sword *engine* measurement goes through `bin/play-probe.ts`, which
 * drives the engine directly. So the sequence the browser actually performs —
 * `openGame`, `loadAdventureEngine`, `toEditableGame`, then the surface — had
 * no test taking it end to end, on either family.
 *
 * That gap is why this file exists. The owner reported both games as "not
 * playable nor editable" while every test and sweep in the repository was
 * green, and the one defect that audit did turn up (`SwordEngine.resolution`
 * scaling the pointer by 400/480) lived in exactly this untested seam: the
 * probe sets `SwordInput.x/y` itself and never asks the shell to convert a
 * click. A fixture cannot catch that class of bug, because a fixture is built
 * by the same code that reads it.
 *
 * **The install arrives as an environment variable, never as a path written
 * here.** `MGI_SWORD1_INSTALL` and `MGI_SWORD2_INSTALL` point at a folder the
 * person running the tests owns; with neither set the file skips, which is
 * what CI does. Naming a folder in `tests/` would tie a Target to where one
 * machine keeps its files, and this repository keeps that knowledge in run
 * configuration instead.
 */
import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { openGame } from '../src/hosting/openGame.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import { LoadProgressTracker } from '../src/engine/resource/progress.js';
import { Sword1Editor } from '../src/editor/sword1/Sword1Editor.js';
import { Sword2Editor } from '../src/editor/sword2/Sword2Editor.js';
import type { Project } from '../src/authoring/project.js';

/** The folder this family's install is at, when the runner named one. */
function install(variable: string): string | null {
  const named = process.env[variable];
  if (!named) return null;
  const path = resolve(named);
  return existsSync(path) ? path : null;
}

const SWORD1 = install('MGI_SWORD1_INSTALL');
const SWORD2 = install('MGI_SWORD2_INSTALL');

/**
 * The shell's own sequence, in the order `src/main.ts` performs it.
 *
 * `describeEditRefusal` is asserted null rather than ignored because that is
 * what disables the Edit button in the browser: a game the shell refuses is
 * one an author cannot open, however complete the surface behind it is.
 */
async function projectFor(path: string): Promise<Project> {
  const engine = await loadAdventureEngine(await openGame(path), { onLog: () => {} });
  expect(engine.describeEditRefusal?.()).toBeNull();
  const editable = await engine.toEditableGame?.({ progress: new LoadProgressTracker() });
  expect(editable).not.toBeNull();
  return editable!.project;
}

describe.runIf(SWORD1)('Broken Sword, opened from a real install', () => {
  it('reaches the editor and renders every section as an accordion', async () => {
    const project = await projectFor(SWORD1!);
    const editor = new Sword1Editor({ project: () => project, update: (edit) => edit(project) });

    const text = editor.element.textContent ?? '';
    for (const section of ['Screens', 'Objects', 'Scripts', 'Palettes', 'Pictures', 'Effects']) {
      expect(text).toContain(section);
    }

    // The owner's requirement is the SCUMM editor's sections *and* its
    // accordion, so the heads are asserted as well as the words: a surface
    // that lists the same names down one long column is a different thing.
    const heads = editor.element.querySelectorAll('.accordion-head');
    expect(heads.length).toBeGreaterThanOrEqual(6);
    for (const head of heads) expect(head.getAttribute('aria-expanded')).toBeTruthy();
  }, 180_000);

  /*
   * The two surfaces that are in the interpreter and in no cluster.
   *
   * Only a real install can carry this one: a folder of clusters has neither
   * table, and the whole point is that the folder the game ships *does* — the
   * interpreter is in the box. So the section only appears here, and the
   * standing on `rooms` only turns writable here.
   */
  it('shows the start positions it read out of the interpreter, and calls the room table writable', async () => {
    const project = await projectFor(SWORD1!);
    const sword1 = project.sword1!;
    expect(sword1.interpreter?.rooms?.toUpperCase()).toBe('SWORD.EXE');
    expect(sword1.interpreter?.startPositions?.toUpperCase()).toBe('SWORD.EXE');
    expect(sword1.startPositions?.length).toBeGreaterThan(0);
    expect(sword1.surfaces.rooms).toBe('editable');
    expect(sword1.surfaces.startPositions).toBe('editable');

    const editor = new Sword1Editor({ project: () => project, update: (edit) => edit(project) });
    expect(editor.element.textContent ?? '').toContain('Start positions');
  }, 180_000);
});

describe.runIf(SWORD2)('Broken Sword II, opened from a real install', () => {
  it('reaches the editor and renders every section as an accordion', async () => {
    const project = await projectFor(SWORD2!);
    const editor = new Sword2Editor({ project: () => project, update: (edit) => edit(project) });

    const text = editor.element.textContent ?? '';
    for (const section of ['Screens', 'Objects', 'Palettes', 'Animations', 'Text']) {
      expect(text).toContain(section);
    }

    const heads = editor.element.querySelectorAll('.accordion-head');
    expect(heads.length).toBeGreaterThanOrEqual(5);
    for (const head of heads) expect(head.getAttribute('aria-expanded')).toBeTruthy();
  }, 180_000);
});
