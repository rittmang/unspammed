import { copyFile, mkdir, rm } from 'node:fs/promises';
import { build } from 'vite';

await build({
  configFile: false,
  publicDir: false,
  build: {
    ssr: 'server/vercel.ts',
    target: 'node22',
    outDir: '.vercel-runtime',
    emptyOutDir: true,
    rollupOptions: {
      output: { entryFileNames: 'handler.mjs', chunkFileNames: '[name]-[hash].mjs' },
    },
  },
});

// Vercel rejects an empty static output. Only this already-public icon is static;
// HTML, dashboard assets, APIs, and Mini App responses pass through the function.
await rm('.vercel-static', { recursive: true, force: true });
await mkdir('.vercel-static', { recursive: true });
await copyFile('public/favicon.svg', '.vercel-static/favicon.svg');
