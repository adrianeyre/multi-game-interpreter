import { describe, expect, it } from 'vitest';
import { VerbTable } from '../src/engine/verbs/Verbs.js';

describe('verb table', () => {
  it('creates verbs on demand', () => {
    const verbs = new VerbTable();
    const verb = verbs.getOrCreate(3);
    expect(verb.id).toBe(3);
    expect(verbs.get(3)).toBe(verb);
  });

  it('hit-tests only enabled verbs', () => {
    const verbs = new VerbTable();
    const verb = verbs.getOrCreate(3);
    verb.bounds = { left: 10, top: 150, right: 60, bottom: 158 };

    expect(verbs.hitTest(20, 152)).toBe(0); // disabled
    verb.enabled = true;
    expect(verbs.hitTest(20, 152)).toBe(3);
    expect(verbs.hitTest(200, 152)).toBe(0);
  });

  it('never reports verb 0, which is the sentence line', () => {
    const verbs = new VerbTable();
    const verb = verbs.getOrCreate(0);
    verb.enabled = true;
    verb.bounds = { left: 0, top: 0, right: 320, bottom: 200 };
    expect(verbs.hitTest(10, 10)).toBe(0);
  });

  it('finds a verb by its keyboard shortcut', () => {
    const verbs = new VerbTable();
    const verb = verbs.getOrCreate(4);
    verb.key = 'o'.charCodeAt(0);
    verb.enabled = true;
    expect(verbs.findByKey('o'.charCodeAt(0))).toBe(4);
    expect(verbs.findByKey('z'.charCodeAt(0))).toBe(0);
  });

  it('saves and restores a range of verbs', () => {
    const verbs = new VerbTable();
    for (const id of [1, 2, 3]) {
      const verb = verbs.getOrCreate(id);
      verb.enabled = true;
    }

    verbs.saveRange(1, 3, 7);
    expect(verbs.all.every((verb) => !verb.enabled)).toBe(true);

    verbs.restoreRange(1, 3, 7);
    expect(verbs.all.every((verb) => verb.enabled)).toBe(true);
  });

  it('deletes a saved range permanently', () => {
    const verbs = new VerbTable();
    verbs.getOrCreate(1).enabled = true;
    verbs.saveRange(1, 1, 7);
    verbs.deleteRange(1, 1, 7);
    expect(verbs.get(1)).toBeUndefined();
  });
});
