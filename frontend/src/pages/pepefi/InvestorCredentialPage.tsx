import type { WalletAPI } from 'src/hooks/useWallet'

import { useOutletContext } from 'react-router'

import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'

import { t } from 'src/locales'

import { InvestorCredentialPanel } from 'src/components/pepefi/InvestorCredentialPanel'

// ----------------------------------------------------------------------

/** /credentials：合格投資人憑證（VC）→ RWA 市場資格。docs/SSI_RWA_ACCESS.md。 */
export default function InvestorCredentialPage() {
  const wallet = useOutletContext<WalletAPI>()
  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" sx={{ mb: 3 }}>
        {t.investorVc.pageTitle}
      </Typography>
      <InvestorCredentialPanel wallet={wallet} />
    </Container>
  )
}
