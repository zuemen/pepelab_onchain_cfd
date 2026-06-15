import { useState } from 'react'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Link from '@mui/material/Link'
import Stack from '@mui/material/Stack'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Divider from '@mui/material/Divider'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'

import { SIGNAL_API_URL, demoBuySignal } from 'src/lib/pepefi/signalApi'

const OFFICIAL_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const X402_FEE_ROUTER = '0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d'
const basescanTx = (h: string) => `https://sepolia.basescan.org/tx/${h}`

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <Box component="pre" sx={{
      m: 0, p: 2, borderRadius: 1, bgcolor: 'background.neutral', overflowX: 'auto',
      fontFamily: 'monospace', fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    }}>{children}</Box>
  )
}

export default function X402DocsPage() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof demoBuySignal>> | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const tryBuy = async () => {
    setBusy(true); setErr(null); setResult(null)
    try {
      const r = await demoBuySignal()
      if (r.ok) setResult(r)
      else setErr(r.error ?? 'demo buy failed')
    } catch (e: any) {
      setErr(e?.message ?? 'network error — is the API deployed / VITE_SIGNAL_API_URL set?')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Container maxWidth="md" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <Box>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="h4" sx={{ fontWeight: 'bold' }}>x402 Signal API</Typography>
          <Chip size="small" color="success" label="agent-native commerce" />
        </Stack>
        <Typography color="text.secondary">
          按次付費的交易訊號 API。<b>端點本身就是商品</b>——任何帶 Base Sepolia USDC 錢包的
          agent / CLI 都能直接付費購買，收入經 FeeRouter 70/20/10 上鏈分潤。
        </Typography>
      </Box>

      {/* facts */}
      <Card sx={{ p: 2.5 }}>
        <Stack spacing={1.2}>
          {[
            ['Base URL', SIGNAL_API_URL],
            ['Network', 'base-sepolia (84532)'],
            ['Asset', `官方 USDC ${OFFICIAL_USDC} (6-dec, EIP-3009)`],
            ['x402 分潤 router', X402_FEE_ROUTER],
            ['定價', 'GET /signals/:trader → $0.01 · GET /oracle/:asset → $0.005'],
          ].map(([k, v]) => (
            <Box key={k} sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
              <Typography variant="caption" color="text.secondary" sx={{ minWidth: 130, fontWeight: 'bold' }}>{k}</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{v}</Typography>
            </Box>
          ))}
        </Stack>
      </Card>

      {/* try-buy */}
      <Card sx={{ p: 3, borderLeft: '3px solid', borderColor: 'success.main' }}>
        <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 1 }}>互動試買（訪客免錢包）</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          按下後由伺服器 demo 錢包代付一筆 $0.01 並在鏈上跑 70/20/10，回傳真實 settlement tx。
          （真實外部 agent 則自帶錢包，見下方範例。）
        </Typography>
        <Button variant="contained" color="success" disabled={busy} onClick={() => void tryBuy()}>
          {busy ? '購買中…（送鏈，約數秒）' : '試買一筆訊號 ($0.01)'}
        </Button>
        {err && <Alert severity="error" sx={{ mt: 2 }}>{err}</Alert>}
        {result && (
          <Box sx={{ mt: 2 }}>
            {result.settlementTx && (
              <Alert severity="success" sx={{ mb: 1 }}>
                70/20/10 已上鏈 ·{' '}
                <Link href={basescanTx(result.settlementTx)} target="_blank" rel="noopener" color="inherit" sx={{ textDecoration: 'underline' }}>
                  在 BaseScan 看 settlement tx ↗
                </Link>
              </Alert>
            )}
            <Mono>{JSON.stringify(result.signal ?? result, null, 2)}</Mono>
          </Box>
        )}
      </Card>

      <Divider>外部 agent 自帶錢包付費</Divider>

      {/* curl + node */}
      <Card sx={{ p: 2.5 }}>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 1 }}>1) 探索（免費）</Typography>
        <Mono>{`curl -s ${SIGNAL_API_URL}/`}</Mono>
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mt: 2, mb: 1 }}>2) 付費購買（x402-fetch + viem）</Typography>
        <Mono>{`# agent/examples/buy-signal.ts — 只依賴 viem + x402-fetch
export X402_API_URL=${SIGNAL_API_URL}
export AGENT_PRIVATE_KEY=0x...   # 持官方 USDC + 一點 ETH
npx tsx examples/buy-signal.ts`}</Mono>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          流程：GET → 收 402（含 accepts: network/asset/payTo/price）→ 用官方 USDC 簽
          EIP-3009 transferWithAuthorization → 重送帶 X-PAYMENT → 200 + 訊號 + settlement tx。
        </Typography>
      </Card>

      <Typography variant="caption" color="text.secondary">
        測試網展示用途；`FEE_SETTLEMENT_PRIVATE_KEY` 為半公開測試金鑰，只放極少量測試資產。
      </Typography>
    </Container>
  )
}
