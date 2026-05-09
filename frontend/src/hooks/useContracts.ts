import { useMemo } from 'react'
import { Contract } from 'ethers'
import type { BrowserProvider, Signer } from 'ethers'
import { getAddresses } from '../contracts/addresses'
import MockUSDCABI          from '../contracts/abi/MockUSDC.json'
import MockOracleABI        from '../contracts/abi/MockOracle.json'
import FeeRouterABI         from '../contracts/abi/FeeRouter.json'
import PerpetualExchangeABI from '../contracts/abi/PerpetualExchange.json'
import StrategyRegistryABI  from '../contracts/abi/StrategyRegistry.json'
import CopyTrackerABI       from '../contracts/abi/CopyTracker.json'

export function useContracts(
  provider: BrowserProvider | null,
  signer:   Signer | null,
  chainId:  number | null = null,
) {
  return useMemo(() => {
    const runner = signer ?? provider
    if (!runner) return null
    const addr = getAddresses(chainId)
    if (!addr) return null
    return {
      usdc:        new Contract(addr.MockUSDC,          MockUSDCABI,          runner),
      oracle:      new Contract(addr.MockOracle,        MockOracleABI,        runner),
      feeRouter:   new Contract(addr.FeeRouter,         FeeRouterABI,         runner),
      exchange:    new Contract(addr.PerpetualExchange, PerpetualExchangeABI, runner),
      registry:    new Contract(addr.StrategyRegistry,  StrategyRegistryABI,  runner),
      copyTracker: new Contract(addr.CopyTracker,       CopyTrackerABI,       runner),
    }
  }, [provider, signer, chainId])
}
