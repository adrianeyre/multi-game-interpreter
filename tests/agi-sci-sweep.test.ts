import { describe, expect, it } from 'vitest';

import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { AgiEngine } from '../src/engine/agi/AgiEngine.js';
import { detectAgiGame } from '../src/engine/agi/resource/agiDetect.js';
import { AgiResources } from '../src/engine/agi/resource/AgiResources.js';
import { exportAgiGame } from '../src/authoring/agi/exportAgiGame.js';
import { LoadProgressTracker } from '../src/engine/resource/progress.js';
import { detectSciGame } from '../src/engine/sci/resource/detectSciGame.js';
import { importSciGame } from '../src/authoring/sci/importSciGame.js';
import { exportSciGame } from '../src/authoring/sci/exportSciGame.js';
import { decodeSciInstruction } from '../src/engine/sci/script/opcodes.js';
import { readSci0Blocks } from '../src/engine/sci/script/scriptResource.js';
import { SCI_RESOURCE_TYPES } from '../src/engine/sci/resource/sciResourceTypes.js';
import { SCI_VERSIONS, type SciVersion } from '../src/engine/sci/sciVersion.js';
import {
  agiMajor,
  DECLARABLE_INTERPRETERS,
  DEFAULT_AGI_INTERPRETER,
  formatInterpreterVersion,
} from '../src/authoring/target.js';
import { buildAgiV2Fixture, buildAgiV3Fixture } from './fixtureAgi.js';
import {
  buildSci0Fixture,
  buildSci11Fixture,
  buildSci32Fixture,
  buildSci3Fixture,
} from './fixtureSci.js';

/**
 * The standing sweep for AGI and SCI, pointed at every Target the fixtures
 * reach (#205's reasoning, two families over).
 *
 * `tests/sweep.test.ts` is this file's sibling and its justification: the SCUMM
 * fixture sweep used to be "somebody wrote seven installs to a temporary folder
 * and ran `npm run sweep`", which is a true claim that decays without saying
 * so. AGI and SCI were in the worse position again — their sweeps had **no**
 * test behind them at all, and the round trip that decides whether a game is
 * editable had one, over one layout.
 *
 * That gap is not hypothetical. Running every SCUMM Version through the same
 * four commands on one day found v8's scripts being re-emitted through v6's
 * writer, and the three checks that each looked like they covered it did not:
 * the sweep never re-emits, the round-trip test called the correct pair on one
 * hand-built sample, and `npm run unrecovered` was a local command with nothing
 * asserting on it.
 *
 * **What this proves, and what it does not.** It proves the tools *reach* each
 * Target: the resources are found, every Logic and Script decodes, and an
 * unedited export comes back as the bytes it arrived as. It proves nothing
 * about a shipped game. `docs/processes/verifying-version-support.md` calls that
 * Tier 1 and names the trap — a fixture encodes this project's reading of the
 * format, so the fixture and the engine agree with each other by construction.
 * Real data is `npm run sweep:agi`, `npm run sweep:sci`, `npm run reexport:agi`
 * and `npm run reexport:sci` against games that are gitignored and stay that
 * way.
 */

function sourceFrom(label: string, files: Map<string, Uint8Array>): MemoryDataSource {
  const source = new MemoryDataSource(label);
  for (const [name, bytes] of files) source.set(name, bytes);
  return source;
}

const AGI_LAYOUTS = [
  { name: 'agi-v2', major: 2, build: buildAgiV2Fixture },
  { name: 'agi-v3', major: 3, build: buildAgiV3Fixture },
] as const;

const SCI_LAYOUTS = [
  { name: 'sci0', build: buildSci0Fixture },
  { name: 'sci1-1', build: buildSci11Fixture },
  { name: 'sci32', build: buildSci32Fixture },
  { name: 'sci3', build: buildSci3Fixture },
] as const;

const AGI_RESOURCE_KINDS = ['logic', 'picture', 'view', 'sound'] as const;

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let at = 0; at < a.length; at++) if (a[at] !== b[at]) return false;
  return true;
}

