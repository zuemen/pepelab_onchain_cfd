// 已換下來、但上面還有 active 跟單的 CopyTracker（ADR-024、OWNER_ACTIONS 第 8 步）。
//
// 換 tracker 只撤銷舊 tracker 在交易所的「代為開平倉」授權：舊 tracker 上的跟單紀錄還在，部位也一直在
// 跟隨者自己名下（Portfolio 的「部位」頁籤看得到、平得掉）。這些人仍然照著交易者的某一版在跟，只是
// 不會自動同步、取消時不再經過 tracker 計分（只能 deactivateWithoutScoring）。排行榜與交易者頁的
// 「目前跟隨人數」因此把它們也算進去，並分開標示「其中幾位是舊版跟單」——不算的話，換 tracker 那一刻
// 所有交易者的跟隨人數會同時歸零，看起來像所有人都取消了。
//
// 只收部位開在**現行交易所**的舊 tracker。更早的 tracker 綁的是已退役的交易所，那些部位在 /legacy 處理
// （legacyExchanges.ts），不算在現行交易者的跟隨人數裡。
//
// 位址一律來自這裡的常數。換 tracker 時把被換下來的那一顆加進來（不是刪掉）。

export interface LegacyCopyTracker {
  chainId: number;
  address: string;
  /** 在 addresses.ts 上線的日期（YYYY-MM-DD）。 */
  activeFrom: string;
  /** 被新 tracker 取代的日期（YYYY-MM-DD）。 */
  activeUntil: string;
}

export const LEGACY_COPY_TRACKERS: readonly LegacyCopyTracker[] = [
  // #344 cutover（docs/CUTOVER_LOG_2026-10-20.md）部署的快照版，2026-10-26 由自動同步版取代
  // （docs/CUTOVER_LOG_2026-10-26.md）。綁現行交易所 0xbF30…C979。
  {
    chainId: 84532,
    address: '0x15A9Cbf803a3EEee2794B74Ad78252d27Ccd347C',
    activeFrom: '2026-10-21',
    activeUntil: '2026-10-26',
  },
];

/** 這條鏈上要一併讀的舊 tracker；跳過現行那一顆（換 tracker 之前它就是現行的，不能算兩次）。 */
export function legacyCopyTrackersFor(chainId: number | null, current: string | null): string[] {
  if (chainId === null) return [];
  const cur = current?.toLowerCase() ?? null;
  return LEGACY_COPY_TRACKERS
    .filter((t) => t.chainId === chainId && t.address.toLowerCase() !== cur)
    .map((t) => t.address);
}

/** 讀跟隨者只需要這三個 view；舊 tracker 沒有自動同步的函式，不用完整 ABI。 */
export const LEGACY_COPY_TRACKER_ABI = [
  'function getFollowerCount(address trader) view returns (uint256)',
  'function followersByTrader(address trader, uint256 index) view returns (address)',
  'function getCopyRecords(address follower) view returns ((address trader, uint256 versionId, uint256 initialAmount, uint256[] positionIds, uint256 copiedAt, bool active, uint256 deployedAmount)[])',
] as const;
