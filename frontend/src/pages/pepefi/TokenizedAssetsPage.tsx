import { MONO, shortAddr } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react'
import { Contract, parseEther, type ContractTransactionResponse } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { useV2Contracts } from 'src/hooks/useV2Contracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { safeRead } from 'src/lib/pepefi/safeRead'
import { fUsd, fromUnits, f18 } from 'src/lib/pepefi/format'
import {
  ASSET_IDS, getAddresses, getSynthTokens, type AssetSymbol,
} from 'src/contracts/addresses'
import { t, interpolate } from 'src/locales'
import { useMode } from 'src/contexts/mode-context'
import { ASSET_META } from 'src/lib/pepefi/assetMeta'
import {
  buildAssetRows, sortAssetRows, assetRowColumnsForMode, assetRowColumnLabelForMode,
  type AssetRow, type AssetRowChainData, type AssetRowColumnKey, type AssetSortKey,
} from 'src/lib/pepefi/assetRows'
import SyntheticAssetABI   from 'src/contracts/abi/SyntheticAsset.json'
import SyntheticAssetV2ABI from 'src/contracts/abi/SyntheticAssetV2.json'
import AssetIcon from 'src/components/pepefi/AssetIcon'
import { WhoRunsWhat, AssetProvenanceSummary } from 'src/components/pepefi/AssetProvenance'
import { AssetDetailPanel } from 'src/components/pepefi/AssetDetailPanel'
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
import Drawer from '@mui/material/Drawer';
import ToggleButton from '@mui/material/ToggleButton';
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup';
import LinearProgress from '@mui/material/LinearProgress';
import Link from '@mui/material/Link';
import Accordion from '@mui/material/Accordion';
import AccordionSummary from '@mui/material/AccordionSummary';
import AccordionDetails from '@mui/material/AccordionDetails';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';
import TableContainer from '@mui/material/TableContainer';
import { useTheme } from '@mui/material/styles';
import useMediaQuery from '@mui/material/useMediaQuery';
import { Icon } from '@iconify/react';

const ZERO_ADDR = '0x0000000000000000000000000000000000000000'

// f18/fUsd used to be declared locally here (and again, slightly differently,
// on other pages, and a third time in AssetDetailPanel.tsx) — the exact
// duplication lib/pepefi/format.ts exists to stop; f18 is now a proper named
// export there instead of a fourth copy. The local fUsd also used to pin
// 'en-US' on a Traditional Chinese interface; the shared one follows the
// user's locale. For zh-Hant the grouping and decimal separators are the
// same, so the rendered output does not change.

// Contract methods come off a JSON ABI, so ethers types them loosely. Narrow to
// the transaction shape we actually use rather than casting through `any`.
const asTx = (t: unknown) => t as ContractTransactionResponse

