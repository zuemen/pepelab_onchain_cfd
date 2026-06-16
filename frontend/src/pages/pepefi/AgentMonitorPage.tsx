import { MONO, LiveDot } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { formatUnits } from 'ethers'

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
  totals: { count: number; feeUsd: number; traderShare: number; platformShare: number; vaultShare: number }
  // 鏈上讀的 /revenue 不一定帶 byBeneficiary（舊鏈下帳務才有）→ optional + guard。
  byBeneficiary?: Record<string, number> | null
}

const fUsdc = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 })
const fPrice8 = (p: bigint) => '$' + (Number(p) / 1e8).toLocaleString('en-US', { maximumFractionDigits: 2 })
const fDate = (ts: bigint) =>
  ts === 0n ? '—' : new Date(Number(ts) * 1000).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' })
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`

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
      setRevenue(await res.json())
      setRevErr(null)
    } catch (e) {
      setRevenue(null)
      setRevErr(e instanceof Error ? e.message : 'fetch failed')
    }
  }, [revUrl])

  useEffect(() => { void fetchSessions() }, [fetchSessions])
  useEffect(() => { void fetchOracle() }, [fetchOracle])
  useEffect(() => { void fetchRevenue() }, [fetchRevenue])

  // risk helpers
  const utilPct = (s: SessionRisk) => (s.budget === 0n ? 0 : Math.min(100, (Number(s.spent) / Number(s.budget)) * 100))
  const sessionStatus = (s: SessionRisk): { label: string; color: 'success' | 'warning' | 'error' | 'default' } => {
    if (s.revoked) return { label: 'Revoked', color: 'default' }
    if (Number(s.expiry) * 1000 < Date.now()) return { label: 'Expired', color: 'warning' }
    if (utilPct(s) >= 80) return { label: 'High use', color: 'error' }
    if (Number(s.expiry) * 1000 - Date.now() < 3600_000) return { label: 'Expiring', color: 'warning' }
    return { label: 'Active', color: 'success' }
  }

  const activeCount = sessions.filter(s => !s.revoked && Number(s.expiry) * 1000 >= Date.now()).length
  const staleCount  = oracle.filter(o => o.stale).length

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to view the agent monitor.</Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="lg" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h4" sx={{ fontWeight: 'bold' }}>📊 Agent Risk Monitor</Typography>
          <LiveDot />
          <Typography variant="caption" sx={{ fontFamily: MONO, color: 'primary.main', letterSpacing: 1 }}>LIVE</Typography>
        </Stack>
        <Typography variant="body2" color="text.secondary">
          監控 AI agent 經濟：委派 session 的限額使用、x402 收入分潤、預言機健康度。唯讀。
        </Typography>
      </Box>

      {err && <Alert severity="error">{err}</Alert>}

      {/* Risk disclosure — be honest about live solvency backstops */}
      <Alert severity="info" variant="outlined">
        <Typography variant="caption" sx={{ display: 'block' }}>
          <b>償付後盾揭露</b>：ADL（自動減倉）與組合保證金<b>已實作、由旗標控管</b>，本測試網部署
          目前<b>預設關閉</b>（線上跑逐倉清算 + 保險金庫 bailout）。極端行情下，在 ADL 啟用前協議
          作為對手方仍有償付風險——本頁數據不代表線上償付無虞。詳見 docs/RISK_NOTES.md。
        </Typography>
      </Alert>

      {/* KPI row */}
      <Grid container spacing={2}>
        {[
          { label: 'Chain', value: wallet.chainId ? (CHAIN_NAMES[wallet.chainId] ?? `#${wallet.chainId}`) : '—' },
          { label: 'Active sessions', value: deployed ? String(activeCount) : '—' },
          { label: 'Stale feeds', value: `${staleCount}/${oracle.length || '—'}` },
          { label: 'Vault assets (USDC)', value: vault ? Number(formatUnits(vault.assets, 18)).toLocaleString(undefined, { maximumFractionDigits: 0 }) : '—' },
          { label: 'Vault px (USDC/pIV)', value: vault ? Number(formatUnits(vault.sharePrice, 18)).toFixed(4) : '—' },
          { label: 'x402 fees (USD)', value: revenue ? revenue.totals.feeUsd.toFixed(3) : '—' },
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
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>Delegated Sessions</Typography>
          <Button variant="text" size="small" onClick={() => void fetchSessions()} sx={{ textTransform: 'none' }}>↺ Refresh</Button>
        </Box>
        {!deployed ? (
          <Alert severity="warning">
            請切換到 <b>Base Sepolia</b>（chainId 84532）以檢視 agent sessions。目前網路：
            <b>{wallet.chainId !== null ? (CHAIN_NAMES[wallet.chainId] ?? `chainId ${wallet.chainId}`) : '未連線'}</b>。
          </Alert>
        ) : sessions.length === 0 ? (
          <Typography variant="body2" color="text.secondary">尚無 session。</Typography>
        ) : (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow sx={{ bgcolor: 'background.neutral' }}>
                  {['#', 'User', 'Agent', 'Budget use', 'Max lev', 'Expiry', 'Status'].map(h => (
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

      <Grid container spacing={3}>
        {/* x402 revenue */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
            <Typography variant="h6" sx={{ fontWeight: 'bold' }}>x402 Revenue (70/20/10)</Typography>
            <Stack direction="row" spacing={1}>
              <TextField size="small" fullWidth label="signal-api URL" value={revUrl} onChange={e => setRevUrl(e.target.value)} />
              <Button variant="outlined" onClick={() => void fetchRevenue()} sx={{ textTransform: 'none' }}>Fetch</Button>
            </Stack>
            {revErr ? (
              <Alert severity="warning">無法連到 signal-api（{revErr}）。請先 <code>npm run signal-api</code>。</Alert>
            ) : revenue ? (
              <Stack spacing={1}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2" color="text.secondary">Calls / Total</Typography>
                  <Typography variant="body2" sx={{ fontFamily: MONO }}>{revenue.totals.count} / ${revenue.totals.feeUsd.toFixed(3)}</Typography>
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2" color="success.main">Trader 70%</Typography>
                  <Typography variant="body2" sx={{ fontFamily: MONO }}>${revenue.totals.traderShare.toFixed(4)}</Typography>
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2">Platform 20%</Typography>
                  <Typography variant="body2" sx={{ fontFamily: MONO }}>${revenue.totals.platformShare.toFixed(4)}</Typography>
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                  <Typography variant="body2">Vault 10%</Typography>
                  <Typography variant="body2" sx={{ fontFamily: MONO }}>${revenue.totals.vaultShare.toFixed(4)}</Typography>
                </Box>
                {Object.keys(revenue.byBeneficiary ?? {}).length > 0 && (
                  <>
                    <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>Top beneficiaries (70% share)</Typography>
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
              <Typography variant="body2" color="text.secondary">Loading…</Typography>
            )}
          </Card>
        </Grid>

        {/* Oracle health */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6" sx={{ fontWeight: 'bold' }}>Oracle Health</Typography>
              <Button variant="text" size="small" onClick={() => void fetchOracle()} sx={{ textTransform: 'none' }}>↺</Button>
            </Box>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow sx={{ bgcolor: 'background.neutral' }}>
                    {['Asset', 'Price', 'Funding', 'Feed'].map(h => (
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
                          <Chip size="small" label={o.stale ? 'Stale' : 'Fresh'} color={o.stale ? 'warning' : 'success'} variant="outlined" />
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
        AgentSessionManager: {short(getSessionManagerAddress(wallet.chainId))}
      </Typography>
    </Container>
  )
}
