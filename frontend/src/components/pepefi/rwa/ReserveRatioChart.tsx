import type { ReserveHistory } from 'src/lib/pepefi/solvency'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Alert from '@mui/material/Alert'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'
import { timeText } from 'src/lib/pepefi/rwaLabels'
import { formatRatio, HISTORY_CHUNK, plottablePoints } from 'src/lib/pepefi/solvency'

const W = 640
const H = 180
const PAD = { l: 8, r: 8, t: 12, b: 12 }

/** 曲線座標（純函式，方便測試）：x 依時間、y 依準備率，單點時畫在中央。 */
export function chartPath(points: { timestamp: number; ratio: number }[]): string {
  if (points.length === 0) return ''
  const xs = points.map((p) => p.timestamp)
  const ys = points.map((p) => p.ratio)
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)]
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)]
  const sx = (x: number) => (x1 === x0 ? W / 2 : PAD.l + ((x - x0) / (x1 - x0)) * (W - PAD.l - PAD.r))
  const sy = (y: number) => (y1 === y0 ? H / 2 : PAD.t + (1 - (y - y0) / (y1 - y0)) * (H - PAD.t - PAD.b))
  return points.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.timestamp).toFixed(1)},${sy(p.ratio).toFixed(1)}`).join(' ')
}

/**
 * 準備率隨時間（ReserveObserved 事件）。null = 還在讀。
 * 讀取失敗顯示「讀取失敗」、沒有事件顯示「沒有事件」——兩者都不是 0。
 */
export function ReserveRatioChart({ history, loading }: { history: ReserveHistory | null; loading: boolean }) {
  const s = t.rwa.solvency
  const hours = Math.round(((history ? history.toBlock - history.fromBlock + 1 : 0) * 2) / 3600)
  const plot = history ? plottablePoints(history.points) : []
  const unknown = history ? history.points.length - plot.length : 0
  const series = plot.map((p) => ({ timestamp: p.timestamp, ratio: Number(p.ratioBps) }))
  const last = plot[plot.length - 1]

  return (
    <Card variant="outlined" data-testid="reserve-history" sx={{ p: 2.5 }}>
      <Typography variant="h6" sx={{ fontWeight: 800 }}>
        {s.historyTitle}
      </Typography>
      {history && history.status !== 'failed' && (
        <Typography variant="caption" color="text.secondary">
          {interpolate(s.historyWindow, {
            hours,
            from: history.fromBlock,
            to: history.toBlock,
            chunk: HISTORY_CHUNK,
          })}
        </Typography>
      )}

      <Box sx={{ mt: 1.5 }}>
        {history === null ? (
          <Typography variant="body2" color="text.secondary">
            {loading ? s.historyLoading : s.historyFailed}
          </Typography>
        ) : history.status === 'failed' ? (
          <Alert severity="error" variant="outlined" data-testid="reserve-history-failed">
            {s.historyFailed}
          </Alert>
        ) : (
          <>
            {history.status === 'partial' && (
              <Alert severity="warning" variant="outlined" sx={{ mb: 1 }} data-testid="reserve-history-partial">
                {interpolate(s.historyPartial, { failed: history.failedChunks, total: history.totalChunks })}
              </Alert>
            )}
            {history.points.length === 0 ? (
              <Typography variant="body2" color="text.secondary" data-testid="reserve-history-empty">
                {s.historyEmpty}
              </Typography>
            ) : (
              <>
                {series.length > 0 && (
                  <Box
                    component="svg"
                    viewBox={`0 0 ${W} ${H}`}
                    role="img"
                    aria-label={s.historyTitle}
                    sx={{ width: '100%', height: 'auto', maxHeight: 220, display: 'block' }}
                  >
                    <path d={chartPath(series)} fill="none" stroke="currentColor" strokeWidth={2} />
                    {series.length === 1 && (
                      <circle cx={W / 2} cy={H / 2} r={4} fill="currentColor" />
                    )}
                  </Box>
                )}
                <Typography variant="caption" color="text.secondary" component="p">
                  {interpolate(s.historyPoints, { n: history.points.length })}
                  {last && ` · ${timeText(last.timestamp)} · ${formatRatio(last.ratioBps ?? 0n)}`}
                </Typography>
                {series.length > 1 && (
                  <Typography variant="caption" color="text.secondary" component="p" data-testid="reserve-history-range">
                    {interpolate(s.historyRange, {
                      min: formatRatio(BigInt(Math.min(...series.map((p) => p.ratio)))),
                      max: formatRatio(BigInt(Math.max(...series.map((p) => p.ratio)))),
                      from: timeText(series[0].timestamp),
                      to: timeText(series[series.length - 1].timestamp),
                    })}
                  </Typography>
                )}
                {unknown > 0 && (
                  <Typography variant="caption" color="warning.dark" component="p">
                    {s.historyUnknownPoint}
                  </Typography>
                )}
              </>
            )}
          </>
        )}
      </Box>
    </Card>
  )
}
