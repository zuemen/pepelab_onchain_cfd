import { useState, useEffect, useCallback, useRef } from 'react'
import { Link as RouterLink } from 'react-router'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { ASSET_IDS } from 'src/contracts/addresses'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { TableSkeleton } from 'src/components/pepefi/Skeleton'
import { ASSETS_LIST, ASSET_LABEL } from 'src/lib/pepefi/assetMeta'
import { getPepeAvatar } from 'src/utils/pepefi-assets'
import TraderRankBadge from 'src/components/pepefi/TraderRankBadge'
import Avatar from '@mui/material/Avatar'

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
import Select from '@mui/material/Select';
import MenuItem from '@mui/material/MenuItem';
import Chip from '@mui/material/Chip';

// ── Config ─────────────────────────────────────────────────────────────────
type AssetId = `0x${string}`

const ASSETS = ASSETS_LIST

// ── Types ──────────────────────────────────────────────────────────────────
interface AllocRow {
  uid:      number
  asset:    AssetId
  isLong:   boolean
  leverage: number
  weight:   string
}

interface RawAlloc {
  asset:    string
  weight:   bigint
  isLong:   boolean
  leverage: bigint
}

interface HistVer {
  versionId: number
  createdAt: bigint
  allocs:    RawAlloc[]
  expanded:  boolean
}

interface TraderInfo {
  isRegistered: boolean
  displayName:  string
}

// ── Helpers ────────────────────────────────────────────────────────────────
const parseAlloc = (a: unknown): RawAlloc => {
  const x = a as { asset: string; weight: bigint; isLong: boolean; leverage: bigint }
  return { asset: x.asset, weight: x.weight, isLong: x.isLong, leverage: x.leverage }
}

const fmtDate = (ts: bigint) =>
  new Date(Number(ts) * 1000).toLocaleString('zh-TW', {
    dateStyle: 'short',
    timeStyle: 'short',
  })

const fmtPct = (bps: bigint) => (Number(bps) / 100).toFixed(0) + '%'

type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (tx: unknown): TxResp => tx as TxResp

