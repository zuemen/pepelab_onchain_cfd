import Box from '@mui/material/Box'

import { t } from 'src/locales'

import { C, monoCss } from './terminal-theme'

/** 品牌列：logo、網路標示、連線指示燈。 */
export function TerminalHeader() {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
      <Box sx={{ fontSize: 18 }}>🐸</Box>
      <Box sx={{ ...monoCss, fontWeight: 800, fontSize: 14, letterSpacing: '.18em', color: C.ink }}>
        PEPELAB<span style={{ color: C.lime }}>·</span>TERMINAL
      </Box>
      <Box sx={{ ...monoCss, fontSize: 11, color: C.mut, letterSpacing: '.08em' }}>
        {t.terminal.header.tagline}
      </Box>
      <Box
        sx={{
          ml: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 0.7,
          ...monoCss,
          fontSize: 11.5,
          color: C.green,
        }}
      >
        <Box
          sx={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            bgcolor: C.green,
            animation: 'tPulse 1.6s ease-out infinite',
            '@keyframes tPulse': {
              '0%': { boxShadow: `0 0 0 0 ${C.greenDim}` },
              '70%': { boxShadow: '0 0 0 6px rgba(63,217,138,0)' },
              '100%': { boxShadow: '0 0 0 0 rgba(63,217,138,0)' },
            },
          }}
        />
        {t.terminal.header.status}
      </Box>
    </Box>
  )
}
