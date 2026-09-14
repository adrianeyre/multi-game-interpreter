import { ACTION_LABELS, describeAction, type Action } from '../authoring/actions.js';
import { fromBase64, toBase64 } from '../authoring/base64.js';
import { scummVersionOf } from '../authoring/project.js';
import type { Target } from '../authoring/target.js';
import {
  assembleClassic,
  disassembleClassic,
  formatClassicListing,
  type ClassicVersion,
} from '../authoring/disassembleClassic.js';
import {
  assembleV6,
  assembleV8,
  disassembleV6,
  disassembleV7,
  disassembleV8,
  formatV6Listing,
} from '../authoring/disassembleV6.js';

type ActionType = Action['type'];

/** Sensible starting values, so adding an action never yields an invalid one. */
const TEMPLATES: Record<ActionType, () => Action> = {
  say: () => ({ type: 'say', actor: 'ego', text: 'Something to say.' }),
  wait: () => ({ type: 'wait', frames: 30 }),
  waitForMessage: () => ({ type: 'waitForMessage' }),
  walkTo: () => ({ type: 'walkTo', x: 160, y: 120 }),
  walkToObject: () => ({ type: 'walkToObject', object: 0 }),
  faceObject: () => ({ type: 'faceObject', object: 0 }),
  walkActorTo: () => ({ type: 'walkActorTo', actor: 1, x: 160, y: 120 }),
  putActorInRoom: () => ({ type: 'putActorInRoom', actor: 1, room: 1, x: 160, y: 120 }),
  faceActorAt: () => ({ type: 'faceActorAt', actor: 1, target: 1 }),
  setState: () => ({ type: 'setState', object: 0, state: 1 }),
  giveItem: () => ({ type: 'giveItem', object: 0 }),
  takeItem: () => ({ type: 'takeItem', object: 0 }),
  gotoRoom: () => ({ type: 'gotoRoom', room: 1 }),
  setFlag: () => ({ type: 'setFlag', flag: 0, value: 1 }),
  playSound: () => ({ type: 'playSound', sound: 1 }),
  startScript: () => ({ type: 'startScript', script: 10 }),
  animateActor: () => ({ type: 'animateActor', actor: 'ego', frame: 3 }),
  if: () => ({ type: 'if', flag: 0, equals: 1, then: [] }),
  code: () => ({ type: 'code', source: "s.sayEgo('Hello from code');" }),
  // Never chosen from the menu — it only ever arrives from an import — but the
  // table has to be total, and a template that produces nothing is honest
  // about that.
  raw: () => ({ type: 'raw', listing: '', bytes: '' }),
};

/** Steps an author can add. `raw` is not one: it comes out of a game. */
const ADDABLE = (Object.keys(TEMPLATES) as ActionType[]).filter((type) => type !== 'raw');

export interface ActionEditorOptions {
  /** Objects the author can reference, for the dropdowns. */
  objects: Array<{ id: number; name: string }>;
  rooms: Array<{ id: number; name: string }>;
  actors: Array<{ id: number; name: string }>;
  /** The project's audio library, for the "Play sound" step. */
  audio: Array<{ id: number; name: string }>;
  /**
   * The SCUMM version the project targets.
   *
   * It decides whether a preserved script can be edited: v6 instruction
   * boundaries are certain, so an edit can be written back exactly (ADR 0005),
   * and v5's are not.
   */
  target?: Target;
  /**
   * The game's text, when it lives outside the scripts.
   *
   * A v7 instruction names a line by tag, so a listing shows `/NEW.007/` where
   * an author expects words. Passing the strings in lets the row show the line
   * and, more importantly, how many other scripts share it — an edit here
   * changes all of them, which is not true of anything else in a project
   * (ADR 0009).
   */
  strings?: { entries: Array<{ tag: string; text: string; original: string }> };
  /** Tag -> the scripts that reference it, from `findReferences`. */
  stringReferences?: ReadonlyMap<string, string[]>;
  onChange: () => void;
}

/**
 * Edits a list of actions.
 *
 * Rendered as plain DOM rather than through a framework: the editor has one
 * data shape and one update path, and a framework would add a build-time
 * dependency for a list with add, remove and reorder.
 */
