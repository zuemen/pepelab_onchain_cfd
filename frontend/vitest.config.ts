import { fileURLToPath } from 'url'
import { defineConfig } from 'vitest/config'

import { pinnedEnv } from './vitest.pinnedEnv'

export default defineConfig({
  resolve: {
    alias: [
      // 測試一律跑 default 租戶（與正式站相同）；其他租戶由 src/tenant/*.test.ts
      // 直接讀檔驗證。對應 vite.config.ts 的同名 alias。
      {
        find: /^@tenant-config$/,
        replacement: fileURLToPath(new URL('./src/tenant/tenants/default.json', import.meta.url)),
      },
      // 部署登記同樣固定成 default（＝平台的現行部署，addresses.ts）；專屬部署的解析由
      // src/contracts/tenantDeployment.test.ts 以 fixture 直接驗證。
      {
        find: /^@tenant-deployment$/,
        replacement: fileURLToPath(
          new URL('./src/contracts/deployments/default.json', import.meta.url)
        ),
      },
      // `import … from 'src/…'`：對應 vite.config.ts 的同名 alias。vitest 2 的 vite-node
      // 解析失敗時會退回「相對於專案根目錄的檔案路徑」，所以以前沒有這條也能跑；vitest 4
      // 改用 Vite 的 module runner，沒有這個退路，缺 alias 就是 Cannot find package 'src/…'。
      {
        find: /^src(.+)/,
        replacement: `${fileURLToPath(new URL('./src', import.meta.url))}$1`,
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
    // 語系、功能旗標、signal-api 網址等同理：它們都在模組載入時被讀進常數，shell 或
    // .env.local 裡的 VITE_LOCALE=en、VITE_FEATURE_GAMEFI=1 會讓 default 斷言失敗。
    // 固定清單（明確白名單＋每一項的理由）在 vitest.pinnedEnv.ts，
    // 由 src/testEnvPinning.test.ts 斷言內容與涵蓋範圍。
    env: pinnedEnv(),
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
