import type { Signer, BrowserProvider } from 'ethers'

import { useMemo } from 'react'
import { Contract } from 'ethers'

import { getV2Stack } from 'src/contracts/addresses'
import AssetVaultV2ABI  from 'src/contracts/abi/AssetVaultV2.json'
import GuardedOracleABI from 'src/contracts/abi/GuardedOracle.json'

/**
 * Contracts for the V2 hardened stack, or null when V2 isn't deployed on this
 * chain. Deliberately separate from useContracts: V1 and V2 run side by side,
 * and a caller must be explicit about which one it is talking to.
 *
 * Interface differences that bite — see AssetVaultV2.sol:
 *   previewMint / previewRedeem both return a TUPLE (amount, feePaid) here,
 *   while V1 returns a single uint256. Destructuring V1's return, or failing to
 *   destructure V2's, silently yields the wrong number rather than throwing.
 */
export function useV2Contracts(
  provider: BrowserProvider | null,
  signer:   Signer | null,
  chainId:  number | null = null,
) {
  return useMemo(() => {
    const runner = signer ?? provider
    if (!runner) return null
    const stack = getV2Stack(chainId)
    if (!stack) return null
    return {
      vault:     new Contract(stack.AssetVaultV2,  AssetVaultV2ABI,  runner),
      oracle:    new Contract(stack.GuardedOracle, GuardedOracleABI, runner),
      tokens:    stack.tokens,
      vaultAddr: stack.AssetVaultV2,
      oracleAddr: stack.GuardedOracle,
    }
  }, [provider, signer, chainId])
}
