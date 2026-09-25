import { useState, useEffect } from 'react'
import Box from '@mui/material/Box'
import Card from '@mui/material/Card'
import Chip from '@mui/material/Chip'
import Link from '@mui/material/Link'
import Grid from '@mui/material/Grid'
import Stack from '@mui/material/Stack'
import Alert from '@mui/material/Alert'
import Button from '@mui/material/Button'
import Accordion from '@mui/material/Accordion'
import Container from '@mui/material/Container'
import Typography from '@mui/material/Typography'
import AccordionSummary from '@mui/material/AccordionSummary'
import AccordionDetails from '@mui/material/AccordionDetails'

import { t, interpolate } from 'src/locales'
import { SIGNAL_API_URL, demoBuySignal } from 'src/lib/pepefi/signalApi'
import { Mono as Num, LiveDot, PEPE, MONO, hexA } from 'src/components/pepefi/brandKit'

// #154：讀者是一般使用者。前半頁只講「這是什麼、對我有什麼用、怎麼開始」，
// 端點、位址、程式範例全部收進最下方預設收合的「給開發者」區塊。

interface RevenueTotals {
  count: number | null
  feeUsd: number
  traderShare: number
  platformShare: number
  vaultShare: number
}

const docs = t.x402.docs

// 可以買到的兩種資料。path 只在卡片角落當註記，名稱與說明才是主角。
const PRODUCTS = [
  { path: '/signals/:trader', price: '$0.01', name: docs.product.signalsName, blurb: docs.product.signals, accent: PEPE.green },
  { path: '/oracle/:asset', price: '$0.005', name: docs.product.oracleName, blurb: docs.product.oracle, accent: PEPE.gold },
] as const

const BENEFITS = [
  { ...docs.benefits.payPerUse, accent: PEPE.green },
  { ...docs.benefits.autonomous, accent: PEPE.gold },
  { ...docs.benefits.transparent, accent: '#00B8D9' },
]

const HOW_STEPS = [docs.how.ask, docs.how.quote, docs.how.pay]
const FAQ = [docs.faq.spend, docs.faq.trade, docs.faq.real]

const OFFICIAL_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const X402_FEE_ROUTER = '0x29e5732AC62254d9b92A1C7d3F38EbFA8809B57d'
const CIRCLE_FAUCET = 'https://faucet.circle.com'
const basescanTx = (h: string) => `https://sepolia.basescan.org/tx/${h}`

function Mono({ children }: { children: React.ReactNode }) {
  return (
    <Box component="pre" sx={{
      m: 0, p: 2, borderRadius: 1, bgcolor: 'background.neutral', overflowX: 'auto',
      fontFamily: MONO, fontSize: 13, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
    }}>{children}</Box>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <Typography variant="h5" sx={{ fontWeight: 'bold', mb: 1.5 }}>{children}</Typography>
}

// 編號圓圈：「怎麼運作」與「怎麼開始」兩處步驟共用。
function StepNumber({ n, color = PEPE.green }: { n: number; color?: string }) {
  return (
    <Box sx={{
      width: 32, height: 32, flexShrink: 0, borderRadius: '50%', display: 'grid', placeItems: 'center',
      bgcolor: hexA(color, 0.15), color, fontWeight: 800, fontFamily: MONO,
    }}>{n}</Box>
  )
}

// 即時 70/20/10 分潤條（讀鏈上 /revenue）。
function SplitBar({ rev }: { rev: RevenueTotals | null }) {
  const segs = [
    { label: docs.split.traders, pct: 70, val: rev?.traderShare, color: PEPE.green },
    { label: docs.split.platform, pct: 20, val: rev?.platformShare, color: PEPE.gold },
    { label: docs.split.vault, pct: 10, val: rev?.vaultShare, color: '#00B8D9' },
  ]
  return (
    <Card sx={{ p: 2.5 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1.5 }} flexWrap="wrap">
        {rev && <LiveDot size={6} />}
        <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
          {docs.split.title}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ ml: 'auto' }}>
          {docs.split.accrued}{' '}
          <Num tone="green">${(rev?.feeUsd ?? 0).toFixed(3)}</Num>{' · '}
          <Num tone="muted">
            {rev == null
              ? '—'
              : rev.count == null
                ? docs.split.callsUnknown
                : interpolate(docs.split.calls, { count: rev.count })}
          </Num>
        </Typography>
      </Stack>
      <Box sx={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', mb: 1.5 }}>
        {segs.map((s) => (
          <Box key={s.label} sx={{ width: `${s.pct}%`, bgcolor: s.color, opacity: 0.85 }} />
        ))}
      </Box>
      <Stack direction="row" spacing={2} flexWrap="wrap" useFlexGap>
        {segs.map((s) => (
          <Stack key={s.label} direction="row" alignItems="center" spacing={0.8}>
            <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: s.color }} />
            <Typography variant="caption" color="text.secondary">
              {interpolate(docs.split.share, { label: s.label, pct: s.pct })}
            </Typography>
            <Num tone="muted" sx={{ fontSize: 12 }}>
              ${(s.val ?? 0).toFixed(4)}
            </Num>
          </Stack>
        ))}
      </Stack>
    </Card>
  )
}

