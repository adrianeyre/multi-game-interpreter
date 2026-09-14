import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createProject, migrate, type Project } from '../src/authoring/project.js';
import { describeUnbuildableTarget } from '../src/authoring/projectToGame.js';
import { exportAgiGame } from '../src/authoring/agi/exportAgiGame.js';
import { describeUneditableTarget } from '../src/authoring/target.js';

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), 'utf8');
}

function readCode(relative: string): string {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/**
 * The two surfaces are separate, and the separation is the design.
 *
 * ADR 0013: an AGI project holds behaviour exactly one way, and a SCUMM project
 * holds it three. "The split is between project types, where the Target already
 * tells you which you have" — so the editor swaps surfaces rather than growing
 * a mode.
 */
describe('an AGI project never offers Action-based editing', () => {
  it('does not import ActionEditor into the AGI surface', () => {
    expect(readCode('src/editor/agi/AgiEditor.ts')).not.toMatch(/ActionEditor|from '.*actions/);
  });

  it('does not import the AGI surface into the SCUMM action editor', () => {
    expect(readCode('src/editor/ActionEditor.ts')).not.toMatch(/AgiEditor|decompileLogic/);
  });

  /**
   * One branch, at the mount point. More than one is how a family check spreads
   * through an editor a panel at a time.
   *
   * **Tightened when SCI arrived**, which is when the old shape would have
   * started spreading: this used to allow up to three `isAgiProject()`-shaped
   * questions, and a second family turned that into four. `familySurface()` is
   * a `switch` on the Target returning the surface to mount, so the count is
   * now exactly one and a third family adds a case rather than a predicate.
   */
  it('branches on Engine family exactly once, at the mount point', () => {
    const code = readCode('src/editor/main.ts');
    expect(code.match(/target\.engine/g) ?? []).toHaveLength(1);
    expect(code).toMatch(/function familySurface\(\)/);
  });
});

describe('a SCUMM project never offers Logic editing', () => {
  it('refuses to export a SCUMM project as AGI game files', () => {
    const result = exportAgiGame(createProject('a scumm game'));
    expect(result.errors.join(' ')).toMatch(/not an AGI project/);
  });

  /**
   * The mirror of the above, and ADR 0004's rule read for a second Engine
   * family: an AGI Target has an assembler, and it is not this one.
   */
  it('refuses to build an AGI project with the SCUMM builder, naming the route', () => {
    const project: Project = {
      ...createProject('an agi game'),
      target: { engine: 'agi', interpreter: 0x2917, platform: 'dos' },
    };
    const refusal = describeUnbuildableTarget(project);
    expect(refusal).toMatch(/AGI v2/);
    expect(refusal).toMatch(/re-emitting its Logic/);
  });
});

describe('editing is refused where the interpreter version was guessed', () => {
  /**
   * ADR 0013's rule, checked at the *project* level as well as at the engine's:
   * a rule enforced in one entry point is a rule with a way round it, and the
   * CLI reaches the importer directly.
   */
  it('refuses an AGI Target that fell back, and says what would fix it', () => {
    const refusal = describeUneditableTarget({
      engine: 'agi',
      interpreter: 0x2917,
      platform: 'dos',
      identification: 'fallback',
    });
    expect(refusal).toMatch(/cannot be edited/);
    expect(refusal).toMatch(/AGIDATA\.OVL/);
  });

  it('allows editing where the version was read out of the game', () => {
    expect(
      describeUneditableTarget({
        engine: 'agi',
        interpreter: 0x2917,
        platform: 'dos',
        identification: 'agidata',
      }),
    ).toBeNull();
  });
});

describe('an AGI project survives the project format', () => {
  /**
   * The AGI section is plain JSON like the rest of a project, so it goes
   * through local storage, a file and the migration path without ceremony —
   * which is the whole reason it is a section of `Project` rather than a second
   * project type (ADR 0013).
   */
  it('migrates with its resources and its Unrecovered count intact', () => {
    const project: Project = {
      ...createProject('agi'),
      target: { engine: 'agi', interpreter: 0x3149, platform: 'dos' },
      agi: {
        interpreter: { identification: 'agidata', evidence: 'AGIDATA.OVL says 3149' },
        logics: [{ number: 0, bytes: 'AAA=' }],
        pictures: [],
        views: [],
        sounds: [],
        words: [['look', 1]],
        inventory: { items: [], maxAnimatedObjects: 0, encrypted: false },
        unrecoveredCount: 1,
      },
    };

    const reloaded = migrate(JSON.parse(JSON.stringify(project)));
    expect(reloaded.target).toEqual({ engine: 'agi', interpreter: 0x3149, platform: 'dos' });
    expect(reloaded.agi?.unrecoveredCount).toBe(1);
    expect(reloaded.agi?.logics[0].bytes).toBe('AAA=');
  });
});

describe('the AGI surface shows what ADR 0013 says it must', () => {
  const source = read('src/editor/agi/AgiEditor.ts');

  /**
   * The Unrecovered count is a published number with a target of zero. A number
   * that only appears in a log is not one anybody drives down.
   */
  it('shows the Unrecovered count in the editor, not only in the log', () => {
    expect(source).toMatch(/unrecoveredCount/);
    expect(source).toMatch(/Unrecovered and open read-only/);
  });

  it('shows how the interpreter version was established beside the count', () => {
    expect(source).toMatch(/interpreter\.evidence/);
  });

  /** An author who cannot edit something is owed the reason, in plain words. */
  it('explains why an Unrecovered Logic is read-only', () => {
    expect(source).toMatch(/This Logic is Unrecovered and cannot be edited/);
    expect(source).toMatch(/better decompiler, never a/);
  });

  /**
   * The two facts about AGI that are unlike SCUMM and would otherwise surprise
   * an author: a picture's draw commands decide what blocks walking, and a
   * mirrored loop shares its source's bytes.
   */
  it('says that editing a picture edits what blocks walking', () => {
    expect(source).toMatch(/edits what blocks walking/);
  });

  it('says that editing a mirror source changes the mirror too', () => {
    expect(source).toMatch(/both will change|changes them too/);
  });
});
