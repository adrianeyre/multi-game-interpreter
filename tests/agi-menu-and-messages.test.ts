/**
 * The two things King's Quest III needed that no AGI game here had: a menu bar
 * and message format codes.
 *
 * Both were invisible in a passing suite, and both are the same *kind* of gap —
 * the interpreter had the game's data and was not turning it into what a player
 * sees. The menu was logged as unimplemented on the argument that every
 * controller a menu fires is also reachable from `set.key`; the format codes
 * were drawn literally.
 */

import { describe, expect, it } from 'vitest';

import { AgiMenu } from '../src/engine/agi/AgiMenu.js';
import { formatAgiMessage } from '../src/engine/agi/script/messageFormat.js';

/** Escape, Enter, and the four arrow scan codes, as `pressKey` takes them. */
const ESCAPE = 0x1b;
const ENTER = 0x0d;
const DOWN = 80 << 8;
const UP = 72 << 8;
const RIGHT = 77 << 8;

const never = (): boolean => false;

/** King's Quest III's own bar, as its Logic 0 declares it. */
function kq3Menu(): AgiMenu {
  const menu = new AgiMenu();
  menu.addColumn(' Sierra ');
  menu.addItem('About KQ3', 30);
  menu.addItem('Help  <F1>', 5);
  menu.addColumn(' File ');
  menu.addItem('Save  <F5>', 6);
  menu.addItem('Restore  <F7>', 8);
  menu.addItem('-------------', 29);
  menu.addItem('Restart  <F9>', 7);
  menu.addItem('-------------', 29);
  menu.addItem('Quit  <Alt-Z>', 1);
  menu.submit();
  return menu;
}

describe('the menu bar a game builds', () => {
  it('is not usable until submit.menu', () => {
    const menu = new AgiMenu();
    menu.addColumn(' File ');
    menu.addItem('Quit', 1);

    expect(menu.available).toBe(false);
    menu.show();
    expect(menu.open).toBe(false);

    menu.submit();
    expect(menu.available).toBe(true);
  });

  it('answers with the controller of the entry chosen', () => {
    const menu = kq3Menu();
    menu.show();
    // Sierra is the first column; one step right reaches File, whose first
    // entry is Save.
    menu.key(RIGHT, never);

    expect(menu.key(ENTER, never)).toBe(6);
    expect(menu.open).toBe(false);
  });

  it('walks down a column and skips the separators', () => {
    const menu = kq3Menu();
    menu.show();
    menu.key(RIGHT, never);
    // Save, Restore, then the hyphens — which must be stepped over, or a
    // player lands on an entry that fires a controller bound to nothing.
    menu.key(DOWN, never);
    menu.key(DOWN, never);

    expect(menu.key(ENTER, never)).toBe(7);
  });

  it('steps over a separator going up as well', () => {
    const menu = kq3Menu();
    menu.show();
    menu.key(RIGHT, never);
    // Up from the first entry wraps to the last — Quit — and up again has to
    // clear the separator above it to reach Restart.
    menu.key(UP, never);
    menu.key(UP, never);

    expect(menu.key(ENTER, never)).toBe(7);
  });

  it('will not fire a controller a script has disabled', () => {
    const menu = kq3Menu();
    menu.show();
    menu.key(RIGHT, never);

    // `disable.item` is asked at the moment of the choice rather than at
    // submit, because a script disables Save during a cutscene and re-enables
    // it after.
    expect(menu.key(ENTER, (controller) => controller === 6)).toBe('closed');
  });

  it('closes on Escape without firing anything', () => {
    const menu = kq3Menu();
    menu.show();

    expect(menu.key(ESCAPE, never)).toBe('closed');
    expect(menu.open).toBe(false);
  });

  it('replaces the bar when a game declares a second one', () => {
    const menu = kq3Menu();
    menu.addColumn(' Only ');
    menu.addItem('One', 2);
    menu.submit();

    expect(menu.describe()).toEqual([{ text: ' Only ', items: ['One'] }]);
  });
});

describe('a message’s format codes', () => {
  const context = {
    variable: (number: number) => ({ 115: 9, 116: 5, 117: 1, 42: 0, 3: 210 })[number] ?? 0,
    string: (number: number) => (number === 1 ? 'a %v3 point game' : ''),
    objectName: (item: number) => (item === 4 ? 'the magic map' : ''),
    word: (index: number) => (index === 0 ? 'wizard' : ''),
    message: (logic: number, number: number) =>
      logic === 0 ? `logic0 message ${number}` : `logic${logic} message ${number}`,
  };

  const format = (text: string, logic = 45): string => formatAgiMessage(text, logic, context);

  /**
   * The one that named the whole gap. King's Quest III's clock, drawn
   * literally, ran twenty-two characters across `Sound:on` beside it.
   */
  it('expands the clock King’s Quest III puts in its status line', () => {
    expect(format('%v117:%v116|2:%v115|2 ')).toBe('1:05:09 ');
  });

  it('strips a variable’s leading zeros when no width is given', () => {
    expect(format('%v3')).toBe('210');
    // And a zero keeps its last digit rather than becoming nothing.
    expect(format('%v42')).toBe('0');
  });

  it('counts a field width from the right, so it truncates rather than grows', () => {
    // 210 in a field of two is "10": Sierra formats to fifteen digits and
    // slices from `15 - width`.
    expect(format('%v3|2')).toBe('10');
    expect(format('%v3|5')).toBe('00210');
  });

  it('names an inventory item, on the digit zero rather than the letter', () => {
    expect(format('You have %05.')).toBe('You have the magic map.');
  });

  it('reaches another message in the same Logic, and Logic 0 by name', () => {
    expect(format('%m3')).toBe('logic45 message 2');
    expect(format('%g3')).toBe('logic0 message 2');
  });

  it('expands a string, and the codes inside it', () => {
    expect(format('This is %s1.')).toBe('This is a 210 point game.');
  });

  it('substitutes a word the player typed', () => {
    expect(format('You cannot talk to the %w1.')).toBe('You cannot talk to the wizard.');
  });

  it('leaves a message with no codes exactly as it was', () => {
    expect(format('You are in a hallway.')).toBe('You are in a hallway.');
  });

  it('takes a backslash as an escape, so a literal percent survives', () => {
    expect(format('50\\% of nothing')).toBe('50% of nothing');
  });

  it('drops a code it does not know along with its digits', () => {
    // Sierra's own switch has no default arm and the digit skip runs anyway,
    // so `%z12` leaves nothing behind rather than leaving `12`.
    expect(format('a%z12b')).toBe('ab');
  });

  it('stops a message that references itself rather than recursing forever', () => {
    const looping = formatAgiMessage('%m1', 1, {
      ...context,
      message: () => '%m1',
    });

    expect(looping).toBe('%m1');
  });
});
