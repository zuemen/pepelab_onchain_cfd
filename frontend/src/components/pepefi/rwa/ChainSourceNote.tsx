import type { ReadSource } from 'src/lib/pepefi/readChain'

import Alert from '@mui/material/Alert'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'
import { CHAIN_NAMES } from 'src/contracts/addresses'

/** 頁首的一行：這一頁從哪條鏈、哪個節點讀（唯讀）。沒有節點時改成提示。 */
export function ChainSourceNote({ chainId, source }: { chainId: number | null; source: ReadSource }) {
  if (source === null || chainId === null) {
    return (
      <Alert severity="info" variant="outlined" data-testid="rwa-no-provider">
        {t.rwa.common.noProvider}
      </Alert>
    )
  }
  const chain = CHAIN_NAMES[chainId] ?? `chainId ${chainId}`
  return (
    <Typography variant="caption" color="text.secondary" data-testid="rwa-chain-source">
      {interpolate(source === 'public' ? t.rwa.common.chainSourcePublic : t.rwa.common.chainSourceWallet, {
        chain: `${chain} (${chainId})`,
      })}
    </Typography>
  )
}
