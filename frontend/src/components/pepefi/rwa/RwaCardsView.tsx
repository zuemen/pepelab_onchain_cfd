import type { ReadSource } from 'src/lib/pepefi/readChain'
import type { RwaSnapshot } from 'src/lib/pepefi/rwaCards'
import type { AssetSymbol } from 'src/contracts/addresses'

import Box from '@mui/material/Box'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

import { t } from 'src/locales'

import { RwaAssetCard } from './RwaAssetCard'
import { RwaPagesNav } from './RwaPagesNav'
import { ChainSourceNote } from './ChainSourceNote'
import { ComplianceDisclosure } from './ComplianceDisclosure'

export interface RwaCardsViewProps {
  symbols: readonly AssetSymbol[]
  snapshot: RwaSnapshot | null
  loading: boolean
  chainId: number | null
  source: ReadSource
  nowSec: number
  onReload?: () => void
  /** 上一次成功讀取的時間（unix 秒）。 */
  updatedAt?: number | null
  /** 最近一次重新讀取失敗（畫面上是上一次成功的資料）。 */
  stale?: boolean
}

/** /rwa 的內容（不含資料讀取，方便測試）。 */
export function RwaCardsView({ symbols, snapshot, loading, chainId, source, nowSec, onReload, updatedAt = null, stale = false }: RwaCardsViewProps) {
  const c = t.rwa.cards
  const allFailed =
    !loading &&
    snapshot !== null &&
    snapshot.kycAddress.status === 'failed' &&
    Object.values(snapshot.perAsset).every((a) => a.rwaFlag.status === 'failed')

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <RwaPagesNav current="cards" />
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          {c.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 860 }}>
          {c.subtitle}
        </Typography>
        <Box sx={{ mt: 1, display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <ChainSourceNote chainId={chainId} source={source} updatedAt={updatedAt} failed={stale} />
          {onReload && source !== null && (
            <Button size="small" variant="text" onClick={onReload} disabled={loading}>
              {loading ? t.rwa.common.loading : t.rwa.common.retry}
            </Button>
          )}
        </Box>
      </Box>

      <ComplianceDisclosure />

      {allFailed && (
        <Alert severity="error" variant="outlined" data-testid="rwa-load-failed">
          {c.loadFailed}
        </Alert>
      )}

      <Box
        sx={{
          display: 'grid',
          gap: 2,
          gridTemplateColumns: { xs: '1fr', md: 'repeat(2, minmax(0, 1fr))', xl: 'repeat(3, minmax(0, 1fr))' },
        }}
      >
        {symbols.map((symbol) => (
          <RwaAssetCard
            key={symbol}
            symbol={symbol}
            chain={snapshot?.perAsset[symbol]}
            kycAddress={snapshot?.kycAddress}
            modeSupport={snapshot?.modeSupport}
            nowSec={nowSec}
          />
        ))}
      </Box>
    </Box>
  )
}
