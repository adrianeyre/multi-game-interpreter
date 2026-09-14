/**
 * What a Broken Sword call's argument may be, and what it currently names.
 *
 * The bridge between `authoring/sword1/calls.ts` (which says an argument is a
 * `screen`) and `operandField.ts` (which draws a picker): this is the file that
 * knows a screen list is `sword1.rooms` and that a text id splits into a
 * section and a line.
 *
 * Pure functions returning plain records, for the reason every editor module
 * here gives: jsdom has no canvas and no layout, so the part worth testing is
 * the part that decides *what* to show. The DOM around it is a thin shell.
 */

import type { Sword1CallArgument } from '../../authoring/sword1/calls.js';
import type { Sword1Project } from '../../authoring/sword1/project.js';
import { formatResourceId } from '../../engine/sword1/resource/rif.js';
import { SWORD1_DIRECTION_NAMES } from '../../engine/sword1/script/mcodeParams.js';
import { sword1ScriptVarName } from '../../engine/sword1/script/scriptVars.js';
import { sword1VarLayout } from '../../engine/sword1/script/swordVarLayout.js';
import { sword1CompactFieldName } from '../../authoring/sword1/disassemble.js';
import { sword1SequenceName } from '../../engine/sword1/video/sequenceNames.js';
import { OPERAND_CHOICE_LIMIT, type OperandChoice } from '../operandField.js';

/** How one argument is drawn: a label, a picker or not, and what it names. */
export interface Sword1ArgumentField {
  readonly label: string;
  readonly choices: readonly OperandChoice[] | null;
  readonly hint: string | null;
}

/**
 * The subtitle a text id names.
 *
 * A text id is `section * 0x10000 + line`, the same shape as a script id.
 * English is preferred because it is the language every release ships and the
 * one an author is most likely to be reading; a release without it falls back
 * to whatever this project imported.
 */
export function sword1TextLine(sword1: Sword1Project, textId: number): string | null {
  const section = Math.floor(textId / 0x10000);
  const line = textId & 0xffff;
  const candidates = sword1.text.filter((entry) => entry.section === section);
  const entry = candidates.find((one) => one.language === 'english') ?? candidates[0];
  const text = entry?.lines[line];
  return text ? text : null;
}

/** Which compact an object id names, said in the terms the editor lists them. */
function compactHint(sword1: Sword1Project, id: number): string {
  const section = Math.floor(id / 0x10000);
  const index = id & 0xffff;
  const held = sword1.sections
    .find((one) => one.section === section)
    ?.compacts.some((compact) => compact.id === id);
  return held
    ? `compact ${index} of section ${section}`
    : `compact ${index} of section ${section} — not in this project`;
}

/** What a resource id is, as far as this project can say. */
function resourceHint(sword1: Sword1Project, id: number): string {
  const label = formatResourceId(id);
  if (sword1.pictures.some((picture) => picture.resource === id)) return `${label} — a picture`;
  if (sword1.palettes.some((palette) => palette.resource === id)) return `${label} — a palette`;
  if (sword1.scripts.some((script) => script.resource === id)) return `${label} — a script module`;
  if (sword1.text.some((text) => text.resource === id)) return `${label} — a text resource`;
  return `${label} — not a resource this project imported`;
}

/** Trims a list that is too long to be a usable picker down to no picker. */
function picker(choices: OperandChoice[]): readonly OperandChoice[] | null {
  return choices.length > 0 && choices.length <= OPERAND_CHOICE_LIMIT ? choices : null;
}

/**
 * How to draw one argument.
 *
 * The *push* outranks the argument's kind, and that ordering matters: an
 * argument declared a screen but pushed with `IT_PUSHVARIABLE` is a variable
 * number, and offering the screen list for it would write a screen number into
 * a variable index.
 */
export function sword1ArgumentField(
  sword1: Sword1Project,
  argument: Sword1CallArgument,
): Sword1ArgumentField {
  if (argument.push === 'variable') {
    return {
      label: `${argument.label} (variable)`,
      choices: null,
      hint: sword1ScriptVarName(
        sword1VarLayout(sword1.identification.release).toRetail[argument.value] ?? argument.value,
      ),
    };
  }
  if (argument.push === 'longOffset' || argument.push === 'wordOffset') {
    return {
      label: `${argument.label} (this object's)`,
      choices: null,
      hint: sword1CompactFieldName(argument.value),
    };
  }

  switch (argument.kind) {
    case 'screen':
      return {
        label: argument.label,
        choices: picker(
          sword1.rooms.map((room) => ({
            value: room.screen,
            label: `${room.screen} — ${room.width}×${room.height}`,
          })),
        ),
        hint: null,
      };
    case 'text': {
      const line = sword1TextLine(sword1, argument.value);
      return {
        label: argument.label,
        choices: null,
        hint: line
          ? `“${line}”`
          : `section ${Math.floor(argument.value / 0x10000)}, line ${argument.value & 0xffff} — ` +
            `no text for it in this project`,
      };
    }
    case 'script':
      return {
        label: argument.label,
        choices: null,
        hint: `script ${argument.value & 0xffff} of section ${Math.floor(argument.value / 0x10000)}`,
      };
    case 'object':
      return { label: argument.label, choices: null, hint: compactHint(sword1, argument.value) };
    case 'sequence':
      return {
        label: argument.label,
        choices: null,
        hint: sword1SequenceName(argument.value) ?? 'no sequence of that number',
      };
    case 'sound': {
      const effect = sword1.effects.find((one) => one.fxNo === argument.value);
      return {
        label: argument.label,
        choices: picker(
          sword1.effects.map((one) => ({
            value: one.fxNo,
            label: `${one.fxNo} — sample ${one.sample ?? 'none'}`,
          })),
        ),
        hint: effect
          ? `sample ${effect.sample ?? 'none'}, in ${effect.rooms.length} rooms`
          : 'no effect of that number in the fx table',
      };
    }
    case 'music':
      return { label: argument.label, choices: null, hint: `tune ${argument.value}` };
    case 'resource':
      return { label: argument.label, choices: null, hint: resourceHint(sword1, argument.value) };
    case 'direction':
      return {
        label: argument.label,
        choices: SWORD1_DIRECTION_NAMES.map((name, value) => ({
          value,
          label: `${value} — ${name}`,
        })),
        hint: null,
      };
    case 'coordinate':
    case 'number':
    default:
      return { label: argument.label, choices: null, hint: null };
  }
}
