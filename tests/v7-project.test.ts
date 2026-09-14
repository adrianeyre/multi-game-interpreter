import { describe, expect, it } from 'vitest';
import { createProject, migrate, type Project } from '../src/authoring/project.js';
import { describeUnbuildableTarget } from '../src/authoring/projectToGame.js';
import { emitActions } from '../src/authoring/actions.js';
import { Assembler } from '../src/authoring/Assembler.js';

/**
 * A v7 project.
 *
 * Every version branch in the editor was two-valued before this, and each was
 * wrong for v7 in a different way — the worst silently, by tagging a v7 import
 * as a v6 project holding v7 bytecode.
 */
describe('tagging a project with its version', () => {
  it('keeps a v7 tag through a migration rather than collapsing it to v5', () => {
    // `=== 6 ? 6 : 5` was correct with two targets and retagged v7 as v5 the
    // moment there was a third — a project of v7 instructions built with the
    // v5 assembler.
    const { target: _dropped, ...legacy } = createProject('v7 game');
    const project = { ...legacy, scummVersion: 7, version: 5 } as unknown;
    expect(migrate(JSON.parse(JSON.stringify(project))).target).toEqual({
      engine: 'scumm',
      version: 7,
    });
  });

  it('migrates every pre-Target scummVersion through the format-version path', () => {
    for (const version of [5, 6, 7] as const) {
      const { target: _dropped, ...base } = createProject('legacy');
      const project = { ...base, scummVersion: version, version: 5 } as unknown;
      expect(migrate(JSON.parse(JSON.stringify(project))).target).toEqual({
        engine: 'scumm',
        version,
      });
    }
  });

  it('still reads a project written before targets existed as v5, which it was', () => {
    // No target field of any kind, which genuinely means "written before v6
    // support" — distinct from a target that is present and unrecognised.
    const project = { version: 5, name: 'ancient', rooms: [], actors: [] };
    expect(migrate(project).target).toEqual({ engine: 'scumm', version: 5 });
  });

  /**
   * The hazard #123 documents, as a test that fails if it recurs.
   *
   * This function carried `=== 6 ? 6 : 5`, which silently retagged a v7 project
   * as v5 — a project holding v7 instructions built with the v5 assembler,
   * which loaded fine and compiled wrong. A second Engine family widens that
   * hazard: `{engine: 'scumm', version: 5}` is a plausible-looking wrong answer
   * for an AGI project in exactly the way `5` was for a v7 one.
   *
   * So a target that is *present and unrecognised* now refuses rather than
   * defaulting. This replaces a test that asserted the fallback, because the
   * fallback is the defect.
   */
  it('refuses a target it does not recognise rather than retagging it', () => {
    const { target: _dropped, ...legacy } = createProject('odd');
    const project = { ...legacy, scummVersion: 99, version: 5 } as unknown;
    expect(() => migrate(JSON.parse(JSON.stringify(project)))).toThrow(/v99|refused/);
  });

  it('refuses an unrecognised Target object rather than falling back to SCUMM', () => {
    const project = {
      ...createProject('odd'),
      target: { engine: 'agi', version: 6 },
      version: 6,
    } as unknown;
    expect(() => migrate(JSON.parse(JSON.stringify(project)))).toThrow(/recognise/);
  });

  it('reads an AGI Target back unchanged', () => {
    const project = {
      ...createProject('sq2'),
      target: { engine: 'agi', interpreter: 0x2917, platform: 'dos' },
      version: 6,
    } as unknown;
    expect(migrate(JSON.parse(JSON.stringify(project))).target).toEqual({
      engine: 'agi',
      interpreter: 0x2917,
      platform: 'dos',
    });
  });
});

describe('refusing to compile what cannot be compiled', () => {
  it('refuses a v7 project, naming v7 rather than v6', () => {
    const project: Project = {
      ...createProject('ft'),
      target: { engine: 'scumm', version: 7 },
    };
    expect(describeUnbuildableTarget(project)).toMatch(/v7/);
  });

  it('still refuses a v6 project, naming v6', () => {
    const project: Project = {
      ...createProject('dott'),
      target: { engine: 'scumm', version: 6 },
    };
    expect(describeUnbuildableTarget(project)).toMatch(/v6/);
  });

  it('still builds a v5 project', () => {
    expect(describeUnbuildableTarget(createProject('atlantis'))).toBeNull();
  });
});

describe('the custom-code action', () => {
  it('is refused in a v7 project, with the version named', () => {
    // ADR 0004's rule: `compile.ts` emits v5 bytecode, so custom code in a v7
    // project would compile to instructions the game's interpreter cannot read.
    // Refused where it can be attributed rather than mis-compiled.
    const warnings: string[] = [];
    const script = new Assembler();
    emitActions(script, [{ type: 'code', source: 'x = 1' }], {
      target: { engine: 'scumm', version: 7 },
      warnings,
    });

    expect(warnings.join(' ')).toMatch(/v7/);
  });
});
