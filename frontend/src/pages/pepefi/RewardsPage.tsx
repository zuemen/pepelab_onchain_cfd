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
import { prettyError } from 'src/lib/pepefi/errorMessages';

// ── Constants ──────────────────────────────────────────────────────────────────

const TIER_NAMES  = ['Bronze 🥉', 'Silver 🥈', 'Gold 🥇', 'Diamond 💎'];
const TIER_THRESHOLD = [10_000, 50_000, 200_000, 1_000_000]; // in USDC (18-dec /1e18)
const TIER_REWARD    = [500,    2_000,  10_000,  50_000];    // PEPE

const fmt18 = (v: bigint) => Number(v) / 1e18;
const fmtPepe = (v: bigint) => (Number(v) / 1e18).toFixed(0) + ' PEPE';

const TODAY_INDEX = () => Math.floor(Date.now() / 1000 / 86400);

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

  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const notify = (msg: string, ok: boolean) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 5000);
  };

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
    setMiningBusy(p => ({ ...p, [posId.toString()]: true }));
    try {
      const tx = (await contracts.pepeIncentives.claimTradeMining(posId)) as { wait(): Promise<unknown> };
      await tx.wait();
      notify('Trade mining claimed! 🎉', true);
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
    setTierBusy(p => ({ ...p, [tier]: true }));
    try {
      const rawIds = (await contracts.exchange.getUserPositions(wallet.address)) as bigint[];
      const ids = Array.from(rawIds).map(id => id.toString());
      const tx = (await contracts.pepeIncentives.claimTierReward(tier, ids)) as { wait(): Promise<unknown> };
      await tx.wait();
      notify(`${TIER_NAMES[tier]} reward claimed! 🏆`, true);
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
    setCopyBusy(p => ({ ...p, [trader]: true }));
    try {
      const tx = (await contracts.pepeIncentives.claimCopyReward(trader)) as { wait(): Promise<unknown> };
      await tx.wait();
      notify('Copy reward claimed! 200 PEPE each 🐸', true);
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

  const doCheckIn = async () => {
    if (!contracts) return;
    setCheckInBusy(true);
    try {
      const tx = (await contracts.pepeIncentives.dailyCheckIn()) as { wait(): Promise<unknown> };
      await tx.wait();
      notify('Checked in! 🐸', true);
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
  const dailyReward = 50 + 10 * Math.min(myStreak, 6);

  if (!wallet.isConnected) {
    return (
      <Container maxWidth="md" sx={{ py: 6, textAlign: 'center' }}>
        <Typography variant="h4" sx={{ fontWeight: 900 }}>🎁 Rewards</Typography>
        <Typography color="text.secondary" sx={{ mt: 2 }}>Connect wallet to view your rewards.</Typography>
      </Container>
    );
  }

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
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

      <Typography variant="h4" sx={{ fontWeight: 900, mb: 1 }}>🎁 PepeLab Rewards</Typography>
      <Typography color="text.secondary" sx={{ mb: 4 }}>
        Trade, follow, and check-in daily to earn PEPE.
      </Typography>

      <Grid container spacing={3}>
        {/* A — Trade Mining */}
        <Grid size={{ xs: 12 }}>
          <SectionCard title="Trade Mining" emoji="⛏️">
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              每筆開倉可領一次。獎勵 = 名義價值 × 0.5%，封頂 5,000 PEPE。
            </Typography>
            {posLoading ? (
              <CircularProgress size={24} />
            ) : positions.length === 0 ? (
              <Typography color="text.secondary" variant="body2">No open positions found.</Typography>
            ) : (
              <Stack spacing={1}>
                {positions.map(p => (
                  <Box key={p.id.toString()} sx={{
                    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                    p: 1.5, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.04)',
                  }}>
                    <Box>
                      <Typography variant="body2" sx={{ fontWeight: 700 }}>
                        Position #{p.id.toString()}
                      </Typography>
                      <Typography variant="caption" color="text.secondary">
                        Notional: ${(fmt18(p.margin) * Number(p.leverage)).toFixed(0)}
                        {' · '}Est reward: {fmtPepe(p.estReward)}
                      </Typography>
                    </Box>
                    <Button
                      variant="contained"
                      size="small"
                      disabled={p.mined || !!miningBusy[p.id.toString()]}
                      onClick={() => void claimMining(p.id)}
                    >
                      {p.mined ? 'Claimed' : miningBusy[p.id.toString()] ? '…' : 'Claim'}
                    </Button>
                  </Box>
                ))}
              </Stack>
            )}
          </SectionCard>
        </Grid>

        {/* B — Tier Upgrade */}
        <Grid size={{ xs: 12, md: 6 }}>
          <SectionCard title="Tier Upgrade" emoji="🏆">
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              累積交易量達標即可領取一次性 tier 獎勵。
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
              Cumulative notional: ${(fmt18(cumNotional)).toLocaleString(undefined, { maximumFractionDigits: 0 })}
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
                        {TIER_REWARD[i].toLocaleString()} PEPE
                      </Typography>
                    </Box>
                    <LinearProgress
                      variant="determinate"
                      value={progress}
                      sx={{ height: 6, borderRadius: 3, mb: 0.5 }}
                    />
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Typography variant="caption" color="text.secondary">
                        ${TIER_THRESHOLD[i].toLocaleString()} required
                      </Typography>
                      <Button
                        size="small"
                        variant={claimed ? 'outlined' : 'contained'}
                        disabled={claimed || !eligible || !!tierBusy[i]}
                        onClick={() => void claimTier(i)}
                      >
                        {claimed ? 'Claimed' : tierBusy[i] ? '…' : eligible ? 'Claim' : 'Locked'}
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
          <SectionCard title="Copy Reward" emoji="🤝">
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              跟單成功後，跟單者與被跟單者各領 200 PEPE（每對一次）。
            </Typography>
            {copyEntries.length === 0 ? (
              <Typography color="text.secondary" variant="body2">No active copy trades found.</Typography>
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
                      {e.claimed ? 'Claimed' : copyBusy[e.trader] ? '…' : '200 PEPE'}
                    </Button>
                  </Box>
                ))}
              </Stack>
            )}
          </SectionCard>
        </Grid>

        {/* D — Daily Check-in */}
        <Grid size={{ xs: 12 }}>
          <SectionCard title="Daily Check-in" emoji="📅">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
              <Box sx={{ flex: 1, minWidth: 200 }}>
                <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
                  每日簽到領 50 PEPE，連續簽到每天 +10 PEPE，7 天封頂 110 PEPE。
                </Typography>
                <Stack direction="row" spacing={1} alignItems="center">
                  <Chip label={`🔥 ${myStreak} day streak`} color={myStreak >= 7 ? 'warning' : 'default'} size="small" />
                  <Chip label={`今日獎勵: ${dailyReward} PEPE`} color="success" size="small" />
                </Stack>
              </Box>
              <Button
                variant="contained"
                size="large"
                disabled={checkedInToday || checkInBusy}
                onClick={() => void doCheckIn()}
                sx={{ minWidth: 160, fontWeight: 900 }}
              >
                {checkInBusy ? <CircularProgress size={20} color="inherit" /> :
                  checkedInToday ? '✓ 今天已簽到' : '🐸 簽到 +' + dailyReward + ' PEPE'}
              </Button>
            </Box>
            {checkedInToday && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                明天再來！明日獎勵: {Math.min(50 + 10 * myStreak, 110)} PEPE
              </Typography>
            )}
          </SectionCard>
        </Grid>
      </Grid>
    </Container>
  );
}
