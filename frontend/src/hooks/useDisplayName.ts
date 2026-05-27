import { useState, useEffect, useCallback } from 'react'

import { getDisplayName, setDisplayName } from 'src/lib/pepefi/displayName'

export function useDisplayName(addr?: string | null): [string, (name: string) => void] {
  const [name, setName] = useState(() => getDisplayName(addr))

  useEffect(() => {
    setName(getDisplayName(addr))
  }, [addr])

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (addr && e.key === `pepefi:displayName:${addr.toLowerCase()}`) {
        setName(e.newValue ?? '')
      }
    }
    const onCustom = (e: Event) => {
      const ce = e as CustomEvent<{ addr: string; name: string }>
      if (addr && ce.detail.addr.toLowerCase() === addr.toLowerCase()) {
        setName(ce.detail.name)
      }
    }
    window.addEventListener('storage', onStorage)
    window.addEventListener('pepefi:displayName-changed', onCustom)
    return () => {
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('pepefi:displayName-changed', onCustom)
    }
  }, [addr])

  const save = useCallback(
    (newName: string) => {
      if (!addr) return
      setDisplayName(addr, newName)
      setName(newName)
    },
    [addr],
  )

  return [name, save]
}
