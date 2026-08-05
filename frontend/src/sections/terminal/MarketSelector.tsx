import type { AssetId } from './types'

import Box from '@mui/material/Box'

import { ASSETS_LIST } from 'src/lib/pepefi/assetMeta'

import { C, monoCss } from './terminal-theme'

/** 標的分頁列。受管制標的（需 KYC）前面掛鎖頭。 */
export function MarketSelector({
  selAsset,
  onSelect,
}: {
  selAsset: AssetId
  onSelect: (id: AssetId) => void
}) {
  return (
    <Box
      sx={{
        display: 'flex',
        gap: 0.5,
        overflowX: 'auto',
        pb: 1,
        mb: 1.5,
        '&::-webkit-scrollbar': { height: 0 },
      }}
    >
      {ASSETS_LIST.map((a) => {
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
            {a.symbol}
          </Box>
        )
      })}
    </Box>
  )
}
