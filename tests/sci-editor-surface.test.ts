// @vitest-environment jsdom
/**
 * The SCI editing surface, tested for the decisions rather than for the pixels.
 *
 * Four of ADR 0018's and ADR 0013's conclusions are only true if the editor
 * behaves a particular way, and each is a thing that would rot silently:
 *
 * - vector and cel Pictures are two kinds, so the surface must not offer one in
 *   the other's panel;
 * - Source is a **view**, so the degradation must be visible rather than a
 *   guessed `if`;
 * - a guessed Version is refused, with the reason on screen;
 * - the editor says where this game keeps its words, and what it cannot reach.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';

import { SciEditor } from '../src/editor/sci/SciEditor.js';
import { AudioSection } from '../src/editor/audioSection.js';
import { fromBase64, toBase64 } from '../src/authoring/base64.js';
import { drawSciPicture } from '../src/engine/sci/gfx/SciPicture.js';
import {
  describeSciViewInPlace,
  readSciView,
  writeSciView,
} from '../src/engine/sci/gfx/SciView.js';
import { readSciFont, writeSciFont } from '../src/engine/sci/gfx/SciFont.js';
import { writeSciCursor } from '../src/engine/sci/gfx/SciCursor.js';
import { readSciVocabulary, writeSciVocabulary } from '../src/engine/sci/resource/sciVocabulary.js';
import { createProject, type Project, type SciProject } from '../src/authoring/project.js';
import { describeUnbuildableTarget } from '../src/authoring/projectToGame.js';
import { STORAGE_KEYS } from '../src/ui/storageKeys.js';

/**
 * Read from the working directory rather than from `import.meta.url`, because
 * this file runs under jsdom — where `URL` is the DOM's and `import.meta.url`
 * is not what it is under Node.
 */
