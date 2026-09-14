import { describe, expect, it } from 'vitest';
import {
  compactIn,
  CPT,
  readCompactSection,
  SwordCompactError,
  SWORD1_COMPACT_SIZE,
  SWORD1_COMPACT_WORDS,
} from '../src/engine/sword1/resource/swordCompact.js';
import {
  readSwordTextResource,
  writeSwordTextResource,
} from '../src/engine/sword1/resource/swordTextResources.js';
import { SwordEvents } from '../src/engine/sword1/script/SwordEvents.js';
import { SwordLogicMode, SWORD1_HEADER_SIZE } from '../src/engine/sword1/resource/swordDefs.js';
import {
  SWORD1_SCRIPT_VAR_INIT,
  sword1ScriptVarName,
} from '../src/engine/sword1/script/scriptVars.js';
import {
  SWORD1_SECTION_COMPACTS,
  SWORD1_SECTIONS,
} from '../src/engine/sword1/resource/swordSections.js';
import { SWORD1_ROOMS } from '../src/engine/sword1/resource/swordRooms.js';
import { SV } from '../src/engine/sword1/script/swordVarIndex.js';
import { buildCompactResource, buildTextResource } from './fixtureSword.js';

describe('the compact record', () => {
  it('is 12,340 bytes, which is what o_route’s 600 nodes fix it at', () => {
    expect(SWORD1_COMPACT_SIZE).toBe(12340);
    expect(SWORD1_COMPACT_WORDS).toBe(3085);
  });

  it('lays its fields where the shipped bytecode addresses them', () => {
    // These are compiled into every script, so they are the format.
    expect(CPT.TYPE).toBe(0);
    expect(CPT.XCOORD).toBe(44);
    expect(CPT.TREE).toBe(108);
    expect(CPT.BOOKMARK).toBe(152);
    expect(CPT.EVENT_LIST).toBe(280);
    expect(CPT.ROUTE).toBe(340);
  });

  it('reads a section through its one-based offset table', () => {
    const words = new Array(SWORD1_COMPACT_WORDS).fill(0);
    words[CPT.XCOORD >> 2] = 321;
    const resource = buildCompactResource([words, words]);
    const section = readCompactSection(resource, 12);
    expect(section.count).toBe(2);
    const compact = compactIn(section, 1);
    expect(compact?.x).toBe(321);
    expect(compact?.id).toBe(12 * 0x10000 + 1);
  });

  it('hands back a window, not a copy, so an mcode and a script see one word', () => {
    const words = new Array(SWORD1_COMPACT_WORDS).fill(0);
    const section = readCompactSection(buildCompactResource([words]), 1);
    const first = compactIn(section, 0);
    const second = compactIn(section, 0);
    first!.y = 99;
    expect(second!.y).toBe(99);
  });

  it('copies a tree to the bookmark and back, eleven words at a time', () => {
    const words = new Array(SWORD1_COMPACT_WORDS).fill(0);
    const section = readCompactSection(buildCompactResource([words]), 1);
    const compact = compactIn(section, 0)!;
    compact.scriptLevel = 2;
    compact.setScriptId(2, 4242);
    compact.copyTree(CPT.TREE, CPT.BOOKMARK);
    compact.scriptLevel = 0;
    compact.setScriptId(2, 0);
    compact.copyTree(CPT.BOOKMARK, CPT.TREE);
    expect(compact.scriptLevel).toBe(2);
    expect(compact.scriptId(2)).toBe(4242);
  });

  it('refuses a resource whose payload is not whole words', () => {
    const bad = new Uint8Array(SWORD1_HEADER_SIZE + 6);
    expect(() => readCompactSection(bad, 3)).toThrow(SwordCompactError);
  });

  it('refuses a count that does not fit the words it has', () => {
    const resource = buildCompactResource([[1, 2, 3]]);
    // Claim eight objects where one was written.
    new DataView(resource.buffer).setUint32(SWORD1_HEADER_SIZE, 8, true);
    expect(() => readCompactSection(resource, 3)).toThrow(/does not fit/);
  });

  it('tolerates a short final compact, which a text compact is', () => {
    const section = readCompactSection(buildCompactResource([[1, 2, 3, 4]]), 149);
    const compact = compactIn(section, 0);
    expect(compact).not.toBeNull();
    expect(compact!.type).toBe(1);
  });
});

