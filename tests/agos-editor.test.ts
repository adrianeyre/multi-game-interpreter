// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DRAW_FLAGS } from '../src/engine/agos/gfx/vgaImages.js';
import { bitmapOf } from '../src/authoring/agos/paint.js';
import { AgosEditor, type AgosEditorOptions } from '../src/editor/agos/AgosEditor.js';
import { paintBitmap } from '../src/editor/agos/AgosImageCanvas.js';
import { MemoryDataSource } from '../src/engine/resource/DataSource.js';
import { loadAdventureEngine } from '../src/engine/loadEngine.js';
import type { Project } from '../src/authoring/project.js';
import { buildGamePc, buildGraphicsArchive } from './fixtureAgos.js';

async function agosProject(): Promise<Project> {
  const source = new MemoryDataSource('simon-editor');
  source.set('GAMEPC', buildGamePc({ withSpeech: true }));
  source.set('SIMON.GME', buildGraphicsArchive());
  source.set('SIMON.VOC', Uint8Array.of(0));
  const engine = await loadAdventureEngine(source);
  const editable = await engine.toEditableGame({ progress: undefined as never });
  if (!editable) throw new Error('AGOS produced no editable game');
  return editable.project;
}

function editorFor(project: Project) {
  let current = project;
  const editor = new AgosEditor({
    project: () => current,
    update: (mutate) => {
      // A copy, the way the editor's own state store works: the surface must
      // not depend on mutating the object it was handed.
      const next = structuredClone(current);
      mutate(next);
      current = next;
    },
  });
  return { editor, project: () => current };
}

/**
 * The bit a *pixel entry* uses to say its bytes are run-length coded.
 *
 * Not `DRAW_FLAGS.compressed`, which is a flag a script passes to a draw.
 * Simon 1's entries carry `0x80` and nothing else — see `isCompressedEntry`.
 */
const COMPRESSED_ENTRY = 0x80;

/** The sidebar's section titles, which is what `<h3>` used to be. */
function sectionTitles(editor: AgosEditor): string[] {
  return [...editor.element.querySelectorAll('.accordion-heading')].map((heading) => {
    const title = heading.querySelector('.accordion-title')?.textContent ?? '';
    const count = heading.querySelector('.accordion-count')?.textContent ?? '';
    return `${title} (${count})`;
  });
}

/** A sidebar row or a table cell button, by the text it starts with. */
function clickButton(editor: AgosEditor, startsWith: string): void {
  const button = [...editor.element.querySelectorAll('button')].find((each) =>
    each.textContent?.startsWith(startsWith),
  );
  button?.click();
}

/**
 * Opens zone 2's only image, which is two clicks: the zone, then its row.
 *
 * The row is in the properties column rather than in a strip under the canvas —
 * a zone of 1,828 images made that strip taller than the canvas it sat below.
 */
function openImage(editor: AgosEditor): void {
  clickButton(editor, 'Zone 2');
  editor.element.querySelector<HTMLButtonElement>('.agos-art-rows .agos-art-row')?.click();
}

/** The art canvas, which is always in the document and hidden when unusable. */
function artCanvas(editor: AgosEditor): HTMLCanvasElement {
  return editor.element.querySelector<HTMLCanvasElement>('.agos-image-canvas')!;
}

