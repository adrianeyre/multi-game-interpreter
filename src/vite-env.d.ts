/// <reference types="vite/client" />

/**
 * The published version, injected at build time from `package.json`.
 *
 * Declared rather than imported so the number lives in exactly one place: a
 * version typed into the page would go stale at the next automatic release.
 */
declare const __APP_VERSION__: string;
