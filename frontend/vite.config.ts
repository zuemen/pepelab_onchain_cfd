import path from 'path';
import checker from 'vite-plugin-checker';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

// ----------------------------------------------------------------------

const PORT = 8081;

export default defineConfig({
  plugins: [
    react(),
    checker({
      typescript: true,
      eslint: {
        useFlatConfig: true,
        lintCommand: 'eslint "./src/**/*.{js,jsx,ts,tsx}"',
        dev: { logLevel: ['error'] },
      },
      overlay: {
        position: 'tl',
        initialIsOpen: false,
      },
    }),
  ],
  resolve: {
    alias: [
      {
        find: /^src(.+)/,
        replacement: path.resolve(process.cwd(), 'src/$1'),
      },
    ],
  },
  server: {
    port: PORT,
    host: true,
    headers: {
      // Allow eval() needed by Vite dev-mode source maps
      'Content-Security-Policy': "script-src 'self' 'unsafe-eval' 'unsafe-inline'; default-src 'self' 'unsafe-inline' data: https: wss:;",
    },
  },
  preview: { port: PORT, host: true },

  build: {
    rollupOptions: {
      output: {
        // Routes were already split, but every vendor library still landed in
        // one 1,789 kB entry chunk (570 kB gzipped) that the browser had to
        // fetch and parse before anything rendered.
        //
        // Splitting by library does two things. Downloads go in parallel over
        // HTTP/2 instead of serialising behind one file. More importantly the
        // hashes stop moving in lockstep: ethers and MUI change when we bump a
        // dependency, app code changes every deploy, and keeping them apart
        // means a routine deploy no longer invalidates ~1.7 MB of cache that
        // did not actually change.
        //
        // Deliberately coarse. Splitting per-package produces a request
        // waterfall of tiny chunks that costs more than it saves; these four
        // are the ones large enough to be worth isolating.
        manualChunks: {
          ethers: ['ethers'],
          mui: ['@mui/material', '@mui/system'],
          charts: ['recharts'],
          react: ['react', 'react-dom', 'react-router'],
        },
      },
    },
  },
});
