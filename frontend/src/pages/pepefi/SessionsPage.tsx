import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { parseUnits, formatUnits } from 'ethers'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Link from '@mui/material/Link'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Snackbar from '@mui/material/Snackbar'
import TextField from '@mui/material/TextField'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import Table from '@mui/material/Table'
import TableRow from '@mui/material/TableRow'
import TableBody from '@mui/material/TableBody'
import TableCell from '@mui/material/TableCell'
import TableHead from '@mui/material/TableHead'
import TableContainer from '@mui/material/TableContainer'

import { usePepefiWallet } from 'src/layouts/pepefi'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { explorerTx, explorerName } from 'src/lib/pepefi/notify'
import { agentDid, shortDid } from 'src/lib/pepefi/did'
import { CHAIN_NAMES } from 'src/contracts/addresses'
import {
  getSessionManager,
  getSessionManagerAddress,
  isSessionManagerDeployed,
} from 'src/contracts/sessionManager'

// ── Types ───────────────────────────────────────────────────────────────────
interface SessionRow {
  id:                number
  user:              string
  agent:             string
  maxMarginPerTrade: bigint
  totalMarginBudget: bigint
  spentMargin:       bigint
  maxLeverage:       bigint
  expiry:            bigint
  revoked:           boolean
}

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

