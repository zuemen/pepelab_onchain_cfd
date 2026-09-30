// 這個 build 的白標租戶。元件一律 `import { tenant } from 'src/tenant'`。
//
// 租戶是**建置期**選的（`VITE_TENANT`，沒設 = `default`），跟語系一樣：一個 build
// 一個租戶，沒有執行期切換。`@tenant-config` 由 vite.config.ts（與 vitest.config.ts）
// alias 到 src/tenant/tenants/<id>.json，bundle 裡只有被選中的那一份設定。
//
// build 時 vite.config.ts 已經驗證過一次（失敗就 build 失敗）；這裡在載入時再驗證一次，
// 失敗就丟錯讓 app 起不來——fail-closed，不會帶著半套設定上線。

// eslint-disable-next-line import/no-unresolved -- 建置期 alias（vite.config.ts / vitest.config.ts），型別見 tenant-config.d.ts
import rawTenant from '@tenant-config';

import { makeAssetPolicy } from './assetPolicy';
import { parseTenant, tenantIdFrom } from './schema';

// ----------------------------------------------------------------------

export const tenant = parseTenant(rawTenant, tenantIdFrom(import.meta.env.VITE_TENANT));

/** 資產白名單：進場看它，出場不看它。見 assetPolicy.ts。 */
export const assetPolicy = makeAssetPolicy(tenant);

export type { FeatureKey, TenantConfig, TenantLocale } from './schema';