describe('the AGOS editing surface', () => {
  it('lists what an AGOS project holds, art included', async () => {
    // Art is a *fourth* section, and it being here is the wiring working: the
    // pixels are not in `GAMEPC`, so it appears only because the project was
    // built with a `ZoneSource` behind it. A project built from the base file
    // alone has no `art` at all — undefined rather than empty, because a caller
    // with no zones and a game with no art are different facts.
    const { editor } = editorFor(await agosProject());

    // Collapsible counted sections, the same ones the SCUMM sidebar uses, so a
    // closed section still says how much is inside it.
    expect(sectionTitles(editor)).toEqual([
      'Items (2)',
      'Strings (3)',
      // Rooms before Art: a room is the game's own noun for a place and a zone
      // is the archive's. The fixture's item 2 carries a room record naming
      // Subroutine 42, which is the one room here.
      'Rooms (1)',
      'Art (1)',
      'Subroutines (2)',
    ]);
  });

  it('lists a zone per section when the project carries art', async () => {
    const base = await agosProject();
    const withArt = {
      ...base,
      agos: {
        ...base.agos!,
        art: {
          zones: [2, 3],
          images: [{ zone: 2, id: 10, width: 8, height: 4, flags: 0 }],
          unreadableZones: [3],
        },
      },
    };
    const { editor } = editorFor(withArt);

    // Two zones, one of which is unreadable — the count is zones, because a
    // zone is the thing the sidebar lists.
    expect(sectionTitles(editor)).toContain('Art (2)');
    // The unreadable zone is labelled as such rather than shown as empty.
    expect(editor.element.textContent).toContain('unreadable');
  });

  it('shows how the Version was identified, because the count means nothing without it', async () => {
    const { editor } = editorFor(await agosProject());

    expect(editor.element.textContent).toContain('Version identified by');
    expect(editor.element.textContent).toContain('Unrecovered: 0');
  });

  it('states a string edit’s reach before the edit rather than after', async () => {
    const { editor } = editorFor(await agosProject());
    const stringButton = [...editor.element.querySelectorAll('button')].find((each) =>
      each.textContent?.startsWith('0:'),
    );
    stringButton?.click();

    // The pool is shared, so an edit reaches every user of it — which is the
    // whole reason this surface differs from AGI's.
    expect(editor.element.querySelector('.agos-reach')?.textContent).toMatch(
      /No subroutine refers|Editing this changes it for/,
    );
  });

  it('edits a pooled string through the project rather than in place', async () => {
    const { editor, project } = editorFor(await agosProject());
    const stringButton = [...editor.element.querySelectorAll('button')].find((each) =>
      each.textContent?.startsWith('1:'),
    );
    stringButton?.click();

    const field = editor.element.querySelector('textarea');
    expect(field).not.toBeNull();
    field!.value = 'a longer line than before';
    field!.dispatchEvent(new Event('change'));

    expect(atob(project().agos!.textBase64)).toContain('a longer line than before');
  });

  it('moves an item, which is the only structural change an AGOS world has', async () => {
    const { editor, project } = editorFor(await agosProject());
    const itemButton = [...editor.element.querySelectorAll('button')].find(
      (each) => each.textContent === 'Item 3',
    );
    itemButton?.click();

    const parent = editor.element.querySelector('input[type="number"]') as HTMLInputElement;
    parent.value = '0';
    parent.dispatchEvent(new Event('change'));

    // 0 means nowhere, which is how a game destroys something.
    expect(project().agos!.items[1]!.parent.raw).toBe(0xffffffff);
  });

  it('shows a Subroutine as a listing and says why it is not a reconstruction', async () => {
    const { editor } = editorFor(await agosProject());
    const subroutine = [...editor.element.querySelectorAll('button')].find((each) =>
      each.textContent?.startsWith('Verb table'),
    );
    subroutine?.click();

    expect(editor.element.querySelector('.agos-listing')?.textContent).toContain('o_at');
    // The listing is still a listing rather than reconstructed source, and the
    // note still says so. What changed is that it is no longer *read-only*:
    // operand values are editable, and the note draws the line at the opcodes
    // and the shape of the line, which are not.
    expect(editor.element.textContent).toContain('listing rather than a reconstruction');
    expect(editor.element.textContent).toContain('Operand values are');
  });

  it('offers an operand of a Subroutine as an editable field', async () => {
    const { editor } = editorFor(await agosProject());
    [...editor.element.querySelectorAll('button')]
      .find((each) => each.textContent?.startsWith('Verb table'))
      ?.click();

    const fields = [...editor.element.querySelectorAll('.agos-operand input')];
    expect(fields.length).toBeGreaterThan(0);
    // Located by position, because an operand has no name — the argument table
    // gives it a letter and the opcode gives it a meaning.
    expect(editor.element.querySelector('.agos-operand')?.textContent).toContain('Line 0');
  });

  it('puts the old value back when an operand edit does not fit its field', async () => {
    // A number field that keeps a refused value looks like it was accepted,
    // which is the failure this guards: what is on screen has to be what is in
    // the game.
    const { editor } = editorFor(await agosProject());
    [...editor.element.querySelectorAll('button')]
      .find((each) => each.textContent?.startsWith('Subroutine 42'))
      ?.click();

    const byte = [...editor.element.querySelectorAll('.agos-operand')].find((each) =>
      each.textContent?.includes('byte'),
    );
    const input = byte?.querySelector('input');
    if (!input) return;
    const before = input.value;

    input.value = '70000';
    input.dispatchEvent(new Event('change'));

    expect(input.value).toBe(before);
    expect(byte?.textContent).toContain('does not fit');
  });
});

/**
 * Adding and removing instructions from the surface.
 *
 * The authoring layer gained these first, and without a control nobody could
 * use them — so what these check is that the surface reaches the same rules the
 * authoring functions enforce, rather than a second permissive copy of them.
 */
describe('the AGOS surface can change a line structurally', () => {
  async function onSubroutine() {
    const { editor, project } = editorFor(await agosProject());
    [...editor.element.querySelectorAll('button')]
      .find((each) => each.textContent?.startsWith('Subroutine 42'))
      ?.click();
    return { editor, project };
  }

  it('says a line can change length without renumbering, because it can', async () => {
    const { editor } = await onSubroutine();

    expect(editor.element.textContent).toContain('refers to');
    expect(editor.element.textContent).toContain('nothing has to be renumbered');
  });

  it('offers a delete control per instruction', async () => {
    const { editor } = await onSubroutine();

    const deletes = editor.element.querySelectorAll('.agos-delete-instruction');
    expect(deletes.length).toBeGreaterThan(0);
  });

  it('removes an instruction when the control is used', async () => {
    const { editor, project } = await onSubroutine();
    const before = project().agos!.subroutines.subroutines.find((each) => each.id === 42)!.lines[0]!
      .instructions.length;

    editor.element.querySelector<HTMLButtonElement>('.agos-delete-instruction')?.click();

    const after = project().agos!.subroutines.subroutines.find((each) => each.id === 42)!.lines[0]!
      .instructions.length;
    expect(after).toBe(before - 1);
  });

  it('refuses an opcode the Version has no entry for, and writes nothing', async () => {
    // The failure this prevents: an opcode with no table entry decodes as
    // whatever follows it, which makes a whole line unreadable rather than one
    // instruction wrong.
    const { editor, project } = await onSubroutine();
    const before = project().agos!.subroutines.subroutines.find((each) => each.id === 42)!.lines[0]!
      .instructions.length;

    const wrapper = editor.element.querySelector('.agos-insert-instruction')!;
    const input = wrapper.querySelector('input')!;
    input.value = '250';
    wrapper.querySelector('button')!.click();

    const after = project().agos!.subroutines.subroutines.find((each) => each.id === 42)!.lines[0]!
      .instructions.length;
    expect(after).toBe(before);
    expect(wrapper.textContent).toContain('is not in');
  });

  it('adds an instruction with operands of the shapes its opcode takes', async () => {
    const { editor, project } = await onSubroutine();
    const before = project().agos!.subroutines.subroutines.find((each) => each.id === 42)!.lines[0]!
      .instructions.length;

    const wrapper = editor.element.querySelector('.agos-insert-instruction')!;
    // Opcode 11 takes a single `B`, so a blank one is a byte.
    wrapper.querySelector('input')!.value = '11';
    wrapper.querySelector('button')!.click();

    const line = project().agos!.subroutines.subroutines.find((each) => each.id === 42)!.lines[0]!;
    expect(line.instructions).toHaveLength(before + 1);
    expect(line.instructions.at(-1)).toMatchObject({ opcode: 11 });
    expect(line.instructions.at(-1)!.operands[0]).toMatchObject({ kind: 'byte' });
  });
});

