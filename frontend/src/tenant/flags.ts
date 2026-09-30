// 功能旗標的「租戶上限 × 環境變數」合成規則。Node 端（vite.config.ts）與瀏覽器端共用。
//
//   有效值 = policy.allowed && readFlag(env, policy.default)
//
// - 環境變數沒設定 → 用租戶的 default。
// - 環境變數可以把功能**關掉**（例如緊急下架某功能，不必改設定檔重新審查）。
// - 環境變數**打不開**租戶未授權（allowed=false）的功能——授權範圍是合約／法遵層面的
//   決定，不該是部署面板上一個欄位就能改的東西。
//
// 預設 tenant 五個旗標都是 { allowed: true, default: false }，所以結果與改動前的
// `readFlag(env, false)` 逐位元相同。理由見 frontend/docs/adr/0009-tenant-config-layer.md。

import type { FeatureKey, TenantConfig, FeaturePolicy } from './schema';

import { readFlag } from '../lib/pepefi/flagParse';
import { FEATURE_KEYS, FEATURE_ENV_KEYS } from './schema';

// ----------------------------------------------------------------------

export function resolveFeatureFlag(policy: FeaturePolicy, raw: unknown): boolean {
  return policy.allowed && readFlag(raw, policy.default);
}

/** 依租戶設定與環境變數表，算出全部旗標。`env` 是 `import.meta.env` 或 Node 端的等價物。 */
export function resolveTenantFeatures(
  tenant: Pick<TenantConfig, 'features'>,
  env: Record<string, unknown>
): Record<FeatureKey, boolean> {
  return Object.fromEntries(
    FEATURE_KEYS.map((k) => [k, resolveFeatureFlag(tenant.features[k], env[FEATURE_ENV_KEYS[k]])])
  ) as Record<FeatureKey, boolean>;
}
