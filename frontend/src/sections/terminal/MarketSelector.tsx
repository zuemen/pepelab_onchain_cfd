import type { AssetId } from './types'
import type { MarketStatus } from 'src/lib/pepefi/marketStatus'

import Box from '@mui/material/Box'

import { t } from 'src/locales'
import { assetPolicy } from 'src/tenant'
import { ASSETS_LIST } from 'src/lib/pepefi/assetMeta'

import { RwaInfoLink } from 'src/components/pepefi/rwa/RwaInfoLink'

import { C, monoCss } from './terminal-theme'
import { MarketStatusBadge } from './MarketStatusBadge'

/**
 * 可選標的只列白標租戶白名單內的資產（src/tenant/assetPolicy.ts）。這裡只影響「新開
 * 部位選哪一檔」；持倉表列的是使用者全部的部位，不受白名單影響。
 */
const SELECTABLE = assetPolicy.selectable(ASSETS_LIST)

/**
 * 標的分頁列。受管制標的（需 KYC）前面掛鎖頭；休市、只能減倉、暫停的標的在代號後面
 * 掛短標籤（開盤與 24/7 不掛，見 MarketStatusBadge）。
 */
export function MarketSelector({
  selAsset,
  onSelect,
  statusFor,
}: {
  selAsset: AssetId
  onSelect: (id: AssetId) => void
  statusFor?: (id: AssetId) => MarketStatus
}) {
  const anyReduceOnly = statusFor ? SELECTABLE.some((a) => statusFor(a.id as AssetId).kind === 'reduceOnly') : false
  return (
    <>
    <Box
      sx={{
        display: 'flex',
        gap: 0.5,
        overflowX: 'auto',
        pb: 1,
        mb: 1.5,
        // 標的放不下時要看得出來還能捲，不把捲軸藏掉。
        '&::-webkit-scrollbar': { height: 6 },
        '&::-webkit-scrollbar-thumb': { bgcolor: C.line2, borderRadius: 3 },
      }}
    >
      {SELECTABLE.map((a) => {
        const on = a.id === selAsset
        return (
          <Box
            key={a.id}
            onClick={() => onSelect(a.id as AssetId)}
            sx={{
              cursor: 'pointer',
              px: 1.6,
              py: 0.8,
              borderRadius: '9px',
              whiteSpace: 'nowrap',
              ...monoCss,
              fontSize: 13,
              fontWeight: 700,
              bgcolor: on ? C.lime : 'transparent',
              color: on ? '#0a0d07' : C.mut,
              border: `1px solid ${on ? C.lime : C.line}`,
              transition: '.15s',
              '&:hover': { color: on ? '#0a0d07' : C.ink, borderColor: on ? C.lime : C.line2 },
            }}
          >
            {a.regulated ? '🔒 ' : ''}
            {a.ticker}
            {statusFor && (
              <Box component="span" sx={{ ml: 0.8, verticalAlign: 'middle' }}>
                <MarketStatusBadge status={statusFor(a.id as AssetId)} variant="short" onAccent={on} />
              </Box>
            )}
          </Box>
        )
      })}
      {/* 參照資產、准入、價格來源與休市規則的揭露頁（/rwa）。 */}
      <Box sx={{ alignSelf: 'center', px: 1, flexShrink: 0 }}>
        <RwaInfoLink dense />
      </Box>
    </Box>
    {/* 只掛「只能減倉」看不出原因，整排鎖住會像網站壞了。 */}
    {anyReduceOnly && (
      <Box data-testid="market-reduce-only-hint" sx={{ mb: 1.5, mt: -0.5, fontSize: 12.5, lineHeight: 1.5, color: C.mut }}>
        {t.status.market.reduceOnlyHint}
      </Box>
    )}
    </>
  )
}
