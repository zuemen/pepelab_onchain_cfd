import { Link as RouterLink } from 'react-router'

import Link from '@mui/material/Link'
import Alert from '@mui/material/Alert'
import Container from '@mui/material/Container'
import AlertTitle from '@mui/material/AlertTitle'

import { t } from 'src/locales'

/** 交易者頁與跟單頁共用：位址在 hiddenTraders.ts 的名單上時，整頁換成這段說明（#383）。 */
export default function HiddenTraderNotice() {
  const h = t.marketplace.hiddenTrader
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Alert severity="info" variant="outlined">
        <AlertTitle>{h.title}</AlertTitle>
        {h.body}{' '}
        <Link component={RouterLink} to="/marketplace">{h.back}</Link>
      </Alert>
    </Container>
  )
}
