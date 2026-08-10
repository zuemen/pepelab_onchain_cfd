import type { AssetId, LivePos } from './types'

import { useMemo, useState, useCallback } from 'react'

import Box from '@mui/material/Box'
import Snackbar from '@mui/material/Snackbar'

import { useKYC } from 'src/hooks/useKYC'
import { useCandles } from 'src/hooks/useCandles'
import { useContracts } from 'src/hooks/useContracts'
import { useStablecoin } from 'src/hooks/useStablecoin'
import { useLivePrices } from 'src/hooks/useLivePrices'
import { useFundingData } from 'src/hooks/useFundingData'
import { useVaultBacking } from 'src/hooks/useVaultBacking'
import { useTerminalLayout } from 'src/hooks/useTerminalLayout'
import { useMarketActivity } from 'src/hooks/useMarketActivity'
import { useTerminalAccount } from 'src/hooks/useTerminalAccount'

import { ASSET_IDS } from 'src/contracts/addresses'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { ASSET_META } from 'src/lib/pepefi/assetMeta'
import { bybitSymbolFor } from 'src/lib/pepefi/bybitMarket'
import { type Interval, DEFAULT_INTERVAL } from 'src/lib/pepefi/candles'
import { blocksTrading, stalenessNotice } from 'src/lib/pepefi/priceFreshness'

import PaperTradingBadge from 'src/components/pepefi/PaperTradingBadge'

import { BookPanel } from './book/BookPanel'
import { ChartPanel } from './chart/ChartPanel'
import { TerminalHeader } from './TerminalHeader'
import { MarketSelector } from './MarketSelector'
import { MarketStatsBar } from './MarketStatsBar'
import { OrderTicket } from './ticket/OrderTicket'
import { AccountPanel } from './ticket/AccountPanel'
import { PositionsPanel } from './positions/PositionsPanel'
import { C, panel, monoCss, labelCss } from './terminal-theme'

/**
 * 終端機版面骨架與共用狀態的擁有者。
 *
 * 只保留「多個面板都要用」的狀態：選中標的、鏈上帳戶、即時報價、toast。表單類的
 * 狀態（方向、槓桿、保證金、入金金額）由各自的面板持有，避免每次打字都重繪整頁。
 */
export function TerminalView() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const live = useLivePrices()
  const funding = useFundingData(contracts?.exchange ?? null)

  const [selAsset, setSelAsset] = useState<AssetId>(ASSET_IDS.sBTC)
  const [interval, setInterval] = useState<Interval>(DEFAULT_INTERVAL)
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null)

  const layout = useTerminalLayout()

  const account = useTerminalAccount(contracts, wallet.address ?? null, selAsset)
  const { stable, setStable } = useStablecoin(contracts)
  const { isVerified: kycOk, isUnknown: kycUnknown, isPending: kycPending } = useKYC(contracts?.kycRegistry ?? null, wallet.address ?? null)

  const meta = ASSET_META[selAsset]
  const kycBlocked = (meta?.regulated ?? false) && !kycOk

  // 指數價超過合約的 maxPriceAge 時，開倉／平倉／清算在鏈上都會 revert
  // StalePrice。讓按鈕在送出之前就停用，而不是讓使用者付 gas 去撞牆。
  const freshness = live[selAsset]?.freshness
  const staleBlocked = freshness ? blocksTrading(freshness) : false

  // M1：上面那句註解原本只有開倉是真的——平倉按鈕從來沒被擋過。持倉表每一列
  // 可能是不同標的，所以給它一個「按標的查」的函式而不是單一布林值。
  const staleNoticeFor = useCallback(
    (asset: string) => stalenessNotice(live[asset as AssetId]?.freshness, ASSET_META[asset]?.symbol),
    [live],
  )

  // 後端代號與 bytes32 assetId 都收；代號比較好讀，也讓 API 錯誤訊息看得懂。
  const feed = useCandles(meta?.symbol ?? selAsset, interval)

  // 只有加密貨幣在 Bybit 有對應永續合約可以對照盤口；其餘標的拿到 undefined，
  // BookPanel 會改顯示鏈上的 OI / funding。
  const bybitSymbol = bybitSymbolFor(meta?.symbol)

  // 這個標的在鏈上的實際部位活動（全平台，不只自己的），取代原本借用的 Bybit 盤口。
  const activity = useMarketActivity(contracts, selAsset)
  const { assets: vaultAssets } = useVaultBacking(contracts)

  const notify = useCallback((msg: string, ok: boolean) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 5000)
  }, [])

  const livePx = live[selAsset]?.usd

  // 以即時價重算未實現損益，不等鏈上刷新。
  const livePositions: LivePos[] = useMemo(
    () =>
      account.positions.map((p) => {
        const lp = live[p.asset as AssetId]?.usd
        const cur = lp ? BigInt(Math.round(lp * 1e8)) * 10n ** 10n : p.cur
        const size = p.entryPrice > 0n ? (p.margin * p.leverage * 10n ** 18n) / p.entryPrice : 0n
        let pnl = ((cur - p.entryPrice) * size) / 10n ** 18n
        if (!p.isLong) pnl = -pnl
        return { ...p, cur, livePnl: pnl }
      }),
    [account.positions, live],
  )

  const totalPnl = livePositions.reduce((a, p) => a + p.livePnl, 0n)
  const equity = account.freeMgn + totalPnl
  const fi = funding[selAsset]
  const rate = fi ? Number(fi.rate) : 0

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
        Connect wallet to open the terminal.
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
      <Snackbar open={!!toast} anchorOrigin={{ vertical: 'top', horizontal: 'center' }}>
        <Box
          sx={{
            ...panel,
            px: 2,
            py: 1.2,
            borderColor: toast?.ok ? C.line2 : C.redDim,
            bgcolor: C.panel2,
            ...monoCss,
            fontSize: 13,
            color: toast?.ok ? C.green : C.red,
          }}
        >
          {toast?.msg}
        </Box>
      </Snackbar>

      <Box sx={{ display: 'flex', mb: 1.5 }}>
        <PaperTradingBadge />
      </Box>

      <TerminalHeader />
      <MarketSelector selAsset={selAsset} onSelect={setSelAsset} />

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
            <BookPanel
              bybitSymbol={bybitSymbol}
              symbol={meta?.symbol}
              activity={activity}
              active
            />
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
              <BookPanel
                bybitSymbol={bybitSymbol}
                symbol={meta?.symbol}
                activity={activity}
                active
                split
              />
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
            kycBlocked={kycBlocked}
            kycUnknown={kycUnknown}
            kycPending={kycPending}
            staleBlocked={staleBlocked}
            staleLabel={freshness?.label}
            notify={notify}
            onFilled={account.refresh}
          />
          <AccountPanel
            contracts={contracts}
            equity={equity}
            freeMgn={account.freeMgn}
            totalPnl={totalPnl}
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
        funding={funding}
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
            {layout.bookCollapsed ? '顯示訂單簿欄' : '收合訂單簿欄'}
          </Box>
        </Box>
      )}
    </Box>
  )
}
