import { defineConfig } from 'vite';

// Builds server/embed.ts and everything it uses into dist/server.mjs, the one file the
// Companion's proxy.js loads. Packages are bundled in, so the Companion still runs
// with nothing installed. The Postgres client lands in its own file next to it
// (dist/server-*.mjs) and is only read when DATABASE_URL is set.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: 'server/embed.ts',
    outDir: 'dist',
    // dist/client was just built by vite.config.ts.
    emptyOutDir: false,
    target: 'node22',
    minify: false,
    rollupOptions: {
      output: { format: 'es', entryFileNames: 'server.mjs', chunkFileNames: 'server-[name].mjs' },
    },
  },
  ssr: {
    noExternal: true,
    // An optional native add-on the Postgres client only reaches for when asked to, which this never does.
    external: ['pg-native'],
  },
});
