/**
 * The AGI editing surface: Logic, Picture and View.
 *
 * One module rather than three, because ADR 0013's conclusion is that an AGI
 * project has **one representation** and the three surfaces are views onto one
 * project rather than three subsystems. `ActionEditor` is not reusable here at
 * all — it edits `Action`s, and an AGI project has none.
 *
 * The editor branches on Engine family exactly once, at the mount point in
 * `src/editor/main.ts` (#134). Below that nothing asks: an AGI project never
 * offers `Action`-based editing and a SCUMM project never offers Logic editing,
 * because they are different surfaces rather than one surface with a mode.
 */

import { fromBase64, toBase64 } from '../../authoring/base64.js';
import type {
  AgiProject,
  AgiProjectLogic,
  AgiProjectResource,
  Project,
} from '../../authoring/project.js';
import {
  emitLogic,
  formatLogicTree,
  type AgiLogicTree,
  type AgiStatement,
} from '../../authoring/agi/decompileLogic.js';
import {
  AgiPicture,
  commandName,
  writePictureCommands,
  type PictureCommand,
} from '../../engine/agi/gfx/AgiPicture.js';
import { AGI_EGA_PALETTE, PICTURE_HEIGHT, PICTURE_WIDTH } from '../../engine/agi/gfx/agiPalette.js';
import {
  loopIsMirrored,
  readView,
  writeView,
  type AgiCel,
  type AgiViewResource,
} from '../../engine/agi/gfx/AgiView.js';
import { announce, describeColour } from '../../ui/a11y.js';
import { groupItem, rovingGrid, rovingGroup } from '../a11yWidgets.js';

export type AgiResourceKind = 'logic' | 'picture' | 'view' | 'sound';

export interface AgiEditorOptions {
  /** Applies a change to the project, going through the undo/autosave path. */
  update(mutate: (project: Project) => void): void;
  /** Re-reads the project, so the surface redraws from the source of truth. */
  project(): Project;
}

/** What the surface is showing. Held here rather than in the shared state. */
interface AgiSelection {
  kind: AgiResourceKind;
  number: number;
  /** Picture: the command being edited. View: the loop and cel. */
  commandIndex: number;
  loop: number;
  cel: number;
  /** Picture: whether the priority buffer is overlaid on the preview. */
  showPriority: boolean;
  /** View: whether the animation preview is running. */
  playing: boolean;
  /** View: the colour the pixel editor paints with. */
  colour: number;
}

export class AgiEditor {
  readonly element = document.createElement('div');

  private readonly options: AgiEditorOptions;
  private readonly list = document.createElement('div');
  private readonly detail = document.createElement('div');

  private selection: AgiSelection = {
    kind: 'logic',
    number: -1,
    commandIndex: -1,
    loop: 0,
    cel: 0,
    showPriority: false,
    playing: false,
    colour: 15,
  };

