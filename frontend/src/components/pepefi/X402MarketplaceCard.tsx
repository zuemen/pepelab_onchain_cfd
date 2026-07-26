import { useState, useEffect } from 'react'
import { Link as RouterLink } from 'react-router'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Button from '@mui/material/Button'
import Typography from '@mui/material/Typography'

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
      else if (!r.ok) setErr(r.error ?? 'demo buy failed')
    } catch (e: any) {
      setErr(e?.message ?? 'API 未連上（VITE_SIGNAL_API_URL?）')
    } finally { setBusy(false) }
  }

  return (
    <Card sx={{ p: 2.5, bgcolor: 'background.neutral', borderLeft: '3px solid', borderColor: 'success.main' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }} justifyContent="space-between">
        <Box>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>⚡ x402 Signal Marketplace</Typography>
            <Chip size="small" color="success" label="pay-per-call" />
          </Stack>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            任何 agent 帶 Base Sepolia USDC 即可付費購買訊號（$0.01/$0.005），收入 70/20/10 上鏈分潤。
          </Typography>
          {rev && (
            <Typography variant="caption" sx={{ fontFamily: 'monospace', mt: 0.5, display: 'block' }}>
              鏈上累計：${rev.feeUsd.toFixed(3)} 收入 · ${rev.traderShare.toFixed(3)} 歸 traders (70%)
            </Typography>
          )}
        </Box>
        <Stack direction="row" spacing={1} alignItems="center">
          <Button variant="contained" color="success" disabled={busy} onClick={() => void tryBuy()}>
            {busy ? '購買中…' : '試買 ($0.01)'}
          </Button>
          <Button component={RouterLink} to="/x402" variant="outlined">API 文件</Button>
        </Stack>
      </Stack>
      {tx && (
        <Typography variant="caption" sx={{ display: 'block', mt: 1 }}>
          ✓ 已上鏈：{' '}
          <Link href={`https://sepolia.basescan.org/tx/${tx}`} target="_blank" rel="noopener" sx={{ textDecoration: 'underline' }}>
            BaseScan settlement tx ↗
          </Link>
        </Typography>
      )}
      {err && <Typography variant="caption" color="error.main" sx={{ display: 'block', mt: 1 }}>{err}</Typography>}
    </Card>
  )
}
