/**
 * Base64 for the binary a project carries inside its JSON.
 *
 * Images and audio both need it, and both have to work in the browser and in
 * the Node CLI, so the two environments are handled in one place rather than
 * each caller repeating the `btoa`/`Buffer` dance.
 */

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  // Chunked to avoid blowing the argument limit on large payloads.
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return typeof btoa === 'function' ? btoa(binary) : Buffer.from(bytes).toString('base64');
}

export function fromBase64(text: string): Uint8Array {
  if (typeof atob === 'function') {
    const binary = atob(text);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(text, 'base64'));
}
