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
  pnl: bigint
  cur: bigint
}

/** Pos 再疊上以即時價重算的未實現損益。 */
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