/**
 * Opening one image.
 *
 * The pixels do not live in the Project — a Project is serialised and a game's
 * art runs to megabytes — so the surface takes a callback for them. Which means
 * there are three states worth asserting and not one: no callback at all, a
 * callback that cannot find the zone, and a zone that reads.
 */
describe('the AGOS art surface can open an image', () => {
  /**
   * A zone holding one 4x2 uncompressed image, laid out as the entry reader
   * expects.
   *
   * The layout is not guessable and was got wrong first time: entries are
   * **eight** bytes at `image * 8`, and the width is stored in *bits* rather
   * than pixels or bytes. Written out field by field so the next reader does
   * not have to rediscover that.
   */
  function zoneWithOneImage(): Uint8Array {
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    const at = 1 * 8; // entry for image 1; image 0 has no entry
    view.setUint32(at, 32, false); // where its pixels start
    bytes[at + 4] = 0; // flags: uncompressed
    bytes[at + 5] = 2; // two rows
    view.setUint16(at + 6, 4, false); // four pixels wide, so two bytes a row
    bytes.set([0x12, 0x34, 0x56, 0x78], 32);
    return bytes;
  }

  function projectWithArt(base: Awaited<ReturnType<typeof agosProject>>, flags = 0) {
    return {
      ...base,
      agos: {
        ...base.agos!,
        art: {
          zones: [2],
          images: [{ zone: 2, id: 1, width: 4, height: 2, flags }],
          unreadableZones: [],
        },
      },
    };
  }

  it('says the pixels are unreachable rather than drawing a blank canvas', async () => {
    // A blank canvas reads as a blank image, which is a different claim.
    const { editor } = editorFor(projectWithArt(await agosProject()));
    openImage(editor);

    // ADR 0034's sentence: the pixels are not in the project because the
    // archive is too large to keep, and the way to get them is the folder.
    expect(editor.element.textContent).toContain('resource archive');
    expect(editor.element.textContent).toContain('Open the game folder');
    expect(artCanvas(editor).hidden).toBe(true);
  });

  it('draws an image at the size its entry gives', async () => {
    const base = projectWithArt(await agosProject());
    const editor = new AgosEditor({
      project: () => base,
      update: () => {},
      readZonePixels: () => zoneWithOneImage(),
    });
    openImage(editor);

    const canvas = artCanvas(editor);
    expect(canvas.hidden).toBe(false);
    expect(canvas.width).toBe(4);
    expect(canvas.height).toBe(2);
    // Labelled, because a canvas is otherwise invisible to a screen reader.
    expect(canvas.getAttribute('aria-label')).toContain('4 by 2');
  });

  it('says a compressed image is writable too, because there is an encoder for it', async () => {
    // Simon 1's sprites are compressed almost throughout, so refusing the form
    // meant an Art tab that showed a game's art and would change none of it.
    // What is still refused is a masked draw, whose pixels are half a picture.
    for (const [flags, expected] of [
      [0, 'Writable'],
      [COMPRESSED_ENTRY, 'Writable'],
      [DRAW_FLAGS.masked, 'Not writable'],
    ] as const) {
      const base = projectWithArt(await agosProject(), flags);
      const editor = new AgosEditor({
        project: () => base,
        update: () => {},
        readZonePixels: () => zoneWithOneImage(),
      });
      openImage(editor);

      expect(editor.element.textContent).toContain(expected);
    }
  });

  it('reports a zone whose pixels the callback cannot find', async () => {
    const base = projectWithArt(await agosProject());
    const editor = new AgosEditor({
      project: () => base,
      update: () => {},
      readZonePixels: () => undefined,
    });
    openImage(editor);

    expect(editor.element.textContent).toContain('could not be read');
  });
});

/**
 * Painting a pixel.
 *
 * The write half is a callback for the same reason the read half is, so the
 * three states worth asserting are: no writer (painting not offered), a paint
 * that lands, and a paint the write-back refuses.
 */
