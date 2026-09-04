import { MONO, LiveDot } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { formatUnits } from 'ethers'

import { t, locale, interpolate } from 'src/locales'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Grid from '@mui/material/Grid'
import Stack from '@mui/material/Stack'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import TextField from '@mui/material/TextField'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import LinearProgress from '@mui/material/LinearProgress'
import Table from '@mui/material/Table'
import TableRow from '@mui/material/TableRow'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableContainer from '@mui/material/TableContainer'

import { useContracts } from 'src/hooks/useContracts'
import { useFundingData } from 'src/hooks/useFundingData'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { ASSETS_LIST } from 'src/lib/pepefi/assetMeta'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import {
  getSessionManager,
  getSessionManagerAddress,
  isSessionManagerDeployed,
} from 'src/contracts/sessionManager'
import { CHAIN_NAMES } from 'src/contracts/addresses'
import { SIGNAL_API_URL } from 'src/lib/pepefi/signalApi'

// ── Types ─────────────────────────────────────────────────────────────────────
interface SessionRisk {
  id:          number
  user:        string
  agent:       string
  spent:       bigint
  budget:      bigint
  maxLeverage: bigint
  expiry:      bigint
  revoked:     boolean
}
interface OracleRow {
  id:     string
  symbol: string
  price8: bigint
  stale:  boolean
  rate:   bigint // funding bps
}
interface Revenue {
  // count is null when the fee router only accumulates an amount on-chain and
  // there is no event scan to count calls — `countNote` on the payload explains
  // it. Not the same as 0.
  totals: { count: number | null; feeUsd: number; traderShare: number; platformShare: number; vaultShare: number }
  // 鏈上讀的 /revenue 不一定帶 byBeneficiary（舊鏈下帳務才有）→ optional + guard。
  byBeneficiary?: Record<string, number> | null
}
// ERC-8126 agent 驗證（讀 GET /agent/:did/verification）。
interface VerificationCheck {
  type: 'ETV' | 'MCV' | 'SCV' | 'WAV' | 'WV'
  name: string
  applicable: boolean
  passed: boolean
  score: number
  details: string
}
type RiskTier = 'low' | 'moderate' | 'elevated' | 'high' | 'critical'
interface AgentVerification {
  subject: string
  overallRiskScore: number
  riskTier: RiskTier
  assessment: string
  checks: VerificationCheck[]
  verifier: string
}

/**
 * /revenue 的最小形狀檢查。只驗真的會被 render 讀到的欄位——寧可讓一個欄位缺失
 * 就退回「—」，也不要在 render 途中丟例外把整頁炸掉。
 */
function isRevenueShape(v: unknown): v is Revenue {
  if (typeof v !== 'object' || v === null) return false
  const t = (v as { totals?: unknown }).totals
  if (typeof t !== 'object' || t === null) return false
  const n = t as Record<string, unknown>
  return (
    (typeof n.count === 'number' || n.count === null) &&
    typeof n.feeUsd === 'number' &&
    typeof n.traderShare === 'number' &&
    typeof n.platformShare === 'number' &&
    typeof n.vaultShare === 'number'
  )
}

