import { useState, useEffect, useCallback } from 'react'

import Box          from '@mui/material/Box'
import Card         from '@mui/material/Card'
import Grid         from '@mui/material/Grid'
import Chip         from '@mui/material/Chip'
import Stack        from '@mui/material/Stack'
import Button       from '@mui/material/Button'
import Divider      from '@mui/material/Divider'
import Container    from '@mui/material/Container'
import Typography   from '@mui/material/Typography'
import LinearProgress from '@mui/material/LinearProgress'

import { useContracts }    from 'src/hooks/useContracts'
import { usePepefiWallet } from 'src/layouts/pepefi'
import { pepeNameFor }     from 'src/lib/pepefi/pepeName'
import { prettyError }     from 'src/lib/pepefi/errorMessages'
import { ITEMS }           from 'src/lib/pepefi/items'
import { getEquipped }     from 'src/lib/pepefi/inventory'
import { BURN_ADDRESS }    from 'src/lib/pepefi/items'

import { PepeAvatar }      from 'src/components/pepefi/PepeAvatar'
import { PepeShopDialog }  from 'src/components/pepefi/PepeShopDialog'
import { LootBoxButton }   from 'src/components/pepefi/LootBoxButton'

// ── Helpers ───────────────────────────────────────────────────────────────────

const TODAY_INDEX = () => Math.floor(Date.now() / 1000 / 86400)

// ── Achievement definitions ───────────────────────────────────────────────────

interface Achievement {
  id:    string
  emoji: string
  title: string
  desc:  string
  check: (ctx: AchCtx) => boolean
}

interface AchCtx {
  streak:    number
  pepeNum:   number
  positions: number
  owned:     number
}

const ACHIEVEMENTS: Achievement[] = [
  { id: 'ach_first_stake',  emoji: '🌱', title: '初次質押',    desc: '持有任何 PEPE',             check: c => c.pepeNum > 0 },
  { id: 'ach_streak3',      emoji: '🔥', title: '3 天連到',    desc: '連續簽到 3 天',              check: c => c.streak >= 3 },
  { id: 'ach_streak7',      emoji: '⚡', title: '週簽神人',    desc: '連續簽到 7 天',              check: c => c.streak >= 7 },
  { id: 'ach_first_trade',  emoji: '📈', title: '首筆交易',    desc: '開過至少一筆倉',              check: c => c.positions >= 1 },
  { id: 'ach_whale',        emoji: '🐋', title: 'Whale 降臨', desc: '持有 100,000 PEPE',           check: c => c.pepeNum >= 100_000 },
  { id: 'ach_collector',    emoji: '🎨', title: '收藏家',      desc: '收藏至少 3 件 Pepe 道具',    check: c => c.owned >= 3 },
  { id: 'ach_degen',        emoji: '🎰', title: 'Degen',       desc: '持有 1,000,000 PEPE',        check: c => c.pepeNum >= 1_000_000 },
  { id: 'ach_legend',       emoji: '👑', title: '傳說 Pepe',   desc: '所有成就解鎖',               check: c => c.streak >= 7 && c.pepeNum >= 100_000 && c.owned >= 3 },
]

// ── Quest definitions ─────────────────────────────────────────────────────────

interface Quest {
  id:       string
  emoji:    string
  title:    string
  reward:   string
  progress: number   // 0-100
  done:     boolean
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function HomePage() {
  const wallet    = usePepefiWallet()
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId)

  const [pepeBalance, setPepeBalance] = useState<bigint | null>(null)
  const [streak,      setStreak]      = useState(0)
  const [lastDay,     setLastDay]     = useState(0)
  const [positions,   setPositions]   = useState(0)
  const [shopOpen,    setShopOpen]    = useState(false)
  const [toast,       setToast]       = useState<{ msg: string; ok: boolean } | null>(null)
  const [equipped,    setEquipped]    = useState<Record<string, string>>(() => getEquipped())

  const notify = (msg: string, ok: boolean) => {
    setToast({ msg, ok })
    setTimeout(() => setToast(null), 5000)
  }

  const fetchData = useCallback(async () => {
    if (!contracts || !wallet.address) return
    try {
      const bal = (await contracts.pepeToken.balanceOf(wallet.address)) as bigint
      setPepeBalance(bal)
    } catch { /* not deployed */ }
    try {
      const last = (await contracts.pepeIncentives.lastCheckIn(wallet.address)) as bigint
      const s    = (await contracts.pepeIncentives.streak(wallet.address)) as bigint
      setLastDay(Number(last))
      setStreak(Number(s))
    } catch { /* not deployed */ }
    try {
      const ids = (await contracts.exchange.getUserPositions(wallet.address)) as bigint[]
      setPositions(ids.length)
    } catch { /* not deployed */ }
  }, [contracts, wallet.address])

  useEffect(() => { if (wallet.isConnected) void fetchData() }, [fetchData, wallet.isConnected])

