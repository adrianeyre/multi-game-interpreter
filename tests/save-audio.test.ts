// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

/**
 * Save carries the audio that is too large to live inside the project.
 *
 * README calls the saved `.json` "the source of truth" — something to back up,
 * commit and re-import anywhere. A track over the inline limit keeps only a
 * `storeKey` in the document and its bytes in this browser's audio store, so a
 * Save that wrote the document alone produced a folder that reopened elsewhere
 * with every large track listed and silent. `exportProjectOnly` already wrote
 * an `audio/` folder beside the document; Save now writes the same one.
 */
const STORED = new Map<string, Uint8Array>([['track-1', new Uint8Array([1, 2, 3, 4])]]);

vi.mock('../src/editor/audioStore.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/editor/audioStore.js')>();
  return {
    ...actual,
    getAudioBytes: async (key: string) => STORED.get(key) ?? null,
  };
});

const { saveToFolder } = await import('../src/editor/save.js');
const { writeInto } = await import('../src/editor/files.js');
const { createProject } = await import('../src/authoring/project.js');
type DirectoryHandleLike = import('../src/editor/files.js').DirectoryHandleLike;

/** A folder that remembers what was written into it, subfolders included. */
function memoryFolder(
  name: string,
  written: Map<string, Uint8Array>,
  prefix = '',
): DirectoryHandleLike {
  return {
    name,
    async getFileHandle(file: string) {
      return {
        async createWritable() {
          return {
            async write(data: Blob | string) {
              const bytes =
                typeof data === 'string'
                  ? new TextEncoder().encode(data)
                  : new Uint8Array(await data.arrayBuffer());
              written.set(`${prefix}${file}`, bytes);
            },
            async close() {},
          };
        },
      } as unknown as Awaited<ReturnType<DirectoryHandleLike['getFileHandle']>>;
    },
    async getDirectoryHandle(folder: string) {
      return memoryFolder(folder, written, `${prefix}${folder}/`);
    },
    async queryPermission() {
      return 'granted' as PermissionState;
    },
  };
}

describe('Save and audio kept outside the project', () => {
  it('writes each stored track into audio/ beside the project JSON', async () => {
    const project = createProject('Loud');
    project.audio.push({
      id: 1,
      name: 'theme',
      format: 'wav',
      filename: 'theme.wav',
      storeKey: 'track-1',
      bytes: 4,
    });

    const written = new Map<string, Uint8Array>();
    const result = await saveToFolder(project, memoryFolder('out', written), true);

    expect(result.files).toContain('audio/track-1');
    expect([...(written.get('audio/track-1') ?? [])]).toEqual([1, 2, 3, 4]);
    expect(written.has('loud.scummproj.json')).toBe(true);
  });

  it('leaves out a stored track whose bytes are gone rather than writing it empty', async () => {
    const project = createProject('Quiet');
    project.audio.push({
      id: 1,
      name: 'lost',
      format: 'wav',
      filename: 'lost.wav',
      storeKey: 'missing',
      bytes: 4,
    });

    const written = new Map<string, Uint8Array>();
    const result = await saveToFolder(project, memoryFolder('out', written), true);
    expect(result.files).not.toContain('audio/missing');
  });

  it('refuses a nested path on a folder that cannot hold one, by name', async () => {
    const flat: DirectoryHandleLike = { ...memoryFolder('flat', new Map()) };
    delete (flat as { getDirectoryHandle?: unknown }).getDirectoryHandle;
    await expect(writeInto(flat, 'audio/x', new Uint8Array(1))).rejects.toThrow(/audio\//);
  });
});
