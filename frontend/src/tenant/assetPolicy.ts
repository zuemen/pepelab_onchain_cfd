// 租戶的資產白名單：哪些資產可以**新開**部位／買進／委任給 agent。
//
// 規則只有一條，而且刻意不對稱：
//   - 進場（開倉、買進、採用配置、agent session 可交易資產）→ 只允許白名單內的資產。
//   - 出場（平倉、贖回／賣出）→ **永遠不看白名單**。
//
// 一個資產從白名單移除時，已經持有它的使用者必須還看得到、還出得去。把出場也擋住，
// 等於用一個前端設定把別人的錢鎖在看不到的地方——跟 Reserve Ratio 不擋贖回、功能旗標
// 不擋既有跟單取消是同一個原則（frontend/CONTEXT.md、featureFlags.ts）。
//
// 這是**顯示層與送單前**的政策，不是安全邊界：合約不知道有租戶，任何人都可以繞過
// 前端直接呼叫合約。真正的隔離是每個租戶一套合約（docs/ADR-008-tenant-isolation.md）；
// 在那之前，這層確保的是「照著機構自己的站操作的使用者，不會在上面開到機構沒上架的資產」。

import type { TenantConfig } from './schema';

import { ASSET_IDS, type AssetSymbol } from '../contracts/addresses';

// ----------------------------------------------------------------------

export interface AssetPolicy {
  /** 白名單內的資產代號，依 ASSET_IDS 的順序。 */
  readonly enabledSymbols: readonly AssetSymbol[];
  /** 這個資產（代號或 bytes32 asset id，大小寫不敏感）可以新開部位／買進嗎？ */
  canOpen(symbolOrId: string): boolean;
  /** 從清單中留下可以新開部位的項目（交易頁的可選資產）。 */
  selectable<T extends { id: string }>(list: readonly T[]): T[];
}

const ID_TO_SYMBOL: ReadonlyMap<string, AssetSymbol> = new Map(
  (Object.entries(ASSET_IDS) as [AssetSymbol, string][]).map(([sym, id]) => [id.toLowerCase(), sym])
);

function toSymbol(symbolOrId: string): AssetSymbol | null {
  if (symbolOrId in ASSET_IDS) return symbolOrId as AssetSymbol;
  return ID_TO_SYMBOL.get(symbolOrId.toLowerCase()) ?? null;
}

export function makeAssetPolicy(tenant: Pick<TenantConfig, 'assets'>): AssetPolicy {
  const all = Object.keys(ASSET_IDS) as AssetSymbol[];
  const allowed: ReadonlySet<AssetSymbol> =
    tenant.assets.enabled === 'all' ? new Set(all) : new Set(tenant.assets.enabled);
  const enabledSymbols = all.filter((s) => allowed.has(s));

  const canOpen = (symbolOrId: string): boolean => {
    const sym = toSymbol(symbolOrId);
    // 不認得的資產一律不給開——fail-closed。
    return sym !== null && allowed.has(sym);
  };

  return {
    enabledSymbols,
    canOpen,
    selectable: (list) => list.filter((item) => canOpen(item.id)),
  };
}

/**
 * 代幣化資產表（/tokens）的列套用白名單：
 *   - 白名單內：原樣保留。
 *   - 白名單外但有持倉：保留，買進關閉，**賣出（canSell）原樣不動**。
 *   - 白名單外且沒有持倉：不顯示。
 */
export function applyAssetWhitelist<
  R extends { symbol: string; balance: bigint; canBuy: boolean; canSell: boolean },
>(rows: readonly R[], policy: AssetPolicy): (R & { enabled: boolean })[] {
  return rows.flatMap((row): (R & { enabled: boolean })[] => {
    const enabled = policy.canOpen(row.symbol);
    if (enabled) return [{ ...row, enabled }];
    if (row.balance > 0n) return [{ ...row, enabled, canBuy: false }];
    return [];
  });
}

/** 為什麼這筆**新開**永續部位要被租戶政策擋下；null = 不擋。平倉永遠不經過這裡。 */
export type PerpetualOpenBlock = 'perpetualsNotAuthorized' | 'assetNotEnabled' | null;

export function perpetualOpenBlock(
  policy: AssetPolicy,
  perpetualsAuthorized: boolean,
  assetId: string
): PerpetualOpenBlock {
  if (!perpetualsAuthorized) return 'perpetualsNotAuthorized';
  if (!policy.canOpen(assetId)) return 'assetNotEnabled';
  return null;
}

/**
 * agent session 的預設可交易資產：`preferred` 中在白名單內的；一個都不在就用白名單第一檔。
 * 回傳值永不為空——合約把空陣列當成「全部允許」。
 */
export function sessionAssetsForTenant(
  policy: AssetPolicy,
  preferred: readonly string[]
): string[] {
  const kept = preferred.filter((id) => policy.canOpen(id));
  if (kept.length > 0) return kept;
  return [ASSET_IDS[policy.enabledSymbols[0]]];
}
