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

      <Stat label="Index (oracle · settles here)" v={fUsd(fromUnits(curPrice, 18))} />
      <Stat
        label="Mark (OI premium)"
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
        v={`${rate >= 0 ? '+' : ''}${fNum(rate / 100, { dp: 4 })}%`}
        color={rate > 0 ? C.red : rate < 0 ? C.green : C.mut}
      />
      <Stat
        label="Open interest L/S"
        v={
          funding
            ? `${fNum(fromUnits(funding.longOI, 18), { dp: 1 })} / ${fNum(fromUnits(funding.shortOI, 18), { dp: 1 })}`
            : '—'
        }
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
