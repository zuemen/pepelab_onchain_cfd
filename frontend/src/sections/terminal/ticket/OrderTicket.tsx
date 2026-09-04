import type { AssetMeta } from 'src/lib/pepefi/assetMeta'

import { useState, useEffect } from 'react'

import Box from '@mui/material/Box'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'

import { t, interpolate } from 'src/locales'
import { STABLE_LABEL } from 'src/lib/pepefi/tokenLabel'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { estimateLiquidationPrice } from 'src/lib/pepefi/liquidation'
import { fUsd, fNum, fToken, fromUnits } from 'src/lib/pepefi/format'
import { SHOW_LEVERAGE, FIXED_LEVERAGE } from 'src/lib/pepefi/featureFlags'
import { paramsFor, attestationExpired, type Tier } from 'src/lib/pepefi/carbon'

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
  staleNotice,
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
  /**
   * 指數價已超過合約的 maxPriceAge —— 鏈上會 revert StalePrice，不讓使用者白送一筆。
   *
   * 傳的是 `stalenessNotice()` 算好的那句話（null = 可以下單），不是一個布林加一個
   * 價齡：擋單理由全站只有一份文案，終端機自己再寫一句就會跟其他頁面分岔。
   */
  staleNotice: string | null
  notify: (msg: string, ok: boolean) => void
  onFilled: () => Promise<void>
}) {
  const [isLong, setIsLong] = useState(true)
  // 旗標關閉時鎖在 1×：畫面不露出選擇器，送單也只送 1，鏈上行為等同現貨。
  const [lev, setLev] = useState(SHOW_LEVERAGE ? 2 : FIXED_LEVERAGE)

  // 碳分級的槓桿上限。合約 openPosition 會用 CarbonTiers 推導的上限擋，這裡
  // 先把選擇器夾住，讓使用者在按下去之前就看到「這個資產只能到 N×」，而不是
  // 送出後吃一個 revert。見證過期一律當未評等（1×）。
  const carbonTier: Tier = meta?.carbon
    ? attestationExpired(meta.carbon.observed, Date.now())
      ? 'unrated'
      : meta.carbon.tier
    : 'unrated'
  const carbonMaxLev = meta?.carbon ? paramsFor(carbonTier).maxLeverage : 5
  useEffect(() => {
    if (lev > carbonMaxLev) setLev(carbonMaxLev)
  }, [carbonMaxLev, lev])
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
  const staleBlocked = staleNotice !== null

  const openPosition = async () => {
    if (!contracts) return
    const amt = tryParse(margin)
    if (!amt) {
      notify(t.terminal.ticket.enterMargin, false)
      return
    }
    if (amt > freeMgn) {
      notify(t.terminal.ticket.insufficientFreeMargin, false)
      return
    }
    // 按鈕已經 disabled，這裡是第二道防線：鍵盤送出或狀態剛好在重繪的空窗。
    if (staleNotice) {
      notify(staleNotice, false)
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
      notify(
        interpolate(t.terminal.ticket.opened, {
          side: isLong ? t.terminal.ticket.sideLong : t.terminal.ticket.sideShort,
          asset: meta?.symbol ?? '',
        }),
        true,
      )
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
        {(
          [
            [t.terminal.ticket.long, true],
            [t.terminal.ticket.short, false],
          ] as const
        ).map(([label, v]) => {
          const on = isLong === v
          const col = v ? C.green : C.red
          return (
            <Box
              key={label}
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
              {label} {v ? '↑' : '↓'}
            </Box>
          )
        })}
      </Box>

      {/* leverage —— SHOW_LEVERAGE 關閉時整塊不渲染，lev 固定 FIXED_LEVERAGE。
          碳分級上限之上的倍數不給選（合約也會擋，這裡先攔）。 */}
      {SHOW_LEVERAGE && (
      <Box>
        <Box sx={{ ...labelCss, mb: 0.7, display: 'flex', justifyContent: 'space-between' }}>
          <span>{t.terminal.ticket.leverage}</span>
          {meta?.carbon && carbonMaxLev < 5 && (
            <Box component="span" sx={{ ...monoCss, fontSize: 10, color: C.mut }}>
              {interpolate(t.terminal.stats.carbonValue, {
                tier: t.tokens.provenance.carbonTier[carbonTier],
                fee: paramsFor(carbonTier).tradingFeeBps,
                lev: carbonMaxLev,
              })}
            </Box>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 0.8 }}>
          {[1, 2, 5].filter((l) => l <= carbonMaxLev).map((l) => {
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
      )}

      {/* margin input */}
      <Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.7 }}>
          <Box sx={labelCss}>{t.terminal.ticket.margin}</Box>
          <Box
            sx={{ ...monoCss, fontSize: 11, color: C.mut, cursor: 'pointer' }}
            onClick={() => setMargin(fromUnits(freeMgn, 18).toFixed(2))}
          >
            {interpolate(t.terminal.ticket.free, { amount: fNum(fromUnits(freeMgn, 18)) })}
          </Box>
        </Box>
        <Box sx={{ display: 'flex', alignItems: 'center', ...panel, bgcolor: C.panel2, px: 1.5, py: 1 }}>
          <input
            value={margin}
            onChange={(e) => setMargin(e.target.value)}
            type="number"
            placeholder="0.00"
            aria-label={interpolate(t.terminal.ticket.marginAria, { token: STABLE_LABEL })}
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
        <Row
          k={t.terminal.ticket.notional}
          v={fToken(fromUnits(notional, 18), STABLE_LABEL, { dp: 2 })}
        />
        <Row k={t.terminal.ticket.entryOracle} v={fUsd(fromUnits(curPrice, 18))} />
        {/* 清算 = 強制平倉，但殘值（扣掉虧損／費用／清算獎勵／liquidationPenaltyBps）
            會退還給倉位所有者，不再是 100% 沒收。 */}
        <Row k={t.terminal.ticket.estLiquidation} v={fUsd(fromUnits(liq, 18))} color={C.red} />
        <Row
          k={t.terminal.ticket.onLiquidation}
          v={t.terminal.ticket.onLiquidationValue}
          color={C.mut}
        />
        <Row
          k={t.terminal.ticket.funding8h}
          v={`${rate >= 0 ? '+' : ''}${fNum(rate / 100, { dp: 4 })}%`}
          color={rate > 0 ? C.red : rate < 0 ? C.green : C.mut}
        />
      </Box>

      {kycBlocked && (
        <Box
          sx={{ ...monoCss, fontSize: 11.5, color: C.lime, ...panel, borderColor: C.line2, p: 1 }}
        >
          {interpolate(
            kycUnknown
              ? t.terminal.ticket.kycUnknown
              : kycPending
                ? t.terminal.ticket.kycPending
                : t.terminal.ticket.kycRequired,
            { asset: meta?.symbol ?? '' },
          )}
        </Box>
      )}

      {staleNotice && (
        <Box sx={{ ...monoCss, fontSize: 11.5, color: C.red, ...panel, borderColor: C.line2, p: 1 }}>
          {staleNotice}
        </Box>
      )}

      {riskOpen ? (
        <Alert
          severity="info"
          variant="outlined"
          onClose={() => setRiskOpen(false)}
          sx={{ py: 0.5, fontSize: 11.5 }}
        >
          {t.terminal.ticket.riskNotice}
        </Alert>
      ) : (
        <Button
          size="small"
          variant="text"
          onClick={() => setRiskOpen(true)}
          sx={{ alignSelf: 'flex-start', textTransform: 'none', color: C.mut, fontSize: 11.5 }}
        >
          {t.terminal.ticket.showRiskNotice}
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
          ? t.terminal.ticket.submitting
          : overFree
            ? t.terminal.ticket.insufficientMargin
            : interpolate(t.terminal.ticket.ctaOpen, {
                side: isLong ? t.terminal.ticket.sideLong : t.terminal.ticket.sideShort,
                asset: meta?.symbol ?? '',
              })}
      </Button>
    </>
  )
}
