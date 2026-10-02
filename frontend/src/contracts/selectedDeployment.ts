// 這個 build 被選中的租戶的部署登記（已驗證）。
//
// 跟租戶設定一樣是建置期選的：`@tenant-deployment` 由 vite.config.ts（與 vitest.config.ts）
// alias 到 src/contracts/deployments/<VITE_TENANT>.json，bundle 裡只有這一份——A 機構的站
// 不會帶著 B 機構的合約位址，也看不出平台還有哪些租戶。
//
// 元件與 hook 不直接用這個檔案，一律走 ./deployment.ts 的 getter。這個檔案獨立出來只為了
// 讓 ./sessionManager.ts 能讀到專屬部署、而不與 ./deployment.ts 互相 import。

// eslint-disable-next-line import/no-unresolved -- 建置期 alias（vite.config.ts / vitest.config.ts），型別見 tenant-deployment.d.ts
import rawDeployment from '@tenant-deployment';

import { tenantIdFrom } from '../tenant/schema';
import { resolveDeployment, parseTenantDeployment } from './tenantDeployment';

// ----------------------------------------------------------------------

/** 載入時驗證；失敗就丟錯讓 app 起不來（fail-closed），不帶著半套位址上線。 */
export const tenantDeployment = parseTenantDeployment(
  rawDeployment,
  tenantIdFrom(import.meta.env.VITE_TENANT)
);

export const resolvedDeployment = resolveDeployment(tenantDeployment);
