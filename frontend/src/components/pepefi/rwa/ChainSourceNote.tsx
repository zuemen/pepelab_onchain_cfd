import type { ReadSource } from 'src/lib/pepefi/readChain'

import Alert from '@mui/material/Alert'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'
import { CHAIN_NAMES } from 'src/contracts/addresses'
import { timeText } from 'src/lib/pepefi/rwaLabels'

/** 頁首的一行：這一頁從哪條鏈、哪個節點讀（唯讀）。沒有節點時改成提示。 */
export function ChainSourceNote({
  chainId,
  source,
  updatedAt = null,
  failed = false,
}: {
  chainId: number | null
  source: ReadSource
  /** 上一次成功讀取的時間（unix 秒）。 */
  updatedAt?: number | null
  /** 最近一次重新讀取失敗：畫面上的資料是上一次成功的那份。 */
  failed?: boolean
}) {
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
      {updatedAt !== null && (
        <Typography
          component="span"
          variant="caption"
          data-testid="rwa-last-read"
          sx={{ ml: 1, color: failed ? 'warning.dark' : 'text.secondary', fontWeight: failed ? 700 : 400 }}
        >
          · {interpolate(t.rwa.common.lastRead, { at: timeText(updatedAt) })}
          {failed && ` · ${t.rwa.common.readFailed}`}
        </Typography>
      )}
    </Typography>
  )
}
