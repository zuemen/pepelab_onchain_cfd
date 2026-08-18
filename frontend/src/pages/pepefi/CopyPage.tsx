import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link as RouterLink } from 'react-router'
import { parseEther } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { ASSET_LABEL, ASSET_META } from 'src/lib/pepefi/assetMeta'
import { useKYC } from 'src/hooks/useKYC'
import { useESG } from 'src/hooks/useESG'
import { useLivePrices } from 'src/hooks/useLivePrices'
import { useExecutionFee, formatEth } from 'src/hooks/useExecutionFee'
import { t, interpolate } from 'src/locales'
import { STABLE_LABEL } from 'src/lib/pepefi/tokenLabel'
import { firstBlocking, stalenessNotice } from 'src/lib/pepefi/priceFreshness'
import ESGBadge from 'src/components/pepefi/ESGBadge'
import KYCModal from 'src/components/pepefi/KYCModal'
import { getPepeAvatar } from 'src/utils/pepefi-assets'
import TraderRankBadge from 'src/components/pepefi/TraderRankBadge'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import TextField from '@mui/material/TextField';
import Snackbar from '@mui/material/Snackbar';
import Alert from '@mui/material/Alert';
import Link from '@mui/material/Link';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import Chip from '@mui/material/Chip';
import Breadcrumbs from '@mui/material/Breadcrumbs';
import Avatar from '@mui/material/Avatar';
import { explorerTx, explorerName } from 'src/lib/pepefi/notify'

interface TraderStakeData {
  stake:        bigint
  totalSlashed: bigint
  reputation:   bigint
}

interface CopyPreview {
  copyFee:            bigint
  totalTradingFee:    bigint
  marginForPositions: bigint
  portions:           bigint[]
}

interface AllocWithPrice {
  asset:      string
  weight:     bigint
  isLong:     boolean
  leverage:   bigint
  entryPrice: bigint   // 18-dec, current oracle price
}

const tryParse = (s: string): bigint | null => {
  if (!s) return null
  try { return parseEther(s) } catch { return null }
}

const f18  = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const fUsd = (v: bigint) =>
  '$' + (Number(v) / 1e18).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

