import { describe, expect, it } from 'vitest';
import { parseByteRange } from '../src/hosting/gamesFolderPlugin.js';

/**
 * The `Range` header the served `games/` folder answers.
 *
 * `DataSource.readRange` exists so that a v7 bundle — hundreds of megabytes,
 * addressed by offset — is never read whole to take a few kilobytes out of it.
 * A server that ignores the header does not fail: the reader treats a 200 as
 * "ranges are not available here" and slices what it needs, so the bytes are
 * right and the cost is the whole file. Which means the machinery can be
 * completely inert on the one path a maintainer would use to try a retail
 * game, and nothing would say so.
 */
describe('reading a range of a game file', () => {
  it('reads an interval, inclusive of both ends as the header defines it', () => {
    // `bytes=0-1` is two bytes, not one. Off by one here reads a chunk header
    // one byte short, which decodes as a plausible-looking wrong value.
    expect(parseByteRange('bytes=0-1', 100)).toEqual({ start: 0, end: 1 });
    expect(parseByteRange('bytes=10-19', 100)).toEqual({ start: 10, end: 19 });
  });

  it('reads to the end when no end is given', () => {
    expect(parseByteRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
  });

  it('reads the last n bytes when no start is given', () => {
    // `bytes=-500` means the last 500 bytes, not the first 500. Read the other
    // way it returns the wrong part of the file with a perfectly valid status.
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
  });

  it('clamps an end past the file rather than promising bytes it has not got', () => {
    expect(parseByteRange('bytes=95-999', 100)).toEqual({ start: 95, end: 99 });
  });

  it('declines a range that starts past the end, so the whole file is sent', () => {
    // Not an error: a whole file is a slow answer and never a wrong one, and
    // the reader slices what it needs out of a 200.
    expect(parseByteRange('bytes=500-600', 100)).toBeNull();
  });

  it('declines a reversed or empty range', () => {
    expect(parseByteRange('bytes=50-10', 100)).toBeNull();
    expect(parseByteRange('bytes=-', 100)).toBeNull();
  });

  it('declines the forms it will not answer rather than guessing at them', () => {
    // Multiple intervals make the response a MIME document; a client that
    // asked for one would rather have the file.
    expect(parseByteRange('bytes=0-10,20-30', 100)).toBeNull();
    expect(parseByteRange('items=0-10', 100)).toBeNull();
    expect(parseByteRange(undefined, 100)).toBeNull();
  });
});