export default function X402DocsPage() {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<Awaited<ReturnType<typeof demoBuySignal>> | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [rev, setRev] = useState<RevenueTotals | null>(null)

  useEffect(() => {
    let off = false
    const pull = async () => {
      try {
        const r = await (await fetch(`${SIGNAL_API_URL}/revenue`)).json()
        if (!off && r?.totals) setRev(r.totals)
      } catch {
        /* API 未連上 → 靜默 */
      }
    }
    void pull()
    const id = setInterval(pull, 15_000)
    return () => {
      off = true
      clearInterval(id)
    }
  }, [])

  const tryBuy = async () => {
    setBusy(true); setErr(null); setResult(null)
    try {
      const r = await demoBuySignal()
      if (r.ok) setResult(r)
      else setErr(r.error ?? docs.tryBuy.failed)
    } catch {
      // 原始錯誤（多半是 fetch 的 TypeError）對一般使用者沒有意義；
      // 開發者要的排查提示在「給開發者」區塊的 networkErrorHint。
      setErr(docs.tryBuy.networkError)
    } finally {
      setBusy(false)
    }
  }

  const startSteps = [
    { ...docs.start.wallet },
    {
      ...docs.start.fund,
      extra: (
        <Link href={CIRCLE_FAUCET} target="_blank" rel="noopener" variant="body2" sx={{ fontWeight: 'bold' }}>
          {docs.start.fund.link}
        </Link>
      ),
    },
    { ...docs.start.connect },
    { ...docs.start.track },
  ]

  return (
    <Container maxWidth="md" sx={{ py: 4, display: 'flex', flexDirection: 'column', gap: 4 }}>
      {/* ── 開頭：這是什麼、對我有什麼用（不捲動就看得到） ── */}
      <Box>
        <Chip size="small" color="success" variant="outlined" label={docs.testnetChip} sx={{ mb: 1.5 }} />
        <Typography variant="h3" component="h1" sx={{ fontWeight: 'bold', mb: 1.5, fontSize: { xs: 28, md: 36 } }}>
          {docs.title}
        </Typography>
        <Typography variant="h6" color="text.secondary" sx={{ fontWeight: 400, lineHeight: 1.6 }}>
          {docs.lead}
        </Typography>
      </Box>

      <Grid container spacing={2} sx={{ mt: -1 }}>
        {BENEFITS.map((b) => (
          <Grid size={{ xs: 12, sm: 4 }} key={b.title}>
            <Card sx={{
              p: 2.5, height: '100%', position: 'relative', overflow: 'hidden',
              '&::before': {
                content: '""', position: 'absolute', top: 0, left: 0, width: '100%', height: 3, bgcolor: b.accent,
              },
            }}>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 0.75 }}>{b.title}</Typography>
              <Typography variant="body2" color="text.secondary">{b.body}</Typography>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* ── 一次購買怎麼進行 ── */}
      <Box>
        <SectionHeading>{docs.how.heading}</SectionHeading>
        <Grid container spacing={2}>
          {HOW_STEPS.map((s, i) => (
            <Grid size={{ xs: 12, sm: 4 }} key={s.title}>
              <Stack spacing={1}>
                <StepNumber n={i + 1} />
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{s.title}</Typography>
                <Typography variant="body2" color="text.secondary">{s.body}</Typography>
              </Stack>
            </Grid>
          ))}
        </Grid>
      </Box>

      {/* ── 可以買到什麼 + 收入怎麼分 ── */}
      <Box>
        <SectionHeading>{docs.product.heading}</SectionHeading>
        <Grid container spacing={2}>
          {PRODUCTS.map((p) => (
            <Grid size={{ xs: 12, sm: 6 }} key={p.path}>
              <Card
                sx={{
                  p: 2.5,
                  height: '100%',
                  position: 'relative',
                  overflow: 'hidden',
                  border: '1px solid',
                  borderColor: hexA(p.accent, 0.25),
                  '&::before': {
                    content: '""', position: 'absolute', top: 0, left: 0, width: '100%', height: 3,
                    background: `linear-gradient(90deg, ${p.accent}, transparent)`,
                  },
                }}
              >
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 1 }}>{p.name}</Typography>
                <Typography component="div" sx={{ fontSize: 28, lineHeight: 1, mb: 1 }}>
                  <Num glow sx={{ color: p.accent }}>{p.price}</Num>
                  <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                    {docs.product.perCall}
                  </Typography>
                </Typography>
                <Typography variant="body2" color="text.secondary">{p.blurb}</Typography>
              </Card>
            </Grid>
          ))}
        </Grid>
        <Box sx={{ mt: 2 }}>
          <SplitBar rev={rev} />
        </Box>
      </Box>

      {/* ── 免費試用 ── */}
      <Card sx={{ p: 3, borderLeft: '3px solid', borderColor: 'success.main' }}>
        <Typography variant="h6" sx={{ fontWeight: 'bold', mb: 1 }}>{docs.tryBuy.title}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {docs.tryBuy.description}
        </Typography>
        <Button variant="contained" color="success" disabled={busy} onClick={() => void tryBuy()}>
          {busy ? docs.tryBuy.busy : docs.tryBuy.cta}
        </Button>
        {err && <Alert severity="error" sx={{ mt: 2 }}>{err}</Alert>}
        {result && (
          <Box sx={{ mt: 2 }}>
            {result.settlementTx && (
              <Alert severity="success" sx={{ mb: 1 }}>
                {docs.tryBuy.settled}
                <Link href={basescanTx(result.settlementTx)} target="_blank" rel="noopener" color="inherit" sx={{ textDecoration: 'underline' }}>
                  {docs.tryBuy.viewSettlement}
                </Link>
              </Alert>
            )}
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
              {docs.tryBuy.resultCaption}
            </Typography>
            <Mono>{JSON.stringify(result.signal ?? result, null, 2)}</Mono>
          </Box>
        )}
      </Card>

      {/* ── 怎麼開始使用 ── */}
      <Box>
        <SectionHeading>{docs.start.heading}</SectionHeading>
        <Card sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            {startSteps.map((s, i) => (
              <Stack key={s.title} direction="row" spacing={2} alignItems="flex-start">
                <StepNumber n={i + 1} />
                <Box>
                  <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 0.5 }}>{s.title}</Typography>
                  <Typography variant="body2" color="text.secondary">{s.body}</Typography>
                  {'extra' in s && <Box sx={{ mt: 0.75 }}>{s.extra}</Box>}
                </Box>
              </Stack>
            ))}
          </Stack>
          <Alert severity="info" sx={{ mt: 3 }}>{docs.start.note}</Alert>
        </Card>
      </Box>

      {/* ── 常見問題 ── */}
      <Box>
        <SectionHeading>{docs.faq.heading}</SectionHeading>
        <Stack spacing={2}>
          {FAQ.map((f) => (
            <Box key={f.q}>
              <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 0.5 }}>{f.q}</Typography>
              <Typography variant="body2" color="text.secondary">{f.a}</Typography>
            </Box>
          ))}
        </Stack>
      </Box>

      {/* ── 給開發者（預設收合）：術語、參數、程式範例 ── */}
      <Accordion disableGutters sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, '&::before': { display: 'none' } }}>
        <AccordionSummary>
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>{docs.advanced.summary}</Typography>
            <Typography variant="caption" color="text.secondary">{docs.advanced.hint}</Typography>
          </Box>
        </AccordionSummary>
        <AccordionDetails>
          <Stack spacing={1.2} sx={{ mb: 3 }}>
            {[
              [docs.advanced.fact.baseUrl, SIGNAL_API_URL],
              [docs.advanced.fact.network, 'base-sepolia (84532)'],
              [
                docs.advanced.fact.asset,
                interpolate(docs.advanced.fact.assetValue, { address: OFFICIAL_USDC }),
              ],
              [docs.advanced.fact.router, X402_FEE_ROUTER],
              [docs.advanced.fact.pricing, docs.advanced.fact.pricingValue],
            ].map(([k, v]) => (
              <Box key={k} sx={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                <Typography variant="caption" color="text.secondary" sx={{ minWidth: 130, fontWeight: 'bold' }}>{k}</Typography>
                <Typography variant="body2" sx={{ fontFamily: MONO, wordBreak: 'break-all' }}>{v}</Typography>
              </Box>
            ))}
          </Stack>

          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mb: 1 }}>{docs.advanced.step1}</Typography>
          <Mono>{`curl -s ${SIGNAL_API_URL}/`}</Mono>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', mt: 2, mb: 1 }}>{docs.advanced.step2}</Typography>
          <Mono>{`# agent/examples/buy-signal.ts — 只依賴 viem + x402-fetch
export X402_API_URL=${SIGNAL_API_URL}
export AGENT_PRIVATE_KEY=0x...   # 持 Circle USDC + 一點 ETH
npx tsx examples/buy-signal.ts`}</Mono>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {docs.advanced.flow}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            {docs.advanced.networkErrorHint}
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 2, opacity: 0.7 }}>
            {docs.footer}
          </Typography>
        </AccordionDetails>
      </Accordion>
    </Container>
  )
}