// #136：哪些欄是數字/雜湊，該用等寬字體——查表而不是一長串 ===，跟
// assetRows.ts 自己的 TIER_RANK 同一種寫法。加一欄數字欄只改這裡一處。
const MONO_COLUMNS = new Set<AssetRowColumnKey>([
  'tradingFee', 'price', 'balance', 'issuedOverCap', 'assetId',
])

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

  // 哪一套金庫在這條鏈上可用是鏈上事實，不是使用者的選擇——見 CONTEXT.md
  // 的 The Vault 詞條。useV2Contracts 已經把「這條鏈有沒有硬化版」這個判斷
  // 做完了（沒有就回傳 null），這裡不再需要 localStorage、不再需要使用者
  // 自己挑，也就沒有「按錯鍵、餘額看起來歸零」這種陷阱。
  const isV2 = !!v2

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
  // #134：詳情層取代了買賣對話框——selected 現在同時是「哪一列被點開」跟
  // 「詳情層裡買進／贖回哪個分頁」，一份狀態，不是兩份各自要對齊的狀態。
  const [selected, setSelected] = useState<{ sym: AssetSymbol; mode: 'buy' | 'sell' } | null>(null)
  const [amount, setAmount]   = useState('')
  const [quote, setQuote]     = useState<{ out: bigint; fee: bigint } | null>(null)
  const [busy, setBusy]       = useState(false)
  const [sortKey, setSortKey] = useState<AssetSortKey>('tier')

  const { notify } = useToast()
  const { mode } = useMode()
  const theme = useTheme()
  // #134：桌面是側邊欄（表格保持可見），手機是全螢幕 Drawer——這裡只決定
  // 外殼，內容（AssetDetailPanel）兩邊共用同一份。
  const isDesktop = useMediaQuery(theme.breakpoints.up('md'))

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
          //
          // #133：cap/issued 還是讀進來，但資產表目前不顯示發行量／上限這一
          // 欄（那張卡片牆版本有的 t.tokens.card.issuedOverCap）——Expert
          // Mode 專屬的欄位由 #136 補回來，讀取先留著，免得那張票還要重新
          // 接一次資料源。
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
    // symbols/activeTokens derive from chainId + isV2, both dependencies below
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contracts, vaultReady, wallet.address, wallet.chainId, isV2])

  useEffect(() => { void refresh() }, [refresh])

  // Live quote from the contract rather than client-side arithmetic, so the V2
  // fee is the real one. V1 returns a single uint256; V2 returns
  // (amount, feePaid) for BOTH previewMint and previewRedeem — verified against
  // the ABI, not assumed.
  useEffect(() => {
    let cancelled = false
    if (!selected || !activeVault || !amount) { setQuote(null); return undefined }

    void (async () => {
      let parsed: bigint
      try { parsed = parseEther(amount) } catch { setQuote(null); return }
      if (parsed <= 0n) { setQuote(null); return }

      const id = ASSET_IDS[selected.sym]
      try {
        const raw = selected.mode === 'buy'
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
  }, [selected, amount, activeVault, isV2])

  const closePanel = () => { setSelected(null); setAmount(''); setQuote(null) }

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
      closePanel()
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
      closePanel()
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

  // 這個金庫有哪些防護——單欄清單，只有硬化版金庫真的有這些防護時才顯示。
  // 舊版金庫（isV2 為 false）沒有這九項裡的大多數，把這張清單套在它頭上會是
  // 一個站不住的宣稱，所以呼叫端必須只在 isV2 時 render 它，不能無條件顯示。
  const protectionsList = (
    <Accordion sx={{ mt: 1 }}>
      <AccordionSummary expandIcon={<Icon icon="solar:alt-arrow-down-linear" />}>
        <Typography sx={{ fontWeight: 'bold' }}>{t.tokens.protections.title}</Typography>
      </AccordionSummary>
      <AccordionDetails>
        <TableContainer>
          <Table size="small">
            <TableBody>
              {t.tokens.protections.items.map(({ label, detail }) => (
                <TableRow key={label}>
                  <TableCell sx={{ fontWeight: 'bold' }}>{label}</TableCell>
                  <TableCell sx={{ color: 'success.main' }}>{detail}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          {t.tokens.markup.protectionsNoteBefore}<b>docs/RISK_MODEL.md</b>{t.tokens.markup.protectionsNoteMid}{' '}
          <b>docs/KNOWN_LIMITATIONS.md</b>{t.tokens.markup.protectionsNoteAfter}
        </Typography>
      </AccordionDetails>
    </Accordion>
  )

  // ── not deployed on this chain ──────────────────────────────────────────────
  if (!vaultReady) {
    return (
      <Container maxWidth="md" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>{mode === 'simple' ? t.tokens.titleSimple : t.tokens.title}</Typography>
          <Typography variant="body2" color="text.secondary">{t.tokens.subtitle}</Typography>
        </Box>
        <Alert severity="info">{t.tokens.notDeployed}</Alert>
      </Container>
    )
  }

  const ratioPct = health.reserveRatioBps !== null
    ? Number(health.reserveRatioBps) / 100
    : null

  // #133：資產表的每一列由 assetRows 這個純函式算出來——分級解析、費率
  // 推導、排序、買賣可用性全部在那邊測過，這裡只是把鏈上讀回來的原始資料
  // 餵進去。
  const assetRowInputs: AssetRowChainData[] = symbols.map((sym) => ({
    symbol: sym,
    meta: ASSET_META[ASSET_IDS[sym]],
    price: rows[sym]?.price ?? 0n,
    updatedAtSec: rows[sym] ? Number(rows[sym].updatedAt) : 0,
    balance: rows[sym]?.balance ?? 0n,
    cap: rows[sym]?.cap ?? 0n,
    issued: rows[sym]?.issued ?? 0n,
  }))
  // isV2 由 useV2Contracts 的 useMemo 同步跟著 chainId 變，但 health 是
  // refresh() 的非同步 effect 才會重設——兩者之間有一段 health 還沒被
  // 正規化、卻已經換了鏈的空檔。舊版卡片牆的寫法是 `isV2 && (health...)`，
  // isV2 一變就整條表達式立刻短路，不會被上一條鏈殘留的 health 值影響；
  // 這裡照抄同一個安全性質，而不是信任 health 已經被正規化過。
  const gate = isV2 ? health : { paused: null, mintingHalted: false, stale: false }
  const displayRows = sortAssetRows(
    buildAssetRows(assetRowInputs, gate, { nowMs: Date.now() }),
    sortKey,
  )

  // #136：欄位集由 assetRows 回答，不是散在元件裡的條件判斷——這裡只問
  // 「這個 Mode 看得到哪些欄」，不重新決定欄位長什麼樣。
  const columns = assetRowColumnsForMode(mode)

  // Expert 的三格網格跟 Simple 的一句話都要講同一件事：儲備率現在讀起來
  // 是多少。算一次、兩邊引用，不要各自重算一次同一個三分支判斷。
  const reserveRatioText = health.stale
    ? t.tokens.health.reserveRatioUnknown
    : ratioPct === null
    ? '—'
    : ratioPct > 100000 ? t.tokens.health.reserveRatioInfinite : ratioPct.toFixed(1) + '%'

  // #136 code review：Simple 的一句話版不能只判斷「過不過期」——鑄造暫停、
  // 儲備率跌破下限都是投資人該知道的事（#93 user story 5、6），Expert 的
  // 三格網格已經分別處理這三種狀態,Simple 只是換一句話講同一組事實,不能
  // 漏掉其中兩種。severity 同理跟著真正的健康狀況走,不是固定給 'info'。
  const simpleReserve: { severity: 'info' | 'warning' | 'error'; message: string } = !isV2
    ? { severity: 'info', message: t.tokens.health.simpleNotConnected }
    : health.stale
      ? { severity: 'warning', message: reserveRatioText }
      : health.mintingHalted
        ? { severity: 'error', message: interpolate(t.tokens.health.simpleMintingHalted, { ratio: reserveRatioText }) }
        : {
            // 對齊 Expert 網格用同一個門檻判斷顏色（LinearProgress 的
            // color）：ratioPct < 110 讀成 'error'。
            severity: ratioPct !== null && ratioPct < 110 ? 'error' : 'info',
            message: interpolate(t.tokens.health.simpleNote, { ratio: reserveRatioText }),
          }

  // #136：一列的每一格由欄位 key 決定內容——表頭跟表身共用同一份 columns
  // 清單，不會有「表頭多一欄、表身忘了補」這種兩邊各寫一次才會出現的漂移
  // （#134 detailPanel 的重複剛好是這個問題的前車之鑑）。只定義一次（不在
  // displayRows.map() 裡面重新宣告），每列呼叫時傳 assetRow 進來。
  // `never` 分支是編譯期的窮舉檢查——AssetRowColumnKey 多一個值卻忘了在這裡
  // 加對應的 case，會在這裡直接編譯失敗，不會等到執行期才發現少畫一欄。
  const renderAssetCell = (col: AssetRowColumnKey, assetRow: AssetRow) => {
    const sym = assetRow.symbol as AssetSymbol
    switch (col) {
      case 'asset':
        return (
          <Stack direction="row" spacing={1.25} alignItems="center">
            <AssetIcon symbol={assetRow.symbol} size={28} />
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 'bold', lineHeight: 1.2 }}>
                {assetRow.symbol}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {assetRow.name}
              </Typography>
            </Box>
          </Stack>
        )
      case 'provenance':
        // #134：跟詳情層標題共用同一個摘要元件，不是長得像的兩份。
        return <AssetProvenanceSummary tier={assetRow.tier} freshness={assetRow.freshness} />
      case 'tradingFee':
        return `${(assetRow.tradingFeeBps / 100).toFixed(2)}%`
      case 'price':
        return loading
          ? <Skeleton height={20} sx={{ width: 64 }} />
          : assetRow.price > 0n ? fUsd(Number(assetRow.price) / 1e8) : '—'
      case 'balance':
        return loading ? (
          <Skeleton height={20} sx={{ width: 88 }} />
        ) : (
          <>
            {f18(assetRow.balance)} {assetRow.symbol}
            <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
              ≈ {fUsd(fromUnits(assetRow.usdValue, 18))}
            </Typography>
          </>
        )
      case 'issuedOverCap':
        // 舊版金庫沒有發行上限這個概念——cap/issued 在那裡永遠是 refresh()
        // 塞進去的 0n，不是鏈上真的讀到「已關閉」，跟卡片牆版本（#133 之前）
        // 同一條規則：這一欄只在硬化版金庫上有意義。
        return !isV2 ? '—' : (
          <>
            {f18(assetRow.issued, { dp: 2 })} / {assetRow.cap === 0n ? t.tokens.card.capClosed : f18(assetRow.cap, { dp: 2 })}
          </>
        )
      case 'priceUpdatedAt':
        return assetRow.freshness.label
      case 'assetId': {
        const id = ASSET_IDS[sym]
        return <span title={id}>{shortAddr(id, 8, 6)}</span>
      }
      case 'actions':
        return (
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button
              size="small" variant="contained"
              // #99：這三個條件是 assetRow.canBuy 的定義本身，見
              // lib/pepefi/assetRows.ts——暫停／鑄造停止／比率不可信
              // 任一為真就擋買進，理由見那個模組自己的註解。
              disabled={!assetRow.canBuy}
              onClick={() => setSelected({ sym, mode: 'buy' })}
              sx={{ textTransform: 'none', fontWeight: 'bold' }}
            >
              {t.tokens.card.buy}
            </Button>
            <Button
              size="small" variant="outlined"
              // #99：只有暫停擋得住贖回，見 assetRows.ts 的 canSell。
              disabled={!assetRow.canSell}
              onClick={() => setSelected({ sym, mode: 'sell' })}
              sx={{ textTransform: 'none', fontWeight: 'bold' }}
            >
              {t.tokens.card.sell}
            </Button>
            {/* #136：加入錢包在表格列上是 Expert 專屬的快捷方式——Simple
                使用者一樣按得到，就是走詳情層那個共用的按鈕（見
                AssetDetailPanel，兩個模式的詳情層內容相同）。這是「一個
                按鈕在既有欄位裡看不看得到」的判斷，跟 assetRowColumnsForMode
                「這個模式有沒有這一欄」是不同層級的問題，所以刻意不透過
                欄位集機制處理。 */}
            {mode === 'expert' && (
              <Button
                size="small" variant="text"
                onClick={() => void addToWallet(sym)}
                sx={{ textTransform: 'none', fontSize: '0.7rem', color: 'info.main' }}
              >
                {t.tokens.card.addToWallet}
              </Button>
            )}
          </Stack>
        )
      default: {
        const exhaustive: never = col
        return exhaustive
      }
    }
  }

  // #134：詳情層的內容只算一次——桌面的側邊欄跟手機的 Drawer 只是不同的
  // 外殼，內容元件與它的整份 props 不該在兩個分支各寫一遍（那正是這一頁
  // 其餘條件渲染的既有寫法，比照 protectionsList 這個變數）。
  const selectedRow = selected ? displayRows.find((r) => r.symbol === selected.sym) : undefined
  const selectedMeta = selected ? ASSET_META[ASSET_IDS[selected.sym]] : undefined
  const detailPanel = selected && selectedRow && selectedMeta ? (
    <AssetDetailPanel
      sym={selected.sym}
      assetRow={selectedRow}
      meta={selectedMeta}
      price={rows[selected.sym]?.price ?? 0n}
      isV2={isV2}
      mode={selected.mode}
      onModeChange={(mode) => setSelected({ sym: selected.sym, mode })}
      amount={amount}
      onAmountChange={setAmount}
      quote={quote}
      busy={busy}
      onConfirm={() => void (selected.mode === 'buy' ? doBuy(selected.sym) : doSell(selected.sym))}
      onAddToWallet={() => void addToWallet(selected.sym)}
      onClose={closePanel}
    />
  ) : null

  return (
    <Container maxWidth="xl" sx={{ py: 3 }}>
    {/* #134：桌面版詳情層是右側面板、表格保持可見——外層開一個橫向 flex，
        主欄放原本整頁的內容，詳情層是它的旁邊那一欄，不是蓋在上面的遮罩。 */}
    <Box sx={{ display: 'flex', gap: 3, alignItems: 'flex-start' }}>
    <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>{mode === 'simple' ? t.tokens.titleSimple : t.tokens.title}</Typography>
        <Typography variant="body2" color="text.secondary">{t.tokens.subtitle}</Typography>
      </Box>

      <Alert severity="info">
        {t.tokens.markup.introBefore}<b>{t.tokens.markup.introBold1}</b>{SHOW_PERPETUALS ? t.tokens.markup.introMid1 : t.tokens.markup.introMid1Spot}<b>{t.tokens.markup.introBold2}</b>{t.tokens.markup.introMid2}<b>USDC</b>{t.tokens.markup.introAfter}
      </Alert>

      {/* #100 ③：誰提供價格、誰見證碳資料、誰營運儲備、誰稽核程式。 */}
      <Card sx={{ p: 2.5 }}>
        <WhoRunsWhat />
      </Card>

      {/* #136：儲備率是給投資人的事實（#93 user story 5、6），不能整塊收進
          Expert——Simple 收起來的是四格儀表板跟預言機的機制細節,不是這件事
          本身。不可信時講「無法確認」,不接「，可隨時贖回」那句尾巴,那句
          在不可信的狀態下講不通。 */}
      {mode === 'simple' && (
        <Alert severity={simpleReserve.severity} variant="outlined">
          {simpleReserve.message}
        </Alert>
      )}

      {/* ── V2 hardening panel（Expert 專屬——工程證據，不是 Simple 該看的東西）── */}
      {mode === 'expert' && (isV2 ? (
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
                {reserveRatioText}
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
                {health.accruedFees === null ? '—' : f18(health.accruedFees, { dp: 2 }) + ' USDC'}
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
          {t.tokens.health.notHardened}
        </Alert>
      ))}

      {mode === 'expert' && isV2 && protectionsList}

      {/* #133：卡片牆 → 資產表。碳分級決定買入費率——兩欄相鄰，順序由
          buildAssetRows/sortAssetRows 這個純函式決定，元件只管渲染。
          身世卡的完整內容（追蹤標的、KYC 理由、出處網址…）搬進詳情層是
          下一張票（#134）的事，這裡先只留分級與新鮮度兩顆摘要 chip。 */}
      <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
        <Typography variant="body2" color="text.secondary">{t.tokens.table.sort.label}</Typography>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={sortKey}
          onChange={(_, v) => { if (v) setSortKey(v as AssetSortKey) }}
        >
          <ToggleButton value="tier" sx={{ textTransform: 'none', px: 1.5 }}>{t.tokens.table.sort.tier}</ToggleButton>
          <ToggleButton value="price" sx={{ textTransform: 'none', px: 1.5 }}>{t.tokens.table.sort.price}</ToggleButton>
          <ToggleButton value="balance" sx={{ textTransform: 'none', px: 1.5 }}>{t.tokens.table.sort.balance}</ToggleButton>
          <ToggleButton value="name" sx={{ textTransform: 'none', px: 1.5 }}>{t.tokens.table.sort.name}</ToggleButton>
        </ToggleButtonGroup>
      </Stack>

      <TableContainer component={Card}>
        <Table>
          <TableHead>
            <TableRow>
              {columns.map((col) => (
                <TableCell key={col} sx={{ fontWeight: 'bold' }}>{assetRowColumnLabelForMode(col, mode)}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {displayRows.map((assetRow) => (
              <TableRow key={assetRow.symbol}>
                {columns.map((col) => (
                  <TableCell key={col} sx={MONO_COLUMNS.has(col) ? { fontFamily: MONO } : undefined}>
                    {renderAssetCell(col, assetRow)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>

      {mode === 'expert' && (
        <Typography variant="caption" color="text.secondary">
          {t.tokens.markup.vaultDryBefore}<Box component="code" sx={{ fontFamily: MONO }}>fundVault()</Box>{t.tokens.markup.vaultDryAfter}
        </Typography>
      )}
    </Box>

      {/* #134：桌面版詳情層——側邊欄，表格保持可見。sticky 讓面板跟著捲動，
          maxHeight 留一點邊界並讓面板內容自己捲（AssetDetailPanel 的
          overflowY: auto）。 */}
      {isDesktop && detailPanel && (
        <Box sx={{ width: 420, flexShrink: 0, position: 'sticky', top: 16 }}>
          <Card sx={{ maxHeight: 'calc(100vh - 32px)', overflow: 'hidden' }}>
            {detailPanel}
          </Card>
        </Box>
      )}
    </Box>

      {/* 手機版詳情層——全螢幕 Drawer，桌面版的側邊欄在窄螢幕上放不下。 */}
      {!isDesktop && (
        <Drawer
          anchor="bottom"
          open={!!detailPanel}
          onClose={closePanel}
          slotProps={{ paper: { sx: { height: '100%', maxHeight: '100%' } } }}
        >
          {detailPanel}
        </Drawer>
      )}
    </Container>
  )
}
