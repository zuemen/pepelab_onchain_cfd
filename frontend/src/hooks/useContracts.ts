import type { Signer, BrowserProvider } from 'ethers'

import { useMemo } from 'react'
import { Contract } from 'ethers'

import { getAddresses } from 'src/contracts/addresses'
import MockUSDCABI              from 'src/contracts/abi/MockUSDC.json'
import FeeRouterABI             from 'src/contracts/abi/FeeRouter.json'
import MockOracleABI            from 'src/contracts/abi/MockOracle.json'
import TraderStakeABI           from 'src/contracts/abi/TraderStake.json'
import CopyTrackerABI           from 'src/contracts/abi/CopyTracker.json'
import ESGRegistryABI           from 'src/contracts/abi/ESGRegistry.json'
import KYCRegistryABI           from 'src/contracts/abi/KYCRegistry.json'
import InsuranceVaultABI        from 'src/contracts/abi/InsuranceVault.json'
import MockSwapRouterABI        from 'src/contracts/abi/MockSwapRouter.json'
import StrategyRegistryABI      from 'src/contracts/abi/StrategyRegistry.json'
import PerpetualExchangeABI     from 'src/contracts/abi/PerpetualExchange.json'
import PepeAMMABI               from 'src/contracts/abi/PepeAMM.json'
import PepeTokenABI             from 'src/contracts/abi/PepeToken.json'
import PepeClaimABI             from 'src/contracts/abi/PepeClaim.json'
import EsgRewardDistributorABI  from 'src/contracts/abi/EsgRewardDistributor.json'

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
      usdc:                 new Contract(addr.MockUSDC,             MockUSDCABI,             runner),
      oracle:               new Contract(addr.MockOracle,           MockOracleABI,           runner),
      traderStake:          new Contract(addr.TraderStake,          TraderStakeABI,          runner),
      insuranceVault:       new Contract(addr.InsuranceVault,       InsuranceVaultABI,       runner),
      feeRouter:            new Contract(addr.FeeRouter,            FeeRouterABI,            runner),
      exchange:             new Contract(addr.PerpetualExchange,    PerpetualExchangeABI,    runner),
      registry:             new Contract(addr.StrategyRegistry,     StrategyRegistryABI,     runner),
      copyTracker:          new Contract(addr.CopyTracker,          CopyTrackerABI,          runner),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      swapRouter:           new Contract(addr.MockSwapRouter,       (MockSwapRouterABI as any).abi ?? MockSwapRouterABI, runner),
      esgRegistry:          new Contract(addr.ESGRegistry,          ESGRegistryABI,          runner),
      kycRegistry:          new Contract(addr.KYCRegistry,          KYCRegistryABI,          runner),
      pepeAMM:              new Contract(addr.PepeAMM,              PepeAMMABI,              runner),
      pepeToken:            new Contract(addr.PepeToken,            PepeTokenABI,            runner),
      pepeClaim:            new Contract(addr.PepeClaim,            PepeClaimABI,            runner),
      esgRewardDistributor: new Contract(addr.EsgRewardDistributor, EsgRewardDistributorABI, runner),
    }
  }, [provider, signer, chainId])
}
