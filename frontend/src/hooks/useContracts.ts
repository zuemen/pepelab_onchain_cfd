import { useMemo } from 'react'
import { Contract } from 'ethers'
import type { BrowserProvider, Signer } from 'ethers'
import { getAddresses } from '../contracts/addresses'
import MockUSDCABI          from '../contracts/abi/MockUSDC.json'
import MockOracleABI        from '../contracts/abi/MockOracle.json'
import TraderStakeABI       from '../contracts/abi/TraderStake.json'
import InsuranceVaultABI    from '../contracts/abi/InsuranceVault.json'
import FeeRouterABI         from '../contracts/abi/FeeRouter.json'
import PerpetualExchangeABI from '../contracts/abi/PerpetualExchange.json'
import StrategyRegistryABI  from '../contracts/abi/StrategyRegistry.json'
import CopyTrackerABI       from '../contracts/abi/CopyTracker.json'
import MockSwapRouterABI    from '../contracts/abi/MockSwapRouter.json'
import ESGRegistryABI       from '../contracts/abi/ESGRegistry.json'
import KYCRegistryABI       from '../contracts/abi/KYCRegistry.json'
import PepeAMMABI           from '../contracts/abi/PepeAMM.json'
import PepeTokenABI         from '../contracts/abi/PepeToken.json'
import PepeClaimABI         from '../contracts/abi/PepeClaim.json'

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
      usdc:           new Contract(addr.MockUSDC,          MockUSDCABI,          runner),
      oracle:         new Contract(addr.MockOracle,        MockOracleABI,        runner),
      traderStake:    new Contract(addr.TraderStake,       TraderStakeABI,       runner),
      insuranceVault: new Contract(addr.InsuranceVault,    InsuranceVaultABI,    runner),
      feeRouter:      new Contract(addr.FeeRouter,         FeeRouterABI,         runner),
      exchange:       new Contract(addr.PerpetualExchange, PerpetualExchangeABI, runner),
      registry:       new Contract(addr.StrategyRegistry,  StrategyRegistryABI,  runner),
      copyTracker:    new Contract(addr.CopyTracker,       CopyTrackerABI,       runner),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRouter:     new Contract(addr.MockSwapRouter,    (MockSwapRouterABI as any).abi ?? MockSwapRouterABI, runner),
      esgRegistry:    new Contract(addr.ESGRegistry,       ESGRegistryABI,       runner),
      kycRegistry:    new Contract(addr.KYCRegistry,       KYCRegistryABI,       runner),
      pepeAMM:        new Contract(addr.PepeAMM,           PepeAMMABI,           runner),
      pepeToken:      new Contract(addr.PepeToken,         PepeTokenABI,         runner),
      pepeClaim:      new Contract(addr.PepeClaim,         PepeClaimABI,         runner),
    }
  }, [provider, signer, chainId])
}
