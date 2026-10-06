import type { ReactNode } from 'react'
import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { parseUnits, formatUnits, Wallet, getAddress } from 'ethers'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Dialog from '@mui/material/Dialog'
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
import { t, locale, interpolate } from 'src/locales'
import { assetPolicy } from 'src/tenant'
import { sessionAssetsForTenant } from 'src/tenant/assetPolicy'
import { PERPETUALS_AUTHORIZED } from 'src/lib/pepefi/featureFlags'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { agentDid, shortDid } from 'src/lib/pepefi/did'
import { useToast } from 'src/components/pepefi/ToastProvider'
import { SwitchChainButton } from 'src/components/pepefi/SwitchChainButton'
import { afterRevocation, DelegationCredentialPanel, revokeDelegationCredential } from 'src/components/pepefi/DelegationCredentialPanel'
import { delegationStorageKey, type StoredDelegation } from 'src/lib/pepefi/delegationCredential'
import { ASSET_IDS, CHAIN_NAMES } from 'src/contracts/addresses'
import { ASSETS_LIST } from 'src/lib/pepefi/assetMeta'
import { BASE_SEPOLIA_RPC_URL } from 'src/lib/pepefi/chains'
import { mapLimit, withRetry, RPC_CONCURRENCY } from 'src/lib/pepefi/rpcBatch'
import {
  getSessionManager,
  getSessionManagerAddress,
  isSessionManagerDeployed,
} from 'src/contracts/sessionManager'
import {
  authDomainV2,
  AUTH_TYPES_V2,
  newAuthNonce,
  defaultValidUntil,
  DEFAULT_VC_VALIDITY_DAYS,
  buildAuthTypedValueV2,
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
  ts === 0n ? '—' : new Date(Number(ts) * 1000).toLocaleString(locale, { dateStyle: 'short', timeStyle: 'short' })
const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`
/** VC 實際到期時間（v2 取 validUntil，舊格式 v1 取 session expiry）。 */
const vcExpiry = (vc: AuthorizationVC) =>
  Number(vc.credentialSubject.validUntil ?? vc.credentialSubject.authorization.expiry)

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
/** 撤銷欄釘在表格右緣：表格比容器寬時橫向捲動，撤銷鈕仍固定可見。 */
const STICKY_ACTION_CELL = {
  position: 'sticky',
  right: 0,
  zIndex: 1,
  boxShadow: '-8px 0 8px -8px rgba(0,0,0,0.4)',
} as const

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
  const { notify } = useToast()

  // Create-session form
  const [agent,    setAgent]    = useState('')
  const [perTrade, setPerTrade] = useState('1000')
  const [budget,   setBudget]   = useState('5000')
  const [maxLev,   setMaxLev]   = useState('5')
  const [hours,    setHours]    = useState('24')
  // agent 可交易的標的白名單（createSessionWithAssets）。預設 sBTC、sETH。
  // 合約把空陣列解讀成「全部允許」，所以 UI 要求至少選一檔——不讓一個沒勾任何
  // 東西的表單默默變成無限制的 session。
  //
  // 白標租戶：可勾選的只有租戶白名單內的資產；預設的 sBTC、sETH 若不在白名單，
  // 就退成白名單第一檔（default 租戶 = 全部資產，預設值與改版前相同）。
  const [allowedAssets, setAllowedAssets] = useState<string[]>(() =>
    sessionAssetsForTenant(assetPolicy, [ASSET_IDS.sBTC, ASSET_IDS.sETH])
  )
  const toggleAsset = (id: string) =>
    setAllowedAssets(prev => (prev.includes(id) ? prev.filter(a => a !== id) : [...prev, id]))

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
    notify(t.sessions.key.generated, true)
  }

  // Onboarding: issued VCs (persisted in localStorage, keyed by wallet+chain) +
  // which session's export dialog is open.
  const [vcBySession, setVcBySession] = useState<Record<number, AuthorizationVC>>({})
  // 新簽發 VC 的效期（天）；預設 30 天，簽發時再以 session 到期為上限。
  const [vcValidityDays, setVcValidityDays] = useState<string>(String(DEFAULT_VC_VALIDITY_DAYS))
  const [exportFor,   setExportFor]   = useState<number | null>(null)
  // 每次開啟／關閉匯出視窗都回到「不嵌入私鑰」——勾選只對當下這一次匯出有效。
  useEffect(() => { setIncludeKey(false) }, [exportFor])

  // localStorage key for this wallet's issued VCs (per chain + address).
  const vcStorageKey = useCallback(
    () => (wallet.address ? `pepelab_vc_${wallet.chainId ?? 0}_${wallet.address.toLowerCase()}` : null),
    [wallet.address, wallet.chainId],
  )

  // v3 delegation credentials (docs/SSI_AGENT_DELEGATION.md): persisted per chain + manager + wallet,
  // and which session's v3 dialog is open (also opened right after a session is created).
  const [delegations, setDelegations] = useState<Record<number, StoredDelegation>>({})
  const [delegationFor, setDelegationFor] = useState<number | null>(null)
  const delegationKey = delegationStorageKey(wallet.chainId, getSessionManagerAddress(wallet.chainId), wallet.address)
  useEffect(() => {
    if (!delegationKey) { setDelegations({}); return }
    try {
      const raw = localStorage.getItem(delegationKey)
      setDelegations(raw ? (JSON.parse(raw) as Record<number, StoredDelegation>) : {})
    } catch {
      setDelegations({})
    }
  }, [delegationKey])
  const storeDelegation = (id: number, next: StoredDelegation) =>
    setDelegations(p => {
      const map = { ...p, [id]: next }
      if (delegationKey) { try { localStorage.setItem(delegationKey, JSON.stringify(map)) } catch { /* quota — keep in memory */ } }
      return map
    })

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


  // ── Export helpers ──────────────────────────────────────────────────────────
  const copyText = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      notify(interpolate(t.sessions.copied, { label }), true)
    } catch {
      notify(t.sessions.copyFailed, false)
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
              : t.sessions.export.privateKeyPlaceholder,
          SESSION_MANAGER_ADDRESS: getSessionManagerAddress(wallet.chainId),
          BASE_SEPOLIA_RPC_URL,
          DEMO_SESSION_ID: String(sessionId),
        },
      },
    },
  })

  // ── Issue authorization VC (user signs in MetaMask — SSI issuer role) ─────────
  const issueCredential = async (s: SessionRow) => {
    if (!wallet.signer || !wallet.address) {
      notify(t.sessions.list.needsRealWallet, false)
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
      // v2：domain 綁 session manager 位址（verifyingContract），並簽入 validUntil 與 nonce。
      const verifyingContract = getSessionManagerAddress(wallet.chainId)
      const validUntil = defaultValidUntil(issuedAt, caps.expiry, Number(vcValidityDays) * 86400)
      const nonce = newAuthNonce()
      const value = buildAuthTypedValueV2({
        issuer: wallet.address, agent: s.agent, sessionId: s.id, caps, issuedAt, validUntil, nonce,
      })
      const signature = await wallet.signer.signTypedData(authDomainV2(verifyingContract), AUTH_TYPES_V2, value)
      const vc = assembleAuthorizationVC({
        issuerAddress: wallet.address, agentAddress: s.agent, sessionId: s.id, caps, issuedAt, signature,
        v2: { validUntil, nonce, verifyingContract },
      })
      setVcBySession(p => {
        const nextMap = { ...p, [s.id]: vc }
        const k = vcStorageKey()
        if (k) { try { localStorage.setItem(k, JSON.stringify(nextMap)) } catch { /* quota — keep in memory */ } }
        return nextMap
      })
      setExportFor(s.id)
      notify(t.sessions.list.credentialIssued, true)
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
      const me = wallet.address.toLowerCase()
      // 原本逐一 await（N 個 session = N 次來回），session 一多整頁就卡在 loading。
      // 改成有上限的並行（RPC_CONCURRENCY，公共 RPC 同時太多會丟請求）＋暫時性失敗重試。
      const ids = Array.from({ length: next }, (_, i) => i)
      const rows = await mapLimit(ids, RPC_CONCURRENCY, async (i): Promise<SessionRow | null> => {
        const s = (await withRetry(() => manager.sessions(i))) as unknown as [
          string, string, bigint, bigint, bigint, bigint, bigint, boolean,
        ]
        if (s[0].toLowerCase() !== me) return null
        return {
          id: i, user: s[0], agent: s[1],
          maxMarginPerTrade: s[2], totalMarginBudget: s[3], spentMargin: s[4],
          maxLeverage: s[5], expiry: s[6], revoked: s[7],
        }
      })
      setSessions(rows.filter((r): r is SessionRow => r !== null))
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
    // agent session 是委任 agent 新開永續部位；租戶未授權永續就不建立。撤銷既有 session
    // 不經過這裡，照常可用。
    if (!PERPETUALS_AUTHORIZED) { notify(t.common.tenant.perpetualsNotAuthorized, false); return }
    // 送出前再濾一次白名單。合約把空陣列當成「全部允許」，所以濾完是空的就**不送**，
    // 絕不讓白名單過濾把一個受限 session 變成無限制的 session。
    const tenantAssets = allowedAssets.filter(a => assetPolicy.canOpen(a))
    if (tenantAssets.length === 0) { notify(t.sessions.create.noAssetSelected, false); return }
    try {
      const expiry = Math.floor(Date.now() / 1000) + Math.round(parseFloat(hours) * 3600)
      setBusy(p => ({ ...p, create: true }))
      const tx = asTx(await manager.createSessionWithAssets(
        agent.trim(),
        parseUnits(perTrade || '0', 18),
        parseUnits(budget || '0', 18),
        BigInt(maxLev || '0'),
        BigInt(expiry),
        tenantAssets,
      ))
      const receipt = (await tx.wait()) as { logs?: { topics: string[]; data: string }[] } | null
      notify(t.sessions.create.done, true, tx.hash)
      setAgent('')
      await fetchSessions()
      // Next step of the SSI flow: issue + anchor the v3 delegation credential for the new session.
      for (const log of receipt?.logs ?? []) {
        try {
          const ev = manager.interface.parseLog(log)
          if (ev?.name === 'SessionCreated') { setDelegationFor(Number(ev.args[0])); break }
        } catch { /* not ours */ }
      }
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
      notify(t.sessions.list.revoked, true, tx.hash)
      await fetchSessions()
      // Revoking the session also revokes its v3 credential in the ADR-016 status list
      // (the chain already makes isAnchored false; the list covers verifiers that cache).
      const d = delegations[id]
      if (d && !d.revoked && wallet.signer && wallet.address && window.confirm(t.sessions.delegation.revokeWithSession)) {
        const r = await revokeDelegationCredential({
          signer: wallet.signer, user: wallet.address,
          sessionManager: getSessionManagerAddress(wallet.chainId), credential: d.credential,
        })
        storeDelegation(id, afterRevocation(d, r))
        notify(
          interpolate(r.published ? t.sessions.delegation.revokedPublished : t.sessions.delegation.revokedDownloaded, { seq: String(r.list.sequence) }),
          true,
        )
      }
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy(p => ({ ...p, [key]: false }))
    }
  }

  const statusOf = (s: SessionRow): { label: string; color: 'success' | 'warning' | 'default' } => {
    if (s.revoked) return { label: t.sessions.list.status.revoked, color: 'default' }
    if (Number(s.expiry) * 1000 < Date.now())
      return { label: t.sessions.list.status.expired, color: 'warning' }
    return { label: t.sessions.list.status.active, color: 'success' }
  }

  // ── Guards ────────────────────────────────────────────────────────────────
  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.common.wallet.connectPrompt.sessions}</Typography>
      </Box>
    )
  }

  return (
    // lg 而不是 md：「我的 Session」表有九欄，md（900px）在 1440 寬會把撤銷鈕擠出表格、
    // 表頭擠成直排。建立表單沿用同一個寬度，欄位只是變長，不影響閱讀。
    <Container maxWidth="lg" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* Header */}
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>{t.sessions.title}</Typography>
        <Typography variant="body2" color="text.secondary">
          {t.sessions.markup.introBefore}<b>did:pkh</b>{t.sessions.markup.introMid}<b>W3C VC</b>{t.sessions.markup.introAfter}
        </Typography>
      </Box>

      {/* SSI 角色說明 — 一眼看懂三角 */}
      <Alert severity="info" variant="outlined" icon={false}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
          {t.sessions.ssi.title}
        </Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={{ xs: 0.5, sm: 3 }} sx={{ typography: 'caption' }}>
          <span>{t.sessions.markup.roleIssuerBefore}<b>{t.sessions.markup.roleIssuerBold}</b>{t.sessions.markup.roleIssuerAfter}</span>
          <span>{t.sessions.markup.roleHolderBefore}<b>{t.sessions.markup.roleHolderBold}</b>{t.sessions.markup.roleHolderAfter}</span>
          <span>{t.sessions.markup.roleVerifierBefore}<b>{t.sessions.markup.roleVerifierBold}</b>{t.sessions.markup.roleVerifierAfter}</span>
        </Stack>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
          {t.sessions.ssi.flow}
        </Typography>
      </Alert>

      {!deployed ? (
        <Alert severity="warning">
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
            {t.sessions.wrongNetwork.title}
          </Typography>
          {t.sessions.markup.wrongNetBefore}<b>Base Sepolia</b>{t.sessions.markup.wrongNetMid}{' '}
          <b>{wallet.chainId !== null ? (CHAIN_NAMES[wallet.chainId] ?? `chainId ${wallet.chainId}`) : t.sessions.wrongNetwork.unknownChain}</b>
          {t.sessions.markup.wrongNetAfter}
          <Box sx={{ mt: 1 }}>
            <SwitchChainButton />
          </Box>
        </Alert>
      ) : (
        <>
          {/* Create session */}
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.sessions.create.title}</Typography>

            {/* 觀念說明：agent 用獨立 session key，不是主錢包 */}
            <Alert severity="info" variant="outlined" icon={false} sx={{ py: 0.5 }}>
              <Typography variant="caption">
                <b>{t.sessions.markup.keyNoteBold1}</b>{t.sessions.markup.keyNoteMid1}
                <b>{t.sessions.markup.keyNoteBold2}</b>{t.sessions.markup.keyNoteMid2}<b>{t.sessions.markup.keyNoteBold3}</b>{t.sessions.markup.keyNoteAfter}
              </Typography>
            </Alert>

            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'flex-end' }}>
              <Labeled label={t.sessions.create.agentAddress}>
                <TextField
                  placeholder={t.sessions.create.agentPlaceholder}
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
                {t.sessions.create.generateKey}
              </Button>
            </Stack>

            {/* 產生的金鑰只顯示一次（記憶體，不入庫/不上傳） */}
            {genKey && (
              <Alert severity="warning" variant="outlined" sx={{ '& .MuiAlert-message': { width: '100%' } }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{t.sessions.key.title}</Typography>
                  <Button size="small" variant="text" color="inherit" onClick={() => { setGenKey(null); setRevealKey(false); setIncludeKey(false) }} sx={{ textTransform: 'none' }}>{t.sessions.key.clear}</Button>
                </Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  {t.sessions.markup.burnerWarnBefore}<b>{t.sessions.markup.burnerWarnBold}</b>{t.sessions.markup.burnerWarnAfter}
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                  <Chip size="small" label={t.sessions.key.addressChip} color="success" variant="outlined" />
                  <Typography variant="caption" sx={{ fontFamily: MONO, wordBreak: 'break-all', flex: 1 }}>{genKey.address}</Typography>
                  <Button size="small" variant="outlined" onClick={() => void copyText(t.sessions.key.copyAddressLabel, genKey.address)} sx={{ textTransform: 'none' }}>{t.sessions.key.copy}</Button>
                </Box>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <Chip size="small" label={t.sessions.key.privateKeyChip} color="error" variant="outlined" />
                  <Typography variant="caption" sx={{ fontFamily: MONO, wordBreak: 'break-all', flex: 1 }}>
                    {revealKey ? genKey.privateKey : '•'.repeat(24) + t.sessions.key.hiddenSuffix}
                  </Typography>
                  <Button size="small" variant="text" onClick={() => setRevealKey(v => !v)} sx={{ textTransform: 'none', minWidth: 0 }}>{revealKey ? t.sessions.key.hide : t.sessions.key.reveal}</Button>
                  <Button size="small" variant="outlined" color="error" onClick={() => void copyText(t.sessions.key.copyPrivateKeyLabel, genKey.privateKey)} sx={{ textTransform: 'none' }}>{t.sessions.key.copy}</Button>
                </Box>
              </Alert>
            )}
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Labeled label={t.sessions.create.maxPerTrade}>
                <TextField type="number" value={perTrade} placeholder="1000"
                  onChange={e => setPerTrade(e.target.value)} size="small" fullWidth />
              </Labeled>
              <Labeled label={t.sessions.create.totalBudget}>
                <TextField type="number" value={budget} placeholder="5000"
                  onChange={e => setBudget(e.target.value)} size="small" fullWidth />
              </Labeled>
            </Stack>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
              <Labeled label={t.sessions.create.maxLeverage}>
                <TextField type="number" value={maxLev} placeholder="5"
                  onChange={e => setMaxLev(e.target.value)} size="small" fullWidth
                  slotProps={{ htmlInput: { min: 1, max: 5 } }} />
              </Labeled>
              <Labeled label={t.sessions.create.validFor}>
                <TextField type="number" value={hours} placeholder="24"
                  onChange={e => setHours(e.target.value)} size="small" fullWidth />
              </Labeled>
            </Stack>
            <Box>
              <Typography variant="body2" sx={{ fontWeight: 600, mb: 0.5 }}>{t.sessions.create.allowedAssets}</Typography>
              <Stack direction="row" flexWrap="wrap" useFlexGap gap={0.75} role="group" aria-label={t.sessions.create.allowedAssets}>
                {assetPolicy.selectable(ASSETS_LIST).map(a => {
                  const on = allowedAssets.includes(a.id)
                  return (
                    <Chip
                      key={a.id}
                      label={a.symbol}
                      size="small"
                      clickable
                      color={on ? 'primary' : 'default'}
                      variant={on ? 'filled' : 'outlined'}
                      aria-pressed={on}
                      onClick={() => toggleAsset(a.id)}
                    />
                  )
                })}
              </Stack>
              <Typography variant="caption" color={allowedAssets.length === 0 ? 'error.main' : 'text.secondary'} sx={{ display: 'block', mt: 0.5 }}>
                {allowedAssets.length === 0 ? t.sessions.create.noAssetSelected : t.sessions.create.allowedAssetsHint}
              </Typography>
            </Box>
            <Box>
              {!PERPETUALS_AUTHORIZED && (
                <Typography variant="caption" color="warning.main" sx={{ display: 'block', mb: 1 }}>
                  {t.common.tenant.perpetualsNotAuthorized}
                </Typography>
              )}
              <Button
                variant="contained"
                onClick={() => void createSession()}
                disabled={!agent.trim() || !!busy.create || allowedAssets.length === 0 || !PERPETUALS_AUTHORIZED}
              >
                {busy.create ? t.sessions.create.creating : t.sessions.create.cta}
              </Button>
            </Box>
          </Card>

          {/* Session list */}
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="h6" sx={{ fontWeight: 'bold' }}>{t.sessions.list.title}</Typography>
              <Stack direction="row" spacing={1} alignItems="center">
                <TextField
                  size="small"
                  type="number"
                  label={t.sessions.list.vcValidity}
                  value={vcValidityDays}
                  onChange={e => setVcValidityDays(e.target.value)}
                  inputProps={{ min: 1, step: 1 }}
                  sx={{ width: 150 }}
                  title={interpolate(t.sessions.list.vcValidityHint, { days: String(DEFAULT_VC_VALIDITY_DAYS) })}
                />
                <Button variant="text" size="small" onClick={() => void fetchSessions()} sx={{ textTransform: 'none' }}>
                  {t.sessions.list.refresh}
                </Button>
              </Stack>
            </Box>

            {loading ? (
              <Typography variant="body2" color="text.secondary">{t.sessions.list.loading}</Typography>
            ) : sessions.length === 0 ? (
              <Typography variant="body2" color="text.secondary">{t.sessions.list.empty}</Typography>
            ) : (
              // 窄螢幕（含 1280 寬收起側欄前）放不下九欄時改橫向捲動；最右的撤銷欄
              // sticky 釘在右緣，捲到哪裡都看得到、點得到。表頭與數字一律不換行。
              <TableContainer sx={{ overflowX: 'auto' }}>
                <Table
                  size="small"
                  sx={{
                    '& th, & td': { px: 1, whiteSpace: 'nowrap' },
                    '& th:first-of-type, & td:first-of-type': { pl: 2 },
                  }}
                >
                  <TableHead>
                    <TableRow sx={{ bgcolor: 'background.neutral' }}>
                      {[
                        t.sessions.list.column.id,
                        t.sessions.list.column.agent,
                        t.sessions.list.column.spent,
                        t.sessions.list.column.maxPerTrade,
                        t.sessions.list.column.leverage,
                        t.sessions.list.column.expiry,
                        t.sessions.list.column.status,
                        t.sessions.list.column.credential,
                        '',
                      ].map((h, i, all) => (
                        <TableCell
                          key={h}
                          sx={{
                            color: 'text.secondary',
                            fontWeight: 'bold',
                            ...(i === all.length - 1 && { ...STICKY_ACTION_CELL, bgcolor: 'background.neutral' }),
                          }}
                        >
                          {h}
                        </TableCell>
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
                            <Box component="span" sx={{ display: 'block', fontSize: 10, color: 'text.disabled', maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={agentDid(s.agent)}>
                              {shortDid(s.agent)}
                            </Box>
                          </TableCell>
                          <TableCell sx={{ fontFamily: MONO }}>{fUsdc(s.spentMargin)} / {fUsdc(s.totalMarginBudget)}</TableCell>
                          <TableCell sx={{ fontFamily: MONO }}>{fUsdc(s.maxMarginPerTrade)}</TableCell>
                          <TableCell sx={{ fontFamily: MONO }}>{Number(s.maxLeverage)}x</TableCell>
                          <TableCell sx={{ fontSize: '0.75rem', '&&': { whiteSpace: 'normal' }, minWidth: 88 }}>{fDate(s.expiry)}</TableCell>
                          <TableCell><Chip size="small" label={st.label} color={st.color} variant="outlined" /></TableCell>
                          <TableCell>
                            {vcBySession[s.id] && vcExpiry(vcBySession[s.id]) * 1000 > Date.now() ? (
                              <Stack spacing={0.25}>
                                <Stack direction="row" spacing={0.5} alignItems="center">
                                  <Chip size="small" label={t.sessions.list.issued} color="success" variant="outlined" />
                                  <Button
                                    size="small" variant="outlined" color="primary"
                                    onClick={() => setExportFor(s.id)}
                                    sx={{ textTransform: 'none', whiteSpace: 'nowrap' }}
                                  >
                                    {t.sessions.list.export}
                                  </Button>
                                </Stack>
                                <Typography variant="caption" color="text.secondary">
                                  {interpolate(t.sessions.list.vcExpires, { date: fDate(BigInt(vcExpiry(vcBySession[s.id]))) })}
                                </Typography>
                              </Stack>
                            ) : (
                              <Stack spacing={0.25} alignItems="flex-start">
                              {vcBySession[s.id] && (
                                <Chip size="small" label={t.sessions.list.vcExpired} color="warning" variant="outlined" />
                              )}
                              <Button
                                size="small" variant="outlined"
                                onClick={() => void issueCredential(s)}
                                disabled={s.revoked || Number(s.expiry) * 1000 < Date.now() || !!busy[`vc_${s.id}`] || !wallet.signer}
                                sx={{ textTransform: 'none' }}
                                title={!wallet.signer ? t.sessions.list.issueVcNeedsWallet : t.sessions.list.issueVcHint}
                              >
                                {busy[`vc_${s.id}`] ? t.sessions.list.signing : t.sessions.list.issueVc}
                              </Button>
                              </Stack>
                            )}
                          </TableCell>
                          <TableCell align="right" sx={{ ...STICKY_ACTION_CELL, bgcolor: 'background.paper' }}>
                            <Button
                              size="small" variant="outlined"
                              onClick={() => setDelegationFor(s.id)}
                              sx={{ textTransform: 'none', mr: 1, whiteSpace: 'nowrap' }}
                            >
                              {t.sessions.delegation.open}
                            </Button>
                            <Button
                              size="small" variant="outlined" color="error"
                              onClick={() => void revokeSession(s.id)}
                              disabled={s.revoked || !!busy[key]}
                              sx={{ textTransform: 'none' }}
                            >
                              {busy[key] ? t.sessions.working : t.sessions.list.revoke}
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

          {/* v3 delegation credential — issue, anchor, status, x402 spend, revoke */}
          <Dialog open={delegationFor !== null} onClose={() => setDelegationFor(null)} maxWidth="md" fullWidth scroll="paper">
            <DialogTitle>{t.sessions.delegation.title}</DialogTitle>
            <DialogContent dividers>
              {(() => {
                const s = sessions.find(x => x.id === delegationFor)
                if (!s || !wallet.address || wallet.chainId === null) return null
                return (
                  <DelegationCredentialPanel
                    session={s}
                    chainId={wallet.chainId}
                    signer={wallet.signer}
                    userAddress={wallet.address}
                    sessionManager={getSessionManagerAddress(wallet.chainId)}
                    stored={delegations[s.id]}
                    onStored={next => storeDelegation(s.id, next)}
                  />
                )
              })()}
            </DialogContent>
            <DialogActions>
              <Button onClick={() => setDelegationFor(null)}>{t.sessions.delegation.close}</Button>
            </DialogActions>
          </Dialog>

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
                    {interpolate(t.sessions.export.title, { id: sid })}
                    <IconButton onClick={() => setExportFor(null)} size="small" aria-label={t.sessions.export.closeAria}>✕</IconButton>
                  </DialogTitle>
                  <DialogContent dividers sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <Typography variant="body2" color="text.secondary">
                      {t.sessions.export.intro}
                    </Typography>
                    <Box component="ol" sx={{ pl: 2.5, m: 0, typography: 'caption', color: 'text.secondary' }}>
                      <li>{t.sessions.markup.step1Before}<b>{t.sessions.markup.step1Bold}</b>{t.sessions.markup.step1Mid1}<code>mcpServers</code>{t.sessions.markup.step1Mid2}<code>AGENT_PRIVATE_KEY</code>{t.sessions.markup.step1After}</li>
                      <li>{t.sessions.markup.step2Before}<b>{t.sessions.markup.step2Bold}</b>{t.sessions.markup.step2Mid1}<code>AGENT_AUTH_VC_PATH</code>{t.sessions.markup.step2Mid2}<code>open_position</code>{t.sessions.markup.step2Mid3}<code>authVcJson</code>{t.sessions.markup.step2After}</li>
                      <li>{t.sessions.markup.step3}</li>
                    </Box>

                    {/* 地址 vs 私鑰 對應，避免混淆 */}
                    <Alert severity="info" variant="outlined" icon={false} sx={{ py: 0.5 }}>
                      <Typography variant="caption">
                        <b>{t.sessions.markup.addrKeyBold1}</b>{t.sessions.markup.addrKeyMid1}<code>{short(sessAgent)}</code>{t.sessions.markup.addrKeyMid2}
                        <b>{t.sessions.markup.addrKeyBold2}</b>{t.sessions.markup.addrKeyAfter}<code>AGENT_PRIVATE_KEY</code>{t.sessions.markup.addrKeyTail}
                      </Typography>
                    </Alert>

                    {/* MCP config */}
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 0.5 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{t.sessions.export.mcpTitle}</Typography>
                        <Button size="small" variant="outlined" onClick={() => void copyText(t.sessions.export.copyMcpLabel, cfgStr)} sx={{ textTransform: 'none' }}>{t.sessions.export.copy}</Button>
                        <Button size="small" variant="outlined" onClick={() => downloadJson(`pepelab-mcp-session-${sid}.json`, cfg)} sx={{ textTransform: 'none' }}>{t.sessions.export.download}</Button>
                      </Stack>
                      {canIncludeKey && (
                        <Alert severity={includeKey ? 'error' : 'warning'} variant="outlined" sx={{ mb: 1, py: 0.5 }}>
                          <Typography variant="caption" sx={{ display: 'block', fontWeight: 700 }}>
                            {includeKey ? t.sessions.markup.includeKeyOnWarning : t.sessions.markup.includeKeyRiskTitle}
                          </Typography>
                          <Typography variant="caption" sx={{ display: 'block' }}>
                            {t.sessions.markup.includeKeyRisk}
                          </Typography>
                        </Alert>
                      )}
                      {canIncludeKey ? (
                        <FormControlLabel
                          control={<Checkbox size="small" color="error" checked={includeKey} onChange={e => setIncludeKey(e.target.checked)} />}
                          label={
                            <Typography variant="caption" color={includeKey ? 'error.main' : 'text.secondary'}>
                              {t.sessions.markup.includeKeyBefore}<code>AGENT_PRIVATE_KEY</code>{t.sessions.markup.includeKeyAfter}
                            </Typography>
                          }
                          sx={{ mb: 0.5 }}
                        />
                      ) : (
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                          <code>AGENT_PRIVATE_KEY</code>{t.sessions.markup.placeholderAfter}
                        </Typography>
                      )}
                      <Box component="pre" sx={preSx}>{cfgStr}</Box>
                    </Box>

                    {/* Authorization VC */}
                    <Box>
                      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{t.sessions.export.vcTitle}</Typography>
                        <Button size="small" variant="outlined" onClick={() => void copyText(t.sessions.export.copyVcLabel, vcStr)} sx={{ textTransform: 'none' }}>{t.sessions.export.copy}</Button>
                        <Button size="small" variant="outlined" onClick={() => downloadJson(`pepelab-auth-vc-session-${sid}.json`, vc)} sx={{ textTransform: 'none' }}>{t.sessions.export.download}</Button>
                      </Stack>
                      <Box component="pre" sx={preSx}>{vcStr}</Box>
                    </Box>

                    <Alert severity="warning" variant="outlined">
                      <Typography variant="caption">
                        {t.sessions.markup.finalWarnBefore}<b>{t.sessions.markup.finalWarnBold1}</b>{t.sessions.markup.finalWarnMid1}<code>AGENT_PRIVATE_KEY</code>{t.sessions.markup.finalWarnMid2}<b>{t.sessions.markup.finalWarnBold2}</b>{t.sessions.markup.finalWarnAfter}
                      </Typography>
                    </Alert>
                  </DialogContent>
                  <DialogActions>
                    <Button onClick={() => setExportFor(null)} sx={{ textTransform: 'none' }}>{t.sessions.export.close}</Button>
                  </DialogActions>
                </>
              )
            })()}
          </Dialog>

          <Divider />
          <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
            {interpolate(t.sessions.sessionManager, {
              address: short(getSessionManagerAddress(wallet.chainId)),
            })}
          </Typography>
        </>
      )}
    </Container>
  )
}
