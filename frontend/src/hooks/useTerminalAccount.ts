import { useRef, useState, useEffect, useCallback } from 'react'

import { safeRead, withTimeout } from 'src/lib/pepefi/safeRead'
import {
  chainNowSec,
  readPosition,
  cachedMaxPriceAge,
  type OpenPositionRead,
} from 'src/lib/pepefi/positionPnl'
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
  /** 持倉最後一次讀取成功的時間（ms）；還沒讀過為 null。 */
  updatedAt: number | null
  /** 最近一次讀取有失敗（整批讀不到或有部位讀不到）。畫面要提示，不能裝作是最新值。 */
  readFailed: boolean
  /**
   * getPosition 本身讀不到、因此不在 positions 裡的部位數（審查 N1）。> 0 時權益與
   * 未實現 PnL 的合計都不能顯示數字——少算一個部位的合計是錯的。
   */
  unreadCount: number
  refresh: () => Promise<void>
}

/**
 * 持倉輪詢間隔：與投資組合頁相同（30 秒）。分頁在背景時不打 RPC，切回前景立刻補讀一次。
 * 以前終端機只在掛載、下單、按重新整理時讀，數字會停在開頁那一刻。
 */
export const POSITION_POLL_MS = 30_000

/** 超過這個時間沒有成功讀到，就把數字標成「可能已過期」。 */
export const POSITION_STALE_MS = POSITION_POLL_MS * 2 + 5_000

/** 終端機持倉表要的形狀。`cur` 是合約 mark 價（持倉表的「標記價」欄），不是鏈下參考價。 */
export const toTerminalPos = (r: OpenPositionRead): Pos => ({
  id: r.id,
  asset: r.asset,
  isLong: r.isLong,
  entryPrice: r.entryPrice,
  margin: r.margin,
  leverage: r.leverage,
  status: r.status,
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
  const [updatedAt, setUpdatedAt] = useState<number | null>(null)
  const [readFailed, setReadFailed] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)

  // 審查 N3：每一輪 refresh 一個序號，只有最新一輪的結果能寫進 state；換錢包或換合約時
  // 序號也會前進，舊位址還在跑的請求晚回來一律丟棄。inFlight 讓輪詢在上一輪還沒回來時跳過。
  const seqRef = useRef(0)
  const inFlightRef = useRef(false)

  // 換錢包／換合約：清掉舊位址的持倉與時間戳，讓還在飛的舊請求失效。
  useEffect(() => {
    seqRef.current += 1
    inFlightRef.current = false
    setPositions([])
    setUpdatedAt(null)
    setReadFailed(false)
    setUnreadCount(0)
  }, [contracts, address])

  const refresh = useCallback(async () => {
    if (!contracts || !address) return
    seqRef.current += 1
    const seq = seqRef.current
    const isCurrent = () => seq === seqRef.current
    inFlightRef.current = true
    try {
      // 隔離處理：餘額讀取失敗不該連帶把可用保證金歸零，也不該讓下面的持倉查詢
      // 整段被跳過。
      const [bal, mgn] = await Promise.all([
        safeRead<bigint | null>(contracts.usdc.balanceOf(address) as Promise<bigint>, null),
        safeRead<bigint | null>(contracts.exchange.freeMargin(address) as Promise<bigint>, null),
      ])
      if (!isCurrent()) return
      // 讀不到就保留上一次的值並標成讀取失敗，不覆寫成 0——0 看起來像「餘額真的歸零」。
      if (bal !== null) setUsdcBal(bal)
      if (mgn !== null) setFreeMgn(mgn)
      const balancesFailed = bal === null || mgn === null

      // MockUSDT 不一定部署在這條鏈上——對 0x0 發讀取會直接丟錯。
      if (String(contracts.usdt.target) !== '0x0000000000000000000000000000000000000000') {
        try {
          const usdt = (await contracts.usdt.balanceOf(address)) as bigint
          if (isCurrent()) setUsdtBal(usdt)
        } catch {
          // 讀不到：保留上一次的值（不覆寫成 0）。
        }
      } else {
        setUsdtBal(0n)
      }

      // 跟投資組合頁同一個讀取函式：未實現損益＝合約 getPositionValue − 保證金
      // （mark 價、資金費、手續費都已在合約裡算好）。見 lib/pepefi/positionPnl.ts。
      // maxPriceAge 有 10 分鐘快取，與持倉 id、最新區塊時間（判斷價格過期用）並行讀。
      const [ids, maxPriceAgeSec, nowSec] = await Promise.all([
        withTimeout(contracts.exchange.getUserPositions(address) as Promise<bigint[]>, 10_000),
        cachedMaxPriceAge(contracts.exchange),
        chainNowSec(contracts.exchange),
      ])
      const results = await Promise.all(
        ids.map((id) => readPosition(contracts, id, { maxPriceAgeSec, nowSec })),
      )
      if (!isCurrent()) return
      const rows = results.flatMap((r) => (r.kind === 'open' ? [r.row] : []))
      const unread = results.filter((r) => r.kind === 'failed').length
      setPositions(rows.map(toTerminalPos))
      setUnreadCount(unread)
      setUpdatedAt(Date.now())
      // getPosition 本身讀不到的部位不在列表裡——一定要讓畫面說「讀取失敗」，不能裝作沒有。
      setReadFailed(balancesFailed || unread > 0 || rows.some((r) => r.status === 'unreadable'))
    } catch (e) {
      // 整批讀不到：保留上一次的數字，但標成讀取失敗（畫面顯示最後更新時間＋提示）。
      console.error('[useTerminalAccount]', e)
      if (isCurrent()) setReadFailed(true)
    } finally {
      if (isCurrent()) inFlightRef.current = false
    }
  }, [contracts, address])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // 持倉輪詢。背景分頁不打 RPC；切回前景立刻補讀一次，不等下一個週期。
  useEffect(() => {
    if (!contracts || !address) return undefined
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
    // 上一輪還沒回來（單輪最壞可能超過輪詢間隔）就跳過這次，不疊加請求。
    const tick = () => {
      if (!hidden() && !inFlightRef.current) void refresh()
    }
    const timer = setInterval(tick, POSITION_POLL_MS)
    const onVisible = tick
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    }
  }, [contracts, address, refresh])

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

  return {
    usdcBal,
    usdtBal,
    freeMgn,
    positions,
    curPrice,
    markPrice,
    updatedAt,
    readFailed,
    unreadCount,
    refresh,
  }
}
