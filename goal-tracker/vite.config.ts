import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Builds the site into dist/client. It lives inside the Companion app at /nowhere
// (the same word as CLAIM.slug in src/lib/claim.ts), so every file it loads is
// asked for under that address. The server half is vite.server.config.ts.
export default defineConfig({
  base: '/nowhere/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    // public/gamedata.json is served straight from public/ (see server/embed.ts), not copied into each build.
    copyPublicDir: false,
  },
  server: {
    port: 5183,
    strictPort: true,
    // `npm run dev` is for working on the screens: open http://localhost:5183/nowhere.
    // The API is the Companion's, so start that too (`node proxy.js` one folder up).
    // COMPANION names another address when it is not on its usual port.
    proxy: { '/nowhere/api': process.env.COMPANION ?? 'http://localhost:3000' },
  },
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
