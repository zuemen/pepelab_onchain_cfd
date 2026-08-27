import { MONO } from 'src/components/pepefi/brandKit'
import { useState, useEffect, useCallback } from 'react';
import { ethers } from 'ethers';

import Box from '@mui/material/Box';
import Card from '@mui/material/Card';
import Grid from '@mui/material/Grid';
import Chip from '@mui/material/Chip';
import Stack from '@mui/material/Stack';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';
import CircularProgress from '@mui/material/CircularProgress';

import { useContracts } from 'src/hooks/useContracts';
import { usePepefiWallet } from 'src/layouts/pepefi';
import PepeTokenCard from 'src/components/pepefi/PepeTokenCard';
import { useToast } from 'src/components/pepefi/ToastProvider';
import { t, interpolate } from 'src/locales';
import { prettyError } from 'src/lib/pepefi/errorMessages';
import { toStrictlyIncreasingIds } from 'src/lib/pepefi/positionIds';
import { dailyRewardFor, TODAY_INDEX } from 'src/lib/pepefi/achievements';

// ── Constants ──────────────────────────────────────────────────────────────────

const TIER_NAMES  = [t.rewards.tier.bronze, t.rewards.tier.silver, t.rewards.tier.gold, t.rewards.tier.diamond];
const TIER_THRESHOLD = [10_000, 50_000, 200_000, 1_000_000]; // in mUSDC (18-dec /1e18)
const TIER_REWARD    = [500,    2_000,  10_000,  50_000];    // PEPE

const fmt18 = (v: bigint) => Number(v) / 1e18;
const fmtPepe = (v: bigint) => (Number(v) / 1e18).toFixed(0) + ' PEPE';

// ── Types ──────────────────────────────────────────────────────────────────────

interface OpenPosition {
  id:      bigint;
  margin:  bigint;
  leverage: bigint;
  mined:   boolean;
  estReward: bigint;
}

interface CopyEntry {
  trader:  string;
  claimed: boolean;
}

// ── Section Card wrapper ───────────────────────────────────────────────────────

