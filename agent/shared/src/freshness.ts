// 「這筆價格現在能不能拿來交易」的單一判準。
//
// 之前 getOracleSnapshot 用的是 MockOracle.isStale（24 小時），而
// PerpetualExchange 的 maxPriceAge 是 6 小時。落在兩者之間時，付費端點會回
// 「不 stale、建議做多」，買方的 agent 照做，然後開倉在鏈上 revert StalePrice。
// 付費 API 的判準必須是合約的判準。

export interface TradeFreshness {
  fresh: boolean;
  ageSec: number;
  maxPriceAgeSec: number;
}

export function classifyTradeFreshness(a: {
  updatedAtSec: number;
  nowSec: number;
  maxPriceAgeSec: number;
}): TradeFreshness {
  const ageSec = Math.max(0, a.nowSec - a.updatedAtSec);
  return {
    fresh: ageSec <= a.maxPriceAgeSec,
    ageSec,
    maxPriceAgeSec: a.maxPriceAgeSec,
  };
}
