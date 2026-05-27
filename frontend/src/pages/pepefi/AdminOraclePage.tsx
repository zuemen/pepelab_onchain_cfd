import { useState, useEffect, useCallback, useRef } from 'react'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { useFundingData } from 'src/hooks/useFundingData'
import { ASSET_IDS } from 'src/contracts/addresses'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import { ASSETS_LIST } from 'src/lib/pepefi/assetMeta'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
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
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import Stack from '@mui/material/Stack';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';

// ── Config ────────────────────────────────────────────────────────────────────
type AssetId = `0x${string}`

const ASSETS = ASSETS_LIST

// ── Types ─────────────────────────────────────────────────────────────────────
interface AssetRow {
  id:        AssetId
  label:     string
  price8:    bigint
  updatedAt: bigint
  input:     string
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const fPrice8 = (p: bigint) =>
  '$' + (Number(p) / 1e8).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })

const fDate = (ts: bigint) =>
  ts === 0n
    ? '—'
    : new Date(Number(ts) * 1000).toLocaleString('zh-TW', {
        dateStyle: 'short',
        timeStyle: 'short',
      })

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

// ── Funding helpers ───────────────────────────────────────────────────────────
const fOI = (v: bigint) => (Number(v) / 1e18).toFixed(2)
const fImbalance = (long: bigint, short: bigint): string => {
  const total = long + short
  if (total === 0n) return '0.00%'
  const pct = (Number(long - short) / Number(total)) * 100
  return (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%'
}
const fCountdown = (lastSettled: bigint, interval: bigint): string => {
  const nextAt = Number(lastSettled + interval)
  const now    = Math.floor(Date.now() / 1000)
  const secs   = nextAt - now
  if (secs <= 0) return 'Now'
  const m = Math.floor(secs / 60)
  const s = secs % 60
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

// ── Component ─────────────────────────────────────────────────────────────────
export default function AdminOraclePage() {
  const wallet = usePepefiWallet()
  const contracts    = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const fundingData  = useFundingData(contracts?.exchange ?? null)

  const [assets,         setAssets]         = useState<AssetRow[]>(
    ASSETS.map(a => ({ id: a.id, label: a.symbol, price8: 0n, updatedAt: 0n, input: '' })),
  )
  const [oracleOwner,    setOracleOwner]    = useState<string | null>(null)
  const [ownerCheckError, setOwnerCheckError] = useState<string | null>(null)
  const [busy,           setBusy]           = useState<Record<string, boolean>>({})
  const [toast,          setToast]          = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)
  const [autoSettle,     setAutoSettle]     = useState(false)
  const [fundingSettleBusy, setFundingSettleBusy] = useState<Record<string, boolean>>({})
  const [, setTick]   = useState(0)  // force re-render for countdown
  const autoSettleRef = useRef(false)

  const isOwner =
    oracleOwner !== null &&
    wallet.address !== null &&
    oracleOwner.toLowerCase() === wallet.address.toLowerCase()

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = (msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }

  // Countdown ticker
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 1000)
    return () => clearInterval(t)
  }, [])

  // Settle funding for one asset
  const settleFunding = useCallback(async (assetId: string) => {
    if (!contracts || !isOwner) return
    const key = `settle_${assetId}`
    setFundingSettleBusy(p => ({ ...p, [key]: true }))
    try {
      const tx = asTx(await contracts.exchange.settleFunding(assetId))
      await tx.wait()
      notify(`Funding settled ✓`, true, tx.hash)
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setFundingSettleBusy(p => ({ ...p, [key]: false }))
    }
  }, [contracts, isOwner])

  // Auto-settle toggle: check every 60s, settle all eligible assets
  useEffect(() => {
    autoSettleRef.current = autoSettle
  }, [autoSettle])

  useEffect(() => {
    if (!autoSettle) return
    const run = async () => {
      if (!contracts || !autoSettleRef.current) return
      for (const [id, info] of Object.entries(fundingData)) {
        if (info.canSettle) {
          try {
            const tx = asTx(await contracts.exchange.settleFunding(id))
            await tx.wait()
          } catch { /* ignore */ }
        }
      }
    }
    void run()
    const t = setInterval(() => { void run() }, 60_000)
    return () => clearInterval(t)
  }, [autoSettle, contracts, fundingData])

  // ── Fetch prices ──────────────────────────────────────────────────────────
  const fetchPrices = useCallback(async () => {
    if (!contracts) return
    try {
      const rows = await Promise.all(
        ASSETS.map(async a => {
          const res = (await contracts.oracle.getPrice(a.id)) as unknown as [bigint, bigint]
          return {
            id:        a.id,
            label:     a.symbol,
            price8:    res[0],
            updatedAt: res[1],
            input:     (Number(res[0]) / 1e8).toFixed(2),
          }
        }),
      )
      setAssets(rows)
    } catch (e) {
      console.error('[oracle fetch]', e)
      notify(prettyError(e), false)
    }
  }, [contracts])

  // ── Check oracle ownership (cancellation flag avoids unmount race) ────────
  useEffect(() => {
    if (!contracts) return
    let cancelled = false
    void (async () => {
      try {
        const owner = (await contracts.oracle.owner()) as string
        if (!cancelled) { setOracleOwner(owner); setOwnerCheckError(null) }
      } catch (e) {
        if (!cancelled) {
          setOracleOwner(null)
          setOwnerCheckError(e instanceof Error ? e.message.slice(0, 120) : 'Failed to read owner')
        }
      }
    })()
    return () => { cancelled = true }
  }, [contracts])

  useEffect(() => { void fetchPrices() }, [fetchPrices])

  // ── Update price ──────────────────────────────────────────────────────────
  const updatePrice = async (id: AssetId, inputStr: string) => {
    if (!contracts) return
    if (!isOwner) {
      notify('Connected wallet is not the oracle owner', false)
      return
    }
    const new8 = BigInt(Math.round(parseFloat(inputStr) * 1e8))
    setLoad(id, true)
    try {
      const tx = asTx(await contracts.oracle.updatePrice(id, new8))
      await tx.wait()
      notify('Price updated ✓', true, tx.hash)
      await fetchPrices()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad(id, false) }
  }

  const updateInput = (id: AssetId, value: string) =>
    setAssets(prev => prev.map(a => a.id === id ? { ...a, input: value } : a))


  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to access Oracle Admin.</Typography>
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

      {/* Header */}
      <Box sx={{ mb: 1 }}>
        <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
          Oracle Price Admin
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Only the oracle owner wallet can update prices.
        </Typography>
      </Box>


      {/* Owner status banner */}
      {ownerCheckError ? (
        <Alert severity="error">
          <strong>Failed to read oracle owner:</strong> {ownerCheckError}
        </Alert>
      ) : oracleOwner === null ? (
        <Alert severity="info">Checking owner permissions…</Alert>
      ) : !isOwner ? (
        <Alert severity="warning">
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
            Read-only mode: connected wallet is not the oracle owner. Updates will revert.
          </Typography>
          <Box sx={{ fontFamily: 'monospace', fontSize: '0.75rem', mt: 1 }}>
            Owner: {oracleOwner.slice(0, 10)}…{oracleOwner.slice(-6)}<br />
            You:&nbsp;&nbsp;&nbsp;{wallet.address?.slice(0, 10)}…{wallet.address?.slice(-6)}
          </Box>
        </Alert>
      ) : (
        <Alert severity="success">Owner verified ✓</Alert>
      )}

      {/* General warning */}
      <Alert severity="warning">
        <strong>Note:</strong> MockOracle price changes immediately affect all open position PnL.
        In production, oracle prices would come from trusted off-chain data feeds (e.g. Chainlink).
      </Alert>

      {/* ─── Funding Settlement ──────────────────────────────────────────── */}
      {isOwner && (
        <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
            <Box>
              <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
                Funding Settlement
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Settle per-asset funding (every {Object.values(fundingData)[0]
                  ? `${Number(Object.values(fundingData)[0].interval) / 60}m`
                  : '5m'}). Anyone can call on-chain; UI restricts to owner.
              </Typography>
            </Box>
            <FormControlLabel
              control={
                <Checkbox
                  checked={autoSettle}
                  onChange={e => setAutoSettle(e.target.checked)}
                  color="success"
                />
              }
              label={<Typography variant="body2">Auto-Settle</Typography>}
            />
          </Box>

          {Object.keys(fundingData).length === 0 ? (
            <TableSkeleton rows={4} cols={7} />
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow sx={{ bgcolor: 'background.neutral' }}>
                    {['Asset','Rate (bps)','Long OI','Short OI','Imbalance','Last Settled','Next In',''].map(h => (
                      <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {ASSETS.map(a => {
                    const info = fundingData[a.id]
                    if (!info) return null
                    const key     = `settle_${a.id}`
                    const rateNum = Number(info.rate)
                    return (
                      <TableRow key={a.id} hover>
                        <TableCell sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'text.primary' }}>{a.symbol}</TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: rateNum > 0 ? 'error.main' : rateNum < 0 ? 'success.main' : 'text.secondary' }}>
                          {rateNum > 0 ? '+' : ''}{rateNum} {rateNum > 0 ? '(L pay)' : rateNum < 0 ? '(S pay)' : ''}
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace' }}>{fOI(info.longOI)}</TableCell>
                        <TableCell sx={{ fontFamily: 'monospace' }}>{fOI(info.shortOI)}</TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', color: Number(info.longOI) > Number(info.shortOI) ? 'error.main' : 'success.main' }}>
                          {fImbalance(info.longOI, info.shortOI)}
                        </TableCell>
                        <TableCell sx={{ fontSize: '0.75rem', color: 'text.secondary' }}>
                          {info.lastSettled === 0n ? 'Never' : fDate(info.lastSettled)}
                        </TableCell>
                        <TableCell sx={{ fontSize: '0.75rem', fontFamily: 'monospace' }}>
                          {info.canSettle ? <Typography variant="caption" sx={{ color: 'success.main', fontWeight: 'bold' }}>Ready</Typography> : fCountdown(info.lastSettled, info.interval)}
                        </TableCell>
                        <TableCell align="right">
                          <Button
                            size="small"
                            variant="outlined"
                            onClick={() => void settleFunding(a.id)}
                            disabled={!info.canSettle || !!fundingSettleBusy[key]}
                            sx={{ textTransform: 'none' }}
                          >
                            {fundingSettleBusy[key] ? '…' : 'Settle Now'}
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
      )}

      {/* Price table */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="h6" sx={{ fontWeight: 'bold' }}>
            Asset Prices (8-decimal)
          </Typography>
          <Button
            variant="text"
            size="small"
            onClick={() => void fetchPrices()}
            sx={{ textTransform: 'none' }}
          >
            ↺ Refresh
          </Button>
        </Box>

        <Stack spacing={2}>
          {assets.map((row, index) => {
            const hasVal = row.input !== '' && !isNaN(parseFloat(row.input))
            return (
              <Box key={row.id} sx={{ pt: index > 0 ? 2 : 0, borderTop: index > 0 ? '1px solid' : 'none', borderColor: 'divider', display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 2 }}>
                  <Box>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                      <Typography variant="subtitle1" sx={{ fontWeight: 'bold', fontFamily: 'monospace' }}>{row.label}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                        {row.id.slice(0, 10)}…
                      </Typography>
                    </Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                      Last updated: {fDate(row.updatedAt)}
                    </Typography>
                  </Box>
                  <Typography variant="h5" color="success.main" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
                    {row.price8 > 0n ? fPrice8(row.price8) : '—'}
                  </Typography>
                </Box>

                <Box sx={{ display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
                  <TextField
                    type="number"
                    size="small"
                    disabled={!isOwner}
                    placeholder={row.price8 > 0n ? (Number(row.price8) / 1e8).toFixed(2) : '0.00'}
                    value={row.input}
                    onChange={e => updateInput(row.id, e.target.value)}
                    slotProps={{
                      htmlInput: { min: "0", step: "0.01", style: { fontFamily: 'monospace' } },
                      input: {
                        startAdornment: <Typography variant="body2" color="text.secondary" sx={{ mr: 0.5 }}>$</Typography>,
                      }
                    }}
                    sx={{ width: 200 }}
                  />
                  <Button
                    variant="contained"
                    color="warning"
                    onClick={() => void updatePrice(row.id, row.input)}
                    disabled={busy[row.id] || !hasVal || !isOwner}
                  >
                    {busy[row.id] ? 'Updating…' : 'Update Price'}
                  </Button>
                </Box>
              </Box>
            )
          })}
        </Stack>
      </Card>

      {/* Raw values Accordion */}
      <Accordion sx={{ bgcolor: 'transparent', backgroundImage: 'none', border: '1px solid', borderColor: 'divider', '&::before': { display: 'none' } }}>
        <AccordionSummary expandIcon={<Typography variant="caption">▼</Typography>}>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 'bold' }}>
            Raw 8-decimal prices (for cast commands)
          </Typography>
        </AccordionSummary>
        <AccordionDetails sx={{ borderTop: '1px solid', borderColor: 'divider', bgcolor: 'background.neutral' }}>
          <Stack spacing={0.5} sx={{ fontFamily: 'monospace', fontSize: '0.75rem', color: 'text.secondary' }}>
            {assets.map(a => (
              <Box key={a.id}>
                {a.label}: {String(a.price8)} (= ${(Number(a.price8)/1e8).toFixed(2)})
              </Box>
            ))}
          </Stack>
        </AccordionDetails>
      </Accordion>
    </Container>
  )
}
