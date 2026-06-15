// PepeLab landing hero — live on-chain KPI strip.
// x402 revenue + call count come from the public signal-api /revenue (no wallet
// needed → genuinely live on the landing). Open-interest is read from the
// exchange when a wallet is connected, otherwise shown as a quiet placeholder.

import { useEffect, useRef, useState } from 'react'
import { formatUnits } from 'ethers'

import Box from '@mui/material/Box'
import Grid from '@mui/material/Grid'
import Stack from '@mui/material/Stack'
import Typography from '@mui/material/Typography'

import { usePepefiWallet } from 'src/layouts/pepefi'
import { useContracts } from 'src/hooks/useContracts'
import { useFundingData } from 'src/hooks/useFundingData'
import { SIGNAL_API_URL } from 'src/lib/pepefi/signalApi'

import { Mono, LiveDot, PEPE, hexA } from './brandKit'

interface RevenueTotals {
  count: number
  feeUsd: number
}

/** Smoothly tween a number toward `target` for a lively "counting" feel. */
function useCountUp(target: number, ms = 700): number {
  const [val, setVal] = useState(target)
  const fromRef = useRef(target)
  const startRef = useRef(0)
  useEffect(() => {
    const from = fromRef.current
    if (from === target) return
    let raf = 0
    const tick = (t: number) => {
      if (!startRef.current) startRef.current = t
      const p = Math.min(1, (t - startRef.current) / ms)
      const eased = 1 - Math.pow(1 - p, 3)
      setVal(from + (target - from) * eased)
      if (p < 1) raf = requestAnimationFrame(tick)
      else {
        fromRef.current = target
        startRef.current = 0
      }
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [target, ms])
  return val
}

function KpiTile({
  label,
  children,
  live,
}: {
  label: string
  children: React.ReactNode
  live?: boolean
}) {
  return (
    <Box
      sx={{
        p: { xs: 2, md: 2.5 },
        height: '100%',
        borderRadius: 2,
        border: '1px solid',
        borderColor: PEPE.line,
        bgcolor: hexA(PEPE.green, 0.03),
        backdropFilter: 'blur(6px)',
        transition: 'border-color .25s, transform .25s',
        '&:hover': { borderColor: hexA(PEPE.green, 0.4), transform: 'translateY(-3px)' },
      }}
    >
      <Stack direction="row" alignItems="center" spacing={0.8} sx={{ mb: 1 }}>
        {live && <LiveDot size={6} />}
        <Typography
          variant="caption"
          sx={{
            color: 'text.secondary',
            textTransform: 'uppercase',
            letterSpacing: 1.5,
            fontWeight: 700,
            fontSize: 11,
          }}
        >
          {label}
        </Typography>
      </Stack>
      <Typography component="div" sx={{ fontSize: { xs: '1.5rem', md: '1.9rem' }, lineHeight: 1 }}>
        {children}
      </Typography>
    </Box>
  )
}

export default function HeroKpiStrip() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const funding = useFundingData(contracts?.exchange ?? null)

  const [rev, setRev] = useState<RevenueTotals | null>(null)

  useEffect(() => {
    let alive = true
    const pull = async () => {
      try {
        const r = await (await fetch(`${SIGNAL_API_URL}/revenue`)).json()
        if (alive && r?.totals) setRev({ count: r.totals.count, feeUsd: r.totals.feeUsd })
      } catch {
        /* offline → leave previous value */
      }
    }
    void pull()
    const id = setInterval(pull, 15_000)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  // Aggregate open interest (long+short notional, 18-dec) across listed assets.
  const totalOI = Object.values(funding).reduce((acc, f) => acc + f.longOI + f.shortOI, 0n)
  const hasOI = Object.keys(funding).length > 0

  const feeUsd = useCountUp(rev?.feeUsd ?? 0)
  const calls = useCountUp(rev?.count ?? 0)

  const oiUsd = hasOI ? Number(formatUnits(totalOI, 18)) : null

  return (
    <Grid container spacing={1.5} sx={{ mb: 5 }}>
      <Grid size={{ xs: 6, md: 3 }}>
        <KpiTile label="x402 Revenue" live={!!rev}>
          <Mono glow tone="green">
            ${feeUsd.toFixed(3)}
          </Mono>
        </KpiTile>
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <KpiTile label="Agent Calls Paid" live={!!rev}>
          <Mono tone="gold">{Math.round(calls).toLocaleString()}</Mono>
        </KpiTile>
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <KpiTile label="Open Interest" live={hasOI}>
          {oiUsd != null ? (
            <Mono tone="green">
              ${oiUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}
            </Mono>
          ) : (
            <Mono tone="muted" sx={{ fontSize: '1.1rem' }}>
              connect ↗
            </Mono>
          )}
        </KpiTile>
      </Grid>
      <Grid size={{ xs: 6, md: 3 }}>
        <KpiTile label="Network">
          <Stack direction="row" alignItems="center" spacing={1}>
            <LiveDot color={PEPE.green} size={7} />
            <Mono tone="green" sx={{ fontSize: '1.05rem' }}>
              Base Sepolia
            </Mono>
          </Stack>
          <Typography
            variant="caption"
            sx={{ color: 'text.secondary', fontFamily: 'inherit', display: 'block', mt: 0.5 }}
          >
            <Mono tone="muted" sx={{ fontSize: 12 }}>
              chainId 84532
            </Mono>
          </Typography>
        </KpiTile>
      </Grid>
    </Grid>
  )
}