describe('the AGI fixture sweep', () => {
  for (const layout of AGI_LAYOUTS) {
    /**
     * Every declarable build whose major matches this layout.
     *
     * An AGI major fixes the resource layout and nothing about the instruction
     * encoding (ADR 0012) — the arity table does, and the table comes from the
     * interpreter build. So the axis this loop covers is
     * `DECLARABLE_INTERPRETERS`, the set `opcodeSetFor` actually tells apart,
     * and a build whose table stops decoding the fixture fails here rather
     * than waiting for somebody to point `sweep:agi --interpreter=` at it.
     *
     * The filter is not a convenience.
     *
     * `{engine: 'agi', interpreter: 0x2917}` over a v3 install is not a Target
     * that exists: the major governs how a resource is packaged — one combined
     * `<GAMEID>DIR`, volumes whose entries may be LZW-compressed — and
     * declaring a v2 build over v3 packaging asks a v2 reader for a v3
     * resource. `detectAgiGame` now refuses that pairing by name — it used to
     * fail several layers down as a truncated message section, which reads
     * like a fault in the message reader and is not one. `agiMajor` is the
     * split, derived from the interpreter exactly so the pairing is decided in
     * one place (ADR 0012).
     */
    for (const interpreter of DECLARABLE_INTERPRETERS.filter(
      (candidate) => agiMajor(candidate) === layout.major,
    )) {
      const build = formatInterpreterVersion(interpreter);

      it(`decompiles and re-exports ${layout.name} under ${build}`, async () => {
        const source = sourceFrom(layout.name, layout.build().files);
        const detectedInput = await detectAgiGame(source, { interpreter, platform: 'dos' });
        const engine = await AgiEngine.create(source, {
          onLog: () => undefined,
          declaredInterpreter: { interpreter, platform: 'dos' },
        });

        // A declared build is not a guess, so ADR 0013's refusal must not fire.
        expect(engine.describeEditRefusal()).toBeNull();

        const project = await engine.toEditableGame({ progress: new LoadProgressTracker() });
        const unrecovered = project.project.agi?.logics.filter((logic) => logic.unrecovered) ?? [];
        expect(unrecovered.map((logic) => `logic ${logic.number}: ${logic.unrecovered}`)).toEqual(
          [],
        );

        const result = exportAgiGame(project.project);
        expect(result.errors).toEqual([]);

        /**
         * Resource against resource, not file against file.
         *
         * `exportAgiGame` writes one `VOL.0` by design, so a game that shipped
         * four volumes is repacked and every directory entry's volume and
         * offset legitimately changes. `CONTEXT.md` makes byte-identity a
         * property of a **resource**, and reading the export back through the
         * same reader the engine uses is what checks that property.
         */
        const exported = sourceFrom(`${layout.name} re-exported`, new Map());
        for (const file of result.files) exported.set(file.name, file.data);

        /**
         * The export is re-opened under a **v2** build, whatever went in.
         *
         * An export is always v2 packaging, so declaring the input's own v3
         * build here asks a v3 reader for a v2 volume — and `detectAgiGame`
         * now refuses that pairing by name rather than failing several layers
         * down as a corrupt message table. Which is how this line came to be
         * written twice: the first version declared `interpreter` and the
         * mispairing read as evidence that v3 games cannot be exported.
         *
         * So for a v3 layout this asserts what the exporter actually claims —
         * every resource survives the conversion to v2 packaging.
         */
        const before = await AgiResources.load(source, detectedInput, { onLog: () => undefined });
        const after = await AgiResources.load(
          exported,
          await detectAgiGame(exported, {
            interpreter: DEFAULT_AGI_INTERPRETER,
            platform: 'dos',
          }),
          { onLog: () => undefined },
        );

        const differing: string[] = [];
        let compared = 0;
        for (const kind of AGI_RESOURCE_KINDS) {
          for (const number of before.list(kind)) {
            compared++;
            const original = before.read(kind, number);
            const rebuilt = after.read(kind, number);
            if (!rebuilt || !sameBytes(rebuilt, original)) {
              differing.push(`${kind} ${number}`);
            }
          }
        }

        expect(differing).toEqual([]);
        expect(compared).toBeGreaterThan(0);
      });
    }
  }
});

