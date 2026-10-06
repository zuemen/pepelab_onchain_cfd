import type { Provider } from 'ethers'
import type { RwaSnapshot } from 'src/lib/pepefi/rwaCards'
import type { AssetSymbol } from 'src/contracts/addresses'
import type { ReadSource } from 'src/lib/pepefi/readChain'
import type { RefFetchResult, OnchainSnapshot } from 'src/lib/pepefi/oracleWitness'
import type { ReserveHistory, RawReserveLog, SolvencySnapshot } from 'src/lib/pepefi/solvency'

import { Contract } from 'ethers'
import { useMemo, useState, useEffect, useCallback } from 'react'

import { loadRwaSnapshot } from 'src/lib/pepefi/rwaCards'
import PerpetualExchangeABI from 'src/contracts/abi/PerpetualExchange.json'
import { isDeployed } from 'src/lib/pepefi/safeRead'
import { SIGNAL_API_URL } from 'src/lib/pepefi/signalApi'
import { PRIMARY_CHAIN_ID } from 'src/contracts/addresses'
import { loadProbeCode } from 'src/lib/pepefi/contractProbe'
import { useWalletContext } from 'src/contexts/wallet-context'
import { chainMap, getV2Stack, getAddresses } from 'src/contracts/deployment'
import { loadSolvency, loadReserveHistory } from 'src/lib/pepefi/solvency'
import { pickReadSource, publicProvider, pickReadChainId } from 'src/lib/pepefi/readChain'
import { loadOnchainQuotes, fetchReferencePrices } from 'src/lib/pepefi/oracleWitness'

// RWA 透明度三頁的鏈上讀取。全部唯讀；ABI 只列這幾頁會呼叫的 view（human-readable），
// 與完整 ABI 檔的版本差異無關——鏈上沒有的函式由 contractProbe 先掃 bytecode 擋下。

// 交易所用 repo 內的 ABI 檔（與其他頁讀 getPosition 的方式相同，它對應的是線上部署版）；
// assetMode 不在那份 ABI 裡（舊部署沒有），另用一個片段，與 useAssetModes 相同。
const ASSET_MODE_ABI = ['function assetMode(bytes32) view returns (uint8)']
const ESG_ABI = [
  'function medianCarbonTier(bytes32) view returns (uint8 tier, uint256 count, uint256 dispersion, bool isRated)',
  'function getAttestors(bytes32) view returns (address[])',
]
const ORACLE_ABI = ['function getPrice(bytes32) view returns (uint256 price, uint256 updatedAt)']
const ERC20_ABI = ['function decimals() view returns (uint8)', 'function balanceOf(address) view returns (uint256)']
const INSURANCE_ABI = ['function totalAssets() view returns (uint256)']
const VAULT_ABI = [
  'function reserveStatus() view returns (uint256 reserve_, uint256 liability, uint256 ratioBps, uint256 unpriced, bool stale, bool halted)',
  'function minReserveRatioBps() view returns (uint256)',
  'event ReserveObserved(uint256 reserve, uint256 liability, uint256 ratioBps, uint256 unpriced, uint256 timestamp)',
]

export interface ReadChain {
  chainId: number | null
  provider: Provider | null
  source: ReadSource
}

/** 這三頁讀哪條鏈、用哪個節點（見 lib/pepefi/readChain.ts）。 */
export function useReadChain(): ReadChain {
  const wallet = useWalletContext()
  return useMemo(() => {
    const deployed = Object.keys(chainMap).map(Number)
    const chainId = pickReadChainId(wallet.chainId, deployed, PRIMARY_CHAIN_ID)
    const source = pickReadSource(chainId, wallet.chainId, wallet.provider !== null)
    const provider: Provider | null =
      source === 'wallet' ? wallet.provider : source === 'public' && chainId !== null ? publicProvider(chainId) : null
    return { chainId, provider, source }
  }, [wallet.chainId, wallet.provider])
}

