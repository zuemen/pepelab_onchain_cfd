import { useMemo, useState, useEffect, useCallback } from 'react'
import { useNavigate, useSearchParams } from 'react-router'

import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Grid from '@mui/material/Grid'
import Chip from '@mui/material/Chip'
import Alert from '@mui/material/Alert'
import Stack from '@mui/material/Stack'
import Button from '@mui/material/Button'
import Container from '@mui/material/Container'
import TextField from '@mui/material/TextField'
import Typography from '@mui/material/Typography'

import { useMode } from 'src/contexts/mode-context'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { useMarketSentiment } from 'src/hooks/useMarketSentiment'
import { useExchangeActivity } from 'src/hooks/useExchangeActivity'
import { useRegisteredTraders } from 'src/hooks/useRegisteredTraders'
import { useLargestOpenPositions } from 'src/hooks/useLargestOpenPositions'

import { t, interpolate } from 'src/locales'
import { MONO } from 'src/components/pepefi/brandKit'
import { WHALE_THRESHOLD, WHALE_THRESHOLD_OPTIONS } from 'src/lib/pepefi/whale'
import WhaleFeed from 'src/components/pepefi/whale/WhaleFeed'
import WhaleKpiRow from 'src/components/pepefi/whale/WhaleKpiRow'
import MarketSentimentBar from 'src/components/pepefi/whale/MarketSentimentBar'
import LargestOpenPositions from 'src/components/pepefi/whale/LargestOpenPositions'
import { describeScanWindow } from 'src/lib/pepefi/chainLogs'

// Whale Tracker：現在錢往哪流。
//
// 這一頁原本有 894 行，做的卻是四件互相不太相干的事：全站統計、交易員排行榜、
// 地址搜尋框、搜尋結果。真正的「鯨魚動向」反而完全不在這裡。
//
// 拆解的依據：
//  - **排行榜砍掉**。/marketplace 的 Star Trader Leaderboard 已經在排交易員，
//    而且能按 reputation / followers / PnL / ESG 排；這裡那份只能按累積成交量排，
//    是它的弱化重複。空出來的位置換成 Marketplace 結構上做不到的東西——
//    部位維度：最大未平倉 + 多空未平倉分布。
//  - **地址檢視搬去 /trader/:address**。那一頁本來就有 follower、stake、
//    reputation、slash 紀錄，兩邊各做一半的結果是誰也看不到完整的樣子。
//    這裡的搜尋框現在只是那一頁的入口。
//  - 於是這一頁只剩一件事，也就是它的名字所說的那件事。
//
// 職責分工變成：Marketplace 回答「我要跟單誰」，Whale Tracker 回答「錢往哪流」。

const isEthAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s)

