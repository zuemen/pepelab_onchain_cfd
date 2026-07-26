// PepeLab brand kit — shared design tokens + tiny presentational primitives.
// Concept: "on-chain lab terminal" — green-tinted near-black, neon pepe-green
// data, JetBrains Mono numerals, kept playful with the 🐸 mascot energy.
// Reused by Landing hero, Trade Terminal and the x402 marketplace surfaces.

import Box from '@mui/material/Box'
import type { BoxProps } from '@mui/material/Box'

// ---- tokens ----------------------------------------------------------------

/** Monospace stack for prices / addresses / on-chain figures. */
export const MONO =
  "'JetBrains Mono Variable', ui-monospace, 'SF Mono', 'Roboto Mono', monospace"

export const PEPE = {
  green: '#7cc14a', // primary — pepe-green
  greenBright: '#a8e85a', // hover / emphasis
  gold: '#FFD23D', // secondary — meme gold
  long: '#22C55E', // 做多 / 正值
  short: '#FF5630', // 做空 / 負值
  ink: '#0A0F0B', // page background
  panel: '#121A13', // raised panel
  line: 'rgba(124,193,74,0.16)', // hairline on dark
} as const

/** Neon text-shadow glow in a given colour (defaults to pepe-green). */
export const pepeGlow = (color: string = PEPE.green, strength = 0.55) =>
  `0 0 24px ${hexA(color, strength)}, 0 0 2px ${hexA(color, strength)}`

/** Append an alpha (0–1) to a #rrggbb hex → rgba(). */
export function hexA(hex: string, a: number): string {
  const h = hex.replace('#', '')
  const r = parseInt(h.slice(0, 2), 16)
  const g = parseInt(h.slice(2, 4), 16)
  const b = parseInt(h.slice(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

/** Shorten a 0x address → 0x1234…abcd. */
export const shortAddr = (a?: string, head = 6, tail = 4): string =>
  !a ? '' : a.length <= head + tail ? a : `${a.slice(0, head)}…${a.slice(-tail)}`

// ---- primitives ------------------------------------------------------------

type MonoProps = BoxProps & {
  /** Tint: 'long' (green), 'short' (red), 'gold', or default green data. */
  tone?: 'long' | 'short' | 'gold' | 'green' | 'muted'
  glow?: boolean
}

/** Inline monospace value — the workhorse for on-chain numerals. */
export function Mono({ tone = 'green', glow = false, sx, children, ...rest }: MonoProps) {
  const color =
    tone === 'long'
      ? PEPE.long
      : tone === 'short'
        ? PEPE.short
        : tone === 'gold'
          ? PEPE.gold
          : tone === 'muted'
            ? 'text.secondary'
            : PEPE.green
  return (
    <Box
      component="span"
      sx={{
        fontFamily: MONO,
        fontWeight: 600,
        letterSpacing: '-0.02em',
        color,
        textShadow: glow ? pepeGlow(typeof color === 'string' && color.startsWith('#') ? color : PEPE.green) : 'none',
        ...sx,
      }}
      {...rest}
    >
      {children}
    </Box>
  )
}

/** Pulsing "live" status dot. */
export function LiveDot({ color = PEPE.green, size = 7 }: { color?: string; size?: number }) {
  return (
    <Box
      component="span"
      sx={{
        display: 'inline-block',
        width: size,
        height: size,
        borderRadius: '50%',
        bgcolor: color,
        boxShadow: `0 0 0 0 ${hexA(color, 0.6)}`,
        animation: 'pepePulse 1.6s ease-out infinite',
        '@keyframes pepePulse': {
          '0%': { boxShadow: `0 0 0 0 ${hexA(color, 0.55)}` },
          '70%': { boxShadow: `0 0 0 6px ${hexA(color, 0)}` },
          '100%': { boxShadow: `0 0 0 0 ${hexA(color, 0)}` },
        },
      }}
    />
  )
}
