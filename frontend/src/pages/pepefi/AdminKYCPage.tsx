import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback, useRef } from 'react'
import { isAddress } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { useKYCReviewQueue, type ReviewApplication } from 'src/hooks/useKYCReviewQueue'
import { screenApplication, type ScreeningResult, type ScreeningReasonCode } from 'src/lib/pepefi/kycScreening'
import { isCommitmentHash, verifyKycCommitment } from 'src/lib/pepefi/kycCommitment'
import { t, interpolate } from 'src/locales'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { withRetry } from 'src/lib/pepefi/rpcBatch'
import { explorerTx } from 'src/lib/pepefi/notify'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import EmptyState from 'src/components/pepefi/EmptyState'
import { useToast } from 'src/components/pepefi/ToastProvider'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Link from '@mui/material/Link';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Card from '@mui/material/Card';
import Chip from '@mui/material/Chip';
import Tooltip from '@mui/material/Tooltip';
import TextField from '@mui/material/TextField';
import LinearProgress from '@mui/material/LinearProgress';

// ── Component ─────────────────────────────────────────────────────────────────
//
// 硬擋，跟 AdminTreasuryPage 同一套姿態，不是 AdminOraclePage 那種軟擋——那頁
// 攤開的是公開價格，這頁攤開的是申請人姓名與國籍的彙整清單。非授權、或權限
// 讀取失敗（RPC 抖動），一律不顯示內容：跟 useKYC.ts 的 fail-closed 是同一條
// 原則，這頁不該是全站唯一 fail-open 的地方。
//
// 權限判斷刻意比 treasury 寬一格：合約的 `onlyVerifier` 修飾子本身就接受
// owner 或 setVerifier 指派的地址（見 KYCRegistry.sol），這裡原樣照抄，
// 讀 owner() 與 verifiers(me) 兩者，任一為真即放行。

const SHORT_ADDR = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const COUNTRY_NAMES: Record<string, string> = t.kyc.country;

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

// ── 三段共用的表格 ────────────────────────────────────────────────────────────
// 三段（待審／已驗證／已撤銷）欄位一樣，只有那顆動作鍵不同（核准／撤銷／無），
// 所以拆成一個參數化元件，而不是複製三份幾乎一樣的 JSX。

type RowAction = {
  label:    string
  busyLabel: string
  color:    'success' | 'error'
  onClick:  (app: ReviewApplication) => void
  disabled: (app: ReviewApplication) => boolean
} | null

const REASON_LABEL: Record<ScreeningReasonCode, string> = {
  unclearJurisdiction: t.admin.kyc.queue.screening.reasonUnclearJurisdiction,
  watchlistNameMatch: t.admin.kyc.queue.screening.reasonWatchlistNameMatch,
  hashedOffChainCheck: t.admin.kyc.queue.screening.reasonHashedOffChainCheck,
}

/**
 * 新版申請的姓名／國籍欄位在鏈上是 keccak256(salt ‖ 值)。完整值放 tooltip 方便複製
 * 比對，表格裡只顯示縮短版加一個「雜湊」標記，不讓它看起來像一個（很怪的）姓名。
 */
function HashOrPlain({ value, plain }: { value: string; plain?: string }) {
  if (!isCommitmentHash(value)) return <>{plain ?? value}</>
  return (
    <Tooltip title={value}>
      <Box component="span" sx={{ fontFamily: MONO, fontSize: '0.75rem', whiteSpace: 'nowrap' }}>
        {`${value.slice(0, 10)}…${value.slice(-6)}`}{' '}
        <Chip size="small" variant="outlined" label={t.admin.kyc.queue.hashedLabel} sx={{ height: 18, fontSize: 10 }} />
      </Box>
    </Tooltip>
  )
}

function ScreeningChip({ result }: { result: ScreeningResult }) {
  if (result.verdict === 'clean') {
    return <Chip size="small" color="success" variant="outlined" label={t.admin.kyc.queue.screening.clean} />
  }
  const reasonText = result.reasons.map(r => REASON_LABEL[r]).join(' · ')
  return (
    <Tooltip title={reasonText}>
      <Chip size="small" color="warning" label={t.admin.kyc.queue.screening.needsReview} />
    </Tooltip>
  )
}

// ── 線下比對工具 ──────────────────────────────────────────────────────────────
// 新版申請在鏈上只有 keccak256(salt ‖ 值)。申請人線下出示 salt 與原始資料後，審核員
// 在這裡重算比對。全部在瀏覽器內計算，不送出任何東西、不寫入任何地方。

