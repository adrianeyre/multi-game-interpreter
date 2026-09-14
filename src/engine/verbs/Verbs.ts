/**
 * The verb interface — the row of words at the bottom of the screen plus the
 * inventory slots.
 *
 * Verbs are entirely script-driven: the game's boot script creates them, sets
 * their text, position and colours, and the engine just draws them and reports
 * clicks. Verb 0 is special and means "the sentence line".
 */
export interface Verb {
  id: number;
  x: number;
  y: number;
  text: string;
  /** Object id when the verb draws an image (inventory arrows) instead of text. */
  image: number;
  imageRoom: number;
  type: 'text' | 'image';
  color: number;
  hiColor: number;
  dimColor: number;
  bakColor: number;
  /** Keyboard shortcut, as an ASCII code. */
  key: number;
  /**
   * The charset this verb's word is drawn in, fixed when the verb was made.
   *
   * `VerbSlot::charset_nr`, and a per-verb field rather than one current
   * charset because the original is one: a verb takes the default charset at
   * the moment the script creates it (`vs->charset_nr =
   * _string[0]._default.charset`) and keeps it for life, whatever the game
   * switches to afterwards. Day of the Tentacle switches three times while its
   * boot script runs, so a panel drawn in whichever charset happened to be
   * current last came out as `L°k at` and `Pu¸` — the right glyph indices read
   * out of the wrong font.
   */
  charsetId: number;
  center: boolean;
  enabled: boolean;
  dim: boolean;
  /** Non-zero while stashed by `saveRestoreVerbs`. */
  saveId: number;
  /** Whether it was on when `saveRange` stashed it, so restoring is faithful. */
  savedEnabled: boolean;
  /** Screen rectangle occupied by the last drawn text, for hit testing. */
  bounds: { left: number; top: number; right: number; bottom: number };
}

function createVerb(id: number): Verb {
  return {
    id,
    x: 0,
    y: 0,
    text: '',
    image: 0,
    imageRoom: 0,
    type: 'text',
    color: 2,
    hiColor: 0,
    dimColor: 8,
    bakColor: 0,
    key: 0,
    // One rather than zero, which is `resetVerbs`' own starting value. A verb a
    // game never gives a charset to is still drawn, and charset 0 is not a
    // font every game ships.
    charsetId: 1,
    center: false,
    enabled: false,
    dim: false,
    saveId: 0,
    savedEnabled: false,
    bounds: { left: 0, top: 0, right: 0, bottom: 0 },
  };
}

export class VerbTable {
  private readonly verbs = new Map<number, Verb>();
  private dirty = true;

  get all(): Verb[] {
    return [...this.verbs.values()];
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  clearDirty(): void {
    this.dirty = false;
  }

  markDirty(_id?: number): void {
    this.dirty = true;
  }

  get(id: number): Verb | undefined {
    return this.verbs.get(id);
  }

  getOrCreate(id: number): Verb {
    let verb = this.verbs.get(id);
    if (!verb) {
      verb = createVerb(id);
      this.verbs.set(id, verb);
    }
    return verb;
  }

  /**
   * Resets a verb to its default state, creating it if needed.
   *
   * Resetting in place rather than replacing the object matters: `verbOps`
   * takes a reference to the verb before running its sub-opcodes, and the
   * "new verb" sub-opcode appears in the middle of that stream. Swapping the
   * object out would leave the caller writing to an orphan.
   *
   * `charsetId` is the game's current default charset, which the reference
   * reads straight off `_string[0]._default` here. Left out, the verb keeps
   * the starting charset rather than guessing.
   */
  create(id: number, charsetId?: number): Verb {
    const existing = this.verbs.get(id);
    const fresh = createVerb(id);
    // The charset the game had current when it asked for the verb, which is
    // the one the verb keeps. See {@link Verb.charsetId}.
    if (charsetId !== undefined) fresh.charsetId = charsetId;
    this.dirty = true;

    if (!existing) {
      this.verbs.set(id, fresh);
      return fresh;
    }
    Object.assign(existing, fresh);
    return existing;
  }

  remove(id: number): void {
    this.verbs.delete(id);
    this.dirty = true;
  }

  reset(): void {
    this.verbs.clear();
    this.dirty = true;
  }

  /**
   * The verb under a screen point, or 0. Disabled verbs are not clickable.
   *
   * Searched newest first, because the original walks its slots from the last
   * one down (`findVerbAtPos`) and a game relies on that: Atlantis draws the
   * frame around its verb panel as an image verb created before any of the
   * words, covering the whole strip. Found first, it answers for every click
   * in the panel and nothing else in there can ever be pressed.
   */
  hitTest(x: number, y: number): number {
    const all = [...this.verbs.values()];
    for (let i = all.length - 1; i >= 0; i--) {
      const verb = all[i];
      if (!verb.enabled || verb.id === 0) continue;
      const { left, top, right, bottom } = verb.bounds;
      if (x >= left && x < right && y >= top && y < bottom) return verb.id;
    }
    return 0;
  }

  findByKey(key: number): number {
    for (const verb of this.verbs.values()) {
      if (verb.enabled && verb.key === key) return verb.id;
    }
    return 0;
  }

  /**
   * Stashes a range of verbs so a dialogue can reuse the panel.
   *
   * The original moves verbs into a "save area" identified by `saveId`;
   * restoring pulls them back. Games use this for conversation trees, which
   * temporarily replace the verb row with dialogue choices.
   */
  saveRange(from: number, to: number, saveId: number): void {
    for (let id = from; id <= to; id++) {
      const verb = this.verbs.get(id);
      if (verb && verb.saveId === 0) {
        verb.saveId = saveId;
        // What it was showing has to come back the same way. The original
        // keeps a second slot per saved verb and never touches the first one's
        // mode, so a verb that was off is off again afterwards. Restoring
        // everything as *on* switched on whatever a game had deliberately left
        // hidden: Atlantis keeps three unused slots in the right of its verb
        // panel, and they came back showing raw variables — "None", "2",
        // "-14568" — beside the inventory.
        verb.savedEnabled = verb.enabled;
        verb.enabled = false;
      }
    }
    this.dirty = true;
  }

  restoreRange(from: number, to: number, saveId: number): void {
    for (const verb of this.verbs.values()) {
      if (verb.saveId === saveId && verb.id >= from && verb.id <= to) {
        verb.saveId = 0;
        verb.enabled = verb.savedEnabled;
      }
    }
    this.dirty = true;
  }

  deleteRange(from: number, to: number, saveId: number): void {
    for (const [id, verb] of [...this.verbs]) {
      if (verb.saveId === saveId && id >= from && id <= to) this.verbs.delete(id);
    }
    this.dirty = true;
  }
}