  const pepeNum       = pepeBalance !== null ? Number(pepeBalance) / 1e18 : 0
  const checkedToday  = lastDay === TODAY_INDEX()
  const dailyReward   = 50 + 10 * Math.min(streak, 6)
  const ownedCount    = Object.values(getEquipped()).length

  const achCtx: AchCtx = { streak, pepeNum, positions, owned: ownedCount }

  // ── Quests ──────────────────────────────────────────────────────────────────
  const quests: Quest[] = [
    { id: 'q_checkin',  emoji: '📅', title: '每日簽到',      reward: `+${dailyReward} PEPE`,    progress: checkedToday ? 100 : 0,  done: checkedToday },
    { id: 'q_trade',    emoji: '📈', title: '開一筆新倉',    reward: '+25 PEPE',                 progress: positions > 0 ? 100 : 0, done: positions > 0 },
    { id: 'q_balance',  emoji: '💰', title: '持有 100 PEPE', reward: '達成成就',                 progress: Math.min(100, pepeNum), done: pepeNum >= 100 },
    { id: 'q_streak3',  emoji: '🔥', title: '連簽 3 天',     reward: '解鎖成就',                 progress: Math.min(100, (streak / 3) * 100), done: streak >= 3 },
  ]

  // ── Buy handler (pepe.transfer to burn addr) ─────────────────────────────────
  const handleBuy = useCallback(async (_item: { price: number }, price: number) => {
    if (!contracts) throw new Error('Not connected')
    const amount = BigInt(price) * 10n ** 18n
    const tx = (await contracts.pepeToken.transfer(BURN_ADDRESS, amount)) as { wait(): Promise<unknown> }
    await tx.wait()
    notify(`購買成功！ -${price.toLocaleString()} PEPE 🐸`, true)
    setEquipped(getEquipped())
    await fetchData()
  }, [contracts, fetchData])

  const handleBurn = useCallback(async (amount: number) => {
    if (!contracts) throw new Error('Not connected')
    const amountBig = BigInt(amount) * 10n ** 18n
    const tx = (await contracts.pepeToken.transfer(BURN_ADDRESS, amountBig)) as { wait(): Promise<unknown> }
    await tx.wait()
    notify(`開箱成功！消耗 ${amount.toLocaleString()} PEPE`, true)
    await fetchData()
  }, [contracts, fetchData])

  const equippedItems = Object.values(equipped)
    .map(id => ITEMS.find(i => i.id === id))
    .filter(Boolean) as typeof ITEMS

  if (!wallet.isConnected) {
    return (
      <Container maxWidth="md" sx={{ py: 8, textAlign: 'center' }}>
        <Typography variant="h3" sx={{ fontWeight: 900, color: '#7cc14a', mb: 2 }}>🏠 我的 Pepe</Typography>
        <Typography color="text.secondary">請先連結錢包</Typography>
      </Container>
    )
  }

