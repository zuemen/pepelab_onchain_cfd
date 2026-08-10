import { useState, useEffect } from 'react'

// InsuranceVault 目前的資產規模——也就是「極端行情下有多少錢可以兜底」。
//
// 放進行情列而不是自己開一個分頁：它只是一個數字，而且是全平台共用的（不隨選中
// 標的變化）。為了一行字多開一層分頁不划算。
//
// 目前鏈上實測是 0：金庫已部署但還沒有人存錢。照實顯示 $0 而不是藏起來——一個
// 沒有後盾的永續平台，使用者有權在下單前看到這件事。

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Contracts = any

const POLL_MS = 60_000

export function useVaultBacking(contracts: Contracts): { assets: bigint | null } {
  const [assets, setAssets] = useState<bigint | null>(null)

  useEffect(() => {
    if (!contracts?.insuranceVault) {
      setAssets(null)
      return undefined
    }
    let alive = true

    const read = async () => {
      try {
        const v = (await contracts.insuranceVault.totalAssets()) as bigint
        if (alive) setAssets(v)
      } catch {
        // 這條鏈上沒部署或讀取失敗 → 維持 null，UI 顯示 '—' 而不是假的 0。
        if (alive) setAssets(null)
      }
    }

    void read()
    const timer = setInterval(() => void read(), POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [contracts])

  return { assets }
}
