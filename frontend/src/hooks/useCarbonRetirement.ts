import type { CarbonRouting } from 'src/hooks/useCarbonRouting'
import type { RetiredLog, RawRetirement, RetirementRow, RetirementSummary, RawRetirementState } from 'src/lib/pepefi/carbonRetirement'

import { Contract, Interface } from 'ethers'
import { useMemo, useState, useEffect, useCallback } from 'react'

import { safeRead } from 'src/lib/pepefi/safeRead'
import { useCarbonRouting } from 'src/hooks/useCarbonRouting'
import { chainMap } from 'src/contracts/deployment'
import { useReadChain } from 'src/hooks/useRwaTransparency'
import { useWalletContext } from 'src/contexts/wallet-context'
import { UI_RETRIES, avgBlockTime, getLogsChunkedDetailed } from 'src/lib/pepefi/chainLogs'
import {
  RECENT_LIMIT,
  attachRetirementTx,
  LOCAL_CHAIN_ID,
  retirementLogRanges,
  summarizeRetirements,
  retirementReadFailed,
  simulationFlagContradicts,
} from 'src/lib/pepefi/carbonRetirement'
import {
  CARBON_RETIREMENT_ABI,
  CARBON_ERC20_DECIMALS_ABI,
  getCarbonRetirementAddress,
} from 'src/contracts/carbonRetirement'

export type RetirementRowWithTx = RetirementRow & { txHash: string | null }

export interface UseCarbonRetirementResult {
  /** 這個 build／這條鏈沒有 CarbonRetirement（或還沒有可讀的節點）：整個區塊不顯示。 */
  unavailable: boolean
  /** 這輪讀取已經結束（不論成功與否）。 */
  loaded: boolean
  /** 位址有設但讀不到，或讀到的合約自稱不是模擬：畫面說「暫時無法確認」。 */
  error: boolean
  summary: (Omit<RetirementSummary, 'rows'> & { rows: RetirementRowWithTx[] }) | null
  address: string | null
  /** 讀的是哪條鏈（給交易連結選區塊瀏覽器）。 */
  chainId: number | null
  /** 錢從哪裡來：鏈上讀到的比例（#333）。讀不到時為 null，畫面照樣說明機制、不寫數字。 */
  routing: CarbonRouting | null
  /** 往前多讀一頁（RECENT_LIMIT 筆）。每一筆退役紀錄都要看得到，不只最近 10 筆。 */
  showMore: () => void
}

type RawTuple = { amount: bigint; tonnesCO2e: bigint; timestamp: bigint; retiredBy: string }

const RETIRED_EVENT = new Interface(CARBON_RETIREMENT_ABI as unknown as string[])

/**
 * 讀 CarbonRetirement 的累計退役量、預算與最近幾筆退役。全部唯讀。
 *
 * 讀哪條鏈：錢包連在任何一條有部署的鏈上（含本機展示鏈 31337）就讀那條鏈；否則沿用 RWA 透明度頁的
 * useReadChain（主要部署鏈的公開節點），所以沒連錢包也看得到。不能直接用 useReadChain：它在主要部署鏈
 * 存在時一律讀主要部署鏈，本機展示時退役紀錄就會讀到 Base Sepolia 去（#333 要求兩條鏈都有）。
 * 每個欄位各自 safeRead，一筆失敗不拖垮其他欄位。
 *
 * 位址來源（先到先用）：VITE_CARBON_RETIREMENT → per-chain 表 → 從 FeeRouter 的平台收款人找到的
 * 分流合約所指的退役合約（#333）。最後一條讓 cutover 換上新 FeeRouter 之後不必再改前端。
 *
 * 退役清單沒有存交易雜湊，所以另查 CarbonRetired 事件補上（attachRetirementTx）；查不到的列
 * 沒有連結，不影響其他欄位。
 */