const fUsdc = (v: bigint) => Number(formatUnits(v, 18)).toLocaleString('en-US', { maximumFractionDigits: 2 })
const fDate = (ts: bigint) =>
  ts === 0n ? '—' : new Date(Number(ts) * 1000).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short' })
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`

// ── Component ─────────────────────────────────────────────────────────────────
export default function SessionsPage() {
  const wallet = usePepefiWallet()
  const deployed = isSessionManagerDeployed(wallet.chainId)

  const manager = useMemo(
    () => getSessionManager(wallet.signer ?? wallet.provider, wallet.chainId),
    [wallet.signer, wallet.provider, wallet.chainId],
  )

  const [sessions, setSessions] = useState<SessionRow[]>([])
  const [loading,  setLoading]  = useState(false)
  const [busy,     setBusy]     = useState<Record<string, boolean>>({})
  const [toast,    setToast]    = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  // Create-session form
  const [agent,    setAgent]    = useState('')
  const [perTrade, setPerTrade] = useState('1000')
  const [budget,   setBudget]   = useState('5000')
  const [maxLev,   setMaxLev]   = useState('5')
  const [hours,    setHours]    = useState('24')

  const notify = (msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }

  // ── Fetch this wallet's sessions ──────────────────────────────────────────
  const fetchSessions = useCallback(async () => {
    if (!manager || !wallet.address) return
    setLoading(true)
    try {
      const next = Number(await manager.nextSessionId())
      const mine: SessionRow[] = []
      for (let i = 0; i < next; i++) {
        const s = (await manager.sessions(i)) as unknown as [
          string, string, bigint, bigint, bigint, bigint, bigint, boolean,
        ]
        if (s[0].toLowerCase() === wallet.address.toLowerCase()) {
          mine.push({
            id: i, user: s[0], agent: s[1],
            maxMarginPerTrade: s[2], totalMarginBudget: s[3], spentMargin: s[4],
            maxLeverage: s[5], expiry: s[6], revoked: s[7],
          })
        }
      }
      setSessions(mine)
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setLoading(false)
    }
  }, [manager, wallet.address])

  useEffect(() => { void fetchSessions() }, [fetchSessions])

  // ── Create session ────────────────────────────────────────────────────────
  const createSession = async () => {
    if (!manager) return
    try {
      const expiry = Math.floor(Date.now() / 1000) + Math.round(parseFloat(hours) * 3600)
      setBusy(p => ({ ...p, create: true }))
      const tx = asTx(await manager.createSession(
        agent.trim(),
        parseUnits(perTrade || '0', 18),
        parseUnits(budget || '0', 18),
        BigInt(maxLev || '0'),
        BigInt(expiry),
      ))
      await tx.wait()
      notify('Session created ✓', true, tx.hash)
      setAgent('')
      await fetchSessions()
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy(p => ({ ...p, create: false }))
    }
  }

  // ── Revoke session ────────────────────────────────────────────────────────
  const revokeSession = async (id: number) => {
    if (!manager) return
    const key = `revoke_${id}`
    try {
      setBusy(p => ({ ...p, [key]: true }))
      const tx = asTx(await manager.revokeSession(id))
      await tx.wait()
      notify('Session revoked ✓', true, tx.hash)
      await fetchSessions()
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy(p => ({ ...p, [key]: false }))
    }
  }

  const statusOf = (s: SessionRow): { label: string; color: 'success' | 'warning' | 'default' } => {
    if (s.revoked) return { label: 'Revoked', color: 'default' }
    if (Number(s.expiry) * 1000 < Date.now()) return { label: 'Expired', color: 'warning' }
    return { label: 'Active', color: 'success' }
  }

  // ── Guards ────────────────────────────────────────────────────────────────
  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to manage agent sessions.</Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="md" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Snackbar
        open={!!toast}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {toast ? (
          <Alert severity={toast.ok ? 'success' : 'error'} onClose={() => setToast(null)} sx={{ width: '100%' }}>
            {toast.msg}
            {toast.hash && explorerTx(toast.hash, wallet.chainId) && (
              <Link
                href={explorerTx(toast.hash, wallet.chainId)!}
                target="_blank" rel="noopener noreferrer" color="inherit"
                sx={{ display: 'block', mt: 0.5, typography: 'caption', textDecoration: 'underline' }}
              >
                View on {explorerName(wallet.chainId)} ↗
              </Link>
            )}
          </Alert>
        ) : undefined}
      </Snackbar>

      {/* Header */}
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>🤖 AI Agent Sessions</Typography>
        <Typography variant="body2" color="text.secondary">
          委派一把有界 session key 給 agent：限單筆保證金、總預算、最大槓桿與到期。
          Agent 只能在限額內經 AgentSessionManager 代你開/平倉，永不持有你的主錢包私鑰。
          每個 agent 具 <b>did:pkh</b> 身分，授權可憑證化為 <b>W3C VC</b> 供下單前驗簽
          （SSI / 可驗證自主交易，見 docs/AGENT_IDENTITY_VC_SSI.md）。
        </Typography>
      </Box>

      {!deployed ? (
        <Alert severity="warning">
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
            請切換到 Base Sepolia（chainId 84532）
          </Typography>
          AI Agent Sessions 部署在 <b>Base Sepolia</b> 測試網。你目前連到的是{' '}
          <b>{wallet.chainId !== null ? (CHAIN_NAMES[wallet.chainId] ?? `chainId ${wallet.chainId}`) : '未知網路'}</b>
          ，請在 MetaMask 切換到 Base Sepolia 後重整本頁。
        </Alert>
      ) : (
        <>
          {/* Create session */}
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 'bold' }}>Create Session</Typography>
            <TextField
              label="Agent address (session key)"
              placeholder="0x…"
              value={agent}
              onChange={e => setAgent(e.target.value)}
              size="small"
              fullWidth
            />
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField label="Max / trade (USDC)" type="number" value={perTrade}
                onChange={e => setPerTrade(e.target.value)} size="small" fullWidth />
              <TextField label="Total budget (USDC)" type="number" value={budget}
                onChange={e => setBudget(e.target.value)} size="small" fullWidth />
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <TextField label="Max leverage" type="number" value={maxLev}
                onChange={e => setMaxLev(e.target.value)} size="small" fullWidth
                slotProps={{ htmlInput: { min: 1, max: 5 } }} />
              <TextField label="Valid for (hours)" type="number" value={hours}
                onChange={e => setHours(e.target.value)} size="small" fullWidth />
            </Stack>
            <Box>
              <Button
                variant="contained"
                onClick={() => void createSession()}
                disabled={!agent.trim() || !!busy.create}
              >
                {busy.create ? 'Creating…' : 'Create Session'}
              </Button>
            </Box>
          </Card>

          {/* Session list */}
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6" sx={{ fontWeight: 'bold' }}>My Sessions</Typography>
              <Button variant="text" size="small" onClick={() => void fetchSessions()} sx={{ textTransform: 'none' }}>
                ↺ Refresh
              </Button>
            </Box>

            {loading ? (
              <Typography variant="body2" color="text.secondary">Loading…</Typography>
            ) : sessions.length === 0 ? (
              <Typography variant="body2" color="text.secondary">尚無 session。建立一個來授權 agent。</Typography>
            ) : (
              <TableContainer>
                <Table size="small">
                  <TableHead>
                    <TableRow sx={{ bgcolor: 'background.neutral' }}>
                      {['#', 'Agent', 'Spent / Budget', 'Max/trade', 'Lev', 'Expiry', 'Status', ''].map(h => (
                        <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {sessions.map(s => {
                      const st = statusOf(s)
                      const key = `revoke_${s.id}`
                      return (
                        <TableRow key={s.id} hover>
                          <TableCell sx={{ fontFamily: MONO }}>{s.id}</TableCell>
                          <TableCell sx={{ fontFamily: MONO }}>
                            {short(s.agent)}
                            <Box component="span" sx={{ display: 'block', fontSize: 10, color: 'text.disabled' }} title={agentDid(s.agent)}>
                              {shortDid(s.agent)}
                            </Box>
                          </TableCell>
                          <TableCell sx={{ fontFamily: MONO }}>{fUsdc(s.spentMargin)} / {fUsdc(s.totalMarginBudget)}</TableCell>
                          <TableCell sx={{ fontFamily: MONO }}>{fUsdc(s.maxMarginPerTrade)}</TableCell>
                          <TableCell sx={{ fontFamily: MONO }}>{Number(s.maxLeverage)}x</TableCell>
                          <TableCell sx={{ fontSize: '0.75rem' }}>{fDate(s.expiry)}</TableCell>
                          <TableCell><Chip size="small" label={st.label} color={st.color} variant="outlined" /></TableCell>
                          <TableCell align="right">
                            <Button
                              size="small" variant="outlined" color="error"
                              onClick={() => void revokeSession(s.id)}
                              disabled={s.revoked || !!busy[key]}
                              sx={{ textTransform: 'none' }}
                            >
                              {busy[key] ? '…' : 'Revoke'}
                            </Button>
                          </TableCell>
                        </TableRow>
                      )
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Card>

          <Divider />
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
            AgentSessionManager: {short(getSessionManagerAddress(wallet.chainId))}
          </Typography>
        </>
      )}
    </Container>
  )
}
