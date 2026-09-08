// issue #134：詳情層——身世卡與買進表單同框。
//
// #93 user story 15「在買進之前就看到碳分級與對應費率」在這裡才是介面保證，
// 不是碰巧：這個元件把 AssetProvenanceBody（碳分級、出處、KYC 理由…）跟
// 買進／贖回表單放進同一個框，呼叫端（TokenizedAssetsPage）只決定外殼是
// 桌面的側邊欄還是手機的全螢幕 Drawer，內容在這裡只有一份。

import type { AssetSymbol } from 'src/contracts/addresses'
import type { AssetMeta } from 'src/lib/pepefi/assetMeta'
import type { AssetRow } from 'src/lib/pepefi/assetRows'

import { MONO } from 'src/components/pepefi/brandKit'
import { t, interpolate } from 'src/locales'
import { fUsd, f18 } from 'src/lib/pepefi/format'

import Box from '@mui/material/Box'
import Chip from '@mui/material/Chip'
import Stack from '@mui/material/Stack'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import IconButton from '@mui/material/IconButton'
import Typography from '@mui/material/Typography'
import TextField from '@mui/material/TextField'
import InputAdornment from '@mui/material/InputAdornment'
import ToggleButton from '@mui/material/ToggleButton'
import ToggleButtonGroup from '@mui/material/ToggleButtonGroup'
import Alert from '@mui/material/Alert'
import { Icon } from '@iconify/react'

import AssetIcon from './AssetIcon'
import { AssetCandleChart } from './AssetCandleChart'
import { AssetProvenanceSummary, AssetProvenanceBody } from './AssetProvenance'

export interface AssetDetailPanelProps {
  sym: AssetSymbol
  assetRow: AssetRow
  meta: AssetMeta
  /** 8-dec oracle 價格；0n 代表尚未讀到。 */
  price: bigint
  /** 這條鏈是不是硬化版金庫——舊版沒有手續費這個概念，見下面 fee 顯示的註解。 */
  isV2: boolean
  mode: 'buy' | 'sell'
  onModeChange: (mode: 'buy' | 'sell') => void
  amount: string
  onAmountChange: (v: string) => void
  quote: { out: bigint; fee: bigint } | null
  busy: boolean
  onConfirm: () => void
  onAddToWallet: () => void
  onClose: () => void
}