  /** Drives the View animation preview at AGI's own cycle rate. */
  private previewTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: AgiEditorOptions) {
    this.options = options;
    this.element.className = 'agi-editor';
    this.list.className = 'agi-resource-list';
    this.detail.className = 'agi-resource-detail';
    this.element.append(this.list, this.detail);
    this.render();
  }

  private get agi(): AgiProject | undefined {
    return this.options.project().agi;
  }

  /** Stops the preview timer, so a surface swapped away does not keep ticking. */
  destroy(): void {
    if (this.previewTimer !== null) clearInterval(this.previewTimer);
    this.previewTimer = null;
  }

  render(): void {
    this.renderList();
    this.renderDetail();
  }

  // ------------------------------------------------------------- the list --

  private renderList(): void {
    this.list.replaceChildren();
    const agi = this.agi;
    if (!agi) return;

    // The Unrecovered count, in the editor as well as in the log. ADR 0013
    // makes it a published number with a target of zero, and a number nobody
    // sees is not one anybody drives down.
    const summary = document.createElement('p');
    summary.className = 'agi-summary';
    summary.textContent =
      agi.unrecoveredCount === 0
        ? `${agi.logics.length} Logic resources, all decompiled.`
        : `${agi.unrecoveredCount} of ${agi.logics.length} Logic resources are ` +
          `Unrecovered and open read-only.`;
    summary.classList.toggle('agi-summary-warning', agi.unrecoveredCount > 0);
    this.list.appendChild(summary);

    // How the interpreter version was established, beside the count — because
    // ADR 0013 is explicit that the count is meaningless without it.
    const provenance = document.createElement('p');
    provenance.className = 'agi-provenance';
    provenance.textContent = `Interpreter: ${agi.interpreter.evidence}`;
    this.list.appendChild(provenance);

    this.list.appendChild(
      this.section('Logic', agi.logics.length, (body) => {
        for (const logic of agi.logics) {
          body.appendChild(
            this.resourceButton('logic', logic.number, logic.unrecovered ? 'Unrecovered' : ''),
          );
        }
        const add = document.createElement('button');
        add.type = 'button';
        add.className = 'agi-add';
        add.textContent = 'New Logic';
        // A Logic written from nothing is the same thing as an imported one:
        // one representation, so there is no "which half is this" to explain
        // (ADR 0013).
        add.addEventListener('click', () => this.createLogic());
        body.appendChild(add);
      }),
    );

    for (const [kind, entries] of [
      ['picture', agi.pictures],
      ['view', agi.views],
      ['sound', agi.sounds],
    ] as const) {
      this.list.appendChild(
        this.section(kind[0].toUpperCase() + kind.slice(1), entries.length, (body) => {
          for (const entry of entries) {
            body.appendChild(this.resourceButton(kind, entry.number, ''));
          }
        }),
      );
    }
  }

  private section(title: string, count: number, fill: (body: HTMLElement) => void): HTMLElement {
    const wrapper = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = `${title} (${count})`;
    const body = document.createElement('div');
    body.className = 'agi-section-body';
    fill(body);
    wrapper.append(heading, body);
    return wrapper;
  }

  private resourceButton(kind: AgiResourceKind, number: number, note: string): HTMLElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'agi-resource';
    button.textContent = note ? `${number} · ${note}` : String(number);
    button.classList.toggle(
      'selected',
      this.selection.kind === kind && this.selection.number === number,
    );
    button.classList.toggle('agi-unrecovered', note === 'Unrecovered');
    // "12" on its own is not a name. Which kind of resource, which number, and
    // whether this is the one currently open (4.1.2).
    button.setAttribute('aria-label', note ? `${kind} ${number}, ${note}` : `${kind} ${number}`);
    if (this.selection.kind === kind && this.selection.number === number) {
      button.setAttribute('aria-current', 'true');
    }
    button.addEventListener('click', () => {
      this.destroy();
      this.selection = {
        ...this.selection,
        kind,
        number,
        commandIndex: -1,
        loop: 0,
        cel: 0,
        playing: false,
      };
      this.render();
    });
    return button;
  }

  // ----------------------------------------------------------- the detail --

  private renderDetail(): void {
    this.detail.replaceChildren();
    const agi = this.agi;
    if (!agi || this.selection.number < 0) {
      const empty = document.createElement('p');
      empty.textContent = 'Choose a resource on the left.';
      this.detail.appendChild(empty);
      return;
    }

    switch (this.selection.kind) {
      case 'logic':
        this.renderLogic(agi);
        break;
      case 'picture':
        this.renderPicture(agi);
        break;
      case 'view':
        this.renderView(agi);
        break;
      default:
        this.renderSound(agi);
        break;
    }
  }

  // ---------------------------------------------------------------- Logic --

  private renderLogic(agi: AgiProject): void {
    const logic = agi.logics.find((entry) => entry.number === this.selection.number);
    if (!logic) return;

    const heading = document.createElement('h2');
    heading.textContent = `Logic ${logic.number}`;
    this.detail.appendChild(heading);

    if (logic.unrecovered) {
      // Read-only, and it says why in plain words rather than being merely
      // disabled. An author who cannot edit something is owed the reason.
      const warning = document.createElement('div');
      warning.className = 'agi-unrecovered-note';
      warning.innerHTML = '';
      const title = document.createElement('strong');
      title.textContent = 'This Logic is Unrecovered and cannot be edited.';
      const why = document.createElement('p');
      why.textContent = logic.unrecovered;
      const what = document.createElement('p');
      what.textContent =
        'It is kept exactly as it arrived and will be exported unchanged, so the ' +
        'game still works. This is a defect in the decompiler rather than a ' +
        'limitation of the format — the fix is a better decompiler, never a ' +
        'wider fallback.';
      warning.append(title, why, what);
      this.detail.appendChild(warning);
      return;
    }

    const tree = logic.tree as AgiLogicTree;

    // The source is a *view* over the tree, not the stored form (ADR 0013).
    // Read-only text, because editing happens through the structured controls
    // below it — a text box here would need a parser before anything could be
    // edited at all.
    const source = document.createElement('pre');
    source.className = 'agi-logic-source';
    source.textContent = formatLogicTree(tree);
    this.detail.appendChild(source);

    this.detail.appendChild(this.messageTable(logic, tree));
    this.detail.appendChild(this.statementList(logic, tree));
  }

  /**
   * The message table, edited beside the code that shows it.
   *
   * This is where AGI escapes ADR 0009's problem rather than merely not having
   * it yet: a Logic's messages are stored *inside* that Logic, so there is no
   * shared string pool and no edit whose reach an author cannot see. Changing a
   * message changes one Logic, and the editor does not have to explain
   * otherwise.
   */
  private messageTable(logic: AgiProjectLogic, tree: AgiLogicTree): HTMLElement {
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = 'Messages';
    const note = document.createElement('p');
    note.className = 'agi-hint';
    note.textContent =
      'These belong to this Logic alone. Changing one changes nothing anywhere else.';
    section.append(heading, note);

    for (const [number, text] of tree.messages.entries()) {
      if (number === 0) continue; // `print 1` is the first message.
      const row = document.createElement('label');
      row.className = 'agi-message-row';

      const label = document.createElement('span');
      label.textContent = `m${number}`;

      const field = document.createElement('input');
      field.type = 'text';
      field.value = text ?? '';
      field.addEventListener('change', () => {
        this.editLogic(logic.number, (current) => {
          const messages = [...current.messages];
          messages[number] = field.value;
          return { ...current, messages };
        });
      });

      row.append(label, field);
      section.appendChild(row);
    }

    return section;
  }

  /** Every statement, with the ones that carry editable operands editable. */
  private statementList(logic: AgiProjectLogic, tree: AgiLogicTree): HTMLElement {
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = 'Instructions';
    section.appendChild(heading);

    const walk = (statements: AgiStatement[], path: number[], depth: number): void => {
      for (const [index, statement] of statements.entries()) {
        const here = [...path, index];
        const row = document.createElement('div');
        row.className = 'agi-statement';
        row.style.paddingLeft = `${depth}rem`;

        if (statement.kind === 'if') {
          const label = document.createElement('span');
          label.textContent = `if (${statement.conditions.length} condition(s))`;
          row.appendChild(label);
          section.appendChild(row);
          walk(statement.then, [...here, 0], depth + 1);
          if (statement.otherwise.length > 0) {
            const elseRow = document.createElement('div');
            elseRow.className = 'agi-statement';
            elseRow.style.paddingLeft = `${depth}rem`;
            elseRow.textContent = 'else';
            section.appendChild(elseRow);
            walk(statement.otherwise, [...here, 1], depth + 1);
          }
          continue;
        }

        if (statement.kind === 'goto') {
          row.textContent = `goto ${statement.target}`;
          section.appendChild(row);
          continue;
        }

        const name = document.createElement('span');
        name.className = 'agi-statement-name';
        name.textContent = statement.name;
        row.appendChild(name);

        for (const [operandIndex, operand] of statement.operands.entries()) {
          const field = document.createElement('input');
          field.type = 'number';
          field.min = '0';
          field.max = '255';
          field.value = String(operand.value);
          field.className = 'agi-operand';
          field.title = operand.kind;
          field.addEventListener('change', () => {
            const value = Math.max(0, Math.min(255, Number(field.value) || 0));
            this.editLogic(logic.number, (current) =>
              replaceOperand(current, here, operandIndex, value),
            );
          });
          row.appendChild(field);
        }

        section.appendChild(row);
      }
    };

    walk(tree.statements, [], 0);
    return section;
  }

  /**
   * Applies a change to a Logic's tree.
   *
   * The tree is the truth, so a change is a change to it — and the bytes are
   * re-derived rather than patched. That is what keeps "saving with no change
   * re-emits byte-identically" (#134) true by construction rather than by care.
   */
  private editLogic(number: number, change: (tree: AgiLogicTree) => AgiLogicTree): void {
    this.options.update((project) => {
      const logic = project.agi?.logics.find((entry) => entry.number === number);
      if (!logic?.tree) return;
      const next = change(logic.tree as AgiLogicTree);
      logic.tree = next;
      logic.bytes = toBase64(emitLogic(next));
    });
    this.render();
  }

  private createLogic(): void {
    this.options.update((project) => {
      const agi = project.agi;
      if (!agi) return;
      const number = agi.logics.reduce((top, entry) => Math.max(top, entry.number), -1) + 1;
      // The smallest thing that is a Logic: one `return`. Held as a tree from
      // the moment it exists, exactly like an imported one.
      const tree: AgiLogicTree = {
        statements: [{ kind: 'command', opcode: 0x00, name: 'return', operands: [] }],
        messages: [undefined],
        messagesEncrypted: true,
      };
      agi.logics.push({ number, tree, bytes: toBase64(emitLogic(tree)) });
    });
    this.render();
  }

  // -------------------------------------------------------------- Picture --

  /**
   * A Picture, shown as its two buffers and its command list.
   *
   * The stored form *is* the editable form, which is why this surface is a list
   * of commands rather than a paint program: `RoomCanvas` has to solve the
   * harder problem for SCUMM bitmaps — repaint pixels and re-encode them — and
   * here there is nothing to re-encode (#135).
   */
  private renderPicture(agi: AgiProject): void {
    const entry = agi.pictures.find((resource) => resource.number === this.selection.number);
    if (!entry) return;

    const heading = document.createElement('h2');
    heading.textContent = `Picture ${entry.number}`;
    this.detail.appendChild(heading);

    const picture = new AgiPicture();
    const result = picture.execute(fromBase64(entry.bytes));

    const controls = document.createElement('div');
    controls.className = 'agi-controls';

    const overlay = document.createElement('label');
    const toggle = document.createElement('input');
    toggle.type = 'checkbox';
    toggle.checked = this.selection.showPriority;
    toggle.addEventListener('change', () => {
      this.selection.showPriority = toggle.checked;
      this.renderDetail();
    });
    overlay.append(toggle, document.createTextNode(' Show priority bands'));
    controls.appendChild(overlay);

    const hint = document.createElement('p');
    hint.className = 'agi-hint';
    // The thing that is unlike SCUMM and has to be said out loud: the priority
    // bands are in this command stream, so drawing changes what blocks walking.
    hint.textContent =
      'Priority is drawn from this same command list, so editing the picture ' +
      'edits what blocks walking. SCUMM keeps walk boxes separately; AGI does not.';
    controls.appendChild(hint);
    this.detail.appendChild(controls);

    this.detail.appendChild(this.pictureCanvas(picture));
    this.detail.appendChild(this.commandList(entry, result.commands));
  }

  private pictureCanvas(picture: AgiPicture): HTMLElement {
    const canvas = document.createElement('canvas');
    canvas.width = PICTURE_WIDTH * 2;
    canvas.height = PICTURE_HEIGHT;
    canvas.className = 'agi-picture-canvas';
    /*
     * A rendering of the command list below it, and named as one.
     *
     * `role="img"` rather than `application`: nothing here is operable — the
     * picture is edited through the command rows underneath, which is the
     * accessible route to every pixel of it and is not a lesser one. Saying so
     * in the name is the difference between a picture with no alternative and a
     * picture whose alternative is the next section.
     */
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      this.selection.showPriority
        ? 'Priority bands for this picture, drawn from the commands listed below'
        : 'This picture as drawn, from the commands listed below',
    );

    const context = canvas.getContext('2d');
    if (context) {
      const image = context.createImageData(canvas.width, canvas.height);
      for (let y = 0; y < PICTURE_HEIGHT; y++) {
        for (let x = 0; x < PICTURE_WIDTH; x++) {
          const source = y * PICTURE_WIDTH + x;
          const colour = this.selection.showPriority
            ? picture.priority[source]
            : picture.visual[source];
          const [red, green, blue] = AGI_EGA_PALETTE[colour & 0x0f];
          // Doubled horizontally, because a Picture is 160 wide and an AGI
          // pixel is two EGA pixels.
          for (const step of [0, 1]) {
            const at = (y * canvas.width + x * 2 + step) * 4;
            image.data[at] = red;
            image.data[at + 1] = green;
            image.data[at + 2] = blue;
            image.data[at + 3] = 255;
          }
        }
      }
      context.putImageData(image, 0, 0);
    }

    return canvas;
  }

  private commandList(entry: AgiProjectResource, commands: PictureCommand[]): HTMLElement {
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = 'Draw commands';
    section.appendChild(heading);

    for (const [index, command] of commands.entries()) {
      const row = document.createElement('div');
      row.className = 'agi-command';
      row.classList.toggle('selected', index === this.selection.commandIndex);

      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', `Command ${index + 1}, ${commandName(command.opcode)}`);

      const name = document.createElement('button');
      name.type = 'button';
      name.className = 'agi-command-name';
      name.textContent = commandName(command.opcode);
      name.setAttribute(
        'aria-label',
        `Select command ${index + 1}, ${commandName(command.opcode)}`,
      );
      if (index === this.selection.commandIndex) name.setAttribute('aria-current', 'true');
      name.addEventListener('click', () => {
        this.selection.commandIndex = index;
        this.renderDetail();
      });
      row.appendChild(name);

      for (const [argIndex, value] of command.args.entries()) {
        const field = document.createElement('input');
        field.type = 'number';
        field.min = '0';
        field.max = '255';
        field.value = String(value);
        field.className = 'agi-operand';
        // A row of unlabelled number boxes is a row of controls a screen reader
        // can only call "spin button" (3.3.2).
        field.setAttribute(
          'aria-label',
          `${commandName(command.opcode)} command ${index + 1}, operand ${argIndex + 1}`,
        );
        field.addEventListener('change', () => {
          const next = Math.max(0, Math.min(255, Number(field.value) || 0));
          this.editPicture(entry.number, commands, (list) => {
            const args = [...list[index].args];
            args[argIndex] = next;
            list[index] = { ...list[index], args };
            return list;
          });
        });
        row.appendChild(field);
      }

      if (command.opcode !== 0xff) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'agi-remove';
        remove.textContent = 'Remove';
        // Nine buttons all called "Remove" is nine identical names; which one
        // this is has to be part of it (2.4.6).
        remove.setAttribute(
          'aria-label',
          `Remove command ${index + 1}, ${commandName(command.opcode)}`,
        );
        remove.addEventListener('click', () => {
          this.editPicture(entry.number, commands, (list) => {
            list.splice(index, 1);
            return list;
          });
        });
        row.appendChild(remove);
      }

      section.appendChild(row);
    }

    section.appendChild(this.addCommandControls(entry, commands));
    return section;
  }

  private addCommandControls(entry: AgiProjectResource, commands: PictureCommand[]): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'agi-controls';

    const additions: Array<[string, number, number[]]> = [
      ['Add line', 0xf6, [10, 10, 40, 40]],
      ['Add fill', 0xf8, [20, 20]],
      ['Set visual colour', 0xf0, [15]],
      ['Set priority colour', 0xf2, [4]],
      ['Visual off', 0xf1, []],
      ['Priority off', 0xf3, []],
      ['Set pen', 0xf9, [0]],
      ['Plot pen', 0xfa, [30, 30]],
    ];

    for (const [label, opcode, args] of additions) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.addEventListener('click', () => {
        this.editPicture(entry.number, commands, (list) => {
          // Before the terminator, which always stays last.
          const at = Math.max(0, list.length - 1);
          list.splice(at, 0, { offset: 0, opcode, name: commandName(opcode), args: [...args] });
          return list;
        });
      });
      bar.appendChild(button);
    }

    return bar;
  }

  private editPicture(
    number: number,
    commands: PictureCommand[],
    change: (list: PictureCommand[]) => PictureCommand[],
  ): void {
    const next = change(commands.map((command) => ({ ...command, args: [...command.args] })));
    this.options.update((project) => {
      const entry = project.agi?.pictures.find((resource) => resource.number === number);
      if (entry) entry.bytes = toBase64(writePictureCommands(next));
    });
    this.render();
  }

  // ----------------------------------------------------------------- View --

  private renderView(agi: AgiProject): void {
    const entry = agi.views.find((resource) => resource.number === this.selection.number);
    if (!entry) return;

    let view: AgiViewResource;
    try {
      view = readView(fromBase64(entry.bytes));
    } catch (error) {
      const problem = document.createElement('p');
      problem.textContent = `This View could not be read: ${String(error)}`;
      this.detail.appendChild(problem);
      return;
    }

    const heading = document.createElement('h2');
    heading.textContent = `View ${entry.number}`;
    this.detail.appendChild(heading);

    const loop = view.loops[this.selection.loop];
    const cel = loop?.cels[this.selection.cel];

    this.detail.appendChild(this.loopList(entry, view));
    if (loop && cel) {
      this.detail.appendChild(this.mirrorNote(view, this.selection.loop));
      this.detail.appendChild(this.celEditor(entry, view, cel));
      this.detail.appendChild(this.celControls(entry, view));
    }
  }

  private loopList(entry: AgiProjectResource, view: AgiViewResource): HTMLElement {
    const section = document.createElement('section');
    const heading = document.createElement('h3');
    heading.textContent = 'Loops and cels';
    section.appendChild(heading);

    for (const [loopIndex, loop] of view.loops.entries()) {
      const row = document.createElement('div');
      row.className = 'agi-loop-row';

      const label = document.createElement('span');
      label.textContent =
        loop.mirrorOf === null
          ? `Loop ${loopIndex}`
          : `Loop ${loopIndex} — mirror of ${loop.mirrorOf}`;
      row.appendChild(label);

      for (const [celIndex] of loop.cels.entries()) {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = String(celIndex);
        const chosen = loopIndex === this.selection.loop && celIndex === this.selection.cel;
        button.classList.toggle('selected', chosen);
        // A bare number is not a name, and which loop it belongs to is the half
        // that matters when several rows each start at zero.
        button.setAttribute('aria-label', `Loop ${loopIndex}, cel ${celIndex}`);
        if (chosen) button.setAttribute('aria-current', 'true');
        button.addEventListener('click', () => {
          this.selection.loop = loopIndex;
          this.selection.cel = celIndex;
          this.renderDetail();
        });
        row.appendChild(button);
      }

      section.appendChild(row);
    }

    const bar = document.createElement('div');
    bar.className = 'agi-controls';

    const addLoop = document.createElement('button');
    addLoop.type = 'button';
    addLoop.textContent = 'Add loop';
    addLoop.addEventListener('click', () => {
      this.editView(entry.number, view, (loops) => [
        ...loops,
        { cels: [blankCel()], offset: 0, mirrorOf: null },
      ]);
    });
    bar.appendChild(addLoop);

    const removeLoop = document.createElement('button');
    removeLoop.type = 'button';
    removeLoop.textContent = 'Remove loop';
    removeLoop.disabled = view.loops.length <= 1;
    removeLoop.addEventListener('click', () => {
      this.editView(entry.number, view, (loops) =>
        loops.filter((_loop, index) => index !== this.selection.loop),
      );
      this.selection.loop = 0;
      this.selection.cel = 0;
    });
    bar.appendChild(removeLoop);

    section.appendChild(bar);
    section.appendChild(this.mirrorControls(entry, view));
    return section;
  }

  /**
   * Marking a loop as a mirror of another.
   *
   * The trap #136 names: a mirrored loop is stored **once** and flipped at
   * render time, so editing the source changes both — and the editor has to
   * make that obvious rather than letting an author discover it.
   */
  private mirrorControls(entry: AgiProjectResource, view: AgiViewResource): HTMLElement {
    const row = document.createElement('div');
    row.className = 'agi-controls';

    const label = document.createElement('label');
    label.textContent = `Loop ${this.selection.loop} mirrors `;

    const select = document.createElement('select');
    const none = document.createElement('option');
    none.value = '';
    none.textContent = 'nothing (own artwork)';
    select.appendChild(none);

    for (const [index, loop] of view.loops.entries()) {
      if (index === this.selection.loop || loop.mirrorOf !== null) continue;
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = `loop ${index}`;
      select.appendChild(option);
    }

    select.value = String(view.loops[this.selection.loop]?.mirrorOf ?? '');
    select.addEventListener('change', () => {
      const source = select.value === '' ? null : Number(select.value);
      this.editView(entry.number, view, (loops) =>
        loops.map((loop, index) => {
          if (index !== this.selection.loop) return loop;
          if (source === null) {
            // Its own artwork again: a copy of what it was mirroring, with the
            // mirror flag cleared, so it can be edited independently.
            return {
              ...loop,
              mirrorOf: null,
              cels: loop.cels.map((cel) => ({ ...cel, mirrorSourceLoop: null })),
            };
          }
          return {
            ...loop,
            mirrorOf: source,
            cels: loops[source].cels.map((cel) => ({ ...cel, mirrorSourceLoop: source })),
          };
        }),
      );
    });

    label.appendChild(select);
    row.appendChild(label);
    return row;
  }

  private mirrorNote(view: AgiViewResource, loopIndex: number): HTMLElement {
    const note = document.createElement('p');
    note.className = 'agi-hint';
    const loop = view.loops[loopIndex];

    if (loop.mirrorOf !== null) {
      note.classList.add('agi-summary-warning');
      note.textContent =
        `This loop is a mirror of loop ${loop.mirrorOf}. It has no artwork of its ` +
        `own — editing it means editing loop ${loop.mirrorOf}, and both will change.`;
      return note;
    }

    const mirrors = view.loops
      .map((candidate, index) => (candidate.mirrorOf === loopIndex ? index : -1))
      .filter((index) => index >= 0);

    note.textContent =
      mirrors.length > 0
        ? `Loop ${mirrors.join(' and ')} mirror this one, so an edit here changes them too.`
        : 'This loop has its own artwork.';
    if (mirrors.length > 0) note.classList.add('agi-summary-warning');
    return note;
  }

  /** A pixel grid in the sixteen EGA colours. */
  private celEditor(entry: AgiProjectResource, view: AgiViewResource, cel: AgiCel): HTMLElement {
    const section = document.createElement('section');

    const palette = document.createElement('div');
    palette.className = 'agi-palette';
    for (const [index, [red, green, blue]] of AGI_EGA_PALETTE.entries()) {
      const swatch = document.createElement('button');
      swatch.type = 'button';
      swatch.className = 'agi-swatch';
      swatch.style.background = `rgb(${red},${green},${blue})`;
      swatch.title = `Colour ${index}`;
      swatch.classList.toggle('selected', index === this.selection.colour);
      // A square of colour whose only content is that colour: 1.4.1 says the
      // colour cannot be the only thing carrying the meaning, so the name says
      // the index and the values.
      groupItem(swatch, {
        role: 'radio',
        selected: index === this.selection.colour,
        label: describeColour(index, [red, green, blue]),
      });
      swatch.addEventListener('click', () => {
        this.selection.colour = index;
        this.renderDetail();
      });
      palette.appendChild(swatch);
    }
    rovingGroup(palette, { role: 'radiogroup', label: 'Drawing colour' });
    section.appendChild(palette);

    const grid = document.createElement('div');
    grid.className = 'agi-cel-grid';
    grid.style.gridTemplateColumns = `repeat(${cel.width}, 12px)`;

    // The source loop's pixels, even when a mirror is selected — because a
    // mirror has no artwork of its own and editing it means editing the source.
    const sourceLoop = view.loops[this.selection.loop].mirrorOf ?? this.selection.loop;
    const mirrored = loopIsMirrored(cel, this.selection.loop);

    for (let y = 0; y < cel.height; y++) {
      for (let x = 0; x < cel.width; x++) {
        const shown = mirrored ? cel.width - 1 - x : x;
        const colour = cel.pixels[y * cel.width + shown];
        const [red, green, blue] = AGI_EGA_PALETTE[colour & 0x0f];

        const pixel = document.createElement('button');
        pixel.type = 'button';
        pixel.className = 'agi-pixel';
        pixel.style.background = `rgb(${red},${green},${blue})`;
        pixel.classList.toggle('agi-pixel-transparent', colour === cel.transparent);
        /*
         * A grid cell, named by where it is and what colour it holds.
         *
         * The whole grid is one tab stop with arrows inside it — see
         * `rovingGrid` for why a thousand tab stops is not keyboard access.
         * `role="gridcell"` rather than `radio` because the position is part of
         * what a pixel *is*, and a screen reader saying "row 4, column 12" is
         * telling the author where they are on the drawing.
         */
        pixel.setAttribute('role', 'gridcell');
        pixel.setAttribute(
          'aria-label',
          `Row ${y + 1}, column ${x + 1}. ${
            colour === cel.transparent
              ? 'Transparent'
              : describeColour(colour & 0x0f, [red, green, blue])
          }`,
        );
        pixel.addEventListener('click', () => {
          this.editView(entry.number, view, (loops) =>
            paintPixel(loops, sourceLoop, this.selection.cel, shown, y, this.selection.colour),
          );
          announce(`Painted colour ${this.selection.colour} at row ${y + 1}, column ${x + 1}.`);
        });
        grid.appendChild(pixel);
      }
    }

    rovingGrid(grid, {
      label: `Cel ${this.selection.cel} of loop ${this.selection.loop}, ${cel.width} by ${cel.height} pixels`,
      columns: cel.width,
    });

    section.appendChild(grid);
    return section;
  }

  private celControls(entry: AgiProjectResource, view: AgiViewResource): HTMLElement {
    const bar = document.createElement('div');
    bar.className = 'agi-controls';
    const loopIndex = view.loops[this.selection.loop].mirrorOf ?? this.selection.loop;
    const cel = view.loops[loopIndex].cels[this.selection.cel];

    const transparent = document.createElement('label');
    transparent.textContent = 'Transparent colour ';
    const transparentField = document.createElement('input');
    transparentField.type = 'number';
    transparentField.min = '0';
    transparentField.max = '15';
    transparentField.value = String(cel.transparent);
    transparentField.addEventListener('change', () => {
      const value = Math.max(0, Math.min(15, Number(transparentField.value) || 0));
      this.editView(entry.number, view, (loops) =>
        mapCel(loops, loopIndex, this.selection.cel, (target) => ({
          ...target,
          transparent: value,
        })),
      );
    });
    transparent.appendChild(transparentField);
    bar.appendChild(transparent);

    for (const [label, field] of [
      ['Width', 'width'],
      ['Height', 'height'],
    ] as const) {
      const wrapper = document.createElement('label');
      wrapper.textContent = `${label} `;
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '1';
      input.max = '160';
      input.value = String(cel[field]);
      input.addEventListener('change', () => {
        const value = Math.max(1, Math.min(160, Number(input.value) || 1));
        this.editView(entry.number, view, (loops) =>
          mapCel(loops, loopIndex, this.selection.cel, (target) =>
            // Resized by copying the overlapping region rather than
            // reinterpreting the buffer, so changing one cel's dimensions
            // cannot corrupt its neighbours (#136).
            resizeCel(
              target,
              field === 'width' ? value : target.width,
              field === 'height' ? value : target.height,
            ),
          ),
        );
      });
      wrapper.appendChild(input);
      bar.appendChild(wrapper);
    }

    const addCel = document.createElement('button');
    addCel.type = 'button';
    addCel.textContent = 'Add cel';
    addCel.addEventListener('click', () => {
      this.editView(entry.number, view, (loops) =>
        loops.map((loop, index) =>
          index === loopIndex
            ? { ...loop, cels: [...loop.cels, { ...cel, pixels: cel.pixels.slice() }] }
            : loop,
        ),
      );
    });
    bar.appendChild(addCel);

    const removeCel = document.createElement('button');
    removeCel.type = 'button';
    removeCel.textContent = 'Remove cel';
    removeCel.disabled = view.loops[loopIndex].cels.length <= 1;
    removeCel.addEventListener('click', () => {
      this.editView(entry.number, view, (loops) =>
        loops.map((loop, index) =>
          index === loopIndex
            ? { ...loop, cels: loop.cels.filter((_cel, at) => at !== this.selection.cel) }
            : loop,
        ),
      );
      this.selection.cel = 0;
    });
    bar.appendChild(removeCel);

    const play = document.createElement('button');
    play.type = 'button';
    play.textContent = this.selection.playing ? 'Stop preview' : 'Play loop';
    play.addEventListener('click', () => {
      this.selection.playing = !this.selection.playing;
      this.destroy();
      if (this.selection.playing) {
        // AGI's own cycle rate: the interpreter's default time delay is two
        // twentieths of a second, so a cel every tenth of a second is what a
        // player sees.
        this.previewTimer = setInterval(() => {
          const loop = view.loops[this.selection.loop];
          this.selection.cel = (this.selection.cel + 1) % Math.max(1, loop.cels.length);
          this.renderDetail();
        }, 100);
      }
      this.renderDetail();
    });
    bar.appendChild(play);

    return bar;
  }

  private editView(
    number: number,
    view: AgiViewResource,
    change: (loops: AgiViewResource['loops']) => AgiViewResource['loops'],
  ): void {
    const loops = change(view.loops);
    const next: AgiViewResource = { ...view, loops };
    this.options.update((project) => {
      const entry = project.agi?.views.find((resource) => resource.number === number);
      if (entry) entry.bytes = toBase64(writeView(next));
    });
    this.render();
  }

  // ---------------------------------------------------------------- Sound --

  private renderSound(agi: AgiProject): void {
    const entry = agi.sounds.find((resource) => resource.number === this.selection.number);
    if (!entry) return;

    const heading = document.createElement('h2');
    heading.textContent = `Sound ${entry.number}`;
    const note = document.createElement('p');
    note.className = 'agi-hint';
    // Honest about the boundary: sound editing is not in any of #134 to #136,
    // and saying so beats an empty panel that reads as a broken one.
    note.textContent =
      'Sounds are carried through unchanged. Editing them is not part of this ' +
      'surface, and the resource is exported exactly as it arrived.';
    this.detail.append(heading, note);
  }
}

