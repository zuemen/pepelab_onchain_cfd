import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: [
      // 測試一律跑 default 租戶（與正式站相同）；其他租戶由 src/tenant/tenant.test.ts
      // 直接讀檔驗證。對應 vite.config.ts 的同名 alias。
      {
        find: /^@tenant-config$/,
        replacement: fileURLToPath(new URL('./src/tenant/tenants/default.json', import.meta.url)),
      },
    ],
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
