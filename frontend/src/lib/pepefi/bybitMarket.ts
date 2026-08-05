// Bybit 公開行情（訂單簿 / 近期成交）的瀏覽器端 client。
//
// 為什麼不像 K 線那樣走自家後端：訂單簿要 1 秒一次才有意義，把那個流量打在
// serverless function 上既慢又貴。Bybit 的公開端點 CORS 全開（實測會回應
// access-control-allow-origin），瀏覽器可以直連，延遲也低得多。
//
// 出處一樣要標——這是 Bybit 的盤口，不是本平台的。本平台是 oracle 計價永續，
// 根本沒有自己的掛單簿。

const HOST = 'https://api.bybit.com'

/**
 * 合成資產 → Bybit 永續 symbol。
 *
 * 只有加密貨幣有盤口可對照；股票 / ETF / 商品在 Bybit 上沒有對應合約，呼叫端
 * 拿到 undefined 時要改顯示鏈上的 OI / funding，而不是硬湊一個假盤口。
 *
 * 後端 agent/signal-api/src/symbols.ts 有同一份對應（那裡還多了 Coinbase 與
 * Yahoo）。兩份是刻意的：後端那份是伺服器才需要的知識（含備援來源），這裡只需要
 * 瀏覽器直連的那一個。真要合併應該讓 /candles 回傳 exchange symbol，之後再說。
 */
const BYBIT_SYMBOL: Record<string, string> = {
  sBTC: 'BTCUSDT',
  sETH: 'ETHUSDT',
}

export function bybitSymbolFor(assetSymbol?: string): string | undefined {
  return assetSymbol ? BYBIT_SYMBOL[assetSymbol] : undefined
}

/** [價格, 數量]，皆為字串。 */
export interface BookLevel {
  price: number
  size: number
  /** 由最佳價往外累加的總量，用來畫深度背景條。 */
  total: number
}

export interface OrderBookSnapshot {
  bids: BookLevel[]
  asks: BookLevel[]
  /** 最佳買賣價中點。 */
  mid?: number
  spread?: number
  spreadPct?: number
}

export interface PublicTrade {
  id: string
  price: number
  size: number
  /** Buy = 主動買進（吃掉賣單）。 */
  side: 'Buy' | 'Sell'
  time: number
}

async function get(url: string, signal?: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal })
  if (!res.ok) throw new Error(`Bybit 回 ${res.status}`)
  const json = (await res.json()) as { retCode?: number; retMsg?: string; result?: unknown }
  // HTTP 200 不代表成功——symbol 打錯照樣 200，錯誤在 body 的 retCode。
  if (json.retCode !== 0) throw new Error(json.retMsg ?? `retCode ${json.retCode}`)
  return json.result
}

function toLevels(raw: [string, string][] | undefined, desc: boolean): BookLevel[] {
  if (!raw?.length) return []
  const rows = raw
    .map(([p, s]) => ({ price: Number(p), size: Number(s), total: 0 }))
    .filter((l) => Number.isFinite(l.price) && Number.isFinite(l.size) && l.price > 0)
  // 防禦性排序：買方由高到低、賣方由低到高。Bybit 目前就是這個順序，但深度條
  // 的累加值一旦排錯會整個反過來，成本太高不值得賭。
  rows.sort((a, b) => (desc ? b.price - a.price : a.price - b.price))
  let running = 0
  for (const l of rows) {
    running += l.size
    l.total = running
  }
  return rows
}

export async function fetchOrderBook(
  symbol: string,
  limit = 25,
  signal?: AbortSignal,
): Promise<OrderBookSnapshot> {
  const result = (await get(
    `${HOST}/v5/market/orderbook?category=linear&symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
    signal,
  )) as { b?: [string, string][]; a?: [string, string][] }

  const bids = toLevels(result.b, true)
  const asks = toLevels(result.a, false)
  const bestBid = bids[0]?.price
  const bestAsk = asks[0]?.price
  const mid = bestBid && bestAsk ? (bestBid + bestAsk) / 2 : undefined
  const spread = bestBid && bestAsk ? bestAsk - bestBid : undefined

  return {
    bids,
    asks,
    mid,
    spread,
    spreadPct: spread && mid ? (spread / mid) * 100 : undefined,
  }
}

export async function fetchRecentTrades(
  symbol: string,
  limit = 30,
  signal?: AbortSignal,
): Promise<PublicTrade[]> {
  const result = (await get(
    `${HOST}/v5/market/recent-trade?category=linear&symbol=${encodeURIComponent(symbol)}&limit=${limit}`,
    signal,
  )) as {
    list?: { execId: string; price: string; size: string; side: string; time: string }[]
  }

  return (result.list ?? [])
    .map((t) => ({
      id: t.execId,
      price: Number(t.price),
      size: Number(t.size),
      side: (t.side === 'Buy' ? 'Buy' : 'Sell') as 'Buy' | 'Sell',
      time: Number(t.time),
    }))
    .filter((t) => Number.isFinite(t.price) && t.price > 0)
}

export const BYBIT_ATTRIBUTION = 'Bybit 永續合約公開盤口 · 非本平台掛單'
