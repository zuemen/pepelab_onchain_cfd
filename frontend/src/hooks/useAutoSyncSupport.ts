import type { Contract, BrowserProvider } from 'ethers'

import { useState, useEffect } from 'react'

import { safeRead } from 'src/lib/pepefi/safeRead'
import { FALLBACK_MAX_TIP_WEI } from 'src/lib/pepefi/autoSync'
import { supportMap, loadProbeCode } from 'src/lib/pepefi/contractProbe'

// ----------------------------------------------------------------------
// 這條鏈上的 CopyTracker 有沒有自動同步（ADR-024）。
//
// 線上的舊 CopyTracker 沒有這些函式；對它呼叫只會得到空 revert。所以比照 contractProbe：先讀
// runtime bytecode 找 selector，找得到才露出自動同步的 UI。bytecode 讀不到（unknown）時一律當成
// 不支援——這是會送出交易、付 ETH 的功能，寧可少一個選項，也不要讓使用者送一筆注定失敗的交易。

const SIG_RESYNC = 'resyncFor(address,uint256)'
// 本人「立即同步」走釘版本、釘執行費上限的入口（交易者在按下前發的新版、交易所 owner 在按下前
// 調高的執行費都不會被直接採用）。部署出去的自動同步版 tracker 一定同時有這兩個；要求兩個都在，
// 介面就永遠不會退回不釘版本的本人同步，也不會對簽名不同的舊版測試合約送出注定失敗的交易
// （setAutoSync／followTraderAtVersionWithAutoSync 與它同一版加上 maxExecFeePerLeg）。
const SIG_RESYNC_PINNED = 'resyncAtVersion(uint256,uint256,uint256)'
const SIG_COMBINED = 'followTraderAtVersionWithAutoSync(address,uint256,uint256,uint8,uint32,uint96,uint256)'
const SIG_PREVIEW_CAP = 'previewCopyAllocationWithCap(address,uint256,uint8)'
// 指定執行者（只讓自己的 agent 同步）：第四輪審查才加的；沒有就不顯示那個欄位。
const SIG_EXECUTOR = 'setSyncExecutor(uint256,address)'
// 釘版本的跟單（M10，與自動同步無關，舊版 tracker 也可能有）：不勾自動同步時也用它，
// 交易者在送出前搶先發布的另一版會讓跟單整筆失敗，而不是直接跟到沒看過的那一版。
const SIG_FOLLOW_PINNED = 'followTraderAtVersion(address,uint256,uint256)'

export interface AutoSyncSupport {
  /** 讀完了（不論結果）。 */
  loaded: boolean
  /** resyncFor／resyncAtVersion／setAutoSync／油箱都可用。 */
  supported: boolean
  /** 有一筆完成「跟單＋自動同步＋油箱」的函式；沒有就分開送。 */
  combined: boolean
  /** 有套用跟隨者槓桿上限的預覽（previewCopyAllocationWithCap）；沒有就用不設上限的預覽。 */
  previewWithCap: boolean
  /** 有指定執行者（setSyncExecutor／syncExecutor）。 */
  executorLock: boolean
  /** 有釘版本的跟單入口（followTraderAtVersion）；與自動同步無關，沒有才退回不釘版本的 followTrader。 */
  pinnedFollow: boolean
  /** 合約的小費上限；讀不到用後備值。 */
  maxTipWei: bigint
}

const NONE: AutoSyncSupport = {
  loaded: false, supported: false, combined: false, previewWithCap: false, executorLock: false, pinnedFollow: false,
  maxTipWei: FALLBACK_MAX_TIP_WEI,
}

export function useAutoSyncSupport(copyTracker: Contract | null, provider: BrowserProvider | null): AutoSyncSupport {
  const [support, setSupport] = useState<AutoSyncSupport>(NONE)

  useEffect(() => {
    setSupport(NONE)
    if (!copyTracker || !provider) {
      setSupport({ ...NONE, loaded: true })
      return undefined
    }
    let cancelled = false
    void (async () => {
      const address = String(copyTracker.target)
      const code = await loadProbeCode({ getCode: (a) => provider.getCode(a) }, address)
      const map = supportMap(code, [SIG_RESYNC, SIG_RESYNC_PINNED, SIG_COMBINED, SIG_PREVIEW_CAP, SIG_EXECUTOR, SIG_FOLLOW_PINNED])
      const supported = map[SIG_RESYNC] === 'supported' && map[SIG_RESYNC_PINNED] === 'supported'
      const maxTipWei = supported
        ? await safeRead<bigint>(copyTracker.MAX_TIP_WEI() as Promise<bigint>, FALLBACK_MAX_TIP_WEI)
        : FALLBACK_MAX_TIP_WEI
      if (cancelled) return
      setSupport({
        loaded: true,
        supported,
        combined: supported && map[SIG_COMBINED] === 'supported',
        previewWithCap: supported && map[SIG_PREVIEW_CAP] === 'supported',
        executorLock: supported && map[SIG_EXECUTOR] === 'supported',
        pinnedFollow: map[SIG_FOLLOW_PINNED] === 'supported',
        maxTipWei,
      })
    })()
    return () => { cancelled = true }
  }, [copyTracker, provider])

  return support
}
