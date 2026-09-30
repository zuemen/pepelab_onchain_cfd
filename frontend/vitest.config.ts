import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

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
    env: { VITE_TENANT: '' },
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
