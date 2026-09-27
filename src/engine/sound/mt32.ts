/**
 * What this engine does with Roland MT-32 material, which is not synthesis.
 *
 * A real MT-32 is a linear-arithmetic synthesiser whose patches and PCM
 * attack samples live in two mask ROMs. Emulating it faithfully is Munt — tens
 * of thousands of lines — and it cannot make a sound without those ROMs, which
 * are Roland's copyright and cannot ship here. So a `ROL ` score is played on
 * the OPL2 instead, and this module holds the two things that make that
 * sensible rather than accidental:
 *
 * - the MT-32 → General MIDI programme map, so an MT-32 score's instrument
 *   numbers reach the OPL2's GM bank as the instruments they meant; and
 * - recognising the ROM files an author may import, and saying which one each
 *   is, so "you gave me an MT-32 ROM" is an answer with a name on it.
 */

/**
 * ScummVM's `MidiDriver::_mt32ToGm` (audio/mididrv.cpp), verbatim.
 *
 * MT-32 preset numbers and General MIDI programmes cover the same ground in a
 * different order — MT-32 programme 0 is "Acou Piano 1" and 48 is "Strings 1",
 * where GM puts strings at 48 only by coincidence and brass at 61 rather than
 * 56. iMUSE's `Instrument_Program::send` runs every programme change of an
 * MT-32 score through this table when the device it plays on is not an MT-32,
 * which is exactly the situation here.
 */
export const MT32_TO_GM: readonly number[] = [
  0, 1, 0, 2, 4, 4, 5, 3, 16, 17, 18, 16, 16, 19, 20, 21, 6, 6, 6, 7, 7, 7, 8, 112, 62, 62, 63, 63,
  38, 38, 39, 39, 88, 95, 52, 98, 97, 99, 14, 54, 102, 96, 53, 102, 81, 100, 14, 80, 48, 48, 49, 45,
  41, 40, 42, 42, 43, 46, 45, 24, 25, 28, 27, 104, 32, 32, 34, 33, 36, 37, 35, 35, 79, 73, 72, 72,
  74, 75, 64, 65, 66, 67, 71, 71, 68, 69, 70, 22, 56, 59, 57, 57, 60, 60, 58, 61, 61, 11, 11, 98,
  14, 9, 14, 13, 12, 107, 107, 77, 78, 78, 76, 76, 47, 117, 127, 118, 118, 116, 115, 119, 115, 112,
  55, 124, 123, 0, 14, 117,
];

/** The General MIDI programme an MT-32 programme number stands for. */
export function mt32ProgramToGm(program: number): number {
  return MT32_TO_GM[program & 0x7f];
}

/**
 * An MT-32 score's note velocity, as heard on a General MIDI device.
 *
 * iMUSE's `Player::send` compresses it into the upper range — `(v * 3 / 4) +
 * 32` — when an MT-32 score plays on anything else, because MT-32 patches
 * respond to velocity far less steeply than GM ones and the soft notes would
 * otherwise vanish.
 */
export function mt32VelocityToGm(velocity: number): number {
  return (((velocity * 3) >> 2) + 32) & 0x7f;
}

/** What a Roland synthesiser ROM turned out to be. */
export interface Mt32Rom {
  /** Which half of the synthesiser: its program, or its attack samples. */
  role: 'control' | 'pcm';
  /** The module family the ROM belongs to. */
  model: 'MT-32' | 'CM-32L' | 'LAPC-I' | 'Roland synthesiser';
  /** Firmware version, when the control ROM names one. */
  version: string | null;
  /** A plain-English name for the file, for an import report. */
  name: string;
}

/**
 * The sizes Munt's `ROMInfo` table lists for the ROMs it accepts.
 *
 * A control ROM is 64 KiB (128 KiB for the later 2.x firmware); a PCM ROM is
 * 512 KiB for the MT-32 and 1 MiB for the CM-32L and LAPC-I, whose sample set
 * is larger. These are what distinguish a PCM ROM at all — it is raw samples
 * with no header and no strings.
 */
const CONTROL_SIZES = new Set([32 * 1024, 64 * 1024, 128 * 1024]);
const MT32_PCM_SIZE = 512 * 1024;
const CM32L_PCM_SIZE = 1024 * 1024;

/** How far into a control ROM to look for its display strings. */
const SCAN_BYTES = 128 * 1024;

function asciiUpper(bytes: Uint8Array, length: number): string {
  let text = '';
  for (let i = 0; i < length; i++) {
    const byte = bytes[i];
    text += byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : ' ';
  }
  return text.toUpperCase();
}

function modelFrom(text: string): Mt32Rom['model'] | null {
  if (/CM-?32L/.test(text)) return 'CM-32L';
  if (/LAPC/.test(text)) return 'LAPC-I';
  if (/MT-?32/.test(text)) return 'MT-32';
  return null;
}

/**
 * Says which Roland ROM a file is, or null when it is not one.
 *
 * The control ROM is recognised by the strings it drives the front panel with
 * — "** Roland MT-32 **", its version — and those are in the bytes, so the
 * bytes decide. A PCM ROM has nothing to read, so for that the name the file
 * arrived with, and its size, are all there is; they are only consulted when
 * the bytes have said nothing.
 */
export function identifyMt32Rom(bytes: Uint8Array, filename = ''): Mt32Rom | null {
  const text = asciiUpper(bytes, Math.min(SCAN_BYTES, bytes.length));
  const named = filename.toUpperCase();

  const fromBytes = modelFrom(text);
  const looksRoland = fromBytes !== null || text.includes('ROLAND');
  if (looksRoland && (CONTROL_SIZES.has(bytes.length) || bytes.length < MT32_PCM_SIZE)) {
    const model = fromBytes ?? modelFrom(named) ?? 'Roland synthesiser';
    // "ver1.07", "VER 2.04", "V1.04": the firmware says which it is.
    const version = /V(?:ER)?\s?([0-9]\.[0-9]{2})/.exec(text)?.[1] ?? null;
    return {
      role: 'control',
      model,
      version,
      name: `Roland ${model} control ROM${version ? ` (v${version})` : ''}`,
    };
  }

  if (!/\.ROM$/.test(named) && !/MT-?32|CM-?32L|LAPC/.test(named)) return null;

  const nameModel = modelFrom(named);
  const pcmByName = /PCM/.test(named);
  const controlByName = /CONTROL|CTRL/.test(named);

  if (pcmByName || bytes.length === MT32_PCM_SIZE || bytes.length === CM32L_PCM_SIZE) {
    const model = nameModel ?? (bytes.length === CM32L_PCM_SIZE ? 'CM-32L' : 'MT-32');
    return { role: 'pcm', model, version: null, name: `Roland ${model} PCM ROM` };
  }
  if (controlByName || CONTROL_SIZES.has(bytes.length)) {
    const model = nameModel ?? 'Roland synthesiser';
    return { role: 'control', model, version: null, name: `Roland ${model} control ROM` };
  }
  return null;
}

/**
 * Why an imported ROM does not make the game's Roland music play on a Roland.
 *
 * Stated plainly because the natural assumption — "I gave it the ROMs, so it
 * will sound like an MT-32" — is wrong here, and silently playing OPL2 music
 * after being handed the ROMs would read as a bug.
 */
export function mt32RomNotice(rom: Mt32Rom): string {
  return (
    `${rom.name}: recognised, but not used. True MT-32 sound needs a full ` +
    `linear-arithmetic synthesis emulator (Munt) driven by both the control and ` +
    `PCM ROMs, and this engine does not include one. Roland scores play on the ` +
    `emulated AdLib instead, with their instruments mapped to General MIDI.`
  );
}
