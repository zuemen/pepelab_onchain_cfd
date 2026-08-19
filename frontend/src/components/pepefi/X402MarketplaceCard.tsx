import { useState, useEffect } from 'react'
import { Link as RouterLink } from 'react-router'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

import { t, interpolate } from 'src/locales'
import { SIGNAL_API_URL, demoBuySignal } from 'src/lib/pepefi/signalApi'

// 即時鏈上分潤統計（讀 Track A 的 /revenue）+ 訪客試買按鈕。
export default function X402MarketplaceCard() {
  const [rev, setRev] = useState<{ feeUsd: number; traderShare: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [tx, setTx] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    let off = false
    void (async () => {
      try {
        const r = await (await fetch(`${SIGNAL_API_URL}/revenue`)).json()
        if (!off && r?.totals) setRev({ feeUsd: r.totals.feeUsd, traderShare: r.totals.traderShare })
      } catch { /* API 未部署 → 靜默 */ }
    })()
    return () => { off = true }
  }, [])

  const tryBuy = async () => {
    setBusy(true); setErr(null); setTx(null)
    try {
      const r = await demoBuySignal()
      if (r.ok && r.settlementTx) setTx(r.settlementTx)
      else if (!r.ok) setErr(r.error ?? t.x402.docs.tryBuy.failed)
    } catch (e) {
      setErr(e instanceof Error ? e.message : t.x402.card.apiUnreachable)
    } finally { setBusy(false) }
  }

  return (
    <Card sx={{ p: 2.5, bgcolor: 'background.neutral', borderLeft: '3px solid', borderColor: 'success.main' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }} justifyContent="space-between">
        <Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{t.x402.card.title}</Typography>
            <Chip size="small" color="success" label={t.x402.card.chip} />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {t.x402.card.description}
          </Typography>
          {rev && (
            <Typography variant="caption" sx={{ fontFamily: 'monospace', mt: 0.5, display: 'block' }}>
              {interpolate(t.x402.card.accrued, {
                feeUsd: rev.feeUsd.toFixed(3),
                traderShare: rev.traderShare.toFixed(3),
              })}
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button variant="contained" color="success" disabled={busy} onClick={() => void tryBuy()}>
            {busy ? t.x402.card.busy : t.x402.card.tryBuy}
          </Button>
          <Button component={RouterLink} to="/x402" variant="outlined">{t.x402.card.docs}</Button>
        </Stack>
      </Stack>
      {tx && (
        <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>
          {t.x402.card.settled}{' '}
          <Link href={`https://sepolia.basescan.org/tx/${tx}`} target="_blank" rel="noopener" sx={{ textDecoration: 'underline' }}>
            {t.x402.card.viewSettlement}
          </Link>
        </Typography>
      )}
      {err && <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 1 }}>{err}</Typography>}
    </Card>
  )
}