export default function CopyPage() {
  const wallet = usePepefiWallet()
  const { traderAddress } = useParams<{ traderAddress: string }>()
  const navigate = useNavigate()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [traderName,       setTraderName]       = useState('')
  const [traderRegistered, setTraderRegistered] = useState(false)
  const [hasStrategy,      setHasStrategy]      = useState(false)
  const [loadError,        setLoadError]        = useState<string | null>(null)
  const [stratAllocs,      setStratAllocs]      = useState<AllocWithPrice[]>([])
  const [stakeData,        setStakeData]        = useState<TraderStakeData | null>(null)
  const [totalMargin,      setTotalMargin]      = useState('1000')
  const [approved,         setApproved]         = useState(false)
  const [busy,             setBusy]             = useState<Record<string, boolean>>({})
  const [toast,            setToast]            = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)
  const [preview,          setPreview]          = useState<CopyPreview | null>(null)
  const [showKYCModal,     setShowKYCModal]     = useState(false)

  const { isVerified: isKYCVerified, isPending: kycPending, refetch: refetchKYC } = useKYC(
    contracts?.kycRegistry ?? null,
    wallet.address ?? null,
  )
  const { data: esg } = useESG(contracts?.esgRegistry ?? null)
  const livePrices = useLivePrices()
  const execFee = useExecutionFee(contracts?.exchange ?? null)

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = (msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }

  useEffect(() => {
    if (!contracts || !traderAddress) return
    setLoadError(null)
    const go = async () => {
      let traderRaw: [boolean, string, bigint] | null = null;
      try {
        traderRaw = (await contracts.registry.traders(traderAddress)) as unknown as [boolean, string, bigint]
      } catch { traderRaw = null; }
      if (traderRaw) {
        setTraderName(traderRaw[1])
        setTraderRegistered(traderRaw[0])
      }

      let stratRaw: [unknown[], bigint] | null = null;
      try {
        stratRaw = (await contracts.registry.getLatestStrategy(traderAddress)) as unknown as [unknown[], bigint]
      } catch (e) {
        console.warn('[CopyPage] no strategy for', traderAddress, e)
        stratRaw = null;
      }

      if (stratRaw === null) {
        setStratAllocs([])
        setHasStrategy(false)
      } else {
        try {
          const allocs = stratRaw[0] as unknown as Array<{
            asset: string; weight: bigint; isLong: boolean; leverage: bigint
          }>
          const withPrices = await Promise.all(
            allocs.map(async a => {
              const pr = (await contracts.oracle.getPrice(a.asset)) as unknown as [bigint, bigint]
              return {
                asset:      a.asset,
                weight:     a.weight,
                isLong:     a.isLong,
                leverage:   a.leverage,
                entryPrice: pr[0] * 10n ** 10n,
              } satisfies AllocWithPrice
            }),
          )
          setStratAllocs(withPrices)
          setHasStrategy(true)
        } catch {
          setStratAllocs([])
          setHasStrategy(false)
        }
      }

      try {
        const [si, score] = await Promise.all([
          contracts.traderStake.getStake(traderAddress),
          contracts.traderStake.reputationScore(traderAddress),
        ])
        const s = si as unknown as { amount: bigint; totalSlashed: bigint }
        setStakeData({ stake: s.amount, totalSlashed: s.totalSlashed, reputation: score as bigint })
      } catch { /* not deployed */ }
    }
    void go()
  }, [contracts, traderAddress])

  useEffect(() => { setApproved(false) }, [totalMargin])

  const hasKYCRequired = stratAllocs.some(a => ASSET_META[a.asset]?.regulated)
  const kycBlocked     = hasKYCRequired && !isKYCVerified

  // ── F-2 · stale 擋單 ───────────────────────────────────────────────────────
  // 跟單會在同一筆交易裡對策略的每一個標的開倉。只要其中一檔的鏈上價過期，
  // 整筆就 revert StalePrice——而且 N 檔的 execution fee 已經一起送出去了。
  // 所以判斷是「有沒有任何一檔過期」，不是「選中的那檔」。
  const staleAlloc = firstBlocking(
    stratAllocs.map(a => ({
      label: ASSET_LABEL[a.asset] ?? a.asset.slice(0, 8),
      freshness: livePrices[a.asset]?.freshness,
    })),
  )
  const staleNotice = staleAlloc ? stalenessNotice(staleAlloc.freshness, staleAlloc.label) : null
  const staleBlocked = staleNotice !== null

  const COPY_FEE_BPS = 30n
  const totalBig  = tryParse(totalMargin) ?? 0n
  const feeBig    = totalBig * COPY_FEE_BPS / 10_000n
  const netBig    = totalBig - feeBig
  const previewRows = stratAllocs.map(a => ({
    ...a,
    margin:   netBig * a.weight / 10_000n,
    notional: netBig * a.weight / 10_000n * a.leverage,
  }))

  useEffect(() => {
    if (!contracts || !traderAddress || !totalBig || totalBig === 0n) {
      setPreview(null)
      return
    }
    let cancelled = false
    void (async () => {
      try {
        const r = await contracts.copyTracker.previewCopyAllocation(traderAddress, totalBig)
        if (!cancelled) {
          setPreview({
            copyFee:            r[0] as bigint,
            totalTradingFee:    r[1] as bigint,
            marginForPositions: r[2] as bigint,
            portions:           Array.from(r[3] as bigint[]),
          })
        }
      } catch {
        if (!cancelled) setPreview(null)
      }
    })()
    return () => { cancelled = true }
  }, [contracts, traderAddress, totalBig])

  const doApprove = async () => {
    if (!contracts) return
    const amt = tryParse(totalMargin)
    if (!amt) { notify(t.copy.tx.enterValidAmount, false); return }
    setLoad('approve', true)
    try {
      const tx = asTx(await contracts.usdc.approve(String(contracts.copyTracker.target), amt))
      await tx.wait()
      notify(interpolate(t.copy.tx.approved, { token: STABLE_LABEL }), true, tx.hash)
      setApproved(true)
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('approve', false) }
  }

  const doFollow = async () => {
    if (!contracts || !traderAddress) return
    const amt = tryParse(totalMargin)
    if (!amt) { notify(t.copy.tx.enterValidAmount, false); return }
    // F-2：任何一檔過期就別送。送出去只會 revert，但 N 筆 execution fee 的 gas
    // 已經花掉了——這是最貴的一種白撞牆。
    if (staleNotice) { notify(staleNotice, false); return }
    setLoad('follow', true)
    try {
      const execFeePerPosition = await contracts.exchange.executionFee() as bigint
      const totalExecFee = execFeePerPosition * BigInt(stratAllocs.length)
      const tx = asTx(await contracts.copyTracker.followTrader(traderAddress, amt, {
        value: totalExecFee
      }))
      await tx.wait()
      notify(t.copy.tx.following, true, tx.hash)
      navigate('/portfolio')
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('follow', false) }
  }

  if (!traderAddress) {
    return <Box sx={{ p: 4 }}><Typography color="text.secondary">{t.copy.invalidAddress}</Typography></Box>
  }

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.copy.connectWallet}</Typography>
      </Box>
    )
  }

  return (
    <Container maxWidth="md" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* Snackbar notification */}
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
            sx={{ width: '100%' }}
          >
            {toast.msg}
            {toast.hash && explorerTx(toast.hash, wallet.chainId) && (
              <Link
                href={explorerTx(toast.hash, wallet.chainId)!}
                target="_blank"
                rel="noopener noreferrer"
                color="inherit"
                sx={{ display: 'block', mt: 0.5, typography: 'caption', textDecoration: 'underline' }}
              >
                {interpolate(t.copy.viewOn, { explorer: explorerName(wallet.chainId) })}
              </Link>
            )}
          </Alert>
        ) : undefined}
      </Snackbar>

      {/* Load error banner */}
      {loadError && (
        <Alert severity="error">
          <strong>{t.copy.loadFailed}</strong> {loadError}
        </Alert>
      )}

      {/* Breadcrumb */}
      <Breadcrumbs separator="/" sx={{ mb: 1 }}>
        <Link component={RouterLink} to="/marketplace" color="inherit" underline="hover" sx={{ fontSize: '0.875rem' }}>
          {t.copy.breadcrumbMarketplace}
        </Link>
        <Typography variant="body2" color="text.primary">
          {traderName || shortAddr(traderAddress)}
        </Typography>
      </Breadcrumbs>

      {/* Header */}
      <Card sx={{ p: 3 }}>
        <Stack direction="row" spacing={3} alignItems="center">
          <Avatar
            src={getPepeAvatar(stakeData ? stakeData.reputation : null, traderAddress)}
            sx={{
              width: 80,
              height: 80,
              border: '3px solid',
              borderColor: stakeData && stakeData.reputation >= 80n ? 'warning.main' : 'rgba(255,255,255,0.1)',
              boxShadow: '0 0 16px rgba(0,0,0,0.5)',
              bgcolor: 'rgba(255, 255, 255, 0.05)',
              '& .MuiAvatar-img': {
                objectFit: 'contain',
                padding: '4px',
              }
            }}
          />
          <Box sx={{ flexGrow: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 2 }}>
              <Box>
                <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                  <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
                    {traderName || t.copy.header.unknownTrader}
                  </Typography>
                  <TraderRankBadge reputation={stakeData ? stakeData.reputation : null} />
                </Stack>
                <Typography variant="caption" sx={{ fontFamily: MONO, color: 'text.secondary', display: 'block', mt: 0.5 }}>
                  {traderAddress}
                </Typography>
              </Box>
              {stakeData && (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
                  <Chip
                    label={interpolate(t.copy.header.repChip, { rep: String(stakeData.reputation) })}
                    size="small"
                    sx={{
                      fontWeight: 'bold',
                      ...(stakeData.reputation >= 80n ? { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' }
                        : stakeData.reputation >= 60n ? { bgcolor: 'rgba(255, 171, 0, 0.16)', color: '#ffab00', border: '1px solid', borderColor: 'rgba(255, 171, 0, 0.24)' }
                        : { bgcolor: 'rgba(255, 86, 48, 0.16)', color: '#ff5630', border: '1px solid', borderColor: 'rgba(255, 86, 48, 0.24)' }
                      )
                    }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                    {interpolate(t.copy.header.staked, {
                      amount: (Number(stakeData.stake) / 1e18).toFixed(0),
                      token: STABLE_LABEL,
                    })}
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>
        </Stack>
        {!loadError && traderName !== '' && !traderRegistered && (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 2, fontWeight: 'bold' }}>
            {t.copy.header.notRegistered}
          </Typography>
        )}
      </Card>

      {/* Strategy allocations */}
      <Card sx={{ p: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>
          {t.copy.strategy.title}
        </Typography>

        {stratAllocs.length === 0 ? (
          <Typography color="text.secondary">{t.copy.strategy.empty}</Typography>
        ) : (
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {stratAllocs.map((a, i) => (
              <Chip
                key={i}
                label={interpolate(t.copy.strategy.chip, {
                  side: a.isLong ? '↑' : '↓',
                  asset: ASSET_LABEL[a.asset] ?? '?',
                  weight: (Number(a.weight) / 100).toFixed(0),
                  leverage: String(a.leverage),
                })}
                size="small"
                sx={{
                  fontWeight: 'bold',
                  ...(a.isLong
                    ? { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' }
                    : { bgcolor: 'rgba(255, 86, 48, 0.16)', color: '#ff5630', border: '1px solid', borderColor: 'rgba(255, 86, 48, 0.24)' }
                  )
                }}
              />
            ))}
          </Stack>
        )}
      </Card>

      {/* Strategy ESG composite */}
      {stratAllocs.length > 0 && (() => {
        const totalW = stratAllocs.reduce((s, a) => s + Number(a.weight), 0)
        if (totalW === 0) return null
        let wavg = 0
        let allRated = true
        for (const a of stratAllocs) {
          const info = esg[a.asset]
          if (!info) { allRated = false; break }
          wavg += info.composite * Number(a.weight)
        }
        if (!allRated) return null
        const composite = Math.round(wavg / totalW)
        const rating    = composite >= 80 ? 'AAA' : composite >= 70 ? 'AA' : composite >= 60 ? 'A' : composite >= 50 ? 'BBB' : 'CCC'
        const tierName  = composite >= 80 ? t.copy.esg.champion : composite >= 60 ? t.copy.esg.aware : t.copy.esg.considerGreener
        const tierColorHex = composite >= 80 ? '#22c55e' : composite >= 60 ? '#c0ca33' : '#ffab00'
        return (
          <Card sx={{ p: 2.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Typography variant="h5">🌱</Typography>
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 'bold' }}>
                  {t.copy.esg.title}
                </Typography>
                <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: tierColorHex }}>
                  {tierName}
                </Typography>
              </Box>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, ml: 'auto' }}>
              <ESGBadge composite={composite} rating={rating} size="md" />
              <Typography variant="h5" sx={{ fontWeight: 'extrabold', fontFamily: MONO, color: tierColorHex }}>
                {composite}
              </Typography>
              <Button
                component={RouterLink}
                to="/esg"
                variant="text"
                size="small"
                sx={{ textTransform: 'none' }}
              >
                {t.copy.esg.details}
              </Button>
            </Box>
          </Card>
        )
      })()}

      {/* Total margin input */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          {t.copy.amount.title}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <TextField
            type="number"
            size="small"
            placeholder={t.copy.amount.placeholder}
            value={totalMargin}
            disabled={!hasStrategy}
            onChange={e => setTotalMargin(e.target.value)}
            slotProps={{ htmlInput: { min: "0", style: { fontFamily: MONO } } }}
            sx={{ width: 200 }}
          />
          <Typography variant="body2" color="text.secondary">
            {interpolate(t.copy.amount.unitSuffix, { token: STABLE_LABEL })}
          </Typography>
          {!hasStrategy && (
            <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
              {t.copy.amount.disabledHint}
            </Typography>
          )}
        </Box>

        {preview && totalBig > 0n && (
          <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
            <Stack spacing={1} sx={{ typography: 'caption' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
                <Box>{t.copy.preview.totalDeposit}</Box>
                <Box sx={{ fontFamily: MONO, color: 'text.primary', fontWeight: 'semibold' }}>{f18(totalBig)} {STABLE_LABEL}</Box>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
                <Box>{t.copy.preview.copyFee}</Box>
                <Box sx={{ fontFamily: MONO, color: 'error.main', fontWeight: 'semibold' }}>-{f18(preview.copyFee)} {STABLE_LABEL}</Box>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
                <Box>{t.copy.preview.tradingFeeBuffer}</Box>
                <Box sx={{ fontFamily: MONO, color: 'error.main', fontWeight: 'semibold' }}>-{f18(preview.totalTradingFee)} {STABLE_LABEL}</Box>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.primary', fontWeight: 'bold', borderTop: '1px solid', borderColor: 'divider', pt: 1, mt: 0.5 }}>
                <Box>{t.copy.preview.effectiveMargin}</Box>
                <Box sx={{ fontFamily: MONO, color: 'success.main' }}>{f18(preview.marginForPositions)} {STABLE_LABEL}</Box>
              </Box>
            </Stack>
          </Card>
        )}

        {previewRows.length > 0 && totalBig > 0n && (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {[
                    t.copy.preview.column.asset,
                    t.copy.preview.column.side,
                    t.copy.preview.column.leverage,
                    t.copy.preview.column.weight,
                    t.copy.preview.column.margin,
                    t.copy.preview.column.notional,
                    t.copy.preview.column.estEntry,
                  ].map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {previewRows.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ fontFamily: MONO, fontWeight: 'bold', color: 'text.primary' }}>
                      {ASSET_LABEL[row.asset] ?? '?'}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 'bold', color: row.isLong ? 'success.main' : 'error.main' }}>
                      {row.isLong ? t.copy.preview.long : t.copy.preview.short}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO }}>{String(row.leverage)}×</TableCell>
                    <TableCell sx={{ fontFamily: MONO }}>{(Number(row.weight) / 100).toFixed(0)}%</TableCell>
                    <TableCell sx={{ fontFamily: MONO }} align="right">
                      {preview && preview.portions[i] !== undefined
                        ? f18(preview.portions[i])
                        : f18(row.margin)}
                    </TableCell>
                    <TableCell sx={{ fontFamily: MONO }} align="right">{f18(row.notional)}</TableCell>
                    <TableCell sx={{ fontFamily: MONO }} align="right">{fUsd(row.entryPrice)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>

      {/* Fee preview */}
      {totalBig > 0n && (
        <Card sx={{ p: 2.5, bgcolor: 'background.neutral', border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="overline" color="warning.main" sx={{ fontWeight: 'bold', display: 'block', mb: 1 }}>
            {t.copy.feePreview.title}
          </Typography>
          <Stack spacing={1} sx={{ typography: 'body2' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
              <Box>{t.copy.feePreview.copyFee}</Box>
              <Box sx={{ fontFamily: MONO }}>−{f18(feeBig, 4)} {STABLE_LABEL}</Box>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
              <Box>{t.copy.feePreview.netMargin}</Box>
              <Box sx={{ fontFamily: MONO, color: 'text.primary', fontWeight: 'semibold' }}>{f18(netBig)} {STABLE_LABEL}</Box>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary', borderTop: '1px solid', borderColor: 'divider', pt: 1, mt: 1 }}>
              <Box>{t.copy.feePreview.executionFee}</Box>
              <Box sx={{ fontFamily: MONO, color: 'primary.main', fontWeight: 'semibold' }}>{formatEth(execFee.wei * BigInt(stratAllocs.length))} ETH</Box>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              {t.copy.feePreview.split}
            </Typography>
          </Stack>
        </Card>
      )}

      {/* Trader stake / risk summary */}
      {stakeData && (
        <Card sx={{ p: 3, border: '1px solid', borderColor: stakeData.totalSlashed > 0n ? 'error.main' : 'divider', bgcolor: 'background.neutral' }}>
          <Typography variant="overline" sx={{ fontWeight: 'bold', display: 'block', mb: 1.5 }}>
            {t.copy.skinInGame.title}
          </Typography>
          <Grid container spacing={3}>
            <Grid size={{ xs: 4 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{t.copy.skinInGame.staked}</Typography>
              <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                {(Number(stakeData.stake) / 1e18).toFixed(0)} <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>{STABLE_LABEL}</Box>
              </Typography>
            </Grid>
            <Grid size={{ xs: 4 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{t.copy.skinInGame.reputation}</Typography>
              <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 'bold', color: stakeData.reputation >= 80n ? 'success.main' : stakeData.reputation >= 60n ? 'warning.main' : 'error.main' }}>
                {String(stakeData.reputation)} <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>{t.copy.skinInGame.reputationUnit}</Box>
              </Typography>
            </Grid>
            <Grid size={{ xs: 4 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{t.copy.skinInGame.totalSlashed}</Typography>
              <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 'bold', color: stakeData.totalSlashed > 0n ? 'error.main' : 'text.primary' }}>
                {(Number(stakeData.totalSlashed) / 1e18).toFixed(0)} <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>{STABLE_LABEL}</Box>
              </Typography>
            </Grid>
          </Grid>
          {stakeData.totalSlashed > 0n && (
            <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 2, fontWeight: 'semibold' }}>
              {interpolate(t.copy.skinInGame.slashedWarning, {
                amount: (Number(stakeData.totalSlashed) / 1e18).toFixed(0),
                token: STABLE_LABEL,
              })}
            </Typography>
          )}
          {stakeData.stake === 0n && (
            <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 2, fontWeight: 'semibold' }}>
              {t.copy.skinInGame.noStakeWarning}
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            {t.copy.skinInGame.slashRule}
          </Typography>
        </Card>
      )}

      {/* Two-stage action */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          {t.copy.confirm.title}
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Chip
            label={approved ? '✓' : '1'}
            size="small"
            color={approved ? 'success' : 'default'}
            sx={{ fontWeight: 'bold' }}
          />
          <Typography variant="body2" color={approved ? 'success.main' : 'text.secondary'}>
            {interpolate(t.copy.confirm.approveStep, { token: STABLE_LABEL })}
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ mx: 1 }}>→</Typography>
          <Chip
            label="2"
            size="small"
            color={approved ? 'default' : 'primary'}
            sx={{ fontWeight: 'bold' }}
          />
          <Typography variant="body2" color="text.secondary">
            {t.copy.confirm.followStep}
          </Typography>
        </Box>

        {staleNotice && (
          <Alert severity="error">
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 0.5 }}>
              {t.copy.confirm.staleTitle}
            </Typography>
            <Typography variant="caption" sx={{ display: 'block' }}>{staleNotice}</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              {interpolate(t.copy.confirm.staleExplain, { count: stratAllocs.length })}
            </Typography>
          </Alert>
        )}

        {/* 審核制：送出申請 ≠ 通過。待審中不要再推「完成 KYC」按鈕。 */}
        {kycBlocked && kycPending && (
          <Alert severity="info">
            ⏳ 你的 KYC 申請<b>已送出，正在等待審核</b>。審核人員核准後才能跟單含股票 / 債券的策略，不需要重複送出。
          </Alert>
        )}

        {kycBlocked && !kycPending && (
          <Alert severity="warning" action={
            <Button
              color="inherit"
              size="small"
              onClick={() => setShowKYCModal(true)}
              sx={{ fontWeight: 'bold' }}
            >
              {t.copy.confirm.kycSubmit}
            </Button>
          }>
            {t.copy.confirm.kycRequired}
          </Alert>
        )}

        <Box sx={{ display: 'flex', gap: 2 }}>
          <Button
            variant={approved ? 'contained' : 'outlined'}
            color={approved ? 'success' : 'inherit'}
            onClick={() => void doApprove()}
            disabled={approved || busy['approve'] || !totalMargin || !hasStrategy || kycBlocked}
            sx={{ flexGrow: 1 }}
          >
            {busy['approve'] ? t.copy.confirm.approving : approved ? t.copy.confirm.approved : t.copy.confirm.approveCta}
          </Button>

          <Button
            variant="contained"
            color="primary"
            onClick={() => void doFollow()}
            disabled={
              !hasStrategy || !approved || busy['follow'] || stratAllocs.length === 0 ||
              (preview !== null && preview.marginForPositions === 0n) ||
              kycBlocked || staleBlocked
            }
            title={staleNotice ?? undefined}
            sx={{ flexGrow: 1 }}
          >
            {busy['follow']
              ? t.copy.confirm.following
              : staleBlocked
                ? interpolate(t.copy.confirm.stalePrice, { asset: staleAlloc?.label ?? '' })
                : t.copy.confirm.followCta}
          </Button>
        </Box>

        {!hasStrategy && (
          <Typography variant="caption" color="warning.main" sx={{ textAlign: 'center', fontWeight: 'bold', display: 'block' }}>
            {t.copy.confirm.noStrategy}
          </Typography>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block' }}>
          {t.copy.confirm.footer}
        </Typography>
      </Card>

      {/* KYC Modal */}
      <KYCModal
        isOpen={showKYCModal}
        onClose={() => setShowKYCModal(false)}
        onSuccess={() => { void refetchKYC() }}
        kycRegistry={contracts?.kycRegistry ?? null}
        isPending={kycPending}
      />
    </Container>
  )
}
