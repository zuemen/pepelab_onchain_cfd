import type { AssetMeta } from 'src/lib/pepefi/assetMeta'

import { useState } from 'react'

import Box from '@mui/material/Box'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'

import { STABLE_LABEL } from 'src/lib/pepefi/tokenLabel'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { estimateLiquidationPrice } from 'src/lib/pepefi/liquidation'
import { fUsd, fNum, fToken, fromUnits } from 'src/lib/pepefi/format'

import { Row } from '../Atoms'
import { C, panel, monoCss, labelCss } from '../terminal-theme'
import { asTx, tryParse, type AssetId, type TerminalContracts } from '../types'

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
  kycUnknown,
  kycPending,
  staleBlocked,
  staleLabel,
  notify,
  onFilled,
}: {
  contracts: TerminalContracts
  selAsset: AssetId
  meta?: AssetMeta
  curPrice: bigint
  freeMgn: bigint
  rate: number
  kycBlocked: boolean
  /** KYC 狀態讀不到（fail-closed 擋住）。和「確定未驗證」要說不同的話。 */
  kycUnknown: boolean
  /** 申請已送出、待審核（KYCRegistry 改審核制後才有的狀態）。 */
  kycPending?: boolean
  /** 指數價已超過合約的 maxPriceAge —— 鏈上會 revert StalePrice，不讓使用者白送一筆。 */
  staleBlocked: boolean
  staleLabel?: string
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
  // 清算價和 /exchange 共用 lib/pepefi/liquidation.ts。原本這裡少算了 5.1% 的
  // 維持保證金 + 平倉費 buffer，同一個倉位在兩頁會看到兩個清算價，而且這邊的
  // 比實際更寬鬆——正好是會害人的那個方向。
  const liq = estimateLiquidationPrice({ entryPrice: curPrice, isLong, leverage: BigInt(lev) })
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
    // 按鈕已經 disabled，這裡是第二道防線：鍵盤送出或狀態剛好在重繪的空窗。
    if (staleBlocked) {
      notify(
        `⛔ 指數價已超過合約的 maxPriceAge${staleLabel ? `（最後更新：${staleLabel}）` : ''}，鏈上會以 StalePrice 拒絕。`,
        false,
      )
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
            aria-label={`Margin (${STABLE_LABEL})`}
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
          <Box sx={{ ...monoCss, color: C.mut, fontSize: 13 }}>{STABLE_LABEL}</Box>
        </Box>
      </Box>

      {/* quote rows */}
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.6, py: 0.5 }}>
        <Row k="Notional" v={fToken(fromUnits(notional, 18), STABLE_LABEL, { dp: 2 })} />
        <Row k="Entry (oracle)" v={fUsd(fromUnits(curPrice, 18))} />
        {/* 清算 = 強制平倉，但殘值（扣掉虧損／費用／清算獎勵／liquidationPenaltyBps）
            會退還給倉位所有者，不再是 100% 沒收。 */}
        <Row k="Est. liquidation" v={fUsd(fromUnits(liq, 18))} color={C.red} />
        <Row k="On liquidation" v="殘值退還（扣罰金）" color={C.mut} />
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
          {kycUnknown
            ? `⚠ 無法確認 KYC 狀態（鏈上讀取失敗）。合規閘門採 fail-closed，${meta?.symbol} 暫停交易。`
            : kycPending
              ? `⏳ ${meta?.symbol} 需 KYC：申請已送出，等待審核人員核准中，核准後自動解鎖`
              : `🔒 ${meta?.symbol} 需 KYC，請至 Exchange 頁送出申請（送出後需審核）`}
        </Box>
      )}

      {staleBlocked && (
        <Box sx={{ ...monoCss, fontSize: 11.5, color: C.red, ...panel, borderColor: C.line2, p: 1 }}>
          ⛔ 指數價格已超過合約的 maxPriceAge{staleLabel ? `（最後更新：${staleLabel}）` : ''}，
          鏈上會以 StalePrice 拒絕交易。等待 keeper 更新後再下單。
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
        disabled={busy || !margin || overFree || kycBlocked || staleBlocked}
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