function readCode(relative: string): string {
  return readFileSync(resolve(process.cwd(), relative), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

/**
 * A small but real vector Picture: set a colour, draw a two-point line, fill,
 * terminate. Real rather than empty because the panel's whole job is to show
 * and change operations, and an empty Picture has none.
 */
function vectorPictureBytes(): string {
  const absolute = (x: number, y: number): number[] => [
    ((x >> 4) & 0xf0) | ((y >> 8) & 0x0f),
    x & 0xff,
    y & 0xff,
  ];
  return toBase64(
    new Uint8Array([
      0xf0,
      4, // setColour 4
      0xf6,
      ...absolute(10, 20),
      ...absolute(90, 60), // longLines
      0xf8,
      ...absolute(50, 40), // fill
      0xff, // terminate
    ]),
  );
}

/** A one-loop, one-cel EGA View: a 2x2 cel of colour 3. */
function viewBytes(): string {
  return toBase64(
    writeSciView({
      loops: [
        {
          // **Two cels, because one cel cannot answer rows 15 and 18.** A frame
          // strip with a single frame in it looks identical whether the strip
          // works or does not, and a Play button over one cel is a button that
          // cannot be told from a broken one.
          cels: [
            {
              width: 2,
              height: 2,
              displaceX: 0,
              displaceY: 0,
              clearKey: 0,
              pixels: new Uint8Array([3, 3, 3, 3]),
            },
            {
              width: 2,
              height: 2,
              displaceX: 1,
              displaceY: 0,
              clearKey: 0,
              pixels: new Uint8Array([5, 5, 5, 5]),
            },
          ],
          mirrored: false,
          mirrorOf: 0,
        },
      ],
      paletteOffset: 0,
      vga: false,
      encoding: 'ega',
      resolution: null,
    }),
  );
}

/** A two-character font, one glyph inked in a corner. */
function fontBytes(): string {
  return toBase64(
    writeSciFont({
      lineHeight: 8,
      glyphs: [
        { width: 3, height: 2, pixels: new Uint8Array([1, 0, 0, 0, 0, 0]) },
        { width: 3, height: 2, pixels: new Uint8Array([0, 0, 0, 0, 0, 1]) },
      ],
    }),
  );
}

function cursorBytes(): string {
  const pixels = new Uint8Array(16 * 16).fill(0xff);
  pixels[0] = 1;
  return toBase64(writeSciCursor({ width: 16, height: 16, hotspotX: 0, hotspotY: 0, pixels }));
}

function vocabularyBytes(): string {
  return toBase64(
    writeSciVocabulary([
      { word: 'get', wordClass: 2, group: 100 },
      { word: 'take', wordClass: 2, group: 100 },
      { word: 'lamp', wordClass: 4, group: 200 },
    ]).bytes,
  );
}

function sciProject(overrides: Partial<SciProject> = {}): Project {
  const project = createProject('a sci game');
  project.target = { engine: 'sci', version: 'sci1-1' } as Project['target'];
  project.sci = {
    identification: { how: 'probe', evidence: ['RESOURCE.MAP is a sci11 map'] },
    selectors: ['-objID-', 'play', 'init', 'doit'],
    classes: [{ number: 4, script: 995 }],
    scripts: [
      {
        number: 0,
        objects: [
          {
            name: 'LB2',
            isClass: false,
            species: 4,
            superClass: 4,
            variables: [0, 1],
            variableSelectors: [0, 1],
            variablesAt: { resource: 'heap', offset: 10 },
            methods: [
              {
                selector: 'play',
                selectorNumber: 1,
                offset: 40,
                instructions: [
                  { offset: 40, name: 'push0', operands: [], raw: 0x79 },
                  // A backward branch, which the Source view degrades rather
                  // than guessing a loop from.
                  { offset: 41, name: 'jmp', operands: [-4], raw: 0x32 },
                  { offset: 44, name: 'ret', operands: [], raw: 0x48 },
                ],
              },
            ],
          },
        ],
        exports: [40],
        locals: [3, 7],
        localsAt: { resource: 'heap', offset: 4 },
        bytes: '',
      },
    ],
    resources: [
      { type: 'view', number: 0, bytes: viewBytes() },
      { type: 'font', number: 4, bytes: fontBytes() },
      { type: 'cursor', number: 1, bytes: cursorBytes() },
      { type: 'vocab', number: 0, bytes: vocabularyBytes() },
      { type: 'vocab', number: 997, bytes: '' },
      { type: 'sound', number: 3, bytes: '' },
    ],
    messages: [
      {
        resource: 210,
        noun: 1,
        verb: 2,
        cond: 0,
        seq: 1,
        talker: 9,
        text: 'A line of dialogue.',
        audio: 210,
        sync: 210,
      },
    ],
    vectorPictures: [{ type: 'pic', number: 95, bytes: vectorPictureBytes() }],
    celPictures: [
      {
        type: 'pic',
        number: 100,
        bytes: '',
        container: 'sci11',
        resolution: { width: 320, height: 200 },
        hasVectors: true,
        items: [{ headerAt: 40, width: 320, height: 190, x: 0, y: 0, priority: 0 }],
      },
    ],
    languages: [
      { number: 0, name: 'English', resourceCount: 12 },
      { number: 33, name: 'French', resourceCount: 12 },
    ],
    unrecoveredCount: 0,
    ...overrides,
  };
  return project;
}

function mount(project: Project): { editor: SciEditor; text: () => string } {
  const editor = new SciEditor({
    project: () => project,
    update: (mutate) => mutate(project),
  });
  return { editor, text: () => editor.element.textContent ?? '' };
}

/**
 * Open every collapsed section of the list.
 *
 * The column is `shell.ts`'s accordion, the same one SCUMM and both Broken
 * Swords use, so a section this surface does not start open renders no body at
 * all — which is the point of it, and which means a test wanting a row has to
 * ask for the section first. `aria-expanded` is read rather than assumed
 * because the open set is remembered in `localStorage` and jsdom keeps one of
 * those for a whole file.
 */
function openAllSections(root: HTMLElement): void {
  for (const head of root.querySelectorAll<HTMLButtonElement>('.accordion-head')) {
    if (head.getAttribute('aria-expanded') === 'false') head.click();
  }
}

/** What a section's header says is inside it, by the section's title. */
function sectionCount(root: HTMLElement, title: string): string | null {
  const head = [...root.querySelectorAll<HTMLButtonElement>('.accordion-head')].find(
    (button) => button.querySelector('.accordion-title')?.textContent === title,
  );
  return head?.querySelector('.accordion-count')?.textContent ?? null;
}

describe('the SCI surface is reached at all', () => {
  /**
   * The whole reason this file exists. The import, export and linker were
   * finished and tested for a round while nothing in `src/editor` imported any
   * of them — so every criterion phrased as *editable* was unmet however well
   * the library worked, and nothing said so.
   */
  it('is mounted from the editor rather than only from the tests', () => {
    const code = readCode('src/editor/main.ts');
    expect(code).toMatch(/SciEditor/);
    expect(code).toMatch(/case 'sci':/);
  });

  it('shares no editing surface with the AGI one', () => {
    expect(readCode('src/editor/sci/SciEditor.ts')).not.toMatch(/AgiEditor|decompileLogic/);
    expect(readCode('src/editor/agi/AgiEditor.ts')).not.toMatch(/SciEditor|sciSource|sciLinker/);
  });
});

describe('a guessed Version is refused, with the reason on screen', () => {
  /**
   * ADR 0013 and ADR 0020. The refusal replaces the surface rather than
   * annotating it: an editor that lists the resources and refuses at the save
   * has already let somebody do the work twice.
   */
  it('refuses, names the evidence, and shows no resources', () => {
    const project = sciProject();
    project.sci!.identification = {
      how: 'guess',
      evidence: ['probe "heap split": inconclusive'],
    };
    const { text } = mount(project);

    expect(text()).toMatch(/refused for editing/);
    expect(text()).toMatch(/probe "heap split": inconclusive/);
    // The reason, not just a verdict.
    expect(text()).toMatch(/stamps its Version nowhere/);
    // And nothing to edit.
    expect(text()).not.toMatch(/Vector Pictures/);
  });

  it('shows the resources when the Version was probed', () => {
    expect(mount(sciProject()).text()).toMatch(/Vector Pictures/);
  });
});

/**
 * Declaring the Version a probe could not settle.
 *
 * ADR 0020 has always said an author may state their Version and edit — and
 * until now nothing offered them anywhere to state it, so the refusal named a
 * remedy that could not be taken. This is not a way round ADR 0013: a *guess*
 * is still refused, and what changes is that a *declaration* is now reachable.
 */
describe('a guessed Version can be declared', () => {
  function guessed(): Project {
    const project = sciProject();
    project.target = { engine: 'sci', version: 'sci2-1-middle', platform: 'dos' };
    project.sci!.identification = {
      how: 'guess',
      evidence: ['narrowed to SCI2.1 middle, SCI2.1 late and no further'],
    };
    return project;
  }

  it('offers the Versions still standing, and not the whole axis', () => {
    const project = guessed();
    const editor = new SciEditor({ project: () => project, update: (m) => m(project) });
    const options = [...editor.element.querySelectorAll('#sci-declare-version option')].map(
      (option) => option.textContent,
    );
    // The probes excluded everything else; offering SCI0 would invite an author
    // to contradict a measurement rather than settle what it could not reach.
    expect(options).toEqual(['SCI2.1 middle', 'SCI2.1 late']);
  });

  it('records the declaration in the Project and stops refusing', () => {
    const project = guessed();
    const editor = new SciEditor({ project: () => project, update: (m) => m(project) });
    const picker = editor.element.querySelector('#sci-declare-version') as HTMLSelectElement;
    picker.value = 'sci2-1-late';
    [...editor.element.querySelectorAll('button')]
      .find((button) => button.textContent === 'Declare this Version')!
      .click();

    expect(project.target).toMatchObject({
      version: 'sci2-1-late',
      identification: 'declared',
    });
    // The evidence is kept beside it: what the probes did reach is the record of
    // why a person had to choose at all.
    expect(project.sci!.identification.how).toMatch(/declared as SCI2.1 late/);
    expect(project.sci!.identification.evidence.join(' ')).toMatch(/no further/);
    // And the surface stops refusing, which is the whole point.
    expect(editor.element.querySelector('.sci-refusal')).toBeNull();
  });

  it('warns that a wrong declaration is written into every resource', () => {
    const project = guessed();
    const editor = new SciEditor({ project: () => project, update: (m) => m(project) });
    expect(editor.element.querySelector('.sci-declare-bar')?.textContent).toMatch(
      /A declaration is not a probe/,
    );
  });
});

describe('two kinds of Picture, not one editor with a mode', () => {
  /**
   * ADR 0018. A vector drawing tool and a bitmap composition tool share no
   * editing operation, and one editor with half its buttons greyed out by
   * Version is the bag of flags ADR 0007's test exists to prevent.
   */
  it('lists them as two sections', () => {
    const { editor } = mount(sciProject());
    expect(sectionCount(editor.element, 'Vector Pictures')).toBe('1');
    expect(sectionCount(editor.element, 'Cel Pictures')).toBe('1');
  });

  it('edits a cel Picture as a composition, which a vector Picture has none of', () => {
    const project = sciProject();
    const { editor } = mount(project);
    openAllSections(editor.element);
    const button = [...editor.element.querySelectorAll('button')].find(
      (one) => one.getAttribute('aria-label') === 'cel picture 100, 1 items',
    );
    expect(button).toBeDefined();
    button!.click();

    const field = editor.element.querySelector<HTMLInputElement>(
      'input[aria-label="item 0 priority"]',
    );
    expect(field).toBeDefined();
    field!.value = '7';
    field!.dispatchEvent(new Event('change'));
    expect(project.sci!.celPictures[0].items[0].priority).toBe(7);
  });

  /**
   * The two panels share no control, which is ADR 0018's claim stated as a
   * test: a cel Picture is an arrangement of bitmaps at positions and a vector
   * Picture is a path of points, and two panels that turned out to want the
   * same controls would be the evidence against the decision.
   */
  it('offers drawing operations on the vector panel and no composition table', () => {
    const project = sciProject();
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label') === 'vector picture 95, drawing')!
      .click();

    expect(editor.element.querySelector('.sci-cel-items')).toBeNull();
    expect(editor.element.querySelectorAll('.sci-command').length).toBe(4);
    expect(editor.element.textContent).toMatch(/4 drawing operations/);
  });

  it('offers no drawing operations on the cel panel', () => {
    const project = sciProject();
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label') === 'cel picture 100, 1 items')!
      .click();

    expect(editor.element.querySelector('.sci-command-list')).toBeNull();
  });

  /**
   * The criterion this file exists to make true: a vector Picture is *editable*
   * rather than shown. Editing a point re-emits the resource, and the re-emitted
   * resource reads back with the change in it.
   */
  it('edits a drawing operation and re-emits the resource', () => {
    const project = sciProject();
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label') === 'vector picture 95, drawing')!
      .click();

    const operand = [...editor.element.querySelectorAll<HTMLInputElement>('.sci-operand')].find(
      (input) => input.getAttribute('aria-label')?.startsWith('longLines'),
    )!;
    operand.value = '10, 20, 120, 80';
    operand.dispatchEvent(new Event('change'));

    const written = drawSciPicture(fromBase64(project.sci!.vectorPictures[0].bytes), {
      vga: false,
      width: 320,
      height: 190,
    });
    const lines = written.commands.find((command) => command.op.endsWith('Lines'))!;
    expect(lines.args).toEqual([10, 20, 120, 80]);

    // And nothing else moved. The line run's *encoding* is not asserted: the
    // writer picks the tightest one the whole run fits, so a run that arrived
    // as `longLines` and whose points are a signed byte apart comes back as
    // `mediumLines`. That is the behaviour that lets an author drag a point out
    // of a three-bit step's reach without being refused, and asserting the
    // encoding here would be asserting the compression rather than the path.
    expect(
      written.commands.map((command) => command.op.replace(/(long|medium|short)/, 'x')),
    ).toEqual(['setColour', 'xLines', 'fill', 'terminate']);
  });

  /**
   * A Picture whose walk stopped is shown read-only, because writing back a
   * command list that ends where the reader gave up throws away everything
   * after it — silently, and with no way back.
   */
  it('refuses to edit a Picture it could not read to the end', () => {
    const project = sciProject();
    // An operation below 0xf0 where a command belongs: the walk desynchronised.
    project.sci!.vectorPictures[0].bytes = toBase64(new Uint8Array([0xf0, 4, 0x12, 0xff]));
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label') === 'vector picture 95, drawing')!
      .click();

    expect(editor.element.querySelector('.sci-operand')).toBeNull();
    expect(editor.element.textContent).toMatch(/shown read-only/);
  });
});

describe('Source is a view, and the degradation is visible', () => {
  let project: Project;
  let editor: SciEditor;

  beforeEach(() => {
    project = sciProject();
    ({ editor } = mount(project));
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label') === 'script 0, 1 object')!
      .click();
  });

  /**
   * The criterion in #220, and the thing that would rot silently: a view that
   * guesses at an `if` where it cannot reconstruct one reads as source and is
   * fiction.
   */
  it('says how many instructions it could not fold, rather than folding them anyway', () => {
    expect(editor.element.textContent).toMatch(/shown as themselves/);
    expect(editor.element.querySelector('.sci-degraded-count')?.className).toMatch(
      /sci-summary-warning/,
    );
  });

  it('parses an edited method back and relinks the script', () => {
    const source = editor.element.querySelector<HTMLTextAreaElement>('.sci-source')!;
    source.value = source.value.replace('push0', 'push1');
    editor.element.querySelector<HTMLButtonElement>('.sci-apply')!.click();
    expect(project.sci!.scripts[0].objects[0].methods[0].instructions[0].name).toBe('push1');
  });

  /**
   * An author who deletes an instruction gets an error rather than a method
   * that silently lost one — removing an instruction moves every offset after
   * it, which needs the linker rather than a rewrite in place.
   */
  it('refuses a deletion and says what it needs instead', () => {
    const source = editor.element.querySelector<HTMLTextAreaElement>('.sci-source')!;
    source.value = source.value.split('\n').slice(0, 1).join('\n');
    editor.element.querySelector<HTMLButtonElement>('.sci-apply')!.click();
    expect(editor.element.querySelector('.sci-problems')?.textContent).toMatch(/needs the linker/);
  });
});

describe('the editor says where this game keeps its words', () => {
  it('names MESSAGE where a game has them, and the artwork it cannot reach', () => {
    const text = mount(sciProject()).text();
    expect(text).toMatch(/MESSAGE resources, keyed by noun, verb, condition and sequence/);
    expect(text).toMatch(/baked into Views and Pictures is artwork/);
  });

  it('names the Script resource where a game keeps them inline', () => {
    const project = sciProject();
    project.sci!.messages = [];
    expect(mount(project).text()).toMatch(/inline in its Script resources/);
  });

  /**
   * #222: a release that ships four languages and imports one has lost three,
   * and by this project's own definitions that is `Unrecovered`. So the count
   * is on screen, named rather than totalled.
   */
  it('names every language a multilingual release ships', () => {
    const text = mount(sciProject()).text();
    expect(text).toMatch(/ships 2 languages/);
    expect(text).toMatch(/English \(12\)/);
    expect(text).toMatch(/French \(12\)/);
  });

  /**
   * A Message is one authored item with three faces under one key. Showing the
   * audio and the mouth timing beside the text is what stops a translation
   * updating the words and leaving the lip sync pointing at the old ones.
   */
  it('shows a Message with its audio and its mouth timing, by key', () => {
    const project = sciProject();
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label') === 'message 210, 1 lines')!
      .click();

    expect(editor.element.textContent).toMatch(/noun 1, verb 2, cond 0, seq 1/);
    expect(editor.element.textContent).toMatch(/speech in audio36 210/);
    expect(editor.element.textContent).toMatch(/mouth timing in sync36 210/);

    const text = editor.element.querySelector<HTMLTextAreaElement>('.sci-message-text')!;
    text.value = 'Une ligne de dialogue.';
    text.dispatchEvent(new Event('change'));
    expect(project.sci!.messages[0].text).toBe('Une ligne de dialogue.');
  });
});

describe('Views, fonts, cursors and vocabularies have surfaces of their own', () => {
  /**
   * #220's last criterion, and the one that stayed unmet longest. These four
   * used to be listed under "Carried through" — honest, and the whole of what
   * was missing.
   */
  function open(project: Project, label: string): SciEditor {
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label') === label)!
      .click();
    return editor;
  }

  it('gives each of them a section rather than one shared heading', () => {
    const { editor, text } = mount(sciProject());
    expect(sectionCount(editor.element, 'Views')).toBe('1');
    expect(sectionCount(editor.element, 'Fonts')).toBe('1');
    expect(sectionCount(editor.element, 'Cursors')).toBe('1');
    expect(sectionCount(editor.element, 'Vocabulary')).toBe('1');
    openAllSections(editor.element);
    // `vocab.997` is a Selector table rather than words, so it stays carried.
    expect(text()).toMatch(/1 sound, 1 vocab/);
  });

  /**
   * A cel's origin is where it sits relative to the actor's feet, and getting
   * it wrong stands every actor half a cel to one side — which reads as art
   * that does not line up rather than as a fault. Two signed bytes, and worth
   * being able to correct without a pixel editor.
   */
  it('edits a View cel origin and re-emits the resource', () => {
    const project = sciProject();
    const editor = open(project, 'view 0');
    const field = editor.element.querySelector<HTMLInputElement>(
      'input[aria-label="loop 0 cel 0 displaceX"]',
    )!;
    field.value = '-4';
    field.dispatchEvent(new Event('change'));

    const back = readSciView(fromBase64(project.sci!.resources[0].bytes));
    expect(back.loops[0].cels[0].displaceX).toBe(-4);
    expect([...back.loops[0].cels[0].pixels]).toEqual([3, 3, 3, 3]);
  });

  it('edits a font glyph a pixel at a time and re-emits the resource', () => {
    const project = sciProject();
    const editor = open(project, 'font 4');
    const dot = editor.element.querySelector<HTMLButtonElement>(
      'button[aria-label="1, 0, blank"]',
    )!;
    dot.click();

    const font = readSciFont(fromBase64(project.sci!.resources[1].bytes));
    expect([...font.glyphs[0].pixels]).toEqual([1, 1, 0, 0, 0, 0]);
    expect(font.lineHeight).toBe(8);
  });

  it('edits a cursor through its three states', () => {
    const project = sciProject();
    const editor = open(project, 'cursor 1');
    // White becomes black on the first click.
    editor.element.querySelector<HTMLButtonElement>('button[aria-label="0, 0, white"]')!.click();
    expect(
      mount(project).editor.element.querySelector('button[aria-label="0, 0, black"]'),
    ).toBeDefined();
  });

  /**
   * A word's *group* is what `said` matches, not its spelling — so adding a
   * synonym means giving a new word an existing group, and that is the one
   * operation this surface has to make possible.
   */
  it('edits a word and its group, and says what a group is', () => {
    const project = sciProject();
    const editor = open(project, 'vocabulary 0');
    expect(editor.element.textContent).toMatch(/3 words in 2 groups/);
    expect(editor.element.textContent).toMatch(/two words in one group are synonyms/);

    const group = editor.element.querySelector<HTMLInputElement>(
      'input[aria-label="word 0 group"]',
    )!;
    group.value = '200';
    group.dispatchEvent(new Event('change'));

    const words = readSciVocabulary(fromBase64(project.sci!.resources[3].bytes));
    expect(words.find((word) => word.word === 'get')?.group).toBe(200);
    expect(words).toHaveLength(3);
  });
});

/**
 * The folder bar, which is the gate on the two gestures that leave the editor.
 *
 * A SCI Project carries nothing about its container (ADR 0010, ADR 0020), so
 * Save and Play both need the folder back before they can pack anything. The
 * bar is where an author supplies it, and the two things worth asserting are
 * that it says so when none is open and that it is reachable on a game that is
 * refused for editing — because such a game still plays, and hiding the bar
 * under the refusal would make the one allowed gesture the unreachable one.
 */
describe('the re-supplied game folder', () => {
  it('says why one is needed, and offers the gesture', () => {
    const project = sciProject();
    const editor = new SciEditor({
      project: () => project,
      update: (mutate) => mutate(project),
      folderName: () => null,
      openGameFolder: async () => null,
    });

    const bar = editor.element.querySelector('.sci-folder-bar')!;
    expect(bar.textContent).toMatch(/ADR 0010, ADR 0034/);
    expect(bar.querySelector('button')?.textContent).toMatch(/Open game folder/);
  });

  it('names the folder once one is open', () => {
    const project = sciProject();
    const editor = new SciEditor({
      project: () => project,
      update: (mutate) => mutate(project),
      folderName: () => 'kq6',
      openGameFolder: async () => null,
    });

    expect(editor.element.querySelector('.sci-folder-name')?.textContent).toBe('kq6');
    expect(editor.element.querySelector('.sci-folder-bar button')?.textContent).toMatch(/Change/);
  });

  it('is still reachable on a game refused for editing, because that game plays', () => {
    const project = sciProject();
    project.sci!.identification = {
      how: 'guess',
      evidence: ['no probe separated SCI1 middle from SCI1 late'],
    };
    const editor = new SciEditor({
      project: () => project,
      update: (mutate) => mutate(project),
      folderName: () => null,
      openGameFolder: async () => null,
    });

    expect(editor.element.querySelector('.sci-folder-bar')).not.toBeNull();
    // And the refusal is still the whole of what is below it.
    expect(editor.element.querySelector('.sci-refusal')).not.toBeNull();
    expect(editor.element.querySelector('.sci-resource')).toBeNull();
  });

  it('mounts without one, and says the result cannot be packed', () => {
    const project = sciProject();
    const editor = new SciEditor({ project: () => project, update: (mutate) => mutate(project) });
    expect(editor.element.querySelector('.sci-folder-bar button')).toBeNull();
    expect(editor.element.querySelector('.sci-folder-bar')?.textContent).toMatch(
      /cannot be packed into an install/,
    );
  });
});

/**
 * Play and Save reach the SCI arm at all.
 *
 * The same failure `is mounted from the editor rather than only from the tests`
 * was written for, one layer out: the packer and the export can both be right
 * while `familySurface()` has no `play` for `sci` and `exportGameOnly` has no
 * arm for it, and then nothing a player or an author can press uses either.
 */
describe('the gestures that leave the editor', () => {
  it('gives the sci case a Play', () => {
    const code = readCode('src/editor/main.ts');
    expect(code).toMatch(/case 'sci':\s*\n?\s*return \{[^}]*play: playSci/);
  });

  it('packs rather than exporting loose resources, in both of them', () => {
    expect(readCode('src/editor/main.ts')).toMatch(/packSciGame/);
    expect(readCode('src/editor/save.ts')).toMatch(/packSciGame/);
  });

  /**
   * Save and Export game have to agree, and for a while they did not.
   *
   * The arm went into `exportGameOnly` and not into `buildFileSet`, which is
   * the route behind **Save to folder** and **Save as zip**. So the same
   * project exported a packed install through one button and, through the
   * other, wrote its JSON beside the SCUMM builder's complaint that the game
   * did not compile.
   */
  it('packs on the Save route as well as the Export game one', () => {
    const code = readCode('src/editor/save.ts');
    // `buildFileSet` is what `saveToFolder` and `saveWithDownloads` both call.
    const buildFileSet = code.slice(code.indexOf('async function buildFileSet'));
    const untilNextExport = buildFileSet.slice(0, buildFileSet.indexOf('export async function'));
    expect(untilNextExport).toMatch(/engine === 'sci'/);
    expect(untilNextExport).toMatch(/packSciGame/);
  });

  /**
   * What a SCI project was told when it reached the SCUMM builder.
   *
   * Every other family has an arm in `describeUnbuildableTarget` naming the
   * route that works. SCI had none, so it fell past the refusal into
   * `validateProject` and came back with `The game has no rooms` and
   * `The starting room (1) does not exist` — SCUMM's validation, about a
   * concept a class graph does not have. Measured before the arm was added,
   * not supposed.
   */
  it('refuses a SCI project by naming the packer rather than rooms it cannot have', () => {
    const project = createProject('SCI');
    project.target = { engine: 'sci', version: 'sci0-late', platform: 'dos' };

    const refusal = describeUnbuildableTarget(project);
    expect(refusal).toMatch(/SCI0 late/);
    expect(refusal).toMatch(/packSciGame/);
    // The SCUMM validator's own wording, which is what used to come back. The
    // refusal above says "no rooms, actors or verbs" itself, deliberately, so
    // this pins the sentence that was wrong rather than the two words in it.
    expect(refusal).not.toMatch(/The game has no rooms/);
    expect(refusal).not.toMatch(/The starting room/);
  });

  it('hands the zip over through the shared helper rather than a fourth copy', () => {
    // Every family's arm in this file calls `download` from `files.ts`, which
    // revokes the object URL on a timer — revoking it in the same tick cancels
    // the download in some browsers, and that mistake has been made more than
    // once here. The SCI arm is not where a private copy appears.
    const code = readCode('src/editor/save.ts');
    expect(code).toMatch(/`\$\{gameStem\(project\)\}-sci\.zip`/);
    expect(code).toMatch(/download\(name, zip as BlobPart/);
    expect(code).not.toMatch(/createObjectURL/);
  });
});

/**
 * Artwork out of the editor, which is half of what "editable" means for a
 * resource that is pixels.
 *
 * The buttons are asserted rather than clicked: the encode is a canvas, jsdom
 * has none, and what would break silently is not the encoder — it is a kind of
 * resource quietly having no way out at all.
 */
describe('exporting artwork', () => {
  /** Mounts, then selects a resource by the label its button carries. */
  function open(project: Project, label: string): SciEditor {
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label') === label)!
      .click();
    return editor;
  }

  for (const [surface, label] of [
    ['view 0', 'View 0 loop 0 cel 0'],
    ['font 4', 'font 4'],
    ['cursor 1', 'cursor 1'],
    ['vector picture 95, drawing', 'vector Picture 95'],
    ['cel picture 100, 1 items', 'cel Picture 100'],
  ] as const) {
    it(`offers a PNG of ${label}`, () => {
      const editor = open(sciProject(), surface);
      const button = editor.element.querySelector(`button[aria-label="export ${label} as a PNG"]`);
      expect(button?.textContent).toBe('Export PNG');
    });
  }

  it('says which palette a View was coloured with, because a View has none', () => {
    expect(open(sciProject(), 'view 0').element.textContent).toMatch(
      /coloured with EGA's sixteen colours/,
    );
  });

  it('goes through the shared PNG writer rather than a second download', () => {
    const code = readCode('src/editor/sci/SciEditor.ts');
    expect(code).toMatch(/writePng/);
    expect(code).not.toMatch(/createObjectURL|toBlob/);
  });
});

/**
 * The Audio panel: rows that are addresses, and the folder that lights them up.
 *
 * The same shape both Broken Swords have (`swordAudioPane.ts`) and for the same
 * reason — a SCI talkie's `RESOURCE.AUD` is hundreds of megabytes, so the
 * project holds which recording and never the recording (ADR 0034). What would
 * rot silently is the pairing: rows listed in a pane with no way to open the
 * folder read as a play button that does nothing.
 */
describe('the Audio section', () => {
  /** The shared, family-neutral section, with the shell's mutators stubbed. */
  function section(project: Project): AudioSection {
    return new AudioSection({
      tracks: () => project.audio,
      add: async () => project.audio[0],
      remove: () => undefined,
      rename: () => undefined,
    });
  }

  function withAudio(): Project {
    const project = sciProject();
    project.audio = [
      {
        id: 1,
        name: 'Audio 42',
        format: 'wav',
        filename: 'RESOURCE.AUD',
        resource: { engine: 'sci', kind: 'speech', number: 42, file: 'RESOURCE.AUD' },
      },
    ];
    // A room's speech map, which is what the panel says it does not reach.
    project.sci!.resources.push({ type: 'map', number: 200, bytes: '' });
    return project;
  }

  function openAudio(project: Project, audio: AudioSection): SciEditor {
    const editor = new SciEditor({
      project: () => project,
      update: (mutate) => mutate(project),
      audio,
      folderName: () => null,
      openGameFolder: async () => null,
    });
    openAllSections(editor.element);
    editor.element
      .querySelectorAll<HTMLButtonElement>('button[aria-label^="audio,"]')
      .forEach((button) => button.click());
    return editor;
  }

  it('lists the recordings in the column and opens them in the pane', () => {
    const project = withAudio();
    const editor = openAudio(project, section(project));

    const detail = editor.element.querySelector('.sci-resource-detail')!;
    expect(detail.textContent).toMatch(/Audio 42/);
    // The bar above the rows, not in some other pane: without a folder every
    // row lists and none of them plays.
    expect(detail.querySelector('.sci-folder-bar')).not.toBeNull();
  });

  it('names the per-room speech it does not list, rather than implying that is all', () => {
    const project = withAudio();
    const detail = openAudio(project, section(project)).element.querySelector(
      '.sci-resource-detail',
    )!;
    expect(detail.textContent).toMatch(/1 per-room speech map/);
    expect(detail.textContent).toMatch(/noun, verb, condition, sequence/);
  });

  it('says music is not here, because SCI’s is not a file', () => {
    const project = withAudio();
    const detail = openAudio(project, section(project)).element.querySelector(
      '.sci-resource-detail',
    )!;
    expect(detail.textContent).toMatch(/Music is not here/);
  });

  it('says a replacement does not reach the exported install, before one is made', () => {
    // The rows offer Replace because the shared section does, and a SCI export
    // carries `RESOURCE.AUD` through byte for byte (#227). Saying so on the
    // panel is the difference between a documented limit and a button that
    // looks like it changed the game.
    const project = withAudio();
    const detail = openAudio(project, section(project)).element.querySelector(
      '.sci-resource-detail',
    )!;
    expect(detail.textContent).toMatch(/does not change the exported install/);
  });

  it('mounts without a section at all, and says so instead of showing an empty pane', () => {
    const project = withAudio();
    const editor = new SciEditor({
      project: () => project,
      update: (mutate) => mutate(project),
    });
    // No Audio row in the column when there is no section to open.
    expect(editor.element.querySelector('button[aria-label^="audio,"]')).toBeNull();
  });

  it('reads its bytes through the shared resolver rather than a second reader', () => {
    // `readTrackBytes` is the one place that knows a track can be inline, in
    // the editor's store, or still in the game. The SCI arm points it at the
    // open folder and adds nothing beside it.
    const code = readCode('src/editor/main.ts');
    expect(code).toMatch(/setAudioResourceReader\(sciAudioReader\(result\)\)/);
    // `writeWavePcm` is the engine-level writer both families share — Broken
    // Sword's speech is RLE inside a WAVE header, SCI's SOL is raw PCM with no
    // container, and both end at the same forty-four bytes rather than at two
    // copies that could disagree about them.
    expect(readCode('src/editor/sci/audioResources.ts')).toMatch(/writeWavePcm/);
  });
});

/**
 * The left column, as the accordion the owner's own sentence asked for.
 *
 * This was the one row of `docs/editor-parity.md` that SCUMM, Simon and both
 * Broken Swords answered Yes to and SCI answered No to for a structural reason
 * that was not structural at all: `SciEditor.section` built a heading and a
 * body and rendered the body every time. On King's Quest VII that is 218
 * Scripts, 1,527 Views and 168 Cel Pictures in one column with no way to put
 * any of it away — and the count in the header, which is what makes a closed
 * section still informative, was in the heading's own text rather than
 * anywhere a reader could be told it was a count.
 *
 * The widget is `shell.ts`'s, unchanged, so what is asserted here is that this
 * surface uses it and not that it works: `tests/sword-editor.test.ts` already
 * holds that.
 */
describe('the list is an accordion, and remembers what was left open', () => {
  function forgetSections(): void {
    globalThis.localStorage?.removeItem(STORAGE_KEYS.editorSectionsSci);
  }

  it('opens the four sections a SCI game is mostly made of, Rooms first', () => {
    forgetSections();
    const { editor } = mount(sciProject());

    const open = [...editor.element.querySelectorAll('.accordion-head')]
      .filter((head) => head.getAttribute('aria-expanded') === 'true')
      .map((head) => head.querySelector('.accordion-title')?.textContent);
    // Rooms leads, and that is the whole of ADR 0037 expressed as an ordering:
    // a room is a view over a Script and the Picture it names, so every entry
    // here is already one of the Scripts below it. An author opening a game
    // looks for a place before they look for a class graph, so the derived
    // view comes first and the resource it derives from stays underneath.
    expect(open).toEqual(['Rooms', 'Scripts', 'Cel Pictures', 'Views']);
  });

  it('says how much is inside a section it has closed', () => {
    forgetSections();
    const { editor } = mount(sciProject());

    const closed = [...editor.element.querySelectorAll('.accordion-head')].find(
      (head) => head.querySelector('.accordion-title')?.textContent === 'Fonts',
    );
    expect(closed?.getAttribute('aria-expanded')).toBe('false');
    // Closed, and still saying there is one font behind it: a section that hid
    // its count would be hiding information rather than hiding detail.
    expect(closed?.querySelector('.accordion-count')?.textContent).toBe('1');
    expect(editor.element.querySelector('#sci-accordion-fonts')).toBeNull();
  });

  it('remembers what was opened, so a reopened editor is where it was left', () => {
    forgetSections();
    const project = sciProject();
    const first = mount(project);
    const head = [
      ...first.editor.element.querySelectorAll<HTMLButtonElement>('.accordion-head'),
    ].find((button) => button.querySelector('.accordion-title')?.textContent === 'Fonts');
    head!.click();

    const second = mount(project);
    const reopened = [...second.editor.element.querySelectorAll('.accordion-head')].find(
      (button) => button.querySelector('.accordion-title')?.textContent === 'Fonts',
    );
    expect(reopened?.getAttribute('aria-expanded')).toBe('true');
  });

  it('keeps its open sections apart from the other families', () => {
    // One key per family, for the reason `storageKeys.ts` gives: an author who
    // folded Views here has not asked for a Broken Sword's Screens to close.
    expect(STORAGE_KEYS.editorSectionsSci).not.toBe(STORAGE_KEYS.editorSections);
    expect(STORAGE_KEYS.editorSectionsSci).not.toBe(STORAGE_KEYS.editorSectionsSword1);
  });
});

/**
 * The other half of the class graph.
 *
 * A method body says what an object does; its properties say what it **is** —
 * which view an actor wears, which room a door leads to, what priority a prop
 * draws at. Until this existed the panel said "2 properties" and showed none
 * of them, which made every one of `docs/editor-parity.md`'s rows about
 * editing a record's own words a No for SCI while Broken Sword's compacts had
 * been editable word by word since that surface existed.
 *
 * The reason it can be done without the linker the method bodies are still
 * waiting for: an object's size is a word in its own header, a property is two
 * bytes, and nothing here moves either.
 */
describe('an object’s properties, and a script’s locals', () => {
  function openScript(project: Project): SciEditor {
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label')?.startsWith('script 0'))!
      .click();
    return editor;
  }

  it('names each property by its Selector rather than by its index', () => {
    const editor = openScript(sciProject());
    const rows = [...editor.element.querySelectorAll('.sci-properties tr')];
    // Head row, then one per property.
    expect(rows).toHaveLength(1 + 2);
    expect(editor.element.textContent).toMatch(/Properties \(2\)/);
    // `selectors[0]` is `-objID-` and `[1]` is `play` in the fixture.
    expect(editor.element.querySelector('input[aria-label^="-objID- on LB2"]')).not.toBeNull();
    expect(editor.element.querySelector('input[aria-label^="play on LB2"]')).not.toBeNull();
  });

  it('writes a changed property into the project', () => {
    const project = sciProject();
    const editor = openScript(project);
    const field = editor.element.querySelector<HTMLInputElement>(
      'input[aria-label^="play on LB2"]',
    )!;
    field.value = '31';
    field.dispatchEvent(new Event('change'));

    expect(project.sci!.scripts[0].objects[0].variables).toEqual([0, 31]);
  });

  it('refuses a value a sixteen-bit word cannot hold, rather than truncating it', () => {
    const project = sciProject();
    const editor = openScript(project);
    const field = editor.element.querySelector<HTMLInputElement>(
      'input[aria-label^="play on LB2"]',
    )!;
    field.value = '70000';
    field.dispatchEvent(new Event('change'));

    // Unchanged, and the field put back to what the file holds: 70000 & 0xffff
    // is 4464, and writing that is changing a number the author did not type.
    expect(project.sci!.scripts[0].objects[0].variables).toEqual([0, 1]);
    expect(field.value).toBe('1');
  });

  it('stores a negative property as the word the file would hold', () => {
    const project = sciProject();
    const editor = openScript(project);
    const field = editor.element.querySelector<HTMLInputElement>(
      'input[aria-label^="play on LB2"]',
    )!;
    field.value = '-1';
    field.dispatchEvent(new Event('change'));

    expect(project.sci!.scripts[0].objects[0].variables[1]).toBe(0xffff);
  });

  it('says which resource a word is written back into', () => {
    const editor = openScript(sciProject());
    // The fixture is SCI1.1, where the objects are in the heap and the code
    // resource is not touched by a property edit at all.
    expect(editor.element.textContent).toMatch(/written back into this script’s heap resource/);
  });

  it('calls script 0’s locals the game’s globals, and edits them', () => {
    const project = sciProject();
    const editor = openScript(project);
    expect(editor.element.textContent).toMatch(/Globals \(2\)/);

    const field = editor.element.querySelector<HTMLInputElement>(
      'input[aria-label="global 1 in script 0"]',
    )!;
    field.value = '9';
    field.dispatchEvent(new Event('change'));

    expect(project.sci!.scripts[0].locals).toEqual([3, 9]);
  });

  it('shows a value it does not know where to write, rather than a field that goes nowhere', () => {
    const project = sciProject();
    delete project.sci!.scripts[0].objects[0].variablesAt;
    const editor = openScript(project);

    expect(editor.element.querySelector('input[aria-label^="play on LB2"]')).toBeNull();
    expect(editor.element.textContent).toMatch(/shown and not edited/);
  });
});

/**
 * Row 22 of `docs/editor-parity.md`: the round trip stated **before** the edit.
 *
 * `linkSciScript` refuses every SCI1.1 heap pair and every SCI3 script — which
 * is every SCI game from 1992 on — and the refusal used to arrive at Apply,
 * after the method had been retyped. It is a fact about the script's layout
 * and not about what was typed, so it is knowable when the method is opened.
 */
describe('what a method edit is allowed to do, said before it is made', () => {
  /**
   * **A heap pair used to be the refused case and is not any more.** Every SCI
   * release from 1992 on ships this layout, and `linkSci11Script` relays it out
   * — method dictionaries, the export table's procedure entries and the
   * relocation table's positions all move with the bodies — so a body here may
   * change length exactly as a SCI0 one may.
   */
  it('says nothing of the kind about a heap pair, which is relinked', async () => {
    const { describeSciRelinking } = await import('../src/authoring/sci/sciLinker.js');
    const project = sciProject();
    // A heap pair: no SCI0 block chain in the code resource.
    project.sci!.scripts[0].bytes = toBase64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    project.sci!.scripts[0].heapBytes = toBase64(new Uint8Array(8));

    expect(describeSciRelinking(project.sci!.scripts[0])).toBeNull();
  });

  /**
   * SCI3 is what is left: its code, strings and relocations sit behind a fixed
   * 22-byte header that neither linker reads, so the refusal is narrower than
   * it was and still real.
   */
  it('says same-length-only for a SCI3 layout, which has no heap beside it', async () => {
    const { describeSciRelinking } = await import('../src/authoring/sci/sciLinker.js');
    const project = sciProject();
    project.sci!.scripts[0].bytes = toBase64(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
    delete project.sci!.scripts[0].heapBytes;

    expect(describeSciRelinking(project.sci!.scripts[0])).toMatch(/not lengthened or shortened/);

    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label')?.startsWith('script 0'))!
      .click();
    expect(editor.element.textContent).toMatch(/Same length only/);
  });

  it('says nothing of the kind about a script the linker does reach', async () => {
    const { describeSciRelinking } = await import('../src/authoring/sci/sciLinker.js');
    const { buildSci0Fixture } = await import('./fixtureSci.js');
    const { detectSciGame } = await import('../src/engine/sci/resource/detectSciGame.js');
    const { MemoryDataSource } = await import('../src/engine/resource/DataSource.js');
    const { importSciGame } = await import('../src/authoring/sci/importSciGame.js');

    const fixture = buildSci0Fixture();
    const { game, resources } = await detectSciGame(new MemoryDataSource('t', fixture.files));
    const imported = await importSciGame(game, resources);
    const script = imported.scripts.find((one) => one.objects.length > 0)!;

    expect(describeSciRelinking(script)).toBeNull();
  });
});

/**
 * Rows 14, 15 and 18, which were three Noes for one reason.
 *
 * The reason was not a fact about SCI. Nothing on this surface ever **drew** a
 * frame — every kind of artwork left it as a PNG and none of it appeared in
 * the pane — so there was no frame to pick, nothing to step, and no character's
 * art to put on a character's pane. A cast section exists since the last
 * branch, which is what made row 14 reachable at all.
 */
describe('a View is shown a frame at a time, and played back', () => {
  function open(project: Project, label: string): SciEditor {
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label') === label)!
      .click();
    return editor;
  }

  it('offers one radio per cel of the open loop, and one per loop', () => {
    const editor = open(sciProject(), 'view 0');
    const cels = [...editor.element.querySelectorAll('[role="radio"]')].map((one) =>
      one.getAttribute('aria-label'),
    );
    expect(cels).toContain('cel 0, 2 by 2');
    expect(cels).toContain('cel 1, 2 by 2');
    expect(cels).toContain('loop 0');
  });

  /**
   * The caption is what says which frame is drawn, and it is read rather than
   * the canvas because jsdom has no 2D context — so a test that looked at
   * pixels would pass on a surface that draws nothing at all.
   */
  it('draws the picked cel, and says which one with its own origin', () => {
    const editor = open(sciProject(), 'view 0');
    expect(editor.element.textContent).toMatch(/Cel 0 of 2, 2x2, origin 0, 0\./);

    [...editor.element.querySelectorAll<HTMLButtonElement>('[role="radio"]')]
      .find((one) => one.getAttribute('aria-label') === 'cel 1, 2 by 2')!
      .click();
    expect(editor.element.textContent).toMatch(/Cel 1 of 2, 2x2, origin 1, 0\./);
  });

  /**
   * Row 18. The button toggles, which is the part a test can hold: a timer
   * that steps a canvas cannot be looked at under jsdom, and a Play button
   * that never becomes a Stop button is one that did not start.
   */
  it('plays the loop and stops it again', () => {
    const editor = open(sciProject(), 'view 0');
    const play = [...editor.element.querySelectorAll<HTMLButtonElement>('button')].find(
      (one) => one.className === 'sci-play',
    )!;
    expect(play.getAttribute('aria-pressed')).toBe('false');
    play.click();
    expect(play.getAttribute('aria-pressed')).toBe('true');
    expect(editor.element.textContent).toMatch(/Playing at SCI's own default of one cel a cycle/);
    play.click();
    expect(play.getAttribute('aria-pressed')).toBe('false');
  });

  /**
   * **A SCI View carries no frame rate**, and the panel says so rather than
   * implying the speed was measured. That sentence is the honest half of row
   * 18's Yes.
   */
  it('names where the speed came from rather than implying a measurement', () => {
    const editor = open(sciProject(), 'view 0');
    expect(editor.element.textContent).toMatch(/A SCI View carries no frame rate of its own/);
  });
});

describe('a cast member has a pane, and their own art on it', () => {
  /**
   * A project with a real `Actor` chain, because the cast is derived from the
   * class graph and there is nothing to derive from without one.
   */
  function castProject(view: number): Project {
    const project = sciProject();
    const sci = project.sci!;
    // A View with a number of its own, because **0 is SCI's class default** and
    // an instance carrying it has declared nothing. The fixture's View 0 would
    // make "wears the View its property names" and "declares no View"
    // indistinguishable, which is the very pair this pane has to keep apart.
    sci.resources.push({ type: 'view', number: 7, bytes: viewBytes() });
    sci.selectors = ['-objID-', 'play', 'init', 'doit', 'view', 'loop', 'cel', 'cycleSpeed'];
    sci.classes = [{ number: 9, script: 0 }];
    sci.scripts[0].objects.push(
      {
        name: 'Actor',
        isClass: true,
        species: 9,
        superClass: 9,
        variables: [0, 0, 0, 0],
        variableSelectors: [4, 5, 6, 7],
        methods: [],
      },
      {
        name: 'rosella',
        isClass: false,
        species: 9,
        superClass: 9,
        variables: [view, 0, 0, 12],
        variableSelectors: [4, 5, 6, 7],
        variablesAt: { resource: 'heap', offset: 40 },
        methods: [],
      },
    );
    return project;
  }

  function openCast(project: Project): SciEditor {
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => (one.getAttribute('aria-label') ?? '').startsWith('cast 0'))!
      .click();
    return editor;
  }

  it('opens the member rather than whichever object of their Script comes first', () => {
    const editor = openCast(castProject(7));
    // The detail pane's own heading, not the accordion's — the list has h2s too.
    expect([...editor.element.querySelectorAll('h2')].map((one) => one.textContent)).toContain(
      'rosella',
    );
    expect(editor.element.textContent).toMatch(/An instance in Script 0/);
  });

  it("draws the View the member's own property word names, at their own speed", () => {
    const editor = openCast(castProject(7));
    expect(editor.element.textContent).toMatch(/View 7, from this instance's own view property/);
    expect(editor.element.textContent).toMatch(/this instance's own cycleSpeed of 12/);
    expect(editor.element.textContent).toMatch(/Cel 0 of 2/);
  });

  it('says by name when the instance ships SCI class default of View 0', () => {
    const editor = openCast(castProject(0));
    expect(editor.element.textContent).toMatch(
      /ships View 0 in its view property, which means the room dresses them in its own init/,
    );
  });

  /**
   * **65535 is SCI's own "no View"**, and a great many of a SCI game's cast
   * ship it because their room dresses them in `init`. An empty pane and "this
   * release names no artwork for them" are different facts and must not look
   * alike.
   */
  it('says by name when the file dresses nobody, rather than drawing View 0', () => {
    const editor = openCast(castProject(0xffff));
    expect(editor.element.textContent).toMatch(
      /ships SCI's own .no View., 65535 .* the room dresses them in its own init/,
    );
    expect(editor.element.textContent).not.toMatch(/Cel 0 of/);
  });

  it('names a View the release does not ship rather than showing an empty pane', () => {
    const editor = openCast(castProject(4242));
    expect(editor.element.textContent).toMatch(/wears View 4242, which this release does not ship/);
  });
});

/**
 * Row 17's No was two different sizes stacked into one cell.
 *
 * A **V56 cel** has no encoder — `writeSciView` patches a cel's origin in
 * place and does not re-encode pixels at all — so an import over one would
 * need an encoder per SCI cel compression, and none exists. A **font glyph**
 * and a **cursor** are the other end: their encoders are what the pixel grids
 * already call, so the only thing between them and an import was a picker.
 */
describe('a PNG comes back in where this project has an encoder for it', () => {
  function open(project: Project, label: string): SciEditor {
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => one.getAttribute('aria-label') === label)!
      .click();
    return editor;
  }

  const importButton = (editor: SciEditor): HTMLButtonElement | undefined =>
    [...editor.element.querySelectorAll<HTMLButtonElement>('button')].find((one) =>
      (one.textContent ?? '').startsWith('Import a PNG over'),
    );

  it('offers an import on a font glyph and on a cursor', () => {
    expect(importButton(open(sciProject(), 'font 4'))?.textContent).toBe(
      'Import a PNG over character 0',
    );
    expect(importButton(open(sciProject(), 'cursor 1'))?.textContent).toBe(
      'Import a PNG over cursor 1',
    );
  });

  /**
   * And on a View whose cels **do** have an encoder. `writeSciView` re-encodes
   * a SCI0 or SCI1 run-length body from its pixels, so those take a PNG; the
   * fixture's View is an EGA one and is one of them.
   */
  it('offers an import on a cel this project can re-encode', () => {
    expect(importButton(open(sciProject(), 'view 0'))?.textContent).toBe(
      'Import a PNG over loop 0 cel 0',
    );
  });

  /**
   * And not on a V56 View, which is the half of the row that is still a No.
   * `writeSciView` patches a V56 cel's origin in place and never re-encodes its
   * body, so a button there would write a cel back unencoded — worse than the
   * No it replaced.
   *
   * Held against `describeSciViewInPlace` rather than against a rendered pane,
   * because that sentence **is** the condition the button is behind, and the
   * jsdom fixture has no real V56 bytes to make one out of. The pane's own use
   * of it is one line above the button in `renderView`.
   */
  it('is behind the same sentence the pane shows about a V56 View', () => {
    const ega = readSciView(fromBase64(sciProject().sci!.resources[0].bytes));
    expect(describeSciViewInPlace(ega)).toBeNull();
    expect(describeSciViewInPlace({ ...ega, encoding: 'v56' })).toMatch(
      /written back in place[\s\S]*Its artwork is not re-encoded/,
    );
  });
});

/**
 * Row 11, which was the largest **No** left in the SCI column.
 *
 * The reason given was half right: a SCI walkable area is not a resource. From
 * SCI2 it is a `Polygon` a room builds in its own `init` from literal operands,
 * and that stream is decoded already — so the coordinates are numbers an author
 * can change, written back into the **instruction's own operand**, which is the
 * same word row 21 edits through the same linker.
 */
describe('a room shows its walk areas, and a point is a number', () => {
  const SELECTORS = ['-objID-', 'init', 'type', 'yourself', 'new', 'setPolygon', 'x', 'y', 'name'];
  const at = (name: string) => SELECTORS.indexOf(name);
  const POLYGON = 71;

  let offset = 0;
  const step = (name: string, ...operands: number[]) => ({
    offset: (offset += 3),
    name,
    operands,
    raw: 0,
  });

  function roomWithPolygon(): Project {
    const project = sciProject();
    const sci = project.sci!;
    sci.selectors = SELECTORS;
    sci.classes = [
      { number: POLYGON, script: 0 },
      { number: 90, script: 0 },
    ];
    sci.scripts = [
      {
        number: 42,
        objects: [
          {
            name: 'Polygon',
            isClass: true,
            species: POLYGON,
            superClass: POLYGON,
            variables: [],
            variableSelectors: [],
            methods: [],
          },
          {
            name: 'Room',
            isClass: true,
            species: 90,
            superClass: 90,
            variables: [0],
            variableSelectors: [at('name')],
            methods: [],
          },
          {
            name: 'theDesert',
            isClass: false,
            species: 0xffff,
            superClass: 90,
            variables: [0],
            variableSelectors: [at('name')],
            methods: [
              {
                selector: 'init',
                selectorNumber: at('init'),
                offset: 0,
                instructions: [
                  step('pushi', at('setPolygon')),
                  step('push1'),
                  step('pushi', at('type')),
                  step('push1'),
                  step('push2'),
                  step('pushi', at('init')),
                  step('pushi', 6),
                  step('pushi', 876),
                  step('pushi', 79),
                  step('pushi', 875),
                  step('pushi', 29),
                  step('pushi', 920),
                  step('pushi', 27),
                  step('pushi', at('yourself')),
                  step('push0'),
                  step('pushi', at('new')),
                  step('push0'),
                  step('class', POLYGON),
                  step('send', 4),
                  step('send', 30),
                  step('ret'),
                ],
              },
            ],
          },
        ],
        exports: [],
        locals: [],
        bytes: '',
      },
    ];
    return project;
  }

  function openRoom(project: Project): SciEditor {
    const { editor } = mount(project);
    openAllSections(editor.element);
    [...editor.element.querySelectorAll('button')]
      .find((one) => (one.getAttribute('aria-label') ?? '').startsWith('room 42'))!
      .click();
    return editor;
  }

  it('counts the room walk areas and names the kind each one is', () => {
    const editor = openRoom(roomWithPolygon());
    expect(editor.element.textContent).toMatch(/1 walk polygon, 3 points/);
    expect(editor.element.textContent).toMatch(/theDesert · barred access/);
  });

  /**
   * The edit lands on the instruction, which is the whole point: there is no
   * record to write, so what moves is the number the script pushes.
   */
  it("writes a moved point into the instruction's own operand", () => {
    const project = roomWithPolygon();
    const editor = openRoom(project);
    const field = editor.element.querySelector<HTMLInputElement>(
      'input[aria-label="theDesert polygon 0 point 0 x"]',
    )!;
    expect(field.value).toBe('876');
    field.value = '400';
    field.dispatchEvent(new Event('change'));

    const instructions = project.sci!.scripts[0].objects[2].methods[0].instructions;
    const pushes = instructions.filter((one) => one.name === 'pushi').map((one) => one.operands[0]);
    expect(pushes).toContain(400);
    expect(pushes).not.toContain(876);
    // And nothing else moved: the y beside it is the word it was.
    expect(pushes).toContain(79);
  });

  it('says so, rather than showing an empty panel, where a room states none', () => {
    const project = roomWithPolygon();
    project.sci!.scripts[0].objects[2].methods[0].instructions = [];
    expect(openRoom(project).element.textContent).toMatch(/states no walk polygon/);
  });
});
