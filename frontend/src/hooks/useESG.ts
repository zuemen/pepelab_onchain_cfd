import { useState, useEffect } from 'react'
import type { Contract } from 'ethers'
import { ASSET_IDS } from 'src/contracts/addresses'

export interface ESGInfo {
  environmental: number
  social:        number
  governance:    number
  composite:     number
  rating:        string
}

const ASSETS = [
  ASSET_IDS.sBTC,
  ASSET_IDS.sETH,
  ASSET_IDS.sAAPL,
  ASSET_IDS.sTSLA,
  ASSET_IDS.sGOLD,
  ASSET_IDS.sBOND,
  ASSET_IDS.sNVDA,
  ASSET_IDS.sMSFT,
  ASSET_IDS.sGOOGL,
  ASSET_IDS.sICLN,
  ASSET_IDS.sESGU,
]

export interface UseESGResult {
  data:   Record<string, ESGInfo>
  loaded: boolean
  error:  boolean
}

export function useESG(esgRegistry: Contract | null): UseESGResult {
  const [data,   setData]   = useState<Record<string, ESGInfo>>({})
  const [loaded, setLoaded] = useState(false)
  const [error,  setError]  = useState(false)

  useEffect(() => {
    if (!esgRegistry) return
    let cancelled = false
    setLoaded(false)
    setError(false)
    void (async () => {
      try {
        const out: Record<string, ESGInfo> = {}
        for (const id of ASSETS) {
          try {
            const d = await esgRegistry.getESG(id)
            const e = Number(d.environmental)
            const s = Number(d.social)
            const g = Number(d.governance)
            out[id] = {
              environmental: e,
              social:        s,
              governance:    g,
              composite:     Math.round((e + s + g) / 3),
              rating:        d.rating as string,
            }
          } catch { /* asset not rated */ }
        }
        if (!cancelled) {
          setData(out)
          setLoaded(true)
          if (Object.keys(out).length === 0) setError(true)
        }
      } catch {
        if (!cancelled) { setLoaded(true); setError(true) }
      }
    })()
    return () => { cancelled = true }
  }, [esgRegistry])

  return { data, loaded, error }
}
