import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react'
import { Contract, parseEther, type ContractTransactionResponse } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { useV2Contracts } from 'src/hooks/useV2Contracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { safeRead } from 'src/lib/pepefi/safeRead'
import { fNum, fUsd, fromUnits } from 'src/lib/pepefi/format'
import {
  ASSET_IDS, getAddresses, getSynthTokens, getV2Stack, type AssetSymbol,
} from 'src/contracts/addresses'
import { t, interpolate } from 'src/locales'
import { ASSET_META } from 'src/lib/pepefi/assetMeta'
import SyntheticAssetABI   from 'src/contracts/abi/SyntheticAsset.json'
import SyntheticAssetV2ABI from 'src/contracts/abi/SyntheticAssetV2.json'
import AssetIcon from 'src/components/pepefi/AssetIcon'
import { AssetProvenanceCard, WhoRunsWhat } from 'src/components/pepefi/AssetProvenance'
import TradingViewChart from 'src/components/pepefi/TradingViewChart'
import { SHOW_PERPETUALS } from 'src/lib/pepefi/featureFlags'
import Skeleton from 'src/components/pepefi/Skeleton'
import { useToast } from 'src/components/pepefi/ToastProvider'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import Chip from '@mui/material/Chip';
import Dialog from '@mui/material/Dialog';
import DialogTitle from '@mui/material/DialogTitle';
import DialogContent from '@mui/material/DialogContent';
import DialogActions from '@mui/material/DialogActions';
import TextField from '@mui/material/TextField';
import InputAdornment from '@mui/material/InputAdornment';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import Tooltip from '@mui/material/Tooltip';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Divider from '@mui/material/Divider';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import { Icon } from '@iconify/react';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

/**
 * 圖表能顯示哪些 symbol。刻意只有兩個、而且都是 Coinbase **現貨**：
 * 這一頁賣的是代幣化的現貨資產，掛一張永續合約的圖會自打嘴巴。
 */
const CHART_SYMBOLS = {
  btc: 'COINBASE:BTCUSD',
  eth: 'COINBASE:ETHUSD',
} as const
type ChartKey = keyof typeof CHART_SYMBOLS
const VERSION_KEY = 'pepefi:vaultVersion'

type VaultVersion = 'v1' | 'v2'

// These two were declared locally here (and again, slightly differently, on
// other pages) — which is the duplication lib/pepefi/format.ts exists to stop.
// The local fUsd also pinned 'en-US' on a Traditional Chinese interface; the
// shared one follows the user's locale. For zh-Hant the grouping and decimal
// separators are the same, so the rendered output does not change.
//
// f18 gains thousands separators, which toFixed did not produce: a balance now
// reads 1,234.5678 instead of 1234.5678.
const f18 = (v: bigint, d = 4) => fNum(fromUnits(v, 18), { dp: d })

// Contract methods come off a JSON ABI, so ethers types them loosely. Narrow to
// the transaction shape we actually use rather than casting through `any`.
const asTx = (t: unknown) => t as ContractTransactionResponse

interface Row {
  price:     bigint // 8-dec oracle price
  updatedAt: bigint // oracle updatedAt (sec) — #100: feeds the provenance card's freshness
  balance:   bigint // 18-dec token balance
  cap:       bigint // V2 only: per-asset issuance ceiling
  issued:    bigint // V2 only: currently outstanding
}

interface V2Health {
  reserveRatioBps: bigint | null
  paused:          boolean | null
  accruedFees:     bigint | null
  /**
   * #99: mirrors `ratioIsStale()` — true when at least one outstanding asset's
   * price could not be priced, which means the liability sum UNDER-counts and
   * `reserveRatioBps` reads optimistic. This is a VAULT-WIDE signal about
   * whether the ratio can be trusted, not a per-asset "this price is old" flag
   * — a single stale sBOND quote sets it even while sAAPL's own price is
   * perfectly fresh. It gates the reserve-ratio DISPLAY only; it must never
   * gate redeem, and it does not gate buy either (mint() prices the specific
   * asset itself and reverts StalePrice on its own if that one is old —
   * `mintingHalted` below is the only vault-wide gate on buy).
   */
  stale: boolean
  /**
   * #99 `AssetVaultV2_3.mintingHalted()`: latched by `observeReserve()` when a
   * snapshot found the reserve ratio under the operator's floor — including a
   * pure price move with nobody minting. Blocks NEW MINTS ONLY; false on a
   * pre-V2.3 proxy (the field does not exist there yet, so `reserveStatus()`
   * fails over to the individual-view fallback below).
   */
  mintingHalted: boolean
}

