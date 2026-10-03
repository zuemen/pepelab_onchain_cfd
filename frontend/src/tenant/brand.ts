// 把 catalog 裡的品牌佔位符換成租戶的品牌。Node 端（vite.config.ts 填 index.html 標題）
// 與瀏覽器端（src/locales/index.ts）共用。
//
// catalog 裡平台名稱寫成 `{brand}`、品牌小圖示寫成 `{brandMark}`，其餘 `{token}` 原樣
// 留給呼叫端的 interpolate()。代換在載入時做一次，所以元件照舊 `t.x.y` 取字串，
// 不需要每個呼叫點都記得傳品牌。
//
// 只換「指稱平台本身」的地方。GameFi 的 PepeLab 扭蛋／PepeLab Rewards、合約名稱
// （PepeLabIncentives、PepeAMM）、Pepe 角色設定不是平台品牌，是功能或鏈上名稱，
// 保持原樣——它們由功能旗標決定出不出現。清單見 frontend/docs/adr/0009-tenant-config-layer.md。

import type { TenantConfig } from './schema';

// ----------------------------------------------------------------------

export type BrandVars = Pick<TenantConfig['brand'], 'name' | 'mark'>;

const BRAND_TOKENS = /\{(brand|brandMark)\}/g;

export function applyBrand(text: string, brand: BrandVars): string {
  return text.replace(BRAND_TOKENS, (_, token: string) =>
    token === 'brand' ? brand.name : brand.mark
  );
}

/**
 * 深層走訪 catalog（純資料：物件、陣列、字串），回傳代換過品牌的新物件。
 * 型別不變，所以 `t` 的型別仍是 Catalog。
 */
export function brandCatalog<T>(catalog: T, brand: BrandVars): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return applyBrand(node, brand);
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === 'object') {
      return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, walk(v)]));
    }
    return node;
  };
  return walk(catalog) as T;
}

/** brand.mascot 省略視為 true：只有明確寫 false 的租戶才拿掉吉祥物元素。 */
export function showsMascot(cfg: Pick<TenantConfig, 'brand'>): boolean {
  return cfg.brand.mascot !== false;
}
