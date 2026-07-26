import type { Contract } from 'ethers';
import type { Stable } from 'src/lib/pepefi/stablecoin';

import { useState, useEffect, useCallback } from 'react';

import { getStable, setStable as persistStable } from 'src/lib/pepefi/stablecoin';

type ContractsLike = { usdc: Contract; usdt: Contract } | null;

/// Selected stablecoin plus the matching ethers Contract. Stays in sync across
/// components via the 'pepefi:stable-changed' event.
export function useStablecoin(contracts: ContractsLike) {
  const [stable, setStableState] = useState<Stable>(getStable());

  useEffect(() => {
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent<Stable>).detail;
      if (detail === 'USDC' || detail === 'USDT') setStableState(detail);
    };
    window.addEventListener('pepefi:stable-changed', onChange);
    return () => window.removeEventListener('pepefi:stable-changed', onChange);
  }, []);

  const setStable = useCallback((s: Stable) => {
    persistStable(s);
    setStableState(s);
  }, []);

  const token: Contract | null = !contracts
    ? null
    : stable === 'USDC'
      ? contracts.usdc
      : contracts.usdt;

  return { stable, setStable, token };
}