describe('the AGOS art surface can paint a pixel', () => {
  function zoneWithOneImage(flags = 0): Uint8Array {
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    const at = 1 * 8;
    view.setUint32(at, 32, false);
    bytes[at + 4] = flags;
    bytes[at + 5] = 2;
    view.setUint16(at + 6, 4, false); // four pixels wide, so two bytes a row
    bytes.set([0x12, 0x34, 0x56, 0x78], 32);
    return bytes;
  }

  async function surface(
    base: Awaited<ReturnType<typeof agosProject>>,
    flags: number,
    allowPainting = true,
  ) {
    const withArt = {
      ...base,
      agos: {
        ...base.agos!,
        art: {
          zones: [2],
          images: [{ zone: 2, id: 1, width: 4, height: 2, flags }],
          unreadableZones: [],
        },
      },
    };
    const editor = new AgosEditor({
      project: () => withArt,
      update: (mutate) => mutate(withArt),
      readZonePixels: () => zoneWithOneImage(flags),
      allowPainting,
    });
    openImage(editor);
    return { editor, project: withArt };
  }

  /** One pointer stroke on the canvas, which is what a paint gesture is. */
  function stroke(editor: AgosEditor, x = 0, y = 0): void {
    const canvas = artCanvas(editor);
    for (const type of ['pointerdown', 'pointerup'] as const) {
      const event = new MouseEvent(type, { bubbles: true, button: 0 });
      // jsdom gives every event an offset of zero and no `pointerId`, so both
      // are supplied here — the canvas scales the offset by its rendered size,
      // and captures the pointer on the way down.
      Object.defineProperty(event, 'offsetX', { value: x });
      Object.defineProperty(event, 'offsetY', { value: y });
      Object.defineProperty(event, 'pointerId', { value: 1 });
      canvas.dispatchEvent(event);
    }
  }

  /** The swatch for one colour index, which is how a colour is now chosen. */
  function swatch(editor: AgosEditor, index: number): HTMLButtonElement {
    return [...editor.element.querySelectorAll<HTMLButtonElement>('.palette .swatch')].find(
      (each) => each.textContent === String(index),
    )!;
  }

  it('does not offer painting on a surface mounted read-only', async () => {
    const { editor } = await surface(await agosProject(), 0, false);

    expect(editor.element.textContent).toContain('read-only');
    // The tools and the strip are still shown — the image is still worth
    // looking at — but nothing on them can be pressed.
    expect(swatch(editor, 3).disabled).toBe(true);
  });

  it('names each swatch by its colour as well as its index', async () => {
    // The index is written on the swatch because colour alone must not carry
    // which one it is (1.4.1), and the name says the colour too — a swatch
    // whose accessible name is only a number tells a screen-reader user
    // nothing about what they are about to paint with.
    const { editor } = await surface(await agosProject(), 0);

    const swatches = [...editor.element.querySelectorAll('.palette .swatch')];
    expect(swatches).toHaveLength(16);
    expect(swatches.map((each) => each.textContent)).toContain('15');
    expect(swatches[15]!.getAttribute('aria-label')).toMatch(/^Colour 15, /);
  });

  it('falls back to greys, and says so, for a zone whose colours cannot be read', async () => {
    // A zone's palette banks are in its script resource. A surface with only
    // the pixels behind it has nothing to be right about, so it shows greys and
    // names the reason rather than inventing a palette.
    const { editor } = await surface(await agosProject(), 0);

    expect(editor.element.querySelector('.toolbar')?.textContent).toContain('greys');
    expect(editor.element.querySelector('.toolbar')?.textContent).toContain('game folder');
  });

  it('records the paint as intent on the project, not as zone bytes', async () => {
    // ADR 0030's shape: the Project holds what the author meant and export
    // replays it onto the folder the player supplies again. A zone resource is
    // far too large to keep; one sprite's bitmap is not.
    const { editor, project } = await surface(await agosProject(), 0);

    swatch(editor, 15).click();
    stroke(editor);

    const painted = project.agos!.paintedImages!;
    expect(painted).toHaveLength(1);
    expect(painted[0]).toMatchObject({ zone: 2, id: 1, width: 4, height: 2 });
    // The painted pixel is in the recorded bitmap.
    expect(bitmapOf(painted[0]!).pixels[0]).toBe(15);
  });

  it('replaces an earlier paint of the same image rather than stacking them', async () => {
    // Two strokes on one image are one intent, not two: replaying both would
    // apply the older bitmap and then the newer, which is the same result by
    // luck rather than by design.
    const { editor, project } = await surface(await agosProject(), 0);

    stroke(editor);
    stroke(editor, 1, 1);

    expect(project.agos!.paintedImages).toHaveLength(1);
  });

  it('paints a compressed image, which used to be refused outright', async () => {
    const { editor, project } = await surface(await agosProject(), COMPRESSED_ENTRY);

    expect(editor.element.textContent).toContain('Writable');
    expect(swatch(editor, 3).disabled).toBe(false);

    swatch(editor, 9).click();
    stroke(editor);

    expect(project.agos!.paintedImages).toHaveLength(1);
    expect(bitmapOf(project.agos!.paintedImages![0]!).pixels[0]).toBe(9);
  });

  it('refuses a masked image before offering to paint it, not after', async () => {
    // A masked draw takes its shape from a second resource, so the pixels an
    // entry points at are half of the picture. The refusal is stated and the
    // tools are turned off, rather than a paint being taken and thrown away.
    const { editor, project } = await surface(await agosProject(), DRAW_FLAGS.masked);

    expect(editor.element.textContent).toContain('Not writable');
    expect(swatch(editor, 3).disabled).toBe(true);

    stroke(editor);
    expect(project.agos!.paintedImages ?? []).toHaveLength(0);
  });
});

/**
 * The affordances the surface gained when it stopped being a list and a pane.
 *
 * None of these is about AGOS. They are how *this editor* works — a counted
 * collapsible sidebar, tabs, a properties pane, tools and a keyboard on the
 * canvas — and the SCUMM surface had all of them while this one had none.
 */
describe('the AGOS surface has the editor’s own affordances', () => {
  it('offers the same tabs as a tablist rather than four loose buttons', async () => {
    const { editor } = editorFor(await agosProject());
    const tablist = editor.element.querySelector('[role="tablist"]');

    expect(tablist).not.toBeNull();
    expect([...tablist!.querySelectorAll('[role="tab"]')].map((each) => each.textContent)).toEqual([
      'Items',
      'Rooms',
      'Art',
      'Script',
      'Text',
    ]);
  });

  it('follows a sidebar selection to the view that shows it', async () => {
    // Picking something from the sidebar means wanting to look at it, which is
    // the same choice the SCUMM sidebar makes.
    const { editor } = editorFor(await agosProject());
    clickButton(editor, 'Subroutine 42');

    const selected = editor.element.querySelector('[role="tab"][aria-selected="true"]');
    expect(selected?.textContent).toBe('Script');
  });

  it('puts the editing in the properties pane and the reading in the middle', async () => {
    const { editor } = editorFor(await agosProject());
    clickButton(editor, 'Verb table');

    // The listing is a listing; the operand fields are beside it.
    expect(editor.element.querySelector('.agos-centre .agos-listing')).not.toBeNull();
    expect(editor.element.querySelector('.agos-inspector .agos-operand')).not.toBeNull();
  });

  it('disables the Art tab when nothing with art is selected, and says why', async () => {
    const { editor } = editorFor(await agosProject());
    const art = [...editor.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (each) => each.textContent === 'Art',
    )!;

    expect(art.disabled).toBe(true);
    // `title` is not a dependable accessible description, and the reason a tab
    // is unavailable is exactly what a reader needs.
    expect(art.getAttribute('aria-label')).toContain('select a zone first');
  });

  it('renames an item by pointing its noun at a new string, not by editing the old one', async () => {
    // The difference between renaming *this* item and renaming everything that
    // happened to share its word. The in-place edit is offered separately, on
    // the string, where the count of what it would change is visible.
    const { editor, project } = editorFor(await agosProject());
    const before = project().agos!.items[0]!.noun;

    clickButton(editor, 'Item 2');
    const name = editor.element.querySelector<HTMLInputElement>(
      '.agos-inspector input[type="text"]',
    )!;
    name.value = 'a brand new name';
    name.dispatchEvent(new Event('change'));

    const after = project().agos!.items[0]!;
    expect(after.noun).not.toBe(before);
    expect(stringsOfProject(project())[after.noun]).toBe('a brand new name');
  });

  it('says how far a rename reaches before it is made', async () => {
    const { editor } = editorFor(await agosProject());
    clickButton(editor, 'Item 2');

    expect(editor.element.querySelector('.agos-inspector')?.textContent).toContain(
      'points this item at a new string',
    );
  });
});

