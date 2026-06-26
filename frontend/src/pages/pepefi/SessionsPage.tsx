import type { ReactNode } from 'react'
import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { parseUnits, formatUnits, Wallet, getAddress } from 'ethers'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Link from '@mui/material/Link'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Dialog from '@mui/material/Dialog'
import Snackbar from '@mui/material/Snackbar'
import TextField from '@mui/material/TextField'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import IconButton from '@mui/material/IconButton'
import Checkbox from '@mui/material/Checkbox'
import FormControlLabel from '@mui/material/FormControlLabel'
import DialogTitle from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'
import DialogActions from '@mui/material/DialogActions'
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
import {
  AUTH_DOMAIN,
  AUTH_TYPES,
  buildAuthTypedValue,
  assembleAuthorizationVC,
  type AuthorizationCaps,
  type AuthorizationVC,
} from 'src/contracts/agentAuth'

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

// 表單欄位：標籤置於框上方，避免 MUI 浮動標籤在有值時壓線/溢出。
function Labeled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box sx={{ flex: 1, minWidth: 0 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        sx={{ display: 'block', mb: 0.5, fontWeight: 600 }}
      >
        {label}
      </Typography>
      {children}
    </Box>
  )
}

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

  // Generated agent burner key — **kept only in memory**, never persisted / sent.
  const [genKey,    setGenKey]    = useState<{ address: string; privateKey: string } | null>(null)
  const [revealKey, setRevealKey] = useState(false)
  const [includeKey, setIncludeKey] = useState(false) // opt-in: embed real key in exported MCP config

  // Generate a fresh agent-only keypair in the browser and auto-fill the address.
  const generateAgentKey = () => {
    const w = Wallet.createRandom()
    setGenKey({ address: w.address, privateKey: w.privateKey })
    setRevealKey(false)
    setIncludeKey(false)
    setAgent(w.address) // 自動填入 Agent address 欄
    notify('已產生 agent 專用金鑰（只在本機瀏覽器，請立即保存）', true)
  }

  // Onboarding: issued VCs (persisted in localStorage, keyed by wallet+chain) +
  // which session's export dialog is open.
  const [vcBySession, setVcBySession] = useState<Record<number, AuthorizationVC>>({})
  const [exportFor,   setExportFor]   = useState<number | null>(null)

  // localStorage key for this wallet's issued VCs (per chain + address).
  const vcStorageKey = useCallback(
    () => (wallet.address ? `pepelab_vc_${wallet.chainId ?? 0}_${wallet.address.toLowerCase()}` : null),
    [wallet.address, wallet.chainId],
  )

  // Restore persisted VCs whenever the wallet / chain changes (survives reload).
  useEffect(() => {
    const k = vcStorageKey()
    if (!k) { setVcBySession({}); return }
    try {
      const raw = localStorage.getItem(k)
      setVcBySession(raw ? (JSON.parse(raw) as Record<number, AuthorizationVC>) : {})
    } catch {
      setVcBySession({})
    }
  }, [vcStorageKey])

  const notify = (msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }

  // ── Export helpers ──────────────────────────────────────────────────────────
  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify(`${label} copied ✓`, true)
    } catch {
      notify('複製失敗（瀏覽器剪貼簿權限）', false)
    }
  }
  const downloadJson = (filename: string, obj: unknown) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  // Whether the generated burner key belongs to a given session's agent (so the
  // export can offer to embed it). Compares checksummed addresses.
  const genKeyMatchesAgent = (agentAddr: string): boolean => {
    if (!genKey) return false
    try { return getAddress(genKey.address) === getAddress(agentAddr) } catch { return false }
  }

  // Claude Desktop / Code MCP config — auto-filled. AGENT_PRIVATE_KEY stays a
  // placeholder UNLESS the user explicitly opts to embed the key they just
  // generated on this page (includeKey + same agent). The website never embeds
  // any other private key.
  const mcpConfig = (sessionId: number, agentAddr: string) => ({
    mcpServers: {
      'pepelab-cfd': {
        command: 'npx',
        args: ['-y', 'tsx', '/path/to/pepelab_onchain_cfd/agent/mcp-server/src/index.ts'],
        env: {
          AGENT_PRIVATE_KEY:
            includeKey && genKeyMatchesAgent(agentAddr) && genKey
              ? genKey.privateKey
              : '0x...   # 貼上你剛產生/保存的 agent 私鑰（放本機，勿外流）',
          SESSION_MANAGER_ADDRESS: getSessionManagerAddress(wallet.chainId),
          BASE_SEPOLIA_RPC_URL: 'https://sepolia.base.org',
          DEMO_SESSION_ID: String(sessionId),
        },
      },
    },
  })

  // ── Issue authorization VC (user signs in MetaMask — SSI issuer role) ─────────
  const issueCredential = async (s: SessionRow) => {
    if (!wallet.signer || !wallet.address) {
      notify('需連接真實錢包以簽署 VC（mock 模式不支援簽章）', false)
      return
    }
    const key = `vc_${s.id}`
    try {
      setBusy(p => ({ ...p, [key]: true }))
      const caps: AuthorizationCaps = {
        maxMarginPerTrade: formatUnits(s.maxMarginPerTrade, 18),
        totalBudget:       formatUnits(s.totalMarginBudget, 18),
        maxLeverage:       Number(s.maxLeverage),
        expiry:            Number(s.expiry),
      }
      const issuedAt = Math.floor(Date.now() / 1000)
      // 與 agent 端 verifyAuthorizationVC 共用同一組 EIP-712 schema（agentAuth.ts）。
      const value = buildAuthTypedValue({ issuer: wallet.address, agent: s.agent, sessionId: s.id, caps, issuedAt })
      const signature = await wallet.signer.signTypedData(AUTH_DOMAIN, AUTH_TYPES, value)
      const vc = assembleAuthorizationVC({
        issuerAddress: wallet.address, agentAddress: s.agent, sessionId: s.id, caps, issuedAt, signature,
      })
      setVcBySession(p => {
        const nextMap = { ...p, [s.id]: vc }
        const k = vcStorageKey()
        if (k) { try { localStorage.setItem(k, JSON.stringify(nextMap)) } catch { /* quota — keep in memory */ } }
        return nextMap
      })
      setExportFor(s.id)
      notify('Credential issued ✓', true)
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy(p => ({ ...p, [key]: false }))
    }
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

      {/* SSI 角色說明 — 一眼看懂三角 */}
      <Alert severity="info" variant="outlined" icon={false}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
          SSI 三角：你的錢包就是信任根
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 3 }} sx={{ typography: 'caption' }}>
          <span>🖊️ <b>Issuer＝你</b>：用 MetaMask 簽發授權 VC（私鑰不離開錢包）</span>
          <span>🤖 <b>Holder＝agent</b>：持 VC + session key 代你下單</span>
          <span>✅ <b>Verifier＝MCP/合約</b>：下單前驗簽 + 鏈上 session 交叉比對</span>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          流程：連錢包 → 設限額建 session → 簽發授權 VC → 一鍵匯出 agent 設定 → 之後只下口頭交易意圖。
        </Typography>
      </Alert>

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

            {/* 觀念說明：agent 用獨立 session key，不是主錢包 */}
            <Alert severity="info" variant="outlined" icon={false} sx={{ py: 0.5 }}>
              <Typography variant="caption">
                <b>agent 用一把獨立的 session key，不是你的主錢包</b>：
                <b>地址</b> → 拿來授權下面這個 session；<b>私鑰</b> → 放進 agent 的 MCP 設定 + 一點 ETH 付 gas。
                沒有現成的就按「Generate agent key」在瀏覽器產生一把全新 burner。
              </Typography>
            </Alert>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-end' }}>
              <Labeled label="Agent address (session key)">
                <TextField
                  placeholder="0x… 或按右側 Generate agent key"
                  value={agent}
                  onChange={e => setAgent(e.target.value)}
                  size="small"
                  fullWidth
                />
              </Labeled>
              <Button
                variant="outlined"
                onClick={generateAgentKey}
                sx={{ textTransform: 'none', whiteSpace: 'nowrap', minWidth: 180 }}
                startIcon={<span>🔑</span>}
              >
                Generate agent key
              </Button>
            </Stack>

            {/* 產生的金鑰只顯示一次（記憶體，不入庫/不上傳） */}
            {genKey && (
              <Alert severity="warning" variant="outlined" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>🔑 你的 agent 專用金鑰（burner）</Typography>
                  <Button size="small" variant="text" color="inherit" onClick={() => { setGenKey(null); setRevealKey(false); setIncludeKey(false) }} sx={{ textTransform: 'none' }}>清除</Button>
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  這是一把獨立的 burner 金鑰，只受你下面設的 session 限額拘束。請存到本機 agent 設定，<b>別放主錢包資產</b>。本頁只顯示這一次，且不會上傳或寫入伺服器。
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <Chip size="small" label="地址（會上鏈授權）" color="success" variant="outlined" />
                  <Typography variant="caption" sx={{ fontFamily: MONO, wordBreak: 'break-all', flex: 1 }}>{genKey.address}</Typography>
                  <Button size="small" variant="outlined" onClick={() => void copyText('Agent address', genKey.address)} sx={{ textTransform: 'none' }}>Copy</Button>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Chip size="small" label="私鑰（只放本機）" color="error" variant="outlined" />
                  <Typography variant="caption" sx={{ fontFamily: MONO, wordBreak: 'break-all', flex: 1 }}>
                    {revealKey ? genKey.privateKey : '•'.repeat(24) + ' （已隱藏）'}
                  </Typography>
                  <Button size="small" variant="text" onClick={() => setRevealKey(v => !v)} sx={{ textTransform: 'none', minWidth: 0 }}>{revealKey ? 'Hide' : 'Reveal'}</Button>
                  <Button size="small" variant="outlined" color="error" onClick={() => void copyText('Agent private key', genKey.privateKey)} sx={{ textTransform: 'none' }}>Copy</Button>
                </Box>
              </Alert>
            )}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Labeled label="Max / trade (USDT)">
                <TextField type="number" value={perTrade} placeholder="1000"
                  onChange={e => setPerTrade(e.target.value)} size="small" fullWidth />
              </Labeled>
              <Labeled label="Total budget (USDT)">
                <TextField type="number" value={budget} placeholder="5000"
                  onChange={e => setBudget(e.target.value)} size="small" fullWidth />
              </Labeled>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Labeled label="Max leverage">
                <TextField type="number" value={maxLev} placeholder="5"
                  onChange={e => setMaxLev(e.target.value)} size="small" fullWidth
                  slotProps={{ htmlInput: { min: 1, max: 5 } }} />
              </Labeled>
              <Labeled label="Valid for (hours)">
                <TextField type="number" value={hours} placeholder="24"
                  onChange={e => setHours(e.target.value)} size="small" fullWidth />
              </Labeled>
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
                      {['#', 'Agent', 'Spent / Budget', 'Max/trade', 'Lev', 'Expiry', 'Status', 'Credential', ''].map(h => (
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
                          <TableCell>
                            {vcBySession[s.id] ? (
                              <Stack direction="row" spacing={0.5} alignItems="center">
                                <Chip size="small" label="Issued ✓" color="success" variant="outlined" />
                                <Button
                                  size="small" variant="outlined" color="primary"
                                  onClick={() => setExportFor(s.id)}
                                  sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}
                                >
                                  Export ⤓
                                </Button>
                              </Stack>
                            ) : (
                              <Button
                                size="small" variant="outlined"
                                onClick={() => void issueCredential(s)}
                                disabled={s.revoked || Number(s.expiry) * 1000 < Date.now() || !!busy[`vc_${s.id}`] || !wallet.signer}
                                sx={{ textTransform: 'none' }}
                                title={!wallet.signer ? '需真實錢包簽署（mock 模式不支援）' : 'MetaMask 簽發授權 VC'}
                              >
                                {busy[`vc_${s.id}`] ? 'Signing…' : 'Issue VC'}
                              </Button>
                            )}
                          </TableCell>
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

          {/* Export / Connect your Agent — modal dialog (centered, always reachable) */}
          <Dialog
            open={exportFor !== null && !!vcBySession[exportFor ?? -1]}
            onClose={() => setExportFor(null)}
            maxWidth="md"
            fullWidth
            scroll="paper"
          >
            {exportFor !== null && vcBySession[exportFor] && (() => {
              const sid = exportFor
              const vc = vcBySession[sid]
              const sessAgent = sessions.find(s => s.id === sid)?.agent ?? vc.credentialSubject.id.split(':').pop() ?? ''
              const canIncludeKey = genKeyMatchesAgent(sessAgent)
              const cfg = mcpConfig(sid, sessAgent)
              const cfgStr = JSON.stringify(cfg, null, 2)
              const vcStr = JSON.stringify(vc, null, 2)
              const preSx = {
                fontFamily: MONO, fontSize: 11, m: 0, p: 1.5, borderRadius: 1,
                bgcolor: 'background.neutral', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre' as const,
              }
              return (
                <>
                  <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', pr: 1 }}>
                    🔌 Connect your Agent — Session #{sid}
                    <IconButton onClick={() => setExportFor(null)} size="small" aria-label="close">✕</IconButton>
                  </DialogTitle>
                  <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <Typography variant="body2" color="text.secondary">
                      把以下兩份貼進你本機的 agent client，之後只需下「口頭交易意圖」，agent 會在 session 限額內憑 VC 代你下單：
                    </Typography>
                    <Box component="ol" sx={{ pl: 2.5, m: 0, typography: 'caption', color: 'text.secondary' }}>
                      <li>把 <b>MCP 設定</b>貼進 Claude Desktop/Code 的 <code>mcpServers</code>，並把 <code>AGENT_PRIVATE_KEY</code> 換成你本機 agent 的 session key。</li>
                      <li>把 <b>授權 VC</b> 存成檔案，agent 下單時以 <code>AGENT_AUTH_VC_PATH</code> 指向它（或 MCP <code>open_position</code> 的 <code>authVcJson</code>）。</li>
                      <li>完成後直接對 agent 說：「幫我用 3x 槓桿做多 sBTC、保證金 200」即可，無需再報帳號/位址。</li>
                    </Box>

                    {/* 地址 vs 私鑰 對應，避免混淆 */}
                    <Alert severity="info" variant="outlined" icon={false} sx={{ py: 0.5 }}>
                      <Typography variant="caption">
                        <b>地址</b>（<code>{short(sessAgent)}</code>）＝已上鏈授權的 agent，放在 session / VC 裡；
                        <b>私鑰</b>＝對應這個地址、只放本機 agent 設定的 <code>AGENT_PRIVATE_KEY</code>。兩者是同一把 key 的公開/秘密兩面。
                      </Typography>
                    </Alert>

                    {/* MCP config */}
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>MCP 設定（Claude Desktop / Code）</Typography>
                        <Button size="small" variant="outlined" onClick={() => void copyText('MCP config', cfgStr)} sx={{ textTransform: 'none' }}>Copy</Button>
                        <Button size="small" variant="outlined" onClick={() => downloadJson(`pepelab-mcp-session-${sid}.json`, cfg)} sx={{ textTransform: 'none' }}>Download .json</Button>
                      </Stack>
                      {canIncludeKey ? (
                        <FormControlLabel
                          control={<Checkbox size="small" color="error" checked={includeKey} onChange={e => setIncludeKey(e.target.checked)} />}
                          label={
                            <Typography variant="caption" color={includeKey ? 'error.main' : 'text.secondary'}>
                              把我剛產生的 agent 私鑰填進 <code>AGENT_PRIVATE_KEY</code>（含真鑰，請只在自己機器使用）
                            </Typography>
                          }
                          sx={{ mb: 0.5 }}
                        />
                      ) : (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                          <code>AGENT_PRIVATE_KEY</code> 為佔位 — 貼上你保存的 agent 私鑰即可（在本頁用「Generate agent key」產生的，可勾選自動填入）。
                        </Typography>
                      )}
                      <Box component="pre" sx={preSx}>{cfgStr}</Box>
                    </Box>

                    {/* Authorization VC */}
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>授權 VC（下單驗證用）</Typography>
                        <Button size="small" variant="outlined" onClick={() => void copyText('Authorization VC', vcStr)} sx={{ textTransform: 'none' }}>Copy</Button>
                        <Button size="small" variant="outlined" onClick={() => downloadJson(`pepelab-auth-vc-session-${sid}.json`, vc)} sx={{ textTransform: 'none' }}>Download .json</Button>
                      </Stack>
                      <Box component="pre" sx={preSx}>{vcStr}</Box>
                    </Box>

                    <Alert severity="warning" variant="outlined">
                      <Typography variant="caption">
                        agent 私鑰只放你本機的 agent 設定，<b>勿外流</b>。私鑰只存在你瀏覽器記憶體（不寫伺服器、不入庫）；
                        預設匯出的 <code>AGENT_PRIVATE_KEY</code> 為佔位字串，只有你<b>明確勾選「填入私鑰」</b>時才會含真鑰——此時請勿把這份 JSON 貼到任何他人/公開處。
                      </Typography>
                    </Alert>
                  </DialogContent>
                  <DialogActions>
                    <Button onClick={() => setExportFor(null)} sx={{ textTransform: 'none' }}>Close</Button>
                  </DialogActions>
                </>
              )
            })()}
          </Dialog>

          <Divider />
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
            AgentSessionManager: {short(getSessionManagerAddress(wallet.chainId))}
          </Typography>
        </>
      )}
    </Container>
  )
}
