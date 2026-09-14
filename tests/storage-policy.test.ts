// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from 'vitest';

import { mountConsent } from '../src/ui/consent.js';
import { STORAGE_KEYS } from '../src/ui/storageKeys.js';

/**
 * What the site says it keeps in your browser.
 *
 * The table in the storage notice is the site's own claim, and saved games are
 * now ten slots and a title record per game rather than one hidden slot. A
 * policy that lists six of the seven things in your browser is a policy that is
 * wrong, so what it names is asserted rather than left to be noticed.
 */
beforeEach(() => {
  document.body.replaceChildren();
  mountConsent();
});

const policy = (): string =>
  document.querySelector<HTMLElement>('#consent-overlay')!.textContent ?? '';

describe('the storage policy', () => {
  /**
   * The table is the site's own claim about what it writes, and this change
   * adds a key. A policy that lists six of the seven things in your browser is
   * a policy that is wrong.
   */
  it('names both of the keys a saved game uses', () => {
    expect(policy()).toContain('scumm.save.<game>.<slot>');
    expect(policy()).toContain('scumm.save.<game>.meta');
  });

  it('says the title record holds no part of the game itself', () => {
    expect(policy()).toMatch(/no part of the game itself/);
  });

  /**
   * Saves live nowhere else: not a file, not a server. Someone about to clear
   * site data is entitled to know that before they do it, not after.
   */
  it('warns that clearing the site’s data deletes every saved game', () => {
    expect(policy()).toMatch(/every\s+saved game in every slot/);
    expect(policy()).toMatch(/they are not files, and there is no copy on a server/);
  });

  it('mentions saved games in the banner, not only the editor', () => {
    const banner = document.querySelector<HTMLElement>('#consent-banner')!;
    expect(banner.textContent).toMatch(/saved games/i);
  });

  /**
   * Every key in `STORAGE_KEYS`, not a hand-kept subset.
   *
   * Each engine family's sidebar remembers its own open sections under its own
   * key, so adding a family adds a key — and the way this notice goes wrong is
   * not by being edited wrongly but by not being edited at all. Asserting the
   * declaration list rather than a list written out here is what makes that
   * impossible to forget.
   */
  it('names every key the project declares it writes', () => {
    const text = policy();
    for (const key of Object.values(STORAGE_KEYS)) expect(text).toContain(key);
  });
});
