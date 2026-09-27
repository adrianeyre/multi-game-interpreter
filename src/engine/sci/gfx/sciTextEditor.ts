/**
 * SCI32's one-line text editor, as `InputText` runs it.
 *
 * `GfxControls32::processEditTextEvent` (`engines/sci/graphics/
 * controls32.cpp`, fetched 2026-09-27), which ScummVM's `kInputText` loops
 * over until Enter or ESC. What the editor *does* with a key is the part a
 * player can see — which keys move the cursor, which delete, that the first
 * printable key replaces the whole default text and a cursor key first
 * cancels that, and that nothing is typed past the length limit or the edge
 * of the box — so it is kept here as one pure step, and `InputText` is a loop
 * over it.
 */

/** The keys the editor reads, from `event.h`. */
const KEY = {
  backspace: 8,
  etx: 3,
  left: 75 << 8,
  right: 77 << 8,
  home: 71 << 8,
  end: 79 << 8,
  insert: 82 << 8,
  delete: 83 << 8,
} as const;

export interface SciTextEditorState {
  text: string;
  cursor: number;
  maxLength: number;
  /** True until the first key that is not a printable one, as `clearTextOnInput`. */
  clearOnInput: boolean;
  /** Insert or overwrite, which the Insert key toggles. */
  overwrite: boolean;
  /** How many pixels the text box is wide, and how wide a string is in its font. */
  boxWidth: number;
  measure: (text: string) => number;
}

/** One key into the editor, answering whether the text changed. */
export function sciTextEditorKey(state: SciTextEditorState, key: number): boolean {
  let deleteChar = false;
  let changed = false;
  switch (key) {
    case KEY.left:
      state.clearOnInput = false;
      if (state.cursor > 0) state.cursor--;
      break;
    case KEY.right:
      state.clearOnInput = false;
      if (state.cursor < state.text.length) state.cursor++;
      break;
    case KEY.home:
      state.clearOnInput = false;
      state.cursor = 0;
      break;
    case KEY.end:
      state.clearOnInput = false;
      state.cursor = state.text.length;
      break;
    case KEY.insert:
      state.clearOnInput = false;
      state.overwrite = !state.overwrite;
      break;
    case KEY.delete:
      state.clearOnInput = false;
      if (state.cursor < state.text.length) deleteChar = true;
      break;
    case KEY.backspace:
      state.clearOnInput = false;
      deleteChar = true;
      if (state.cursor > 0) state.cursor--;
      break;
    case KEY.etx:
      state.text = '';
      state.cursor = 0;
      changed = true;
      break;
    default:
      if (key >= 20 && key < 257) {
        if (state.clearOnInput) {
          state.clearOnInput = false;
          state.text = '';
          // Only a printable key can arrive here with the flag still set, and
          // nothing before it moved the cursor off nought, where it starts.
          state.cursor = 0;
        }
        const character = String.fromCharCode(key);
        const fits =
          (state.overwrite && state.cursor < state.maxLength) ||
          (state.text.length < state.maxLength &&
            state.measure(character) + state.measure(state.text) < state.boxWidth);
        if (fits) {
          state.text =
            state.overwrite && state.cursor < state.text.length
              ? state.text.slice(0, state.cursor) + character + state.text.slice(state.cursor + 1)
              : state.text.slice(0, state.cursor) + character + state.text.slice(state.cursor);
          state.cursor++;
          changed = true;
        }
      }
  }
  if (deleteChar) {
    if (state.cursor < state.text.length) {
      state.text = state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1);
    }
    changed = true;
  }
  return changed;
}
