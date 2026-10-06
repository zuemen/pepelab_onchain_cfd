import Container from '@mui/material/Container'

import { useSolvency, useReadChain, useReserveHistory } from 'src/hooks/useRwaTransparency'

import { SolvencyView } from 'src/components/pepefi/rwa/SolvencyView'

// /solvency：儲備與償付能力。資料來源與限制見 docs/RWA_TRANSPARENCY.md §3。

export default function SolvencyPage() {
  const chain = useReadChain()
  const solvency = useSolvency(chain)
  const history = useReserveHistory(chain)

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
      <SolvencyView
        snapshot={solvency.data}
        loading={solvency.loading}
        history={history.data}
        historyLoading={history.loading}
        chainId={chain.chainId}
        source={chain.source}
        onReload={() => {
          solvency.reload()
          history.reload()
        }}
      />
    </Container>
  )
}
