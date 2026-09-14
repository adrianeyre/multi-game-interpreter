/**
 * What a Broken Sword II call's parameter may be, and what it currently names.
 *
 * The sibling of `sword1/callFields.ts`, and separate for ADR 0036's reason.
 * What differs is not the shape but the answers:
 *
 * - A **pointer** parameter has nothing to pick from. It is the address of a
 *   structure inside this object's own local variables, at an offset only this
 *   object's script knows, so the hint says which structure Revolution's own
 *   comment named and stops there.
 * - A **text id** is `resource * 0x10000 + line` where the resource is a text
 *   module this project imported by id — not a section number, which is what
 *   Sword1's is.
 * - A **string** parameter is not a number at all, so it has no field here: the
 *   listing edits it through `editSword2String`, which is the one edit in this
 *   family that changes text rather than a word.
 */

import type { Sword2CallArgument } from '../../authoring/sword2/calls.js';
import type { Sword2Project } from '../../authoring/sword2/project.js';
import { OPERAND_CHOICE_LIMIT, type OperandChoice } from '../operandField.js';

export interface Sword2ArgumentField {
  readonly label: string;
  readonly choices: readonly OperandChoice[] | null;
  readonly hint: string | null;
}

/** The line a text id names, or null when this project holds no such line. */
export function sword2TextLine(sword2: Sword2Project, textId: number): string | null {
  const module = Math.floor(textId / 0x10000);
  const line = textId & 0xffff;
  const text = sword2.text.find((entry) => entry.resource === module)?.lines[line];
  return text ? text : null;
}

/** What a resource id is, as far as this project can say. */
function resourceHint(sword2: Sword2Project, id: number): string {
  if (sword2.screens.some((screen) => screen.resource === id)) return `${id} — a screen`;
  if (sword2.objects.some((object) => object.id === id)) return `${id} — a game object`;
  if (sword2.text.some((text) => text.resource === id)) return `${id} — a text module`;
  if (sword2.runLists.some((list) => list.resource === id)) return `${id} — a run list`;
  return `${id} — not a resource this project imported`;
}

function picker(choices: OperandChoice[]): readonly OperandChoice[] | null {
  return choices.length > 0 && choices.length <= OPERAND_CHOICE_LIMIT ? choices : null;
}

/**
 * How to draw one parameter.
 *
 * As on the Sword1 side, the push outranks the described kind: a parameter
 * documented as an animation resource but pushed from a global variable is a
 * variable number, and a picker over resources would write the wrong thing.
 */
export function sword2ArgumentField(
  sword2: Sword2Project,
  argument: Sword2CallArgument,
): Sword2ArgumentField {
  if (argument.push === 'localVar' || argument.push === 'globalVar') {
    const where = argument.push === 'localVar' ? "this object's" : 'a game';
    return {
      label: `${argument.label} (variable)`,
      choices: null,
      hint: `${where} variable ${argument.value}`,
    };
  }
  if (argument.push === 'localAddr') {
    return {
      label: `${argument.label} (address)`,
      choices: null,
      hint: `byte ${argument.value} of this object's local variables`,
    };
  }
  if (argument.push === 'structure') {
    return {
      label: `${argument.label} (structure)`,
      choices: null,
      hint: `byte ${argument.value} of the pushed structure`,
    };
  }
  if (argument.push === 'string') {
    return { label: argument.label, choices: null, hint: argument.text ?? '' };
  }

  switch (argument.kind) {
    case 'pointer':
      return {
        label: argument.label,
        choices: null,
        hint: `${argument.value} — a pointer written as a plain number`,
      };
    case 'text': {
      const line = sword2TextLine(sword2, argument.value);
      return {
        label: argument.label,
        choices: null,
        hint: line
          ? `“${line}”`
          : `module ${Math.floor(argument.value / 0x10000)}, line ${argument.value & 0xffff} — ` +
            `no text for it in this project`,
      };
    }
    case 'object':
      return {
        label: argument.label,
        choices: picker(
          sword2.objects.map((object) => ({
            value: object.id,
            label: `${object.id} — ${object.name}`,
          })),
        ),
        hint:
          sword2.objects.find((object) => object.id === argument.value)?.name ??
          'no object of that id in this project',
      };
    case 'script':
      return {
        label: argument.label,
        choices: null,
        hint: `script ${argument.value & 0xffff} of object ${Math.floor(argument.value / 0x10000)}`,
      };
    case 'resource':
      return { label: argument.label, choices: null, hint: resourceHint(sword2, argument.value) };
    case 'sound':
    case 'music':
      return { label: argument.label, choices: null, hint: `resource ${argument.value}` };
    case 'direction':
    case 'coordinate':
    case 'string':
    case 'number':
    default:
      return { label: argument.label, choices: null, hint: null };
  }
}
