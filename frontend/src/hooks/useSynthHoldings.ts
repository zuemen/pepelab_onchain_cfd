import { Contract } from 'ethers'
import { useState, useEffect, useCallback } from 'react'

import { usePepefiWallet } from 'src/layouts/pepefi'
import { safeRead } from 'src/lib/pepefi/safeRead'
import { ASSET_IDS, getSynthTokens, getV2Stack, type AssetSymbol } from 'src/contracts/addresses'
import type { HoldingRow } from 'src/lib/pepefi/assetClass'
import SyntheticAssetABI from 'src/contracts/abi/SyntheticAsset.json'
import SyntheticAssetV2ABI from 'src/contracts/abi/SyntheticAssetV2.json'

import { useContracts } from './useContracts'
import { useV2Contracts } from './useV2Contracts'

// ----------------------------------------------------------------------
// 使用者持有的代幣化資產（/tokens 用 USDC 從 AssetVault 鑄出來的那些）。
//
// 存在的理由：平台把門面改成代幣化 RWA 現貨之後，一般使用者的資產是這些代幣，
// 不是永續部位的保證金。首頁與 Portfolio 的「股債金幣配置」原本只算保證金，
// 於是一個買了 sGOLD 與 sBOND、一張永續都沒開的人，在配置圖上會是四類皆 0%
// ——正好是那個區塊要證明的事情的反面。
//
// 讀法與 TokenizedAssetsPage 一致（V1/V2 兩套 vault 並存，預設 V2、使用者的
// 明確選擇優先），差別是這裡**只讀不寫**，也不提供版本切換：切換的 UI 只該有
// 一個入口，多一個就會出現「兩個地方顯示不同版本」的狀態。

const VERSION_KEY = 'pepefi:vaultVersion'

function storedVersion(): 'v1' | 'v2' | null {
  try {
    const saved = localStorage.getItem(VERSION_KEY)
    return saved === 'v1' || saved === 'v2' ? saved : null
  } catch {
    return null // private mode
  }
}

export interface SynthHoldings {
  /** 餘額為 0 的資產不會出現在這裡——配置圖的四類補零由 groupByAssetClass 負責。 */
  rows: HoldingRow[]
  loading: boolean
  /** 重新讀一次。買賣完成後呼叫它，配置圖才會跟著動。 */
  refresh: () => Promise<void>
}

export function useSynthHoldings(): SynthHoldings {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const v2 = useV2Contracts(wallet.provider, wallet.signer, wallet.chainId)

  const [rows, setRows] = useState<HoldingRow[]>([])
  const [loading, setLoading] = useState(true)

  const isV2 = (storedVersion() ?? (getV2Stack(wallet.chainId) ? 'v2' : 'v1')) === 'v2' && !!v2

  const tokens = isV2 ? v2!.tokens : getSynthTokens(wallet.chainId)
  const vault = isV2 ? v2!.vault : contracts?.assetVault
  const oracle = isV2 ? v2!.oracle : contracts?.oracle
  const tokenAbi = isV2 ? SyntheticAssetV2ABI : SyntheticAssetABI

  const runner = contracts?.usdc?.runner ?? null
  const address = wallet.address
  // 物件每次 render 都是新的參考，直接放進 deps 會讓 effect 每次都重跑。
  const symbolKey = Object.keys(tokens).sort().join(',')

  const refresh = useCallback(async () => {
    if (!address || !vault || !oracle || !runner) {
      setRows([])
      setLoading(false)
      return
    }
    const symbols = symbolKey ? (symbolKey.split(',') as AssetSymbol[]) : []
    const read = await Promise.all(
      symbols.map(async (sym): Promise<HoldingRow | null> => {
        const id = ASSET_IDS[sym]
        const tokenAddr = tokens[sym]
        if (!tokenAddr) return null
        // 每一項各自 safeRead：一個資產的價格過期（GuardedOracle fail-closed 會
        // revert）不該讓整個配置圖變空，那會讓「讀不到」看起來像「沒有持倉」。
        const [priceRes, balance] = await Promise.all([
          safeRead(oracle.getPrice(id) as Promise<[bigint, bigint]>, [0n, 0n] as [bigint, bigint]),
          safeRead(new Contract(tokenAddr, tokenAbi, runner).balanceOf(address) as Promise<bigint>, 0n),
        ])
        if (balance === 0n) return null
        const row: HoldingRow = { asset: id, balance, price: priceRes[0] }
        return row
      }),
    )
    setRows(read.filter((r): r is HoldingRow => r !== null))
    setLoading(false)
    // tokens/vault/oracle 都是從 chainId + 版本推出來的，symbolKey 與 isV2 已經
    // 代表它們；把物件本身放進 deps 只會讓 effect 每次 render 都重跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, symbolKey, isV2, runner])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { rows, loading, refresh }
}
