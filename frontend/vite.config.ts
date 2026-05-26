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
    proxy: {
      // Proxy CoinGecko API to bypass CORS in dev
      '/api/coingecko': {
        target: 'https://api.coingecko.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/coingecko/, ''),
      },
    },
  },
  preview: { port: PORT, host: true },
});