/** The pool as the surface reads it, for a test that wants to check a rename. */
function stringsOfProject(project: Project): string[] {
  const binary = atob(project.agos!.textBase64);
  const strings: string[] = [];
  let current = '';
  for (const character of binary) {
    if (character === '\u0000') {
      strings.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  return strings;
}

/**
 * The colours an image is shown in.
 *
 * The Art tab drew every image, and every swatch, as one of sixteen grey levels
 * — on the argument that a bank is chosen by a script at draw time, so any
 * palette the editor picked would be one the game might never use. True, and
 * the wrong conclusion: the banks are readable without running anything, so the
 * choice can be *offered* instead of avoided.
 */
describe('the AGOS art surface paints in the game’s own colours', () => {
  /**
   * A zone script resource carrying one palette bank.
   *
   * Colours live at offset 6, ninety-six bytes a bank, six-bit components
   * widened by four. The header block follows, and where it starts is what
   * bounds the table — nothing counts the banks.
   */
  function scriptsWithOnePalette(colours: ReadonlyArray<readonly [number, number, number]>) {
    const headerAt = 6 + 96;
    const out = new Uint8Array(headerAt + 26);
    const view = new DataView(out.buffer);
    for (const [index, [red, green, blue]] of colours.entries()) {
      out[6 + index * 3] = red;
      out[6 + index * 3 + 1] = green;
      out[6 + index * 3 + 2] = blue;
    }
    // The header the palette table runs up to, and one image entry after it.
    // The pointer to it is at offset 4 in this layout, which is also why the
    // palette table can start at 6.
    view.setUint16(4, headerAt, false);
    view.setUint16(headerAt + 2, 1, false);
    view.setUint16(headerAt + 6, 0, false);
    view.setUint16(headerAt + 10, headerAt + 18, false);
    view.setUint16(headerAt + 14, 0, false);
    return out;
  }

  function zoneWithOneImage(): Uint8Array {
    const bytes = new Uint8Array(64);
    const view = new DataView(bytes.buffer);
    const at = 1 * 8;
    view.setUint32(at, 32, false);
    bytes[at + 4] = 0;
    bytes[at + 5] = 2;
    view.setUint16(at + 6, 4, false);
    bytes.set([0x12, 0x34, 0x56, 0x78], 32);
    return bytes;
  }

  async function coloured() {
    const base = await agosProject();
    const withArt = {
      ...base,
      agos: {
        ...base.agos!,
        art: {
          zones: [2],
          images: [{ zone: 2, id: 1, width: 4, height: 2, flags: 0 }],
          unreadableZones: [],
        },
      },
    };
    // Index 1 is a strong red, index 2 a strong green. Six-bit in the file,
    // so 63 is full and the reader widens it to 252.
    const scripts = scriptsWithOnePalette([
      [0, 0, 0],
      [63, 0, 0],
      [0, 63, 0],
    ]);
    const editor = new AgosEditor({
      project: () => withArt,
      update: (mutate) => mutate(withArt),
      readZonePixels: () => zoneWithOneImage(),
      readZoneScripts: () => scripts,
    });
    openImage(editor);
    return editor;
  }

  it('paints the swatches in the bank’s colours rather than in greys', async () => {
    const editor = await coloured();
    const swatches = [...editor.element.querySelectorAll<HTMLElement>('.palette .swatch')];

    expect(swatches[1]!.style.background).toBe('rgb(252, 0, 0)');
    expect(swatches[2]!.style.background).toBe('rgb(0, 252, 0)');
  });

  it('says what a swatch’s colour is, not only which index it is', async () => {
    const editor = await coloured();
    const swatches = [...editor.element.querySelectorAll('.palette .swatch')];

    expect(swatches[1]!.getAttribute('aria-label')).toContain('red 252');
  });

  it('offers the zone’s banks, both halves of each, because a bank holds 32', async () => {
    const editor = await coloured();
    const options = [...editor.element.querySelectorAll('.toolbar option')].map(
      (each) => each.textContent,
    );

    expect(options).toContain('Bank 0, first 16');
    expect(options).toContain('Bank 0, second 16');
  });

  it('repaints when a different half is chosen', async () => {
    const editor = await coloured();
    const select = editor.element.querySelector<HTMLSelectElement>('.toolbar select')!;

    select.value = '0:1';
    select.dispatchEvent(new Event('change'));

    // The second sixteen of a bank that only filled its first three entries is
    // black throughout, which is the honest answer for that half.
    const swatches = [...editor.element.querySelectorAll<HTMLElement>('.palette .swatch')];
    expect(swatches[1]!.style.background).toBe('rgb(0, 0, 0)');
  });
});

/**
 * The painter the canvas and the thumbnails share.
 *
 * One function, so the small picture and the large one cannot disagree about
 * what an image looks like — which they would, being written twice.
 */
describe('painting an AGOS bitmap into pixels', () => {
  const bitmap = { width: 2, height: 1, pixels: Uint8Array.of(0, 1) };

  it('uses the palette it is given rather than a grey ramp', () => {
    const target = new Uint8ClampedArray(2 * 4);
    paintBitmap(target, bitmap, {
      transparentZero: false,
      palette: [
        [10, 20, 30],
        [200, 100, 50],
      ],
    });

    expect([...target.slice(0, 3)]).toEqual([10, 20, 30]);
    expect([...target.slice(4, 7)]).toEqual([200, 100, 50]);
  });

  it('draws index zero as a checkerboard when the entry calls it transparent', () => {
    // An AGOS sprite is mostly transparent, and index 0 painted as a colour is
    // what made a whole strip of them read as black rectangles.
    const target = new Uint8ClampedArray(2 * 4);
    paintBitmap(target, bitmap, {
      transparentZero: true,
      palette: [
        [0, 0, 0],
        [200, 100, 50],
      ],
    });

    // Grey, and not the black the palette gives index 0.
    expect(target[0]).toBeGreaterThan(0);
    expect(target[0]).toBe(target[1]);
    expect([...target.slice(4, 7)]).toEqual([200, 100, 50]);
  });

  it('falls back to greys when no palette is given', () => {
    const target = new Uint8ClampedArray(2 * 4);
    paintBitmap(target, bitmap, { transparentZero: false });

    expect(target[4]).toBe(target[5]);
    expect(target[5]).toBe(target[6]);
  });
});

/**
 * Where a zone's images are listed, and how the folder they come from is shown.
 *
 * Both of these were reported against the retail games, and both are
 * counts rather than opinions: Simon 1's zone 8 holds 1,092 images and Simon 2's
 * zone 73 holds 1,828. A wrapping strip of those under the canvas is some four
 * to seven thousand pixels tall, does not shrink, and left the image an author
 * had opened squeezed into whatever was left — which was nothing.
 */
describe('the AGOS art column', () => {
  /** A project holding one zone with `count` images in it. */
  function withImages(base: Project, count: number): Project {
    return {
      ...base,
      agos: {
        ...base.agos!,
        art: {
          zones: [2],
          images: Array.from({ length: count }, (_, index) => ({
            zone: 2,
            id: index + 1,
            width: 4,
            height: 2,
            flags: 0,
          })),
          unreadableZones: [],
        },
      },
    };
  }

  function artEditor(project: Project, options: Partial<AgosEditorOptions> = {}): AgosEditor {
    return new AgosEditor({
      project: () => project,
      update: (mutate) => mutate(project),
      ...options,
    });
  }

  it('lists a zone’s images in the properties column, not under the canvas', async () => {
    const editor = artEditor(withImages(await agosProject(), 3));
    clickButton(editor, 'Zone 2');

    // The list is inside the properties pane. Under the canvas it competed with
    // the picture for height and won, because a strip does not shrink.
    const list = editor.element.querySelector('.agos-inspector .agos-art-list');
    expect(list).not.toBeNull();
    expect(editor.element.querySelector('.agos-centre .agos-art-list')).toBeNull();
    // One row per image, each carrying its own number rather than being a
    // square a person has to count along a strip to identify.
    expect(
      [...list!.querySelectorAll('.agos-art-row .agos-art-name')].map((e) => e.textContent),
    ).toEqual(['Image 1', 'Image 2', 'Image 3']);
  });

  it('pages a zone too big to list, and says which images are on screen', async () => {
    const editor = artEditor(withImages(await agosProject(), 100));
    clickButton(editor, 'Zone 2');

    expect(editor.element.querySelectorAll('.agos-art-row')).toHaveLength(48);
    expect(editor.element.querySelector('.agos-art-count')?.textContent).toBe('1–48 of 100');

    clickButton(editor, 'Next');
    expect(editor.element.querySelector('.agos-art-count')?.textContent).toBe('49–96 of 100');
    expect([...editor.element.querySelectorAll('.agos-art-name')][0]?.textContent).toBe('Image 49');

    // The last page is short, and the pager says so rather than claiming 48.
    clickButton(editor, 'Next');
    expect(editor.element.querySelector('.agos-art-count')?.textContent).toBe('97–100 of 100');
  });

  it('goes to a page number that is typed in, not just the next one', async () => {
    // Previous and Next are enough at four pages and useless at thirty-nine:
    // Simon 2's zone 73 runs to 1,828 images, so the last of them is
    // thirty-eight clicks away.
    const editor = artEditor(withImages(await agosProject(), 1000));
    clickButton(editor, 'Zone 2');

    const field = editor.element.querySelector<HTMLInputElement>('.agos-art-page-input')!;
    expect(field.value).toBe('1');
    expect(field.max).toBe('21');

    field.value = '15';
    field.dispatchEvent(new Event('change'));
    expect(editor.element.querySelector('.agos-art-count')?.textContent).toBe('673–720 of 1000');
  });

  it('goes there on Enter too, which has no form to submit', async () => {
    const editor = artEditor(withImages(await agosProject(), 1000));
    clickButton(editor, 'Zone 2');

    const field = editor.element.querySelector<HTMLInputElement>('.agos-art-page-input')!;
    field.value = '3';
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

    expect(editor.element.querySelector('.agos-art-count')?.textContent).toBe('97–144 of 1000');
  });

  it('clamps a page that does not exist rather than arguing with it', async () => {
    // "Page 400 of 21" is a typed number, not a request worth refusing, and the
    // end of the list is what was meant. The field is put back to where the
    // list actually is, so it never disagrees with the rows below it.
    const editor = artEditor(withImages(await agosProject(), 1000));
    clickButton(editor, 'Zone 2');

    const field = editor.element.querySelector<HTMLInputElement>('.agos-art-page-input')!;
    field.value = '400';
    field.dispatchEvent(new Event('change'));

    expect(editor.element.querySelector('.agos-art-count')?.textContent).toBe('961–1000 of 1000');
    expect(editor.element.querySelector<HTMLInputElement>('.agos-art-page-input')?.value).toBe(
      '21',
    );
  });

  it('puts the page back when what was typed is not a number at all', async () => {
    const editor = artEditor(withImages(await agosProject(), 1000));
    clickButton(editor, 'Zone 2');
    clickButton(editor, 'Next');

    const field = editor.element.querySelector<HTMLInputElement>('.agos-art-page-input')!;
    field.value = 'nonsense';
    field.dispatchEvent(new Event('change'));

    // The list has not moved and the field says so, which reads better than a
    // message about a value nobody meant to type.
    expect(editor.element.querySelector('.agos-art-count')?.textContent).toBe('49–96 of 1000');
    expect(editor.element.querySelector<HTMLInputElement>('.agos-art-page-input')?.value).toBe('2');
  });

  it('keeps the keyboard in the page field after a jump', async () => {
    // Typing a page rebuilds the pager holding the field, so without putting
    // focus back a second jump means finding the field again.
    const editor = artEditor(withImages(await agosProject(), 1000));
    document.body.appendChild(editor.element);
    clickButton(editor, 'Zone 2');

    const field = editor.element.querySelector<HTMLInputElement>('.agos-art-page-input')!;
    field.focus();
    field.value = '7';
    field.dispatchEvent(new Event('change'));

    expect((document.activeElement as HTMLElement | null)?.className).toContain(
      'agos-art-page-input',
    );
    editor.element.remove();
  });

  it('does not page a zone that fits, because there is nowhere to go', async () => {
    const editor = artEditor(withImages(await agosProject(), 3));
    clickButton(editor, 'Zone 2');

    expect(editor.element.querySelector('.agos-art-pager')).toBeNull();
  });

  it('is one tab stop with arrow keys inside it, not one stop per image', async () => {
    // Forty-eight tab stops a page is reachable and unusable; at 1,828 images it
    // is neither. The same pattern the palette and the tab row use.
    const editor = artEditor(withImages(await agosProject(), 3));
    clickButton(editor, 'Zone 2');

    const rows = editor.element.querySelector('.agos-art-rows');
    expect(rows?.getAttribute('role')).toBe('radiogroup');
    expect(
      [...rows!.querySelectorAll<HTMLElement>('.agos-art-row')].map((e) => e.tabIndex),
    ).toEqual([0, -1, -1]);
  });

  it('keeps the page an image was opened from rather than snapping to the first', async () => {
    const editor = artEditor(withImages(await agosProject(), 100));
    clickButton(editor, 'Zone 2');
    clickButton(editor, 'Next');
    editor.element.querySelector<HTMLButtonElement>('.agos-art-row')?.click();

    // Selecting rebuilds the whole surface, and a rebuild that recomputed the
    // page from nothing would drop the author back to image 1.
    expect(editor.element.querySelector('.agos-art-count')?.textContent).toBe('49–96 of 100');
    expect(editor.element.querySelector('[aria-current="true"] .agos-art-name')?.textContent).toBe(
      'Image 49',
    );
  });

  it('starts a different zone at its first page, because a page number is per zone', async () => {
    const base = await agosProject();
    const many = withImages(base, 100);
    const project: Project = {
      ...many,
      agos: {
        ...many.agos!,
        art: {
          zones: [2, 3],
          images: [...many.agos!.art!.images, { zone: 3, id: 1, width: 4, height: 2, flags: 0 }],
          unreadableZones: [],
        },
      },
    };
    const editor = artEditor(project);
    clickButton(editor, 'Zone 2');
    clickButton(editor, 'Next');
    clickButton(editor, 'Zone 3');
    clickButton(editor, 'Zone 2');

    expect(editor.element.querySelector('.agos-art-count')?.textContent).toBe('1–48 of 100');
  });

  it('keeps the keyboard in the list when an arrow key opens the next image', async () => {
    // A radio group selects as it moves, and selecting rebuilds the list — so
    // without putting focus back the first arrow press would end the walk.
    const editor = artEditor(withImages(await agosProject(), 3));
    // Attached, because a detached element cannot hold focus: jsdom leaves
    // `activeElement` on the body, and so does a browser.
    document.body.appendChild(editor.element);
    clickButton(editor, 'Zone 2');
    const first = editor.element.querySelector<HTMLElement>('.agos-art-row')!;
    first.focus();
    first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));

    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.className).toContain('agos-art-row');
    expect(focused?.getAttribute('aria-checked')).toBe('true');
    expect(focused?.textContent).toContain('Image 2');
    editor.element.remove();
  });

  it('names the folder its art is read from, and offers to change it', async () => {
    const editor = artEditor(withImages(await agosProject(), 1), {
      readZonePixels: () => Uint8Array.of(0),
      folderName: () => 'simon-the-sorcerer',
    });

    const bar = editor.element.querySelector('.agos-inspector .agos-folder-bar');
    expect(bar?.querySelector('.agos-folder-name')?.textContent).toBe('simon-the-sorcerer');
    // "Change" rather than "Open": the point of showing the name is that a
    // folder chosen by mistake can be corrected without reloading the editor.
    expect([...bar!.querySelectorAll('button')].map((each) => each.textContent)).toEqual([
      'Change folder…',
    ]);
    // Beside the name, what it was matched against — the useful half of what a
    // path would have said, since a browser will not reveal one.
    expect(bar?.textContent).toContain('GAMEPC');
  });

  it('says no folder is open rather than showing an empty name', async () => {
    const editor = artEditor(withImages(await agosProject(), 1));

    const bar = editor.element.querySelector('.agos-folder-bar');
    expect(bar?.textContent).toContain('None open');
    expect([...bar!.querySelectorAll('button')].map((each) => each.textContent)).toEqual([
      'Open game folder…',
    ]);
  });

  it('takes the name from the folder it opens when the shell has none to give', async () => {
    const editor = artEditor(withImages(await agosProject(), 1), {
      openGameFolder: async () => ({
        pixels: () => Uint8Array.of(0),
        scripts: () => Uint8Array.of(0),
        name: 'simon-the-sorcerer-2',
      }),
    });
    clickButton(editor, 'Open game folder…');
    await Promise.resolve();

    expect(editor.element.querySelector('.agos-folder-name')?.textContent).toBe(
      'simon-the-sorcerer-2',
    );
  });

  it('says why a folder was refused, next to the button that tries again', async () => {
    const editor = artEditor(withImages(await agosProject(), 1), {
      openGameFolder: async () => 'That folder holds a different release of the game.',
    });
    clickButton(editor, 'Open game folder…');
    await Promise.resolve();

    expect(editor.element.querySelector('.agos-folder-bar')?.textContent).toContain(
      'a different release',
    );
  });

  it('offers zooms large enough to see a 32-pixel sprite, and a fit', async () => {
    // The median AGOS image is about 32 by 18 pixels, so 16× — the old ceiling
    // — is a 512-pixel box, and "Fit" is the entry an author actually wants.
    const editor = artEditor(withImages(await agosProject(), 1));
    clickButton(editor, 'Zone 2');

    const zoom = [...editor.element.querySelectorAll<HTMLSelectElement>('.toolbar select')].find(
      (each) => [...each.options].some((option) => option.value === 'fit'),
    );
    expect([...zoom!.options].map((option) => option.textContent)).toEqual([
      'Fit',
      '1×',
      '2×',
      '4×',
      '8×',
      '12×',
      '16×',
      '24×',
      '32×',
    ]);
  });
});

