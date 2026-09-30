import { useState, useEffect } from 'react'

import { useContracts } from 'src/hooks/useContracts'
import { safeRead } from 'src/lib/pepefi/safeRead'
import { useWalletContext } from 'src/contexts/wallet-context'
import { ASSET_IDS, getAddresses } from 'src/contracts/addresses'
import { type LivePrice, buildLivePrices, emptyLivePrices } from 'src/lib/pepefi/livePrices'

import { FALLBACK_MAX_PRICE_AGE_SEC } from 'src/lib/pepefi/priceFreshness'

/**
 * 輪詢間隔。
 *
 * 舊值是 8 秒，而每一輪要對 11 個資產「串行」讀 oracle，加上 maxPriceAge、
 * 再加上頁面自己的其他輪詢——公共 RPC 端點會直接限流。喂價本身是 keeper 幾分鐘
 * 才更新一次，8 秒的解析度沒有任何意義。30 秒足夠，而且分頁在背景時完全不打。
 */
const POLL_MS = 30_000

/** 單筆鏈上讀取的逾時。全站唯一沒有 timeout 的讀取迴圈就是這裡，補上。 */
const READ_TIMEOUT_MS = 6_000

const isPageVisible = () =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden'

// Display-only live quotes from the free, keyless CoinGecko simple-price API.
// These keep the UI alive even when the on-chain keeper is idle. Settlement
// (open/close/liquidation) always uses the on-chain oracle — see `settlementUsd`.
const COINGECKO_IDS: Record<string, string> = {
  [ASSET_IDS.sBTC]: 'bitcoin',
  [ASSET_IDS.sETH]: 'ethereum',
}

export type { LivePrice, PriceSource } from 'src/lib/pepefi/livePrices'

/** Fetch free CoinGecko spot prices for the display-tracked crypto ids + PEPE. */
async function fetchCoinGecko(pepeAddr?: string | null): Promise<Record<string, number>> {
  const ids = [...new Set([...Object.values(COINGECKO_IDS), ...(pepeAddr ? ['pepe'] : [])])]
  const out: Record<string, number> = {}
  try {
    const res = await fetch(
      `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`,
    )
    if (!res.ok) return out
    const json = await res.json()
    for (const [assetId, cgId] of Object.entries(COINGECKO_IDS)) {
      if (json[cgId]?.usd) out[assetId] = json[cgId].usd
    }
    if (pepeAddr && json.pepe?.usd) out[pepeAddr] = json.pepe.usd
  } catch {
    /* offline / rate-limited → caller falls back to oracle, or no price at all */
  }
  return out
}

export function useLivePrices(): Record<string, LivePrice> {
  const { provider, signer, chainId } = useWalletContext()
  const contracts = useContracts(provider, signer, chainId)

  const addr = getAddresses(chainId)
  const pepeAddr = addr?.PepeToken ? addr.PepeToken.toLowerCase() : null

  // 第一次輪詢之前：每個標的都是「無價格」（usd = null、freshness unknown ⇒ 擋單）。
  // 以前這裡先塞一份隨機抖動的模擬價，使用者會先看到一閃而過的假數字。
  const [prices, setPrices] = useState<Record<string, LivePrice>>(() =>
    emptyLivePrices(Object.values(ASSET_IDS), pepeAddr),
  )

  useEffect(() => {
    if (!pepeAddr) return
    setPrices(prev => (prev[pepeAddr] ? prev : { ...prev, ...emptyLivePrices([], pepeAddr) }))
  }, [pepeAddr])

  useEffect(() => {
    let cancelled = false

    const tick = async () => {
      // 1) Free, keyless display quotes (crypto + PEPE) — always tries to be live.
      const cg = await fetchCoinGecko(pepeAddr)
      const nowSec = Math.floor(Date.now() / 1000)

      // 交易所自己的 maxPriceAge 才是「可不可以交易」的真相 —— 顯示價來自
      // CoinGecko，但結算走鏈上 oracle，兩者過期與否由合約說了算。
      const assetIds = Object.values(ASSET_IDS)

      // maxPriceAge 與 11 個資產的 oracle 讀取一次全部併發送出。舊版是 12 次
      // 串行 await：任何一次慢，整輪就跟著慢，而且每輪要花 12 個 RTT。
      const [maxAgeRaw, oracleRaw] = await Promise.all([
        contracts?.exchange
          ? safeRead<bigint | null>(contracts.exchange.maxPriceAge() as Promise<bigint>, null, READ_TIMEOUT_MS)
          : Promise.resolve(null),
        Promise.all(
          assetIds.map(id =>
            contracts?.oracle
              ? safeRead<[bigint, bigint] | null>(
                  contracts.oracle.getPrice(id) as unknown as Promise<[bigint, bigint]>,
                  null,
                  READ_TIMEOUT_MS,
                )
              : Promise.resolve(null),
          ),
        ),
      ])

      // 舊部署沒有這個 getter、或讀取逾時 → 保留後備值。
      const maxPriceAgeSec = maxAgeRaw === null ? FALLBACK_MAX_PRICE_AGE_SEC : Number(maxAgeRaw)

      const next = buildLivePrices({
        assetIds,
        cg,
        oracleRaw,
        maxPriceAgeSec,
        nowSec,
        pepeAddr,
      })

      if (!cancelled) setPrices(next)
    }

    void tick()

    // 分頁不在前景時完全不輪詢——沒人在看的頁面不該持續消耗 RPC 配額。
    // 切回前景時立刻補一次，使用者不會看到過期的畫面。
    const id = setInterval(() => { if (isPageVisible()) void tick() }, POLL_MS)
    const onVisible = () => { if (isPageVisible()) void tick() }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [contracts, pepeAddr])

  return prices
}
