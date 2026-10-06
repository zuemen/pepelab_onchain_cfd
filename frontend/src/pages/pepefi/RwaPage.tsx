import { useState, useEffect } from 'react'

import Container from '@mui/material/Container'

import { RWA_CARD_ORDER } from 'src/lib/pepefi/rwaProfile'
import { useReadChain, useRwaSnapshot } from 'src/hooks/useRwaTransparency'

import { RwaCardsView } from 'src/components/pepefi/rwa/RwaCardsView'

// /rwa：RWA 資產卡與法遵揭露。資料來源與限制見 docs/RWA_TRANSPARENCY.md §1。

export default function RwaPage() {
  const chain = useReadChain()
  const { data, loading, reload, updatedAt, failed } = useRwaSnapshot(chain, RWA_CARD_ORDER)
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000))

  // 「目前是否休市」每分鐘重算一次（只看排定時段，不必重讀鏈）。
  useEffect(() => {
    const timer = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 60_000)
    return () => clearInterval(timer)
  }, [])

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <RwaCardsView
        symbols={RWA_CARD_ORDER}
        snapshot={data}
        loading={loading}
        chainId={chain.chainId}
        source={chain.source}
        nowSec={nowSec}
        onReload={reload}
        updatedAt={updatedAt}
        stale={failed}
      />
    </Container>
  )
}
