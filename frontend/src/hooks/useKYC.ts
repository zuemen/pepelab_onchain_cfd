import { useState, useEffect, useCallback } from 'react'
import type { Contract } from 'ethers'

const ZERO = '0x0000000000000000000000000000000000000000'

export function useKYC(kycRegistry: Contract | null, userAddress: string | null) {
  const [isVerified, setIsVerified] = useState(true)

  const refetch = useCallback(async () => {
    if (!kycRegistry || !userAddress) { setIsVerified(true); return }
    const addr = String(kycRegistry.target).toLowerCase()
    if (addr === ZERO) { setIsVerified(true); return }
    try {
      const v = await kycRegistry.isVerified(userAddress)
      setIsVerified(Boolean(v))
    } catch (e) {
      console.warn('[useKYC] isVerified call failed, defaulting to allowed:', e)
      setIsVerified(true)
    }
  }, [kycRegistry, userAddress])

  useEffect(() => { void refetch() }, [refetch])

  return { isVerified, refetch }
}