/**
 * The Rooms accordion.
 *
 * A room is an item with a room sub-structure, and what it looks like is an
 * `o_picture` in a Subroutine that usually lives in a TABLES file — so this
 * section exists because those two facts can be joined, and the joining is
 * `authoring/agos/rooms.ts`. Measured on the retail games: 92 rooms in Simon 1
 * and 67 in Simon 2, of which 90 and 55 draw.
 */
describe('the AGOS rooms section', () => {
  /** A project with one room, on an item named "kitchen". */
  function withRoom(base: Project, room: { picture?: number; zone?: number }): Project {
    return {
      ...base,
      agos: {
        ...base.agos!,
        rooms: {
          rooms: [{ item: 2, subroutine: 10101, exits: 2, ...room }],
          unreadableSubroutines: [],
        },
      },
    };
  }

  function roomEditor(project: Project, options: Partial<AgosEditorOptions> = {}): AgosEditor {
    return new AgosEditor({
      project: () => project,
      update: (mutate) => mutate(project),
      ...options,
    });
  }

  /**
   * Opens the one room, by its note rather than its name.
   *
   * `clickButton` matches on a prefix and the Items section lists an "Item 2"
   * of its own, so the room row is found by the half of it only a room has.
   */
  function openRoom(editor: AgosEditor): void {
    [...editor.element.querySelectorAll<HTMLButtonElement>('.accordion-body button')]
      .find((each) => each.textContent?.includes('item 2 ·'))
      ?.click();
  }

  it('lists rooms by the game’s own name for them, not by zone number', async () => {
    // "Zone 96" is where a room's picture is kept; the room is an item, and its
    // noun is what an author knows it by.
    const editor = roomEditor(withRoom(await agosProject(), { picture: 9600, zone: 96 }));

    expect(sectionTitles(editor)).toContain('Rooms (1)');
    const row = [...editor.element.querySelectorAll('.accordion-body button')].find((each) =>
      each.textContent?.includes('zone 96'),
    );
    // The item number always, because two rooms can share a word — the games
    // have several "corridor"s, and the name alone would make them one row.
    expect(row?.textContent).toContain('item 2 · zone 96');
  });

  it('opens the Rooms view when a room is picked, not the Art view', async () => {
    const editor = roomEditor(withRoom(await agosProject(), { picture: 9600, zone: 96 }));
    openRoom(editor);

    expect(editor.element.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Rooms',
    );
    // The room's own facts, in the properties column beside the picture.
    expect(editor.element.querySelector('.agos-inspector')?.textContent).toContain(
      'Runs Subroutine 10101 on arrival, and has 2 exits',
    );
  });

  it('asks for the game folder rather than showing an empty room', async () => {
    // A room's picture is in a zone, and a zone is beside the game rather than
    // in the project (ADR 0034). With no folder open there is nothing to draw,
    // and saying so beats a blank frame that reads as a room with no scenery.
    const editor = roomEditor(withRoom(await agosProject(), { picture: 9600, zone: 96 }));
    openRoom(editor);

    const note = editor.element.querySelector('.agos-room-wrap p');
    expect(note?.textContent).toContain('has not been read');
    expect(editor.element.querySelector<HTMLImageElement>('.agos-room-shot')?.hidden).toBe(true);
  });

  it('says a room whose script picks its picture at runtime cannot be drawn', async () => {
    // Two of Simon 1's rooms and two of Simon 2's are like this. The room is
    // still a room; what it looks like is a fact about a running game.
    const editor = roomEditor(withRoom(await agosProject(), {}));
    openRoom(editor);

    expect(editor.element.querySelector('.agos-room-wrap p')?.textContent).toContain(
      'does not name a picture outright',
    );
    expect(editor.element.querySelector('.agos-inspector')?.textContent).toContain(
      'decided as the game runs',
    );
  });

  it('offers the room’s zone on the Art tab, which is the next question', async () => {
    const editor = roomEditor(withRoom(await agosProject(), { picture: 9600, zone: 96 }));
    openRoom(editor);
    clickButton(editor, 'Open zone 96 art');

    expect(editor.element.querySelector('[role="tab"][aria-selected="true"]')?.textContent).toBe(
      'Art',
    );
  });

  it('keeps the Rooms tab shut until a room is selected', async () => {
    // The same rule the Art tab follows: a view with nothing behind it says so
    // rather than showing an empty frame.
    const editor = roomEditor(withRoom(await agosProject(), { picture: 9600, zone: 96 }));
    const tab = [...editor.element.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (each) => each.textContent === 'Rooms',
    );

    expect(tab?.disabled).toBe(true);
    expect(tab?.getAttribute('aria-label')).toContain('select a room first');
  });
});
