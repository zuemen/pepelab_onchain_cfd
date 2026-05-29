import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link as RouterLink } from 'react-router'
import { parseEther } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { ASSET_LABEL, ASSET_META } from 'src/lib/pepefi/assetMeta'
import { useKYC } from 'src/hooks/useKYC'
import { useESG } from 'src/hooks/useESG'
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

  const { isVerified: isKYCVerified, refetch: refetchKYC } = useKYC(
    contracts?.kycRegistry ?? null,
    wallet.address ?? null,
  )
  const { data: esg } = useESG(contracts?.esgRegistry ?? null)

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
    if (!amt) { notify('Enter a valid amount', false); return }
    setLoad('approve', true)
    try {
      const tx = asTx(await contracts.usdc.approve(String(contracts.copyTracker.target), amt))
      await tx.wait()
      notify('USDC approved ✓', true, tx.hash)
      setApproved(true)
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('approve', false) }
  }

  const doFollow = async () => {
    if (!contracts || !traderAddress) return
    const amt = tryParse(totalMargin)
    if (!amt) { notify('Enter a valid amount', false); return }
    setLoad('follow', true)
    try {
      const execFeePerPosition = await contracts.exchange.executionFee() as bigint
      const totalExecFee = execFeePerPosition * BigInt(stratAllocs.length)
      const tx = asTx(await contracts.copyTracker.followTrader(traderAddress, amt, {
        value: totalExecFee
      }))
      await tx.wait()
      notify('Following trader ✓', true, tx.hash)
      navigate('/portfolio')
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('follow', false) }
  }

  if (!traderAddress) {
    return <Box sx={{ p: 4 }}><Typography color="text.secondary">Invalid trader address.</Typography></Box>
  }

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to copy a trader.</Typography>
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
            {toast.hash && wallet.chainId === 11155111 && (
              <Link
                href={`https://sepolia.etherscan.io/tx/${toast.hash}`}
                target="_blank"
                rel="noopener noreferrer"
                color="inherit"
                sx={{ display: 'block', mt: 0.5, typography: 'caption', textDecoration: 'underline' }}
              >
                View on Etherscan ↗
              </Link>
            )}
          </Alert>
        ) : undefined}
      </Snackbar>

      {/* Load error banner */}
      {loadError && (
        <Alert severity="error">
          <strong>Failed to load trader:</strong> {loadError}
        </Alert>
      )}

      {/* Breadcrumb */}
      <Breadcrumbs separator="/" sx={{ mb: 1 }}>
        <Link component={RouterLink} to="/marketplace" color="inherit" underline="hover" sx={{ fontSize: '0.875rem' }}>
          Marketplace
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
            }}
          />
          <Box sx={{ flexGrow: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 2 }}>
              <Box>
                <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap', gap: 1 }}>
                  <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
                    {traderName || 'Unknown Trader'}
                  </Typography>
                  <TraderRankBadge reputation={stakeData ? stakeData.reputation : null} />
                </Stack>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', display: 'block', mt: 0.5 }}>
                  {traderAddress}
                </Typography>
              </Box>
              {stakeData && (
                <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
                  <Chip
                    label={`◆ ${String(stakeData.reputation)} rep`}
                    size="small"
                    sx={{
                      fontWeight: 'bold',
                      ...(stakeData.reputation >= 80n ? { bgcolor: 'rgba(34, 197, 94, 0.16)', color: '#22c55e', border: '1px solid', borderColor: 'rgba(34, 197, 94, 0.24)' }
                        : stakeData.reputation >= 60n ? { bgcolor: 'rgba(255, 171, 0, 0.16)', color: '#ffab00', border: '1px solid', borderColor: 'rgba(255, 171, 0, 0.24)' }
                        : { bgcolor: 'rgba(255, 86, 48, 0.16)', color: '#ff5630', border: '1px solid', borderColor: 'rgba(255, 86, 48, 0.24)' }
                      )
                    }}
                  />
                  <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                    {(Number(stakeData.stake) / 1e18).toFixed(0)} USDC staked
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>
        </Stack>
        {!loadError && traderName !== '' && !traderRegistered && (
          <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 2, fontWeight: 'bold' }}>
            ⚠ This address is not registered as a trader.
          </Typography>
        )}
      </Card>

      {/* Strategy allocations */}
      <Card sx={{ p: 3 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>
          Latest Strategy
        </Typography>

        {stratAllocs.length === 0 ? (
          <Typography color="text.secondary">No strategy published yet.</Typography>
        ) : (
          <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
            {stratAllocs.map((a, i) => (
              <Chip
                key={i}
                label={`${a.isLong ? '↑' : '↓'} ${ASSET_LABEL[a.asset] ?? '?'} ${(Number(a.weight) / 100).toFixed(0)}% · ${String(a.leverage)}×`}
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
        const tierName  = composite >= 80 ? 'ESG Champion' : composite >= 60 ? 'ESG Aware' : 'Consider greener assets'
        const tierColorHex = composite >= 80 ? '#22c55e' : composite >= 60 ? '#c0ca33' : '#ffab00'
        return (
          <Card sx={{ p: 2.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Typography variant="h5">🌱</Typography>
              <Box>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', fontWeight: 'bold' }}>
                  Strategy ESG Score
                </Typography>
                <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: tierColorHex }}>
                  {tierName}
                </Typography>
              </Box>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, ml: 'auto' }}>
              <ESGBadge composite={composite} rating={rating} size="md" />
              <Typography variant="h5" sx={{ fontWeight: 'extrabold', fontFamily: 'monospace', color: tierColorHex }}>
                {composite}
              </Typography>
              <Button
                component={RouterLink}
                to="/esg"
                variant="text"
                size="small"
                sx={{ textTransform: 'none' }}
              >
                Details →
              </Button>
            </Box>
          </Card>
        )
      })()}

      {/* Total margin input */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          Copy Amount
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
          <TextField
            type="number"
            size="small"
            placeholder="1000"
            value={totalMargin}
            disabled={!hasStrategy}
            onChange={e => setTotalMargin(e.target.value)}
            slotProps={{ htmlInput: { min: "0", style: { fontFamily: 'monospace' } } }}
            sx={{ width: 200 }}
          />
          <Typography variant="body2" color="text.secondary">
            USDC total margin
          </Typography>
          {!hasStrategy && (
            <Typography variant="caption" color="text.disabled" sx={{ fontStyle: 'italic' }}>
              disabled — no strategy
            </Typography>
          )}
        </Box>

        {preview && totalBig > 0n && (
          <Card sx={{ p: 2, bgcolor: 'background.neutral' }}>
            <Stack spacing={1} sx={{ typography: 'caption' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
                <Box>Total deposit:</Box>
                <Box sx={{ fontFamily: 'monospace', color: 'text.primary', fontWeight: 'semibold' }}>{f18(totalBig)} USDC</Box>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
                <Box>− Copy fee (0.3%):</Box>
                <Box sx={{ fontFamily: 'monospace', color: 'error.main', fontWeight: 'semibold' }}>-{f18(preview.copyFee)} USDC</Box>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
                <Box>− Trading fee buffer:</Box>
                <Box sx={{ fontFamily: 'monospace', color: 'error.main', fontWeight: 'semibold' }}>-{f18(preview.totalTradingFee)} USDC</Box>
              </Box>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.primary', fontWeight: 'bold', borderTop: '1px solid', borderColor: 'divider', pt: 1, mt: 0.5 }}>
                <Box>Effective margin:</Box>
                <Box sx={{ fontFamily: 'monospace', color: 'success.main' }}>{f18(preview.marginForPositions)} USDC</Box>
              </Box>
            </Stack>
          </Card>
        )}

        {previewRows.length > 0 && totalBig > 0n && (
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {['Asset', 'Side', 'Lev', 'Weight', 'Margin', 'Notional', 'Est. Entry'].map(h => (
                    <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {previewRows.map((row, i) => (
                  <TableRow key={i}>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'text.primary' }}>
                      {ASSET_LABEL[row.asset] ?? '?'}
                    </TableCell>
                    <TableCell sx={{ fontWeight: 'bold', color: row.isLong ? 'success.main' : 'error.main' }}>
                      {row.isLong ? 'LONG ↑' : 'SHORT ↓'}
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{String(row.leverage)}×</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{(Number(row.weight) / 100).toFixed(0)}%</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }} align="right">
                      {preview && preview.portions[i] !== undefined
                        ? f18(preview.portions[i])
                        : f18(row.margin)}
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }} align="right">{f18(row.notional)}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }} align="right">{fUsd(row.entryPrice)}</TableCell>
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
            Fee Preview
          </Typography>
          <Stack spacing={1} sx={{ typography: 'body2' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
              <Box>Copy fee (0.3%)</Box>
              <Box sx={{ fontFamily: 'monospace' }}>−{f18(feeBig, 4)} USDC</Box>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary' }}>
              <Box>Net margin deposited</Box>
              <Box sx={{ fontFamily: 'monospace', color: 'text.primary', fontWeight: 'semibold' }}>{f18(netBig)} USDC</Box>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', color: 'text.secondary', borderTop: '1px solid', borderColor: 'divider', pt: 1, mt: 1 }}>
              <Box>Execution Fee (ETH)</Box>
              <Box sx={{ fontFamily: 'monospace', color: 'primary.main', fontWeight: 'semibold' }}>{(stratAllocs.length * 0.001).toFixed(3)} ETH</Box>
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
              Copy fee is split 70% → trader · 20% → platform · 10% → slash pool. Execution fee pays Keeper bots.
            </Typography>
          </Stack>
        </Card>
      )}

      {/* Trader stake / risk summary */}
      {stakeData && (
        <Card sx={{ p: 3, border: '1px solid', borderColor: stakeData.totalSlashed > 0n ? 'error.main' : 'divider', bgcolor: 'background.neutral' }}>
          <Typography variant="overline" sx={{ fontWeight: 'bold', display: 'block', mb: 1.5 }}>
            Trader Skin-in-the-Game
          </Typography>
          <Grid container spacing={3}>
            <Grid size={{ xs: 4 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Staked</Typography>
              <Typography variant="h6" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
                {(Number(stakeData.stake) / 1e18).toFixed(0)} <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>USDC</Box>
              </Typography>
            </Grid>
            <Grid size={{ xs: 4 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Reputation</Typography>
              <Typography variant="h6" sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: stakeData.reputation >= 80n ? 'success.main' : stakeData.reputation >= 60n ? 'warning.main' : 'error.main' }}>
                {String(stakeData.reputation)} <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>pts</Box>
              </Typography>
            </Grid>
            <Grid size={{ xs: 4 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Total Slashed</Typography>
              <Typography variant="h6" sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: stakeData.totalSlashed > 0n ? 'error.main' : 'text.primary' }}>
                {(Number(stakeData.totalSlashed) / 1e18).toFixed(0)} <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary' }}>USDC</Box>
              </Typography>
            </Grid>
          </Grid>
          {stakeData.totalSlashed > 0n && (
            <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 2, fontWeight: 'semibold' }}>
              ⚠ This trader has had {(Number(stakeData.totalSlashed) / 1e18).toFixed(0)} USDC slashed for causing excessive losses to followers. Proceed with caution.
            </Typography>
          )}
          {stakeData.stake === 0n && (
            <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 2, fontWeight: 'semibold' }}>
              ⚠ This trader has no stake — they have no skin-in-the-game. You cannot trigger slashing if they cause losses.
            </Typography>
          )}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            ⚠ If your loss exceeds 30%, this trader's stake will be slashed (50% of loss, capped at 50% of stake) and transferred to you as compensation.
          </Typography>
        </Card>
      )}

      {/* Two-stage action */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          Confirm Copy
        </Typography>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <Chip
            label={approved ? '✓' : '1'}
            size="small"
            color={approved ? 'success' : 'default'}
            sx={{ fontWeight: 'bold' }}
          />
          <Typography variant="body2" color={approved ? 'success.main' : 'text.secondary'}>
            Approve USDC to CopyTracker
          </Typography>
          <Typography variant="body2" color="text.disabled" sx={{ mx: 1 }}>→</Typography>
          <Chip
            label="2"
            size="small"
            color={approved ? 'default' : 'primary'}
            sx={{ fontWeight: 'bold' }}
          />
          <Typography variant="body2" color="text.secondary">
            Follow Trader
          </Typography>
        </Box>

        {kycBlocked && (
          <Alert severity="warning" action={
            <Button
              color="inherit"
              size="small"
              onClick={() => setShowKYCModal(true)}
              sx={{ fontWeight: 'bold' }}
            >
              完成 KYC
            </Button>
          }>
            🔒 此策略包含股票 / 債券資產，需要完成 KYC 驗證才能跟單。
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
            {busy['approve'] ? 'Approving…' : approved ? 'Approved' : 'Step 1 · Approve'}
          </Button>

          <Button
            variant="contained"
            color="primary"
            onClick={() => void doFollow()}
            disabled={
              !hasStrategy || !approved || busy['follow'] || stratAllocs.length === 0 ||
              (preview !== null && preview.marginForPositions === 0n) ||
              kycBlocked
            }
            sx={{ flexGrow: 1 }}
          >
            {busy['follow'] ? 'Following…' : 'Step 2 · Follow Trader'}
          </Button>
        </Box>

        {!hasStrategy && (
          <Typography variant="caption" color="warning.main" sx={{ textAlign: 'center', fontWeight: 'bold', display: 'block' }}>
            ⚠ Trader has no published strategy. Copy is disabled.
          </Typography>
        )}

        <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block' }}>
          Your margin will be automatically split and deposited into positions according to the strategy above.
        </Typography>
      </Card>

      {/* KYC Modal */}
      <KYCModal
        isOpen={showKYCModal}
        onClose={() => setShowKYCModal(false)}
        onSuccess={() => { refetchKYC(); setShowKYCModal(false) }}
        kycRegistry={contracts?.kycRegistry ?? null}
      />
    </Container>
  )
}
