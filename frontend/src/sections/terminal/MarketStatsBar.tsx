import type { LivePrice } from 'src/hooks/useLivePrices'
import type { AssetMeta } from 'src/lib/pepefi/assetMeta'
import type { FundingInfo } from 'src/hooks/useFundingData'

import Box from '@mui/material/Box'

import { fUsd, fNum, fromUnits } from 'src/lib/pepefi/format'

import { Stat } from './Atoms'
import { C, panel, monoCss, labelCss } from './terminal-theme'

/** 行情列：顯示價、漲跌、index / mark、funding、未平倉量與報價來源。 */
export function MarketStatsBar({
  meta,
  livePx,
  curPrice,
  markPrice,
  chg,
  chgWindow,
  rate,
  funding,
  priceInfo,
  vaultAssets,
}: {
  meta?: AssetMeta
  livePx?: number
  curPrice: bigint
  markPrice: bigint
  chg: number
  /** 漲跌幅是「多長一段時間」的，例如 300×1h。不標的話這個數字沒有意義。 */
  chgWindow?: string
  rate: number
  funding?: FundingInfo
  priceInfo?: LivePrice
  /** InsuranceVault 資產（18 dp）。null = 讀不到或未部署。 */
  vaultAssets?: bigint | null
}) {
  return (
    <Box
      sx={{
        ...panel,
        p: 2,
        mb: 1.5,
        display: 'flex',
        alignItems: 'center',
        gap: { xs: 2.5, md: 5 },
        flexWrap: 'wrap',
      }}
    >
      <Box>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5 }}>
          <Box sx={{ fontFamily: '"Clash Display", sans-serif', fontWeight: 600, fontSize: 22 }}>
            {meta?.symbol}
            <span style={{ color: C.mut, fontSize: 13 }}>-PERP</span>
          </Box>
        </Box>
        <Box sx={{ ...labelCss, mt: 0.3 }}>{meta?.name}</Box>
      </Box>

      <Box>
        <Box sx={{ ...monoCss, fontSize: 26, fontWeight: 700 }}>
          {livePx !== undefined ? fUsd(livePx) : fUsd(fromUnits(curPrice, 18))}
        </Box>
        <Box sx={{ ...monoCss, fontSize: 13, color: chg >= 0 ? C.green : C.red }}>
          {chg >= 0 ? '▲' : '▼'} {fNum(Math.abs(chg))}%
          {chgWindow && (
            <Box component="span" sx={{ color: C.mut, ml: 0.6, fontSize: 11 }}>
              {chgWindow}
            </Box>
          )}
        </Box>
        <Box sx={{ ...labelCss, mt: 0.2, fontSize: 9.5 }}>display price</Box>
      </Box>

      <Stat
        label="Index (oracle · settles here)"
        v={fUsd(fromUnits(curPrice, 18))}
        hint={
          '鏈上預言機價格，也是你實際成交的價格。\n\n' +
          '開倉、平倉、清算全部以這個價格結算，跟上面的顯示價和 K 線圖都無關——' +
          '那兩個是外部行情的參考。預言機由 keeper 定期寫入鏈上，所以會比市場慢一些。'
        }
      />
      <Stat
        label="Mark (OI premium)"
        hint={
          '在指數價之上，依多空失衡加減一個溢價後的價格。\n\n' +
          '多單明顯多於空單時 mark 會高於 index，反之則低。用途是讓損益與清算反映' +
          '「大家都站同一邊」的風險，而不是只看預言機報價。'
        }
        v={markPrice > 0n ? fUsd(fromUnits(markPrice, 18)) : '—'}
        color={
          markPrice > curPrice
            ? C.green
            : markPrice > 0n && markPrice < curPrice
              ? C.red
              : C.mut
        }
      />
      <Stat
        label="Funding"
        hint={
          '多空之間定期互付的資金費，用來把價格拉回指數。\n\n' +
          '正值 = 持多單的人付錢給持空單的人（代表多單過熱）；負值相反。' +
          '你持倉期間會依這個費率累積成本或收益。'
        }
        v={`${rate >= 0 ? '+' : ''}${fNum(rate / 100, { dp: 4 })}%`}
        color={rate > 0 ? C.red : rate < 0 ? C.green : C.mut}
      />
      <Stat
        label="Open interest L/S"
        hint={
          '這個標的目前鏈上未平倉的多單 / 空單名目金額。\n\n' +
          '兩邊差距越大代表市場越偏向一邊，funding 費率也會跟著變大。' +
          '顯示 "—" 代表鏈上讀取失敗，不是沒有部位。'
        }
        v={
          funding
            ? `${fNum(fromUnits(funding.longOI, 18), { dp: 1 })} / ${fNum(fromUnits(funding.shortOI, 18), { dp: 1 })}`
            : '—'
        }
      />
      {/* 保險金庫的規模＝極端行情下的兜底資金。null（讀不到／未部署）顯示 '—'，
          0 就顯示 $0——一個沒有後盾的永續平台，使用者有權在下單前看到。 */}
      <Stat
        label="Vault backing"
        hint={
          '保險金庫目前的資金規模——極端行情下用來吸收穿倉損失的後盾。\n\n' +
          '顯示 $0 代表金庫已部署但還沒有人存入資金，此時平台沒有額外的償付緩衝。' +
          '這是測試網的真實狀態，不是顯示錯誤。'
        }
        v={vaultAssets == null ? '—' : fUsd(fromUnits(vaultAssets, 18))}
        color={vaultAssets === 0n ? C.red : undefined}
      />

      {/*
        顯示來源與「指數價的鏈上年齡」。在這之前這個徽章不論指數價多舊都是綠色的
        live —— 2026-08-06 Base Sepolia 的價格已經 9.5 天沒更新，UI 仍然顯示
        live，使用者按下下單才吃到 StalePrice revert。年齡由合約自己的
        maxPriceAge 分級，所以徽章說的和鏈上接受的是同一件事。
      */}
      <Box
        sx={{
          ml: 'auto',
          ...labelCss,
          color:
            priceInfo?.freshness.level === 'stale'
              ? C.red
              : priceInfo?.freshness.level === 'aging'
                ? C.lime
                : priceInfo?.isMock
                  ? C.mut
                  : C.green,
        }}
      >
        ●{' '}
        {priceInfo?.source === 'coingecko'
          ? 'display · coingecko'
          : priceInfo?.source === 'oracle'
            ? 'display · on-chain oracle'
            : 'simulated feed'}
        {priceInfo?.freshness ? ` · index ${priceInfo.freshness.label}` : ''}
      </Box>
    </Box>
  )
}
