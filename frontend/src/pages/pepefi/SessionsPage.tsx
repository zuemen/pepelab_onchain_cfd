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

  // Onboarding: issued VCs (in-memory only) + which session's export panel is open
  const [vcBySession, setVcBySession] = useState<Record<number, AuthorizationVC>>({})
  const [exportFor,   setExportFor]   = useState<number | null>(null)

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

  // Claude Desktop / Code MCP config — auto-filled; AGENT_PRIVATE_KEY stays a
  // placeholder (the website never generates or embeds a real private key).
  const mcpConfig = (sessionId: number) => ({
    mcpServers: {
      'pepelab-cfd': {
        command: 'npx',
        args: ['-y', 'tsx', '/path/to/pepelab_onchain_cfd/agent/mcp-server/src/index.ts'],
        env: {
          AGENT_PRIVATE_KEY: '0x...   # your agent session key — keep local, never share',
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
      setVcBySession(p => ({ ...p, [s.id]: vc }))
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
                                <Button size="small" variant="text" onClick={() => setExportFor(s.id)} sx={{ textTransform: 'none', minWidth: 0 }}>
                                  Export
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

          {/* Export / Connect your Agent */}
          {exportFor !== null && vcBySession[exportFor] && (() => {
            const sid = exportFor
            const vc = vcBySession[sid]
            const cfg = mcpConfig(sid)
            const cfgStr = JSON.stringify(cfg, null, 2)
            const vcStr = JSON.stringify(vc, null, 2)
            const preSx = {
              fontFamily: MONO, fontSize: 11, m: 0, p: 1.5, borderRadius: 1,
              bgcolor: 'background.neutral', maxHeight: 220, overflow: 'auto', whiteSpace: 'pre' as const,
            }
            return (
              <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="h6" sx={{ fontWeight: 'bold' }}>🔌 Connect your Agent — Session #{sid}</Typography>
                  <Button variant="text" size="small" onClick={() => setExportFor(null)} sx={{ textTransform: 'none' }}>Close</Button>
                </Box>
                <Typography variant="body2" color="text.secondary">
                  把以下兩份貼進你本機的 agent client，之後只需下「口頭交易意圖」，agent 會在 session 限額內憑 VC 代你下單：
                </Typography>
                <Box component="ol" sx={{ pl: 2.5, m: 0, typography: 'caption', color: 'text.secondary' }}>
                  <li>把 <b>MCP 設定</b>貼進 Claude Desktop/Code 的 <code>mcpServers</code>，並把 <code>AGENT_PRIVATE_KEY</code> 換成你本機 agent 的 session key。</li>
                  <li>把 <b>授權 VC</b> 存成檔案，agent 下單時以 <code>AGENT_AUTH_VC_PATH</code> 指向它（或 MCP <code>open_position</code> 的 <code>authVcJson</code>）。</li>
                  <li>完成後直接對 agent 說：「幫我用 3x 槓桿做多 sBTC、保證金 200」即可，無需再報帳號/位址。</li>
                </Box>

                {/* MCP config */}
                <Box>
                  <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>MCP 設定（Claude Desktop / Code）</Typography>
                    <Button size="small" variant="outlined" onClick={() => void copyText('MCP config', cfgStr)} sx={{ textTransform: 'none' }}>Copy</Button>
                    <Button size="small" variant="outlined" onClick={() => downloadJson(`pepelab-mcp-session-${sid}.json`, cfg)} sx={{ textTransform: 'none' }}>Download .json</Button>
                  </Stack>
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
                    agent 私鑰只放你本機的 agent 設定，<b>勿外流</b>。本網站不會產生、儲存或嵌入任何真實私鑰；
                    匯出的 <code>AGENT_PRIVATE_KEY</code> 一律為佔位字串。
                  </Typography>
                </Alert>
              </Card>
            )
          })()}

          <Divider />
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
            AgentSessionManager: {short(getSessionManagerAddress(wallet.chainId))}
          </Typography>
        </>
      )}
    </Container>
  )
}
