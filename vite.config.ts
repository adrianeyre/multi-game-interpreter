import { readFileSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';

import { gamesFolder } from './src/hosting/gamesFolderPlugin.js';

/**
 * The published version, read from the manifest rather than written twice.
 *
 * Releases are cut automatically, so a version typed into the page would be
 * wrong within a release of being written.
 */
const { version } = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string };

/**
 * Two build modes:
 *   default  -> the playable web app (index.html + assets), served by `npm start`.
 *   lib      -> an ES module exposing the engine for embedding elsewhere.
 */
export default defineConfig(({ mode }) => ({
  base: './',
  // Serves `games/` next to package.json, and lists it for the app — a browser
  // cannot list a directory over HTTP, and a dev server can.
  plugins: [gamesFolder()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  resolve: {
    alias: {
      '@engine': fileURLToPath(new URL('./src/engine', import.meta.url)),
      '@ui': fileURLToPath(new URL('./src/ui', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 5160,
    open: false,
    // `games/` is served by the plugin above. `public/games/<id>/` is still
    // served verbatim by Vite, and is the only route a static production build
    // has — there, a `manifest.json` is still required.
    fs: { strict: true },
  },
  preview: {
    host: true,
    port: 4173,
  },
  build:
    mode === 'lib'
      ? {
          outDir: 'dist',
          emptyOutDir: true,
          lib: {
            entry: fileURLToPath(new URL('./src/index.ts', import.meta.url)),
            name: 'MgiWeb',
            fileName: () => 'mgi-web.js',
            formats: ['es'],
          },
        }
      : {
          outDir: 'dist-web',
          emptyOutDir: true,
          sourcemap: true,
          target: 'es2022',
          rollupOptions: {
            // Two pages: the player and the editor.
            input: {
              index: fileURLToPath(new URL('./index.html', import.meta.url)),
              editor: fileURLToPath(new URL('./editor.html', import.meta.url)),
            },
          },
        },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/engine/**/*.ts'],
    },
  },
}));
