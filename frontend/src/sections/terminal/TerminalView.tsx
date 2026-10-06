import type { AssetId, LivePos } from './types'

import { useMemo, useState, useEffect, useCallback } from 'react'

import Box from '@mui/material/Box'

import { paths } from 'src/routes/paths'

import { useKYC } from 'src/hooks/useKYC'
import { useCandles } from 'src/hooks/useCandles'
import { useContracts } from 'src/hooks/useContracts'
import { useStablecoin } from 'src/hooks/useStablecoin'
import { useAssetModes } from 'src/hooks/useAssetModes'
import { useFundingData } from 'src/hooks/useFundingData'
import { useVaultBacking } from 'src/hooks/useVaultBacking'
import { useLivePricesWithMeta } from 'src/hooks/useLivePrices'
import { useTerminalLayout } from 'src/hooks/useTerminalLayout'
import { useMarketActivity } from 'src/hooks/useMarketActivity'
import { useAssetTradingParams } from 'src/hooks/useAssetTradingParams'
import { kycGateApplies, useOnchainRwaFlags } from 'src/hooks/useOnchainRwa'
import { isVcKycRegistry, useVcKycRegistry } from 'src/hooks/useVcKycRegistry'
import { POSITION_STALE_MS, useTerminalAccount } from 'src/hooks/useTerminalAccount'

import { t } from 'src/locales'
import { assetPolicy } from 'src/tenant'
import { ASSET_IDS } from 'src/contracts/addresses'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { marketStatus } from 'src/lib/pepefi/marketStatus'
import { terminalTotals } from 'src/lib/pepefi/positionPnl'
import { stalenessNotice } from 'src/lib/pepefi/priceFreshness'
import { ASSET_META, ASSETS_LIST } from 'src/lib/pepefi/assetMeta'
import { fundingIntervalOf } from 'src/lib/pepefi/fundingInterval'
import { staticTradingParams } from 'src/lib/pepefi/tradingParams'
import { type Interval, DEFAULT_INTERVAL } from 'src/lib/pepefi/candles'
import { freshnessText, dataFreshness } from 'src/lib/pepefi/positionFreshness'

import { useToast } from 'src/components/pepefi/ToastProvider'
import PaperTradingBadge from 'src/components/pepefi/PaperTradingBadge'

import { BookPanel } from './book/BookPanel'
import { ChartPanel } from './chart/ChartPanel'
import { TerminalHeader } from './TerminalHeader'
import { MarketSelector } from './MarketSelector'
import { MarketStatsBar } from './MarketStatsBar'
import { OrderTicket } from './ticket/OrderTicket'
import { AccountPanel } from './ticket/AccountPanel'
import { C, panel, labelCss } from './terminal-theme'
import { PositionsPanel } from './positions/PositionsPanel'

/** 市場列表上的資產（租戶白名單內）；assetMode 只讀這些。 */
const SELECTABLE_IDS = assetPolicy.selectable(ASSETS_LIST).map((a) => a.id)

/**
 * 終端機版面骨架與共用狀態的擁有者。
 *
 * 只保留「多個面板都要用」的狀態：選中標的、鏈上帳戶、即時報價、toast。表單類的
 * 狀態（方向、槓桿、保證金、入金金額）由各自的面板持有，避免每次打字都重繪整頁。
 */
