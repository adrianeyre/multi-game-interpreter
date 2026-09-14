/**
 * Script arrays: the storage v6 added and v5 never had.
 *
 * v5 gave scripts 800 numbered globals and an indexed read that treated a run
 * of them as a pseudo-array. v6 replaced that with real arrays — declared, two
 * dimensional, addressed by their own instructions — which is why the v6
 * engine's `readVar` has no indexed form at all.
 *
 * **This lives out here, next to `ScriptState`, rather than inside the v6
 * decoder.** It is state, not decoding: a save has to put it back, and ADR
 * 0001 puts everything a save touches where the engine can reach it. Keeping
 * it inside the interpreter is what made an array survive a room change and
 * not a reload.
 *
 * Two facts from the format shape the whole class:
 *
 * - **A declared array's variable holds a handle, not a value.** Scripts test
 *   `if (var == 0)` to ask "has this been dimensioned yet?", and `arrayOps`
 *   and `pickVarRandom` both branch on it, so defining an array has to write
 *   something non-zero into the variable and undimensioning has to write zero.
 * - **Only string arrays keep their declared width.** v6 promotes bit, nibble
 *   and byte arrays to integer arrays on definition (`defineArray` in
 *   `script_v6.cpp`), so nothing here masks a bit array's writes to 0 and 1 —
 *   the original does not either, and a script that stores 2 in one reads 2
 *   back.
 */

/**
 * How an array stores its elements.
 *
 * Two kinds rather than the format's five, for the reason above: an integer
 * array holds numbers, a string array holds characters.
 */
export type ScriptArrayKind = 'int' | 'string';

/** The array types a v6 `dimArray` can ask for, by their sub-opcode meaning. */
export type DeclaredArrayKind = 'int' | 'bit' | 'nibble' | 'byte' | 'string';

export interface ScriptArray {
  /**
   * Row length, as a count — one greater than the declared bound, which is how
   * the format writes its own dimensions.
   */
  dim1: number;
  dim2: number;
  kind: ScriptArrayKind;
  data: Int32Array;
  /**
   * The number this array's variable holds.
   *
   * Some instructions are handed the handle rather than the variable —
   * `verbOps`'s "name from string" form takes whatever the script pushed,
   * which is the variable's *value* — so the mapping has to work both ways.
   */
  handle: number;
}

/** An array in a save: plain JSON, like everything else in one. */
export interface SavedScriptArray {
  variable: number;
  dim1: number;
  dim2: number;
  kind: ScriptArrayKind;
  data: number[];
  handle: number;
}

/**
 * The handle written into an array's variable.
 *
 * Any non-zero number would do — scripts only ever compare it against zero —
 * but the original writes a small resource id, and a script that prints the
 * variable for debugging should see something of that shape rather than a
 * pointer-sized number.
 */
const FIRST_HANDLE = 1;

export class ScriptArrayTable {
  private readonly arrays = new Map<number, ScriptArray>();

  /** Handle -> variable, for the instructions handed a handle. */
  private readonly variablesByHandle = new Map<number, number>();

  /** Handles are unique per array so a script can tell two of them apart. */
  private nextHandle = FIRST_HANDLE;

  /**
   * Writes the array's handle to its variable, and zero when it is nuked.
   *
   * Supplied by the owner rather than reached for, because the variable spaces
   * belong to the script engine: a v6 array variable can be a global or a
   * script local, and only the engine knows which.
   */
  private writeHandle: (variable: number, handle: number) => void = () => {};

  /** Called once by the engine that owns the variable spaces. */
  bindVariables(writeHandle: (variable: number, handle: number) => void): void {
    this.writeHandle = writeHandle;
  }

  get size(): number {
    return this.arrays.size;
  }

  has(variable: number): boolean {
    return this.arrays.has(variable);
  }

  get(variable: number): ScriptArray | undefined {
    return this.arrays.get(variable);
  }

  /**
   * Creates an array, replacing any array that variable already held.
   *
   * `dim1` and `dim2` arrive as the script wrote them — bounds, not counts —
   * and are stored one greater, because an array declared `[0..9]` holds ten
   * elements and every read is bounds-checked against the stored figure.
   */
  define(variable: number, kind: DeclaredArrayKind, dim2: number, dim1: number): ScriptArray {
    const width = Math.max(dim1 + 1, 1);
    const height = Math.max(dim2 + 1, 1);
    const handle = this.nextHandle++;
    const array: ScriptArray = {
      dim1: width,
      dim2: height,
      kind: kind === 'string' ? 'string' : 'int',
      data: new Int32Array(width * height),
      handle,
    };
    this.undefine(variable);
    this.arrays.set(variable, array);
    this.variablesByHandle.set(handle, variable);
    this.writeHandle(variable, handle);
    return array;
  }

