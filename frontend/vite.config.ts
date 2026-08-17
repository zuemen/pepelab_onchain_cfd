import path from 'path';
import checker from 'vite-plugin-checker';
import { loadEnv, defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

import { LOCALES, pickLocale } from './src/locales/catalogs';

// ----------------------------------------------------------------------

const PORT = 8081;

export default defineConfig(({ mode }) => {
  // 這個 build 出貨的語言。VITE_LOCALE 可能來自 shell / Vercel 的環境變數，也可能來自
  // .env* 檔案，兩邊都要看：app 讀的是 import.meta.env（Vite 會把兩種來源都注入），
  // 如果這裡只看 process.env，一個寫在 .env.local 的 VITE_LOCALE 就會讓 index.html 的
  // 標題與 lang 停在中文、而 app 內文是英文——半英半中且沒有任何錯誤訊息。
  const locale = pickLocale(
    process.env.VITE_LOCALE ?? loadEnv(mode, process.cwd(), 'VITE_').VITE_LOCALE
  );
  const { htmlLang, catalog } = LOCALES[locale];

  return {
    plugins: [
      react(),
      {
        // index.html 的 lang / title / description 從 catalog 填入，讓語言只有一個來源。
        // order: 'pre' 是必要的——Vite 內建的 HTML env 替換也吃 %FOO% 語法，先跑完這裡
        // 就不會有殘留的 % 記號進到它手上。
        name: 'pepefi-locale-html',
        transformIndexHtml: {
          order: 'pre',
          handler: (html: string) =>
            html
              .replace('__LOCALE_HTML_LANG__', () => htmlLang)
              .replace('__APP_TITLE__', () => catalog.meta.title)
              .replace('__APP_DESCRIPTION__', () => catalog.meta.description),
        },
      },
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
        // Allow eval() needed by Vite dev-mode source maps.
        //
        // connect-src is spelled out rather than left to fall back on default-src.
        // default-src permits `https:` but not plain http, so every locally run
        // backend was blocked in dev — the signal API on :4021 included, which made
        // the K-line chart unloadable while developing against a local server. The
        // http entries are localhost-only and this header is dev-server only
        // (`server.headers`), so nothing here reaches a deployed build.
        'Content-Security-Policy': [
          "script-src 'self' 'unsafe-eval' 'unsafe-inline'",
          "default-src 'self' 'unsafe-inline' data: https: wss:",
          "connect-src 'self' https: wss: ws: http://localhost:* http://127.0.0.1:*",
        ].join('; '),
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
          //
          // Function form, not the object form (`{ mui: ['@mui/material'] }`).
          // The object form also drags each listed module's *transitive* deps
          // into the same chunk, and a dep shared by two groups can only land in
          // one of them. react-is is used by both @mui and recharts: it got
          // hoisted into `mui`, which made `charts` import `mui` while `mui`
          // already imported `charts`. Two chunks in an ESM cycle — charts ran
          // first and called into react-is before mui's top-level
          // `Le = {}` had executed, so the whole app died at boot with
          // "Cannot set properties of undefined (setting 'AsyncMode')" and
          // rendered a blank page.
          //
          // The function form assigns only the modules it matches. Anything
          // shared stays unassigned and Rollup gives it its own chunk that both
          // groups depend on, so the graph stays acyclic by construction.
          manualChunks(id) {
            if (!id.includes('/node_modules/')) return undefined;

            if (/\/node_modules\/(react|react-dom|react-router)\//.test(id)) return 'react';
            if (/\/node_modules\/@mui\//.test(id)) return 'mui';
            if (/\/node_modules\/recharts\//.test(id)) return 'charts';
            // lightweight-charts 只有終端機在用，跟 recharts 分開放：終端機的使用者
            // 不必下載 recharts，其他頁面也不必下載這包。混進 entry chunk 則會直接
            // 吃掉 570→328 kB 那次的成果。
            if (/\/node_modules\/lightweight-charts\//.test(id)) return 'charts-lw';
            if (/\/node_modules\/ethers\//.test(id)) return 'ethers';

            return undefined;
          },
        },
      },
    },
  };
});
