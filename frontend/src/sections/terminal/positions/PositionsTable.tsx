import { useState } from 'react'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'

import { ASSET_META } from 'src/lib/pepefi/assetMeta'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { fUsd, fNum, fromUnits } from 'src/lib/pepefi/format'

import { C, monoCss, labelCss } from '../terminal-theme'
import { asTx, type LivePos, type TerminalContracts } from '../types'

/** 欄寬定義只寫一次，表頭與資料列共用——分開寫就會慢慢對不齊。 */
const COLS = '1fr .7fr 1fr 1fr 1fr .6fr 1.1fr .9fr'

export function PositionsTable({
  contracts,
  positions,
  staleNoticeFor,
  notify,
  onRefresh,
}: {
  contracts: TerminalContracts
  positions: LivePos[]
  /**
   * M1：`closePosition` 走的是同一顆 oracle，價格過期一樣 revert StalePrice。
   * TerminalView 的註解早就寫了「開倉／平倉／清算在鏈上都會 revert」，但實際上
   * 只有開倉被擋。回傳 null = 這檔可以平倉；回傳字串 = 擋單原因（直接顯示給人看）。
   */
  staleNoticeFor: (asset: string) => string | null
  notify: (msg: string, ok: boolean) => void
  onRefresh: () => Promise<void>
}) {
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const closePos = async (id: bigint, asset: string) => {
    if (!contracts) return
    const blocked = staleNoticeFor(asset)
    if (blocked) {
      notify(blocked, false)
      return
    }
    const k = String(id)
    setBusy((p) => ({ ...p, [k]: true }))
    try {
      const tx = asTx(await contracts.exchange.closePosition(id))
      await tx.wait()
      notify('Closed ✓', true)
      await onRefresh()
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy((p) => ({ ...p, [k]: false }))
    }
  }

  return (
    // 面板外框與分頁列由 PositionsPanel 提供，這裡只負責表格本身。
    <Box>
      {/* 寬表格自己橫向捲，不要把外層版面撐開。 */}
      <Box sx={{ overflowX: 'auto' }}>
        <Box sx={{ minWidth: 720 }}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: COLS,
              px: 2,
              py: 1,
              ...labelCss,
              borderTop: `1px solid ${C.line}`,
              borderBottom: `1px solid ${C.line}`,
            }}
          >
            {['Asset', 'Side', 'Entry', 'Mark', 'Margin', 'Lev', 'PnL', ''].map((h, i) => (
              <Box key={h || `sp-${i}`}>{h}</Box>
            ))}
          </Box>

          {positions.length === 0 ? (
            <Box sx={{ p: 4, textAlign: 'center', color: C.mut, ...monoCss, fontSize: 13 }}>
              no open positions
            </Box>
          ) : (
            positions.map((p) => {
              const sym = ASSET_META[p.asset]?.symbol ?? p.asset.slice(0, 8)
              const pnl = fromUnits(p.livePnl, 18)
              const k = String(p.id)
              const stale = staleNoticeFor(p.asset)
              return (
                <Box
                  key={k}
                  sx={{
                    display: 'grid',
                    gridTemplateColumns: COLS,
                    px: 2,
                    py: 1.3,
                    alignItems: 'center',
                    borderBottom: `1px solid ${C.line}`,
                    ...monoCss,
                    fontSize: 13,
                    '&:hover': { bgcolor: 'rgba(255,255,255,.02)' },
                  }}
                >
                  <Box sx={{ fontWeight: 700 }}>{sym}</Box>
                  <Box sx={{ color: p.isLong ? C.green : C.red, fontWeight: 700 }}>
                    {p.isLong ? 'LONG' : 'SHORT'}
                  </Box>
                  <Box>{fUsd(fromUnits(p.entryPrice, 18))}</Box>
                  <Box>{fUsd(fromUnits(p.cur, 18))}</Box>
                  <Box>{fNum(fromUnits(p.margin, 18))}</Box>
                  <Box>{String(p.leverage)}×</Box>
                  <Box sx={{ color: pnl >= 0 ? C.green : C.red, fontWeight: 700 }}>
                    {fNum(pnl, { dp: 4, signed: true })}
                  </Box>
                  <Box>
                    <Button
                      onClick={() => void closePos(p.id, p.asset)}
                      disabled={busy[k] || !!stale}
                      // 灰掉的按鈕一定要說明原因，否則使用者只會一直重按。
                      title={stale ?? undefined}
                      sx={{
                        ...monoCss,
                        fontSize: 11.5,
                        fontWeight: 700,
                        textTransform: 'none',
                        py: 0.4,
                        px: 1.4,
                        borderRadius: '7px',
                        color: stale ? C.red : C.ink,
                        border: `1px solid ${stale ? C.redDim : C.line}`,
                        '&:hover': { borderColor: C.red, color: C.red, bgcolor: C.redDim },
                      }}
                    >
                      {busy[k] ? '…' : stale ? '價格過期' : 'Close'}
                    </Button>
                  </Box>
                </Box>
              )
            })
          )}
        </Box>
      </Box>
    </Box>
  )
}
