// Marketplace 排行榜的指標推導——純函式,不含 fetch 或 ethers 呼叫。
//
// MarketplacePage 的 fetchAll() 負責打 RPC(查 PositionOpened/PositionClosed
// 事件、逐位交易者讀 registry/copyTracker/traderStake),推導完全交給這裡:
// 事件陣列 → volume/pnl/勝率/權益曲線/TraderScore 對照表,再加上逐位交易者
// 已經抓回來的原始資料 → TraderCard。

export interface RawAlloc {
  asset:    string;
  weight:   bigint;
  isLong:   boolean;
  leverage: bigint;
}

export interface TraderCard {
  address:        string;
  displayName:    string;
  allocs:         RawAlloc[];
  followerCount:  bigint;
  hasStrategy:    boolean;
  reputation:     bigint | null;
  stake:          bigint | null;
  totalSlashed:   bigint | null;
  totalVolume:    bigint;   // margin × leverage, last 7d
  pnl7d:          bigint;   // sum realizedPnL from PositionClosed, last 7d
  marginDeployed: bigint;   // 7d 投入保證金(不含槓桿放大)——TraderScore 報酬率的分母
  wins:           number;   // PositionClosed 中 pnl>0 的筆數,last 7d
  trades:         number;   // PositionClosed 總筆數,last 7d
  /** 依平倉時序累加的損益。少於 2 筆平倉時為空陣列——沒有方向可言,不畫線。 */
  equityCurve:    bigint[];
  score:          TraderScoreBreakdown;
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

/**
 * PositionOpened 事件 → 每位交易者「投入的保證金」加總,不像 buildVolumeMap
 * 那樣乘上槓桿。TraderScore 的報酬率算的是「賺了本金的幾成」,分母要用本金
 * 本身,用槓桿放大過的名目曝險當分母會把高槓桿的人的報酬率算得虛高。
 */
export const buildMarginMap = (events: OpenedEvent[]): Record<string, bigint> => {
  const map: Record<string, bigint> = {};
  for (const e of events) {
    const owner = e.owner.toLowerCase();
    map[owner] = (map[owner] ?? 0n) + e.margin;
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

/**
 * PositionClosed 事件依 owner 分組,組內保留原始順序(ethers queryFilter
 * 依區塊由舊到新回傳)。勝率、權益曲線都是對「這一個人的平倉序列」算的,
 * 先分組才有得算。
 */
export const groupClosedEventsByOwner = (events: ClosedEvent[]): Record<string, ClosedEvent[]> => {
  const map: Record<string, ClosedEvent[]> = {};
  for (const e of events) {
    const owner = e.owner.toLowerCase();
    if (!map[owner]) map[owner] = [];
    map[owner].push(e);
  }
  return map;
};

export interface WinRate {
  wins:   number;
  trades: number;
}

/** 勝率 = pnl>0 的筆數 / 總平倉筆數。0 筆平倉時 wins/trades 都是 0,不是 0/0 的 NaN。 */
export const computeWinRate = (events: ClosedEvent[]): WinRate => ({
  trades: events.length,
  wins:   events.filter(e => e.pnl > 0n).length,
});

/**
 * 損益依原始(=依區塊時間)順序累加成權益曲線。少於 2 筆平倉給空陣列——
 * 呼叫端據此決定要不要留白,不畫一條只有單點、會被誤讀成「持平」的線。
 */
export const computeEquityCurve = (events: ClosedEvent[]): bigint[] => {
  if (events.length < 2) return [];
  let running = 0n;
  return events.map(e => (running += e.pnl));
};

// ── TraderScore ──────────────────────────────────────────────────────────────
// 0-100 的複合分數,五項全部從已經抓到的事件資料算得出來,不必多打一次 RPC。
// 配分:報酬率 40 / 勝率 25 / 質押 20 / 聲譽 15,罰沒扣到 -20。
//
// 每一項都回傳「實際數值」與「拿到幾分」,不是只有最終總分——UI 要把這位
// 交易者自己的算式攤開給人看(見 ScoreBreakdown popover),而不是展示一條
// 看不出怎麼代入的公式。

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

const RETURN_SATURATION_PCT = 20;   // 7 天報酬率達 20% 就拿滿 40 分,再高不加碼
const STAKE_FOR_MAX_SCORE   = 5_000; // 質押滿 5,000(完整代幣單位)拿滿 20 分
const MIN_TRADES_FOR_TRUST  = 5;     // 平倉少於這個數,勝率不可信,標「資料不足」

export interface TraderScoreInput {
  pnl7d:          bigint;
  marginDeployed: bigint;
  wins:           number;
  trades:         number;
  stake:          bigint | null;
  reputation:     bigint | null;
  totalSlashed:   bigint | null;
}

export interface TraderScoreBreakdown {
  total:              number; // 0-100,五項加總後 clamp
  insufficientSample: boolean; // trades < 5,勝率不可信

  returnPct:    number | null; // pnl7d / marginDeployed,百分比;沒有投入保證金時為 null
  returnScore:  number;        // 0-40

  winRate:      number | null; // wins/trades;0 筆平倉時為 null
  winRateScore: number;        // 0-25

  stakeAmount:  number;        // 質押量,完整代幣單位
  stakeScore:   number;        // 0-20

  reputationValue: number;     // 0-100,沒讀到時當 0
  reputationScore: number;     // 0-15

  slashRatio:   number;        // totalSlashed/stake,clamp 在 0-1
  slashPenalty: number;        // 0 到 -20
}

export const computeTraderScore = (input: TraderScoreInput): TraderScoreBreakdown => {
  const marginNum = Number(input.marginDeployed) / 1e18;
  const returnPct = marginNum > 0 ? (Number(input.pnl7d) / 1e18 / marginNum) * 100 : null;
  const returnScore = returnPct === null
    ? 0
    : clamp(returnPct, 0, RETURN_SATURATION_PCT) / RETURN_SATURATION_PCT * 40;

  const winRate = input.trades > 0 ? input.wins / input.trades : null;
  const winRateScore = winRate === null ? 0 : winRate * 25;

  const stakeAmount = input.stake !== null ? Number(input.stake) / 1e18 : 0;
  const stakeScore = clamp(stakeAmount / STAKE_FOR_MAX_SCORE, 0, 1) * 20;

  const reputationValue = input.reputation !== null ? Number(input.reputation) : 0;
  const reputationScore = clamp(reputationValue, 0, 100) / 100 * 15;

  const slashRatio = input.stake !== null && input.stake > 0n && input.totalSlashed !== null
    ? clamp(Number(input.totalSlashed) / Number(input.stake), 0, 1)
    : (input.totalSlashed !== null && input.totalSlashed > 0n ? 1 : 0);
  const slashPenalty = -slashRatio * 20;

  const total = clamp(returnScore + winRateScore + stakeScore + reputationScore + slashPenalty, 0, 100);

  return {
    total,
    insufficientSample: input.trades < MIN_TRADES_FOR_TRUST,
    returnPct, returnScore,
    winRate, winRateScore,
    stakeAmount, stakeScore,
    reputationValue, reputationScore,
    slashRatio, slashPenalty,
  };
};

/**
 * TraderScore 總分 → Chip 色階,跟 MarketplacePage 裡聲譽分用的門檻(80/60)
 * 是同一組,兩種分數雖然算法不同,但「多高算好」對使用者該是同一套直覺。
 */
export const scoreChipColor = (total: number): 'success' | 'warning' | 'error' =>
  total >= 80 ? 'success' : total >= 60 ? 'warning' : 'error';

/** 「+2.1k」/「-340.0」的形式——符號永遠顯示,千位用 k 縮寫。表格跟領獎台卡片共用。 */
export const fPnL = (v: bigint): string => {
  const n = Number(v) / 1e18;
  const prefix = n >= 0 ? '+' : '';
  if (Math.abs(n) >= 1_000) return prefix + (n / 1_000).toFixed(1) + 'k';
  return prefix + n.toFixed(1);
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

/** fetchAll() 打完事件查詢後一次算出來的所有對照表,buildTraderCard 逐位交易者查表用。 */
export interface TraderEventAggregates {
  volumeMap:           Record<string, bigint>;
  marginMap:           Record<string, bigint>;
  pnlMap:              Record<string, bigint>;
  closedEventsByOwner: Record<string, ClosedEvent[]>;
}

/**
 * 把逐位交易者的原始資料與事件推導出的對照表組成最終的 TraderCard。
 * `hasStrategy` 在這裡統一由 allocs 是否非空推導,呼叫端不用再自己維護一份
 * 布林值;wins/trades/equityCurve/score 都在這裡一次算好,呼叫端不用知道
 * TraderScore 怎麼算的。
 */
export const buildTraderCard = (
  input:      TraderRawInput,
  aggregates: TraderEventAggregates,
): TraderCard => {
  const key = input.address.toLowerCase();
  const closedEvents  = aggregates.closedEventsByOwner[key] ?? [];
  const { wins, trades } = computeWinRate(closedEvents);
  const pnl7d          = aggregates.pnlMap[key]    ?? 0n;
  const totalVolume    = aggregates.volumeMap[key] ?? 0n;
  const marginDeployed = aggregates.marginMap[key] ?? 0n;

  return {
    ...input,
    hasStrategy: input.allocs.length > 0,
    totalVolume,
    pnl7d,
    marginDeployed,
    wins,
    trades,
    equityCurve: computeEquityCurve(closedEvents),
    score: computeTraderScore({
      pnl7d,
      marginDeployed,
      wins,
      trades,
      stake:        input.stake,
      reputation:   input.reputation,
      totalSlashed: input.totalSlashed,
    }),
  };
};

// ── 排行榜表格用的排序/篩選 ─────────────────────────────────────────────────
// 表格式排行榜(#85)把「怎麼比較兩個 bigint」跟「使用者打的搜尋字要怎麼比對」
// 從 MarketplacePage 搬到這裡:同一批純函式,同一套測試覆蓋。

/** 大到小排序,平手不改變相對順序。 */
export const cmpBigDesc = (a: bigint, b: bigint): number =>
  a === b ? 0 : b > a ? 1 : -1;

/**
 * 兩個都可能沒讀到的 bigint 欄位(聲譽、質押)共用同一種排序:有資料的在前,
 * 沒資料的一律墊底,不當成 0——0n 是「質押了 0」,null 是「根本沒讀到」,
 * 排序上不能混為一談。
 */
export const cmpNullableBigDesc = (a: bigint | null, b: bigint | null): number => {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return cmpBigDesc(a, b);
};

/** 名稱或地址子字串比對,大小寫不敏感。空白查詢(含只有空白)永遠放行。 */
export const matchesSearch = (trader: Pick<TraderCard, 'displayName' | 'address'>, query: string): boolean => {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return trader.displayName.toLowerCase().includes(needle) || trader.address.toLowerCase().includes(needle);
};
