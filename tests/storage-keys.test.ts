import { describe, expect, it } from 'vitest';

import {
  legacyKey,
  migrateLegacyStorage,
  STORAGE_KEYS,
  type KeyValueStore,
} from '../src/ui/storageKeys.js';

/**
 * Renaming the keys this project writes.
 *
 * They said `scumm-web:` because that is what the project was called. It runs
 * two engine families now and is called MGI — but an author's autosaved project
 * is under the old name in their browser, and a rename that simply started
 * writing a new key would look exactly like the editor having lost their work.
 *
 * So the old names are read once and moved across. What is tested here is that
 * the move happens, that it never overwrites something newer, and that it is
 * safe to run on every page load for as long as the code lives.
 */

/** A `localStorage` that cannot fail, so the interesting cases are the logic. */
function store(initial: Record<string, string> = {}): KeyValueStore & {
  contents: Record<string, string>;
} {
  const contents = { ...initial };
  return {
    contents,
    getItem: (key) => contents[key] ?? null,
    setItem: (key, value) => {
      contents[key] = value;
    },
    removeItem: (key) => {
      delete contents[key];
    },
  };
}

describe('the old names', () => {
  it('are the new ones with the old prefix', () => {
    expect(legacyKey(STORAGE_KEYS.project)).toBe('scumm-web:project');
    expect(legacyKey(STORAGE_KEYS.projectBackup)).toBe('scumm-web:project:previous');
    expect(legacyKey(STORAGE_KEYS.editorSections)).toBe('scumm-web:editor:sections');
    expect(legacyKey(STORAGE_KEYS.consent)).toBe('scumm-web:cookie-consent');
  });

  it('leaves a key that never had the prefix alone', () => {
    expect(legacyKey('scumm.save.atlantis.1')).toBe('scumm.save.atlantis.1');
  });
});

describe('moving what is already there', () => {
  it('carries an autosaved project across and drops the old key', () => {
    const local = store({ 'scumm-web:project': '{"name":"mine"}' });

    migrateLegacyStorage(local);

    expect(local.contents[STORAGE_KEYS.project]).toBe('{"name":"mine"}');
    expect(local.contents['scumm-web:project']).toBeUndefined();
  });

  it('moves every key it knows about, in one pass', () => {
    const local = store({
      'scumm-web:project': 'a',
      'scumm-web:project:previous': 'b',
      'scumm-web:project:meta': 'c',
      'scumm-web:editor:sections': 'd',
      'scumm-web:cookie-consent': 'acknowledged',
    });

    migrateLegacyStorage(local);

    expect(local.contents).toEqual({
      [STORAGE_KEYS.project]: 'a',
      [STORAGE_KEYS.projectBackup]: 'b',
      [STORAGE_KEYS.projectMeta]: 'c',
      [STORAGE_KEYS.editorSections]: 'd',
      [STORAGE_KEYS.consent]: 'acknowledged',
    });
  });

  /**
   * The new key was written by a later build than the one that wrote the old,
   * so restoring the old over it would put an author back to before the
   * rename — which is the shape of losing work, not of keeping it.
   */
  it('keeps the newer value when both names hold something', () => {
    const local = store({
      'scumm-web:project': 'older',
      [STORAGE_KEYS.project]: 'newer',
    });

    migrateLegacyStorage(local);

    expect(local.contents[STORAGE_KEYS.project]).toBe('newer');
    expect(local.contents['scumm-web:project']).toBeUndefined();
  });

  it('does nothing at all when there is nothing under the old names', () => {
    const local = store({ [STORAGE_KEYS.project]: 'mine', unrelated: 'kept' });

    migrateLegacyStorage(local);

    expect(local.contents).toEqual({ [STORAGE_KEYS.project]: 'mine', unrelated: 'kept' });
  });

  it('is safe to run again, which is what happens on every page load', () => {
    const local = store({ 'scumm-web:project': 'a' });

    migrateLegacyStorage(local);
    migrateLegacyStorage(local);

    expect(local.contents).toEqual({ [STORAGE_KEYS.project]: 'a' });
  });

  /**
   * Reading `localStorage` throws outright in a private window and with site
   * data blocked. A page that will not load because it could not tidy its own
   * key names would be a poor trade.
   */
  it('survives a store that throws, leaving the old key where it is', () => {
    const angry: KeyValueStore = {
      getItem: () => {
        throw new Error('site data is blocked');
      },
      setItem: () => {
        throw new Error('site data is blocked');
      },
      removeItem: () => {
        throw new Error('site data is blocked');
      },
    };

    expect(() => migrateLegacyStorage(angry)).not.toThrow();
  });

  it('does nothing when there is no store to migrate', () => {
    expect(() => migrateLegacyStorage(null)).not.toThrow();
  });
});
