---
status: accepted
---

# 一個站出多種語言：用網址路徑區分，每種語言仍是一份 build

[ADR 0001](./0001-build-time-locale-selection.md) 讓語言在 build 時決定，兩種語言就是同一個 commit 部署兩次。實際做法是開兩個 Vercel 專案（中文 `pepelab-onchain-cfd-djot`、英文 `pepelab-onchain-cfd` 設 `VITE_LOCALE=en`）。2026-10-29 中文那個專案被改名或刪除，主站網址整個回 `404 DEPLOYMENT_NOT_FOUND`；同時 Hobby 方案的空間快用完，而每次 push 兩個專案各自上傳一份約 135 MB 的 `public/`（issue #396）。

現在同一個站同時出中文與英文，用網址路徑區分：defaultLocale 在 `/`，其他語言在 `/<locale>/`（default 租戶：中文 `/`、英文 `/en/`）。**語言仍然在 build 時決定**：`scripts/build-site.mjs` 用 Vite 的 JS API 依序 build 每種語言，非根目錄的語言設 `base: '/<locale>/'`、不複製 `public/`；頂部列的「中 / EN」是普通連結，整頁跳到另一份 build 的同一頁（`src/locales/site.ts` 的 `localeHref`）。哪些語言要出由租戶設定的 `siteLocales` 決定，沒填就只出 defaultLocale——rwa-poc、demo-bank 的輸出跟以前一樣。

## 考慮過的做法

**app 內即時切換語言。** 否決，理由與 ADR 0001 相同而且更具體了：`t` 在 module scope 被大量使用（nav 設定、合約錯誤表、各種資料表），即時切換要改約 232 個檔案，而且分批改的過程中畫面會一半換了語言一半沒換。

**繼續兩個 Vercel 專案，只把 -djot 網址接到英文專案。** 否決：主站會變成英文；空間問題也還在。

**用網域或子網域區分（`en.` 開頭）。** 否決：`*.vercel.app` 底下不能自己開子網域，要多一個 Vercel 專案或買網域，又回到兩個專案的問題。

**用查詢字串（`?lang=en`）。** 否決：同一個網址要回兩份不同的 index.html，靜態託管做不到；而且分享出去的連結很容易掉參數。

## 結果

- 一個 Vercel 專案、一次 `yarn build` 出兩種語言；`public/` 只放根目錄一份，引用它的絕對路徑（`/pepe-skins/...`、`/data/...`）在每種語言都指向同一份。程式碼裡**不要**用 `import.meta.env.BASE_URL` 拼 `public/` 的路徑：在英文站那會變成 `/en/...`，而那裡沒有這些檔案。
- 每份 build 的 `VITE_LOCALE` 由腳本指定，Vercel 上殘留的 `VITE_LOCALE` 會被忽略（build log 會印一行提醒）。直接跑 `vite`／`vite build` 時 `VITE_LOCALE` 仍照 ADR 0001 的規則生效，本機看英文版用 `VITE_LOCALE=en yarn dev`。
- `vercel.json` 的 rewrites 依語言分流：`/en/...` 回 `/en/index.html`、其餘回 `/index.html`；兩邊都排除 `assets/`，換版後找不到的舊程式檔回 404 而不是一份 HTML。開著的舊分頁碰到這種 404 會觸發 `vite:preloadError`，`main.tsx` 自動重新整理一次（`src/lib/pepefi/staleChunkReload.ts`）。這些規則由 `src/locales/site.test.ts` 對著 default 租戶的語言清單檢查。
- 新增一種語言要同時做三件事：租戶的 `siteLocales`、`vercel.json` 的 rewrites、（若是新語系）catalog。少了 rewrites，site.test.ts 會失敗。
- 切換語言是整頁載入，切換時表單裡沒送出的輸入會不見。語言是給讀者選一次用的，不是常常來回切的設定，這個代價可以接受。
