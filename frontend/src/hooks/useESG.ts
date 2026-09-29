import { Contract } from 'ethers'
import { useState, useEffect } from 'react'

import { ASSET_IDS } from 'src/contracts/addresses'
import { safeRead, isDeployed } from 'src/lib/pepefi/safeRead'

export interface ESGInfo {
  environmental: number
  social:        number
  governance:    number
  composite:     number
  rating:        string
}

const ASSETS = [
  ASSET_IDS.sBTC,
  ASSET_IDS.sETH,
  ASSET_IDS.sAAPL,
  ASSET_IDS.sTSLA,
  ASSET_IDS.sGOLD,
  ASSET_IDS.sBOND,
  ASSET_IDS.sNVDA,
  ASSET_IDS.sMSFT,
  ASSET_IDS.sGOOGL,
  ASSET_IDS.sICLN,
  ASSET_IDS.sESGU,
]

export interface UseESGResult {
  data:   Record<string, ESGInfo>
  /** 這輪讀取已經結束（不論成功與否）。用來把 UI 從「載入中」推進到結論。 */
  loaded: boolean
  error:  boolean
  /** 本鏈根本沒有 ESGRegistry（位址 0x0）。和「讀失敗」是兩件事。 */
  unavailable: boolean
}

type ESGTuple = { environmental: bigint; social: bigint; governance: bigint; rating: string }
type MedianTuple = [bigint, bigint, bigint, bigint, boolean]

// Base Sepolia 的 addresses.ESGRegistry 指向的是 ESGRegistryV2——它沒有 V1 的
// getESG，只有 medianESG（見證人中位數）。舊版只打 getESG，於是 11 筆全部
// revert、ESG 頁雷達圖永遠「No data」。這裡對同一個位址補讀 medianESG。
const MEDIAN_ESG_ABI = [
  'function medianESG(bytes32) view returns (uint8 environmental, uint8 social, uint8 governance, uint256 count, bool isRated)',
  'function maxAttestationAge() view returns (uint256)',
]

/** V2 沒有存評等字串，由綜合分推導——門檻與 ESGPage 的 RATING_TABLE 一致。 */
export function ratingFor(composite: number): string {
  if (composite >= 80) return 'AAA'
  if (composite >= 70) return 'AA'
  if (composite >= 60) return 'A'
  if (composite >= 50) return 'BBB'
  if (composite >= 40) return 'BB'
  if (composite >= 30) return 'B'
  return 'CCC'
}

/**
 * 讀 ESGRegistry 的 11 檔評級。
 *
 * 兩個修正：
 *  1. **0x0 守衛**。Base Sepolia 上 ESGRegistry 是 0x0，舊版仍然對它串行發 11 次
 *     呼叫；每一次都在 hook 內部被 catch 吃掉，於是 `loaded` 永遠沒機會表達
 *     「這條鏈沒有 ESG」，Exchange 頁就卡在「ESG 資料載入中…」到天荒地老。
 *     現在直接回 `unavailable`，一次 RPC 都不發。
 *  2. **並行 + 逾時**。11 次 await 串起來，任何一次慢就整串慢；改成 allSettled +
 *     safeRead（8 秒逾時）。
 */
export function useESG(esgRegistry: Contract | null): UseESGResult {
  const [data,   setData]   = useState<Record<string, ESGInfo>>({})
  const [loaded, setLoaded] = useState(false)
  const [error,  setError]  = useState(false)
  const [unavailable, setUnavailable] = useState(false)

  useEffect(() => {
    if (!esgRegistry) return

    if (!isDeployed(esgRegistry.target)) {
      setData({})
      setUnavailable(true)
      setError(false)
      setLoaded(true)
      return
    }

    let cancelled = false
    setLoaded(false)
    setError(false)
    setUnavailable(false)

    const v2 = new Contract(esgRegistry.target, MEDIAN_ESG_ABI, esgRegistry.runner)

    // 先用 V2 才有的 maxAttestationAge() 判斷一次合約版本，之後每檔只打對的那個
    // 函式。舊版每檔先打一次注定 revert 的 getESG 再補 medianESG，11 檔變 22 筆
    // 同時經 MetaMask 的 RPC 送出，排在後面的幾檔會被限流、整頁永遠缺那幾格。
    const readV1 = async (id: string): Promise<ESGTuple | 'failed'> =>
      (await safeRead<ESGTuple | null>(esgRegistry.getESG(id) as Promise<ESGTuple>, null)) ?? 'failed'

    // null = 讀到了、但沒有新鮮見證（未評等）；'failed' = 讀取本身失敗，值得重試。
    const readV2 = async (id: string): Promise<ESGTuple | null | 'failed'> => {
      const m = await safeRead<MedianTuple | null>(v2.medianESG(id) as Promise<MedianTuple>, null)
      if (!m) return 'failed'
      if (!m[4]) return null
      const [environmental, social, governance] = m
      const composite = Math.round((Number(environmental) + Number(social) + Number(governance)) / 3)
      return { environmental, social, governance, rating: ratingFor(composite) }
    }

    void (async () => {
      const probe = await safeRead<bigint | null>(v2.maxAttestationAge() as Promise<bigint>, null)
      const isV2 = probe !== null
      const readOne = async (id: string) => {
        if (isV2) return readV2(id)
        const d = await readV1(id)
        // 探測本身失敗時不確定版本，V1 讀不到就再試 V2。
        return d === 'failed' ? readV2(id) : d
      }

      const results = new Map<string, ESGTuple | null | 'failed'>()
      let pending = ASSETS
      for (const delayMs of [0, 800, 2000]) {
        if (pending.length === 0 || cancelled) break
        if (delayMs) await new Promise(r => setTimeout(r, delayMs))
        const round = await Promise.all(pending.map(async id => ({ id, d: await readOne(id) })))
        for (const { id, d } of round) results.set(id, d)
        pending = round.filter(r => r.d === 'failed').map(r => r.id)
      }
      if (cancelled) return

      const out: Record<string, ESGInfo> = {}
      for (const [id, d] of results) {
        if (!d || d === 'failed') continue // 這檔沒有評級，或重試後仍讀取失敗
        const e = Number(d.environmental)
        const s = Number(d.social)
        const g = Number(d.governance)
        out[id] = {
          environmental: e,
          social:        s,
          governance:    g,
          composite:     Math.round((e + s + g) / 3),
          rating:        d.rating,
        }
      }
      setData(out)
      setLoaded(true)
      setError(Object.keys(out).length === 0)
    })()

    return () => { cancelled = true }
  }, [esgRegistry])

  return { data, loaded, error, unavailable }
}