export function TerminalView() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const { prices: live, meta: priceMeta } = useLivePricesWithMeta()
  const funding = useFundingData(contracts?.exchange ?? null)

  // 預設選白標租戶白名單的第一檔（default 租戶 = 全部資產，第一檔就是 sBTC，與改版前相同）。
  const [selAsset, setSelAsset] = useState<AssetId>(ASSET_IDS[assetPolicy.enabledSymbols[0]])
  const [interval, setInterval] = useState<Interval>(DEFAULT_INTERVAL)
  const { notify } = useToast()

  const layout = useTerminalLayout()

  const account = useTerminalAccount(contracts, wallet.address ?? null, selAsset)
  const { stable, setStable } = useStablecoin(contracts)
  const { isVerified: kycOk, isUnknown: kycUnknown, isPending: kycPending } = useKYC(contracts?.kycRegistry ?? null, wallet.address ?? null)

  const meta = ASSET_META[selAsset]
  // 槓桿上限與費率：讀一次、統計列與下單面板共用。靜態表只在鏈上讀不到時使用。
  const staticParams = staticTradingParams(meta, Date.now())
  const tradingParams = useAssetTradingParams(contracts?.exchange, selAsset, {
    maxLeverage: staticParams.maxLeverage,
    tradingFeeBps: staticParams.tradingFeeBps,
  })
  // 鏈上 rwaAsset 旗標也算：專屬租戶可在部署時追加 RWA（例如 sGOLD），靜態表不知道。
  const onchainRwa = useOnchainRwaFlags(contracts?.exchange, [selAsset])
  const kycBlocked = kycGateApplies(meta?.regulated, onchainRwa[selAsset]) && !kycOk
  // 交易所的 KYC 登錄是 VC 登錄時，提示改指向憑證頁（VC 登錄沒有 submitKYC）。
  const vcKyc = useVcKycRegistry(wallet.chainId, wallet.provider)
  const kycCredentialsHref = isVcKycRegistry(vcKyc, contracts ? String(contracts.kycRegistry.target) : null)
    ? paths.pepefi.credentials
    : null

  // 指數價超過合約的 maxPriceAge 時，開倉／平倉／清算在鏈上都會 revert
  // StalePrice。讓按鈕在送出之前就停用，而不是讓使用者付 gas 去撞牆。
  //
  // M1：上面那句註解原本只有開倉是真的——平倉按鈕從來沒被擋過。持倉表每一列
  // 可能是不同標的，所以給它一個「按標的查」的函式而不是單一布林值。下單面板
  // 也吃同一個函式，於是「為什麼不能下單」全站只有一份文案。
  const staleNoticeFor = useCallback(
    (asset: string) => stalenessNotice(live[asset as AssetId]?.freshness, ASSET_META[asset]?.symbol),
    [live],
  )

  // 後端代號與 bytes32 assetId 都收；代號比較好讀，也讓 API 錯誤訊息看得懂。
  const feed = useCandles(meta?.symbol ?? selAsset, interval)

  // 這個標的在鏈上的實際部位活動（全平台，不只自己的），取代原本借用的 Bybit 盤口。
  const activity = useMarketActivity(contracts, selAsset)
  const { assets: vaultAssets } = useVaultBacking(contracts)

  // null = 兩個來源都讀不到。不補任何替代數字，下游一律顯示「—」。
  const livePx = live[selAsset]?.usd ?? undefined

  // 未實現損益一律用合約讀數（getPositionValue − 保證金），跟投資組合頁同一個來源。
  // 以前這裡用鏈下參考價（CoinGecko／Coinbase）自己重算，同一個部位在終端機是 −7.46、
  // 在投資組合是 +0.00——參考價不是結算價，合約平倉時不會用它。見 lib/pepefi/positionPnl.ts。
  const livePositions: LivePos[] = useMemo(
    () => account.positions.map((p) => ({ ...p, livePnl: p.pnl })),
    [account.positions],
  )

  // 任何一個部位沒有數字（讀取失敗、無有效價格、價格過期），或有部位的 getPosition 本身讀不到
  // （unreadCount，不在列表裡），合計就是 null，畫面顯示「—」（審查 N1）。
  // 權益 = 可用保證金 + 各部位現在平倉可拿回的金額（鎖住的保證金＋未實現損益）。
  const { totalPnl, equity } = terminalTotals({
    positions: account.positions,
    freeMargin: account.freeMgn,
    unreadCount: account.unreadCount,
  })
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    // window.setInterval：這個元件有一個叫 setInterval 的 state setter（K 線週期）。
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000)
    return () => window.clearInterval(id)
  }, [])
  const freshness = dataFreshness({
    updatedAt: account.updatedAt,
    readFailed: account.readFailed,
    nowMs,
    staleAfterMs: POSITION_STALE_MS,
  })
  const freshnessLabel = freshnessText(freshness, account.updatedAt, POSITION_STALE_MS)
  // 市場狀態徽章：排定時段（使用者電腦的時鐘＝牆上時間）× 鏈上 assetMode。
  // 時段用牆上時間而不是區塊時間：「美股現在有沒有開」是現實世界的事；價齡才用鏈上時鐘。
  const assetModes = useAssetModes(contracts?.exchange, SELECTABLE_IDS)
  const nowSec = Math.floor(nowMs / 1000)
  const statusFor = useCallback(
    (id: AssetId) =>
      marketStatus({
        symbol: ASSET_META[id]?.symbol ?? id,
        nowSec,
        probe: assetModes[id] ?? { kind: 'unknown' },
      }),
    [assetModes, nowSec],
  )
  const selStatus = statusFor(selAsset)

  const fi = funding[selAsset]
  const rate = fi ? Number(fi.rate) : 0
  const fundingInterval = fundingIntervalOf(funding)

  // 漲跌幅改由 K 線算：first.open → last.close。舊版是拿「本次載入以來累積的
  // tick」算的，一進頁面永遠是 0.00%，重整就歸零，沒有參考價值。
  const firstK = feed.candles[0]
  const lastK = feed.candles[feed.candles.length - 1]
  const chg = firstK && lastK && firstK.o > 0 ? ((lastK.c - firstK.o) / firstK.o) * 100 : 0

  if (!wallet.isConnected) {
    return (
      <Box
        sx={{ minHeight: '70vh', display: 'grid', placeItems: 'center', bgcolor: C.bg, color: C.mut }}
      >
        {t.terminal.connectWallet}
      </Box>
    )
  }

  return (
    <Box
      ref={layout.ref}
      sx={{
        bgcolor: C.bg,
        color: C.ink,
        minHeight: '100dvh',
        p: { xs: 1.5, md: 2.5 },
        fontFamily: '"Satoshi", system-ui, sans-serif',
      }}
    >
      <Box sx={{ display: 'flex', mb: 1.5 }}>
        <PaperTradingBadge />
      </Box>

      <TerminalHeader />
      <MarketSelector selAsset={selAsset} onSelect={setSelAsset} statusFor={statusFor} />

      <MarketStatsBar
        meta={meta}
        livePx={livePx}
        curPrice={account.curPrice}
        markPrice={account.markPrice}
        chg={chg}
        chgWindow={feed.candles.length ? `${feed.candles.length}×${interval}` : undefined}
        rate={rate}
        funding={fi}
        priceInfo={live[selAsset]}
        vaultAssets={vaultAssets}
        tradingParams={tradingParams}
        marketStatus={selStatus}
        priceMeta={priceMeta}
      />

      {/* 版面分級。欄寬一律用 minmax(0, …)：1fr 的隱含最小值是 min-content，圖表
          canvas 與寬表格會拒絕縮到那之下，整個 grid 就被撐開、頁面長出橫向捲軸。
          三欄（wide）：訂單簿 │ 圖表 │ 下單
          兩欄（medium）：圖表 │ 下單，訂單簿收到圖表下方
          單欄（narrow/mobile）：全部堆疊，下單面板 sticky 貼頂不會捲走 */}
      <Box
        sx={{
          display: 'grid',
          gap: 1.5,
          gridTemplateColumns: layout.bookAsColumn
            ? 'minmax(200px, 240px) minmax(0, 1fr) minmax(300px, 340px)'
            : layout.tier === 'medium'
              ? 'minmax(0, 1fr) minmax(300px, 340px)'
              : 'minmax(0, 1fr)',
          alignItems: 'start',
        }}
      >
        {layout.bookAsColumn && (
          <Box sx={{ height: 520, display: 'flex' }}>
            <BookPanel symbol={meta?.symbol} activity={activity} />
          </Box>
        )}

        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, minWidth: 0 }}>
          <ChartPanel
            feed={feed}
            interval={interval}
            onIntervalChange={setInterval}
            indexPrice={account.curPrice}
            markPrice={account.markPrice}
          />

          {/* 空間不夠給訂單簿一整欄時，它降級成圖表下方的面板——不是消失。
              這個位置很寬，所以改成訂單簿與成交併排，否則右邊會空一大片。 */}
          {!layout.bookAsColumn && (
            <Box sx={{ height: 380, display: 'flex' }}>
              <BookPanel symbol={meta?.symbol} activity={activity} />
            </Box>
          )}
        </Box>

        <Box
          sx={{
            ...panel,
            p: 2,
            display: 'flex',
            flexDirection: 'column',
            gap: 1.5,
            minWidth: 0,
            // 單欄堆疊時下單面板貼頂：捲到持倉表也還看得到、按得到。
            ...(layout.tier === 'narrow' || layout.tier === 'mobile'
              ? { position: 'sticky', top: 8, zIndex: 2 }
              : {}),
          }}
        >
          <OrderTicket
            contracts={contracts}
            selAsset={selAsset}
            meta={meta}
            curPrice={account.curPrice}
            freeMgn={account.freeMgn}
            rate={rate}
            fundingInterval={fundingInterval}
            kycBlocked={kycBlocked}
            kycUnknown={kycUnknown}
            kycPending={kycPending}
            kycCredentialsHref={kycCredentialsHref}
            staleNotice={staleNoticeFor(selAsset)}
            marketStatus={selStatus}
            tradingParams={tradingParams}
            notify={notify}
            onFilled={account.refresh}
          />
          <AccountPanel
            contracts={contracts}
            equity={equity}
            freeMgn={account.freeMgn}
            totalPnl={totalPnl}
            freshness={freshness}
            freshnessLabel={freshnessLabel}
            unreadCount={account.unreadCount}
            usdcBal={account.usdcBal}
            usdtBal={account.usdtBal}
            stable={stable}
            setStable={setStable}
            notify={notify}
            onDeposited={account.refresh}
          />
        </Box>
      </Box>

      <PositionsPanel
        contracts={contracts}
        address={wallet.address ?? null}
        positions={livePositions}
        freshness={freshness}
        freshnessLabel={freshnessLabel}
        funding={funding}
        fundingInterval={fundingInterval}
        staleNoticeFor={staleNoticeFor}
        notify={notify}
        onRefresh={account.refresh}
        chainId={wallet.chainId ?? null}
      />

      {/* 版面偵錯 + 手動覆寫：自動分級處理預設，這個開關給「我知道我在幹嘛」的人。
          只有寬到足以放三欄時才有意義，其餘情況訂單簿本來就在下方。 */}
      {layout.width >= 1400 && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 1 }}>
          <Box
            component="button"
            type="button"
            onClick={layout.toggleBook}
            sx={{
              ...labelCss,
              fontSize: 10,
              minHeight: 32,
              px: 1.2,
              borderRadius: '7px',
              bgcolor: 'transparent',
              border: `1px solid ${C.line}`,
              color: C.mut,
              cursor: 'pointer',
              '@media (pointer: coarse)': { minHeight: 44 },
              '&:hover': { color: C.ink, borderColor: C.line2 },
            }}
          >
            {layout.bookCollapsed ? t.terminal.book.show : t.terminal.book.hide}
          </Box>
        </Box>
      )}
    </Box>
  )
}