  /** Drops an array and clears its variable, so a script can re-dimension it. */
  undefine(variable: number): void {
    const existing = this.arrays.get(variable);
    if (existing) this.variablesByHandle.delete(existing.handle);
    this.arrays.delete(variable);
    this.writeHandle(variable, 0);
  }

  /** The variable an array handle belongs to, or undefined. */
  variableForHandle(handle: number): number | undefined {
    return this.variablesByHandle.get(handle);
  }

  /** Reads a string array addressed by the handle a script pushed. */
  readStringByHandle(handle: number, from = 0): string {
    const variable = this.variablesByHandle.get(handle);
    return variable === undefined ? '' : this.readString(variable, from);
  }

  /**
   * Reads one element, or zero from an array that was never dimensioned.
   *
   * The original treats both a missing array and an out-of-range index as
   * fatal. Here they yield zero, because a script that reads past its own
   * bounds is a script bug — the original has several — and killing the game
   * over one loses far more than reading a zero does.
   */
  read(variable: number, index: number, row = 0): number {
    const array = this.arrays.get(variable);
    if (!array) return 0;
    const at = row * array.dim1 + index;
    return at >= 0 && at < array.data.length ? array.data[at] : 0;
  }

  write(variable: number, index: number, value: number, row = 0): void {
    const array = this.arrays.get(variable);
    if (!array) return;
    const at = row * array.dim1 + index;
    if (at >= 0 && at < array.data.length) array.data[at] = value | 0;
  }

  /**
   * Reads a string array back as text, stopping at its terminator.
   *
   * v6 has no string table separate from its arrays: `arrayOps`'s "assign
   * string" form writes the characters of an inline string into an array, and
   * `verbOps`'s "name from string" form reads them back out.
   */
  readString(variable: number, from = 0): string {
    const array = this.arrays.get(variable);
    if (!array) return '';
    let text = '';
    for (let at = from; at < array.data.length; at++) {
      const code = array.data[at] & 0xff;
      if (code === 0) break;
      text += String.fromCharCode(code);
    }
    return text;
  }

  /** Writes text plus its terminator into a string array at `at`. */
  writeString(variable: number, at: number, text: string): void {
    for (let i = 0; i < text.length; i++) {
      this.write(variable, at + i, text.charCodeAt(i) & 0xff);
    }
    this.write(variable, at + text.length, 0);
  }

  /**
   * Shuffles a range in place, as `shuffle` and `pickVarRandom` need.
   *
   * Two random indices swapped `2 * range` times, which is what the original
   * does. It is not a uniform shuffle and is not meant to be replaced by one:
   * `pickVarRandom` leans on the resulting distribution to keep Sam & Max from
   * repeating a line twice in a row, and a "better" shuffle changes how often
   * that happens.
   */
  shuffle(variable: number, from: number, to: number, random: (max: number) => number): void {
    const range = to - from;
    if (range <= 0) return;

    for (let count = range * 2; count > 0; count--) {
      const a = from + random(range + 1);
      const b = from + random(range + 1);
      const valueA = this.read(variable, a);
      const valueB = this.read(variable, b);
      this.write(variable, a, valueB);
      this.write(variable, b, valueA);
    }
  }

  clear(): void {
    this.arrays.clear();
    this.variablesByHandle.clear();
    this.nextHandle = FIRST_HANDLE;
  }

  capture(): SavedScriptArray[] {
    return [...this.arrays.entries()].map(([variable, array]) => ({
      variable,
      dim1: array.dim1,
      dim2: array.dim2,
      kind: array.kind,
      data: Array.from(array.data),
      handle: array.handle,
    }));
  }

  /**
   * Puts saved arrays back without touching the variables.
   *
   * The handles are already in the restored variables — they were saved with
   * every other global — so re-writing them here would only risk disagreeing
   * with what the scripts hold.
   */
  restore(saved: SavedScriptArray[]): void {
    this.clear();
    let highest = FIRST_HANDLE;
    for (const entry of saved) {
      const handle = entry.handle ?? FIRST_HANDLE + this.arrays.size;
      this.arrays.set(entry.variable, {
        dim1: entry.dim1,
        dim2: entry.dim2,
        kind: entry.kind,
        data: Int32Array.from(entry.data),
        handle,
      });
      this.variablesByHandle.set(handle, entry.variable);
      highest = Math.max(highest, handle);
    }
    this.nextHandle = highest + 1;
  }
}
