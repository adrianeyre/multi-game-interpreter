/**
 * The files a SCI game opens by name, held in memory for one session.
 *
 * SCI0 has four file calls — `FOpen`, `FPuts`, `FGets`, `FClose` — and SCI1
 * folded them into `FileIO`'s twenty sub-functions. What games do with them is
 * narrow and says what an implementation has to get right: Quest for Glory
 * exports a character for its sequel to import, Codename ICEMAN prints a
 * transcript, and every SCI32 game keeps its own catalogue of saved games in
 * one — King's Quest VII reads `kq7cdsg.cat` before it will start a new game.
 *
 * **There is no disc here, and this says what that costs rather than pretending
 * either way.** The bytes live in a map and do not outlive the tab, so a game
 * writes a character, reads it back in the same session, and finds it gone on
 * the next visit. That is a smaller lie than the alternative: answering nought
 * to every open would send a game down its "no disc" path at the moment it is
 * about to write something it wants a minute later, and the round trip within
 * one session is what the scripts actually exercise.
 *
 * **Bytes rather than lines.** This held an array of strings per file while
 * only SCI0's four calls reached it, and `FGets` is the only reader those four
 * have. `FileIO` has seven more — a raw read, a raw write, a seek, a byte and a
 * word each way — and none of them can be expressed over a list of lines: a
 * seek to byte 42 has no meaning there, and a game that writes two bytes and
 * reads back a word gets neither. So a file is a byte array with a cursor per
 * open handle, and the line reader is written over that rather than the other
 * way round.
 *
 * Persisting it belongs to the host and not to the interpreter, which is why
 * `SciFileSurface` is an interface and this is one implementation of it. A host
 * with somewhere to put bytes supplies its own and nothing in the Kernel
 * changes.
 *
 * Transcribed against `engines/sci/engine/kfile.cpp` and
 * `engines/sci/engine/file.cpp` (fetched 2026-09-13).
 */

import { SCI_FILE_MODE, type SciFileSurface } from './SciKernel.js';

/** Where one open handle has got to. Reads and writes share the cursor. */
interface OpenFile {
  name: string;
  at: number;
}

export interface SciFileSurfaceOptions {
  /** Said once, the first time a game opens anything, so a player is told. */
  log?: (message: string) => void;
}

/** A DOS wildcard as a matcher: `*` is any run, `?` is one character. */
function maskMatcher(mask: string): (name: string) => boolean {
  const pattern = mask
    .toLowerCase()
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  const expression = new RegExp(`^${pattern}$`);
  return (name) => expression.test(name);
}

export function createSciFileSurface(options: SciFileSurfaceOptions = {}): SciFileSurface {
  const open = new Map<number, OpenFile>();
  const contents = new Map<string, Uint8Array>();
  let nextHandle = 1;
  let announced = false;

  // Case-folded everywhere, because a game that writes `HERO.SAV` and reads
  // `hero.sav` is a game written against DOS.
  const key = (name: string): string => name.toLowerCase();

  const data = (handle: number): { file: OpenFile; bytes: Uint8Array } | null => {
    const file = open.get(handle);
    if (!file) return null;
    const bytes = contents.get(file.name);
    if (!bytes) return null;
    return { file, bytes };
  };

  return {
    open(name, mode) {
      const at = key(name);
      const existing = contents.get(at);

      // Mode 1 is the only one that refuses, and a game uses the refusal as a
      // question — "have I been here before?" (`file.h:31`).
      if (!existing && mode === SCI_FILE_MODE.openOrFail) return 0;
      if (!existing || mode === SCI_FILE_MODE.create) contents.set(at, new Uint8Array(0));

      if (!announced) {
        announced = true;
        options.log?.(
          `This game opened the file "${name}". Files here live in memory for this session ` +
            `only — there is no disc behind them, so what it writes reads back now and is ` +
            `gone when the tab closes.`,
        );
      }

      const handle = nextHandle++;
      open.set(handle, { name: at, at: 0 });
      return handle;
    },

    readLine(handle) {
      const found = data(handle);
      if (!found || found.file.at >= found.bytes.length) return null;
      let end = found.file.at;
      while (end < found.bytes.length && found.bytes[end] !== 0x0a) end++;
      let line = '';
      for (let index = found.file.at; index < end; index++) {
        line += String.fromCharCode(found.bytes[index]!);
      }
      // Past the newline, or to the end for a last line that has none.
      found.file.at = Math.min(end + 1, found.bytes.length);
      return line;
    },

    write(handle, text) {
      if (text === '') return;
      const bytes = new Uint8Array(text.length);
      for (let index = 0; index < text.length; index++)
        bytes[index] = text.charCodeAt(index) & 0xff;
      this.writeBytes(handle, bytes);
    },

    read(handle, count) {
      const found = data(handle);
      if (!found) return new Uint8Array(0);
      const end = Math.min(found.file.at + Math.max(0, count), found.bytes.length);
      const slice = found.bytes.slice(found.file.at, end);
      found.file.at = end;
      return slice;
    },

    writeBytes(handle, bytes) {
      const found = data(handle);
      if (!found) return;
      const end = found.file.at + bytes.length;
      let target = found.bytes;
      if (end > target.length) {
        // A write past the end grows the file, and a write past the end after a
        // seek leaves a hole of nought — which is what a DOS file does.
        const grown = new Uint8Array(end);
        grown.set(target);
        target = grown;
        contents.set(found.file.name, grown);
      }
      target.set(bytes, found.file.at);
      found.file.at = end;
    },

    seek(handle, offset, whence) {
      const found = data(handle);
      if (!found) return -1;
      const base = whence === 1 ? found.file.at : whence === 2 ? found.bytes.length : 0;
      found.file.at = Math.max(0, Math.min(base + offset, found.bytes.length));
      return found.file.at;
    },

    close(handle) {
      open.delete(handle);
    },

    exists(name) {
      return contents.has(key(name));
    },

    remove(name) {
      return contents.delete(key(name));
    },

    rename(from, to) {
      const bytes = contents.get(key(from));
      if (!bytes) return false;
      contents.delete(key(from));
      contents.set(key(to), bytes);
      return true;
    },

    copy(from, to) {
      const bytes = contents.get(key(from));
      if (!bytes) return false;
      contents.set(key(to), bytes.slice());
      return true;
    },

    names(mask) {
      const matches = maskMatcher(mask);
      return [...contents.keys()].filter(matches).sort();
    },
  };
}
