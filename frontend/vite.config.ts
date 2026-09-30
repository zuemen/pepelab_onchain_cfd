import fs from 'fs';
import path from 'path';
import checker from 'vite-plugin-checker';
import { loadEnv, defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';

import { applyBrand } from './src/tenant/brand';
import { loadTenantForBuild } from './src/tenant/node';
import { resolveFeatureFlag } from './src/tenant/flags';
import { checkSignalApiUrl } from './src/lib/pepefi/cspConnect';
import { LOCALES, pickLocale } from './src/locales/catalogs';

// ----------------------------------------------------------------------

const PORT = 8081;

/** index.html 的 `<link rel="icon" type=…>`，依副檔名決定。 */
function faviconType(file: string): string {
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.ico')) return 'image/x-icon';
  if (file.endsWith('.jpg') || file.endsWith('.jpeg')) return 'image/jpeg';
  return 'image/png';
}

export default defineConfig(({ mode, command }) => {
  // VITE_* 可能來自 shell / Vercel 的環境變數，也可能來自 .env* 檔案，兩邊都要看：app 讀的
  // 是 import.meta.env（Vite 會把兩種來源都注入），如果這裡只看 process.env，一個寫在
  // .env.local 的 VITE_LOCALE 就會讓 index.html 的標題與 lang 停在中文、而 app 內文是
  // 英文——半英半中且沒有任何錯誤訊息。
  const fileEnv = loadEnv(mode, process.cwd(), 'VITE_');
  const envOf = (key: string): string | undefined => process.env[key] ?? fileEnv[key];

  // 白標租戶（VITE_TENANT，沒設 = default）。名字對不到設定檔、或設定檔驗證不過，就在這裡
  // 丟錯讓 build／dev server 起不來——不會退回 default 帶著別人的品牌上線。
  // 見 frontend/docs/adr/0009-tenant-config-layer.md。
  const tenant = loadTenantForBuild(process.cwd(), envOf('VITE_TENANT'));
  const { brand } = tenant.config;

  // 這個 build 出貨的語言：VITE_LOCALE 優先，沒設就用租戶的預設語系。
  const locale = pickLocale(envOf('VITE_LOCALE') || tenant.config.defaultLocale);
  const { htmlLang, catalog } = LOCALES[locale];

  // app 內的旗標在 featureFlags.ts；index.html 在建置時就寫死了，所以 meta description 要在
  // 這裡依 FEATURE_COPY_TRADING 選字串——否則商業版的搜尋結果與分享預覽仍在介紹「社交跟單」。
  // 與 app 內走同一條「租戶上限 × 環境變數」規則（src/tenant/flags.ts）。
  const copyTrading = resolveFeatureFlag(
    tenant.config.features.copyTrading,
    envOf('VITE_FEATURE_COPY_TRADING')
  );
  const metaDescription = applyBrand(
    copyTrading ? catalog.meta.description : catalog.meta.descriptionNoCopy,
    brand
  );

  // 正式 build：可覆寫的 signal-api 網址必須在 vercel.json 的 CSP connect-src 裡，
  // 否則瀏覽器會擋掉所有請求而 build／部署仍是綠的。對不上就讓 build 失敗。
  // dev server 不檢查——本機常打 http://localhost:4021，而 dev 的 CSP 在下面 server.headers。
  if (command === 'build') {
    const vercel = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'vercel.json'), 'utf8'));
    const problem = checkSignalApiUrl(envOf('VITE_SIGNAL_API_URL'), vercel);
    if (problem) throw new Error(`\n[pepefi-csp] ${problem}\n`);
  }

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
              .replace('__APP_TITLE__', () => applyBrand(catalog.meta.title, brand))
              .replace('__APP_DESCRIPTION__', () => metaDescription)
              // 租戶的 favicon 與 theme-color。值都經過 schema 驗證（站內路徑、#RRGGBB），
              // 不會有引號或角括號跑進 HTML。
              .replace('__APP_FAVICON__', () => brand.favicon)
              .replace('__APP_FAVICON_TYPE__', () => faviconType(brand.favicon))
              .replace('__APP_THEME_COLOR__', () => brand.themeColor),
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
        // 只把被選中的租戶設定打進 bundle，理由見 src/tenant/node.ts。
        { find: /^@tenant-config$/, replacement: tenant.file },
        {
          find: /^src(.+)/,
          replacement: path.resolve(process.cwd(), 'src/$1'),
        },
      ],
    },
    server: {
      port: PORT,
      host: true,
      // WSL 底下跑 dev server、原始碼在 Windows 端（/mnt/c）編輯時，原生 inotify
      // 事件常常傳不過來——存檔了 HMR 也不知道，只能整個 dev server 重開才看得到
      // 最新的檔案。polling 用輪詢代替事件通知，兩邊都能正常收到變更；代價是
      // CPU 多一點週期性檢查，對開發體驗不算大。
      watch: { usePolling: true },
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
