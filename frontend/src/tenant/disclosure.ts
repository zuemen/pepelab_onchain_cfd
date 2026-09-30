// 白標租戶在平台核心揭露之後**追加**的內容：營運機構名稱與附加條目。
//
// 只能追加，不能取代——核心三條（測試網原型、合成且非足額抵押、非投資建議）永遠由
// SyntheticDisclosure 顯示，租戶設定沒有任何欄位可以改動或拿掉它們（schema.ts）。
// default 租戶兩者皆空，畫面與改版前相同。

import type { TenantConfig, TenantLocale } from './schema';

import { interpolate } from '../locales/interpolate';

// ----------------------------------------------------------------------

export function tenantDisclosureAdditions(
  compliance: TenantConfig['compliance'],
  lang: TenantLocale,
  /** catalog 的 `common.disclosure.operatedBy`（含 `{operator}` 佔位符）。 */
  operatedByTemplate: string
): { operatorLine: string | null; items: readonly string[] } {
  const { operatorName, additionalDisclosures } = compliance;
  return {
    operatorLine: operatorName
      ? interpolate(operatedByTemplate, { operator: operatorName[lang] })
      : null,
    items: additionalDisclosures[lang],
  };
}
