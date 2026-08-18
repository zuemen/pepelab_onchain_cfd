import type { LivePos, TerminalContracts } from '../types'
import type { FundingData } from 'src/hooks/useFundingData'

import { useState } from 'react'

import Box from '@mui/material/Box'

import { useUserFills } from 'src/hooks/useUserFills'

import { t, interpolate } from 'src/locales'

import { FillsTable } from './FillsTable'
import { FundingTable } from './FundingTable'
import { PositionsTable } from './PositionsTable'
import { C, panel, monoCss, labelCss } from '../terminal-theme'

type Tab = 'positions' | 'fills' | 'funding'

/**
 * 持倉區的分頁殼。
 *
 * 沒有 "Orders" 分頁是刻意的：本平台的 PerpetualExchange 只有市價開平倉，沒有
 * 掛單簿、沒有未成交的限價單。放一個永遠空的分頁只會讓人以為功能壞了。
 */
export function PositionsPanel({
  contracts,
  address,
  positions,
  funding,
  staleNoticeFor,
  notify,
  onRefresh,
  chainId,
}: {
  contracts: TerminalContracts
  address: string | null
  positions: LivePos[]
  funding: FundingData
  /** M1：平倉的 stale 擋單原因（null = 可以平）。往下傳給 PositionsTable。 */
  staleNoticeFor: (asset: string) => string | null
  notify: (msg: string, ok: boolean) => void
  onRefresh: () => Promise<void>
  chainId: number | null
}) {
  const [tab, setTab] = useState<Tab>('positions')

  // 只有切到 Fills 才去掃鏈上事件——queryFilter 掃 5000 個 block 不便宜，
  // 沒人看的時候不該跑。
  const fills = useUserFills(tab === 'fills' ? contracts : null, address)

  const tabs: [Tab, string][] = [
    ['positions', interpolate(t.terminal.panel.tabPositions, { count: positions.length })],
    ['fills', t.terminal.panel.tabFills],
    ['funding', t.terminal.panel.tabFunding],
  ]

  const refreshCurrent = async () => {
    if (tab === 'fills') await fills.refresh()
    else await onRefresh()
  }

  return (
    <Box sx={{ ...panel, mt: 1.5 }}>
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1.5,
          pt: 1.5,
          pb: 1.2,
          borderBottom: `1px solid ${C.line}`,
        }}
      >
        {tabs.map(([id, text]) => {
          const on = tab === id
          return (
            <Box
              key={id}
              component="button"
              type="button"
              onClick={() => setTab(id)}
              aria-pressed={on}
              sx={{
                ...labelCss,
                fontSize: 10.5,
                minHeight: 32,
                px: 1.2,
                borderRadius: '7px',
                cursor: 'pointer',
                bgcolor: 'transparent',
                border: `1px solid ${on ? C.line2 : 'transparent'}`,
                color: on ? C.lime : C.mut,
                '@media (pointer: coarse)': { minHeight: 44 },
                '&:hover': { color: on ? C.lime : C.ink },
              }}
            >
              {text}
            </Box>
          )
        })}

        <Box
          component="button"
          type="button"
          onClick={() => void refreshCurrent()}
          sx={{
            ml: 'auto',
            ...monoCss,
            fontSize: 12,
            minHeight: 32,
            px: 1,
            bgcolor: 'transparent',
            border: 'none',
            color: C.mut,
            cursor: 'pointer',
            '@media (pointer: coarse)': { minHeight: 44 },
            '&:hover': { color: C.ink },
          }}
        >
          {t.terminal.panel.refresh}
        </Box>
      </Box>

      {tab === 'positions' && (
        <PositionsTable
          contracts={contracts}
          positions={positions}
          staleNoticeFor={staleNoticeFor}
          notify={notify}
          onRefresh={onRefresh}
        />
      )}
      {tab === 'fills' && (
        <FillsTable
          fills={fills.fills}
          loading={fills.loading}
          error={fills.error}
          chainId={chainId}
        />
      )}
      {tab === 'funding' && <FundingTable funding={funding} />}
    </Box>
  )
}
