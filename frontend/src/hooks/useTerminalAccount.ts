import { useState, useEffect, useCallback } from 'react'

import { safeRead } from 'src/lib/pepefi/safeRead'
import { type OpenPositionRead, readOpenPosition } from 'src/lib/pepefi/positionPnl'
import type { AssetId, Pos } from 'src/sections/terminal/types'

// 終端機的鏈上帳戶狀態：餘額、可用保證金、持倉，以及選中標的的 index / mark 價。
//
// 這整塊原本內嵌在 TradeTerminalPage 裡（fetchAll + 兩個 useEffect）。抽成 hook
// 之後，下單面板、帳戶面板、持倉表都吃同一份資料與同一個 refresh，不必為了共用
// 而把三個元件塞回同一個檔案。

type Contracts = any

export interface TerminalAccount {
  usdcBal: bigint
  usdtBal: bigint
  freeMgn: bigint
  positions: Pos[]
  /** oracle index 價（結算價），18 位小數。 */
  curPrice: bigint
  /** mark 價（含 OI 溢價）；舊版 ABI 沒有這個 method 時為 0。 */
  markPrice: bigint
  refresh: () => Promise<void>
}

/** 終端機持倉表要的形狀。`cur` 是合約 mark 價（持倉表的「標記價」欄），不是鏈下參考價。 */
export const toTerminalPos = (r: OpenPositionRead): Pos => ({
  id: r.id,
  asset: r.asset,
  isLong: r.isLong,
  entryPrice: r.entryPrice,
  margin: r.margin,
  leverage: r.leverage,
  pnl: r.pnl,
  value: r.value,
  cur: r.markPrice,
})

/** 指數價讀取失敗後的重試：10 秒起跳、每次加倍、上限 60 秒；分頁在背景時暫停。 */
const PRICE_RETRY_BASE_MS = 10_000
const PRICE_RETRY_MAX_MS = 60_000

export function useTerminalAccount(
  contracts: Contracts,
  address: string | null,
  selAsset: AssetId,
): TerminalAccount {
  const [usdcBal, setUsdcBal] = useState(0n)
  const [usdtBal, setUsdtBal] = useState(0n)
  const [freeMgn, setFreeMgn] = useState(0n)
  const [positions, setPositions] = useState<Pos[]>([])
  // 價格連同它屬於哪個標的一起存：render 時比對 selAsset，換標的的那一幀不會
  // 拿到上一個標的的價格（setState 要等 effect 跑完才生效）。
  const [indexQuote, setIndexQuote] = useState<{ asset: string; price: bigint } | null>(null)
  const [markQuote, setMarkQuote] = useState<{ asset: string; price: bigint } | null>(null)
  const curPrice = indexQuote && indexQuote.asset === selAsset ? indexQuote.price : 0n
  const markPrice = markQuote && markQuote.asset === selAsset ? markQuote.price : 0n

  const refresh = useCallback(async () => {
    if (!contracts || !address) return
    try {
      // 隔離處理：餘額讀取失敗不該連帶把可用保證金歸零，也不該讓下面的持倉查詢
      // 整段被跳過。
      const [bal, mgn] = await Promise.all([
        safeRead(contracts.usdc.balanceOf(address) as Promise<bigint>, 0n),
        safeRead(contracts.exchange.freeMargin(address) as Promise<bigint>, 0n),
      ])
      setUsdcBal(bal)
      setFreeMgn(mgn)

      // MockUSDT 不一定部署在這條鏈上——對 0x0 發讀取會直接丟錯。
      if (String(contracts.usdt.target) !== '0x0000000000000000000000000000000000000000') {
        try {
          setUsdtBal((await contracts.usdt.balanceOf(address)) as bigint)
        } catch {
          setUsdtBal(0n)
        }
      } else {
        setUsdtBal(0n)
      }

      const ids = (await contracts.exchange.getUserPositions(address)) as bigint[]
      // 跟投資組合頁同一個讀取函式：未實現損益＝合約 getPositionValue − 保證金
      // （mark 價、資金費、手續費都已在合約裡算好）。見 lib/pepefi/positionPnl.ts。
      const rows = await Promise.all(ids.map((id) => readOpenPosition(contracts, id)))
      setPositions(rows.filter((r): r is NonNullable<typeof r> => r !== null).map(toTerminalPos))
    } catch (e) {
      console.error('[useTerminalAccount]', e)
    }
  }, [contracts, address])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    // 換標的時先清成 null（＝無價格，下單鍵因此停用）。
    setIndexQuote(null)
    setMarkQuote(null)
    if (!contracts) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let failures = 0
    let onVisible: (() => void) | undefined
    const isHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

    const load = async () => {
      let ok = true
      try {
        const pr = (await contracts.oracle.getPrice(selAsset)) as unknown as [bigint, bigint]
        if (cancelled) return
        setIndexQuote({ asset: selAsset, price: pr[0] * 10n ** 10n })
      } catch {
        // 該標的不在 oracle 上或讀取失敗：無價格，稍後重試——不能一次失敗就永遠無法下單。
        ok = false
        if (!cancelled) setIndexQuote(null)
      }
      // G6 mark 價：盡力而為，舊 ABI 沒有 getMarkPrice 就退回 index。
      try {
        const mp = (await contracts.exchange.getMarkPrice(selAsset)) as bigint
        if (!cancelled) setMarkQuote({ asset: selAsset, price: mp })
      } catch {
        if (!cancelled) setMarkQuote(null)
      }
      if (ok) { failures = 0; return }
      if (cancelled) return
      failures += 1
      const delay = Math.min(PRICE_RETRY_BASE_MS * 2 ** (failures - 1), PRICE_RETRY_MAX_MS)
      timer = setTimeout(() => {
        if (cancelled) return
        // 背景分頁不打 RPC：等切回前景再重試一次。
        if (isHidden()) {
          onVisible = () => {
            if (isHidden()) return
            document.removeEventListener('visibilitychange', onVisible!)
            onVisible = undefined
            void load()
          }
          document.addEventListener('visibilitychange', onVisible)
          return
        }
        void load()
      }, delay)
    }
    void load()

    // 切換標的或卸載：停止重試，較慢回來的舊請求也不會寫入。
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (onVisible) document.removeEventListener('visibilitychange', onVisible)
    }
  }, [contracts, selAsset])

  return { usdcBal, usdtBal, freeMgn, positions, curPrice, markPrice, refresh }
}
