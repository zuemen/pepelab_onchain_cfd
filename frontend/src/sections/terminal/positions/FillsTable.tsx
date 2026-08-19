import type { Fill } from 'src/hooks/useUserFills'

import Box from '@mui/material/Box'

import { t } from 'src/locales'
import { explorerTx } from 'src/lib/pepefi/notify'
import { ASSET_META } from 'src/lib/pepefi/assetMeta'
import { fUsd, fNum, fromUnits } from 'src/lib/pepefi/format'

import { C, monoCss, labelCss } from '../terminal-theme'

const COLS = '.9fr 1fr .8fr 1fr 1fr .9fr'

const KIND_LABEL: Record<Fill['kind'], string> = {
  opened: t.terminal.fills.kind.opened,
  closed: t.terminal.fills.kind.closed,
  liquidated: t.terminal.fills.kind.liquidated,
}

export function FillsTable({
  fills,
  loading,
  error,
  chainId,
}: {
  fills: Fill[]
  loading: boolean
  error: string | null
  /** 用來組區塊瀏覽器連結，讓每一筆都能點去鏈上驗證。 */
  chainId: number | null
}) {
  if (error) {
    return <Msg color={C.red}>{error}</Msg>
  }
  if (!fills.length) {
    return <Msg>{loading ? t.terminal.fills.loading : t.terminal.fills.empty}</Msg>
  }

  return (
    <Box sx={{ overflowX: 'auto' }}>
      <Box sx={{ minWidth: 640 }}>
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: COLS,
            px: 2,
            py: 1,
            ...labelCss,
            borderBottom: `1px solid ${C.line}`,
          }}
        >
          {[
            t.terminal.fills.column.type,
            t.terminal.fills.column.asset,
            t.terminal.fills.column.side,
            t.terminal.fills.column.price,
            t.terminal.fills.column.pnl,
            t.terminal.fills.column.tx,
          ].map((h) => (
            <Box key={h}>{h}</Box>
          ))}
        </Box>

        {fills.slice(0, 25).map((f) => {
          const sym = f.asset ? (ASSET_META[f.asset]?.symbol ?? f.asset.slice(0, 8)) : '—'
          const pnl = f.pnl !== undefined ? fromUnits(f.pnl, 18) : null
          const kindColor =
            f.kind === 'opened' ? C.ink : f.kind === 'liquidated' ? C.red : C.lime

          return (
            <Box
              key={f.key}
              sx={{
                display: 'grid',
                gridTemplateColumns: COLS,
                px: 2,
                py: 1.1,
                alignItems: 'center',
                borderBottom: `1px solid ${C.line}`,
                ...monoCss,
                fontSize: 12.5,
                '&:hover': { bgcolor: 'rgba(255,255,255,.02)' },
              }}
            >
              <Box sx={{ color: kindColor, fontWeight: 700 }}>{KIND_LABEL[f.kind]}</Box>
              <Box>{sym}</Box>
              <Box sx={{ color: f.isLong === undefined ? C.mut : f.isLong ? C.green : C.red }}>
                {f.isLong === undefined
                  ? '—'
                  : f.isLong
                    ? t.terminal.fills.long
                    : t.terminal.fills.short}
              </Box>
              <Box>{f.price !== undefined ? fUsd(fromUnits(f.price, 18)) : '—'}</Box>
              <Box sx={{ color: pnl === null ? C.mut : pnl >= 0 ? C.green : C.red }}>
                {pnl === null ? '—' : fNum(pnl, { dp: 4, signed: true })}
              </Box>
              <Box>
                {(() => {
                  const url = explorerTx(f.txHash, chainId)
                  return url ? (
                    <Box
                      component="a"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      sx={{ color: C.mut, textDecoration: 'none', '&:hover': { color: C.lime } }}
                    >
                      {f.txHash.slice(0, 8)}↗
                    </Box>
                  ) : (
                    <Box sx={{ color: C.mut }}>{f.txHash.slice(0, 8)}</Box>
                  )
                })()}
              </Box>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

function Msg({ children, color }: { children: React.ReactNode; color?: string }) {
  return (
    <Box sx={{ p: 4, textAlign: 'center', color: color ?? C.mut, ...monoCss, fontSize: 13 }}>
      {children}
    </Box>
  )
}
