import type { AssetMeta } from 'src/lib/pepefi/assetMeta'

import { useState } from 'react'

import Box from '@mui/material/Box'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'

import { prettyError } from 'src/lib/pepefi/errorMessages'
import { fUsd, fNum, fToken, fromUnits } from 'src/lib/pepefi/format'

import { Row } from '../Atoms'
import { asTx, tryParse, type AssetId } from '../types'
import { C, panel, monoCss, labelCss } from '../terminal-theme'

type Contracts = any

/**
 * 下單面板。
 *
 * 方向 / 槓桿 / 保證金三個欄位與送單流程都由自己持有——它們只有這裡在用，提到
 * 上層只會讓每次打字都重繪整個終端機（包含圖表）。
 */
export function OrderTicket({
  contracts,
  selAsset,
  meta,
  curPrice,
  freeMgn,
  rate,
  kycBlocked,
  notify,
  onFilled,
}: {
  contracts: Contracts
  selAsset: AssetId
  meta?: AssetMeta
  curPrice: bigint
  freeMgn: bigint
  rate: number
  kycBlocked: boolean
  notify: (msg: string, ok: boolean) => void
  onFilled: () => Promise<void>
}) {
  const [isLong, setIsLong] = useState(true)
  const [lev, setLev] = useState(2)
  const [margin, setMargin] = useState('')
  const [busy, setBusy] = useState(false)
  const [riskOpen, setRiskOpen] = useState(true)

  const marginBig = tryParse(margin)
  const notional = marginBig ? marginBig * BigInt(lev) : 0n
  const liq =
    curPrice > 0n
      ? isLong
        ? curPrice - curPrice / BigInt(lev)
        : curPrice + curPrice / BigInt(lev)
      : 0n
  const overFree = marginBig !== null && marginBig > freeMgn

  const openPosition = async () => {
    if (!contracts) return
    const amt = tryParse(margin)
    if (!amt) {
      notify('Enter margin', false)
      return
    }
    if (amt > freeMgn) {
      notify('Insufficient free margin — deposit first', false)
      return
    }
    setBusy(true)
    try {
      const execFee = (await contracts.exchange.executionFee()) as bigint
      const tx = asTx(
        await contracts.exchange.openPosition(selAsset, isLong, amt, BigInt(lev), {
          value: execFee,
        }),
      )
      await tx.wait()
      notify(`${isLong ? 'Long' : 'Short'} ${meta?.symbol} opened ✓`, true)
      setMargin('')
      await onFilled()
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* long / short */}
      <Box sx={{ display: 'flex', gap: 0.8 }}>
        {([['LONG', true], ['SHORT', false]] as const).map(([t, v]) => {
          const on = isLong === v
          const col = v ? C.green : C.red
          return (
            <Box
              key={t}
              onClick={() => setIsLong(v)}
              sx={{
                flex: 1,
                textAlign: 'center',
                py: 1.1,
                borderRadius: '9px',
                cursor: 'pointer',
                fontWeight: 800,
                fontSize: 14,
                bgcolor: on ? (v ? C.greenDim : C.redDim) : 'transparent',
                color: on ? col : C.mut,
                border: `1px solid ${on ? col : C.line}`,
                transition: '.15s',
              }}
            >
              {t} {v ? '↑' : '↓'}
            </Box>
          )
        })}
      </Box>

      {/* leverage */}
      <Box>
        <Box sx={{ ...labelCss, mb: 0.7 }}>Leverage</Box>
        <Box sx={{ display: 'flex', gap: 0.8 }}>
          {[1, 2, 5].map((l) => {
            const on = lev === l
            return (
              <Box
                key={l}
                onClick={() => setLev(l)}
                sx={{
                  flex: 1,
                  textAlign: 'center',
                  py: 0.9,
                  borderRadius: '8px',
                  cursor: 'pointer',
                  ...monoCss,
                  fontWeight: 700,
                  fontSize: 13,
                  bgcolor: on ? C.lime : 'transparent',
                  color: on ? '#0a0d07' : C.mut,
                  border: `1px solid ${on ? C.lime : C.line}`,
                }}
              >
                {l}×
              </Box>
            )
          })}
        </Box>
      </Box>

      {/* margin input */}
      <Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.7 }}>
          <Box sx={labelCss}>Margin</Box>
          <Box
            sx={{ ...monoCss, fontSize: 11, color: C.mut, cursor: 'pointer' }}
            onClick={() => setMargin(fromUnits(freeMgn, 18).toFixed(2))}
          >
            free: {fNum(fromUnits(freeMgn, 18))}
          </Box>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', ...panel, bgcolor: C.panel2, px: 1.5, py: 1 }}>
          <input
            value={margin}
            onChange={(e) => setMargin(e.target.value)}
            type="number"
            placeholder="0.00"
            aria-label="Margin (USDC)"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: C.ink,
              fontFamily: C.mono,
              fontWeight: 700,
              fontSize: 20,
              width: '100%',
            }}
          />
          <Box sx={{ ...monoCss, color: C.mut, fontSize: 13 }}>USDC</Box>
        </Box>
      </Box>

      {/* quote rows */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.6, py: 0.5 }}>
        <Row k="Notional" v={fToken(fromUnits(notional, 18), 'USDC', { dp: 2 })} />
        <Row k="Entry (oracle)" v={fUsd(fromUnits(curPrice, 18))} />
        <Row k="Est. liquidation" v={fUsd(fromUnits(liq, 18))} color={C.red} />
        <Row
          k="Funding (8h)"
          v={`${rate >= 0 ? '+' : ''}${fNum(rate / 100, { dp: 4 })}%`}
          color={rate > 0 ? C.red : rate < 0 ? C.green : C.mut}
        />
      </Box>

      {kycBlocked && (
        <Box
          sx={{ ...monoCss, fontSize: 11.5, color: C.lime, ...panel, borderColor: C.line2, p: 1 }}
        >
          🔒 {meta?.symbol} 需 KYC，請至 Exchange 頁完成驗證
        </Box>
      )}

      {riskOpen ? (
        <Alert
          severity="info"
          variant="outlined"
          onClose={() => setRiskOpen(false)}
          sx={{ py: 0.5, fontSize: 11.5 }}
        >
          ⚠️
          測試網：本平台為 oracle 計價永續，損益以 mark 價（含 OI 失衡）結算；極端單邊行情下帳面利潤可能因
          ADL 自動減倉而調整；保證金為測試代幣。
        </Alert>
      ) : (
        <Button
          size="small"
          variant="text"
          onClick={() => setRiskOpen(true)}
          sx={{ alignSelf: 'flex-start', textTransform: 'none', color: C.mut, fontSize: 11.5 }}
        >
          ⚠️ 顯示風險提示
        </Button>
      )}

      <Button
        onClick={() => void openPosition()}
        disabled={busy || !margin || overFree || kycBlocked}
        sx={{
          py: 1.4,
          borderRadius: '10px',
          fontWeight: 800,
          fontSize: 15,
          textTransform: 'none',
          bgcolor: isLong ? C.green : C.red,
          color: '#06120c',
          '&:hover': { bgcolor: isLong ? C.green : C.red, filter: 'brightness(1.08)' },
          '&.Mui-disabled': { bgcolor: 'rgba(255,255,255,.05)', color: C.mut },
        }}
      >
        {busy
          ? 'Opening…'
          : overFree
            ? 'Insufficient margin'
            : `Open ${isLong ? 'Long' : 'Short'} ${meta?.symbol ?? ''}`}
      </Button>
    </>
  )
}
