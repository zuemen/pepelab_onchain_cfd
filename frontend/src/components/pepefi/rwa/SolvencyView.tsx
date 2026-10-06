import type { ReactNode } from 'react'
import type { ReadSource } from 'src/lib/pepefi/readChain'
import type { ReserveHistory, SolvencySnapshot } from 'src/lib/pepefi/solvency'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'
import { readingText } from 'src/lib/pepefi/rwaLabels'
import { formatAmount, formatRatio, buildWaterfall } from 'src/lib/pepefi/solvency'

import { LossWaterfall } from './LossWaterfall'
import { RwaPagesNav } from './RwaPagesNav'
import { ChainSourceNote } from './ChainSourceNote'
import { ReserveRatioChart } from './ReserveRatioChart'

export interface SolvencyViewProps {
  snapshot: SolvencySnapshot | null
  loading: boolean
  history: ReserveHistory | null
  historyLoading: boolean
  chainId: number | null
  source: ReadSource
  onReload?: () => void
  /** 上一次成功讀取的時間（unix 秒）。 */
  updatedAt?: number | null
  /** 最近一次重新讀取失敗（畫面上是上一次成功的資料）。 */
  stale?: boolean
}

function Stat({ label, value, testId, children }: { label: string; value: string; testId?: string; children?: ReactNode }) {
  return (
    <Box data-testid={testId} sx={{ py: 0.75 }}>
      <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
        {label}
      </Typography>
      <Typography variant="h6" sx={{ fontFamily: 'monospace', fontWeight: 700, lineHeight: 1.3, wordBreak: 'break-all' }}>
        {value}
      </Typography>
      {children}
    </Box>
  )
}

function Section({ title, children, testId }: { title: string; children: ReactNode; testId?: string }) {
  return (
    <Card variant="outlined" data-testid={testId} sx={{ p: 2.5 }}>
      <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>
        {title}
      </Typography>
      {children}
    </Card>
  )
}

const Caption = ({ children, warn = false }: { children: ReactNode; warn?: boolean }) => (
  <Typography variant="caption" component="p" sx={{ color: warn ? 'warning.dark' : 'text.secondary', lineHeight: 1.55 }}>
    {children}
  </Typography>
)

/** /solvency 的內容（不含資料讀取，方便測試）。 */
export function SolvencyView({ snapshot, loading, history, historyLoading, chainId, source, onReload, updatedAt = null, stale = false }: SolvencyViewProps) {
  const s = t.rwa.solvency
  // decimals 讀不到時不猜 18：金額一律改成「小數位數讀取失敗」。
  const dec = snapshot ? snapshot.usdcDecimals : 18
  const usdc = (v: bigint) => (dec === null ? t.rwa.common.decimalsFailed : `${formatAmount(v, dec)} USDC`)
  const pos = snapshot?.positions
  const vault = snapshot?.vault

  const posValue = (pick: (p: NonNullable<typeof pos>) => bigint, signed = false) => {
    if (!pos) return t.rwa.common.loading
    if (pos.status === 'failed') return t.rwa.common.readFailed
    if (pos.status === 'unsupported') return t.rwa.common.notInDeployment
    const v = pick(pos)
    return `${signed && v > 0n ? '+' : ''}${usdc(v)}`
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <RwaPagesNav current="solvency" />
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          {s.title}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 860 }}>
          {s.subtitle}
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

      {dec === null && (
        <Alert severity="error" variant="outlined" data-testid="solvency-decimals-failed">
          {t.rwa.common.decimalsFailed}
        </Alert>
      )}

      <Alert severity="warning" variant="outlined" data-testid="solvency-not-por">
        {s.notPoR}
      </Alert>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: 'repeat(3, minmax(0, 1fr))' } }}>
        <Section title={s.exchangeTitle} testId="solvency-exchange">
          <Stat
            label={s.exchangeBalance}
            testId="exchange-balance"
            value={snapshot ? readingText(snapshot.exchangeBalance, usdc) : t.rwa.common.loading}
          />
          <Stat label={s.totalMargin} testId="total-margin" value={posValue((p) => p.totalMargin)} />
          <Stat label={s.unrealizedPnl} testId="unrealized-pnl" value={posValue((p) => p.unrealizedPnl, true)} />
          {pos && (pos.status === 'ok' || pos.status === 'partial') && (
            <>
              <Caption>
                {pos.nextId === 0 ? s.noPositions : interpolate(s.openPositions, { open: pos.open, scanned: pos.scanned })}
              </Caption>
              {pos.missed + pos.pnlMissed > 0 && (
                <Caption warn>{interpolate(s.positionsPartial, { n: pos.missed + pos.pnlMissed })}</Caption>
              )}
              {pos.truncated && <Caption warn>{interpolate(s.positionsTruncated, { n: pos.scanned })}</Caption>}
            </>
          )}
          <Caption>{s.freeMarginNote}</Caption>
        </Section>

        <Section title={s.insuranceTitle} testId="solvency-insurance">
          <Stat
            label={s.insuranceAssets}
            testId="insurance-assets"
            value={snapshot ? readingText(snapshot.insuranceAssets, usdc) : t.rwa.common.loading}
          />
          <Stat
            label={s.adl}
            testId="adl-state"
            value={snapshot ? readingText(snapshot.adl, (on) => (on ? s.adlOn : s.adlOff)) : t.rwa.common.loading}
          />
        </Section>

        <Section title={s.vaultTitle} testId="solvency-vault">
          {!vault ? (
            <Typography variant="body2">{t.rwa.common.loading}</Typography>
          ) : vault.status === 'notDeployed' ? (
            <Typography variant="body2">{t.rwa.common.notDeployed}</Typography>
          ) : vault.status !== 'ok' ? (
            <Typography variant="body2" color="error.main" data-testid="vault-failed">
              {vault.status === 'unsupported' ? t.rwa.common.notInDeployment : t.rwa.common.readFailed}
            </Typography>
          ) : (
            <>
              <Stat label={s.reserve} testId="vault-reserve" value={usdc(vault.value.reserve)} />
              <Stat label={s.liability} testId="vault-liability" value={usdc(vault.value.liability)} />
              <Stat
                label={s.ratio}
                testId="vault-ratio"
                value={
                  vault.value.unpriced > 0 || vault.value.stale
                    ? t.rwa.common.unknown
                    : vault.value.ratioBps === null
                      ? s.ratioNoLiability
                      : formatRatio(vault.value.ratioBps)
                }
              />
              <Caption>
                {readingText(vault.value.minRatioBps, (b) => interpolate(s.ratioMin, { pct: formatRatio(b) }))}
              </Caption>
              <Caption warn={vault.value.unpriced > 0 || vault.value.stale}>
                {vault.value.unpriced > 0 || vault.value.stale
                  ? interpolate(s.ratioStale, { n: vault.value.unpriced })
                  : s.ratioOk}
              </Caption>
              {vault.value.halted && <Caption warn>{s.mintingHalted}</Caption>}
            </>
          )}
          <Caption warn>{s.notFullyBacked}</Caption>
        </Section>
      </Box>

      <ReserveRatioChart history={history} loading={historyLoading} />

      {snapshot && <LossWaterfall layers={buildWaterfall(snapshot)} decimals={dec} />}
    </Box>
  )
}