// ------------------------------------------------------------- tree edits --

/** Replaces one operand of one statement, addressed by its path in the tree. */
function replaceOperand(
  tree: AgiLogicTree,
  path: number[],
  operandIndex: number,
  value: number,
): AgiLogicTree {
  const walk = (statements: AgiStatement[], at: number): AgiStatement[] => {
    const index = path[at];
    return statements.map((statement, position) => {
      if (position !== index) return statement;

      if (at === path.length - 1) {
        if (statement.kind !== 'command') return statement;
        return {
          ...statement,
          operands: statement.operands.map((operand, slot) =>
            slot === operandIndex ? { ...operand, value } : operand,
          ),
        };
      }

      if (statement.kind !== 'if') return statement;
      // The path alternates statement index and branch (0 for then, 1 for else).
      const branch = path[at + 1];
      return branch === 0
        ? { ...statement, then: walk(statement.then, at + 2) }
        : { ...statement, otherwise: walk(statement.otherwise, at + 2) };
    });
  };

  return { ...tree, statements: walk(tree.statements, 0) };
}

// -------------------------------------------------------------- cel edits --

function blankCel(): AgiCel {
  return {
    width: 8,
    height: 8,
    transparent: 0,
    mirrorSourceLoop: null,
    pixels: new Uint8Array(64),
    offset: 0,
  };
}

