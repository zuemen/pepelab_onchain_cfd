import { useMemo } from 'react'

import Container from '@mui/material/Container'

import { RWA_CARD_ORDER } from 'src/lib/pepefi/rwaProfile'
import { buildWitnessRows } from 'src/lib/pepefi/oracleWitness'
import { useReadChain, useOnchainQuotes, useReferencePrices } from 'src/hooks/useRwaTransparency'

import { OracleWitnessView } from 'src/components/pepefi/rwa/OracleWitnessView'

// /oracle：參考價多源見證看板。資料來源與限制見 docs/RWA_TRANSPARENCY.md §2。

export default function OraclePage() {
  const chain = useReadChain()
  const onchain = useOnchainQuotes(chain, RWA_CARD_ORDER)
  const reference = useReferencePrices()

  const ref = reference.data?.status === 'ok' ? reference.data.report : null
  const rows = useMemo(
    () => buildWitnessRows(RWA_CARD_ORDER, onchain.data, ref, Math.floor(Date.now() / 1000)),
    [onchain.data, ref]
  )

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <OracleWitnessView
        rows={rows}
        onchainLoading={onchain.loading}
        reference={reference.loading && !reference.data ? null : reference.data}
        localClock={onchain.data !== null && onchain.data.blockTime === null}
        maxPriceAge={onchain.data?.maxPriceAge ?? null}
        chainId={chain.chainId}
        source={chain.source}
        onReload={() => {
          onchain.reload()
          reference.reload()
        }}
      />
    </Container>
  )
}