function SectionCard({ title, emoji, children }: {
  title: string; emoji: string; children: React.ReactNode;
}) {
  return (
    <Card sx={{ p: 3, bgcolor: 'background.paper', border: '1px solid', borderColor: 'divider' }}>
      <Typography variant="h6" sx={{ fontWeight: 900, mb: 2, fontSize: 20 }}>
        {emoji} {title}
      </Typography>
      {children}
    </Card>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function RewardsPage() {
  const wallet    = usePepefiWallet();
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId);

  // PEPE incentives are not deployed on every network (address(0) placeholder in
  // addresses.ts) — guard all reward actions so we never send a tx to 0x0.
  const incentivesLive = !!contracts
    && (contracts.pepeIncentives.target as string).toLowerCase()
       !== '0x0000000000000000000000000000000000000000';
  const INCENTIVES_OFFLINE_MSG = t.rewards.offline;

  const { notify } = useToast();

  // ── Trade Mining ────────────────────────────────────────────────────────────
  const [positions,   setPositions]   = useState<OpenPosition[]>([]);
  const [posLoading,  setPosLoading]  = useState(false);
  const [miningBusy,  setMiningBusy]  = useState<Record<string, boolean>>({});

  const fetchPositions = useCallback(async () => {
    if (!contracts || !wallet.address) return;
    setPosLoading(true);
    try {
      const ids = (await contracts.exchange.getUserPositions(wallet.address)) as bigint[];
      const rows: OpenPosition[] = [];
      for (const id of ids) {
        try {
          const pos = await contracts.exchange.getPosition(id) as {
            owner: string; margin: bigint; leverage: bigint; isOpen: boolean;
          };
          if (!pos.isOpen) continue;
          const mined = (await contracts.pepeIncentives.minedPosition(id)) as boolean;
          const notional = pos.margin * pos.leverage;
          const bps = (await contracts.pepeIncentives.tradeMiningBps()) as bigint;
          const cap = (await contracts.pepeIncentives.tradeMiningCap()) as bigint;
          let est = notional * bps / 10_000n;
          if (est > cap) est = cap;
          rows.push({ id, margin: pos.margin, leverage: pos.leverage, mined, estReward: est });
        } catch { /* skip */ }
      }
      setPositions(rows);
    } catch { /* not connected */ }
    finally { setPosLoading(false); }
  }, [contracts, wallet.address]);

  const claimMining = async (posId: bigint) => {
    if (!contracts) return;
    if (!incentivesLive) { notify(INCENTIVES_OFFLINE_MSG, false); return; }
    setMiningBusy(p => ({ ...p, [posId.toString()]: true }));
    try {
      const tx = (await contracts.pepeIncentives.claimTradeMining(posId)) as { wait(): Promise<unknown> };
      await tx.wait();
      notify(t.rewards.mining.done, true);
      await fetchPositions();
    } catch (e) { notify(prettyError(e, 'mining'), false); }
    finally { setMiningBusy(p => ({ ...p, [posId.toString()]: false })); }
  };

  // ── Tier Upgrade ────────────────────────────────────────────────────────────
  const [tierClaimed, setTierClaimed] = useState<number>(0);   // bitmask
  const [cumNotional, setCumNotional] = useState<bigint>(0n);
  const [tierBusy,    setTierBusy]    = useState<Record<number, boolean>>({});

  const fetchTier = useCallback(async () => {
    if (!contracts || !wallet.address) return;
    try {
      const bitmask = (await contracts.pepeIncentives.tierClaimed(wallet.address)) as bigint;
      setTierClaimed(Number(bitmask));
      // Sum notional from all known positions
      const ids = (await contracts.exchange.getUserPositions(wallet.address)) as bigint[];
      let total = 0n;
      for (const id of ids) {
        try {
          const pos = await contracts.exchange.getPosition(id) as { owner: string; margin: bigint; leverage: bigint };
          total += pos.margin * pos.leverage;
        } catch { /* skip */ }
      }
      setCumNotional(total);
    } catch { /* not deployed */ }
  }, [contracts, wallet.address]);

  const claimTier = async (tier: number) => {
    if (!contracts || !wallet.address) return;
    if (!incentivesLive) { notify(INCENTIVES_OFFLINE_MSG, false); return; }
    setTierBusy(p => ({ ...p, [tier]: true }));
    try {
      // PepeIncentives.claimTierReward 現在要求 positionIds **嚴格遞增**
      // （防止同一個倉位重複計入 notional 來灌等級），不符合就 revert
      // PositionIdsNotSorted。getUserPositions 沒有承諾任何順序，所以排序 +
      // 去重是前端的責任——舊版直接原樣送出，等於把成敗押在 storage 的巧合上。
      const rawIds = (await contracts.exchange.getUserPositions(wallet.address)) as bigint[];
      const ids = toStrictlyIncreasingIds(rawIds).map(id => id.toString());
      const tx = (await contracts.pepeIncentives.claimTierReward(tier, ids)) as { wait(): Promise<unknown> };
      await tx.wait();
      notify(interpolate(t.rewards.tierSection.done, { tier: TIER_NAMES[tier] }), true);
      await fetchTier();
    } catch (e) { notify(prettyError(e, 'tier'), false); }
    finally { setTierBusy(p => ({ ...p, [tier]: false })); }
  };

  // ── Copy Reward ─────────────────────────────────────────────────────────────
  const [copyEntries, setCopyEntries] = useState<CopyEntry[]>([]);
  const [copyBusy,    setCopyBusy]    = useState<Record<string, boolean>>({});

  const fetchCopy = useCallback(async () => {
    if (!contracts || !wallet.address) return;
    try {
      const records = await contracts.copyTracker.getCopyRecords(wallet.address) as Array<{
        trader: string; active: boolean;
      }>;
      const entries: CopyEntry[] = [];
      for (const r of records) {
        if (!r.active) continue;
        const key = ethers.keccak256(
          ethers.solidityPacked(['address', 'address'], [wallet.address, r.trader]),
        );
        const claimed = (await contracts.pepeIncentives.copyClaimed(key)) as boolean;
        entries.push({ trader: r.trader, claimed });
      }
      setCopyEntries(entries);
    } catch { /* not deployed */ }
  }, [contracts, wallet.address]);

  const claimCopy = async (trader: string) => {
    if (!contracts) return;
    if (!incentivesLive) { notify(INCENTIVES_OFFLINE_MSG, false); return; }
    setCopyBusy(p => ({ ...p, [trader]: true }));
    try {
      const tx = (await contracts.pepeIncentives.claimCopyReward(trader)) as { wait(): Promise<unknown> };
      await tx.wait();
      notify(t.rewards.copy.done, true);
      await fetchCopy();
    } catch (e) { notify(prettyError(e, 'copy'), false); }
    finally {setCopyBusy(p => ({ ...p, [trader]: false })); }
  };

  // ── Daily Check-in ──────────────────────────────────────────────────────────
  const [myStreak,      setMyStreak]      = useState(0);
  const [lastDay,       setLastDay]       = useState(0);
  const [checkInBusy,   setCheckInBusy]   = useState(false);

  const fetchCheckin = useCallback(async () => {
    if (!contracts || !wallet.address) return;
    try {
      const last   = (await contracts.pepeIncentives.lastCheckIn(wallet.address)) as bigint;
      const s      = (await contracts.pepeIncentives.streak(wallet.address)) as bigint;
      setLastDay(Number(last));
      setMyStreak(Number(s));
    } catch { /* not deployed */ }
  }, [contracts, wallet.address]);

  // The only place in the app that sends dailyCheckIn(). /dashboard and /pepe
  // both show the streak and both link here rather than transacting, which is
  // what keeps a double check-in from being possible. Keep it that way.
  const doCheckIn = async () => {
    if (!contracts) return;
    if (!incentivesLive) { notify(INCENTIVES_OFFLINE_MSG, false); return; }
    setCheckInBusy(true);
    try {
      const tx = (await contracts.pepeIncentives.dailyCheckIn()) as { wait(): Promise<unknown> };
      await tx.wait();
      notify(t.rewards.checkIn.done, true);
      await fetchCheckin();
    } catch (e) { notify(prettyError(e, 'checkin'), false); }
    finally { setCheckInBusy(false); }
  };

  // ── Load all ────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!wallet.isConnected) return;
    void fetchPositions();
    void fetchTier();
    void fetchCopy();
    void fetchCheckin();
  }, [fetchPositions, fetchTier, fetchCopy, fetchCheckin, wallet.isConnected]);

  // ── Daily state ─────────────────────────────────────────────────────────────
  const checkedInToday = lastDay === TODAY_INDEX();
  const dailyReward = dailyRewardFor(myStreak);

  if (!wallet.isConnected) {
    return (
      <Container maxWidth="md" sx={{ py: 6, textAlign: 'center' }}>
        <Typography variant="h4" sx={{ fontWeight: 900 }}>{t.rewards.connectTitle}</Typography>
        <Typography color="text.secondary" sx={{ mt: 2 }}>{t.rewards.connectWallet}</Typography>
      </Container>
    );
  }

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Typography variant="h4" sx={{ fontWeight: 900, mb: 1 }}>{t.rewards.title}</Typography>
      <Typography color="text.secondary" sx={{ mb: 4 }}>
        {t.rewards.subtitle}
      </Typography>

      {/* PEPE balance + airdrop. Moved off the Dashboard: claiming belongs on
          the page that already owns every other claim (trade mining, tiers,
          copy rewards, daily check-in). Self-contained — it reads its own
          contracts and owns its own state. */}
      <Box sx={{ mb: 3 }}>
        <PepeTokenCard />
      </Box>

      <Grid container spacing={3}>
        {/* A — Trade Mining */}
        <Grid size={{ xs: 12 }}>
          <SectionCard title={t.rewards.mining.title} emoji="⛏️">
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t.rewards.mining.description}
            </Typography>
            {posLoading ? (
              <CircularProgress size={24} />
            ) : positions.length === 0 ? (
              <Typography color="text.secondary" variant="body2">{t.rewards.mining.empty}</Typography>
            ) : (
              <Stack spacing={1}>
                {positions.map(p => (
                  <Box key={p.id.toString()} sx={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    p: 1.5, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.04)',
                  }}>
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>
                        {interpolate(t.rewards.mining.position, { id: p.id.toString() })}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        {interpolate(t.rewards.mining.detail, {
                          notional: (fmt18(p.margin) * Number(p.leverage)).toFixed(0),
                        })}
                        {' · '}
                        {interpolate(t.rewards.mining.estReward, { reward: fmtPepe(p.estReward) })}
                      </Typography>
                    </Box>
                    <Button
                      variant="contained"
                      size="small"
                      disabled={p.mined || !!miningBusy[p.id.toString()]}
                      onClick={() => void claimMining(p.id)}
                    >
                      {p.mined
                        ? t.rewards.mining.claimed
                        : miningBusy[p.id.toString()]
                          ? t.rewards.working
                          : t.rewards.mining.claim}
                    </Button>
                  </Box>
                ))}
              </Stack>
            )}
          </SectionCard>
        </Grid>

        {/* B — Tier Upgrade */}
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard title={t.rewards.tierSection.title} emoji="🏆">
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t.rewards.tierSection.description}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              {interpolate(t.rewards.tierSection.cumulative, {
                amount: fmt18(cumNotional).toLocaleString(undefined, { maximumFractionDigits: 0 }),
              })}
            </Typography>
            <Stack spacing={1.5}>
              {TIER_NAMES.map((name, i) => {
                const claimed  = (tierClaimed & (1 << i)) !== 0;
                const eligible = fmt18(cumNotional) >= TIER_THRESHOLD[i];
                const progress = Math.min(100, (fmt18(cumNotional) / TIER_THRESHOLD[i]) * 100);
                return (
                  <Box key={i}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>{name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {interpolate(t.rewards.tierSection.reward, {
                          amount: TIER_REWARD[i].toLocaleString(),
                        })}
                      </Typography>
                    </Box>
                    <LinearProgress
                      variant="determinate"
                      value={progress}
                      sx={{ height: 6, borderRadius: 3, mb: 0.5 }}
                    />
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Typography variant="caption" color="text.secondary">
                        {interpolate(t.rewards.tierSection.required, {
                          amount: TIER_THRESHOLD[i].toLocaleString(),
                        })}
                      </Typography>
                      <Button
                        size="small"
                        variant={claimed ? 'outlined' : 'contained'}
                        disabled={claimed || !eligible || !!tierBusy[i]}
                        onClick={() => void claimTier(i)}
                      >
                        {claimed
                          ? t.rewards.tierSection.claimed
                          : tierBusy[i]
                            ? t.rewards.working
                            : eligible
                              ? t.rewards.tierSection.claim
                              : t.rewards.tierSection.locked}
                      </Button>
                    </Box>
                  </Box>
                );
              })}
            </Stack>
          </SectionCard>
        </Grid>

        {/* C — Copy Reward */}
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard title={t.rewards.copy.title} emoji="🤝">
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              {t.rewards.copy.description}
            </Typography>
            {copyEntries.length === 0 ? (
              <Typography color="text.secondary" variant="body2">{t.rewards.copy.empty}</Typography>
            ) : (
              <Stack spacing={1}>
                {copyEntries.map(e => (
                  <Box key={e.trader} sx={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    p: 1.5, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.04)',
                  }}>
                    <Typography variant="body2" sx={{ fontFamily: MONO, fontSize: 12 }}>
                      {e.trader.slice(0, 8)}…{e.trader.slice(-6)}
                    </Typography>
                    <Button
                      size="small"
                      variant={e.claimed ? 'outlined' : 'contained'}
                      disabled={e.claimed || !!copyBusy[e.trader]}
                      onClick={() => void claimCopy(e.trader)}
                    >
                      {e.claimed
                        ? t.rewards.copy.claimed
                        : copyBusy[e.trader]
                          ? t.rewards.working
                          : t.rewards.copy.claim}
                    </Button>
                  </Box>
                ))}
              </Stack>
            )}
          </SectionCard>
        </Grid>

        {/* D — Daily Check-in */}
        <Grid size={{ xs: 12 }}>
          <SectionCard title={t.rewards.checkIn.title} emoji="📅">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
              <Box sx={{ flex: 1, minWidth: 200 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  {t.rewards.checkIn.description}
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip
                    label={interpolate(t.rewards.checkIn.streak, { days: myStreak })}
                    color={myStreak >= 7 ? 'warning' : 'default'}
                    size="small"
                  />
                  <Chip
                    label={interpolate(t.rewards.checkIn.todayReward, { reward: dailyReward })}
                    color="success"
                    size="small"
                  />
                </Stack>
              </Box>
              <Button
                variant="contained"
                size="large"
                disabled={checkedInToday || checkInBusy || !incentivesLive}
                onClick={() => void doCheckIn()}
                sx={{ minWidth: 160, fontWeight: 900 }}
              >
                {checkInBusy ? (
                  <CircularProgress size={20} color="inherit" />
                ) : checkedInToday ? (
                  t.rewards.checkIn.alreadyCheckedIn
                ) : (
                  interpolate(t.rewards.checkIn.checkIn, { reward: dailyReward })
                )}
              </Button>
            </Box>
            {checkedInToday && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {interpolate(t.rewards.checkIn.comeBack, { reward: dailyRewardFor(myStreak) })}
              </Typography>
            )}
          </SectionCard>
        </Grid>
      </Grid>
    </Container>
  );
}