function mapCel(
  loops: AgiViewResource['loops'],
  loopIndex: number,
  celIndex: number,
  change: (cel: AgiCel) => AgiCel,
): AgiViewResource['loops'] {
  return loops.map((loop, index) =>
    index === loopIndex
      ? { ...loop, cels: loop.cels.map((cel, at) => (at === celIndex ? change(cel) : cel)) }
      : loop,
  );
}

function paintPixel(
  loops: AgiViewResource['loops'],
  loopIndex: number,
  celIndex: number,
  x: number,
  y: number,
  colour: number,
): AgiViewResource['loops'] {
  return mapCel(loops, loopIndex, celIndex, (cel) => {
    const pixels = cel.pixels.slice();
    if (x >= 0 && x < cel.width && y >= 0 && y < cel.height) {
      pixels[y * cel.width + x] = colour & 0x0f;
    }
    return { ...cel, pixels };
  });
}

/**
 * Resizes a cel by copying the overlapping region.
 *
 * Reinterpreting the buffer at a new width would shear the artwork and, worse,
 * read past its end — which is what "changing them does not corrupt neighbouring
 * cels" (#136) is guarding against.
 */
function resizeCel(cel: AgiCel, width: number, height: number): AgiCel {
  const pixels = new Uint8Array(width * height).fill(cel.transparent);
  const copyWidth = Math.min(width, cel.width);
  const copyHeight = Math.min(height, cel.height);

  for (let y = 0; y < copyHeight; y++) {
    for (let x = 0; x < copyWidth; x++) {
      pixels[y * width + x] = cel.pixels[y * cel.width + x];
    }
  }

  return { ...cel, width, height, pixels };
}