export default function WhaleTrackerPage() {
  const { mode } = useMode()
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()

  const exchange = contracts?.exchange ?? null

  // 「多大才算鯨魚」依市場規模而定，不是一個可以寫死的常數——實測這條測試鏈
  // 一週 27 筆開倉、平均一筆 $1.2k，固定 $5k 會讓主角區永遠空著。
  const [threshold, setThreshold] = useState<bigint>(WHALE_THRESHOLD)
  const thresholdLabel =
    WHALE_THRESHOLD_OPTIONS.find(o => o.value === threshold)?.label ?? '$5k'

  const activity  = useExchangeActivity(exchange, wallet.provider, wallet.chainId, threshold)
  const sentiment = useMarketSentiment(exchange)
  const largest   = useLargestOpenPositions(exchange, activity.openTrades, 10)

  // 只問 feed 上真的會顯示的地址，而且結果會被 hook 快取，重掃不會重問。
  const feedAddresses = useMemo(
    () => [...new Set(activity.feed.map(t => t.owner))],
    [activity.feed],
  )
  const registered = useRegisteredTraders(contracts?.registry ?? null, feedAddresses)

  const [inputAddr, setInputAddr] = useState('')
  const [addrError, setAddrError] = useState<string | null>(null)

  const openTrader = useCallback((addr: string) => {
    if (!isEthAddr(addr)) {
      setAddrError(t.whale.page.lookupInvalid)
      return
    }
    setAddrError(null)
    navigate(`/trader/${addr}`)
  }, [navigate])

  // 舊連結相容：Dashboard 與 whale banner 曾經連到 /whale?addr=0x…，那時候
  // 搜尋結果就長在這一頁。結果搬走了，連結不能跟著壞掉，所以把它轉過去。
  const addrParam = searchParams.get('addr')
  useEffect(() => {
    if (addrParam && isEthAddr(addrParam)) navigate(`/trader/${addrParam}`, { replace: true })
  }, [addrParam, navigate])

  // 解構出 refetch 本身，不要把整個 hook 回傳物件放進 deps——那三個物件每次
  // render 都是新的，依賴它們等於沒有 useCallback。
  const { refetch: refetchActivity }  = activity
  const { refetch: refetchSentiment } = sentiment
  const { refetch: refetchLargest }   = largest

  const refreshAll = useCallback(() => {
    refetchActivity()
    refetchSentiment()
    refetchLargest()
  }, [refetchActivity, refetchSentiment, refetchLargest])

  // useContracts 在「沒有 provider」或「這條鏈沒有部署位址」時回 null。後者是
  // 連著錢包也會遇到的真實狀態（例如站在 Ethereum Sepolia），而不是死路：
  // 沒有這個判斷的話三個 hook 永遠不會啟動，畫面卻會一直寫著 "scanning…"，
  // 把「這裡沒有交易所」講成「還在讀取」。
  const ready = Boolean(exchange)

  const { scanRange } = activity
  // 掃描失敗時不能繼續說 "scanning…"，也不能把 0 當成答案端出去——那是
  // 「沒讀到」不是「沒有」。實測就撞到過：getBlock 被擠掉之後畫面停在
  // scanning… 而 KPI 顯示 0 筆、$0 成交量，看起來像鏈上真的沒人在交易。
  const scanFailed = Boolean(activity.error) && !scanRange
  const windowLabel = !ready
    ? t.whale.page.windowUnavailable
    : scanFailed
      ? t.whale.page.windowScanFailed
      : scanRange
        ? interpolate(t.whale.page.windowLast, {
            span: describeScanWindow(wallet.chainId, scanRange.to - scanRange.from),
          })
        : t.whale.page.windowScanning
  const rangeText = scanRange
    ? `#${scanRange.from.toLocaleString()}–#${scanRange.to.toLocaleString()}`
    : null

  const busy = activity.loading || sentiment.loading || largest.loading

  return (
    <Container maxWidth="lg" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* ── Header ──────────────────────────────────────────────────────────── */}
      <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 2 }}>
        <Box sx={{ flexGrow: 1, minWidth: 260 }}>
          <Typography variant="h4" sx={{ fontWeight: 'bold' }}>
            {t.whale.page.title}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {t.whale.page.subtitle}
          </Typography>
          <Stack direction="row" spacing={1} sx={{ mt: 1.5, flexWrap: 'wrap', gap: 1 }}>
            {/* 掃描範圍要寫在畫面上。舊版把滾動 7 天視窗標成 "all-time"，
                使用者會拿一週的數字當成全部歷史來判斷。 */}
            <Chip
              size="small"
              variant="outlined"
              label={interpolate(t.whale.page.window, { label: windowLabel })}
              title={t.whale.page.windowHint}
            />
            {rangeText && (
              <Chip
                size="small"
                variant="outlined"
                label={interpolate(t.whale.page.blocks, { range: rangeText })}
                sx={{ fontFamily: MONO }}
              />
            )}
          </Stack>

          {/* 門檻選擇器。只換篩子，不重掃鏈。 */}
          <Stack direction="row" spacing={1} sx={{ mt: 1.5, alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700 }}>
              {t.whale.page.threshold}
            </Typography>
            {WHALE_THRESHOLD_OPTIONS.map(opt => (
              <Chip
                key={opt.label}
                size="small"
                label={opt.label}
                onClick={() => setThreshold(opt.value)}
                color={opt.value === threshold ? 'primary' : 'default'}
                variant={opt.value === threshold ? 'filled' : 'outlined'}
                sx={{ fontFamily: MONO, fontWeight: 700, cursor: 'pointer' }}
              />
            ))}
          </Stack>
        </Box>

        <Button variant="text" onClick={refreshAll} disabled={busy} sx={{ textTransform: 'none' }}>
          {t.whale.page.refresh}
        </Button>
      </Box>

      {/* ── Address lookup ──────────────────────────────────────────────────── */}
      {/* 整張 "Address Lookup" 卡片壓成 header 下的一列：搜尋結果已經搬到
          /trader/:address，這裡只是入口，不該再佔一個區塊的份量。 */}
      <Card sx={{ p: 2, display: 'flex', gap: 1.5, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <TextField
          placeholder={t.whale.page.lookupPlaceholder}
          value={inputAddr}
          onChange={e => { setInputAddr(e.target.value); setAddrError(null) }}
          onKeyDown={e => e.key === 'Enter' && openTrader(inputAddr.trim())}
          error={Boolean(addrError)}
          helperText={addrError ?? ' '}
          slotProps={{
            htmlInput: { style: { fontFamily: MONO }, 'aria-label': t.whale.page.lookupAria },
          }}
          size="small"
          sx={{ flexGrow: 1, minWidth: 240 }}
        />
        <Button
          variant="contained"
          onClick={() => openTrader(inputAddr.trim())}
          disabled={!inputAddr.trim()}
          sx={{ mt: 0.25 }}
        >
          {t.whale.page.viewProfile}
        </Button>
      </Card>

      {!ready && (
        <Alert severity="info">
          {t.whale.page.notAvailable}
        </Alert>
      )}

      {activity.error && (
        <Alert
          severity="error"
          action={
            <Button color="inherit" size="small" onClick={refreshAll} disabled={busy}>
              {t.whale.page.retry}
            </Button>
          }
        >
          {activity.error}
        </Alert>
      )}

      {/* ── KPIs ────────────────────────────────────────────────────────────── */}
      <WhaleKpiRow
        totals={activity.totals}
        openInterest={ready && !(sentiment.loading && sentiment.total === 0n) ? sentiment.total : null}
        windowLabel={windowLabel}
        thresholdLabel={thresholdLabel}
        ready={ready && !scanFailed}
        loading={ready && activity.loading && activity.opened.length === 0}
      />

      {/* ── Feed（主）＋ 部位維度（輔） ──────────────────────────────────────── */}
      <Grid container spacing={3} alignItems="flex-start">
        <Grid size={{ xs: 12, md: 8 }}>
          <WhaleFeed
            trades={activity.feed}
            mode={mode}
            chainId={wallet.chainId}
            loading={activity.loading}
            progress={activity.progress}
            registered={registered}
            emptyTitle={scanFailed ? t.whale.page.scanFailedTitle : undefined}
            emptyHint={
              !ready
                ? t.whale.page.emptyDisconnected
                : scanFailed
                  ? t.whale.page.emptyScanFailed
                  // 掃到了交易、只是都在門檻以下，跟「這段時間沒有人交易」是
                  // 兩件不同的事。把數字說出來，使用者才知道該調門檻而不是
                  // 以為鏈上沒動靜。
                  : activity.totals.openedCount > 0
                    ? interpolate(t.whale.page.emptyBelowThreshold, {
                        count: activity.totals.openedCount,
                        threshold: thresholdLabel,
                      })
                    : rangeText
                      ? interpolate(t.whale.page.emptyNoTrades, { range: rangeText })
                      : undefined
            }
          />
        </Grid>

        <Grid size={{ xs: 12, md: 4 }}>
          <Stack spacing={3}>
            <MarketSentimentBar sentiment={sentiment} mode={mode} ready={ready} />
            <LargestOpenPositions data={largest} mode={mode} ready={ready} />
          </Stack>
        </Grid>
      </Grid>

      <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', display: 'block' }}>
        {scanRange
          ? interpolate(t.whale.page.footer, { range: rangeText ?? '', window: windowLabel })
          : t.whale.page.footerPending}
      </Typography>
    </Container>
  )
}
