// /tokens 的金庫提醒：平常不顯示，只有真的影響買賣時才講。儲備數字留在 /solvency——
// 這裡的儲備是測試幣，比率高低取決於團隊注入多少，說明不了金庫好不好。

import { t } from 'src/locales'

export interface VaultHealth {
  /** null＝讀不到或尚無發行（合約回 uint256 max，那不是一個比率）。 */
  ratioBps: bigint | null
  /** 低於這個比率合約拒絕 mint。 */
  minRatioBps: bigint | null
  /** null＝讀不到，也包含第一次讀回來之前。 */
  paused: boolean | null
  /** 有資產無法定價：比率偏樂觀，視為未知（CONTEXT.md 的 Unknown Ratio）。 */
  stale: boolean
  mintingHalted: boolean
}

export interface VaultNote {
  severity: 'warning' | 'error'
  message: string
}

/** 現在有什麼事會擋住買賣；沒有就是 null。 */
export function vaultStatusNote(h: VaultHealth): VaultNote | null {
  const copy = t.tokens.health
  if (h.paused === true) return { severity: 'error', message: copy.paused }
  if (h.stale) return { severity: 'warning', message: copy.unknown }
  const belowFloor = h.ratioBps !== null && h.minRatioBps !== null && h.ratioBps < h.minRatioBps
  if (h.mintingHalted || belowFloor) return { severity: 'error', message: copy.buyStopped }
  return null
}
