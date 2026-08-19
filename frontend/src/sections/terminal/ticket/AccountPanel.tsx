import { useState } from 'react'

import Box from '@mui/material/Box'
import Button from '@mui/material/Button'

import { t, interpolate } from 'src/locales'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { fUsd, fNum, fToken, fromUnits } from 'src/lib/pepefi/format'

import { Row } from '../Atoms'
import { C, panel, monoCss } from '../terminal-theme'
import { asTx, tryParse, type TerminalContracts } from '../types'

type Stable = 'USDC' | 'USDT'

/** 帳戶區：權益、可用保證金、未實現損益、幣別切換與入金。 */
export function AccountPanel({
  contracts,
  equity,
  freeMgn,
  totalPnl,
  usdcBal,
  usdtBal,
  stable,
  setStable,
  notify,
  onDeposited,
}: {
  contracts: TerminalContracts
  equity: bigint
  freeMgn: bigint
  totalPnl: bigint
  usdcBal: bigint
  usdtBal: bigint
  stable: Stable
  setStable: (s: Stable) => void
  notify: (msg: string, ok: boolean) => void
  onDeposited: () => Promise<void>
}) {
  const [dep, setDep] = useState('')
  const [busy, setBusy] = useState(false)

  const deposit = async () => {
    if (!contracts) return
    const amt = tryParse(dep)
    if (!amt) {
      notify(t.terminal.account.enterAmount, false)
      return
    }
    setBusy(true)
    try {
      const a = asTx(await contracts.usdc.approve(String(contracts.exchange.target), amt))
      await a.wait()
      const d = asTx(await contracts.exchange.depositMargin(amt))
      await d.wait()
      notify(interpolate(t.terminal.account.deposited, { amount: dep }), true)
      setDep('')
      await onDeposited()
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy(false)
    }
  }

  const pnl = fromUnits(totalPnl, 18)

  return (
    <Box
      sx={{
        borderTop: `1px solid ${C.line}`,
        pt: 1.5,
        mt: 0.5,
        display: 'flex',
        flexDirection: 'column',
        gap: 0.6,
      }}
    >
      <Row k={t.terminal.account.equity} v={fUsd(fromUnits(equity, 18))} strong />
      <Row
        k={t.terminal.account.freeMargin}
        v={fToken(fromUnits(freeMgn, 18), 'USDC', { dp: 2 })}
      />
      <Row
        k={t.terminal.account.unrealizedPnl}
        v={fNum(pnl, { dp: 4, signed: true })}
        color={pnl >= 0 ? C.green : C.red}
      />

      {/* 幣別切換只影響餘額顯示。入金一律走 USDC，因為 PerpetualExchange 寫死了；
          下面那行說明就是在講這件事。 */}
      <Box sx={{ display: 'flex', gap: 0.6, mt: 0.4 }}>
        {(['USDC', 'USDT'] as const).map((s) => {
          const on = stable === s
          return (
            <Box
              key={s}
              onClick={() => setStable(s)}
              sx={{
                ...monoCss,
                flex: 1,
                textAlign: 'center',
                py: 0.6,
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: 11,
                fontWeight: 700,
                bgcolor: on ? 'rgba(255,255,255,.06)' : 'transparent',
                color: on ? C.ink : C.mut,
                border: `1px solid ${on ? C.ink : C.line}`,
                transition: '.15s',
              }}
            >
              {s}
            </Box>
          )
        })}
      </Box>

      <Row
        k={interpolate(t.terminal.account.wallet, { token: stable })}
        v={fNum(fromUnits(stable === 'USDC' ? usdcBal : usdtBal, 18))}
      />
      <Box sx={{ ...monoCss, fontSize: 10, color: C.mut, lineHeight: 1.4 }}>
        {t.terminal.account.marginNote}
      </Box>

      <Box sx={{ display: 'flex', gap: 0.8, mt: 0.8 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', flex: 1, ...panel, bgcolor: C.panel2, px: 1.2 }}>
          <input
            value={dep}
            onChange={(e) => setDep(e.target.value)}
            type="number"
            placeholder={t.terminal.account.depositPlaceholder}
            aria-label={t.terminal.account.depositAria}
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: C.ink,
              fontFamily: C.mono,
              fontSize: 13,
              width: '100%',
              padding: '8px 0',
            }}
          />
        </Box>
        <Button
          onClick={() => void deposit()}
          disabled={busy}
          sx={{
            ...monoCss,
            fontSize: 12,
            fontWeight: 700,
            textTransform: 'none',
            px: 1.6,
            borderRadius: '9px',
            bgcolor: C.lime,
            color: '#0a0d07',
            '&:hover': { bgcolor: C.lime, filter: 'brightness(1.06)' },
            '&.Mui-disabled': { bgcolor: 'rgba(255,255,255,.05)', color: C.mut },
          }}
        >
          {busy ? t.exchange.working : t.terminal.account.deposit}
        </Button>
      </Box>
    </Box>
  )
}
