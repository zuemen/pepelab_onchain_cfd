import type { ReadSource } from 'src/lib/pepefi/readChain'
import type { WitnessRow, RefFetchResult, WitnessSource } from 'src/lib/pepefi/oracleWitness'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Alert from '@mui/material/Alert'
import Table from '@mui/material/Table'
import Button from '@mui/material/Button'
import TableRow from '@mui/material/TableRow'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import Typography from '@mui/material/Typography'
import TableContainer from '@mui/material/TableContainer'

import { t, interpolate } from 'src/locales'
import { deviationLevel } from 'src/lib/pepefi/oracleWitness'
import { usd, ageText, timeText, signedBps } from 'src/lib/pepefi/rwaLabels'

import { RwaPagesNav } from './RwaPagesNav'
import { ChainSourceNote } from './ChainSourceNote'

export interface OracleWitnessViewProps {
  rows: WitnessRow[]
  onchainLoading: boolean
  /** null = 還在讀鏈下參考價。 */
  reference: RefFetchResult | null
  /** 價格年齡是不是用本機時鐘算的（鏈上時間讀不到）。 */
  localClock: boolean
  maxPriceAge: number | null
  chainId: number | null
  source: ReadSource
  onReload?: () => void
}

const LEVEL_COLOR = { ok: 'success', warn: 'warning', alert: 'error' } as const

function SourceLine({ s }: { s: WitnessSource }) {
  const o = t.rwa.oracle
  const name = t.rwa.cards.sourceName[s.provider]
  const level = deviationLevel(s.deviationBps)
  return (
    <Box data-testid={`src-${s.provider}`} sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'baseline', py: 0.25 }}>
      <Typography variant="body2" sx={{ fontWeight: 600 }}>
        {name}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {s.ticker} · {o.role[s.role]}
      </Typography>
      {s.price === null ? (
        <Typography variant="caption" color="error.main">
          {interpolate(o.sourceError, { reason: s.error ?? '—' })}
        </Typography>
      ) : (
        <>
          <Typography variant="body2" sx={{ fontFamily: 'monospace' }}>
            {usd(s.price)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            ({s.quoteTime !== null ? timeText(s.quoteTime) : (s.quoteTimeText ?? o.quoteTimeNone)})
          </Typography>
          {s.deviationBps !== null && level && (
            <Chip
              size="small"
              variant="outlined"
              color={LEVEL_COLOR[level]}
              label={`${signedBps(s.deviationBps)} · ${o.deviationLevel[level]}`}
              sx={{ height: 20, fontSize: 11 }}
            />
          )}
        </>
      )}
    </Box>
  )
}

/** /oracle 的內容（不含資料讀取，方便測試）。 */
export function OracleWitnessView({
  rows,
  onchainLoading,
  reference,
  localClock,
  maxPriceAge,
  chainId,
  source,
  onReload,
}: OracleWitnessViewProps) {
  const o = t.rwa.oracle
  const refFailed = reference?.status === 'failed' ? reference.reason : null
  const generatedAt = reference?.status === 'ok' ? reference.report.generatedAt : null

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <RwaPagesNav current="oracle" />
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          {o.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 860 }}>
          {o.subtitle}
        </Typography>
        <Box sx={{ mt: 1, display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <ChainSourceNote chainId={chainId} source={source} />
          {onReload && (
            <Button size="small" variant="text" onClick={onReload} disabled={onchainLoading}>
              {onchainLoading ? t.rwa.common.loading : t.rwa.common.retry}
            </Button>
          )}
        </Box>
      </Box>

      <Alert severity="warning" variant="outlined" data-testid="oracle-written-only">
        {o.writtenOnlyNote}
      </Alert>

      {reference === null && (
        <Alert severity="info" variant="outlined">
          {o.offchainLoading}
        </Alert>
      )}
      {refFailed !== null && (
        <Alert severity="error" variant="outlined" data-testid="oracle-offchain-failed">
          {interpolate(o.offchainUnavailable, { reason: refFailed })}
        </Alert>
      )}

      <Card variant="outlined">
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{o.colAsset}</TableCell>
                <TableCell>{o.colOnchain}</TableCell>
                <TableCell>{o.colWritten}</TableCell>
                <TableCell>{o.colAge}</TableCell>
                <TableCell sx={{ minWidth: 360 }}>{o.colSources}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => {
                const stale = r.ageSec !== null && maxPriceAge !== null && r.ageSec > maxPriceAge
                return (
                  <TableRow key={r.symbol} data-testid={`oracle-row-${r.symbol}`}>
                    <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{r.symbol}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                      {r.onchain.price !== null ? usd(r.onchain.price) : onchainLoading ? t.rwa.common.loading : o.onchainFailed}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {r.onchain.updatedAt !== null ? timeText(r.onchain.updatedAt) : '—'}
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', color: stale ? 'error.main' : undefined }}>
                      {r.ageSec !== null ? ageText(r.ageSec) : '—'}
                    </TableCell>
                    <TableCell>
                      {r.sources === null ? (
                        <Typography variant="caption" color="text.secondary">
                          —
                        </Typography>
                      ) : (
                        <>
                          {r.sources.map((s) => (
                            <SourceLine key={`${s.provider}-${s.ticker}`} s={s} />
                          ))}
                          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
                            {r.singleSource
                              ? o.singleSource
                              : interpolate(o.okSources, { ok: r.okCount, total: r.totalSources })}
                            {r.spreadBps !== null && ` · ${interpolate(o.spread, { bps: interpolate(t.rwa.common.bps, { n: r.spreadBps }) })}`}
                          </Typography>
                          {r.symbol === 'sGOLD' && (
                            <Typography variant="caption" color="warning.dark" component="p">
                              {o.goldNote}
                            </Typography>
                          )}
                        </>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Typography variant="caption" color="text.secondary">
          {o.ageNote}
          {localClock && ` ${o.ageLocalClock}`}
        </Typography>
        {maxPriceAge !== null && (
          <Typography variant="caption" color="text.secondary">
            {interpolate(o.maxAge, { age: ageText(maxPriceAge) })}
          </Typography>
        )}
        {generatedAt !== null && (
          <Typography variant="caption" color="text.secondary">
            {interpolate(o.offchainFrom, { at: timeText(generatedAt) })}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary">
          {o.licenseNote}
        </Typography>
      </Box>
    </Box>
  )
}