export function AssetDetailPanel({
  sym,
  assetRow,
  meta,
  price,
  isV2,
  mode,
  onModeChange,
  amount,
  onAmountChange,
  quote,
  busy,
  onConfirm,
  onAddToWallet,
  onClose,
}: AssetDetailPanelProps) {
  const dl = t.tokens.dialog
  const canConfirm = mode === 'buy' ? assetRow.canBuy : assetRow.canSell
  // #93 #99：canSell 是「金庫暫停」跟「餘額為零」兩個原因的 OR
  // （assetRows.ts 的 canSell = !sellBlockedByVault && balance > 0n）。
  // 兩個原因給同一句話是誤導——沒有餘額的人看到「金庫已暫停」會以為
  // 金庫出了問題，而金庫可能好好的。canSell 為 false 又 balance > 0n
  // 時,唯一剩下的可能就是金庫暫停,這個推論才是準的。
  const noBalance = assetRow.balance <= 0n

  return (
    <Stack spacing={2} sx={{ p: 2.5, height: '100%', overflowY: 'auto' }}>
      {/* ── 標頭 ── */}
      <Stack direction="row" spacing={1.25} alignItems="flex-start">
        <AssetIcon symbol={sym} size={32} />
        <Box sx={{ minWidth: 0, flex: 1 }}>
          <Typography variant="subtitle1" sx={{ fontWeight: 'bold', lineHeight: 1.2 }}>{sym}</Typography>
          <Typography variant="body2" color="text.secondary" noWrap>{assetRow.name}</Typography>
          <Box sx={{ mt: 0.75 }}>
            <AssetProvenanceSummary tier={assetRow.tier} freshness={assetRow.freshness} />
          </Box>
        </Box>
        <IconButton size="small" onClick={onClose} aria-label={dl.cancel}>
          <Icon icon="solar:close-circle-linear" width={22} />
        </IconButton>
      </Stack>

      {/* #135：這檔資產自己的走勢，資料來自平台的 K 線服務，預設日線
          （投資的時間尺度）。取不到資料時只有這一塊壞掉，不連累下面。 */}
      <AssetCandleChart symbol={sym} height={220} />

      <Divider />

      {/* ── 買進／贖回 ── */}
      <Box>
        <ToggleButtonGroup
          size="small"
          exclusive
          fullWidth
          value={mode}
          onChange={(_, v) => { if (v) onModeChange(v as 'buy' | 'sell') }}
          sx={{ mb: 1.5 }}
        >
          <ToggleButton value="buy" sx={{ textTransform: 'none', fontWeight: 'bold' }}>
            {t.tokens.card.buy}
          </ToggleButton>
          <ToggleButton value="sell" sx={{ textTransform: 'none', fontWeight: 'bold' }}>
            {t.tokens.card.sell}
          </ToggleButton>
        </ToggleButtonGroup>

        <Stack spacing={1.5}>
          <Chip
            size="small"
            variant="outlined"
            label={`Oracle: ${price > 0n ? fUsd(Number(price) / 1e8) : '—'}`}
            sx={{ alignSelf: 'flex-start', fontFamily: MONO }}
          />

          <TextField
            autoFocus fullWidth type="number" size="small"
            label={
              mode === 'buy'
                ? dl.buyAmountLabel
                : interpolate(dl.sellAmountLabel, { symbol: sym })
            }
            value={amount}
            onChange={(e) => onAmountChange(e.target.value)}
            disabled={busy || !canConfirm}
            slotProps={{
              input: {
                endAdornment: (
                  <InputAdornment position="end">
                    {mode === 'buy' ? 'USDC' : sym}
                  </InputAdornment>
                ),
              },
            }}
          />

          {!canConfirm && (
            <Alert severity="warning" variant="outlined">
              {mode === 'buy'
                ? dl.buyDisabledNotice
                : noBalance ? dl.noBalanceNotice : dl.sellDisabledNotice}
            </Alert>
          )}

          <Box>
            <Typography variant="caption" color="text.secondary" display="block">
              {quote === null
                ? dl.needAmount
                : mode === 'buy'
                  ? interpolate(dl.buyQuote, { amount: f18(quote.out), symbol: sym })
                  : interpolate(dl.sellQuote, { amount: fUsd(Number(quote.out) / 1e18) })}
            </Typography>
            {/* #134：預估費用金額——不只是費率，這一筆實際要付多少。買進與
                贖回都有各自的手續費（previewMint/previewRedeem 都回傳
                (amount, feePaid)），金額為 0 也照樣顯示，不是有費用才冒出來
                ——但只在硬化版金庫上顯示：舊版金庫根本沒有手續費這個概念,
                quote.fee 在那裡永遠是程式碼塞進去的 0n,不是鏈上真的收了
                0 元,顯示「手續費：0 USDC」會讓人以為這個機制存在而只是
                剛好免費。 */}
            {isV2 && quote !== null && (
              <Typography variant="caption" color="warning.main" display="block">
                {interpolate(dl.fee, { amount: f18(quote.fee, { dp: 4 }) })}
              </Typography>
            )}
          </Box>

          <Stack direction="row" spacing={1}>
            <Button
              variant="contained"
              fullWidth
              disabled={busy || !amount || !canConfirm}
              onClick={onConfirm}
              sx={{ textTransform: 'none', fontWeight: 'bold' }}
            >
              {busy ? dl.working : dl.confirm}
            </Button>
            <Button
              variant="text"
              onClick={() => void onAddToWallet()}
              sx={{ textTransform: 'none', fontSize: '0.75rem', color: 'info.main', flexShrink: 0 }}
            >
              {t.tokens.card.addToWallet}
            </Button>
          </Stack>
        </Stack>
      </Box>

      <Divider />

      <AssetProvenanceBody meta={meta} />
    </Stack>
  )
}