type CheckResult =
  | { kind: 'notFound' | 'notHashed' | 'invalidSalt' }
  | { kind: 'compared'; nameMatches: boolean; nationalityMatches: boolean }

function CommitmentChecker({ apps }: { apps: ReviewApplication[] }) {
  const [address, setAddress] = useState('')
  const [salt, setSalt] = useState('')
  const [name, setName] = useState('')
  const [nationality, setNationality] = useState('')
  const [result, setResult] = useState<CheckResult | null>(null)
  const vt = t.admin.kyc.verifyTool

  const check = () => {
    const app = apps.find(a => a.address.toLowerCase() === address.trim().toLowerCase())
    if (!app) { setResult({ kind: 'notFound' }); return }
    if (!isCommitmentHash(app.fullName) || !isCommitmentHash(app.nationality)) { setResult({ kind: 'notHashed' }); return }
    try {
      const r = verifyKycCommitment({
        salt: salt.trim(),
        fullName: name,
        nationality,
        onChainName: app.fullName,
        onChainNationality: app.nationality,
      })
      setResult({ kind: 'compared', ...r })
    } catch {
      setResult({ kind: 'invalidSalt' })
    }
  }

  const line = (ok: boolean, yes: string, no: string) => (
    <Typography variant="body2" sx={{ color: ok ? 'success.main' : 'error.main', fontWeight: 700 }}>
      {ok ? `✓ ${yes}` : `✗ ${no}`}
    </Typography>
  )

  return (
    <Card sx={{ p: { xs: 2.5, sm: 3.5 } }}>
      <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1, display: 'block' }}>
        {vt.title}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
        {vt.body}
      </Typography>
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' } }}>
        <TextField size="small" autoComplete="off" label={vt.address} value={address} onChange={e => { setAddress(e.target.value); setResult(null) }}
          slotProps={{ htmlInput: { style: { fontFamily: MONO } } }} />
        <TextField size="small" autoComplete="off" label={vt.salt} value={salt} onChange={e => { setSalt(e.target.value); setResult(null) }}
          slotProps={{ htmlInput: { style: { fontFamily: MONO } } }} />
        <TextField size="small" autoComplete="off" label={vt.name} value={name} onChange={e => { setName(e.target.value); setResult(null) }} />
        <TextField size="small" autoComplete="off" label={vt.nationality} value={nationality} onChange={e => { setNationality(e.target.value); setResult(null) }} />
      </Box>
      <Box sx={{ mt: 1.5, display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
        <Button variant="outlined" onClick={check} disabled={!address.trim() || !salt.trim() || !name.trim() || !nationality.trim()}>
          {vt.submit}
        </Button>
        {result?.kind === 'notFound' && <Typography variant="body2" color="warning.main">{vt.notFound}</Typography>}
        {result?.kind === 'notHashed' && <Typography variant="body2" color="warning.main">{vt.notHashed}</Typography>}
        {result?.kind === 'invalidSalt' && <Typography variant="body2" color="error.main">{vt.invalidSalt}</Typography>}
        {result?.kind === 'compared' && (
          <Box>
            {line(result.nameMatches, vt.nameMatch, vt.nameMismatch)}
            {line(result.nationalityMatches, vt.nationalityMatch, vt.nationalityMismatch)}
          </Box>
        )}
      </Box>
    </Card>
  )
}

