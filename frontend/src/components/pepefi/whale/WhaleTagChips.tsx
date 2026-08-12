import type { Theme } from '@mui/material/styles'
import type { WhaleTag, WhaleTone } from 'src/lib/pepefi/whale'

import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import { alpha } from '@mui/material/styles'

// 標籤的顏色在這裡才變成實際的顏色。
//
// 舊的 whaleTier() 直接在 lib 裡回 `{ bgcolor: 'rgba(0,184,217,0.16)', color: '#00b8d9' }`，
// 於是 dark/light 切換、品牌換色、白牌部署全都繞不過那幾個字面值。現在 lib 只說
// 「這是金色的意圖」，實際的色票由 theme 在 render 時決定。

const TONE_PALETTE: Record<WhaleTone, (t: Theme) => string> = {
  gold:   t => t.palette.secondary.main,
  danger: t => t.palette.error.main,
  info:   t => t.palette.info.main,
}

export default function WhaleTagChips({ tags }: { tags: WhaleTag[] }) {
  if (tags.length === 0) return null

  return (
    <Stack direction="row" spacing={0.5} sx={{ flexWrap: 'wrap', gap: 0.5 }}>
      {tags.map(tag => (
        <Chip
          key={tag.id}
          label={tag.label}
          size="small"
          title={tag.hint}
          sx={{
            height: 20,
            fontSize: '0.6875rem',
            fontWeight: 700,
            color:       theme => TONE_PALETTE[tag.tone](theme),
            bgcolor:     theme => alpha(TONE_PALETTE[tag.tone](theme), 0.16),
            border:      '1px solid',
            borderColor: theme => alpha(TONE_PALETTE[tag.tone](theme), 0.24),
          }}
        />
      ))}
    </Stack>
  )
}
