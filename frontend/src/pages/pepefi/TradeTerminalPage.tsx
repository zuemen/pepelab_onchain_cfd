import { useState, useEffect, useCallback, useMemo } from 'react'
import { parseEther } from 'ethers'
import { AreaChart, Area, YAxis, ResponsiveContainer, Tooltip } from 'recharts'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'
import Snackbar from '@mui/material/Snackbar'

import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { useLivePrices } from 'src/hooks/useLivePrices'
import { useFundingData } from 'src/hooks/useFundingData'
import { useKYC } from 'src/hooks/useKYC'
import { ASSET_IDS } from 'src/contracts/addresses'
import { ASSETS_LIST, ASSET_META } from 'src/lib/pepefi/assetMeta'
import { prettyError } from 'src/lib/pepefi/errorMessages'

// ── terminal palette (forced dark, Hyperliquid-grade, Pepe-green) ──────────────
const C = {
  bg: '#080b09', panel: '#0d1210', panel2: '#10160f',
  line: 'rgba(255,255,255,.07)', line2: 'rgba(199,249,78,.16)',
  ink: '#e9f0e4', mut: '#7e8c7b',
  green: '#3fd98a', greenDim: 'rgba(63,217,138,.14)',
  red: '#ff5d5d', redDim: 'rgba(255,93,93,.14)',
  lime: '#c7f94e',
  mono: '"JetBrains Mono", ui-monospace, monospace',
}

type AssetId = `0x${string}`
interface RawPos { asset: string; isLong: boolean; isOpen: boolean; entryPrice: bigint; margin: bigint; leverage: bigint }
interface Pos { id: bigint; asset: string; isLong: boolean; entryPrice: bigint; margin: bigint; leverage: bigint; pnl: bigint; cur: bigint }
type TxResp = { wait(): Promise<unknown>; hash: string }
const asTx = (t: unknown) => t as TxResp