export default function TokenizedAssetsPage() {
  const wallet    = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const v2        = useV2Contracts(wallet.provider, wallet.signer, wallet.chainId)
  const addr      = getAddresses(wallet.chainId)

  const v2Available = !!getV2Stack(wallet.chainId)

  // Default to V2 where it exists: V1 is deployed bytecode that cannot be given
  // SafeERC20, so it stays reachable as a comparison case rather than the path
  // a new user lands on. An explicit stored choice always wins.
  const [version, setVersion] = useState<VaultVersion>(() => {
    try {
      const saved = localStorage.getItem(VERSION_KEY) as VaultVersion | null
      if (saved === 'v1' || saved === 'v2') return saved
    } catch { /* private mode */ }
    return getV2Stack(wallet.chainId) ? 'v2' : 'v1'
  })
  const switchVersion = (v: VaultVersion) => {
    setVersion(v)
    try { localStorage.setItem(VERSION_KEY, v) } catch { /* private mode */ }
  }

  // The initializer above runs before the wallet reports a chain, so a first
  // visitor would be stuck on V1 until they touched the switch. Promote once the
  // chain resolves — but never over an explicit stored choice.
  useEffect(() => {
    let stored: string | null = null
    try { stored = localStorage.getItem(VERSION_KEY) } catch { /* private mode */ }
    if (stored === 'v1' || stored === 'v2') return
    if (v2Available) setVersion('v2')
  }, [v2Available])

  // If the stored preference is v2 but this chain has no V2, fall back rather
  // than rendering an empty page.
  const isV2 = version === 'v2' && !!v2

  // One set of "active" handles so the logic below never branches on version.
  const activeTokens    = isV2 ? v2!.tokens : getSynthTokens(wallet.chainId)
  const activeVault     = isV2 ? v2!.vault  : contracts?.assetVault
  const activeVaultAddr = isV2 ? v2!.vaultAddr : addr?.AssetVault
  const activeOracle    = isV2 ? v2!.oracle : contracts?.oracle
  const activeTokenAbi  = isV2 ? SyntheticAssetV2ABI : SyntheticAssetABI

  const symbols = Object.keys(activeTokens) as AssetSymbol[]
  const vaultReady =
    !!activeVaultAddr && activeVaultAddr !== ZERO_ADDR && symbols.length > 0

  const [rows, setRows]       = useState<Record<string, Row>>({})
  const [health, setHealth]   = useState<V2Health>({
    reserveRatioBps: null, paused: null, accruedFees: null, stale: false, mintingHalted: false,
  })
  const [loading, setLoading] = useState(true)
  const [dlg, setDlg]         = useState<{ sym: AssetSymbol; mode: 'buy' | 'sell' } | null>(null)
  const [amount, setAmount]   = useState('')
  const [quote, setQuote]     = useState<{ out: bigint; fee: bigint } | null>(null)
  const [busy, setBusy]       = useState(false)
  const [chartKey, setChartKey] = useState<ChartKey>('btc')

  const { notify } = useToast()

  const refresh = useCallback(async () => {
    if (!contracts || !vaultReady || !wallet.address || !activeVault || !activeOracle) {
      setLoading(false); return
    }
    const next: Record<string, Row> = {}
    await Promise.all(
      symbols.map(async (sym) => {
        const id = ASSET_IDS[sym]
        const [priceRes, balance, cap, issued] = await Promise.all([
          safeRead(activeOracle.getPrice(id) as Promise<[bigint, bigint]>, [0n, 0n] as [bigint, bigint]),
          safeRead(
            new Contract(activeTokens[sym]!, activeTokenAbi, contracts.usdc.runner)
              .balanceOf(wallet.address) as Promise<bigint>,
            0n,
          ),
          // V2-only views; on V1 these reject and fall back, which is why each
          // read is isolated rather than batched into one try.
          isV2 ? safeRead(activeVault.assetCap(id) as Promise<bigint>, 0n) : Promise.resolve(0n),
          isV2 ? safeRead(activeVault.exposureOf(id) as Promise<bigint>, 0n) : Promise.resolve(0n),
        ])
        next[sym] = { price: priceRes[0], updatedAt: priceRes[1], balance, cap, issued }
      })
    )
    setRows(next)

    if (isV2) {
      // #99: reserveStatus() reads the ratio and its trustworthiness together
      // so they can't disagree — prefer it. It only exists from V2.3 onward, so
      // also fetch the two views it wraps (reserveRatioBps/ratioIsStale) plus
      // mintingHalted directly, in the SAME Promise.all rather than a second,
      // sequential round-trip: `status` wins when it resolves, but if only that
      // one call fails (a transient RPC hiccup on a real V2.3 proxy, not
      // necessarily "this is an old V2.2 proxy"), the parallel mintingHalted()
      // read still reports the true halt state instead of silently assuming
      // false — a false "not halted" is the one wrong answer that lets someone
      // submit a buy the chain will actually reject.
      const [paused, fees, status, ratio, staleFallback, haltedFallback] = await Promise.all([
        safeRead(activeVault.paused() as Promise<boolean>, null as unknown as boolean),
        safeRead(activeVault.accruedFees() as Promise<bigint>, -1n),
        safeRead(
          activeVault.reserveStatus() as Promise<
            [bigint, bigint, bigint, bigint, boolean, boolean]
          >,
          null,
        ),
        safeRead(activeVault.reserveRatioBps() as Promise<bigint>, -1n),
        safeRead(activeVault.ratioIsStale() as Promise<boolean>, false),
        safeRead(activeVault.mintingHalted() as Promise<boolean>, false),
      ])
      const pausedVal = typeof paused === 'boolean' ? paused : null
      const feesVal   = fees >= 0n ? fees : null

      if (status) {
        const [, , ratioBps, , stale, halted] = status
        setHealth({
          reserveRatioBps: ratioBps, paused: pausedVal, accruedFees: feesVal,
          stale, mintingHalted: halted,
        })
      } else {
        setHealth({
          reserveRatioBps: ratio >= 0n ? ratio : null, paused: pausedVal, accruedFees: feesVal,
          stale: staleFallback, mintingHalted: haltedFallback,
        })
      }
    } else {
      setHealth({ reserveRatioBps: null, paused: null, accruedFees: null, stale: false, mintingHalted: false })
    }

    setLoading(false)
    // symbols/activeTokens derive from chainId + version, both dependencies below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, vaultReady, wallet.address, wallet.chainId, version, isV2])

  useEffect(() => { void refresh() }, [refresh])

  // Live quote from the contract rather than client-side arithmetic, so the V2
  // fee is the real one. V1 returns a single uint256; V2 returns
  // (amount, feePaid) for BOTH previewMint and previewRedeem — verified against
  // the ABI, not assumed.
  useEffect(() => {
    let cancelled = false
    if (!dlg || !activeVault || !amount) { setQuote(null); return undefined }

    void (async () => {
      let parsed: bigint
      try { parsed = parseEther(amount) } catch { setQuote(null); return }
      if (parsed <= 0n) { setQuote(null); return }

      const id = ASSET_IDS[dlg.sym]
      try {
        const raw = dlg.mode === 'buy'
          ? await activeVault.previewMint(id, parsed)
          : await activeVault.previewRedeem(id, parsed)
        if (cancelled) return
        if (isV2) {
          const [out, fee] = raw as unknown as [bigint, bigint]
          setQuote({ out, fee })
        } else {
          setQuote({ out: raw as unknown as bigint, fee: 0n })
        }
      } catch {
        if (!cancelled) setQuote(null)   // asset closed, stale price, etc.
      }
    })()

    return () => { cancelled = true }
  }, [dlg, amount, activeVault, isV2])

  const closeDlg = () => { setDlg(null); setAmount(''); setQuote(null) }

  const doBuy = async (sym: AssetSymbol) => {
    if (!contracts || !activeVault || !activeVaultAddr) return
    let usdcAmt: bigint
    try { usdcAmt = parseEther(amount) } catch { notify(t.tokens.tx.badAmount, false); return }
    if (usdcAmt <= 0n) { notify(t.tokens.tx.amountTooSmall, false); return }

    setBusy(true)
    try {
      // Approve the ACTIVE vault — hardcoding V1's address here would send the
      // allowance to the wrong contract and the mint would revert.
      const approveTx = asTx(await contracts.usdc.approve(activeVaultAddr, usdcAmt))
      await approveTx.wait()
      const tx = asTx(await activeVault.mint(ASSET_IDS[sym], usdcAmt))
      await tx.wait()
      notify(interpolate(t.tokens.tx.bought, { symbol: sym }), true, tx.hash)
      closeDlg()
      await refresh()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setBusy(false) }
  }

  const doSell = async (sym: AssetSymbol) => {
    if (!activeVault) return
    let tokenAmt: bigint
    try { tokenAmt = parseEther(amount) } catch { notify(t.tokens.tx.badQuantity, false); return }
    if (tokenAmt <= 0n) { notify(t.tokens.tx.quantityTooSmall, false); return }

    setBusy(true)
    try {
      const tx = asTx(await activeVault.redeem(ASSET_IDS[sym], tokenAmt))
      await tx.wait()
      notify(interpolate(t.tokens.tx.sold, { symbol: sym }), true, tx.hash)
      closeDlg()
      await refresh()
    } catch (e) {
      notify(prettyError(e), false)
    } finally { setBusy(false) }
  }

  // EIP-747: make the token visible in MetaMask. This is the point of the page —
  // the token should be visibly sitting in the wallet.
  const addToWallet = async (sym: AssetSymbol) => {
    const eth = window.ethereum
    if (!eth) { notify(t.tokens.tx.noWallet, false); return }
    try {
      await eth.request({
        method: 'wallet_watchAsset',
        params: { type: 'ERC20', options: { address: activeTokens[sym], symbol: sym, decimals: 18 } },
      })
    } catch (e) {
      notify(prettyError(e), false)
    }
  }

  const versionSwitcher = (
    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
      <ToggleButtonGroup
        size="small" exclusive value={version}
        onChange={(_, v) => v && switchVersion(v)}
      >
        <ToggleButton value="v1" sx={{ textTransform: 'none', px: 2 }}>{t.tokens.version.v1}</ToggleButton>
        <Tooltip title={v2Available ? '' : t.tokens.version.v2Unavailable} arrow>
          {/* span keeps the tooltip alive on a disabled control */}
          <span>
            <ToggleButton value="v2" disabled={!v2Available} sx={{ textTransform: 'none', px: 2 }}>
              {t.tokens.version.v2}
            </ToggleButton>
          </span>
        </Tooltip>
      </ToggleButtonGroup>
      {isV2 && <Chip size="small" color="success" variant="outlined" label={t.tokens.version.v2Chip} />}
    </Stack>
  )

  const diffTable = (
    <Accordion sx={{ mt: 1 }}>
      <AccordionSummary expandIcon={<Icon icon="solar:alt-arrow-down-linear" />}>
        <Typography sx={{ fontWeight: 'bold' }}>{t.tokens.diff.title}</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>{t.tokens.diff.columnItem}</TableCell>
                <TableCell>{t.tokens.diff.columnV1}</TableCell>
                <TableCell>{t.tokens.diff.columnV2}</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {[
                [t.tokens.diff.transfer, t.tokens.diff.transferV1, t.tokens.diff.transferV2],
                [t.tokens.diff.reentrancy, t.tokens.diff.reentrancyV1, t.tokens.diff.reentrancyV2],
                [t.tokens.diff.pausable, t.tokens.diff.pausableV1, t.tokens.diff.pausableV2],
                [t.tokens.diff.access, t.tokens.diff.accessV1, t.tokens.diff.accessV2],
                [t.tokens.diff.upgradeable, t.tokens.diff.upgradeableV1, t.tokens.diff.upgradeableV2],
                [t.tokens.diff.oracle, t.tokens.diff.oracleV1, t.tokens.diff.oracleV2],
                [t.tokens.diff.cap, t.tokens.diff.capV1, t.tokens.diff.capV2],
                [t.tokens.diff.reserve, t.tokens.diff.reserveV1, t.tokens.diff.reserveV2],
                [t.tokens.diff.fee, t.tokens.diff.feeV1, t.tokens.diff.feeV2],
              ].map(([k, a, b]) => (
                <TableRow key={k}>
                  <TableCell sx={{ fontWeight: 'bold' }}>{k}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{a}</TableCell>
                  <TableCell sx={{ color: 'success.main' }}>{b}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          {t.tokens.markup.diffNoteBefore}<b>docs/RISK_MODEL.md</b>{t.tokens.markup.diffNoteMid}{' '}
          <b>docs/KNOWN_LIMITATIONS.md</b>{t.tokens.markup.diffNoteAfter}
        </Typography>
      </AccordionDetails>
    </Accordion>
  )

  // ── not deployed on this chain ──────────────────────────────────────────────
  if (!vaultReady) {
    return (
      <Container maxWidth="md" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>{t.tokens.title}</Typography>
          <Typography variant="body2" color="text.secondary">ERC-20 Tokenized Assets</Typography>
        </Box>
        {versionSwitcher}
        <Alert severity="info">
          {isV2 ? t.tokens.notDeployed.v2 : t.tokens.notDeployed.vault}
        </Alert>
        {diffTable}
      </Container>
    )
  }

  const ratioPct = health.reserveRatioBps !== null
    ? Number(health.reserveRatioBps) / 100
    : null

  return (
    <Container maxWidth="lg" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>{t.tokens.title}</Typography>
        <Typography variant="body2" color="text.secondary">ERC-20 Tokenized Assets</Typography>
      </Box>

      {versionSwitcher}

      {/* ── 市場行情（TradingView，Coinbase 現貨報價） ──────────────────────
          教授回饋第 5 點指名「加密貨幣的 TradingView 畫面建議用 Coinbase 的
          BTC Spot USD 報價為準」。symbol 寫死在 CHART_SYMBOLS，不開放自由輸入
          ——放開的話畫面上會出現永續合約的 symbol，跟這一頁「現貨」的定位打架。 */}
      <Card sx={{ p: { xs: 2, sm: 3 }, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            {t.tokens.chart.title}
          </Typography>
          <ToggleButtonGroup
            size="small"
            exclusive
            value={chartKey}
            onChange={(_, v) => { if (v) setChartKey(v as ChartKey) }}
          >
            <ToggleButton value="btc">{t.tokens.chart.btc}</ToggleButton>
            <ToggleButton value="eth">{t.tokens.chart.eth}</ToggleButton>
          </ToggleButtonGroup>
        </Box>
        <TradingViewChart symbol={CHART_SYMBOLS[chartKey]} height={380} />
        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
          {interpolate(t.tokens.chart.source, { symbol: CHART_SYMBOLS[chartKey] })}
        </Typography>
        <Typography variant="caption" color="text.disabled">
          {t.tokens.chart.unavailable}
        </Typography>
      </Card>

      <Alert severity="info">
        {t.tokens.markup.introBefore}<b>{t.tokens.markup.introBold1}</b>{SHOW_PERPETUALS ? t.tokens.markup.introMid1 : t.tokens.markup.introMid1Spot}<b>{t.tokens.markup.introBold2}</b>{t.tokens.markup.introMid2}<b>USDC</b>{t.tokens.markup.introAfter}
      </Alert>

      {/* #100 ③：誰提供價格、誰見證碳資料、誰營運儲備、誰稽核程式。 */}
      <Card sx={{ p: 2.5 }}>
        <WhoRunsWhat />
      </Card>

      {/* ── V2 hardening panel ─────────────────────────────────────────────── */}
      {isV2 ? (
        <Card sx={{ p: 2.5 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>
            {t.tokens.health.title}
          </Typography>

          {/* #99: `stale` (ratioIsStale()) means at least one outstanding asset
              couldn't be priced, so the ratio below UNDER-counts the liability
              and reads optimistic — never trade that number for a healthy one.
              It disables Buy (below) but never Sell — redemption is never
              gated on the ratio (see docs/RISK_MODEL.md). This is the reader
              ratioIsStale() was missing before #99. */}
          {health.stale && (
            <Alert severity="warning" variant="outlined" sx={{ mb: 2 }}>
              <b>{t.tokens.markup.staleRatioBold}</b>{t.tokens.markup.staleRatioBody}
            </Alert>
          )}
          {/* mintingHalted is the vault-wide breach latch — buying is blocked
              until an observation finds the book healthy again; selling never
              is (docs/RISK_MODEL.md: redemption is never ratio-gated). */}
          {health.mintingHalted && (
            <Alert severity="error" variant="outlined" sx={{ mb: 2 }}>
              <b>{t.tokens.markup.mintingHaltedBold}</b>{t.tokens.markup.mintingHaltedBody}
            </Alert>
          )}
          <Grid container spacing={2.5}>
            <Grid size={{ xs: 12, md: 4 }}>
              <Typography variant="caption" color="text.secondary" display="block">{t.tokens.health.reserveRatio}</Typography>
              <Typography sx={{ fontFamily: MONO, fontWeight: 'bold', fontSize: '1.15rem' }}>
                {health.stale
                  ? t.tokens.health.reserveRatioUnknown
                  : ratioPct === null
                  ? '—'
                  : ratioPct > 100000 ? t.tokens.health.reserveRatioInfinite : ratioPct.toFixed(1) + '%'}
              </Typography>
              <LinearProgress
                variant="determinate"
                value={health.stale || ratioPct === null ? 0 : Math.min(100, ratioPct / 2)}
                color={health.stale ? 'warning' : ratioPct !== null && ratioPct < 110 ? 'error' : 'success'}
                sx={{ mt: 0.75, height: 6, borderRadius: 3 }}
              />
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                {health.stale ? t.tokens.health.reserveRatioNoteStale : t.tokens.health.reserveRatioNote}
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, md: 4 }}>
              <Typography variant="caption" color="text.secondary" display="block">{t.tokens.health.status}</Typography>
              <Stack direction="row" spacing={0.75} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                {health.paused === null ? (
                  <Typography sx={{ fontFamily: MONO }}>—</Typography>
                ) : (
                  <Chip
                    size="small"
                    color={health.paused ? 'error' : 'success'}
                    label={health.paused ? t.tokens.health.paused : t.tokens.health.running}
                    sx={{ fontWeight: 'bold' }}
                  />
                )}
                {health.mintingHalted && (
                  <Chip
                    size="small"
                    color="error"
                    label={t.tokens.health.mintingHalted}
                    sx={{ fontWeight: 'bold' }}
                  />
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {t.tokens.health.pausableNote}
              </Typography>

              <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>
                {t.tokens.health.accruedFees}
              </Typography>
              <Typography sx={{ fontFamily: MONO }}>
                {health.accruedFees === null ? '—' : f18(health.accruedFees, 2) + ' USDC'}
              </Typography>
            </Grid>

            <Grid size={{ xs: 12, md: 4 }}>
              <Typography variant="caption" color="text.secondary" display="block">{t.tokens.health.guardedOracle}</Typography>
              <Link
                href={`https://sepolia.etherscan.io/address/${v2!.oracleAddr}`}
                target="_blank" rel="noopener noreferrer"
                sx={{ fontFamily: MONO, fontSize: '0.8rem', wordBreak: 'break-all' }}
              >
                {v2!.oracleAddr}
              </Link>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                {t.tokens.health.guardedOracleNote}
              </Typography>
            </Grid>
          </Grid>
        </Card>
      ) : (
        <Alert severity="warning" variant="outlined">
          {t.tokens.health.v1Notice}
        </Alert>
      )}

      <Grid container spacing={2}>
        {symbols.map((sym) => {
          const row = rows[sym]
          const price = row?.price ?? 0n
          const bal   = row?.balance ?? 0n
          const usd   = (Number(bal) / 1e18) * (Number(price) / 1e8)

          return (
            <Grid size={{ xs: 12, sm: 6, md: 4 }} key={sym}>
              <Card sx={{ p: 2.5, height: '100%', display: 'flex', flexDirection: 'column', gap: 1.5 }}>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                  <AssetIcon symbol={sym} size={36} />
                  <Box sx={{ minWidth: 0 }}>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', lineHeight: 1.2 }}>{sym}</Typography>
                    <Typography variant="caption" color="text.secondary" noWrap>
                      {ASSET_META[ASSET_IDS[sym]]?.name ?? sym}
                    </Typography>
                  </Box>
                </Box>

                <Box>
                  <Typography variant="caption" color="text.secondary" display="block">{t.tokens.card.oraclePrice}</Typography>
                  {loading ? (
                    <Skeleton height={24} sx={{ width: '60%' }} />
                  ) : (
                    <Typography sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                      {price > 0n ? fUsd(Number(price) / 1e8) : '—'}
                    </Typography>
                  )}
                </Box>

                <Box>
                  <Typography variant="caption" color="text.secondary" display="block">{t.tokens.card.myBalance}</Typography>
                  {loading ? (
                    <Skeleton height={24} sx={{ width: '70%' }} />
                  ) : (
                    <Typography sx={{ fontFamily: MONO }}>
                      {f18(bal)} {sym}
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.75 }}>
                        ≈ {fUsd(usd)}
                      </Typography>
                    </Typography>
                  )}
                </Box>

                {isV2 && (
                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block">{t.tokens.card.issuedOverCap}</Typography>
                    <Typography variant="caption" sx={{ fontFamily: MONO }}>
                      {f18(row?.issued ?? 0n, 2)} / {(row?.cap ?? 0n) === 0n ? t.tokens.card.capClosed : f18(row?.cap ?? 0n, 2)}
                    </Typography>
                  </Box>
                )}

                <Stack direction="row" spacing={1} sx={{ mt: 'auto', pt: 0.5 }}>
                  <Button
                    size="small" variant="contained" fullWidth
                    // #99: `stale` gates buy too, not just `mintingHalted`. A
                    // stale asset makes reserveRatioBps() UNDER-count liability
                    // (that asset drops out of the sum), so the ratio — and
                    // mintingHalted's own trigger — can read healthy even while
                    // the true, unknown ratio has already breached. Blocking
                    // buy on ANY unpriced asset, not just the one being traded,
                    // is what "cannot confirm the ratio" (docs/RISK_MODEL.md,
                    // frontend/CONTEXT.md's Unknown Ratio) means in practice.
                    // A specific asset's own stale price still separately
                    // reverts via mint()'s _price() call regardless.
                    disabled={isV2 && (health.paused === true || health.mintingHalted || health.stale)}
                    onClick={() => setDlg({ sym, mode: 'buy' })}
                    sx={{ textTransform: 'none', fontWeight: 'bold' }}
                  >
                    {t.tokens.card.buy}
                  </Button>
                  <Button
                    size="small" variant="outlined" fullWidth
                    // #99: redemption is never gated by the reserve ratio or by
                    // mintingHalted (docs/RISK_MODEL.md) — only paused stops it.
                    disabled={bal === 0n || (isV2 && health.paused === true)}
                    onClick={() => setDlg({ sym, mode: 'sell' })}
                    sx={{ textTransform: 'none', fontWeight: 'bold' }}
                  >
                    {t.tokens.card.sell}
                  </Button>
                </Stack>

                <Button
                  size="small" variant="text"
                  onClick={() => void addToWallet(sym)}
                  sx={{ textTransform: 'none', fontSize: '0.75rem', color: 'info.main', alignSelf: 'flex-start' }}
                >
                  {t.tokens.card.addToWallet}
                </Button>

                {/* #100 ①④：代號卡 → 身世卡。追蹤標的、免責、碳強度與出處、KYC 理由、見證日。 */}
                <Divider sx={{ mt: 0.5 }} />
                <AssetProvenanceCard
                  meta={ASSET_META[ASSET_IDS[sym]]}
                  priceUpdatedAtSec={row ? Number(row.updatedAt) : undefined}
                />
              </Card>
            </Grid>
          )
        })}
      </Grid>

      <Typography variant="caption" color="text.secondary">
        {t.tokens.markup.vaultDryBefore}<Box component="code" sx={{ fontFamily: MONO }}>fundVault()</Box>{t.tokens.markup.vaultDryAfter}
      </Typography>

      <Divider />
      {diffTable}

      {/* buy / sell dialog */}
      <Dialog open={!!dlg} onClose={closeDlg} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 'bold' }}>
          {interpolate(dlg?.mode === 'buy' ? t.tokens.dialog.buyTitle : t.tokens.dialog.sellTitle, {
            symbol: dlg?.sym ?? '',
          })}
          <Chip size="small" label={isV2 ? 'V2' : 'V1'} sx={{ ml: 1 }} />
        </DialogTitle>
        <DialogContent>
          <Stack spacing={2} sx={{ mt: 1 }}>
            <Chip
              size="small"
              variant="outlined"
              label={`Oracle: ${
                dlg && (rows[dlg.sym]?.price ?? 0n) > 0n
                  ? fUsd(Number(rows[dlg.sym].price) / 1e8)
                  : '—'
              }`}
              sx={{ alignSelf: 'flex-start', fontFamily: MONO }}
            />
            <TextField
              autoFocus fullWidth type="number" size="small"
              label={
                dlg?.mode === 'buy'
                  ? t.tokens.dialog.buyAmountLabel
                  : interpolate(t.tokens.dialog.sellAmountLabel, { symbol: dlg?.sym ?? '' })
              }
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={busy}
              slotProps={{
                input: {
                  endAdornment: (
                    <InputAdornment position="end">
                      {dlg?.mode === 'buy' ? 'USDC' : dlg?.sym}
                    </InputAdornment>
                  ),
                },
              }}
            />
            <Box>
              <Typography variant="caption" color="text.secondary" display="block">
                {quote === null
                  ? t.tokens.dialog.needAmount
                  : dlg?.mode === 'buy'
                    ? interpolate(t.tokens.dialog.buyQuote, {
                        amount: f18(quote.out),
                        symbol: dlg?.sym ?? '',
                      })
                    : interpolate(t.tokens.dialog.sellQuote, {
                        amount: fUsd(Number(quote.out) / 1e18),
                      })}
              </Typography>
              {isV2 && quote !== null && quote.fee > 0n && (
                <Typography variant="caption" color="warning.main" display="block">
                  {interpolate(t.tokens.dialog.fee, { amount: f18(quote.fee, 4) })}
                </Typography>
              )}
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions>
          <Button onClick={closeDlg} disabled={busy} sx={{ textTransform: 'none' }}>{t.tokens.dialog.cancel}</Button>
          <Button
            variant="contained"
            disabled={busy || !amount}
            onClick={() => dlg && void (dlg.mode === 'buy' ? doBuy(dlg.sym) : doSell(dlg.sym))}
            sx={{ textTransform: 'none', fontWeight: 'bold' }}
          >
            {busy ? t.tokens.dialog.working : t.tokens.dialog.confirm}
          </Button>
        </DialogActions>
      </Dialog>
    </Container>
  )
}
