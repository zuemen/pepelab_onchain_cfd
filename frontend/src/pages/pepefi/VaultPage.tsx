import { MONO } from 'src/components/pepefi/brandKit'
import { useRef, useState, useEffect, useCallback } from 'react'
import type { Contract } from 'ethers'
import { parseUnits, formatUnits } from 'ethers'
import { useContracts } from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { t, interpolate } from 'src/locales'
import { useMode } from 'src/contexts/mode-context'
import { prettyError } from 'src/lib/pepefi/errorMessages'
import { safeRead } from 'src/lib/pepefi/safeRead'
import { UI_RETRIES, scanFromBlock, scanContractEvents } from 'src/lib/pepefi/chainLogs'
import Skeleton, { TableSkeleton } from 'src/components/pepefi/Skeleton'
import EmptyState from 'src/components/pepefi/EmptyState'
import { useToast } from 'src/components/pepefi/ToastProvider'

import Box from '@mui/material/Box';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Alert from '@mui/material/Alert';
import TextField from '@mui/material/TextField';
import TableContainer from '@mui/material/TableContainer';
import Table from '@mui/material/Table';
import TableHead from '@mui/material/TableHead';
import TableBody from '@mui/material/TableBody';
import TableRow from '@mui/material/TableRow';
import TableCell from '@mui/material/TableCell';

interface VaultStats {
  totalAssets:  bigint
  totalSupply:  bigint
  sharePrice:   bigint
  myShares:     bigint
  myUsdcValue:  bigint
  feesRouted:   bigint  // N1: cumulative trading fees routed to the vault
  feeShareBps:  bigint  // N1: % of trading fee routed to LPs
}

interface ActivityEntry {
  type:   'Deposited' | 'Withdrawn' | 'ProtocolDeposit' | 'Bailout'
  label:  string
  amount: string
  from:   string
  block:  number
}

const ZERO = 0n

function f18(v: bigint, dec = 2): string {
  return Number(formatUnits(v, 18)).toLocaleString(undefined, {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  })
}

interface ActivityResult {
  entries: ActivityEntry[]
  /** 掃描有任何一段讀不到。true 時空白不代表「沒有活動」。 */
  failed: boolean
  /** 實際回看了幾塊，顯示給使用者。 */
  blocks: number
}

/**
 * 金庫近期活動。以前只查最近 200 塊（Base 上約 7 分鐘），幾乎永遠是空的，
 * 而且任何錯誤都被吞成「尚無活動」。現在回看 scanFromBlock 的預設視窗
 * （24 小時，並以部署塊為下限），走分段 getLogs，失敗就明說。
 */
async function fetchActivity(
  vault: Contract,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  provider: { getBlockNumber: () => Promise<number>; getLogs: (f: any) => Promise<any[]> },
  chainId: number | null | undefined,
): Promise<ActivityResult> {
  const events: ActivityEntry[] = []
  try {
    const latest = await provider.getBlockNumber()
    const from = scanFromBlock({ chainId, currentBlock: latest })
    const r = await scanContractEvents(
      provider,
      vault,
      [vault.filters.Deposited(), vault.filters.Withdrawn(), vault.filters.ProtocolDeposit(), vault.filters.Bailout()],
      from,
      latest,
      { retries: UI_RETRIES },
    )
    for (const e of r.events) {
      const args = e.args
      switch (e.eventName) {
        case 'Deposited':
          events.push({ type: 'Deposited', label: t.vault.activity.deposited, amount: f18(args.usdcAmount) + ' USDC', from: args.user, block: e.blockNumber })
          break
        case 'Withdrawn':
          events.push({ type: 'Withdrawn', label: t.vault.activity.withdrawn, amount: f18(args.usdcAmount) + ' USDC', from: args.user, block: e.blockNumber })
          break
        case 'ProtocolDeposit':
          events.push({ type: 'ProtocolDeposit', label: t.vault.activity.protocolDeposit, amount: f18(args.amount) + ' USDC', from: args.from, block: e.blockNumber })
          break
        case 'Bailout':
          events.push({ type: 'Bailout', label: t.vault.activity.bailout, amount: f18(args.amount) + ' USDC', from: args.trader, block: e.blockNumber })
          break
        default:
          break
      }
    }
    events.sort((x, y) => y.block - x.block)
    return { entries: events, failed: r.failedChunks > 0, blocks: latest - from + 1 }
  } catch (err) {
    console.warn('[vault] activity read failed', err)
    return { entries: events, failed: true, blocks: 0 }
  }
}

