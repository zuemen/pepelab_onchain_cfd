import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Grid from '@mui/material/Grid'
import Alert from '@mui/material/Alert'
import Stack from '@mui/material/Stack'
import Table from '@mui/material/Table'
import TableRow from '@mui/material/TableRow'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import AlertTitle from '@mui/material/AlertTitle'
import Typography from '@mui/material/Typography'
import TableContainer from '@mui/material/TableContainer'
import Link from '@mui/material/Link'
import Button from '@mui/material/Button'

import { t, interpolate } from 'src/locales'
import { withStable } from 'src/lib/pepefi/tokenLabel'
import { fNum, tabularNums } from 'src/lib/pepefi/format'
import { useCarbonRetirement } from 'src/hooks/useCarbonRetirement'
import { explorerTx } from 'src/lib/pepefi/explorer'
import { FEATURE_COPY_TRADING } from 'src/lib/pepefi/featureFlags'

/**
 * #105：碳權退役紀錄（ADR-022）。
 *
 * **模擬聲明是這個區塊的一部分，不是附註**：退役的是本平台自行鑄造的模擬碳權，issue #105
 * 要求這件事同時寫在合約 NatSpec、README 與畫面上。所以聲明放在標題正下方、不可收合、
 * 不可關閉，而且讀取中、讀取失敗時一樣顯示——它不依賴任何鏈上讀數。
 *
 * 這條鏈沒有退役合約（沒有設定位址，FeeRouter 的平台收款人也不是分流合約）時整個區塊回 null，
 * 不說「本網路尚未部署」（CONTEXT.md 的 The Vault 詞條）。
 *
 * #333：另外說明錢從哪裡來（比例讀自鏈上、寫死在合約裡）與受益人規則（噸數歸屬平台），兩者跟
 * 模擬聲明一樣不依賴讀取成功——讀不到比例時照樣說明機制，只是不寫數字。每筆紀錄附鏈上交易。
 */

const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-6)}`

/** bps → 百分比字串；讀不到時為「—」。 */
const pctOf = (bps: bigint | null | undefined) => (bps === null || bps === undefined ? '—' : fNum(Number(bps) / 100, { dp: 0 }))

const tonnes = (n: number | null) => (n === null ? '—' : interpolate(t.esg.retirement.tonnesUnit, { n: fNum(n, { dp: 3 }) }))
const money = (n: number | null) => (n === null ? '—' : withStable(fNum(n, { dp: 2 })))

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
        {label}
      </Typography>
      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', ...tabularNums }}>
        {value}
      </Typography>
    </Box>
  )
}

export default function CarbonRetirementCard() {
  const { unavailable, loaded, error, summary, chainId, routing, showMore } = useCarbonRetirement()

  if (unavailable) return null

  const s = summary

  return (
    <Card sx={{ p: 3 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap', rowGap: 1 }}>
        <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
          {t.esg.retirement.title}
        </Typography>
        <Chip size="small" color="warning" variant="outlined" label={t.esg.retirement.simulatedChip} />
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
        {t.esg.retirement.lead}
      </Typography>

      <Alert severity="warning" variant="outlined" sx={{ mt: 2 }} data-testid="carbon-retirement-disclaimer">
        <AlertTitle>{t.esg.retirement.disclaimerTitle}</AlertTitle>
        {t.esg.retirement.disclaimer}
      </Alert>

      <Grid container spacing={2} sx={{ mt: 1 }}>
        <Grid size={{ xs: 12, md: 6 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
            {t.esg.retirement.fundingTitle}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {interpolate(t.esg.retirement.funding, {
              platform: pctOf(routing?.platformShareBps),
              carbon: pctOf(routing?.carbonShareBps),
              total: routing
                ? fNum((Number(routing.platformShareBps) * Number(routing.carbonShareBps)) / 1e6, { dp: 0 })
                : '—',
            })}
            {FEATURE_COPY_TRADING ? ` ${t.esg.retirement.fundingCopy}` : ''}
          </Typography>
        </Grid>
        <Grid size={{ xs: 12, md: 6 }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
            {t.esg.retirement.beneficiaryTitle}
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {t.esg.retirement.beneficiary}
          </Typography>
        </Grid>
      </Grid>

      {/* 往前分頁時保留已讀到的列，不閃回「讀取中」 */}
      {!loaded && !s ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
          {t.esg.retirement.loading}
        </Typography>
      ) : error || !s ? (
        // 讀失敗不能畫成「0 公噸」——那是一個結論，而這裡沒有結論。
        <Alert severity="warning" variant="outlined" sx={{ mt: 2 }}>
          {t.esg.retirement.failed}
        </Alert>
      ) : (
        <>
          <Grid container spacing={2} sx={{ mt: 1 }}>
            <Grid size={{ xs: 6, md: 3 }}>
              <Stat label={t.esg.retirement.totalTonnes} value={tonnes(s.totalTonnes)} />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <Stat label={t.esg.retirement.totalSpent} value={money(s.totalSpent)} />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <Stat label={t.esg.retirement.budget} value={money(s.budget)} />
            </Grid>
            <Grid size={{ xs: 6, md: 3 }}>
              <Stat label={t.esg.retirement.count} value={s.count === null ? '—' : fNum(s.count, { dp: 0 })} />
            </Grid>
          </Grid>

          <Typography variant="subtitle2" sx={{ mt: 3, fontWeight: 'bold' }}>
            {t.esg.retirement.recentTitle}
          </Typography>
          {s.rows.length === 0 ? (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
              {t.esg.retirement.empty}
            </Typography>
          ) : (
            <TableContainer sx={{ mt: 1 }}>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>{t.esg.retirement.column.time}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                      {t.esg.retirement.column.tonnes}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>
                      {t.esg.retirement.column.amount}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 'bold', whiteSpace: 'nowrap' }}>{t.esg.retirement.column.tx}</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {s.rows.map((r, i) => (
                    <TableRow key={`${r.timestamp}-${i}`}>
                      <TableCell sx={{ whiteSpace: 'nowrap', ...tabularNums }}>
                        {new Date(r.timestamp * 1000).toLocaleString()}
                      </TableCell>
                      <TableCell align="right" sx={tabularNums}>
                        {tonnes(r.tonnes)}
                      </TableCell>
                      <TableCell align="right" sx={tabularNums}>
                        {money(r.amount)}
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap', ...tabularNums }}>
                        {r.txHash === null ? (
                          '—'
                        ) : explorerTx(r.txHash, chainId) ? (
                          <Link href={explorerTx(r.txHash, chainId)!} target="_blank" rel="noopener noreferrer">
                            {t.esg.retirement.viewTx} {shortHash(r.txHash)}
                          </Link>
                        ) : (
                          // 本機鏈沒有區塊瀏覽器：照樣列出雜湊，可以用 cast tx 查
                          shortHash(r.txHash)
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {s.count !== null && s.rows.length > 0 && (
            <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1.5 }}>
              <Typography variant="caption" color="text.secondary" sx={tabularNums}>
                {interpolate(t.esg.retirement.shownOf, { shown: s.rows.length, count: s.count })}
              </Typography>
              {s.rows.length < s.count && (
                <Button size="small" onClick={showMore} disabled={!loaded}>
                  {t.esg.retirement.more}
                </Button>
              )}
            </Stack>
          )}
        </>
      )}
    </Card>
  )
}