function ApplicationTable({
  apps,
  chainId,
  emptyTitle,
  action,
  screeningByAddress,
}: {
  apps:      ReviewApplication[]
  chainId:   number | null
  emptyTitle: string
  action:    RowAction
  /** 只有待審清單需要顯示 Screening 建議；其餘段落傳 undefined 即可。 */
  screeningByAddress?: Map<string, ScreeningResult>
}) {
  if (apps.length === 0) {
    return <EmptyState icon="✅" title={emptyTitle} />
  }
  return (
    <TableContainer>
      <Table size="small">
        <TableHead>
          <TableRow>
            <TableCell>{t.admin.kyc.queue.column.address}</TableCell>
            <TableCell>{t.admin.kyc.queue.column.name}</TableCell>
            <TableCell>{t.admin.kyc.queue.column.nationality}</TableCell>
            <TableCell>{t.admin.kyc.queue.column.submitted}</TableCell>
            {screeningByAddress && <TableCell>{t.admin.kyc.queue.column.screening}</TableCell>}
            {action && <TableCell align="right">{t.admin.kyc.queue.column.action}</TableCell>}
          </TableRow>
        </TableHead>
        <TableBody>
          {apps.map((app) => (
            <TableRow key={app.address}>
              <TableCell sx={{ fontFamily: MONO }}>
                {explorerTx(app.submittedTxHash, chainId) ? (
                  <Link href={explorerTx(app.submittedTxHash, chainId)!} target="_blank" rel="noopener noreferrer">
                    {SHORT_ADDR(app.address)}
                  </Link>
                ) : SHORT_ADDR(app.address)}
              </TableCell>
              <TableCell><HashOrPlain value={app.fullName} /></TableCell>
              <TableCell><HashOrPlain value={app.nationality} plain={COUNTRY_NAMES[app.nationality] ?? app.nationality} /></TableCell>
              <TableCell sx={{ fontFamily: MONO, color: 'text.secondary' }}>#{app.submittedBlock}</TableCell>
              {screeningByAddress && (
                <TableCell>
                  {(() => {
                    const result = screeningByAddress.get(app.address)
                    return result ? <ScreeningChip result={result} /> : null
                  })()}
                </TableCell>
              )}
              {action && (
                <TableCell align="right">
                  <Button
                    size="small"
                    variant="contained"
                    color={action.color}
                    disabled={action.disabled(app)}
                    onClick={() => action.onClick(app)}
                  >
                    {action.disabled(app) ? action.busyLabel : action.label}
                  </Button>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  )
}

export default function AdminKYCPage() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [registryOwner, setRegistryOwner] = useState<string | null>(null)
  const [isAppointedVerifier, setIsAppointedVerifier] = useState<boolean | null>(null)
  /**
   * 權限讀取的結果。'error' = owner() 也讀不到：顯示「無法確認權限」＋原因＋重試，
   * 不能無限停在「確認權限中…」。仍然 fail-closed：讀不到就不放行。
   */
  const [authStatus, setAuthStatus] = useState<'checking' | 'ready' | 'error'>('checking')
  const [authError, setAuthError] = useState<string | null>(null)
  /**
   * 線上 Base Sepolia 的 KYCRegistry（0x5D95…360d）是舊版：沒有 verifiers(address)
   * （也沒有 pending/isPending），呼叫回 missing revert data。這時只以 owner() 判斷權限，
   * 並隱藏審核員指派功能。
   */
  const [verifiersSupported, setVerifiersSupported] = useState(true)

  // runId 防止舊的請求晚回來蓋掉新的——例如切換錢包／換鏈時，前一次
  // fetchAuth 還沒回來，若晚於新的那次落地會把已經正確的「無權限」蓋回
  // 「有權限」，這頁絕不能是 fail-open 的地方。
  const authRunId = useRef(0)

  const fetchAuth = useCallback(async () => {
    authRunId.current += 1
    const myRun = authRunId.current

    if (!contracts || !wallet.address) {
      setRegistryOwner(null)
      setIsAppointedVerifier(null)
      setAuthStatus('checking')
      return
    }
    // owner() 與 verifiers() 分開讀：verifiers 讀不到（舊版合約沒有這個函式）不該連帶
    // 讓 owner 的判斷失效。
    const [ownerRes, appointedRes] = await Promise.allSettled([
      withRetry(() => contracts.kycRegistry.owner() as Promise<string>),
      contracts.kycRegistry.verifiers(wallet.address) as Promise<boolean>,
    ])
    if (authRunId.current !== myRun) return

    if (ownerRes.status === 'rejected') {
      console.error('[kyc auth] owner()', ownerRes.reason)
      // 讀取失敗一律當作沒權限，不留在舊值上；但要說出原因並給重試，不能無限轉圈。
      setRegistryOwner(null)
      setIsAppointedVerifier(null)
      setAuthError(prettyError(ownerRes.reason))
      setAuthStatus('error')
      return
    }
    setRegistryOwner(ownerRes.value)
    if (appointedRes.status === 'fulfilled') {
      setIsAppointedVerifier(appointedRes.value)
      setVerifiersSupported(true)
    } else {
      // 舊版合約沒有 verifiers()：退回只認 owner（fail-closed，非 owner 一律不放行）。
      console.warn('[kyc auth] verifiers() unavailable, falling back to owner-only', appointedRes.reason)
      setIsAppointedVerifier(false)
      setVerifiersSupported(false)
    }
    setAuthError(null)
    setAuthStatus('ready')
  }, [contracts, wallet.address])

  useEffect(() => { void fetchAuth() }, [fetchAuth])

  // 比照 AdminTreasuryPage：權限不是一次讀完就不變的——owner 可能在別的
  // session 撤銷這個審核員的資格，這個分頁還開著就該在短時間內反映出來，
  // 不能只靠使用者手動重新整理。
  useEffect(() => {
    const id = setInterval(() => { void fetchAuth() }, 15_000)
    return () => clearInterval(id)
  }, [fetchAuth])

  const authUnknown = authStatus === 'checking'

  const isOwner =
    registryOwner !== null &&
    wallet.address !== null &&
    wallet.address !== undefined &&
    registryOwner.toLowerCase() === wallet.address.toLowerCase()

  const isVerifier = isAppointedVerifier === true

  const authorized = isOwner || isVerifier

  const queue = useKYCReviewQueue(
    contracts?.kycRegistry ?? null,
    wallet.provider,
    wallet.chainId,
  )

  useEffect(() => {
    if (authorized) queue.refetch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authorized, contracts?.kycRegistry, wallet.chainId])

  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const { notify } = useToast()

  const doApprove = async (app: ReviewApplication) => {
    if (!contracts) return
    setBusy(p => ({ ...p, [app.address]: true }))
    try {
      const tx = asTx(await contracts.kycRegistry.approveKYC(app.address))
      await tx.wait()
      notify(t.admin.kyc.queue.approved, true, tx.hash)
      queue.refetch()
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy(p => ({ ...p, [app.address]: false }))
    }
  }

  const doRevoke = async (app: ReviewApplication) => {
    if (!contracts) return
    setBusy(p => ({ ...p, [app.address]: true }))
    try {
      const tx = asTx(await contracts.kycRegistry.revokeKYC(app.address))
      await tx.wait()
      notify(t.admin.kyc.queue.revoked, true, tx.hash)
      queue.refetch()
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy(p => ({ ...p, [app.address]: false }))
    }
  }

  // Screening 只產出建議，從不觸碰鏈上狀態——見 ADR 0004。純函式，逐筆算，
  // 不需要放進 hook：待審清單一變就重算，沒有額外的鏈上呼叫。
  const screeningByAddress = new Map(
    queue.pending.map(app => [app.address, screenApplication({ fullName: app.fullName, nationality: app.nationality })]),
  )
  const cleanPending = queue.pending.filter(app => screeningByAddress.get(app.address)?.verdict === 'clean')

  const [batchBusy, setBatchBusy] = useState(false)

  // Owner-only：指派／撤銷審核員。setVerifier 在這之前只出現在部署腳本的
  // 註解裡（見檔案頂端），這是它第一次被實際使用。
  const [verifierInput, setVerifierInput] = useState('')
  const [verifierBusy, setVerifierBusy] = useState<'assign' | 'revoke' | null>(null)
  const verifierInputValid = isAddress(verifierInput.trim())

  const setVerifierAllowed = async (allowed: boolean) => {
    if (!contracts || !verifierInputValid) return
    setVerifierBusy(allowed ? 'assign' : 'revoke')
    try {
      const tx = asTx(await contracts.kycRegistry.setVerifier(verifierInput.trim(), allowed))
      await tx.wait()
      notify(allowed ? t.admin.kyc.verifierAdmin.assigned : t.admin.kyc.verifierAdmin.revoked, true, tx.hash)
      if (allowed) setVerifierInput('')
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setVerifierBusy(null)
    }
  }
  const doApproveAllClean = async () => {
    if (!contracts || cleanPending.length === 0) return
    const addresses = cleanPending.map(a => a.address)
    setBatchBusy(true)
    // 批次核准的每一個地址也鎖住個別的核准鍵——approveKYCBatch 在合約端沒有
    // per-item try/catch（一筆 revert 整批一起倒），跟同一個地址的單筆核准
    // 同時送出只會讓兩筆搶同一個 nonce/狀態，浪費 gas 又混淆哪筆才算數。
    setBusy(p => { const next = { ...p }; for (const a of addresses) next[a] = true; return next })
    try {
      const tx = asTx(await contracts.kycRegistry.approveKYCBatch(addresses))
      await tx.wait()
      notify(interpolate(t.admin.kyc.queue.approveAllCleanDone, { count: cleanPending.length }), true, tx.hash)
      queue.refetch()
    } catch (e) {
      // approveKYCBatch 沒有 per-item try/catch，一筆 revert（例如名單裡有人
      // 剛好被撤銷）整批一起失敗——不能只丟一句泛用錯誤，讓審核員知道要退回
      // 逐筆核准。
      notify(`${prettyError(e)} ${t.admin.kyc.queue.approveAllCleanFailedHint}`, false)
    } finally {
      setBusy(p => { const next = { ...p }; for (const a of addresses) next[a] = false; return next })
      setBatchBusy(false)
    }
  }

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.admin.kyc.connectWallet}</Typography>
      </Box>
    )
  }

  if (!authorized && authStatus === 'error') {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 2, px: 2, textAlign: 'center' }}>
        <Typography variant="h2">🔒</Typography>
        <Typography variant="h5" sx={{ fontWeight: 'bold' }}>{t.admin.kyc.authFailed}</Typography>
        <Typography color="text.secondary">{t.admin.kyc.authFailedBody}</Typography>
        {authError && (
          <Typography variant="caption" color="error.main" sx={{ fontFamily: MONO }}>{authError}</Typography>
        )}
        <Button variant="outlined" onClick={() => { setAuthStatus('checking'); void fetchAuth() }}>
          {t.admin.kyc.authRetry}
        </Button>
      </Box>
    )
  }

  if (!authorized) {
    return (
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 2 }}>
        <Typography variant="h2">🔒</Typography>
        <Typography variant="h5" sx={{ fontWeight: 'bold' }}>
          {authUnknown ? t.admin.kyc.checkingAuth : t.admin.kyc.notAuthorized}
        </Typography>
        <Typography color="text.secondary">
          {authUnknown ? t.admin.kyc.checkingAuthBody : t.admin.kyc.notAuthorizedBody}
        </Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="md" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 'bold' }}>{t.admin.kyc.title}</Typography>
          <Typography color="text.secondary">{t.admin.kyc.subtitle}</Typography>
        </Box>
        <Button
          size="small"
          variant="text"
          color="inherit"
          onClick={() => queue.refetch()}
          disabled={queue.loading}
          sx={{ textTransform: 'none', color: 'text.secondary' }}
        >
          {t.admin.kyc.queue.refresh}
        </Button>
      </Box>

      <Alert severity="success">
        {isOwner ? t.admin.kyc.roleOwner : t.admin.kyc.roleVerifier}
      </Alert>

      <Alert severity="info" variant="outlined">
        {t.admin.kyc.notSecrecyNotice}
      </Alert>

      {/* 新版申請只把雜湊上鏈：審核員看不到姓名與國籍，必須線下比對。 */}
      <Alert severity="warning" variant="outlined">
        {t.admin.kyc.hashedNotice}
      </Alert>

      <CommitmentChecker apps={[...queue.pending, ...queue.verified, ...queue.revoked]} />

      {!verifiersSupported && (
        <Alert severity="info" variant="outlined">{t.admin.kyc.legacyRegistryNotice}</Alert>
      )}

      {isOwner && verifiersSupported && (
        <Card sx={{ p: { xs: 2.5, sm: 3.5 } }}>
          <Typography variant="overline" sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1, display: 'block' }}>
            {t.admin.kyc.verifierAdmin.title}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
            {t.admin.kyc.verifierAdmin.body}
          </Typography>
          <Box sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'flex-start' }}>
            <TextField
              size="small"
              label={t.admin.kyc.verifierAdmin.addressLabel}
              placeholder={t.admin.kyc.verifierAdmin.addressPlaceholder}
              value={verifierInput}
              onChange={(e) => setVerifierInput(e.target.value)}
              error={verifierInput.trim().length > 0 && !verifierInputValid}
              helperText={verifierInput.trim().length > 0 && !verifierInputValid ? t.admin.kyc.verifierAdmin.invalidAddress : ' '}
              sx={{ minWidth: 340, fontFamily: MONO }}
              slotProps={{ htmlInput: { style: { fontFamily: MONO } } }}
            />
            <Button
              variant="contained"
              color="success"
              disabled={!verifierInputValid || verifierBusy !== null}
              onClick={() => void setVerifierAllowed(true)}
            >
              {verifierBusy === 'assign' ? t.admin.kyc.verifierAdmin.assigning : t.admin.kyc.verifierAdmin.assign}
            </Button>
            <Button
              variant="outlined"
              color="error"
              disabled={!verifierInputValid || verifierBusy !== null}
              onClick={() => void setVerifierAllowed(false)}
            >
              {verifierBusy === 'revoke' ? t.admin.kyc.verifierAdmin.revoking : t.admin.kyc.verifierAdmin.revoke}
            </Button>
          </Box>
        </Card>
      )}

      {queue.error && (
        <Alert severity="warning">{queue.error}</Alert>
      )}

      {/* 7 天視窗在公共 RPC 上是數百段 getLogs，可能要幾十秒到數分鐘——進度一定要看得到。 */}
      {queue.loading && queue.progress && (
        <Box>
          <Typography variant="caption" color="text.secondary">
            {interpolate(t.admin.kyc.queue.scanning, queue.progress)}
          </Typography>
          <LinearProgress
            variant="determinate"
            value={queue.progress.total > 0 ? (queue.progress.done / queue.progress.total) * 100 : 0}
            sx={{ mt: 0.5, height: 4, borderRadius: 2 }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {t.admin.kyc.queue.scanningHint}
          </Typography>
        </Box>
      )}

      {/* 待審 */}
      <Card sx={{ p: { xs: 2.5, sm: 3.5 } }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 0.5 }}>
          <Typography
            variant="overline"
            sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1 }}
          >
            {t.admin.kyc.queue.pendingTitle}
          </Typography>
          {cleanPending.length > 0 && (
            <Button
              size="small"
              variant="outlined"
              color="success"
              disabled={batchBusy}
              onClick={() => void doApproveAllClean()}
            >
              {batchBusy
                ? t.admin.kyc.queue.approveAllCleanBusy
                : interpolate(t.admin.kyc.queue.approveAllClean, { count: cleanPending.length })}
            </Button>
          )}
        </Box>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          {t.admin.kyc.queue.screening.disclaimer}
        </Typography>
        {queue.loading ? <TableSkeleton rows={3} cols={6} /> : (
          <ApplicationTable
            apps={queue.pending}
            chainId={wallet.chainId}
            emptyTitle={t.admin.kyc.queue.pendingEmpty}
            screeningByAddress={screeningByAddress}
            action={{
              label: t.admin.kyc.queue.approve,
              busyLabel: t.admin.kyc.queue.approving,
              color: 'success',
              onClick: (app) => void doApprove(app),
              disabled: (app) => !!busy[app.address],
            }}
          />
        )}
      </Card>

      {/* 已驗證 */}
      <Card sx={{ p: { xs: 2.5, sm: 3.5 } }}>
        <Typography
          variant="overline"
          sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1, display: 'block', mb: 0.5 }}
        >
          {t.admin.kyc.queue.verifiedTitle}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          {t.admin.kyc.queue.verifiedCaveat}
        </Typography>
        {queue.loading ? <TableSkeleton rows={2} cols={5} /> : (
          <ApplicationTable
            apps={queue.verified}
            chainId={wallet.chainId}
            emptyTitle={t.admin.kyc.queue.verifiedEmpty}
            action={{
              label: t.admin.kyc.queue.revoke,
              busyLabel: t.admin.kyc.queue.revoking,
              color: 'error',
              onClick: (app) => void doRevoke(app),
              disabled: (app) => !!busy[app.address],
            }}
          />
        )}
      </Card>

      {/* 已撤銷 */}
      <Card sx={{ p: { xs: 2.5, sm: 3.5 } }}>
        <Typography
          variant="overline"
          sx={{ color: 'text.secondary', fontWeight: 700, letterSpacing: 1, display: 'block', mb: 0.5 }}
        >
          {t.admin.kyc.queue.revokedTitle}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
          {t.admin.kyc.queue.revokedNote}
        </Typography>
        {queue.loading ? <TableSkeleton rows={2} cols={4} /> : (
          <ApplicationTable
            apps={queue.revoked}
            chainId={wallet.chainId}
            emptyTitle={t.admin.kyc.queue.revokedEmpty}
            action={null}
          />
        )}
      </Card>

      {queue.scanRange && (
        <Typography variant="caption" color="text.disabled">
          {interpolate(t.admin.kyc.queue.scanRange, queue.scanRange)}
        </Typography>
      )}
    </Container>
  )
}