export default function VaultPage() {
  const wallet = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)
  const vault     = contracts?.insuranceVault ?? null
  const usdc      = contracts?.usdc ?? null
  const exchange  = contracts?.exchange ?? null

  const [stats, setStats]         = useState<VaultStats | null>(null)
  const [activityRes, setActivityRes] = useState<ActivityResult>({ entries: [], failed: false, blocks: 0 })
  const activity = activityRes.entries
  /** 活動掃描進行中。載入中不能顯示「尚無活動」。 */
  const [activityLoading, setActivityLoading] = useState(true)
  // 只採用最後一次發出的掃描結果：存入後的刷新與首次載入可能同時在飛。
  const activityRun = useRef(0)

  const refreshActivity = useCallback(async () => {
    // 早退也要遞增：讓還在飛的舊掃描回來時被丟棄。
    activityRun.current += 1
    const myRun = activityRun.current
    if (!vault || !wallet.provider) {
      // 沒有金庫或 provider（例如斷線、換到未部署的鏈）：上一個狀態的活動不能留在畫面上。
      setActivityRes({ entries: [], failed: false, blocks: 0 })
      setActivityLoading(false)
      return
    }
    setActivityLoading(true)
    const res = await fetchActivity(vault, wallet.provider, wallet.chainId)
    if (myRun !== activityRun.current) return
    setActivityRes(res)
    setActivityLoading(false)
  }, [vault, wallet.provider, wallet.chainId])
  const [depositAmt, setDepositAmt] = useState('')
  const [withdrawAmt, setWithdrawAmt] = useState('')
  const [busy, setBusy]           = useState(false)

  const { notify } = useToast()
  const { mode } = useMode()
  const isExpert = mode === 'expert'

  const fetchStats = useCallback(async () => {
    if (!vault || !wallet.address) return
    try {
      // Isolated so one unavailable view doesn't blank every vault stat.
      const [totalAssets, totalSupply, sharePrice, myShares] = await Promise.all([
        safeRead(vault.totalAssets()    as Promise<bigint>, ZERO),
        safeRead(vault.totalSupply()    as Promise<bigint>, ZERO),
        safeRead(vault.getSharePrice()  as Promise<bigint>, ZERO),
        safeRead(vault.balanceOf(wallet.address) as Promise<bigint>, ZERO),
      ])
      // N1: trading-fee routing stats (best-effort; older ABIs lack these).
      let feesRouted = ZERO
      let feeShareBps = ZERO
      if (exchange) {
        try {
          ;[feesRouted, feeShareBps] = await Promise.all([
            exchange.cumulativeVaultFees() as Promise<bigint>,
            exchange.vaultFeeShareBps()    as Promise<bigint>,
          ])
        } catch { /* feature not deployed */ }
      }
      const myUsdcValue = totalSupply > ZERO
        ? myShares * totalAssets / totalSupply
        : ZERO
      setStats({ totalAssets, totalSupply, sharePrice, myShares, myUsdcValue, feesRouted, feeShareBps })
    } catch { /* not deployed */ }
  }, [vault, exchange, wallet.address])

  useEffect(() => {
    void fetchStats()
    void refreshActivity()
    const t = setInterval(() => { void fetchStats() }, 15_000)
    return () => clearInterval(t)
  }, [fetchStats, refreshActivity])

  const doDeposit = async () => {
    if (!vault || !usdc || !wallet.signer) return
    setBusy(true)
    try {
      const amount = parseUnits(depositAmt.trim(), 18)
      const approveTx = await usdc.approve(await vault.getAddress(), amount)
      await approveTx.wait()
      const tx = await vault.deposit(amount)
      await tx.wait()
      notify(interpolate(t.vault.deposit.done, { amount: depositAmt }), true, tx.hash)
      setDepositAmt('')
      await fetchStats()
      // 活動掃描要幾十段 getLogs，不能擋住按鈕解鎖——背景刷新即可。
      void refreshActivity()
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy(false)
    }
  }

  const doWithdraw = async () => {
    if (!vault || !wallet.signer) return
    setBusy(true)
    try {
      const shares = parseUnits(withdrawAmt.trim(), 18)
      const tx = await vault.withdraw(shares)
      await tx.wait()
      notify(interpolate(t.vault.withdraw.done, { amount: withdrawAmt }), true, tx.hash)
      setWithdrawAmt('')
      await fetchStats()
      // 活動掃描要幾十段 getLogs，不能擋住按鈕解鎖——背景刷新即可。
      void refreshActivity()
    } catch (e) {
      notify(prettyError(e), false)
    } finally {
      setBusy(false)
    }
  }

  if (!wallet.isConnected) {
    return (
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '60vh' }}>
        <Typography color="text.secondary">{t.vault.connectWallet}</Typography>
      </Box>
    )
  }

  const activityColorMui: Record<ActivityEntry['type'], string> = {
    Deposited:      'success.main',
    Withdrawn:      'warning.main',
    ProtocolDeposit:'info.main',
    Bailout:        'error.main',
  }

  return (
    <Container maxWidth="md" sx={{ py: 3, display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* #151: header aligned with /tokens' title/titleSimple + subtitle pattern. */}
      <Box>
        <Typography variant="h4" sx={{ fontWeight: 800 }}>
          {mode === 'simple' ? t.vault.titleSimple : t.vault.title}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t.vault.subtitle}
        </Typography>
      </Box>

      {/* Stats */}
      <Grid container spacing={2}>
        {[
          { label: t.vault.stat.totalAssets, value: stats ? f18(stats.totalAssets) + ' USDC' : null },
          { label: t.vault.stat.sharePrice,  value: stats ? f18(stats.sharePrice) + ' USDC/pIV' : null },
          { label: t.vault.stat.totalSupply, value: stats ? f18(stats.totalSupply) + ' pIV' : null },
          { label: t.vault.stat.myValue,     value: stats ? f18(stats.myUsdcValue) + ' USDC' : null },
        ].map(s => (
          <Grid size={{ xs: 6, md: 3 }} key={s.label}>
            <Card sx={{ p: 2 }}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                {s.label}
              </Typography>
              {s.value === null ? (
                <Skeleton height={28} sx={{ width: '80%', mt: 0.5 }} />
              ) : (
                <Typography variant="h6" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                  {s.value}
                </Typography>
              )}
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* N1: trading-fee → LP routing (market-making yield).
          #151: the bps/amount breakdown is mechanism detail (Expert only,
          matching /tokens' health grid) — Simple gets one plain-language
          line with no percentages, same split as /tokens' simpleReserve. */}
      {stats && stats.feeShareBps > ZERO && (
        isExpert ? (
          <Card sx={{ p: 2, bgcolor: 'background.neutral', borderLeft: '3px solid', borderColor: 'success.main' }}>
            <Typography variant="body2" sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5, alignItems: 'baseline' }}>
              <Box component="span" sx={{ fontWeight: 'bold', color: 'success.main' }}>
                {t.vault.markup.mmActiveLabel}
              </Box>
              <Box component="span" sx={{ color: 'text.secondary' }}>
                {interpolate(t.vault.markup.mmPctRouted, { pct: Number(stats.feeShareBps) / 100 })}
              </Box>
              <Box component="span" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                {interpolate(t.vault.markup.mmAmount, { amount: f18(stats.feesRouted) })}
              </Box>
              <Box component="span" sx={{ color: 'text.secondary' }}>{t.vault.markup.mmRoutedToDate}</Box>
            </Typography>
          </Card>
        ) : (
          <Alert severity="success" variant="outlined">
            {t.vault.simpleYieldActive}
          </Alert>
        )
      )}

      {/* Your position */}
      {stats && stats.myShares > ZERO && (
        <Card sx={{ p: 3, bgcolor: 'background.neutral' }}>
          <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 2, fontWeight: 'bold' }}>
            {t.vault.position.title}
          </Typography>
          <Stack direction="row" spacing={4}>
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {t.vault.position.shares}
              </Typography>
              <Typography variant="body1" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                {f18(stats.myShares, 4)}
              </Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                {t.vault.position.value}
              </Typography>
              <Typography variant="body1" color="success.main" sx={{ fontFamily: MONO, fontWeight: 'bold' }}>
                {f18(stats.myUsdcValue)}
              </Typography>
            </Box>
          </Stack>
        </Card>
      )}

      {/* Deposit + Withdraw */}
      <Grid container spacing={2}>
        {/* Deposit */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
              {t.vault.deposit.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
              {t.vault.deposit.description}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                type="number"
                size="small"
                placeholder={t.vault.deposit.placeholder}
                value={depositAmt}
                onChange={e => setDepositAmt(e.target.value)}
                slotProps={{ htmlInput: { min: "0", style: { fontFamily: MONO } } }}
                sx={{ flexGrow: 1 }}
              />
              <Button
                variant="contained"
                onClick={() => void doDeposit()}
                disabled={busy || !depositAmt}
              >
                {busy ? t.vault.working : t.vault.deposit.cta}
              </Button>
            </Box>
            {stats && depositAmt && (
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                {interpolate(t.vault.deposit.estimate, {
                  shares: f18(
                    stats.totalSupply > ZERO && stats.totalAssets > ZERO
                      ? (BigInt(Math.floor(Number(depositAmt) * 1e18)) * stats.totalSupply) /
                          stats.totalAssets
                      : BigInt(Math.floor(Number(depositAmt) * 1e18)),
                    4,
                  ),
                })}
              </Typography>
            )}
          </Card>
        </Grid>

        {/* Withdraw */}
        <Grid size={{ xs: 12, md: 6 }}>
          <Card sx={{ p: 3, display: 'flex', flexDirection: 'column', gap: 2, height: '100%' }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
              {t.vault.withdraw.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ flexGrow: 1 }}>
              {t.vault.withdraw.description}
            </Typography>
            <Box sx={{ display: 'flex', gap: 1 }}>
              <TextField
                type="number"
                size="small"
                placeholder={t.vault.withdraw.placeholder}
                value={withdrawAmt}
                onChange={e => setWithdrawAmt(e.target.value)}
                slotProps={{ htmlInput: { min: "0", style: { fontFamily: MONO } } }}
                sx={{ flexGrow: 1 }}
              />
              <Button
                variant="contained"
                color="warning"
                onClick={() => void doWithdraw()}
                disabled={busy || !withdrawAmt}
              >
                {busy ? t.vault.working : t.vault.withdraw.cta}
              </Button>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              {stats && withdrawAmt ? (
                <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                  {interpolate(t.vault.withdraw.estimate, {
                    amount: f18(
                      stats.totalSupply > ZERO
                        ? (BigInt(Math.floor(Number(withdrawAmt) * 1e18)) * stats.totalAssets) /
                            stats.totalSupply
                        : 0n,
                      4,
                    ),
                  })}
                </Typography>
              ) : <Box />}
              {stats && stats.myShares > ZERO && (
                <Button
                  size="small"
                  variant="text"
                  color="inherit"
                  onClick={() => setWithdrawAmt(formatUnits(stats.myShares, 18))}
                  sx={{ textDecoration: 'underline', p: 0, minWidth: 0, textTransform: 'none', typography: 'caption', color: 'text.secondary', '&:hover': { color: 'text.primary', bgcolor: 'transparent' } }}
                >
                  {interpolate(t.vault.withdraw.max, { shares: f18(stats.myShares, 4) })}
                </Button>
              )}
            </Box>
          </Card>
        </Grid>
      </Grid>

      {/* Activity Feed */}
      <Card>
        <Box sx={{ p: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
            {t.vault.activity.title}
          </Typography>
        </Box>
        {activityRes.failed && activity.length > 0 && (
          <Alert severity="warning" sx={{ m: 2 }}>{t.vault.activity.partial}</Alert>
        )}
        {activityLoading && activity.length === 0 ? (
          <TableSkeleton rows={4} cols={4} />
        ) : activity.length === 0 && activityRes.failed ? (
          // 讀取失敗不是「尚無活動」。
          <EmptyState
            icon="⚠️"
            title={t.vault.activity.readFailedTitle}
            description={t.vault.activity.readFailedDescription}
          />
        ) : activity.length === 0 ? (
          <EmptyState
            icon="🏦"
            title={t.vault.activity.emptyTitle}
            description={t.vault.activity.emptyDescription}
          />
        ) : (
          <TableContainer>
            <Table size="small">
              <TableBody>
                {activity.slice(0, 20).map((a, i) => (
                  <TableRow key={i} sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                    <TableCell>
                      <Typography variant="body2" sx={{ fontWeight: 'bold', color: activityColorMui[a.type] }}>
                        {a.label}
                      </Typography>
                    </TableCell>
                    <TableCell>
                      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                        {a.from.slice(0, 10)}…
                      </Typography>
                    </TableCell>
                    <TableCell align="right">
                      <Typography variant="body2" sx={{ fontFamily: MONO, fontWeight: 'semibold' }}>
                        {a.amount}
                      </Typography>
                    </TableCell>
                    {/* #151: block number is chain-internals detail — Expert only,
                        same split as /tokens' priceUpdatedAt/assetId columns. */}
                    {isExpert && (
                      <TableCell align="right">
                        <Typography variant="caption" color="text.secondary" sx={{ fontFamily: MONO }}>
                          {interpolate(t.vault.activity.block, { block: a.block })}
                        </Typography>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>

      {/* Info box — #151: names contract fields (liquidationPenaltyBps, BadDebt,
          recapitalize()), which is mechanism detail barred from Simple Mode
          (frontend/CONTEXT.md's Mode entry) — Expert only, same as /tokens'
          protectionsList accordion. */}
      {isExpert && (
        <Card sx={{ p: 2.5, bgcolor: 'background.neutral' }}>
          <Stack spacing={1}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              <Box component="span" sx={{ color: 'text.primary', fontWeight: 'bold' }}>{t.vault.markup.howItWorksLabel}</Box>{t.vault.markup.howItWorksBody}<Box component="span" sx={{ fontWeight: 'bold' }}>{t.vault.markup.liquidationPenaltyLabel}</Box>{t.vault.markup.howItWorksCodeWrap}<code>liquidationPenaltyBps</code>{t.vault.markup.howItWorksTail}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
              {t.vault.markup.badDebtBefore}<code>BadDebt</code>{t.vault.markup.badDebtMid}<code>recapitalize()</code>{t.vault.markup.badDebtAfter}
            </Typography>
          </Stack>
        </Card>
      )}
    </Container>
  )
}