describe('text resources', () => {
  it('reads a line table with holes without shifting the lines after them', () => {
    const resource = buildTextResource(['first', '', 'third']);
    const lines = readSwordTextResource(resource.subarray(SWORD1_HEADER_SIZE));
    expect(lines).toEqual(['first', '', 'third']);
  });

  it('round-trips: a resource read and written back is the same bytes', () => {
    const lines = ['George', '', 'Nico', 'a longer line with spaces'];
    const original = buildTextResource(lines).subarray(SWORD1_HEADER_SIZE);
    const rebuilt = writeSwordTextResource(readSwordTextResource(original));
    expect(Array.from(rebuilt)).toEqual(Array.from(original));
  });

  it('answers nothing for a resource that is not a text table', () => {
    expect(readSwordTextResource(new Uint8Array([1, 2]))).toEqual([]);
  });

  it('round-trips the bytes above 0x7F that the game actually ships', () => {
    // `TextDecoder('latin1')` is a WHATWG label for windows-1252, so 0x83 comes
    // back as U+0192 and 0x85 as U+2026 — both above 0xFF. A writer that
    // assumed "the byte is the code point" wrote '?' for each of them, and the
    // demo's TEXT.CLU came back from an edit-free round trip differing in 488
    // bytes across 28 resources.
    const high = String.fromCharCode(...Array.from({ length: 128 }, (_, at) => at + 128));
    const decoded = new TextDecoder('latin1').decode(
      Uint8Array.from({ length: 128 }, (_, at) => at + 128),
    );
    const original = buildTextResource([decoded, 'plain']).subarray(SWORD1_HEADER_SIZE);
    const rebuilt = writeSwordTextResource(readSwordTextResource(original));
    expect(Array.from(rebuilt)).toEqual(Array.from(original));
    // And it is a real re-map rather than an identity: the decoded string is
    // not the high bytes themselves.
    expect(decoded).not.toEqual(high);
  });
});

describe('the event system', () => {
  it('counts a pending event down and expires it', () => {
    const events = new SwordEvents();
    events.fnIssueEvent(7, 2);
    expect(events.eventValid(7)).toBe(true);
    events.serviceGlobalEventList();
    events.serviceGlobalEventList();
    expect(events.eventValid(7)).toBe(false);
  });

  it('is consumed by the first object that matches, not by every subscriber', () => {
    const events = new SwordEvents();
    events.fnIssueEvent(7, 5);
    const words = new Array(SWORD1_COMPACT_WORDS).fill(0);
    const section = readCompactSection(buildCompactResource([words, words]), 1);
    const first = compactIn(section, 0)!;
    const second = compactIn(section, 1)!;
    for (const compact of [first, second]) {
      compact.set(CPT.EVENT_LIST, 7);
      compact.set(CPT.EVENT_LIST + 4, 0x123);
    }
    expect(events.checkForEvent(first)).toBe(true);
    expect(events.checkForEvent(second)).toBe(false);
    // The one that matched was pushed into script mode at a new level.
    expect(first.logic).toBe(SwordLogicMode.SCRIPT);
    expect(first.scriptLevel).toBe(1);
    expect(first.scriptId(1)).toBe(0x123);
  });

  it('round-trips its pending list through a save', () => {
    const events = new SwordEvents();
    events.fnIssueEvent(3, 4);
    const snapshot = events.snapshot();
    const restored = new SwordEvents();
    restored.restore(snapshot);
    expect(restored.eventValid(3)).toBe(true);
  });

  it('refuses a save with the wrong number of event words', () => {
    expect(() => new SwordEvents().restore([1, 2])).toThrow(/refused rather than half-applied/);
  });
});

describe('the generated tables', () => {
  it('name every section and every screen the game declares', () => {
    expect(SWORD1_SECTIONS).toBe(150);
    expect(SWORD1_SECTION_COMPACTS).toHaveLength(150);
    expect(SWORD1_ROOMS).toHaveLength(100);
  });

  it('give the player’s section and the text section real compacts', () => {
    // 128 is George's mega section and 149 is where the text compacts live;
    // both must be addressable or the game has no player and no subtitles.
    expect(SWORD1_SECTION_COMPACTS[128]).not.toBe(0);
    expect(SWORD1_SECTION_COMPACTS[149]).not.toBe(0);
  });

  it('describe a screen’s grid in blocks wider than its pixels imply', () => {
    // The grid is indexed against a screen 128 pixels wider on each side, so
    // `gridWidth` is not `sizeX / 16`. Screen 1 is 784 wide: 49 visible blocks
    // and 65 with the off-screen edges.
    const screen1 = SWORD1_ROOMS[1];
    expect(screen1.sizeX).toBe(784);
    expect(screen1.gridWidth).toBe(65);
    expect(screen1.gridWidth).toBeGreaterThan(screen1.sizeX / 16);
  });

  it('name the globals the engine reads, at the indexes the scripts use', () => {
    expect(sword1ScriptVarName(SV.SCREEN)).toBe('SCREEN');
    expect(sword1ScriptVarName(SV.POCKET_1)).toBe('POCKET_1');
    expect(sword1ScriptVarName(99999)).toBe('var99999');
  });

  it('start the world with the globals a new game needs', () => {
    expect(SWORD1_SCRIPT_VAR_INIT.length).toBeGreaterThan(50);
    // Every entry is a real variable index with a non-zero value: a zero here
    // would be an entry that does nothing.
    for (const [variable, value] of SWORD1_SCRIPT_VAR_INIT) {
      expect(variable).toBeGreaterThanOrEqual(0);
      expect(value).not.toBe(0);
    }
  });
});
