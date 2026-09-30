import type { Signer, BrowserProvider } from 'ethers'

import { useMemo } from 'react'
import { Contract } from 'ethers'

import { getV2Stack, hasV2Stack } from 'src/contracts/addresses'
import { isDeployed } from 'src/lib/pepefi/safeRead'
import AssetVaultV2ABI  from 'src/contracts/abi/AssetVaultV2.json'
import GuardedOracleABI from 'src/contracts/abi/GuardedOracle.json'
import ESGRegistryV2ABI from 'src/contracts/abi/ESGRegistryV2.json'

/**
 * Contracts for the V2 hardened stack, or null when V2 isn't deployed on this
 * chain. Deliberately separate from useContracts: V1 and V2 run side by side,
 * and a caller must be explicit about which one it is talking to.
 *
 * Interface differences that bite — see AssetVaultV2.sol:
 *   previewMint / previewRedeem both return a TUPLE (amount, feePaid) here,
 *   while V1 returns a single uint256. Destructuring V1's return, or failing to
 *   destructure V2's, silently yields the wrong number rather than throwing.
 *
 * 回傳 null 時呼叫端走舊版金庫（V1）分支（TokenizedAssetsPage、useSynthHoldings
 * 等）。那些分支在 #129 關閉後可刪除——刪除前的兩個前提（本機 Anvil 的 V2_STACK、
 * V1 代幣持有人的贖回路徑）寫在 TokenizedAssetsPage 的 TODO(#132 殘項)。
 */
export function useV2Contracts(
  provider: BrowserProvider | null,
  signer:   Signer | null,
  chainId:  number | null = null,
) {
  return useMemo(() => {
    const runner = signer ?? provider
    if (!runner) return null
    // A chain can have a V2_STACK entry that is still all-0x0 (a cutover in
    // progress — see docs/DEPLOY_129_CUTOVER.md). Treat that as "not deployed"
    // so the caller falls back to V1 instead of dialing 0x0.
    const stack = getV2Stack(chainId)
    if (!stack || !hasV2Stack(chainId)) return null
    return {
      vault:     new Contract(stack.AssetVaultV2,  AssetVaultV2ABI,  runner),
      oracle:    new Contract(stack.GuardedOracle, GuardedOracleABI, runner),
      /**
        * #152：見證碳等級的來源（medianCarbonTier）。位址在 V2_STACK 裡是選用的
        * ——#129 之前部署的 stack 沒有它——所以這裡可能是 null,呼叫端必須處理
        * 「這條鏈有 V2 但沒有 ESGRegistryV2」這個狀態,不能假設有 V2 就有它。
        */
      esgRegistryV2: stack.ESGRegistryV2 && isDeployed(stack.ESGRegistryV2)
        ? new Contract(stack.ESGRegistryV2, ESGRegistryV2ABI, runner)
        : null,
      tokens:    stack.tokens,
      vaultAddr: stack.AssetVaultV2,
      oracleAddr: stack.GuardedOracle,
    }
  }, [provider, signer, chainId])
}