/** 通用：非同步載入＋重新讀取。effect 卸載後丟棄結果。 */
function useAsync<T>(load: (() => Promise<T>) | null): { data: T | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [nonce, setNonce] = useState(0)
  useEffect(() => {
    if (!load) {
      setData(null)
      setLoading(false)
      return undefined
    }
    let cancelled = false
    setLoading(true)
    load()
      .then((d) => {
        if (!cancelled) setData(d)
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [load, nonce])
  const reload = useCallback(() => setNonce((n) => n + 1), [])
  return { data, loading, reload }
}

export function useRwaSnapshot(chain: ReadChain, symbols: readonly AssetSymbol[]) {
  const key = symbols.join(',')
  const load = useMemo(() => {
    const { provider, chainId } = chain
    const addr = getAddresses(chainId)
    if (!provider || !addr || !isDeployed(addr.PerpetualExchange)) return null
    const ex = new Contract(addr.PerpetualExchange, PerpetualExchangeABI, provider)
    const modeReader = new Contract(addr.PerpetualExchange, ASSET_MODE_ABI, provider)
    const esgAddr = getV2Stack(chainId)?.ESGRegistryV2
    const esg = esgAddr && isDeployed(esgAddr) ? new Contract(esgAddr, ESG_ABI, provider) : null
    const reader = { getCode: (a: string) => provider.getCode(a), getStorage: (a: string, s: string) => provider.getStorage(a, s) }
    const syms = key.split(',') as AssetSymbol[]
    return (): Promise<RwaSnapshot> =>
      loadRwaSnapshot(
        {
          exchangeCode: () => loadProbeCode(reader, addr.PerpetualExchange),
          kyc: () => ex.kyc() as Promise<string>,
          rwaAsset: (id) => ex.rwaAsset(id) as Promise<boolean>,
          maxLeverageForAsset: (id) => ex.maxLeverageForAsset(id) as Promise<bigint>,
          maintenanceMarginBpsForAsset: (id) => ex.maintenanceMarginBpsForAsset(id) as Promise<bigint>,
          assetMode: (id) => modeReader.assetMode(id) as Promise<bigint>,
          esg:
            esg && esgAddr
              ? {
                  code: () => loadProbeCode(reader, esgAddr),
                  medianCarbonTier: (id) =>
                    esg.medianCarbonTier(id) as Promise<{ tier: bigint; count: bigint; isRated: boolean }>,
                  getAttestors: (id) => esg.getAttestors(id) as Promise<string[]>,
                }
              : null,
        },
        syms
      )
  }, [chain, key])
  return useAsync(load)
}

export function useOnchainQuotes(chain: ReadChain, symbols: readonly AssetSymbol[]) {
  const key = symbols.join(',')
  const load = useMemo(() => {
    const { provider, chainId } = chain
    const addr = getAddresses(chainId)
    if (!provider || !addr || !isDeployed(addr.MockOracle)) return null
    // 交易所讀的 oracle 是 immutable 的 MockOracle（PARAMS_INVENTORY.md）；位址取自部署表。
    const oracle = new Contract(addr.MockOracle, ORACLE_ABI, provider)
    const ex = isDeployed(addr.PerpetualExchange) ? new Contract(addr.PerpetualExchange, PerpetualExchangeABI, provider) : null
    const syms = key.split(',') as AssetSymbol[]
    return (): Promise<OnchainSnapshot> =>
      loadOnchainQuotes(
        {
          getPrice: (id) => oracle.getPrice(id) as Promise<[bigint, bigint]>,
          latestBlockTime: async () => {
            const b = await provider.getBlock('latest')
            if (!b) throw new Error('no block')
            return b.timestamp
          },
          maxPriceAge: ex ? () => ex.maxPriceAge() as Promise<bigint> : undefined,
        },
        syms
      )
  }, [chain, key])
  return useAsync(load)
}

export function useReferencePrices() {
  const load = useMemo(() => (): Promise<RefFetchResult> => fetchReferencePrices(SIGNAL_API_URL), [])
  return useAsync(load)
}

export function useSolvency(chain: ReadChain) {
  const load = useMemo(() => {
    const { provider, chainId } = chain
    const addr = getAddresses(chainId)
    if (!provider || !addr || !isDeployed(addr.PerpetualExchange)) return null
    const ex = new Contract(addr.PerpetualExchange, PerpetualExchangeABI, provider)
    const usdc = new Contract(addr.MockUSDC, ERC20_ABI, provider)
    const iv = isDeployed(addr.InsuranceVault) ? new Contract(addr.InsuranceVault, INSURANCE_ABI, provider) : null
    const vaultAddr = getV2Stack(chainId)?.AssetVaultV2
    const vault = vaultAddr && isDeployed(vaultAddr) ? new Contract(vaultAddr, VAULT_ABI, provider) : null
    const reader = { getCode: (a: string) => provider.getCode(a) }
    return (): Promise<SolvencySnapshot> =>
      loadSolvency({
        exchangeCode: () => loadProbeCode(reader, addr.PerpetualExchange),
        usdcDecimals: () => usdc.decimals() as Promise<bigint>,
        exchangeUsdcBalance: () => usdc.balanceOf(addr.PerpetualExchange) as Promise<bigint>,
        nextPositionId: () => ex.nextPositionId() as Promise<bigint>,
        getPosition: (id) => ex.getPosition(id) as Promise<{ isOpen: boolean; margin: bigint; asset: string }>,
        getUnrealizedPnL: (id) => ex.getUnrealizedPnL(id) as Promise<bigint>,
        adlEnabled: () => ex.adlEnabled() as Promise<boolean>,
        insuranceTotalAssets: iv ? () => iv.totalAssets() as Promise<bigint> : null,
        vault: vault
          ? {
              reserveStatus: () =>
                vault.reserveStatus() as Promise<{
                  reserve_: bigint
                  liability: bigint
                  ratioBps: bigint
                  unpriced: bigint
                  stale: boolean
                  halted: boolean
                }>,
              minReserveRatioBps: () => vault.minReserveRatioBps() as Promise<bigint>,
            }
          : null,
      })
  }, [chain])
  return useAsync(load)
}

export function useReserveHistory(chain: ReadChain) {
  const load = useMemo(() => {
    const { provider, chainId } = chain
    const vaultAddr = getV2Stack(chainId)?.AssetVaultV2
    if (!provider || !vaultAddr || !isDeployed(vaultAddr)) return null
    const vault = new Contract(vaultAddr, VAULT_ABI, provider)
    const filter = vault.filters.ReserveObserved()
    return (): Promise<ReserveHistory> =>
      loadReserveHistory({
        latestBlock: () => provider.getBlockNumber(),
        getLogs: async (from, to) => {
          const logs = await vault.queryFilter(filter, from, to)
          return logs
            .filter((l): l is typeof l & { args: unknown } => 'args' in l)
            .map(
              (l) =>
                ({
                  blockNumber: l.blockNumber,
                  args: l.args as unknown as RawReserveLog['args'],
                }) satisfies RawReserveLog
            )
        },
      })
  }, [chain])
  return useAsync(load)
}