const f18 = (v: bigint, d = 2) => (Number(v) / 1e18).toFixed(d)
const fUsd = (v: bigint) => '$' + (Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const tryParse = (s: string): bigint | null => { try { return s ? parseEther(s) : null } catch { return null } }

export default function TradeTerminalPage() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const live = useLivePrices()
  const funding = useFundingData(contracts?.exchange ?? null)

  const [selAsset, setSelAsset] = useState<AssetId>(ASSET_IDS.sBTC)
  const [isLong, setIsLong] = useState(true)
  const [lev, setLev] = useState(2)
  const [margin, setMargin] = useState('')
  const [dep, setDep] = useState('')
  const [freeMgn, setFreeMgn] = useState(0n)
  const [usdcBal, setUsdcBal] = useState(0n)
  const [curPrice, setCurPrice] = useState(0n)
  const [positions, setPositions] = useState<Pos[]>([])
  const [hist, setHist] = useState<{ t: number; p: number }[]>([])
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  const { isVerified: kycOk } = useKYC(contracts?.kycRegistry ?? null, wallet.address ?? null)
  const meta = ASSET_META[selAsset]
  const kycBlocked = (meta?.regulated ?? false) && !kycOk

  const setL = (k: string, v: boolean) => setBusy(p => ({ ...p, [k]: v }))
  const notify = useCallback((msg: string, ok: boolean) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 5000) }, [])

  const fetchAll = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const [bal, mgn] = await Promise.all([
        contracts.usdc.balanceOf(wallet.address) as Promise<bigint>,
        contracts.exchange.freeMargin(wallet.address) as Promise<bigint>,
      ])
      setUsdcBal(bal); setFreeMgn(mgn)
      const ids = (await contracts.exchange.getUserPositions(wallet.address)) as bigint[]
      const rows = await Promise.all(ids.map(async (id): Promise<Pos | null> => {
        try {
          const raw = (await contracts.exchange.getPosition(id)) as unknown as RawPos
          if (!raw.isOpen) return null
          const pnl = (await contracts.exchange.getUnrealizedPnL(id)) as bigint
          const pr = (await contracts.oracle.getPrice(raw.asset)) as unknown as [bigint, bigint]
          return { id, asset: raw.asset, isLong: raw.isLong, entryPrice: raw.entryPrice, margin: raw.margin, leverage: raw.leverage, pnl, cur: pr[0] * 10n ** 10n }
        } catch { return null }
      }))
      setPositions(rows.filter((r): r is Pos => r !== null))
    } catch (e) { console.error(e) }
  }, [contracts, wallet.address])

  useEffect(() => { void fetchAll() }, [fetchAll])
  useEffect(() => {
    if (!contracts) return
    void (async () => {
      try { const pr = (await contracts.oracle.getPrice(selAsset)) as unknown as [bigint, bigint]; setCurPrice(pr[0] * 10n ** 10n) } catch { /* */ }
    })()
  }, [contracts, selAsset])
  useEffect(() => { setHist([]) }, [selAsset])
  useEffect(() => {
    const p = live[selAsset]?.usd
    if (p !== undefined) setHist(prev => [...prev, { t: Date.now(), p }].slice(-48))
  }, [live[selAsset]?.usd, selAsset])

  // live PnL recompute against live price
  const livePositions = useMemo(() => positions.map(p => {
    const lp = live[p.asset as AssetId]?.usd
    const cur = lp ? BigInt(Math.round(lp * 1e8)) * 10n ** 10n : p.cur
    const size = p.entryPrice > 0n ? (p.margin * p.leverage * 10n ** 18n) / p.entryPrice : 0n
    let pnl = ((cur - p.entryPrice) * size) / 10n ** 18n
    if (!p.isLong) pnl = -pnl
    return { ...p, cur, livePnl: pnl }
  }), [positions, live])

  const totalPnl = livePositions.reduce((a, p) => a + p.livePnl, 0n)
  const equity = freeMgn + totalPnl
  const marginBig = tryParse(margin)
  const notional = marginBig ? marginBig * BigInt(lev) : 0n
  const liq = curPrice > 0n ? (isLong ? curPrice - curPrice / BigInt(lev) : curPrice + curPrice / BigInt(lev)) : 0n
  const fi = funding[selAsset]
  const rate = fi ? Number(fi.rate) : 0
  const livePx = live[selAsset]?.usd
  const chg = hist.length > 1 ? ((hist[hist.length - 1].p - hist[0].p) / hist[0].p) * 100 : 0

  // ── tx ──
  const openPosition = async () => {
    if (!contracts) return
    const amt = tryParse(margin)
    if (!amt) return notify('Enter margin', false)
    if (amt > freeMgn) return notify('Insufficient free margin — deposit first', false)
    setL('open', true)
    try {
      const tx = asTx(await contracts.exchange.openPosition(selAsset, isLong, amt, BigInt(lev), { value: parseEther('0.001') }))
      await tx.wait(); notify(`${isLong ? 'Long' : 'Short'} ${meta?.symbol} opened ✓`, true); setMargin(''); await fetchAll()
    } catch (e) { notify(prettyError(e), false) } finally { setL('open', false) }
  }
  const closePos = async (id: bigint) => {
    if (!contracts) return
    const k = `c_${id}`; setL(k, true)
    try { const tx = asTx(await contracts.exchange.closePosition(id)); await tx.wait(); notify('Closed ✓', true); await fetchAll() }
    catch (e) { notify(prettyError(e), false) } finally { setL(k, false) }
  }
  const deposit = async () => {
    if (!contracts) return
    const amt = tryParse(dep)
    if (!amt) return notify('Enter amount', false)
    setL('dep', true)
    try {
      const a = asTx(await contracts.usdc.approve(String(contracts.exchange.target), amt)); await a.wait()
      const d = asTx(await contracts.exchange.depositMargin(amt)); await d.wait()
      notify(`Deposited ${dep} USDC ✓`, true); setDep(''); await fetchAll()
    } catch (e) { notify(prettyError(e), false) } finally { setL('dep', false) }
  }

  if (!wallet.isConnected) {
    return <Box sx={{ minHeight: '70vh', display: 'grid', placeItems: 'center', bgcolor: C.bg, color: C.mut }}>Connect wallet to open the terminal.</Box>
  }

  // ── styled atoms ──
  const panel = { bgcolor: C.panel, border: `1px solid ${C.line}`, borderRadius: '12px' }
  const labelCss = { color: C.mut, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase' as const, fontWeight: 700 }
  const monoCss = { fontFamily: C.mono }

  return (
    <Box sx={{ bgcolor: C.bg, color: C.ink, minHeight: '100vh', p: { xs: 1.5, md: 2.5 }, fontFamily: '"Satoshi", system-ui, sans-serif' }}>
      <Snackbar open={!!toast} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
        <Box sx={{ ...panel, px: 2, py: 1.2, borderColor: toast?.ok ? C.line2 : C.redDim, bgcolor: C.panel2, ...monoCss, fontSize: 13, color: toast?.ok ? C.green : C.red }}>
          {toast?.msg}
        </Box>
      </Snackbar>

      {/* asset tab strip */}
      <Box sx={{ display: 'flex', gap: 0.5, overflowX: 'auto', pb: 1, mb: 1.5, '&::-webkit-scrollbar': { height: 0 } }}>
        {ASSETS_LIST.map(a => {
          const on = a.id === selAsset
          return (
            <Box key={a.id} onClick={() => setSelAsset(a.id as AssetId)}
              sx={{ cursor: 'pointer', px: 1.6, py: 0.8, borderRadius: '9px', whiteSpace: 'nowrap', ...monoCss, fontSize: 13, fontWeight: 700,
                bgcolor: on ? C.lime : 'transparent', color: on ? '#0a0d07' : C.mut,
                border: `1px solid ${on ? C.lime : C.line}`, transition: '.15s',
                '&:hover': { color: on ? '#0a0d07' : C.ink, borderColor: on ? C.lime : C.line2 } }}>
              {a.regulated ? '🔒 ' : ''}{a.symbol}
            </Box>
          )
        })}
      </Box>

      {/* market bar */}
      <Box sx={{ ...panel, p: 2, mb: 1.5, display: 'flex', alignItems: 'center', gap: { xs: 2.5, md: 5 }, flexWrap: 'wrap' }}>
        <Box>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
            <Box sx={{ fontFamily: '"Clash Display", sans-serif', fontWeight: 600, fontSize: 22 }}>{meta?.symbol}<span style={{ color: C.mut, fontSize: 13 }}>-PERP</span></Box>
          </Box>
          <Box sx={{ ...labelCss, mt: 0.3 }}>{meta?.name}</Box>
        </Box>
        <Box>
          <Box sx={{ ...monoCss, fontSize: 26, fontWeight: 700 }}>{livePx ? '$' + livePx.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : fUsd(curPrice)}</Box>
          <Box sx={{ ...monoCss, fontSize: 13, color: chg >= 0 ? C.green : C.red }}>{chg >= 0 ? '▲' : '▼'} {Math.abs(chg).toFixed(2)}%</Box>
        </Box>
        <Stat label="Oracle (mark)" v={fUsd(curPrice)} />
        <Stat label="Funding" v={`${rate >= 0 ? '+' : ''}${(rate / 100).toFixed(4)}%`} color={rate > 0 ? C.red : rate < 0 ? C.green : C.mut} />
        <Stat label="Open interest L/S" v={fi ? `${(Number(fi.longOI) / 1e18).toFixed(1)} / ${(Number(fi.shortOI) / 1e18).toFixed(1)}` : '—'} />
        <Box sx={{ ml: 'auto', ...labelCss, color: live[selAsset]?.isMock ? C.mut : C.green }}>● {live[selAsset]?.isMock ? 'simulated feed' : 'live feed'}</Box>
      </Box>

      {/* chart + ticket */}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 340px' }, gap: 1.5 }}>
        {/* chart */}
        <Box sx={{ ...panel, p: 2, minHeight: 380, display: 'flex', flexDirection: 'column' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
            <Box sx={labelCss}>Price · live</Box>
            <Box sx={{ ...monoCss, fontSize: 12, color: C.mut }}>{hist.length} ticks</Box>
          </Box>
          <Box sx={{ flex: 1, minHeight: 320 }}>
            {hist.length > 1 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hist} margin={{ top: 8, right: 4, bottom: 0, left: 0 }}>
                  <defs>
                    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={C.green} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={C.green} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <YAxis domain={['dataMin', 'dataMax']} hide />
                  <Tooltip
                    contentStyle={{ background: C.panel2, border: `1px solid ${C.line}`, borderRadius: 8, fontFamily: C.mono, fontSize: 12, color: C.ink }}
                    labelFormatter={() => ''} formatter={(v) => ['$' + Number(v).toLocaleString(), 'price']} />
                  <Area type="monotone" dataKey="p" stroke={C.green} strokeWidth={2} fill="url(#g)" isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <Box sx={{ height: '100%', display: 'grid', placeItems: 'center', color: C.mut, ...monoCss, fontSize: 13 }}>collecting live ticks…</Box>
            )}
          </Box>
        </Box>

        {/* order ticket */}
        <Box sx={{ ...panel, p: 2, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          {/* long / short */}
          <Box sx={{ display: 'flex', gap: 0.8 }}>
            {[['LONG', true], ['SHORT', false]].map(([t, v]) => {
              const on = isLong === v
              const col = v ? C.green : C.red
              return (
                <Box key={t as string} onClick={() => setIsLong(v as boolean)}
                  sx={{ flex: 1, textAlign: 'center', py: 1.1, borderRadius: '9px', cursor: 'pointer', fontWeight: 800, fontSize: 14,
                    bgcolor: on ? (v ? C.greenDim : C.redDim) : 'transparent', color: on ? col : C.mut,
                    border: `1px solid ${on ? col : C.line}`, transition: '.15s' }}>
                  {t as string} {v ? '↑' : '↓'}
                </Box>
              )
            })}
          </Box>

          {/* leverage */}
          <Box>
            <Box sx={{ ...labelCss, mb: 0.7 }}>Leverage</Box>
            <Box sx={{ display: 'flex', gap: 0.8 }}>
              {[1, 2, 5].map(l => {
                const on = lev === l
                return (
                  <Box key={l} onClick={() => setLev(l)}
                    sx={{ flex: 1, textAlign: 'center', py: 0.9, borderRadius: '8px', cursor: 'pointer', ...monoCss, fontWeight: 700, fontSize: 13,
                      bgcolor: on ? C.lime : 'transparent', color: on ? '#0a0d07' : C.mut, border: `1px solid ${on ? C.lime : C.line}` }}>
                    {l}×
                  </Box>
                )
              })}
            </Box>
          </Box>

          {/* margin input */}
          <Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.7 }}>
              <Box sx={labelCss}>Margin</Box>
              <Box sx={{ ...monoCss, fontSize: 11, color: C.mut, cursor: 'pointer' }} onClick={() => setMargin(f18(freeMgn))}>free: {f18(freeMgn)}</Box>
            </Box>
            <Box sx={{ display: 'flex', alignItems: 'center', ...panel, bgcolor: C.panel2, px: 1.5, py: 1 }}>
              <input value={margin} onChange={e => setMargin(e.target.value)} type="number" placeholder="0.00"
                style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: C.ink, fontFamily: C.mono, fontWeight: 700, fontSize: 20, width: '100%' }} />
              <Box sx={{ ...monoCss, color: C.mut, fontSize: 13 }}>USDC</Box>
            </Box>
          </Box>

          {/* quote rows */}
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.6, py: 0.5 }}>
            <Row k="Notional" v={`${f18(notional)} USDC`} />
            <Row k="Entry (oracle)" v={fUsd(curPrice)} />
            <Row k="Est. liquidation" v={fUsd(liq)} color={C.red} />
            <Row k="Funding (8h)" v={`${rate >= 0 ? '+' : ''}${(rate / 100).toFixed(4)}%`} color={rate > 0 ? C.red : rate < 0 ? C.green : C.mut} />
          </Box>

          {kycBlocked && <Box sx={{ ...monoCss, fontSize: 11.5, color: C.lime, ...panel, borderColor: C.line2, p: 1 }}>🔒 {meta?.symbol} 需 KYC，請至 Exchange 頁完成驗證</Box>}

          <Button onClick={() => void openPosition()}
            disabled={busy.open || !margin || (marginBig !== null && marginBig > freeMgn) || kycBlocked}
            sx={{ py: 1.4, borderRadius: '10px', fontWeight: 800, fontSize: 15, textTransform: 'none',
              bgcolor: isLong ? C.green : C.red, color: '#06120c',
              '&:hover': { bgcolor: isLong ? C.green : C.red, filter: 'brightness(1.08)' },
              '&.Mui-disabled': { bgcolor: 'rgba(255,255,255,.05)', color: C.mut } }}>
            {busy.open ? 'Opening…' : marginBig !== null && marginBig > freeMgn ? 'Insufficient margin' : `Open ${isLong ? 'Long' : 'Short'} ${meta?.symbol ?? ''}`}
          </Button>

          {/* account */}
          <Box sx={{ borderTop: `1px solid ${C.line}`, pt: 1.5, mt: 0.5, display: 'flex', flexDirection: 'column', gap: 0.6 }}>
            <Row k="Equity" v={fUsd(equity)} strong />
            <Row k="Free margin" v={`${f18(freeMgn)} USDC`} />
            <Row k="Unrealized PnL" v={`${Number(totalPnl) >= 0 ? '+' : ''}${f18(totalPnl, 4)}`} color={Number(totalPnl) >= 0 ? C.green : C.red} />
            <Row k="Wallet USDC" v={f18(usdcBal)} />
            <Box sx={{ display: 'flex', gap: 0.8, mt: 0.8 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', flex: 1, ...panel, bgcolor: C.panel2, px: 1.2 }}>
                <input value={dep} onChange={e => setDep(e.target.value)} type="number" placeholder="deposit"
                  style={{ flex: 1, background: 'transparent', border: 'none', outline: 'none', color: C.ink, fontFamily: C.mono, fontSize: 13, width: '100%', padding: '8px 0' }} />
              </Box>
              <Button onClick={() => void deposit()} disabled={busy.dep}
                sx={{ ...monoCss, fontSize: 12, fontWeight: 700, textTransform: 'none', px: 1.6, borderRadius: '9px',
                  bgcolor: C.lime, color: '#0a0d07', '&:hover': { bgcolor: C.lime, filter: 'brightness(1.06)' }, '&.Mui-disabled': { bgcolor: 'rgba(255,255,255,.05)', color: C.mut } }}>
                {busy.dep ? '…' : 'Deposit'}
              </Button>
            </Box>
          </Box>
        </Box>
      </Box>

      {/* positions */}
      <Box sx={{ ...panel, mt: 1.5 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', p: 2, pb: 1.5 }}>
          <Box sx={labelCss}>Open positions ({livePositions.length})</Box>
          <Box onClick={() => void fetchAll()} sx={{ ...monoCss, fontSize: 12, color: C.mut, cursor: 'pointer', '&:hover': { color: C.ink } }}>↺ refresh</Box>
        </Box>
        <Box sx={{ overflowX: 'auto' }}>
          <Box sx={{ minWidth: 720 }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: '1fr .7fr 1fr 1fr 1fr .6fr 1.1fr .9fr', px: 2, py: 1, ...labelCss, borderTop: `1px solid ${C.line}`, borderBottom: `1px solid ${C.line}` }}>
              {['Asset', 'Side', 'Entry', 'Mark', 'Margin', 'Lev', 'PnL', ''].map(h => <Box key={h}>{h}</Box>)}
            </Box>
            {livePositions.length === 0 ? (
              <Box sx={{ p: 4, textAlign: 'center', color: C.mut, ...monoCss, fontSize: 13 }}>no open positions</Box>
            ) : livePositions.map(p => {
              const sym = ASSET_META[p.asset]?.symbol ?? p.asset.slice(0, 8)
              return (
                <Box key={String(p.id)} sx={{ display: 'grid', gridTemplateColumns: '1fr .7fr 1fr 1fr 1fr .6fr 1.1fr .9fr', px: 2, py: 1.3, alignItems: 'center', borderBottom: `1px solid ${C.line}`, ...monoCss, fontSize: 13, '&:hover': { bgcolor: 'rgba(255,255,255,.02)' } }}>
                  <Box sx={{ fontWeight: 700 }}>{sym}</Box>
                  <Box sx={{ color: p.isLong ? C.green : C.red, fontWeight: 700 }}>{p.isLong ? 'LONG' : 'SHORT'}</Box>
                  <Box>{fUsd(p.entryPrice)}</Box>
                  <Box>{fUsd(p.cur)}</Box>
                  <Box>{f18(p.margin)}</Box>
                  <Box>{String(p.leverage)}×</Box>
                  <Box sx={{ color: Number(p.livePnl) >= 0 ? C.green : C.red, fontWeight: 700 }}>{Number(p.livePnl) >= 0 ? '+' : ''}{f18(p.livePnl, 4)}</Box>
                  <Box>
                    <Button onClick={() => void closePos(p.id)} disabled={busy[`c_${p.id}`]}
                      sx={{ ...monoCss, fontSize: 11.5, fontWeight: 700, textTransform: 'none', py: 0.4, px: 1.4, borderRadius: '7px', color: C.ink, border: `1px solid ${C.line}`, '&:hover': { borderColor: C.red, color: C.red, bgcolor: C.redDim } }}>
                      {busy[`c_${p.id}`] ? '…' : 'Close'}
                    </Button>
                  </Box>
                </Box>
              )
            })}
          </Box>
        </Box>
      </Box>
    </Box>
  )
}

// ── small presentational helpers ──
function Stat({ label, v, color }: { label: string; v: string; color?: string }) {
  return (
    <Box>
      <Box sx={{ color: C.mut, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', fontWeight: 700 }}>{label}</Box>
      <Box sx={{ fontFamily: C.mono, fontSize: 14, fontWeight: 700, color: color ?? C.ink, mt: 0.3 }}>{v}</Box>
    </Box>
  )
}
function Row({ k, v, color, strong }: { k: string; v: string; color?: string; strong?: boolean }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <Box sx={{ color: C.mut, fontSize: 12.5 }}>{k}</Box>
      <Box sx={{ fontFamily: C.mono, fontSize: strong ? 15 : 13, fontWeight: strong ? 800 : 600, color: color ?? C.ink }}>{v}</Box>
    </Box>
  )
}
