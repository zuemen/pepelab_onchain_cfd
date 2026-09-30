import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

const SRC_DIR = fileURLToPath(new URL('./src', import.meta.url))

/**
 * src 內（不含測試檔）讀到的所有功能旗標 env 名稱：`VITE_FEATURE_*`、`VITE_SHOW_*`，
 * 以及 `VITE_ENABLE_MOCK_WALLET`。用掃描而不是手抄清單——新增旗標時不必記得回來改這裡，
 * 漏掉一個就會讓「shell 設了旗標 → 單元測試斷言失敗」的問題悄悄回來。
 */
function featureFlagEnvNames(dir: string): string[] {
  const names = new Set<string>()
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8')
        for (const m of text.matchAll(/\bVITE_(?:FEATURE|SHOW)_[A-Z0-9_]+|\bVITE_ENABLE_MOCK_WALLET\b/g)) {
          names.add(m[0])
        }
      }
    }
  }
  walk(dir)
  return [...names].sort()
}

export const PINNED_FLAG_ENV = featureFlagEnvNames(SRC_DIR)

export default defineConfig({
  resolve: {
    alias: [
      // 測試一律跑 default 租戶（與正式站相同）；其他租戶由 src/tenant/*.test.ts
      // 直接讀檔驗證。對應 vite.config.ts 的同名 alias。
      {
        find: /^@tenant-config$/,
        replacement: fileURLToPath(new URL('./src/tenant/tenants/default.json', import.meta.url)),
      },
    ],
  },
  test: {
    // 上面的 alias 固定指向 default.json；import.meta.env.VITE_TENANT 也必須固定成 default，
    // 否則 shell 裡殘留的 VITE_TENANT=demo-bank 會讓 src/tenant/index.ts 以「demo-bank」
    // 驗證 default.json（id 不符 → 整個模組載入失敗）。選擇固定 env 而不是讓 alias 跟 env 走：
    // 單元測試斷言的是 default 租戶（＝正式站）的行為，不該因為跑測試的 shell 而改變；
    // 其他租戶由 src/tenant/*.test.ts 直接讀檔驗證。
    //
    // 功能旗標同理：shell 裡的 VITE_FEATURE_GAMEFI=1、VITE_SHOW_LEVERAGE=1 等會讓 featureFlags.ts
    // 與 branding.test.ts 斷言的「default 租戶旗標全關」失敗。全部固定為 ''（＝未設定＝租戶預設）；
    // 旗標的解析規則由 flagParse／tenant/flags 的單元測試以參數直接驗證，不靠 env。
    env: {
      VITE_TENANT: '',
      ...Object.fromEntries(PINNED_FLAG_ENV.map((name) => [name, ''])),
    },
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
