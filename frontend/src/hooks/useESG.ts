import { useState, useEffect } from 'react'
import type { Contract } from 'ethers'
import { ASSET_IDS } from '../contracts/addresses'

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

export function useESG(esgRegistry: Contract | null): Record<string, ESGInfo> {
  const [data, setData] = useState<Record<string, ESGInfo>>({})

  useEffect(() => {
    if (!esgRegistry) return
    let cancelled = false
    void (async () => {
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
        } catch { /* asset not rated or contract not deployed */ }
      }
      if (!cancelled) setData(out)
    })()
    return () => { cancelled = true }
  }, [esgRegistry])

  return data
}
