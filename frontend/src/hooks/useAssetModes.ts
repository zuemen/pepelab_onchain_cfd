import type { AssetModeProbe } from 'src/lib/pepefi/marketStatus'

import { Contract } from 'ethers'
import { useState, useEffect } from 'react'

import { type ModeSupport, unknownModes, loadAssetModes } from 'src/lib/pepefi/assetModeProbe'

/** 模式是 keeper 每一兩個小時才切一次的東西，一分鐘讀一次綽綽有餘。 */
const POLL_MS = 60_000

const ASSET_MODE_ABI = ['function assetMode(bytes32) view returns (uint8)']

const isPageVisible = () =>
  typeof document === 'undefined' || document.visibilityState !== 'hidden'

/**
 * 每個資產在鏈上 exchange 的模式探測結果（見 lib/pepefi/assetModeProbe.ts）。
 * 沒有 exchange（未連錢包）或還沒讀到之前，每個資產都是 unknown。
 */
export function useAssetModes(
  exchange: Contract | null | undefined,
  assetIds: readonly string[]
): Record<string, AssetModeProbe> {
  const key = assetIds.join(',')
  const [modes, setModes] = useState<Record<string, AssetModeProbe>>(() => unknownModes(assetIds))

  useEffect(() => {
    const ids = key ? key.split(',') : []
    if (!exchange) {
      setModes(unknownModes(ids))
      return undefined
    }
    let cancelled = false
    let support: ModeSupport = 'unknown'
    let reader: Contract | null = null

    const tick = async () => {
      const addr = await exchange.getAddress()
      reader ??= new Contract(addr, ASSET_MODE_ABI, exchange.runner)
      const r = reader
      const out = await loadAssetModes(
        {
          getCode: () => exchange.getDeployedCode(),
          readMode: (a) => r.assetMode(a) as Promise<bigint>,
        },
        ids,
        support
      )
      support = out.support
      if (!cancelled) setModes(out.modes)
    }

    void tick().catch(() => undefined)
    const timer = setInterval(() => {
      if (isPageVisible()) void tick().catch(() => undefined)
    }, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [exchange, key])

  return modes
}
