import { useState, useEffect, useCallback } from 'react'

import { safeRead } from 'src/lib/pepefi/safeRead'
import type { AssetId, Pos, RawPos } from 'src/sections/terminal/types'

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

export function useTerminalAccount(
  contracts: Contracts,
  address: string | null,
  selAsset: AssetId,
): TerminalAccount {
  const [usdcBal, setUsdcBal] = useState(0n)
  const [usdtBal, setUsdtBal] = useState(0n)
  const [freeMgn, setFreeMgn] = useState(0n)
  const [positions, setPositions] = useState<Pos[]>([])
  const [curPrice, setCurPrice] = useState(0n)
  const [markPrice, setMarkPrice] = useState(0n)

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
      const rows = await Promise.all(
        ids.map(async (id): Promise<Pos | null> => {
          try {
            const raw = (await contracts.exchange.getPosition(id)) as unknown as RawPos
            if (!raw.isOpen) return null
            const pnl = (await contracts.exchange.getUnrealizedPnL(id)) as bigint
            const pr = (await contracts.oracle.getPrice(raw.asset)) as unknown as [bigint, bigint]
            return {
              id,
              asset: raw.asset,
              isLong: raw.isLong,
              entryPrice: raw.entryPrice,
              margin: raw.margin,
              leverage: raw.leverage,
              pnl,
              // oracle 存 8 位小數，補到 18 位跟其他數值對齊。
              cur: pr[0] * 10n ** 10n,
            }
          } catch {
            return null
          }
        }),
      )
      setPositions(rows.filter((r): r is Pos => r !== null))
    } catch (e) {
      console.error('[useTerminalAccount]', e)
    }
  }, [contracts, address])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (!contracts) return
    void (async () => {
      try {
        const pr = (await contracts.oracle.getPrice(selAsset)) as unknown as [bigint, bigint]
        setCurPrice(pr[0] * 10n ** 10n)
      } catch {
        /* 該標的不在 oracle 上 */
      }
      // G6 mark 價：盡力而為，舊 ABI 沒有 getMarkPrice 就退回 index。
      try {
        setMarkPrice((await contracts.exchange.getMarkPrice(selAsset)) as bigint)
      } catch {
        setMarkPrice(0n)
      }
    })()
  }, [contracts, selAsset])

  return { usdcBal, usdtBal, freeMgn, positions, curPrice, markPrice, refresh }
}
