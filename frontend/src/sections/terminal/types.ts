import type { useContracts } from 'src/hooks/useContracts'

import { parseEther } from 'ethers'

export type AssetId = `0x${string}`

/**
 * 終端機各面板共用的合約集合。
 *
 * 六個檔案原本各自寫了一行 `type Contracts = any`，於是打錯合約名、打錯方法名、
 * 少傳參數全都不會被編譯器發現。直接綁在 useContracts 的回傳型別上，就永遠不會
 * 和實際建立的合約集合脫節（含 `| null`，因為沒連錢包時它就是 null）。
 */
export type TerminalContracts = ReturnType<typeof useContracts>

/** PerpetualExchange.getPosition() 的原始回傳形狀。 */
export interface RawPos {
  asset: string
  isLong: boolean
  isOpen: boolean
  entryPrice: bigint
  margin: bigint
  leverage: bigint
}

/** 補上 id 與當下報價後的持倉。 */
export interface Pos {
  id: bigint
  asset: string
  isLong: boolean
  entryPrice: bigint
  margin: bigint
  leverage: bigint
  /** 未實現損益：合約 getPositionValue − 保證金（見 lib/pepefi/positionPnl.ts）。 */
  pnl: bigint
  /** 現在平倉拿回的金額（合約 getPositionValue）。 */
  value: bigint
  /** 合約 mark 價，18 位小數。 */
  cur: bigint
}

/**
 * 持倉表與帳戶區吃的形狀。`livePnl` 以前是用鏈下參考價自己重算的，跟合約、跟投資組合頁
 * 都對不起來；現在就是合約讀數 `pnl`，保留這個名字只是為了不動持倉表的介面。
 */
export interface LivePos extends Pos {
  livePnl: bigint
}

export type TxResp = { wait(): Promise<unknown>; hash: string }

/** ethers 的回傳型別在不同 ABI 下不一致，統一在這裡收斂。 */
export const asTx = (t: unknown) => t as TxResp

/** 空字串或不合法輸入回 null，讓呼叫端能區分「沒填」與「填了 0」。 */
export const tryParse = (s: string): bigint | null => {
  try {
    return s ? parseEther(s) : null
  } catch {
    return null
  }
}