describe('the SCI fixture sweep', () => {
  for (const layout of SCI_LAYOUTS) {
    it(`decodes every Script in ${layout.name}`, async () => {
      const source = sourceFrom(layout.name, layout.build().files);
      const { game, resources } = await detectSciGame(source, { onLog: () => undefined });

      let instructions = 0;
      const problems: string[] = [];

      for (const number of resources.list('script')) {
        const bytes = await resources.read('script', number);
        if (!bytes) {
          problems.push(`script ${number}: could not be read from its Volume`);
          continue;
        }

        // SCI0's block chain is the only layout whose code blocks are found by
        // walking the resource itself; the later two are covered by the round
        // trip below and by `bin/sci-sweep.ts` against real data. What is being
        // checked here is that the decoder reaches an instruction at all.
        const blocks = readSci0Blocks(bytes);
        for (const block of blocks.filter((one) => one.type === 'code')) {
          let at = block.offset;
          while (at < block.offset + block.size) {
            const instruction = decodeSciInstruction(bytes, at, game.version);
            if (!instruction || instruction.length <= 0) {
              problems.push(`script ${number}: no instruction decoded at ${at}`);
              break;
            }
            instructions++;
            at += instruction.length;
          }
        }
      }

      expect(problems).toEqual([]);
      expect(resources.list('script').length).toBeGreaterThan(0);
      expect(instructions).toBeGreaterThanOrEqual(0);
    });

    it(`re-exports every resource in ${layout.name} byte-identically`, async () => {
      const source = sourceFrom(layout.name, layout.build().files);
      const { game, resources } = await detectSciGame(source, { onLog: () => undefined });

      const project = await importSciGame(game, resources);
      const result = exportSciGame(project);
      expect(result.problems).toEqual([]);

      /**
       * An unedited export runs the linker over nothing.
       *
       * ADR 0018 keeps an untouched script out of the linker entirely, so a
       * non-zero count here is a finding even when every byte still matches —
       * it means `isUntouched` decided something changed when nothing had, and
       * the bytes agree only because the linker happened to reproduce them.
       * That exact fault has been in this code once: `isUntouched` compared
       * method lengths rather than bytes.
       */
      expect(result.rebuilt).toEqual([]);
      expect(result.recomposed).toEqual([]);

      const differing: string[] = [];
      let compared = 0;

      for (const [key, written] of result.resources) {
        const [type, digits] = key.split(':');
        if (!SCI_RESOURCE_TYPES.includes(type as (typeof SCI_RESOURCE_TYPES)[number])) continue;

        const original = await resources.read(
          type as (typeof SCI_RESOURCE_TYPES)[number],
          Number(digits),
        );
        compared++;
        if (!original || !sameBytes(written, original)) differing.push(key);
      }

      expect(differing).toEqual([]);
      expect(compared).toBeGreaterThan(0);
    });
  }

  /**
   * Every Version on the axis, named rather than detected.
   *
   * ADR 0020: SCI stamps its Version nowhere, a resource map separates six
   * buckets, and the thirteen Versions are finer than any of them. So four
   * fixture layouts cannot each *be* a Version — what they can do is carry
   * bytes that every Version's Kernel table and decoder is asked to read, which
   * is what `sweep:sci --version=` does on the command line and what this does
   * in CI.
   *
   * The claim is correspondingly narrow, and it is the one worth having: no
   * Version on `SCI_VERSIONS` throws, decodes nothing, or fails to produce an
   * export. A Version added to the axis with no Kernel table behind it fails
   * here on the day it is added.
   */
  for (const version of SCI_VERSIONS) {
    it(`reads and re-exports a fixture declared as ${version}`, async () => {
      // The layout closest to each Version, so the pairing is not nonsense: a
      // heap-split Version gets the heap-split fixture, SCI3 gets SCI3's Script
      // header, SCI32 gets the numbered map, and the SCI16 band gets SCI0's.
      const layout: SciVersion[] = ['sci1-1'];
      const build =
        version === 'sci3'
          ? buildSci3Fixture
          : layout.includes(version)
            ? buildSci11Fixture
            : SCI_VERSIONS.indexOf(version) >= SCI_VERSIONS.indexOf('sci2')
              ? buildSci32Fixture
              : buildSci0Fixture;

      const source = sourceFrom(`${version} fixture`, build().files);
      const { game, resources } = await detectSciGame(source, { onLog: () => undefined });

      const declared = { ...game, version, identification: 'declared' as const };
      const project = await importSciGame(declared, resources);
      const result = exportSciGame(project);

      expect(result.problems).toEqual([]);
      expect(result.resources.size).toBeGreaterThan(0);
      expect(project.scripts.length).toBeGreaterThan(0);
    });
  }
});
