import type { Contract } from 'ethers'

import { useRef, useState, useEffect, useCallback } from 'react'

import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'

// feed 上的地址裡，哪些是 StrategyRegistry 註冊過的 trader。
//
// 這是把 whale tracker 與 marketplace 縫起來的那條線：看到一筆大額開倉之後，
// 使用者的下一個問題是「我能不能跟他」。有註冊 → 掛 ⭐ 並直接給跟單入口；
// 沒註冊 → 就是一個匿名鯨魚，只能看。沒有這條線的話兩頁只是各自為政。
//
// 結果會跨 render 留在 ref 裡：feed 每次重掃出現的多半是同一批地址，
// 已經問過的不必再問一次。

export interface RegisteredTrader {
  name:       string
  registered: boolean
}

export function useRegisteredTraders(
  registry:  Contract | null,
  addresses: string[],
): Map<string, RegisteredTrader> {
  const cache = useRef(new Map<string, RegisteredTrader>())
  const [, bump] = useState(0)

  const lookup = useCallback(async () => {
    if (!registry) return

    const unknown = [...new Set(addresses.map(a => a.toLowerCase()))]
      .filter(a => !cache.current.has(a))
    if (unknown.length === 0) return

    const results = await mapLimit(unknown, RPC_CONCURRENCY, async (addr) => {
      try {
        const raw = await withRetry(() => registry.traders(addr)) as unknown as [boolean, string, bigint]
        return [addr, { registered: Boolean(raw[0]), name: String(raw[1] ?? '') }] as const
      } catch {
        // 讀不到就當作未註冊：這只影響一個裝飾用的徽章，不值得為它擋住整個
        // feed，也不值得再開一條「這個地址狀態不明」的 UI 分支。
        return [addr, { registered: false, name: '' }] as const
      }
    })

    for (const [addr, info] of results) cache.current.set(addr, info)
    bump(n => n + 1)
  }, [registry, addresses])

  useEffect(() => { void lookup() }, [lookup])

  return cache.current
}