// ── Component ──────────────────────────────────────────────────────────────
export default function TraderDashboard() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [traderInfo, setTraderInfo] = useState<TraderInfo | null>(null)
  const [nameInput,  setNameInput]  = useState('')
  const [eligible,   setEligible]   = useState<boolean | null>(null)
  const [stakeData,  setStakeData]  = useState<{ stake: bigint; totalSlashed: bigint; reputation: bigint } | null>(null)

  const uidRef = useRef(0)
  const [rows, setRows] = useState<AllocRow[]>([])

  const [history,        setHistory]        = useState<HistVer[]>([])
  const [historyLoading, setHistoryLoading] = useState(true)
  const [earnings,       setEarnings]       = useState<bigint | null>(null)

  const [busy,  setBusy]  = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<{ msg: string; ok: boolean; hash?: string } | null>(null)

  const setLoad = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify  = useCallback((msg: string, ok: boolean, hash?: string) => {
    setToast({ msg, ok, hash })
    setTimeout(() => setToast(null), 6000)
  }, [])

  // ── Fetch ─────────────────────────────────────────────────────────────────
  const fetchTrader = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const raw = (await contracts.registry.traders(wallet.address)) as unknown as [boolean, string, bigint]
      setTraderInfo({ isRegistered: raw[0], displayName: raw[1] })
    } catch (e) {
      console.warn('[trader fetch]', e)
    }
    try {
      const elig = await contracts.traderStake.isEligible(wallet.address)
      setEligible(elig as boolean)
    } catch { setEligible(null) }

    // Fetch stake and reputation score
    try {
      const [si, score] = await Promise.all([
        contracts.traderStake.getStake(wallet.address),
        contracts.traderStake.reputationScore(wallet.address),
      ])
      const s = si as unknown as { amount: bigint; totalSlashed: bigint }
      setStakeData({ stake: s.amount, totalSlashed: s.totalSlashed, reputation: score as bigint })
    } catch { /* not deployed or failed */ }
  }, [contracts, wallet.address, notify])

  const fetchHistory = useCallback(async () => {
    if (!contracts || !wallet.address) return
    setHistoryLoading(true)
    try {
      const count = Number((await contracts.registry.getStrategyCount(wallet.address)) as bigint)
      const addr  = wallet.address
      const vers  = await Promise.all(
        Array.from({ length: count }, (_, i) => i).map(async (i): Promise<HistVer> => {
          const res = (await contracts.registry.getStrategyVersion(
            addr, BigInt(i),
          )) as unknown as [unknown[], bigint]
          return {
            versionId: i,
            createdAt: res[1],
            allocs:    (res[0] as unknown[]).map(parseAlloc),
            expanded:  false,
          }
        }),
      )
      setHistory([...vers].reverse())
    } catch (e) {
      setHistory([])
      console.warn('[history fetch]', e)
    } finally {
      setHistoryLoading(false)
    }
  }, [contracts, wallet.address, notify])

  const fetchEarnings = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const raw = (await contracts.feeRouter.traderEarnings(wallet.address)) as bigint
      setEarnings(raw)
    } catch (e) {
      console.error('[earnings fetch]', e)
    }
  }, [contracts, wallet.address])

  useEffect(() => {
    void fetchTrader()
    void fetchHistory()
    void fetchEarnings()
  }, [fetchTrader, fetchHistory, fetchEarnings])

  // ── Row management ────────────────────────────────────────────────────────
  const addRow = () => {
    const uid = uidRef.current++
    setRows(prev => [
      ...prev,
      { uid, asset: ASSET_IDS.sBTC, isLong: true, leverage: 1, weight: '' },
    ])
  }

  const removeRow = (uid: number) =>
    setRows(prev => prev.filter(r => r.uid !== uid))

  const updateRow = (uid: number, patch: Partial<Omit<AllocRow, 'uid'>>) =>
    setRows(prev => prev.map(r => r.uid === uid ? { ...r, ...patch } : r))

  // ── Derived ────────────────────────────────────────────────────────────────
  const totalBps = rows.reduce((sum, r) => {
    const pct = parseFloat(r.weight || '0')
    return sum + (isNaN(pct) ? 0 : Math.round(pct * 100))
  }, 0)

  const hasDup    = new Set(rows.map(r => r.asset)).size !== rows.length
  const weightOk  = totalBps === 10_000
  const stakeOk   = eligible !== false   // null = not loaded / not deployed → allow
  const canPublish = weightOk && !hasDup && rows.length > 0 && traderInfo?.isRegistered === true && stakeOk

  // Auto-fix: distribute remainder to last row
  const autoFix = () => {
    if (rows.length === 0) return
    const others = rows.slice(0, -1).reduce((s, r) => {
      const pct = parseFloat(r.weight || '0')
      return s + (isNaN(pct) ? 0 : Math.round(pct * 100))
    }, 0)
    const target = (10_000 - others) / 100
    if (target > 0 && target <= 100) {
      const last = rows[rows.length - 1]
      updateRow(last.uid, { weight: target.toFixed(2) })
    }
  }

  // ── Transactions ──────────────────────────────────────────────────────────
  const doRegister = async () => {
    if (!contracts || !nameInput.trim()) return
    setLoad('register', true)
    try {
      const tx = asTx(await contracts.registry.registerTrader(nameInput.trim()))
      await tx.wait()
      notify('Registered as trader ✓', true, tx.hash)
      setNameInput('')
      await fetchTrader()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('register', false) }
  }

  const doPublish = async () => {
    if (!contracts || !canPublish) return
    const allocs = rows.map(r => ({
      asset:    r.asset,
      weight:   BigInt(Math.round(parseFloat(r.weight) * 100)),
      isLong:   r.isLong,
      leverage: BigInt(r.leverage),
    }))
    setLoad('publish', true)
    try {
      const tx = asTx(await contracts.registry.publishStrategy(allocs))
      await tx.wait()
      notify('Strategy published ✓', true, tx.hash)
      setRows([])
      await fetchHistory()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('publish', false) }
  }

  const doClaim = async () => {
    if (!contracts) return
    setLoad('claim', true)
    try {
      const tx = asTx(await contracts.feeRouter.withdrawTraderEarnings())
      await tx.wait()
      notify('Earnings claimed ✓', true, tx.hash)
      await fetchEarnings()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setLoad('claim', false) }
  }

  const toggleExpand = (versionId: number) =>
    setHistory(prev =>
      prev.map(v => v.versionId === versionId ? { ...v, expanded: !v.expanded } : v),
    )

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">Connect wallet to access Trader Dashboard.</Typography>
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

      {/* ─── Personal Profile Header (Only shown if registered) ─── */}
      {traderInfo?.isRegistered && (
        <Card sx={{ p: 3, display: 'flex', flexDirection: 'row', gap: 3, alignItems: 'center' }}>
          <Avatar
            src={getPepeAvatar(stakeData ? stakeData.reputation : null, wallet.address || '')}
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
                    {traderInfo.displayName}
                  </Typography>
                  <TraderRankBadge reputation={stakeData ? stakeData.reputation : null} />
                </Stack>
                <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary', display: 'block', mt: 0.5 }}>
                  {wallet.address}
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
                    {(Number(stakeData.stake) / 1e18).toFixed(0)} mUSDC staked
                  </Typography>
                </Box>
              )}
            </Box>
          </Box>
        </Card>
      )}

      {/* ─── A. Register ────────────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
          Register Trader
        </Typography>

        {traderInfo?.isRegistered ? (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
            <Chip
              label={`✓ ${traderInfo.displayName}`}
              color="success"
              sx={{ fontWeight: 'bold' }}
            />
            <Typography variant="caption" color="text.secondary">
              Registered as public trader
            </Typography>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', gap: 1.5 }}>
            <TextField
              placeholder="Display name (e.g. AlphaTrader)"
              value={nameInput}
              onChange={e => setNameInput(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void doRegister() }}
              size="small"
              sx={{ flexGrow: 1 }}
            />
            <Button
              variant="contained"
              onClick={() => void doRegister()}
              disabled={busy['register'] || !nameInput.trim()}
            >
              {busy['register'] ? '…' : 'Register'}
            </Button>
          </Box>
        )}
      </Card>

      {/* ─── B. Publish Strategy ──────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
            Publish Strategy
          </Typography>
          <Button
            variant="text"
            onClick={addRow}
            sx={{ textTransform: 'none', fontWeight: 'bold' }}
          >
            + Add Asset
          </Button>
        </Box>

        {eligible === false && (
          <Alert severity="warning" action={
            <Button
              color="inherit"
              size="small"
              component={RouterLink}
              to="/stake"
              sx={{ fontWeight: 'bold' }}
            >
              Go to Trader Stake →
            </Button>
          }>
            <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
              Stake required to publish
            </Typography>
            You need to stake at least 100 mUSDC before publishing a strategy. This gives followers confidence that you have skin-in-the-game.
          </Alert>
        )}

        {rows.length === 0 ? (
          <Typography color="text.secondary" sx={{ py: 1 }}>
            Click "+ Add Asset" to define allocations.
          </Typography>
        ) : (
          <>
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 'bold' }}>Asset</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 'bold' }}>Direction</TableCell>
                    <TableCell sx={{ color: 'text.secondary', fontWeight: 'bold' }}>Leverage</TableCell>
                    <TableCell align="right" sx={{ color: 'text.secondary', fontWeight: 'bold' }}>Weight %</TableCell>
                    <TableCell />
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map(row => {
                    const isDup = rows.filter(r => r.asset === row.asset).length > 1
                    return (
                      <TableRow key={row.uid} hover sx={{ opacity: isDup ? 0.8 : 1 }}>
                        <TableCell sx={{ minWidth: 150 }}>
                          <Select
                            size="small"
                            value={row.asset}
                            onChange={e => updateRow(row.uid, { asset: e.target.value as AssetId })}
                            error={isDup}
                            fullWidth
                          >
                            {ASSETS.map(a => (
                              <MenuItem key={a.id} value={a.id}>
                                {a.regulated ? '🔒 ' : ''}{a.symbol}
                              </MenuItem>
                            ))}
                          </Select>
                        </TableCell>

                        <TableCell sx={{ minWidth: 160 }}>
                          <Box sx={{ display: 'flex', borderRadius: 1, border: '1px solid', borderColor: 'divider', overflow: 'hidden', height: 40 }}>
                            <Button
                              onClick={() => updateRow(row.uid, { isLong: true })}
                              sx={{
                                flexGrow: 1,
                                borderRadius: 0,
                                textTransform: 'none',
                                fontWeight: 'bold',
                                fontSize: '0.75rem',
                                bgcolor: row.isLong ? 'success.main' : 'transparent',
                                color: row.isLong ? 'success.contrastText' : 'text.secondary',
                                '&:hover': { bgcolor: row.isLong ? 'success.dark' : 'action.hover' }
                              }}
                            >
                              Long ↑
                            </Button>
                            <Button
                              onClick={() => updateRow(row.uid, { isLong: false })}
                              sx={{
                                flexGrow: 1,
                                borderRadius: 0,
                                textTransform: 'none',
                                fontWeight: 'bold',
                                fontSize: '0.75rem',
                                bgcolor: !row.isLong ? 'error.main' : 'transparent',
                                color: !row.isLong ? 'error.contrastText' : 'text.secondary',
                                '&:hover': { bgcolor: !row.isLong ? 'error.dark' : 'action.hover' }
                              }}
                            >
                              Short ↓
                            </Button>
                          </Box>
                        </TableCell>

                        <TableCell sx={{ minWidth: 90 }}>
                          <Select
                            size="small"
                            value={row.leverage}
                            onChange={e => updateRow(row.uid, { leverage: Number(e.target.value) })}
                            fullWidth
                          >
                            {[1, 2, 5].map(lv => (
                              <MenuItem key={lv} value={lv}>{lv}×</MenuItem>
                            ))}
                          </Select>
                        </TableCell>

                        <TableCell align="right" sx={{ minWidth: 100 }}>
                          <TextField
                            type="number"
                            size="small"
                            placeholder="0"
                            value={row.weight}
                            onChange={e => updateRow(row.uid, { weight: e.target.value })}
                            slotProps={{ htmlInput: { min: "0", max: "100", step: "0.01", style: { textAlign: 'right', fontFamily: 'monospace' } } }}
                          />
                        </TableCell>

                        <TableCell align="right" sx={{ width: 40 }}>
                          <Button
                            color="error"
                            onClick={() => removeRow(row.uid)}
                            sx={{ minWidth: 0, p: 1, borderRadius: 1 }}
                          >
                            ×
                          </Button>
                        </TableCell>
                      </TableRow>
                    )
                  })}
                </TableBody>
              </Table>
            </TableContainer>

            {hasDup && (
              <Typography variant="caption" color="error.main">
                Each asset can only appear once per strategy. Remove the duplicate.
              </Typography>
            )}

            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <Box sx={{ flexGrow: 1, bgcolor: 'background.neutral', borderRadius: 1, height: 8, overflow: 'hidden' }}>
                <Box
                  sx={{
                    bgcolor: weightOk ? 'success.main' : 'warning.main',
                    height: '100%',
                    borderRadius: 1,
                    width: `${Math.min(totalBps / 100, 100)}%`,
                    transition: 'width 0.3s'
                  }}
                />
              </Box>
              <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: weightOk ? 'success.main' : 'warning.main', w: 60, textRight: 'right' }}>
                {(totalBps / 100).toFixed(2)}%
              </Typography>
              {!weightOk && (
                <Typography variant="caption" color="text.secondary">
                  {totalBps > 10000 ? 'exceeds' : 'must reach'} 100%
                </Typography>
              )}
              {!weightOk && rows.length > 0 && totalBps > 9000 && totalBps < 11000 && (
                <Button
                  size="small"
                  onClick={autoFix}
                  sx={{ textTransform: 'none', textDecoration: 'underline', color: 'success.main', minWidth: 0, p: 0 }}
                >
                  Auto-fix to 100%
                </Button>
              )}
            </Box>
          </>
        )}

        <Button
          variant="contained"
          color="secondary"
          onClick={() => void doPublish()}
          disabled={busy['publish'] || !canPublish}
          fullWidth
        >
          {busy['publish'] ? 'Publishing…' : 'Publish Strategy'}
        </Button>

        {!traderInfo?.isRegistered && (
          <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block' }}>
            Register as a trader first to publish.
          </Typography>
        )}
        {traderInfo?.isRegistered && eligible === false && (
          <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block' }}>
            Stake ≥ 100 mUSDC on the <Link component={RouterLink} to="/stake" color="primary.main">Stake page</Link> to unlock publishing.
          </Typography>
        )}
      </Card>

      {/* ─── C. Fee Earnings ─────────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
            Fee Earnings
          </Typography>
          <Button
            variant="text"
            size="small"
            onClick={() => void fetchEarnings()}
            sx={{ textTransform: 'none' }}
          >
            ↺ Refresh
          </Button>
        </Box>

        <Card sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', bgcolor: 'background.neutral' }}>
          <Box>
            <Typography variant="caption" color="text.secondary">
              Claimable (copy + perf fees)
            </Typography>
            <Typography variant="h5" color="success.main" sx={{ fontFamily: 'monospace', fontWeight: 'bold', display: 'flex', alignItems: 'baseline' }}>
              {earnings === null ? '…' : (Number(earnings) / 1e18).toFixed(4)}
              <Box component="span" sx={{ fontSize: '0.75rem', fontWeight: 'normal', color: 'text.secondary', ml: 0.5 }}>
                mUSDC
              </Box>
            </Typography>
          </Box>
          <Button
            variant="contained"
            color="success"
            onClick={() => void doClaim()}
            disabled={busy['claim'] || !earnings || earnings === 0n}
          >
            {busy['claim'] ? 'Claiming…' : 'Claim All'}
          </Button>
        </Card>

        <Typography variant="caption" color="text.secondary">
          Earnings accrue when followers pay the 0.3% copy fee or close copied positions in profit (10% performance fee). Your share is 70% of each fee.
        </Typography>
      </Card>

      {/* ─── D. Strategy History ──────────────────────────────────────── */}
      <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
            Strategy History
          </Typography>
          <Button
            variant="text"
            size="small"
            onClick={() => void fetchHistory()}
            sx={{ textTransform: 'none' }}
          >
            ↺ Refresh
          </Button>
        </Box>

        {historyLoading ? (
          <TableSkeleton rows={3} cols={4} />
        ) : history.length === 0 ? (
          <Typography color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
            No strategies published yet.
          </Typography>
        ) : (
          <Stack spacing={1.5}>
            {history.map(ver => (
              <Card key={ver.versionId} sx={{ border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
                <Box
                  component="button"
                  onClick={() => toggleExpand(ver.versionId)}
                  sx={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    px: 2,
                    py: 1.5,
                    bgcolor: 'transparent',
                    border: 0,
                    cursor: 'pointer',
                    textAlign: 'left',
                    '&:hover': { bgcolor: 'action.hover' }
                  }}
                >
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, minWidth: 0, flexGrow: 1 }}>
                    <Typography variant="caption" sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                      v{ver.versionId}
                    </Typography>
                    <Typography variant="body2" sx={{ fontWeight: 'bold', color: 'text.primary', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {ver.allocs.map(a =>
                        `${ASSET_LABEL[a.asset] ?? a.asset.slice(0, 6)} ${a.isLong ? 'L' : 'S'} ${String(a.leverage)}×`,
                      ).join('  ·  ')}
                    </Typography>
                  </Box>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, ml: 2, shrink: 0 }}>
                    <Typography variant="caption" color="text.secondary">
                      {fmtDate(ver.createdAt)}
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      {ver.expanded ? '▲' : '▼'}
                    </Typography>
                  </Box>
                </Box>

                {ver.expanded && (
                  <Box sx={{ borderTop: '1px solid', borderColor: 'divider', bgcolor: 'background.neutral', px: 2, py: 1.5 }}>
                    <TableContainer>
                      <Table size="small">
                        <TableHead>
                          <TableRow>
                            {['Asset', 'Side', 'Leverage', 'Weight'].map(h => (
                              <TableCell key={h} sx={{ color: 'text.secondary', fontWeight: 'bold' }}>{h}</TableCell>
                            ))}
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {ver.allocs.map((a, idx) => (
                            <TableRow key={idx}>
                              <TableCell sx={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'text.primary' }}>
                                {ASSET_LABEL[a.asset] ?? a.asset.slice(0, 8)}
                              </TableCell>
                              <TableCell sx={{ fontWeight: 'bold', color: a.isLong ? 'success.main' : 'error.main' }}>
                                {a.isLong ? 'Long ↑' : 'Short ↓'}
                              </TableCell>
                              <TableCell sx={{ fontFamily: 'monospace' }}>{String(a.leverage)}×</TableCell>
                              <TableCell align="right" sx={{ fontFamily: 'monospace', fontWeight: 'bold' }}>
                                {fmtPct(a.weight)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  </Box>
                )}
              </Card>
            ))}
          </Stack>
        )}
      </Card>
    </Container>
  )
}
