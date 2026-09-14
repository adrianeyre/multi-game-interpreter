import { describe, expect, it } from 'vitest';

import { FileListDataSource } from '../src/engine/resource/DataSource.js';
import { filesFromDropEntries, readDropEntries } from '../src/ui/droppedFiles.js';

/**
 * A dropped folder, as the browser presents one.
 *
 * The shape is the point: `dataTransfer.files` holds a single entry named after
 * the folder, and the contents exist only behind `webkitGetAsEntry`. A fixture
 * that put the files in `files` would test nothing, because that is precisely
 * the thing the browser does not do.
 */
function fileEntry(name: string, bytes = new Uint8Array([1, 2, 3])): FileSystemEntry {
  return {
    name,
    isFile: true,
    isDirectory: false,
    file: (onFile: (file: File) => void) => onFile(new File([bytes], name)),
  } as unknown as FileSystemEntry;
}

/** A directory whose reader pages, which is the trap the walk has to survive. */
function directoryEntry(
  name: string,
  children: FileSystemEntry[],
  pageSize = 100,
): FileSystemEntry {
  return {
    name,
    isFile: false,
    isDirectory: true,
    createReader: () => {
      let at = 0;
      return {
        readEntries: (onEntries: (entries: FileSystemEntry[]) => void) => {
          const page = children.slice(at, at + pageSize);
          at += page.length;
          onEntries(page);
        },
      };
    },
  } as unknown as FileSystemEntry;
}

describe('a folder dropped on the page', () => {
  it('yields the files inside it, with the path each sat at', async () => {
    const dropped = directoryEntry('fate', [
      fileEntry('ATLANTIS.000'),
      fileEntry('ATLANTIS.001'),
      fileEntry('monster.so3'),
      fileEntry('README.md'),
    ]);

    const found = await filesFromDropEntries([dropped]);

    expect(found.map((entry) => entry.path).sort()).toEqual([
      'fate/ATLANTIS.000',
      'fate/ATLANTIS.001',
      'fate/README.md',
      'fate/monster.so3',
    ]);
  });

  it('reads a directory whose entries arrive a page at a time', async () => {
    // One entry per page is the degenerate case of the real API's paging, and a
    // walk that calls `readEntries` once returns only the first file.
    const children = Array.from({ length: 7 }, (_, index) => fileEntry(`DISK0${index + 1}.LEC`));
    const found = await filesFromDropEntries([directoryEntry('loom', children, 1)]);

    expect(found).toHaveLength(7);
  });

  it('descends into a subfolder, which is where a v7 release keeps its videos', async () => {
    const dropped = directoryEntry('ft', [
      fileEntry('FT.LA0'),
      directoryEntry('VIDEO', [fileEntry('INTRO.SAN')]),
    ]);

    const found = await filesFromDropEntries([dropped]);

    expect(found.map((entry) => entry.path).sort()).toEqual(['ft/FT.LA0', 'ft/VIDEO/INTRO.SAN']);
  });

  it('stops at a depth no release needs, rather than trusting what was dropped', async () => {
    let deepest: FileSystemEntry = fileEntry('DEEP.000');
    for (let level = 0; level < 8; level++) deepest = directoryEntry(`level${level}`, [deepest]);

    const found = await filesFromDropEntries([deepest]);

    expect(found).toHaveLength(0);
  });

  it('is a data source whose names carry the folder, the way the picker’s do', async () => {
    const found = await filesFromDropEntries([
      directoryEntry('fate', [fileEntry('ATLANTIS.000'), fileEntry('ATLANTIS.001')]),
    ]);

    const source = new FileListDataSource(found, 'fate');

    // The full path is what `list()` reports, and a lookup still finds the file
    // by its base name — which is what every detector matches on.
    expect(source.list().sort()).toEqual(['fate/ATLANTIS.000', 'fate/ATLANTIS.001']);
    expect(await source.read('ATLANTIS.000')).not.toBeNull();
    expect(await source.read('fate/ATLANTIS.001')).not.toBeNull();
  });
});

describe('the items a drop carried', () => {
  it('are read before anything awaits, because the list empties itself', () => {
    // A real `DataTransferItemList` is emptied when the handler returns. This
    // stands in for that by refusing to be read twice, so a walk that awaited
    // first would see nothing.
    let read = false;
    const entry = fileEntry('TENTACLE.000');
    const transfer = {
      items: [
        {
          kind: 'file',
          webkitGetAsEntry: () => {
            if (read) return null;
            read = true;
            return entry;
          },
        },
      ],
      files: [],
    } as unknown as DataTransfer;

    expect(readDropEntries(transfer)).toEqual([entry]);
    expect(readDropEntries(transfer)).toEqual([]);
  });

  it('ignores an item that is not a file, such as a dragged link', () => {
    const transfer = {
      items: [{ kind: 'string', webkitGetAsEntry: () => null }],
      files: [],
    } as unknown as DataTransfer;

    expect(readDropEntries(transfer)).toEqual([]);
  });
});
