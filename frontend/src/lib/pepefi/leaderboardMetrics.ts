// Marketplace 排行榜的指標推導——純函式,不含 fetch 或 ethers 呼叫。
//
// MarketplacePage 的 fetchAll() 負責打 RPC(查 PositionOpened/PositionClosed
// 事件、逐位交易者讀 registry/copyTracker/traderStake),推導完全交給這裡:
// 事件陣列 → volume/pnl 對照表,再加上逐位交易者已經抓回來的原始資料 →
// TraderCard。之後 TraderScore、勝率、7d 權益曲線等指標都加在這個模組裡。

export interface RawAlloc {
  asset:    string;
  weight:   bigint;
  isLong:   boolean;
  leverage: bigint;
}

export interface TraderCard {
  address:       string;
  displayName:   string;
  allocs:        RawAlloc[];
  followerCount: bigint;
  hasStrategy:   boolean;
  reputation:    bigint | null;
  stake:         bigint | null;
  totalSlashed:  bigint | null;
  totalVolume:   bigint;   // margin × leverage, last 7d
  pnl7d:         bigint;   // sum realizedPnL from PositionClosed, last 7d
}

/** registry.getLatestStrategy() 回傳的原始配置陣列 → RawAlloc[]。 */
export const parseAllocs = (arr: unknown[]): RawAlloc[] =>
  arr.map(a => {
    const x = a as { asset: string; weight: bigint; isLong: boolean; leverage: bigint };
    return { asset: x.asset, weight: x.weight, isLong: x.isLong, leverage: x.leverage };
  });

export interface OpenedEvent {
  owner:    string;
  margin:   bigint;
  leverage: bigint;
}

export interface ClosedEvent {
  owner: string;
  pnl:   bigint;
}

/**
 * PositionOpened 事件 → 每位交易者的成交量(margin × leverage)加總。
 * 事件查詢整批失敗時,呼叫端會降級傳入空陣列,這裡回傳空物件——
 * 下游用 `volumeMap[addr] ?? 0n` 取值,不會因為查無資料就崩潰或顯示 undefined。
 */
export const buildVolumeMap = (events: OpenedEvent[]): Record<string, bigint> => {
  const map: Record<string, bigint> = {};
  for (const e of events) {
    const owner = e.owner.toLowerCase();
    map[owner] = (map[owner] ?? 0n) + e.margin * e.leverage;
  }
  return map;
};

/** PositionClosed 事件 → 每位交易者的已實現損益加總(可正可負)。 */
export const buildPnlMap = (events: ClosedEvent[]): Record<string, bigint> => {
  const map: Record<string, bigint> = {};
  for (const e of events) {
    const owner = e.owner.toLowerCase();
    map[owner] = (map[owner] ?? 0n) + e.pnl;
  }
  return map;
};

/** 逐位交易者從 registry/copyTracker/traderStake 抓回來、尚未併入事件指標的原始資料。 */
export interface TraderRawInput {
  address:       string;
  displayName:   string;
  allocs:        RawAlloc[];
  followerCount: bigint;
  reputation:    bigint | null;
  stake:         bigint | null;
  totalSlashed:  bigint | null;
}

/**
 * 把逐位交易者的原始資料與事件推導出的 volume/pnl 對照表組成最終的
 * TraderCard。`hasStrategy` 在這裡統一由 allocs 是否非空推導,呼叫端不用
 * 再自己維護一份布林值。
 */
export const buildTraderCard = (
  input:     TraderRawInput,
  volumeMap: Record<string, bigint>,
  pnlMap:    Record<string, bigint>,
): TraderCard => {
  const key = input.address.toLowerCase();
  return {
    ...input,
    hasStrategy: input.allocs.length > 0,
    totalVolume: volumeMap[key] ?? 0n,
    pnl7d:       pnlMap[key]    ?? 0n,
  };
};