const fUsdc = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 })
const fPrice8 = (p: bigint) => '$' + (Number(p) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 })
const fDate = (ts: bigint) =>
  ts === 0n ? '—' : new Date(Number(ts) * 1000).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`

// ERC-8126 風險分數越低越安全；對應 SSL「綠鎖」式信任色。
const tierColor = (t: RiskTier): 'success' | 'warning' | 'error' | 'default' =>
  t === 'low' ? 'success' : t === 'moderate' ? 'success' : t === 'elevated' ? 'warning' : 'error'
const checkColor = (c: VerificationCheck): 'success' | 'warning' | 'error' | 'default' =>
  !c.applicable ? 'default' : c.score <= 20 ? 'success' : c.score <= 60 ? 'warning' : 'error'

// ── Component ─────────────────────────────────────────────────────────────────
export default function AgentMonitorPage() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const funding = useFundingData(contracts?.exchange ?? null)
  const deployed = isSessionManagerDeployed(wallet.chainId)

  const manager = useMemo(
    () => getSessionManager(wallet.signer ?? wallet.provider, wallet.chainId),
    [wallet.signer, wallet.provider, wallet.chainId],
  )

  const [sessions, setSessions] = useState<SessionRisk[]>([])
  const [oracle,   setOracle]   = useState<OracleRow[]>([])
  const [vault,    setVault]    = useState<{ assets: bigint; sharePrice: bigint } | null>(null)
  const [revenue,  setRevenue]  = useState<Revenue | null>(null)
  const [revUrl,   setRevUrl]   = useState(SIGNAL_API_URL)
  const [revErr,   setRevErr]   = useState<string | null>(null)
  const [err,      setErr]      = useState<string | null>(null)

  // ── ERC-8126 agent verification ────────────────────────────────────────────
  const [vDid,     setVDid]     = useState('')
  const [verif,    setVerif]    = useState<AgentVerification | null>(null)
  const [vErr,     setVErr]     = useState<string | null>(null)
  const [vLoading, setVLoading] = useState(false)

  const fetchVerification = useCallback(async (didOrAddr: string) => {
    const q = didOrAddr.trim()
    if (!q) { setVErr(t.admin.agent.verification.enterQuery); return }
    setVLoading(true)
    try {
      const res = await fetch(`${revUrl.replace(/\/$/, '')}/agent/${encodeURIComponent(q)}/verification`)
      const json = await res.json()
      if (!res.ok || !json.ok) throw new Error(json.error ?? `HTTP ${res.status}`)
      setVerif(json.verification as AgentVerification)
      setVErr(null)
    } catch (e) {
      setVerif(null)
      setVErr(e instanceof Error ? e.message : t.admin.agent.verification.fetchFailed)
    } finally {
      setVLoading(false)
    }
  }, [revUrl])

  // ── All sessions (risk view) ──────────────────────────────────────────────
  const fetchSessions = useCallback(async () => {
    if (!manager) return
    try {
      const next = Number(await manager.nextSessionId())
      const rows: SessionRisk[] = []
      for (let i = 0; i < next; i++) {
        const s = (await manager.sessions(i)) as unknown as [
          string, string, bigint, bigint, bigint, bigint, bigint, boolean,
        ]
        rows.push({ id: i, user: s[0], agent: s[1], spent: s[4], budget: s[3], maxLeverage: s[5], expiry: s[6], revoked: s[7] })
      }
      setSessions(rows)
      setErr(null)
    } catch (e) {
      setErr(prettyError(e))
    }
  }, [manager])

  // ── Oracle health ─────────────────────────────────────────────────────────
  const fetchOracle = useCallback(async () => {
    if (!contracts) return
    try {
      const rows = await Promise.all(
        ASSETS_LIST.map(async (a) => {
          const [price, _u] = (await contracts.oracle.getPrice(a.id)) as unknown as [bigint, bigint]
          let stale = false
          try { stale = (await contracts.oracle.isStale(a.id)) as boolean } catch { stale = false }
          return { id: a.id, symbol: a.symbol, price8: price, stale, rate: funding[a.id]?.rate ?? 0n }
        }),
      )
      setOracle(rows)
      // Vault solvency snapshot (best-effort; 0x0 vault → skip).
      try {
        const [assets, sharePrice] = await Promise.all([
          contracts.insuranceVault.totalAssets() as Promise<bigint>,
          contracts.insuranceVault.getSharePrice() as Promise<bigint>,
        ])
        setVault({ assets, sharePrice })
      } catch { setVault(null) }
    } catch (e) {
      setErr(prettyError(e))
    }
  }, [contracts, funding])

  // ── x402 revenue (signal-api) ─────────────────────────────────────────────
  const fetchRevenue = useCallback(async () => {
    try {
      const res = await fetch(`${revUrl.replace(/\/$/, '')}/revenue`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: unknown = await res.json()
      // 這是一個外部 HTTP 端點，不是型別安全的來源。舊版直接 setRevenue(json)，
      // 於是任何 shape 變動（404 的 HTML、舊版少了 totals、代理回錯東西）都會在
      // render 時 `revenue.totals.feeUsd.toFixed` 直接整頁 crash。
      // HeroKpiStrip.tsx 同樣打這支 API 就有 `r?.totals` 的守衛——標準統一。
      if (!isRevenueShape(json)) throw new Error('unexpected /revenue shape')
      setRevenue(json)
      setRevErr(null)
    } catch (e) {
      setRevenue(null)
      setRevErr(e instanceof Error ? e.message : t.admin.agent.verification.fetchFailed)
    }
  }, [revUrl])

  useEffect(() => { void fetchSessions() }, [fetchSessions])
  useEffect(() => { void fetchOracle() }, [fetchOracle])
  useEffect(() => { void fetchRevenue() }, [fetchRevenue])
  // 預填第一個 session 的 agent，方便一鍵驗證。
  useEffect(() => {
    if (!vDid && sessions.length > 0) setVDid(sessions[0].agent)
  }, [sessions, vDid])

  // risk helpers
  const utilPct = (s: SessionRisk) => (s.budget === 0n ? 0 : Math.min(100, (Number(s.spent) / Number(s.budget)) * 100))
  const sessionStatus = (s: SessionRisk): { label: string; color: 'success' | 'warning' | 'error' | 'default' } => {
    const status = t.admin.agent.sessions.status
    if (s.revoked) return { label: status.revoked, color: 'default' }
    if (Number(s.expiry) * 1000 < Date.now()) return { label: status.expired, color: 'warning' }
    if (utilPct(s) >= 80) return { label: status.highUse, color: 'error' }
    if (Number(s.expiry) * 1000 - Date.now() < 3600_000)
      return { label: status.expiring, color: 'warning' }
    return { label: status.active, color: 'success' }
  }

  const activeCount = sessions.filter(s => !s.revoked && Number(s.expiry) * 1000 >= Date.now()).length
  const staleCount  = oracle.filter(o => o.stale).length

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.admin.agent.connectWallet}</Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="lg" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h4" sx={{ fontWeight: 'bold' }}>{t.admin.agent.title}</Typography>
          <LiveDot />
          <Typography variant="caption" sx={{ fontFamily: MONO, color: 'primary.main', letterSpacing: 1 }}>{t.admin.agent.live}</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          {t.admin.agent.subtitle}
        </Typography>
      </Box>

      {err && <Alert severity="error">{err}</Alert>}

      {/* Risk disclosure — be honest about live solvency backstops */}
      <Alert severity="info" variant="outlined">
        <Typography variant="caption" sx={{ display: 'block' }}>
          {t.admin.agent.disclosure}
        </Typography>
      </Alert>

      {/* KPI row */}
      <Grid container spacing={2}>
        {[
          { label: t.admin.agent.kpi.chain, value: wallet.chainId ? (CHAIN_NAMES[wallet.chainId] ?? `#${wallet.chainId}`) : '—' },
          { label: t.admin.agent.kpi.activeSessions, value: deployed ? String(activeCount) : '—' },
          { label: t.admin.agent.kpi.staleFeeds, value: `${staleCount}/${oracle.length || '—'}` },
          { label: t.admin.agent.kpi.vaultAssets, value: vault ? Number(formatUnits(vault.assets, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—' },
          { label: t.admin.agent.kpi.vaultPrice, value: vault ? Number(formatUnits(vault.sharePrice, 18)).toFixed(4) : '—' },
          { label: t.admin.agent.kpi.x402Fees, value: revenue ? revenue.totals.feeUsd.toFixed(3) : '—' },
        ].map(k => (
          <Grid key={k.label} size={{ xs: 6, md: 3 }}>
            <Card sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary">{k.label}</Typography>
              <Typography variant="h5" sx={{ fontWeight: 'bold', fontFamily: MONO }}>{k.value}</Typography>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Sessions risk */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.admin.agent.sessions.title}</Typography>
          <Button variant="text" size="small" onClick={() => void fetchSessions()} sx={{ textTransform: 'none' }}>{t.admin.agent.sessions.refresh}</Button>
        </Box>
        {!deployed ? (
          <Alert severity="warning">
            {interpolate(t.admin.agent.sessions.wrongNetwork, {
              chain:
                wallet.chainId !== null
                  ? (CHAIN_NAMES[wallet.chainId] ?? `chainId ${wallet.chainId}`)
                  : t.admin.agent.sessions.notConnected,
            })}
          </Alert>
        ) : sessions.length === 0 ? (
          <Typography variant="body2" color="text.secondary">{t.admin.agent.sessions.empty}</Typography>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {[
                    t.admin.agent.sessions.column.id,
                    t.admin.agent.sessions.column.user,
                    t.admin.agent.sessions.column.agent,
                    t.admin.agent.sessions.column.budgetUse,
                    t.admin.agent.sessions.column.maxLeverage,
                    t.admin.agent.sessions.column.expiry,
                    t.admin.agent.sessions.column.status,
                  ].map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {sessions.map(s => {
                  const st = sessionStatus(s)
                  const pct = utilPct(s)
                  return (
                    <TableRow key={s.id} hover>
                      <TableCell sx={{ fontFamily: MONO }}>{s.id}</TableCell>
                      <TableCell sx={{ fontFamily: MONO }}>{short(s.user)}</TableCell>
                      <TableCell sx={{ fontFamily: MONO }}>{short(s.agent)}</TableCell>
                      <TableCell sx={{ minWidth: 160 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <LinearProgress
                            variant="determinate"
                            value={pct}
                            color={pct >= 80 ? 'error' : pct >= 50 ? 'warning' : 'success'}
                            sx={{ flex: 1, height: 6, borderRadius: 1 }}
                          />
                          <Typography variant="caption" sx={{ fontFamily: MONO, whiteSpace: 'nowrap' }}>
                            {fUsdc(s.spent)}/{fUsdc(s.budget)}
                          </Typography>
                        </Box>
                      </TableCell>
                      <TableCell sx={{ fontFamily: MONO }}>{Number(s.maxLeverage)}x</TableCell>
                      <TableCell sx={{ fontSize: '0.75rem' }}>{fDate(s.expiry)}</TableCell>
                      <TableCell><Chip size="small" label={st.label} color={st.color} variant="outlined" /></TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>

      {/* ERC-8126 agent verification — SSL「綠鎖」式信任訊號 */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.admin.agent.verification.title}</Typography>
            <Typography variant="caption" color="text.secondary">
              {t.admin.agent.verification.description}
            </Typography>
          </Box>
        </Box>
        <Stack direction="row" spacing={1}>
          <TextField
            size="small"
            fullWidth
            label={t.admin.agent.verification.inputLabel}
            value={vDid}
            onChange={e => setVDid(e.target.value)}
            placeholder={t.admin.agent.verification.inputPlaceholder}
          />
          <Button variant="outlined" disabled={vLoading} onClick={() => void fetchVerification(vDid)} sx={{ textTransform: 'none' }}>
            {vLoading ? t.admin.agent.verification.verifying : t.admin.agent.verification.verify}
          </Button>
        </Stack>
        {vErr && (
          <Alert severity="warning">
            {interpolate(t.admin.agent.verification.failed, { error: vErr })}
          </Alert>
        )}
        {verif && (
          <Stack spacing={2}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
              <Chip
                label={interpolate(t.admin.agent.verification.riskChip, {
                  score: verif.overallRiskScore,
                  tier: verif.riskTier.toUpperCase(),
                })}
                color={tierColor(verif.riskTier)}
                sx={{ fontFamily: MONO, fontWeight: 'bold' }}
              />
              <Typography variant="caption" color="text.secondary">{verif.assessment}</Typography>
            </Box>
            <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
              {verif.checks.map(c => (
                <Chip
                  key={c.type}
                  size="small"
                  variant="outlined"
                  color={checkColor(c)}
                  label={interpolate(t.admin.agent.verification.checkChip, {
                    type: c.type,
                    score: c.applicable ? c.score : t.admin.agent.verification.checkNotApplicable,
                  })}
                  title={interpolate(t.admin.agent.verification.checkTooltip, {
                    name: c.name,
                    details: c.details,
                  })}
                  sx={{ fontFamily: MONO }}
                />
              ))}
            </Stack>
            <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
              {interpolate(t.admin.agent.verification.identity, {
                subject: short(verif.subject.replace(/^did:pkh:eip155:\d+:/, '')),
                verifier: short(verif.verifier.replace(/^did:pkh:eip155:\d+:/, '')),
              })}
            </Typography>
          </Stack>
        )}
      </Card>

      <Grid container spacing={3}>
        {/* x402 revenue */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
            <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.admin.agent.revenue.title}</Typography>
            <Stack direction="row" spacing={1}>
              <TextField size="small" fullWidth label={t.admin.agent.revenue.urlLabel} value={revUrl} onChange={e => setRevUrl(e.target.value)} />
              <Button variant="outlined" onClick={() => void fetchRevenue()} sx={{ textTransform: 'none' }}>{t.admin.agent.revenue.fetch}</Button>
            </Stack>
            {revErr ? (
              <Alert severity="warning">
                {interpolate(t.admin.agent.revenue.failed, { error: revErr })}
              </Alert>
            ) : revenue ? (
              <Stack spacing={1}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2" color="text.secondary">{t.admin.agent.revenue.callsTotal}</Typography>
                  <Typography variant="body2" sx={{ fontFamily: MONO }}>{revenue.totals.count ?? '—'} / ${revenue.totals.feeUsd.toFixed(3)}</Typography>
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2" color="success.main">{t.admin.agent.revenue.traderShare}</Typography>
                  <Typography variant="body2" sx={{ fontFamily: MONO }}>${revenue.totals.traderShare.toFixed(4)}</Typography>
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2">{t.admin.agent.revenue.platformShare}</Typography>
                  <Typography variant="body2" sx={{ fontFamily: MONO }}>${revenue.totals.platformShare.toFixed(4)}</Typography>
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2">{t.admin.agent.revenue.vaultShare}</Typography>
                  <Typography variant="body2" sx={{ fontFamily: MONO }}>${revenue.totals.vaultShare.toFixed(4)}</Typography>
                </Box>
                {Object.keys(revenue.byBeneficiary ?? {}).length > 0 && (
                  <>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>{t.admin.agent.revenue.topBeneficiaries}</Typography>
                    {Object.entries(revenue.byBeneficiary ?? {}).slice(0, 5).map(([k, v]) => (
                      <Box key={k} sx={{ display: 'flex', justifyContent: 'space-between' }}>
                        <Typography variant="caption" sx={{ fontFamily: MONO }}>{k === 'protocol' ? 'protocol' : short(k)}</Typography>
                        <Typography variant="caption" sx={{ fontFamily: MONO }}>${v.toFixed(4)}</Typography>
                      </Box>
                    ))}
                  </>
                )}
              </Stack>
            ) : (
              <Typography variant="body2" color="text.secondary">{t.admin.agent.revenue.loading}</Typography>
            )}
          </Card>
        </Grid>

        {/* Oracle health */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.admin.agent.oracle.title}</Typography>
              <Button variant="text" size="small" onClick={() => void fetchOracle()} sx={{ textTransform: 'none' }}>↺</Button>
            </Box>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow sx={{ bgcolor: 'background.neutral' }}>
                    {[
                      t.admin.agent.oracle.column.asset,
                      t.admin.agent.oracle.column.price,
                      t.admin.agent.oracle.column.funding,
                      t.admin.agent.oracle.column.feed,
                    ].map(h => (
                      <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {oracle.map(o => {
                    const r = Number(o.rate)
                    return (
                      <TableRow key={o.id} hover>
                        <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold' }}>{o.symbol}</TableCell>
                        <TableCell sx={{ fontFamily: MONO }}>{o.price8 > 0n ? fPrice8(o.price8) : '—'}</TableCell>
                        <TableCell sx={{ fontFamily: MONO, color: r > 0 ? 'error.main' : r < 0 ? 'success.main' : 'text.secondary' }}>
                          {r > 0 ? '+' : ''}{r}
                        </TableCell>
                        <TableCell>
                          <Chip size="small" label={o.stale ? t.admin.agent.oracle.stale : t.admin.agent.oracle.fresh} color={o.stale ? 'warning' : 'success'} variant="outlined" />
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </Card>
        </Grid>
      </Grid>

      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
        {interpolate(t.admin.agent.sessionManager, {
          address: short(getSessionManagerAddress(wallet.chainId)),
        })}
      </Typography>
    </Container>
  )
}