export function useCarbonRetirement(): UseCarbonRetirementResult {
  const wallet = useWalletContext()
  const read = useReadChain()
  const onWalletChain = wallet.provider !== null && wallet.chainId !== null && wallet.chainId in chainMap
  const chainId = onWalletChain ? wallet.chainId : read.chainId
  const provider = onWalletChain ? wallet.provider : read.provider
  const { routing, loaded: routingLoaded } = useCarbonRouting(provider, chainId)
  const configured = useMemo(() => getCarbonRetirementAddress(chainId), [chainId])
  const address = configured ?? routing?.retirement ?? null

  const [limit, setLimit] = useState(RECENT_LIMIT)
  const [summary, setSummary] = useState<UseCarbonRetirementResult['summary']>(null)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  // 還在找位址時不算「沒有」：避免區塊先消失再出現。
  const unavailable = provider === null || (address === null && routingLoaded)

  useEffect(() => {
    if (address === null || provider === null) {
      setSummary(null)
      setError(false)
      setLoaded(routingLoaded)
      return undefined
    }

    let cancelled = false
    setLoaded(false)
    setError(false)

    const c = new Contract(address, CARBON_RETIREMENT_ABI, provider)

    void (async () => {
      const [simulated, usdc, budget, totalRetiredTonnes, totalSpent, count, recentRaw] = await Promise.all([
        safeRead<boolean | null>(c.SIMULATED() as Promise<boolean>, null),
        safeRead<string | null>(c.usdc() as Promise<string>, null),
        safeRead<bigint | null>(c.budget() as Promise<bigint>, null),
        safeRead<bigint | null>(c.totalRetiredTonnes() as Promise<bigint>, null),
        safeRead<bigint | null>(c.totalSpent() as Promise<bigint>, null),
        safeRead<bigint | null>(c.retirementCount() as Promise<bigint>, null),
        safeRead<RawTuple[] | null>(c.getRecentRetirements(0n, BigInt(limit)) as Promise<RawTuple[]>, null),
      ])
      const decimals =
        usdc === null
          ? null
          : await safeRead<number | null>(
              new Contract(usdc, CARBON_ERC20_DECIMALS_ABI, provider).decimals().then(Number),
              null,
            )

      const recent: RawRetirement[] | null =
        recentRaw === null
          ? null
          : recentRaw.map((r) => ({
              amount: BigInt(r.amount),
              tonnesCO2e: BigInt(r.tonnesCO2e),
              timestamp: BigInt(r.timestamp),
              retiredBy: String(r.retiredBy),
            }))

      const logs =
        recent && recent.length > 0
          ? await readRetiredLogs(provider, address, chainId, recent.map((r) => Number(r.timestamp)))
          : []
      if (cancelled) return

      const raw: RawRetirementState = { simulated, decimals, totalRetiredTonnes, totalSpent, budget, count, recent }
      const failed = retirementReadFailed(raw) || simulationFlagContradicts(raw)
      if (failed) {
        setSummary(null)
      } else {
        const s = summarizeRetirements(raw)
        setSummary({ ...s, rows: attachRetirementTx(s.rows, recent ?? [], logs) })
      }
      setError(failed)
      setLoaded(true)
    })()

    return () => {
      cancelled = true
    }
  }, [address, provider, chainId, routingLoaded, limit])

  const showMore = useCallback(() => setLimit((n) => n + RECENT_LIMIT), [])

  return { unavailable, loaded, error, summary, address, chainId, routing, showMore }
}

/** CarbonRetired 事件（給交易雜湊）。讀不到就回空陣列：連結是附加資訊，不是退役紀錄本身。 */
async function readRetiredLogs(
  provider: NonNullable<ReturnType<typeof useReadChain>['provider']>,
  address: string,
  chainId: number | null,
  rowTimestamps: number[],
): Promise<RetiredLog[]> {
  try {
    const block = await provider.getBlock('latest')
    if (!block) return []
    const ranges = retirementLogRanges(
      chainId,
      { number: block.number, timestamp: block.timestamp },
      rowTimestamps,
      avgBlockTime(chainId),
    )
    const topic = RETIRED_EVENT.getEvent('CarbonRetired')!.topicHash
    const scans = await Promise.all(
      ranges.map((r) =>
        getLogsChunkedDetailed(provider, { address, topics: [topic] }, r.fromBlock, r.toBlock, {
          // anvil 沒有範圍上限，本機鏈一段查完；公開鏈照預設分段，失敗重試
          chunkSize: chainId === LOCAL_CHAIN_ID ? r.toBlock - r.fromBlock + 1 : undefined,
          retries: UI_RETRIES,
        }),
      ),
    )
    return scans.flatMap((s) => s.logs).flatMap((log: { topics: string[]; data: string; transactionHash: string }) => {
      const parsed = RETIRED_EVENT.parseLog(log)
      if (!parsed) return []
      return [
        {
          amount: BigInt(parsed.args[0]),
          tonnesCO2e: BigInt(parsed.args[1]),
          timestamp: BigInt(parsed.args[2]),
          txHash: log.transactionHash,
        },
      ]
    })
  } catch {
    return []
  }
}
