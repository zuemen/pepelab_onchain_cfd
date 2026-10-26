import type { WalletAPI } from 'src/hooks/useWallet'

import { useRef, useState, useEffect } from 'react'

import { safeRead } from 'src/lib/pepefi/safeRead'
import { useContracts } from 'src/hooks/useContracts'
import { useExecutionFee } from 'src/hooks/useExecutionFee'
import { useAutoSyncSupport } from 'src/hooks/useAutoSyncSupport'
import {
  syncStatus,
  parseExecutor,
  syncAttention,
  parseSyncState,
  parseSyncConfig,
  type SyncAttention,
  type AttentionItem,
} from 'src/lib/pepefi/autoSync'

// ----------------------------------------------------------------------
// 全站提醒的資料：連著錢包的這個帳戶，有哪些紀錄落後交易者的最新版、其中哪些要本人處理
// （ADR-024；src/components/pepefi/copy/CopySyncNotice.tsx）。
//
// 為什麼不是只在投資組合顯示：沒有自己跑 agent 的人收不到 webhook，部位停在舊版時（沒開自動同步、
// 油箱不足、執行費被調高……）他只有打開投資組合才會知道。這裡在任何內頁都讀一次。
//
// 讀鏈預算（公開節點有限速）：常見情況只有 getCopyRecords ＋ 每位交易者一次 getLatestStrategy；
// 有落後的紀錄時才讀它的同步設定與油箱。每 10 分鐘重讀一次；換頁時若上次讀取超過 1 分鐘也重讀
// （在投資組合同步完、換到別頁，提醒就跟著消失）。

const POLL_MS = 10 * 60_000
const ON_NAVIGATE_MIN_MS = 60_000

interface RawRecord {
  trader: string
  versionId: bigint
  copiedAt: bigint
  active: boolean
}

export interface CopySyncAlerts {
  /** null：還沒讀到、沒連錢包、這條鏈沒有部署，或讀取失敗（不猜，不顯示）。 */
  attention: SyncAttention | null
  /** 這條鏈的 CopyTracker 支援自動同步。 */
  autoSyncSupported: boolean
}

export function useCopySyncAlerts(wallet: WalletAPI, pathname: string): CopySyncAlerts {
  const live = wallet.isConnected && !wallet.isMock
  const contracts = useContracts(live ? wallet.provider : null, null, wallet.chainId)
  const autoSync = useAutoSyncSupport(contracts?.copyTracker ?? null, live ? wallet.provider : null)
  const execFee = useExecutionFee(contracts?.exchange ?? null)
  const [attention, setAttention] = useState<SyncAttention | null>(null)
  const [tick, setTick] = useState(0)
  const lastRead = useRef(0)

  // 定期重讀
  useEffect(() => {
    const id = window.setInterval(() => setTick(n => n + 1), POLL_MS)
    return () => window.clearInterval(id)
  }, [])

  // 換頁：上次讀取超過 1 分鐘才重讀
  useEffect(() => {
    if (Date.now() - lastRead.current >= ON_NAVIGATE_MIN_MS) setTick(n => n + 1)
  }, [pathname])

  // 執行費也跟著重讀：提醒在內頁之間不會重新掛載，只讀一次的話，owner 調高費率之後
  // 「別人不能代為同步」（feeAboveCap）會一直顯示成「等待執行者」。費率沒變時不會多觸發一輪。
  const refreshFee = execFee.refresh
  useEffect(() => {
    if (tick > 0) refreshFee()
  }, [tick, refreshFee])

  const address = wallet.address
  const execFeeWei = execFee.loaded ? execFee.wei : null

  useEffect(() => {
    if (!contracts || !address || !autoSync.loaded) {
      setAttention(null)
      return undefined
    }
    let cancelled = false
    void (async () => {
      lastRead.current = Date.now()
      try {
        const recs = (await contracts.copyTracker.getCopyRecords(address)) as unknown as RawRecord[]
        const active = recs.map((r, i) => ({ r, i })).filter(({ r }) => r.active)
        const traders = [...new Set(active.map(({ r }) => r.trader.toLowerCase()))]
        const latest: Record<string, { version: bigint; legs: number } | null> = {}
        await Promise.all(traders.map(async t => {
          try {
            const s = (await contracts.registry.getLatestStrategy(t)) as unknown as [unknown[], bigint]
            latest[t] = { version: BigInt(s[1]), legs: s[0].length }
          } catch {
            latest[t] = null
          }
        }))
        const behind = active.filter(({ r }) => {
          const l = latest[r.trader.toLowerCase()]
          return l !== null && l !== undefined && BigInt(r.versionId) < l.version
        })
        const gas = autoSync.supported && behind.length > 0
          ? await safeRead<bigint | null>(contracts.copyTracker.syncGasBalance(address) as Promise<bigint>, null)
          : null
        const nowSec = Math.floor(Date.now() / 1000)
        const items: AttentionItem[] = await Promise.all(active.map(async ({ r, i }) => {
          const l = latest[r.trader.toLowerCase()] ?? null
          const base = { recordIdx: i, recordVersion: BigInt(r.versionId), latestVersion: l?.version ?? null }
          if (!autoSync.supported) return { ...base, status: null }
          if (l === null || BigInt(r.versionId) >= l.version) return { ...base, status: { kind: 'upToDate' as const } }
          const idx = BigInt(i)
          const [config, state, cap, executor] = await Promise.all([
            (contracts.copyTracker.syncConfig(address, idx) as Promise<unknown>).then(parseSyncConfig).catch(() => null),
            (contracts.copyTracker.getSyncState(address, idx) as Promise<unknown>).then(parseSyncState).catch(() => null),
            (contracts.copyTracker.syncExecFeeCap(address, idx) as Promise<bigint>).then(v => BigInt(v)).catch(() => null),
            autoSync.executorLock
              ? (contracts.copyTracker.syncExecutor(address, idx) as Promise<unknown>).then(parseExecutor).catch(() => null)
              : Promise.resolve(null),
          ])
          return {
            ...base,
            status: syncStatus({
              recordVersion: base.recordVersion,
              latestVersion: l.version,
              config,
              state,
              gasBalance: gas,
              executionFee: execFeeWei,
              latestLegs: l.legs,
              nowSec,
              copiedAt: Number(r.copiedAt),
              execFeeCap: cap,
              executor,
            }),
          }
        }))
        if (!cancelled) setAttention(syncAttention(items))
      } catch (e) {
        console.warn('[useCopySyncAlerts] read failed', e)
        if (!cancelled) setAttention(null)
      }
    })()
    return () => { cancelled = true }
  }, [contracts, address, autoSync.loaded, autoSync.supported, autoSync.executorLock, execFeeWei, tick])

  return { attention, autoSyncSupported: autoSync.supported }
}
