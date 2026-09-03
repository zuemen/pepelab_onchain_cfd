// 合成資產 → 外部行情來源的對照表。
//
// 這份 mapping 原本只存在於 .github/workflows/price-keeper.yml 的 bash 裡
// （sGOLD 對 GC=F、sBOND 對 BGRN 這種不直觀的對應），keeper 以外沒有人看得到。
// K 線 API 需要同一份對應，複製第二份遲早會走鐘，所以在這裡建立單一來源；
// keeper 之後要收斂過來也有東西可以指。
//
// 為什麼不直接吃 frontend 的 assetMeta.ts：那份只有分類與顯示用的中文名，
// 沒有「這個標的在 Coinbase / Yahoo 叫什麼」。feed 對應是後端專屬的知識。

import { ASSET_IDS, symbolOfAssetId } from "@pepelab/shared";

export type AssetCategory = "crypto" | "equity" | "etf" | "commodity" | "bond";

export interface MarketMeta {
  /** 平台內的合成資產代號，如 sBTC。 */
  symbol: string;
  /** 對應的真實標的名稱，出處標示會顯示這個。 */
  underlying: string;
  category: AssetCategory;
  /**
   * Bybit 永續合約的 symbol；加密貨幣的 **fallback** 來源。
   *
   * 曾經是首選，理由是「我們賣的就是永續」。平台改以代幣化 RWA 現貨為門面之後
   * 首選換成 Coinbase 現貨（見 candles.ts 的來源順序），永續退居備援——它仍然
   * 有價值：Coinbase 掛掉時，有永續 K 線總比只剩模擬資料好。
   */
  bybit?: string;
  /** Coinbase Exchange 的 product_id；加密貨幣的**首選**來源（現貨）。 */
  coinbase?: string;
  /** Yahoo Finance 的 ticker；股票 / ETF / 商品 / 債券走這個。 */
  yahoo?: string;
  /** 所有外部來源都掛掉時，模擬資料的起點價（與 MockOracle 初始價一致）。 */
  seed: number;
}

export const MARKETS: Record<string, MarketMeta> = {
  sBTC: {
    symbol: "sBTC",
    underlying: "BTC Spot",
    category: "crypto",
    bybit: "BTCUSDT",
    coinbase: "BTC-USD",
    seed: 50_000,
  },
  sETH: {
    symbol: "sETH",
    underlying: "ETH Spot",
    category: "crypto",
    bybit: "ETHUSDT",
    coinbase: "ETH-USD",
    seed: 3_000,
  },
  sAAPL: {
    symbol: "sAAPL",
    underlying: "AAPL",
    category: "equity",
    yahoo: "AAPL",
    seed: 200,
  },
  sTSLA: {
    symbol: "sTSLA",
    underlying: "TSLA",
    category: "equity",
    yahoo: "TSLA",
    seed: 250,
  },
  sNVDA: {
    symbol: "sNVDA",
    underlying: "NVDA",
    category: "equity",
    yahoo: "NVDA",
    seed: 135,
  },
  sMSFT: {
    symbol: "sMSFT",
    underlying: "MSFT",
    category: "equity",
    yahoo: "MSFT",
    seed: 420,
  },
  sGOOGL: {
    symbol: "sGOOGL",
    underlying: "GOOGL",
    category: "equity",
    yahoo: "GOOGL",
    seed: 175,
  },
  sGOLD: {
    // 黃金走 COMEX 期貨連續合約，不是現貨 XAU/USD——keeper 也是用這個，
    // 兩邊必須一致，否則 oracle 價與圖表價會系統性差一個基差。
    symbol: "sGOLD",
    underlying: "GC=F (COMEX Gold Futures)",
    category: "commodity",
    yahoo: "GC=F",
    seed: 2_650,
  },
  sBOND: {
    // #106：追蹤標的從 TLT（美國公債，無可稽核碳強度來源）換成 BGRN
    // （iShares USD Green Bond ETF，持股公開揭露）。symbol 保留 sBOND——
    // 它是「合成債券曝險」的通稱，換 symbol 會連鎖動到 keccak 出來的 assetId
    // 與四合約重接線；#102 的重部署直接以新的 BGRN 餵價註冊同一個 id。
    symbol: "sBOND",
    underlying: "BGRN (iShares USD Green Bond ETF)",
    category: "bond",
    yahoo: "BGRN",
    seed: 48,
  },
  sICLN: {
    symbol: "sICLN",
    underlying: "ICLN",
    category: "etf",
    yahoo: "ICLN",
    seed: 14,
  },
  sESGU: {
    symbol: "sESGU",
    underlying: "ESGU",
    category: "etf",
    yahoo: "ESGU",
    seed: 120,
  },
};

export const MARKET_SYMBOLS = Object.keys(MARKETS);

/**
 * 把路由參數解析成 MarketMeta。
 *
 * 三種寫法都收：`sBTC`、`btc`（省略 s 前綴、不分大小寫）、以及鏈上的 bytes32
 * assetId。前端的 `selAsset` 拿在手上的是 bytes32，逼它先轉回代號只是把
 * 對照表的責任推給呼叫端。
 */
export function resolveMarket(raw: string): MarketMeta | undefined {
  const input = raw.trim();
  if (!input) return undefined;

  // bytes32 assetId
  if (input.startsWith("0x") && input.length === 66) {
    const sym = symbolOfAssetId(input);
    return sym ? MARKETS[sym] : undefined;
  }

  if (MARKETS[input]) return MARKETS[input];

  const lower = input.toLowerCase();
  for (const meta of Object.values(MARKETS)) {
    if (meta.symbol.toLowerCase() === lower) return meta;
    // "btc" → sBTC
    if (meta.symbol.toLowerCase() === `s${lower}`) return meta;
  }
  return undefined;
}

/** 代號 → 鏈上 assetId；回應裡一起帶上，前端不必再查一次。 */
export function assetIdFor(symbol: string): string | undefined {
  return (ASSET_IDS as Record<string, string>)[symbol];
}