  return (
    <Container maxWidth="lg" sx={{ py: 4 }}>
      {/* Toast */}
      {toast && (
        <Box sx={{
          position: 'fixed', top: 80, right: 24, zIndex: 9999,
          bgcolor: toast.ok ? 'success.dark' : 'error.dark',
          color: '#fff', px: 3, py: 1.5, borderRadius: 2,
          boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
        }}>
          {toast.msg}
        </Box>
      )}

      <Typography variant="h4" sx={{ fontWeight: 900, mb: 3, color: '#7cc14a' }}>🏠 我的 Pepe</Typography>

      <Grid container spacing={3}>
        {/* ── Left: Achievements ── */}
        <Grid size={{ xs: 12, md: 4 }}>
          <Card sx={{ p: 2.5, bgcolor: '#0e1420', border: '1px solid #7cc14a22', borderRadius: 3, height: '100%' }}>
            <Typography fontWeight={900} fontSize={16} sx={{ mb: 2, color: '#7cc14a' }}>🏅 成就</Typography>
            <Stack spacing={1}>
              {ACHIEVEMENTS.map(a => {
                const done = a.check(achCtx)
                return (
                  <Box key={a.id} sx={{
                    display: 'flex', alignItems: 'center', gap: 1.5, p: 1,
                    borderRadius: 1.5, bgcolor: done ? '#7cc14a18' : 'transparent',
                    opacity: done ? 1 : 0.45,
                  }}>
                    <Typography fontSize={22}>{a.emoji}</Typography>
                    <Box>
                      <Typography fontSize={13} fontWeight={700} sx={{ color: done ? '#7cc14a' : 'text.primary' }}>{a.title}</Typography>
                      <Typography variant="caption" color="text.secondary">{a.desc}</Typography>
                    </Box>
                    {done && <Chip label="✓" size="small" sx={{ ml: 'auto', bgcolor: '#7cc14a', color: '#0e1420', fontWeight: 900, height: 20 }} />}
                  </Box>
                )
              })}
            </Stack>
          </Card>
        </Grid>

        {/* ── Center: My Pepe Card ── */}
        <Grid size={{ xs: 12, md: 4 }}>
          <Card sx={{
            p: 3, bgcolor: '#0e1420', border: '2px solid #7cc14a44', borderRadius: 3,
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, height: '100%',
          }}>
            {/* Avatar */}
            <Box sx={{ position: 'relative' }}>
              <PepeAvatar address={wallet.address ?? undefined} size={120} />
              {/* Equipped item emoji overlays */}
              {equippedItems.length > 0 && (
                <Box sx={{ position: 'absolute', top: -8, right: -8, display: 'flex', flexWrap: 'wrap', gap: 0.25, maxWidth: 48 }}>
                  {equippedItems.slice(0, 4).map(item => (
                    <Typography key={item.id} fontSize={18} title={item.name}>{item.emoji}</Typography>
                  ))}
                </Box>
              )}
            </Box>

            {/* Name */}
            <Box sx={{ textAlign: 'center' }}>
              <Typography fontWeight={900} fontSize={20} sx={{ color: '#7cc14a' }}>
                {pepeNameFor(wallet.address)}
              </Typography>
              <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>
                {wallet.address ? `${wallet.address.slice(0,6)}…${wallet.address.slice(-4)}` : ''}
              </Typography>
            </Box>

            {/* Stats */}
            <Box sx={{ width: '100%', bgcolor: '#161f2e', borderRadius: 2, p: 2 }}>
              <Stack direction="row" justifyContent="space-between" sx={{ mb: 1 }}>
                <Typography variant="caption" color="text.secondary">PEPE 餘額</Typography>
                <Typography variant="caption" fontWeight={700} sx={{ color: '#7cc14a' }}>
                  {pepeNum.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                </Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between" sx={{ mb: 1 }}>
                <Typography variant="caption" color="text.secondary">簽到連streak</Typography>
                <Typography variant="caption" fontWeight={700}>🔥 {streak} 天</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="caption" color="text.secondary">持倉數</Typography>
                <Typography variant="caption" fontWeight={700}>{positions}</Typography>
              </Stack>
            </Box>

            <Divider sx={{ width: '100%', borderColor: '#7cc14a22' }} />

            {/* Shop + Lootbox */}
            <Button variant="contained" fullWidth
              sx={{ bgcolor: '#7cc14a', color: '#0e1420', fontWeight: 900 }}
              onClick={() => setShopOpen(true)}>
              🛒 Pepe Shop
            </Button>

            <LootBoxButton pepeBalance={pepeBalance} onBurn={handleBurn} />
          </Card>
        </Grid>

        {/* ── Right: Daily Quests ── */}
        <Grid size={{ xs: 12, md: 4 }}>
          <Card sx={{ p: 2.5, bgcolor: '#0e1420', border: '1px solid #7cc14a22', borderRadius: 3, height: '100%' }}>
            <Typography fontWeight={900} fontSize={16} sx={{ mb: 2, color: '#7cc14a' }}>📋 每日任務</Typography>
            <Stack spacing={2}>
              {quests.map(q => (
                <Box key={q.id}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                    <Typography fontSize={13} fontWeight={700}>
                      {q.emoji} {q.title}
                    </Typography>
                    <Chip label={q.done ? '✓ 完成' : q.reward} size="small"
                      sx={{
                        bgcolor: q.done ? '#7cc14a' : 'transparent',
                        color:   q.done ? '#0e1420' : '#7cc14a',
                        border:  q.done ? 'none' : '1px solid #7cc14a55',
                        fontWeight: 700,
                        fontSize: 10,
                        height: 20,
                      }} />
                  </Box>
                  <LinearProgress
                    variant="determinate"
                    value={q.progress}
                    sx={{
                      height: 6, borderRadius: 3,
                      bgcolor: '#1e2a3a',
                      '& .MuiLinearProgress-bar': { bgcolor: q.done ? '#7cc14a' : '#2196f3' },
                    }}
                  />
                </Box>
              ))}
            </Stack>

            <Divider sx={{ my: 3, borderColor: '#7cc14a22' }} />

            {/* Equipped showcase */}
            <Typography fontWeight={900} fontSize={14} sx={{ mb: 1.5, color: '#7cc14a' }}>🎨 已裝備道具</Typography>
            {equippedItems.length === 0 ? (
              <Typography variant="caption" color="text.secondary">
                前往 Pepe Shop 購買並裝備道具吧！
              </Typography>
            ) : (
              <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
                {equippedItems.map(item => (
                  <Chip key={item.id} label={`${item.emoji} ${item.name}`} size="small"
                    sx={{ bgcolor: '#7cc14a18', color: '#7cc14a', border: '1px solid #7cc14a44', fontWeight: 700, fontSize: 11 }} />
                ))}
              </Box>
            )}
          </Card>
        </Grid>
      </Grid>

      {/* Pepe Shop Modal */}
      <PepeShopDialog
        open={shopOpen}
        onClose={() => { setShopOpen(false); setEquipped(getEquipped()) }}
        pepeBalance={pepeBalance}
        onBuy={handleBuy}
      />
    </Container>
  )
}
