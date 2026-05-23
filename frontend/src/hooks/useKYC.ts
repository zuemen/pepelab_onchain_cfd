import { useState, useEffect, useCallback } from 'react'
import type { Contract } from 'ethers'

export function useKYC(
  kycRegistry: Contract | null,
  address:     string   | null,
): { isVerified: boolean; loading: boolean; refetch: () => void } {
  const [isVerified, setIsVerified] = useState(false)
  const [loading,    setLoading]    = useState(false)
  const [tick,       setTick]       = useState(0)

  const refetch = useCallback(() => setTick(t => t + 1), [])

  useEffect(() => {
    if (!kycRegistry || !address) { setIsVerified(false); return }
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const ok = await kycRegistry.isVerified(address) as boolean
        if (!cancelled) setIsVerified(ok)
      } catch {
        if (!cancelled) setIsVerified(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => { cancelled = true }
  }, [kycRegistry, address, tick])

  return { isVerified, loading, refetch }
}
