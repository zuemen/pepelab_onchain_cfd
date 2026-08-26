import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback, useRef } from 'react'
import { isAddress } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { useKYCReviewQueue, type ReviewApplication } from 'src/hooks/useKYCReviewQueue'
import { screenApplication, type ScreeningResult, type ScreeningReasonCode } from 'src/lib/pepefi/kycScreening'
import { t, interpolate } from 'src/locales'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { explorerTx, explorerName } from 'src/lib/pepefi/notify'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import EmptyState from 'src/components/pepefi/EmptyState'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Alert from '@mui/material/Alert';
import Button from '@mui/material/Button';
import Snackbar from '@mui/material/Snackbar';
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
              <TableCell>{app.fullName}</TableCell>
              <TableCell>{COUNTRY_NAMES[app.nationality] ?? app.nationality}</TableCell>
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
      return
    }
    try {
      const [owner, appointed] = await Promise.all([
        contracts.kycRegistry.owner() as Promise<string>,
        contracts.kycRegistry.verifiers(wallet.address) as Promise<boolean>,
      ])
      if (authRunId.current !== myRun) return
      setRegistryOwner(owner)
      setIsAppointedVerifier(appointed)
    } catch (e) {
      console.error('[kyc auth]', e)
      if (authRunId.current !== myRun) return
      // 讀取失敗一律當作沒權限，不留在舊值上。
      setRegistryOwner(null)
      setIsAppointedVerifier(null)
    }
  }, [contracts, wallet.address])

  useEffect(() => { void fetchAuth() }, [fetchAuth])

  // 比照 AdminTreasuryPage：權限不是一次讀完就不變的——owner 可能在別的
  // session 撤銷這個審核員的資格，這個分頁還開著就該在短時間內反映出來，
  // 不能只靠使用者手動重新整理。
  useEffect(() => {
    const id = setInterval(() => { void fetchAuth() }, 15_000)
    return () => clearInterval(id)
  }, [fetchAuth])

  const authUnknown =
    registryOwner === null && isAppointedVerifier === null

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
  const [toast, setToast] = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const notify = (msg: string, ok: boolean, hash?: string) => {
    // 前一顆 toast 的計時器若還沒到，先取消——不然它會準時把這一顆新的
    // toast 提早清掉，讓兩個動作連續發生時，第二個的訊息一閃就不見。
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ msg, ok, hash })
    toastTimer.current = setTimeout(() => setToast(null), 6000)
  }

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
      <Snackbar
        open={!!toast}
        autoHideDuration={6000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        {toast ? (
          <Alert
            severity={toast.ok ? 'success' : 'error'}
            onClose={() => setToast(null)}
            action={
              toast.hash && explorerTx(toast.hash, wallet.chainId) ? (
                <Button
                  color="inherit"
                  size="small"
                  component="a"
                  href={explorerTx(toast.hash, wallet.chainId)!}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {explorerName(wallet.chainId)}
                </Button>
              ) : null
            }
          >
            {toast.msg}
          </Alert>
        ) : <div />}
      </Snackbar>

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

      {isOwner && (
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

      {queue.loading && queue.progress && (
        <Typography variant="caption" color="text.secondary">
          {interpolate(t.admin.kyc.queue.scanning, queue.progress)}
        </Typography>
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