export class ActionEditor {
  readonly element: HTMLDivElement;
  private actions: Action[] = [];
  private options: ActionEditorOptions;

  constructor(options: ActionEditorOptions) {
    this.options = options;
    this.element = document.createElement('div');
    this.element.className = 'action-editor';
  }

  setOptions(options: Partial<ActionEditorOptions>): void {
    this.options = { ...this.options, ...options };
  }

  /**
   * A v6 script, one row per instruction, with its operand editable.
   *
   * Editing one row re-assembles the whole script and writes the bytes back —
   * which is safe here in a way it would not be for v5, because every
   * instruction carries its own measured length, so the bytes around the edit
   * come out unchanged. The listing is rebuilt from the new bytes rather than
   * patched, so what the author sees is always a reading of what is actually
   * stored.
   */
  /**
   * Replaces each `/TAG/fallback` in a rendered instruction with its line.
   *
   * Falls back to the text carried beside the tag when the bundle has no entry,
   * which is what the engine does and what Full Throttle relies on entirely.
   */
  private resolveTags(text: string): string {
    const strings = this.options.strings;
    if (!strings) return text;

    return text.replace(
      /\/([A-Za-z0-9_.]{1,12})\/([^"']*)/g,
      (whole, tag: string, fallback: string) => {
        const entry = strings.entries.find((candidate) => candidate.tag === tag.toUpperCase());
        return entry ? entry.text : fallback || whole;
      },
    );
  }

  /** "shared with 3 other scripts", or null when nothing is shared. */
  private describeReach(text: string): string | null {
    const references = this.options.stringReferences;
    if (!references) return null;

    const tags = [...text.matchAll(/\/([A-Za-z0-9_.]{1,12})\//g)].map((match) =>
      match[1].toUpperCase(),
    );

    let most = 0;
    for (const tag of tags) most = Math.max(most, references.get(tag)?.length ?? 0);
    if (most <= 1) return null;

    return `shared with ${most - 1} other script${most - 1 === 1 ? '' : 's'}`;
  }

  /**
   * The SCUMM version this editor is showing instructions for, if any.
   *
   * Read from the Target rather than held as a number, because the answer for
   * an AGI project is "none" rather than a version — and treating that as v5
   * would show a v5 disassembly of AGI bytecode (ADR 0012).
   */
  private scummVersion(): number | null {
    return this.options.target ? scummVersionOf(this.options.target) : null;
  }

  /**
   * A Classic script, one row per instruction, with every literal editable.
   *
   * The Stack table below offers one operand per row, because a Stack
   * instruction reads at most one thing from the code stream and takes the rest
   * off the stack. A Classic instruction is the other shape: its operands are
   * all in the code stream, and each is a byte or a word chosen by a mode bit
   * in the opcode. So a row here offers as many fields as the instruction has,
   * each labelled with what it is.
   *
   * An edit rewrites the field in place and keeps the instruction's length, so
   * every jump displacement around it is still correct — which is what makes
   * this safe to offer at all. Changing a length would move every instruction
   * after it and leave every backward jump in the script pointing at the wrong
   * byte.
   */
  private classicInstructionTable(
    action: Extract<Action, { type: 'raw' }>,
    version: ClassicVersion,
    commit: () => void,
  ): HTMLElement {
    const table = document.createElement('div');
    table.className = 'instruction-table';

    const code = fromBase64(action.bytes);
    const listing = disassembleClassic(code, version);

    for (const instruction of listing.instructions) {
      const row = document.createElement('div');
      row.className = 'instruction-row';

      const offset = document.createElement('span');
      offset.className = 'instruction-offset';
      offset.textContent = String(instruction.offset);
      row.appendChild(offset);

      const text = document.createElement('span');
      text.className = 'instruction-text';
      text.textContent = instruction.text;
      row.appendChild(text);

      for (const field of instruction.fields) {
        // A variable reference is a number too, but changing it means pointing
        // the instruction at a different variable rather than giving it a
        // different value, so it is labelled as what it is.
        const label = field.variable ? `${field.label} (var)` : field.label;
        row.appendChild(
          numberField(label, field.value, (value) => {
            field.value = value;
            const rebuilt = assembleClassic(listing, code);
            action.bytes = toBase64(rebuilt);
            action.listing = formatClassicListing(disassembleClassic(rebuilt, version), rebuilt);
            commit();
          }),
        );
      }

      table.appendChild(row);
    }

    if (listing.undecodedFrom !== null) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent =
        `Reading stopped at ${listing.undecodedFrom}: ${listing.reason}. ` +
        `Those bytes are kept exactly as the game had them.`;
      table.appendChild(note);
    }

    return table;
  }

  private instructionTable(
    action: Extract<Action, { type: 'raw' }>,
    commit: () => void,
  ): HTMLElement {
    const table = document.createElement('div');
    table.className = 'instruction-table';

    const code = fromBase64(action.bytes);
    // Which reader depends on the project's target, not on what the bytes look
    // like. The two agree about every opcode and disagree about how an inline
    // message is measured, so reading v7 bytes with the v6 reader is wrong only
    // where a script talks — which is most of them, and silently.
    const version = this.scummVersion();
    const disassemble =
      version === 8 ? disassembleV8 : version === 7 ? disassembleV7 : disassembleV6;
    // v8's stream operands are four bytes wide, so it needs its own emitter as
    // well as its own reader — unlike v7, which shares v6's exactly.
    const assemble = version === 8 ? assembleV8 : assembleV6;
    const listing = disassemble(code);

    for (const [index, instruction] of listing.instructions.entries()) {
      const row = document.createElement('div');
      row.className = 'instruction-row';

      const offset = document.createElement('span');
      offset.className = 'instruction-offset';
      offset.textContent = String(instruction.offset);
      row.appendChild(offset);

      const text = document.createElement('span');
      text.className = 'instruction-text';
      text.textContent = this.resolveTags(instruction.text);
      row.appendChild(text);

      // How far an edit to this line reaches. Shown on the row rather than in
      // the string editor, because the author is looking at the script when
      // they decide to change a line, and "this is shared" is the thing they
      // need before they commit rather than after.
      const reach = this.describeReach(instruction.text);
      if (reach) {
        const note = document.createElement('span');
        note.className = 'instruction-reach';
        note.textContent = reach;
        row.appendChild(note);
      }

      // Only the operand read from the code stream is editable. The rest of an
      // instruction's meaning comes off the stack, which means changing it is
      // editing a *different* instruction — the one that pushed it.
      if (instruction.streamOperand !== undefined) {
        row.appendChild(
          numberField('', instruction.streamOperand, (value) => {
            listing.instructions[index] = { ...instruction, streamOperand: value };
            const rebuilt = assemble(listing, code);
            action.bytes = toBase64(rebuilt);
            action.listing = formatV6Listing(disassemble(rebuilt), rebuilt);
            commit();
          }),
        );
      }

      table.appendChild(row);
    }

    if (listing.undecodedFrom !== null) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent =
        `Reading stopped at ${listing.undecodedFrom}: ${listing.reason}. ` +
        `Those bytes are kept exactly as the game had them.`;
      table.appendChild(note);
    }

    return table;
  }

  /** Binds to a list, which is mutated in place so the project stays the truth. */
  bind(actions: Action[]): void {
    this.actions = actions;
    this.render();
  }

  private changed(): void {
    this.render();
    this.options.onChange();
  }

  render(): void {
    this.element.replaceChildren();

    if (this.actions.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted empty';
      empty.textContent = 'Nothing happens yet. Add a step below.';
      this.element.appendChild(empty);
    }

    this.actions.forEach((action, index) => {
      this.element.appendChild(this.renderAction(action, index));
    });

    this.element.appendChild(this.renderAddButton());
  }

  private renderAction(action: Action, index: number): HTMLElement {
    const row = document.createElement('div');
    row.className = 'action-row';
    // A group named by the step it holds, so the fields inside it are announced
    // as belonging to "step 2, walk to 160, 120" rather than floating loose in
    // a run of identical-looking number boxes.
    row.setAttribute('role', 'group');

    const header = document.createElement('div');
    header.className = 'action-header';

    const title = document.createElement('span');
    title.className = 'action-title';
    title.id = `action-title-${index}-${Math.random().toString(36).slice(2, 8)}`;
    title.textContent = describeAction(action);
    row.setAttribute('aria-labelledby', title.id);
    header.appendChild(title);

    const controls = document.createElement('div');
    controls.className = 'action-controls';

    const move = (delta: number): void => {
      const target = index + delta;
      if (target < 0 || target >= this.actions.length) return;
      const [item] = this.actions.splice(index, 1);
      this.actions.splice(target, 0, item);
      this.changed();
    };

    const step = `step ${index + 1}, ${describeAction(action)}`;
    controls.appendChild(iconButton('↑', `Move ${step} earlier`, () => move(-1)));
    controls.appendChild(iconButton('↓', `Move ${step} later`, () => move(1)));
    controls.appendChild(
      iconButton('✕', `Remove ${step}`, () => {
        this.actions.splice(index, 1);
        this.changed();
      }),
    );
    header.appendChild(controls);
    row.appendChild(header);

    const fields = document.createElement('div');
    fields.className = 'action-fields';
    this.renderFields(fields, action);
    row.appendChild(fields);

    return row;
  }

  private renderFields(container: HTMLElement, action: Action): void {
    const commit = (): void => this.changed();

    switch (action.type) {
      case 'say':
        container.appendChild(
          selectField(
            'Who',
            String(action.actor),
            [
              ['ego', 'The player'],
              ['1', 'Actor 1'],
            ],
            (v) => {
              (action as Extract<Action, { type: 'say' }>).actor = v === 'ego' ? 'ego' : Number(v);
              commit();
            },
          ),
        );
        container.appendChild(
          textAreaField('Text', action.text, (v) => {
            action.text = v;
            commit();
          }),
        );
        break;

      case 'wait':
        container.appendChild(
          numberField('Frames', action.frames, (v) => {
            action.frames = v;
            commit();
          }),
        );
        break;

      case 'waitForMessage':
        break;

      case 'walkTo':
        container.appendChild(numberField('X', action.x, (v) => ((action.x = v), commit())));
        container.appendChild(numberField('Y', action.y, (v) => ((action.y = v), commit())));
        break;

      case 'walkActorTo':
        container.appendChild(
          this.actorField('Actor', action.actor, (v) => ((action.actor = v), commit())),
        );
        container.appendChild(numberField('X', action.x, (v) => ((action.x = v), commit())));
        container.appendChild(numberField('Y', action.y, (v) => ((action.y = v), commit())));
        break;

      case 'putActorInRoom':
        container.appendChild(
          this.actorField('Actor', action.actor, (v) => ((action.actor = v), commit())),
        );
        container.appendChild(
          selectField(
            'Room',
            String(action.room),
            this.options.rooms.map((room) => [String(room.id), `${room.id} — ${room.name}`]),
            (v) => {
              action.room = Number(v);
              commit();
            },
          ),
        );
        container.appendChild(numberField('X', action.x, (v) => ((action.x = v), commit())));
        container.appendChild(numberField('Y', action.y, (v) => ((action.y = v), commit())));
        break;

      case 'faceActorAt':
        container.appendChild(
          this.actorField('Actor', action.actor, (v) => ((action.actor = v), commit())),
        );
        container.appendChild(
          numberField('Faces', action.target, (v) => ((action.target = v), commit())),
        );
        break;

      case 'walkToObject':
      case 'faceObject':
      case 'giveItem':
      case 'takeItem':
        container.appendChild(
          this.objectField('Object', action.object, (v) => {
            action.object = v;
            commit();
          }),
        );
        break;

      case 'setState':
        container.appendChild(
          this.objectField('Object', action.object, (v) => ((action.object = v), commit())),
        );
        container.appendChild(
          numberField('State', action.state, (v) => ((action.state = v), commit())),
        );
        break;

      case 'gotoRoom': {
        container.appendChild(
          selectField(
            'Room',
            String(action.room),
            this.options.rooms.map((room) => [String(room.id), `${room.id} — ${room.name}`]),
            (v) => {
              action.room = Number(v);
              commit();
            },
          ),
        );
        container.appendChild(
          this.objectField('Arrive at', action.arriveAt ?? 0, (v) => {
            action.arriveAt = v || undefined;
            commit();
          }),
        );
        break;
      }

      case 'setFlag':
        container.appendChild(
          numberField('Flag', action.flag, (v) => ((action.flag = v), commit())),
        );
        container.appendChild(
          numberField('Value', action.value, (v) => ((action.value = v), commit())),
        );
        break;

      case 'raw': {
        if (action.note) {
          const note = document.createElement('p');
          note.className = 'muted';
          note.textContent = action.note;
          container.appendChild(note);
        }

        // Every supported Version's instructions can now be edited. The Stack
        // ones always could — their boundaries follow from the opcode alone
        // (ADR 0005). The Classic ones could not until their layouts were
        // measured one at a time against a shipped game, which is what
        // `disassembleClassic` is; before that the reader stopped where it
        // could no longer measure an instruction, and offering an edit it
        // could not write back would have been a lie.
        const scummVersion = this.scummVersion();
        if (scummVersion === 6 || scummVersion === 7 || scummVersion === 8) {
          container.appendChild(this.instructionTable(action, commit));
          break;
        }
        if (scummVersion !== null && scummVersion <= 5) {
          container.appendChild(
            this.classicInstructionTable(action, scummVersion as ClassicVersion, commit),
          );
          break;
        }

        const listing = document.createElement('pre');
        listing.className = 'raw-listing';
        listing.textContent = action.listing || '(no readable instructions)';
        container.appendChild(listing);
        break;
      }

      case 'playSound':
        container.appendChild(
          this.soundField('Sound', action.sound, (v) => ((action.sound = v), commit())),
        );
        break;

      case 'startScript':
        container.appendChild(
          numberField('Script', action.script, (v) => ((action.script = v), commit())),
        );
        break;

      case 'animateActor':
        container.appendChild(
          numberField('Frame', action.frame, (v) => ((action.frame = v), commit())),
        );
        break;

      case 'if': {
        container.appendChild(
          numberField('Flag', action.flag, (v) => ((action.flag = v), commit())),
        );
        container.appendChild(
          numberField('Equals', action.equals, (v) => ((action.equals = v), commit())),
        );

        const branch = (label: string, list: Action[]): HTMLElement => {
          const wrapper = document.createElement('div');
          wrapper.className = 'action-branch';
          const heading = document.createElement('h5');
          heading.textContent = label;
          wrapper.appendChild(heading);

          const nested = new ActionEditor({ ...this.options, onChange: commit });
          nested.bind(list);
          wrapper.appendChild(nested.element);
          return wrapper;
        };

        container.appendChild(branch('Then', action.then));
        action.else ??= [];
        container.appendChild(branch('Otherwise', action.else));
        break;
      }

      case 'code': {
        const help = document.createElement('p');
        help.className = 'muted';
        help.textContent =
          'Runs against the assembler as `s`. Full access to every opcode — this is the escape hatch when the steps above are not enough.';
        container.appendChild(help);
        container.appendChild(
          textAreaField(
            'Code',
            action.source,
            (v) => {
              action.source = v;
              commit();
            },
            6,
          ),
        );
        break;
      }
    }
  }

  private objectField(
    label: string,
    value: number,
    onChange: (value: number) => void,
  ): HTMLElement {
    const choices: Array<[string, string]> = [['0', '(none)']];
    for (const object of this.options.objects) {
      choices.push([String(object.id), `${object.id} — ${object.name}`]);
    }
    // Keep an id that points outside this room selectable rather than silently
    // resetting it to "none".
    if (value !== 0 && !this.options.objects.some((object) => object.id === value)) {
      choices.push([String(value), `${value} — (elsewhere)`]);
    }
    return selectField(label, String(value), choices, (v) => onChange(Number(v)));
  }

  /**
   * Chooses an imported track by name.
   *
   * Falls back to a plain number when the project has no audio, because a
   * decompiled game's scripts refer to sounds in its own container that the
   * editor never imported — an empty dropdown would make those uneditable.
   */
  private soundField(label: string, value: number, onChange: (value: number) => void): HTMLElement {
    const tracks = this.options.audio;
    if (tracks.length === 0) return numberField(label, value, onChange);

    const choices: Array<[string, string]> = tracks.map((track) => [
      String(track.id),
      `${track.id} — ${track.name}`,
    ]);
    if (!tracks.some((track) => track.id === value)) {
      choices.unshift([String(value), `${value} — (not imported)`]);
    }
    return selectField(label, String(value), choices, (v) => onChange(Number(v)));
  }

  private actorField(label: string, value: number, onChange: (value: number) => void): HTMLElement {
    const choices: Array<[string, string]> = this.options.actors.map((actor) => [
      String(actor.id),
      `${actor.id} — ${actor.name}`,
    ]);
    if (choices.length === 0) choices.push(['1', '1 — (none defined)']);
    return selectField(label, String(value), choices, (v) => onChange(Number(v)));
  }

  private renderAddButton(): HTMLElement {
    const wrapper = document.createElement('div');
    wrapper.className = 'action-add';

    const select = document.createElement('select');
    // Its own label: the first option reads as the value, not as a name, so a
    // screen reader announcing this said "+ Add step, combo box" and nothing
    // about what the list is of (3.3.2).
    select.setAttribute('aria-label', 'Add a step to this behaviour');
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = '+ Add step…';
    select.appendChild(placeholder);

    for (const type of ADDABLE) {
      const option = document.createElement('option');
      option.value = type;
      option.textContent = ACTION_LABELS[type];
      select.appendChild(option);
    }

    select.addEventListener('change', () => {
      const type = select.value as ActionType;
      if (!type) return;
      this.actions.push(TEMPLATES[type]());
      select.value = '';
      this.changed();
    });

    wrapper.appendChild(select);
    return wrapper;
  }
}

// ------------------------------------------------------------- field helpers --

function labelled(label: string, control: HTMLElement): HTMLElement {
  const wrapper = document.createElement('label');
  wrapper.className = 'field';
  const text = document.createElement('span');
  text.textContent = label;
  wrapper.append(text, control);
  return wrapper;
}

export function numberField(
  label: string,
  value: number,
  onChange: (value: number) => void,
): HTMLElement {
  const input = document.createElement('input');
  input.type = 'number';
  input.value = String(value);
  input.addEventListener('change', () => onChange(Number(input.value) || 0));
  return labelled(label, input);
}

export function textField(
  label: string,
  value: string,
  onChange: (value: string) => void,
): HTMLElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  return labelled(label, input);
}

function textAreaField(
  label: string,
  value: string,
  onChange: (value: string) => void,
  rows = 3,
): HTMLElement {
  const input = document.createElement('textarea');
  input.rows = rows;
  input.value = value;
  input.addEventListener('change', () => onChange(input.value));
  return labelled(label, input);
}

export function selectField(
  label: string,
  value: string,
  choices: Array<[string, string]>,
  onChange: (value: string) => void,
): HTMLElement {
  const select = document.createElement('select');
  for (const [optionValue, optionLabel] of choices) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = optionLabel;
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return labelled(label, select);
}

/**
 * A button whose face is a symbol and whose name is words.
 *
 * The glyph used to be the button's text content, which made it the accessible
 * name — so these three read as "upwards arrow", "downwards arrow" and "heavy
 * multiplication x", none of which says what pressing them does, and none of
 * which says *which* step it does it to. The glyph is hidden and the name is
 * written out (4.1.2, 2.4.6).
 */
function iconButton(glyph: string, label: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  const inner = document.createElement('span');
  inner.setAttribute('aria-hidden', 'true');
  inner.textContent = glyph;
  button.appendChild(inner);
  button.setAttribute('aria-label', label);
  button.title = label;
  button.addEventListener('click', onClick);
  return button;
}
