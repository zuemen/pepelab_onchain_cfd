import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router';

import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Grid from '@mui/material/Grid';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Dialog from '@mui/material/Dialog';
import Button from '@mui/material/Button';
import Container from '@mui/material/Container';
import Typography from '@mui/material/Typography';
import LinearProgress from '@mui/material/LinearProgress';

import { useWalletContext } from 'src/contexts/wallet-context';
import { useContracts } from 'src/hooks/useContracts';
import { Iconify } from 'src/components/iconify';
import { useToast } from 'src/components/pepefi/ToastProvider';
import { StageSkin, getStageSkins, findStageSkin } from 'src/components/pepefi/pepeStageSkinsData';
import { PEPE_MOUNTS, getMount, getNextMount } from 'src/components/pepefi/pepeMountsData';
import PepeEvolution, {
  PEPE_EVOLUTION_STAGES,
  PepeEvolutionHero,
  PepeEvolutionStage,
  getEvolutionStage,
  getNextEvolutionStage,
} from 'src/components/pepefi/PepeEvolution';

// ── Types & Assets ─────────────────────────────────────────────────────────────

const POTIONS = [
  { id: 'green', name: 'Pepe Green Juice (綠色蛙汁)', desc: '讓你的 Pepe 眼睛發光，經驗值 +50 XP！', cost: 100, xp: 50, color: '#4caf50', emoji: '🧪' },
  { id: 'gold', name: 'Golden Elixir (黃金仙露)', desc: '解鎖奢華黃金配飾，經驗值 +150 XP！', cost: 300, xp: 150, color: '#ffd700', emoji: '🍶' },
  { id: 'moon', name: 'Moon Potion (登月藥水)', desc: '獲得登月火箭背包，直接獲得 +500 XP！', cost: 800, xp: 500, color: '#2196f3', emoji: '🚀' },
];

// ── Helper Title ──────────────────────────────────────────────────────────────

// Title now comes from the evolution stage so the text and the artwork can
// never drift apart.
const getTitleByLevel = (lvl: number) => getEvolutionStage(lvl).title;

type PepeLabTab = 'potions' | 'mounts' | 'skins';

const TABS: PepeLabTab[] = ['potions', 'mounts', 'skins'];

export default function PepeLabPage() {
  // The tab lives in the URL rather than in component state, so `/pepe?tab=mounts`
  // is a real link: shareable, bookmarkable, and the browser back button walks
  // back through the tabs the way a visitor expects it to.
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const tabValue: PepeLabTab = TABS.includes(rawTab as PepeLabTab) ? (rawTab as PepeLabTab) : 'potions';
  const setTabValue = (next: PepeLabTab) => setSearchParams({ tab: next });

  const { notify, confirm } = useToast();
  const wallet = useWalletContext();
  const userAddress = wallet.address || 'mock_user';
  const contracts = useContracts(wallet.provider, wallet.signer, wallet.chainId);

  const [onChainPepeBal, setOnChainPepeBal] = useState<bigint | null>(null);

  // Sync real-time on-chain PEPE balance
  useEffect(() => {
    if (!contracts || !wallet.address) return;
    const fetchOnChainBal = async () => {
      try {
        const bal = await contracts.pepeToken.balanceOf(wallet.address);
        setOnChainPepeBal(bal as bigint);
      } catch (e) {
        console.error('Failed to fetch on-chain PEPE balance in Modal:', e);
      }
    };
    void fetchOnChainBal();
  }, [contracts, wallet.address]);

  // ── Persistent state in localStorage ─────────────────────────────────────────
  const [pepeBal, setPepeBal] = useState<number>(5000);
  const [xp, setXp] = useState<number>(0);
  const [level, setLevel] = useState<number>(1);
  // The mount and the skin are independent slots: you ride something *and* wear
  // something. (The old wardrobe conflated the two behind one 'custom_skin'
  // sentinel.) Everyone starts on the lotus leaf.
  const [activeMount, setActiveMount] = useState<string>('leaf');

  // Skins are per-evolution-stage; an unlocked id stays owned across stages.
  const [unlockedSkins, setUnlockedSkins] = useState<string[]>([]);
  const [activeSkin, setActiveSkin] = useState<string>('');

  // Gachapon state
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [drawResult, setDrawResult] = useState<StageSkin | null>(null);

  // Evolution celebration. Driven from buyPotion rather than from a level
  // watcher: the page reloads its level from localStorage on every mount, so a
  // watcher would fire a bogus "evolved!" burst each time you navigate here.
  const [evolvedTo, setEvolvedTo] = useState<PepeEvolutionStage | null>(null);
  const [heroEvolving, setHeroEvolving] = useState<boolean>(false);

  const celebrateEvolution = (next: PepeEvolutionStage) => {
    setEvolvedTo(next);
    setHeroEvolving(true);
    window.setTimeout(() => setHeroEvolving(false), 1200);
  };

  // Load from storage
  useEffect(() => {
    try {
      const savedBal = localStorage.getItem('pepefi:gamefi:balance');
      const savedXp  = localStorage.getItem('pepefi:gamefi:xp');
      const savedLvl = localStorage.getItem('pepefi:gamefi:level');
      const savedMnt = localStorage.getItem('pepefi:gamefi:active_mount');

      const savedUnl = localStorage.getItem('pepefi:gamefi:unlocked_skins');
      const savedAsk = localStorage.getItem('pepefi:gamefi:active_skin');

      if (savedBal) setPepeBal(Number(savedBal));
      if (savedXp)  setXp(Number(savedXp));
      if (savedLvl) setLevel(Number(savedLvl));
      if (savedMnt) setActiveMount(savedMnt);

      setUnlockedSkins(savedUnl ? JSON.parse(savedUnl) : []);
      setActiveSkin(savedAsk || '');

      // Re-derive the shared avatar on mount rather than only on save. It is a
      // raw image path consumed by other components, so a value written by an
      // older build can point at a file this one no longer serves; recomputing
      // here heals it without waiting for the next purchase.
      const skin = savedAsk ? findStageSkin(savedAsk) : undefined;
      localStorage.setItem(
        `pepeAvatar_${userAddress.toLowerCase()}`,
        skin ? skin.image : getEvolutionStage(Number(savedLvl) || 1).image,
      );
    } catch (e) { /* fallback to defaults */ }
  }, [userAddress]);

  // Save to storage
  const saveState = (newBal: number, newXp: number, newLvl: number, newMnt: string, newUnl?: string[], newAsk?: string) => {
    localStorage.setItem('pepefi:gamefi:balance', newBal.toString());
    localStorage.setItem('pepefi:gamefi:xp', newXp.toString());
    localStorage.setItem('pepefi:gamefi:level', newLvl.toString());
    localStorage.setItem('pepefi:gamefi:active_mount', newMnt);

    const finalUnl = newUnl || unlockedSkins;
    const finalAsk = newAsk !== undefined ? newAsk : activeSkin;

    localStorage.setItem('pepefi:gamefi:unlocked_skins', JSON.stringify(finalUnl));
    localStorage.setItem('pepefi:gamefi:active_skin', finalAsk);

    setPepeBal(newBal);
    setXp(newXp);
    setLevel(newLvl);
    setActiveMount(newMnt);
    setUnlockedSkins(finalUnl);
    setActiveSkin(finalAsk);

    // Save to the standard user avatar store so all PepeAvatars sync instantly.
    // An equipped skin wins; otherwise the evolution artwork is the avatar.
    try {
      const skin = finalAsk ? findStageSkin(finalAsk) : undefined;
      localStorage.setItem(
        `pepeAvatar_${userAddress.toLowerCase()}`,
        skin ? skin.image : getEvolutionStage(newLvl).image,
      );
    } catch (e) { /* fallback */ }

    // Dispatch global event so header avatar or layouts can react to level-ups/skin-swaps
    window.dispatchEvent(new CustomEvent('pepefi:gamefi-updated'));
  };


  // ── Potion Shop Logic ────────────────────────────────────────────────────────

  // Calculate effective PEPE balance (on-chain if connected, otherwise local storage)
  const finalPepeBal = onChainPepeBal !== null ? Math.floor(Number(onChainPepeBal) / 1e18) : pepeBal;

  // ── Potion Shop Logic ────────────────────────────────────────────────────────

  const buyPotion = async (id: string, cost: number, xpBonus: number) => {
    if (finalPepeBal < cost) {
      notify('PEPE 餘額不足。可到 Rewards 頁面簽到或交易挖礦取得更多。', false);
      return;
    }

    if (contracts && wallet.address) {
      try {
        const amountBig = BigInt(cost) * 10n ** 18n;
        const tx = await contracts.pepeToken.transfer("0x000000000000000000000000000000000000dEaD", amountBig);
        await (tx as { wait(): Promise<unknown> }).wait();
        const nextBal = await contracts.pepeToken.balanceOf(wallet.address);
        setOnChainPepeBal(nextBal as bigint);
      } catch (e) {
        notify('鏈上交易已取消或扣款失敗，未扣除任何 PEPE。', false);
        return;
      }
    }

    const nextBal = finalPepeBal - cost;
    const nextXp  = xp + xpBonus;
    let nextLvl = level;
    let tempXp  = nextXp;
    while (tempXp >= nextLvl * 100) {
      tempXp -= nextLvl * 100;
      nextLvl += 1;
    }
    // Crossing a stage threshold is the only thing that changes the artwork,
    // so the burst fires on that, not on every level-up.
    const nextStage = getEvolutionStage(nextLvl);
    const evolved = nextStage.stage > getEvolutionStage(level).stage;

    // A skin belongs to the stage it was drawn from. Keeping an old one equipped
    // through an evolution would leave the hero showing the previous form and
    // hide the thing the player just earned, so it comes off — still owned, and
    // re-equippable if they ever want it back.
    const skinSurvives = !evolved || equippedSkin?.stage === nextStage.stage;
    const nextSkin = skinSurvives ? activeSkin : '';

    saveState(nextBal, tempXp, nextLvl, activeMount, undefined, nextSkin);
    if (evolved) celebrateEvolution(nextStage);
  };

  // ── Mount Logic ──────────────────────────────────────────────────────────────

  const equipMount = (mountId: string, levelReq: number) => {
    if (level < levelReq) {
      notify(`此坐騎需 Pepe 等級 Lv.${levelReq} 解鎖，目前 Lv.${level}。`, false);
      return;
    }
    saveState(finalPepeBal, xp, level, mountId);
  };

  const activeMountObj = getMount(activeMount) || PEPE_MOUNTS[0];

  // ── Evolution ────────────────────────────────────────────────────────────────
  // The frog artwork itself evolves with level (蛙蛋 → 蝌蚪 → … → 蛙神).
  const evoStage = getEvolutionStage(level);
  const nextEvo = getNextEvolutionStage(level);

  // Next mount to unlock
  const nextUnlock = getNextMount(level);
  const levelsToNext = nextUnlock ? nextUnlock.levelRequired - level : 0;

  // ── Skins: one pool per evolution stage ──────────────────────────────────────
  // A Lv.0 egg is only ever offered egg skins; evolving swaps the whole pool.
  // Stages whose artwork does not exist yet simply have an empty pool.
  const stagePool = getStageSkins(evoStage.stage);
  const equippedSkin = activeSkin ? findStageSkin(activeSkin) : undefined;

  // ── Gachapon & Skin Shop Logic ───────────────────────────────────────────────

  const drawGachapon = async () => {
    if (isDrawing) return;
    const COST = 500;
    if (finalPepeBal < COST) {
      notify(`PEPE 餘額不足，抽取一次需要 ${COST} PEPE。`, false);
      return;
    }

    // Only the current stage's pool is drawable.
    if (stagePool.length === 0) {
      notify(`${evoStage.label} 階段的造型還在製作中，敬請期待。`, false);
      return;
    }
    const lockedSkins = stagePool.filter(s => !unlockedSkins.includes(s.id));
    if (lockedSkins.length === 0) {
      notify(`已集齊 ${evoStage.label} 階段的所有造型，進化後會解鎖新的一批。`, true);
      return;
    }

    if (contracts && wallet.address) {
      try {
        const amountBig = BigInt(COST) * 10n ** 18n;
        const tx = await contracts.pepeToken.transfer("0x000000000000000000000000000000000000dEaD", amountBig);
        await (tx as { wait(): Promise<unknown> }).wait();
        const nextBal = await contracts.pepeToken.balanceOf(wallet.address);
        setOnChainPepeBal(nextBal as bigint);
      } catch (e) {
        notify('鏈上交易已取消或扣款失敗，未扣除任何 PEPE。', false);
        return;
      }
    }

    setIsDrawing(true);

    // Simulate 2.5 seconds egg-shaking animation
    setTimeout(() => {
      // Weighted Rarity selection (Legendary: 5%, Epic: 15%, Rare: 30%, Common: 50%)
      const rand = Math.floor(Math.random() * 100);
      let selectedRarity: 'Common' | 'Rare' | 'Epic' | 'Legendary' = 'Common';
      if (rand < 5) selectedRarity = 'Legendary';
      else if (rand < 20) selectedRarity = 'Epic';
      else if (rand < 50) selectedRarity = 'Rare';

      // Find locked skins of selected rarity
      let candidates = lockedSkins.filter(s => s.rarity === selectedRarity);
      if (candidates.length === 0) {
        candidates = lockedSkins;
      }

      // Draw a random skin from candidates
      const chosenSkin = candidates[Math.floor(Math.random() * candidates.length)];
      
      const newUnlocked = [...unlockedSkins, chosenSkin.id];
      saveState(finalPepeBal - COST, xp, level, activeMount, newUnlocked, activeSkin);

      setDrawResult(chosenSkin);
      setIsDrawing(false);
    }, 2500);
  };

  const buySkinDirect = async (skin: StageSkin) => {
    if (unlockedSkins.includes(skin.id)) return;
    if (finalPepeBal < skin.price) {
      notify(`PEPE 餘額不足，此造型需要 ${skin.price} PEPE。`, false);
      return;
    }

    // Spends a real (testnet) token balance, so it keeps a confirmation step —
    // now an in-app dialog rather than window.confirm. Early-return on cancel
    // instead of nesting the whole purchase inside the branch.
    const confirmed = await confirm({
      title: '購買造型',
      message: `以 ${skin.price} PEPE 購買「${skin.name}」？PEPE 將轉入銷毀地址，無法復原。`,
      confirmLabel: `購買 · ${skin.price} PEPE`,
    });
    if (!confirmed) return;

    if (contracts && wallet.address) {
      try {
        const amountBig = BigInt(skin.price) * 10n ** 18n;
        const tx = await contracts.pepeToken.transfer("0x000000000000000000000000000000000000dEaD", amountBig);
        await (tx as { wait(): Promise<unknown> }).wait();
        const nextBal = await contracts.pepeToken.balanceOf(wallet.address);
        setOnChainPepeBal(nextBal as bigint);
      } catch (e) {
        notify('鏈上交易已取消或扣款失敗，未扣除任何 PEPE。', false);
        return;
      }
    }

    const newUnlocked = [...unlockedSkins, skin.id];
    saveState(finalPepeBal - skin.price, xp, level, activeMount, newUnlocked, activeSkin);
    notify(`已購買並解鎖「${skin.name}」`, true);
  };

  // Equipping a skin swaps the artwork the hero panel renders — the frog on the
  // golden stage becomes the chosen skin, still riding the equipped mount.
  // Passing '' clears it and returns to the plain evolution artwork.
  const equipSkin = (skinId: string) => {
    saveState(finalPepeBal, xp, level, activeMount, unlockedSkins, skinId);
  };

  const getRarityColor = (rarity: string) => {
    switch (rarity) {
      case 'Legendary': return '#ff3d00';
      case 'Epic': return '#b200ff';
      case 'Rare': return '#00b0ff';
      default: return 'var(--palette-primary-main)';
    }
  };

  const displayAvatar = equippedSkin ? equippedSkin.image : evoStage.image;

  return (
    <Container maxWidth="lg" sx={{ py: 3 }}>
     <Box sx={{ bgcolor: '#0b1625', border: '1px solid rgba(124,193,74,0.3)', borderRadius: 3, overflow: 'hidden' }}>

      {/* Dynamic Keyframes Animation Injection */}
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes shakeEgg {
          0% { transform: translate(0, 0) rotate(0deg) scale(1); }
          10% { transform: translate(-3px, 3px) rotate(-4deg) scale(1.02); }
          20% { transform: translate(3px, -2px) rotate(4deg) scale(1.02); }
          30% { transform: translate(-5px, -3px) rotate(-6deg) scale(1.06); }
          40% { transform: translate(5px, 2px) rotate(6deg) scale(1.06); }
          50% { transform: translate(-7px, 5px) rotate(-9deg) scale(1.1); }
          60% { transform: translate(7px, -3px) rotate(9deg) scale(1.1); }
          70% { transform: translate(-8px, -5px) rotate(-10deg) scale(1.15); }
          80% { transform: translate(8px, 3px) rotate(10deg) scale(1.15); }
          90% { transform: translate(-3px, -2px) rotate(-2deg) scale(1.06); }
          100% { transform: translate(0, 0) rotate(0deg) scale(1); }
        }
        @keyframes pulseGlow {
          0% { box-shadow: 0 0 15px rgba(124,193,74,0.4); }
          100% { box-shadow: 0 0 45px rgba(124,193,74,0.9); }
        }
        @keyframes rotateBurst {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
      `}} />

      {/* ── Header: who you are, and what you can spend ───────────────────── */}
      <Box sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Box sx={{ width: 48, height: 48, borderRadius: '50%', border: `2px solid ${evoStage.color}`, boxShadow: `0 0 10px ${evoStage.color}80`, overflow: 'hidden', flexShrink: 0 }}>
            <PepeEvolution level={level} size={44} radius="50%" animated={false} />
          </Box>
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 900, color: 'var(--palette-primary-main)' }}>
              Pepe GameFi & MemeFi Lab 🧪
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              DeFi · SocialFi · GameFi · MemeFi 一體化升級中心
            </Typography>
          </Box>
        </Stack>

        {/* The balance belongs next to the identity, not stranded above the
            tabs — every tab spends it, so it reads as a page-level fact. */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'rgba(124,193,74,0.12)', border: '1px solid rgba(124,193,74,0.3)', px: 2, py: 0.75, borderRadius: 2 }}>
          <Typography variant="subtitle2" sx={{ color: 'var(--palette-primary-main)', fontWeight: 'bold' }}>
            💰 餘額: {finalPepeBal.toLocaleString()} PEPE
          </Typography>
        </Box>
      </Box>

      {/* ── HERO: the character, across the full width of the page ─────────── */}
      {/* As a modal this was a 330px column pinned beside the tabs. A page has
          room to lay the frog and its vitals out side by side instead, and to
          give the tabs below the entire width they were previously denied. */}
      <Box
        sx={{
          px: 3, pt: 3, pb: 2.5,
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          background: `radial-gradient(circle at 50% 30%, ${evoStage.color}16 0%, transparent 62%)`,
          display: 'flex',
          flexDirection: { xs: 'column', md: 'row' },
          alignItems: 'center',
          gap: { xs: 1, md: 5 },
        }}
      >
        {/* PepeEvolutionHero is fluid by design (width:100%, maxWidth:size), so
            the wrapper has to carry the width — as a row flex item with no
            basis it would otherwise collapse the hero to nothing. */}
        <Box sx={{ flexShrink: 0, width: '100%', maxWidth: 288 }}>
          <PepeEvolutionHero
            level={level}
            size={288}
            evolving={heroEvolving}
            mount={activeMountObj}
            skinImage={equippedSkin?.image}
            skinGroundY={equippedSkin?.groundY}
          />
        </Box>

        {/* Capped rather than flex:1 — an XP bar stretched across 1100px reads
            as a loading screen, not as progress. */}
        <Box sx={{ width: '100%', maxWidth: 420, textAlign: { xs: 'center', md: 'left' } }}>
          <Typography variant="h5" sx={{ fontWeight: 900, color: evoStage.color }}>
            {equippedSkin ? `${equippedSkin.emoji} ${equippedSkin.name}` : `${evoStage.emoji} ${evoStage.label}`}
          </Typography>
          <Typography variant="subtitle2" sx={{ color: '#ffb300', fontWeight: 'bold', display: 'block' }}>
            {getTitleByLevel(level)}
          </Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mb: 2.5 }}>
            {activeMountObj.emoji} {activeMountObj.name.split(' (')[0]}
          </Typography>

          <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', justifyContent: 'space-between', fontWeight: 'bold' }}>
            <span>Lv. {level}</span>
            <span>{xp}/{level * 100} XP</span>
          </Typography>
          <LinearProgress variant="determinate" value={Math.min(100, (xp / (level * 100)) * 100)} sx={{ height: 8, borderRadius: 4, mt: 0.75, bgcolor: 'rgba(255,255,255,0.08)', '& .MuiLinearProgress-bar': { bgcolor: evoStage.color } }} />
        </Box>
      </Box>

      {/* 🐸 Evolution roadmap — Lv.0 蛙蛋 → Lv.6 蛙神 */}
      {/* No borderTop: the hero above already draws the dividing line. */}
      <Box sx={{ px: 3, py: 2, background: `linear-gradient(180deg, ${evoStage.color}0f 0%, transparent 100%)` }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 1.5 }}>
          <Typography variant="caption" sx={{ fontWeight: 'bold', color: 'text.secondary' }}>
            🐸 佩佩蛙進化樹 (Evolution) · 目前{' '}
            <Box component="span" sx={{ color: evoStage.color, fontWeight: 900 }}>
              Lv.{evoStage.stage} {evoStage.label} {evoStage.emoji}
            </Box>
          </Typography>
          <Typography variant="caption" sx={{ color: nextEvo ? '#ffb300' : 'var(--palette-primary-main)', fontWeight: 'bold' }}>
            {nextEvo
              ? `⚡ 再升 ${nextEvo.minLevel - level} 級 (Lv.${nextEvo.minLevel}) 即可進化為 ${nextEvo.label} ${nextEvo.emoji}`
              : '🏆 已進化至最終形態 蛙神 🌌'}
          </Typography>
        </Stack>

        <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 0.5, overflowX: 'auto', pb: 0.5 }}>
          {PEPE_EVOLUTION_STAGES.map((s, i) => {
            const reached = level >= s.minLevel;
            const isCurrent = s.stage === evoStage.stage;
            return (
              <React.Fragment key={s.stage}>
                {i > 0 && (
                  <Box sx={{ flex: '0 0 auto', width: 14, height: 2, mb: 4, borderRadius: 1, bgcolor: reached ? evoStage.color : 'rgba(255,255,255,0.12)' }} />
                )}
                <Box
                  title={`Lv.${s.stage} ${s.label} — ${s.desc}`}
                  sx={{
                    flex: '1 1 0', minWidth: 74, textAlign: 'center',
                    p: 0.75, borderRadius: 2,
                    border: '1px solid',
                    borderColor: isCurrent ? s.color : 'rgba(255,255,255,0.06)',
                    bgcolor: isCurrent ? `${s.color}14` : 'rgba(255,255,255,0.02)',
                    boxShadow: isCurrent ? `0 0 18px ${s.color}40` : 'none',
                    transition: 'all 0.3s',
                  }}
                >
                  <PepeEvolution stage={s.stage} size={52} locked={!reached} animated={false} />
                  <Typography variant="caption" sx={{ display: 'block', fontWeight: 900, fontSize: '0.68rem', color: reached ? 'text.primary' : 'text.disabled' }}>
                    {s.label}
                  </Typography>
                  <Typography variant="caption" sx={{ display: 'block', fontSize: '0.6rem', color: isCurrent ? s.color : 'text.secondary' }}>
                    {reached ? `Lv.${s.stage}` : `需 Lv.${s.minLevel}`}
                  </Typography>
                </Box>
              </React.Fragment>
            );
          })}
        </Box>
      </Box>

      {/* `centered` would clip these labels on a phone — they are long in two
          languages. Scrollable instead, then centred by the flex container
          once the viewport is wide enough to hold them all. */}
      <Tabs
        value={tabValue}
        onChange={(_, nv) => setTabValue(nv)}
        variant="scrollable"
        scrollButtons="auto"
        allowScrollButtonsMobile
        indicatorColor="custom"
        sx={{
          borderBottom: '1px solid rgba(255,255,255,0.06)',
          '& .MuiTabs-flexContainer': { justifyContent: { md: 'center' } },
          '& .MuiTab-root': {
            color: 'text.secondary',
            fontWeight: 'bold',
            fontSize: { xs: '0.9rem', md: '1.05rem' },
            '&.Mui-selected': { color: 'var(--palette-primary-main)' },
          },
        }}
      >
        <Tab value="potions" label="🧪 魔法藥水 (Potions)" />
        <Tab value="mounts" label="🐋 尊貴坐騎 (Mounts)" />
        <Tab value="skins" label="🎰 造型盲盒與商城 (Skins & Gacha)" />
      </Tabs>

      {/* px:3 matches the 24px DialogContent used to add for us */}
      <Box sx={{ minHeight: 450, py: 3, px: 3 }}>

        {/* A. POTION SHOP TAB */}
        {tabValue === 'potions' && (
          <Grid container spacing={3}>
            {POTIONS.map(potion => (
              <Grid size={{ xs: 12, sm: 6, md: 4 }} key={potion.id}>
                <Card sx={{ p: 3, border: '1px solid rgba(255,255,255,0.08)', bgcolor: 'rgba(255,255,255,0.02)', display: 'flex', flexDirection: 'column', height: '100%', justifyContent: 'space-between', gap: 2 }}>
                  <Box>
                    <Box sx={{ fontSize: 40, mb: 1 }}>{potion.emoji}</Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 'bold', color: potion.color }}>
                      {potion.name}
                    </Typography>
                    <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                      {potion.desc}
                    </Typography>
                  </Box>
                  <Box>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 2 }}>
                      +{potion.xp} XP 經驗值
                    </Typography>
                    <Button variant="contained" fullWidth onClick={() => buyPotion(potion.id, potion.cost, potion.xp)} sx={{ bgcolor: 'rgba(124,193,74,0.15)', border: '1px solid', borderColor: 'var(--palette-primary-main)', color: 'var(--palette-primary-main)', fontWeight: 'bold', '&:hover': { bgcolor: 'var(--palette-primary-main)', color: 'primary.contrastText' } }}>
                      🛒 購買並使用 ({potion.cost} PEPE)
                    </Button>
                  </Box>
                </Card>
              </Grid>
            ))}
          </Grid>
        )}

        {/* B. MOUNTS TAB */}
        {tabValue === 'mounts' && (
          <Box>
            {/* Current mount summary — the frog riding it is on the left panel */}
            <Card sx={{
              p: 3, mb: 4, position: 'relative', overflow: 'hidden',
              background: 'linear-gradient(135deg, rgba(124,193,74,0.12) 0%, rgba(255,210,61,0.06) 100%)',
              border: '1px solid rgba(124,193,74,0.3)', borderRadius: 2.5,
              boxShadow: '0 8px 32px rgba(124,193,74,0.1)',
            }}>
              <Typography variant="h5" sx={{ fontWeight: 900, color: 'var(--palette-primary-main)', mb: 1 }}>
                {activeMountObj.emoji} {activeMountObj.name}
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5, lineHeight: 1.6 }}>
                {activeMountObj.desc} 目前您已達到了 <strong>Lv. {level} · 進化型態 Lv.{evoStage.stage} {evoStage.label} {evoStage.emoji}</strong> 的尊貴段位。
              </Typography>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                <Box sx={{ bgcolor: 'rgba(255,255,255,0.04)', px: 2.5, py: 1, borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.06)', minWidth: 120 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>目前坐騎</Typography>
                  <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                    {activeMountObj.emoji} {activeMountObj.name.split(' (')[0]}
                  </Typography>
                </Box>
                <Box sx={{ bgcolor: 'rgba(255,255,255,0.04)', px: 2.5, py: 1, borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.06)', minWidth: 120 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>進化型態</Typography>
                  <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: '#ffb300' }}>
                    {evoStage.emoji} {evoStage.label}
                  </Typography>
                </Box>
                <Box sx={{ bgcolor: 'rgba(255,255,255,0.04)', px: 2.5, py: 1, borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.06)', minWidth: 120 }}>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>已解鎖坐騎</Typography>
                  <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: 'var(--palette-primary-main)' }}>
                    {PEPE_MOUNTS.filter(m => level >= m.levelRequired).length} / {PEPE_MOUNTS.length}
                  </Typography>
                </Box>
              </Stack>

              <Box sx={{ mt: 2, p: 1.5, bgcolor: 'rgba(0,0,0,0.2)', borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 1.5 }}>
                <Box sx={{ bgcolor: nextUnlock ? 'rgba(255,179,0,0.1)' : 'rgba(124,193,74,0.1)', color: nextUnlock ? '#ffb300' : 'var(--palette-primary-main)', width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', flexShrink: 0 }}>
                  {nextUnlock ? '⚡' : '🏆'}
                </Box>
                <Typography variant="caption" sx={{ color: nextUnlock ? 'text.secondary' : 'var(--palette-primary-main)', fontWeight: 'bold' }}>
                  {nextUnlock ? (
                    <>
                      距離解鎖下一隻坐騎 <strong>{nextUnlock.emoji} {nextUnlock.name.split(' (')[0]}</strong> 還差 <strong style={{ color: '#ffb300' }}>{levelsToNext}</strong> 級！(需要達 Lv.{nextUnlock.levelRequired})
                    </>
                  ) : (
                    '🎉 恭喜！四隻坐騎全數解鎖，黃金天鯨已在等你。'
                  )}
                </Typography>
              </Box>
            </Card>

            <Grid container spacing={3}>
              {PEPE_MOUNTS.map(m => {
                const isUnlocked = level >= m.levelRequired;
                const isEquipped = activeMount === m.id;
                // lg:3 puts all four mounts on one row now that the page is
                // full width — at sm:6 they stretched to ~540px each.
                return (
                  <Grid size={{ xs: 12, sm: 6, lg: 3 }} key={m.id}>
                    <Card sx={{
                      p: 2.5, position: 'relative', height: '100%',
                      border: '1px solid',
                      borderColor: isEquipped ? 'var(--palette-primary-main)' : 'rgba(255,255,255,0.08)',
                      bgcolor: isEquipped ? 'rgba(124,193,74,0.04)' : 'rgba(255,255,255,0.02)',
                      boxShadow: isEquipped ? '0 0 25px rgba(124,193,74,0.15)' : 'none',
                      display: 'flex', flexDirection: 'column', gap: 1.5,
                      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                      '&:hover': {
                        borderColor: isUnlocked ? 'var(--palette-primary-main)' : 'rgba(255,255,255,0.08)',
                        boxShadow: isUnlocked ? '0 8px 30px rgba(124,193,74,0.2)' : 'none',
                        transform: isUnlocked ? 'translateY(-4px)' : 'none',
                      },
                    }}>
                      {isEquipped && (
                        <Box sx={{ position: 'absolute', top: 0, right: 0, zIndex: 2, bgcolor: 'var(--palette-primary-main)', color: '#000', px: 1.5, py: 0.25, borderRadius: '0 0 0 8px', fontSize: '0.72rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Iconify icon="solar:check-circle-bold" sx={{ fontSize: 13 }} /> 騎乘中
                        </Box>
                      )}
                      {!isUnlocked && (
                        <Box sx={{ position: 'absolute', top: 0, right: 0, zIndex: 2, bgcolor: 'rgba(255,255,255,0.08)', color: 'text.secondary', px: 1.5, py: 0.25, borderRadius: '0 0 0 8px', fontSize: '0.72rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Iconify icon="solar:shield-keyhole-bold-duotone" sx={{ fontSize: 13 }} /> 未解鎖
                        </Box>
                      )}

                      {/* Locked mounts stay hidden, same rule as the evolution tree */}
                      <Box sx={{ width: '100%', aspectRatio: '16 / 9', borderRadius: 2, overflow: 'hidden', bgcolor: '#000', border: '1px solid', borderColor: isEquipped ? 'var(--palette-primary-main)' : 'rgba(255,255,255,0.06)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {isUnlocked ? (
                          <Box component="img" src={m.image} alt={m.name} sx={{ width: '100%', height: '170%', objectFit: 'cover', transform: 'translateY(-6%)' }} />
                        ) : (
                          <Typography sx={{ fontSize: 34, color: 'rgba(255,255,255,0.25)' }}>❔</Typography>
                        )}
                      </Box>

                      <Box>
                        <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: isUnlocked ? 'text.primary' : 'text.disabled' }}>
                          {isUnlocked ? `${m.emoji} ${m.name}` : `??? (需 Lv.${m.levelRequired} 解鎖)`}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, lineHeight: 1.5 }}>
                          {isUnlocked ? m.desc : '達到指定等級後才會揭曉這隻坐騎的真面目。'}
                        </Typography>
                      </Box>

                      <Box sx={{ mt: 'auto', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
                        <Typography variant="caption" sx={{ color: isUnlocked ? 'var(--palette-primary-main)' : '#ffb300', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          {isUnlocked ? (
                            <>
                              <Iconify icon="solar:verified-check-bold" sx={{ fontSize: 12 }} /> 已解鎖
                            </>
                          ) : (
                            <>
                              <Iconify icon="solar:clock-circle-bold" sx={{ fontSize: 12 }} /> 需要達 Lv.{m.levelRequired} 級
                            </>
                          )}
                        </Typography>
                        <Button
                          size="small"
                          variant={isEquipped ? 'contained' : 'outlined'}
                          disabled={!isUnlocked}
                          onClick={() => equipMount(m.id, m.levelRequired)}
                          sx={{
                            bgcolor: isEquipped ? 'var(--palette-primary-main)' : 'transparent',
                            color: isEquipped ? '#fff' : 'var(--palette-primary-main)',
                            borderColor: 'var(--palette-primary-main)',
                            fontWeight: 'bold', py: 0.5, px: 2, borderRadius: 1.5, textTransform: 'none',
                            '&:hover': { bgcolor: isEquipped ? '#5a9e2f' : 'rgba(124,193,74,0.08)', borderColor: 'var(--palette-primary-main)' },
                          }}
                        >
                          {isEquipped ? '騎乘中' : isUnlocked ? '騎上去' : `Lv.${m.levelRequired}`}
                        </Button>
                      </Box>
                    </Card>
                  </Grid>
                );
              })}
            </Grid>
          </Box>
        )}

        {/* C. SKINS & GACHA TAB */}
        {tabValue === 'skins' && (
          <Box>
            <Grid container spacing={4}>
              
              {/* 1. GACHA BLIND BOX WIDGET */}
              <Grid size={{ xs: 12, md: 5 }}>
                <Card sx={{
                  p: 4,
                  height: '100%',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  alignItems: 'center',
                  bgcolor: 'rgba(255,255,255,0.01)',
                  border: '1px solid rgba(124,193,74,0.2)',
                  background: 'radial-gradient(circle at center, rgba(124,193,74,0.06) 0%, rgba(11,22,37,0.4) 100%)',
                  borderRadius: 3,
                  position: 'relative',
                  overflow: 'hidden'
                }}>
                  {/* Rotating visual background lights */}
                  <Box sx={{
                    position: 'absolute',
                    width: 250, height: 250,
                    borderRadius: '50%',
                    background: 'radial-gradient(circle, rgba(124,193,74,0.2) 0%, transparent 60%)',
                    zIndex: 0,
                    pointerEvents: 'none'
                  }} />

                  {/* Egg Shell container with shaking class */}
                  <Box
                    className={isDrawing ? 'egg-shaking' : ''}
                    sx={{
                      width: 140,
                      height: 140,
                      borderRadius: '50%',
                      background: 'radial-gradient(circle, #ffe082 10%, var(--palette-primary-main) 70%)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: '4.5rem',
                      zIndex: 1,
                      position: 'relative',
                      border: '4px solid rgba(255,255,255,0.1)',
                      boxShadow: '0 0 25px rgba(124,193,74,0.5)',
                      animation: isDrawing ? 'shakeEgg 0.4s infinite' : 'pulseGlow 2s infinite alternate',
                    }}
                  >
                    🥚
                    {/* Floating magic items */}
                    <Box sx={{ position: 'absolute', top: 5, right: 10, fontSize: '1.2rem', animation: 'spin 10s linear infinite' }}>✨</Box>
                    <Box sx={{ position: 'absolute', bottom: 10, left: 10, fontSize: '1.2rem', animation: 'spin 8s linear infinite' }}>⭐</Box>
                  </Box>

                  <Typography variant="h6" sx={{ fontWeight: '900', color: '#ffb300', mt: 3, zIndex: 1 }}>
                    {evoStage.emoji} {evoStage.label}造型盲盒
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, mb: 3, textAlign: 'center', maxWidth: 280, zIndex: 1 }}>
                    {stagePool.length > 0 ? (
                      <>
                        花費 <strong>500 PEPE</strong> 從 <strong>{evoStage.label}</strong> 專屬的 {stagePool.length} 款造型中隨機抽取。
                        進化到下一階段後，會換上一整批全新造型。
                      </>
                    ) : (
                      <>{evoStage.label} 階段的造型還在製作中，敬請期待 🚧</>
                    )}
                  </Typography>

                  <Button
                    variant="contained"
                    size="large"
                    disabled={isDrawing || stagePool.length === 0}
                    onClick={drawGachapon}
                    sx={{
                      bgcolor: 'var(--palette-primary-main)',
                      color: '#000',
                      fontWeight: 'bold',
                      fontSize: '1.05rem',
                      px: 5,
                      py: 1.5,
                      borderRadius: 2,
                      zIndex: 1,
                      boxShadow: '0 0 20px rgba(124,193,74,0.4)',
                      '&:hover': { bgcolor: '#94d862', boxShadow: '0 0 30px rgba(124,193,74,0.7)' },
                      '&:disabled': { bgcolor: 'rgba(255,255,255,0.1)', color: 'text.secondary' }
                    }}
                  >
                    {isDrawing ? '正在破殼孵化中...' : stagePool.length === 0 ? '🚧 造型製作中' : '🎰 幸運抽造型 (500 PEPE)'}
                  </Button>

                  <Stack direction="row" spacing={2} sx={{ mt: 3, zIndex: 1 }}>
                    <Typography variant="caption" color="text.secondary">🟢 Common: 50%</Typography>
                    <Typography variant="caption" color="text.secondary">🔵 Rare: 30%</Typography>
                    <Typography variant="caption" color="text.secondary">🟣 Epic: 15%</Typography>
                    <Typography variant="caption" color="text.secondary">🔴 Legendary: 5%</Typography>
                  </Stack>
                </Card>
              </Grid>

              {/* 2. SKINS SHOWCASE GALLERY */}
              <Grid size={{ xs: 12, md: 7 }}>
                <Box sx={{ mb: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Box>
                    <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>
                      🎨 {evoStage.label}造型牆 ({stagePool.filter(sk => unlockedSkins.includes(sk.id)).length}/{stagePool.length})
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      只會顯示目前進化階段的造型。點擊已解鎖的即可穿戴，左側主角會立刻換成該造型；未解鎖的可直接花 PEPE 買下。
                    </Typography>
                  </Box>
                  <Button
                    size="small"
                    variant="outlined"
                    color="success"
                    onClick={async () => {
                      const ok = await confirm({
                        title: '取消造型',
                        message: '脫下目前造型，變回原本的進化外觀？已解鎖的造型會保留，隨時可再穿戴。',
                        confirmLabel: '脫下造型',
                      });
                      if (ok) equipSkin('');
                    }}
                    sx={{ textTransform: 'none', fontWeight: 'bold' }}
                  >
                    脫下造型
                  </Button>
                </Box>

                <Box sx={{ maxHeight: 380, overflowY: 'auto', pr: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 2 }}>
                  {stagePool.map(skin => {
                    const isUnlocked = unlockedSkins.includes(skin.id);
                    const isEquipped = activeSkin === skin.id;
                    const rColor = getRarityColor(skin.rarity);

                    return (
                      <Card
                        key={skin.id}
                        onClick={() => isUnlocked ? equipSkin(skin.id) : buySkinDirect(skin)}
                        sx={{
                          p: 1.5,
                          cursor: 'pointer',
                          position: 'relative',
                          bgcolor: isEquipped ? 'rgba(124,193,74,0.06)' : 'rgba(255,255,255,0.01)',
                          border: '1px solid',
                          borderColor: isEquipped ? 'var(--palette-primary-main)' : 'rgba(255,255,255,0.06)',
                          textAlign: 'center',
                          borderRadius: 2,
                          transition: 'all 0.3s',
                          '&:hover': {
                            transform: 'translateY(-4px)',
                            borderColor: isUnlocked ? 'var(--palette-primary-main)' : rColor,
                            boxShadow: `0 4px 20px ${isUnlocked ? 'rgba(124,193,74,0.2)' : 'rgba(255,255,255,0.08)'}`
                          }
                        }}
                      >
                        {/* Status overlays */}
                        {isEquipped && (
                          <Box sx={{ position: 'absolute', top: 4, right: 4, bgcolor: 'var(--palette-primary-main)', color: '#000', borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem' }}>
                            ✓
                          </Box>
                        )}
                        {!isUnlocked && (
                          <Box sx={{ position: 'absolute', top: 4, right: 4, bgcolor: 'rgba(0,0,0,0.6)', p: 0.25, borderRadius: '50%', display: 'flex', color: 'text.secondary' }}>
                            <Iconify icon="solar:shield-keyhole-bold-duotone" sx={{ fontSize: 13 }} />
                          </Box>
                        )}

                        <Box sx={{ width: '100%', pt: '100%', position: 'relative', mb: 1, borderRadius: 1.5, overflow: 'hidden', bgcolor: 'rgba(0,0,0,0.2)' }}>
                          <img
                            src={skin.image}
                            alt={skin.name}
                            style={{
                              position: 'absolute',
                              top: 0, left: 0, width: '100%', height: '100%',
                              objectFit: 'cover',
                              filter: isUnlocked ? 'none' : 'grayscale(1) brightness(0.45)',
                              transition: 'filter 0.3s'
                            }}
                          />
                        </Box>

                        <Typography variant="caption" sx={{ fontWeight: '900', display: 'block', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap' }}>
                          {skin.name}
                        </Typography>

                        {/* Rarity Badge */}
                        <Box sx={{ mt: 0.5, px: 0.75, py: 0.1, bgcolor: `${rColor}15`, color: rColor, border: `1px solid ${rColor}30`, borderRadius: 1, fontSize: '0.62rem', fontWeight: 'bold', display: 'inline-block' }}>
                          {skin.rarity}
                        </Box>

                        {/* Price showing on hover locked card */}
                        {!isUnlocked && (
                          <Typography variant="caption" sx={{ display: 'block', mt: 0.5, fontWeight: 'bold', color: '#ffb300' }}>
                            💰 {skin.price}
                          </Typography>
                        )}
                      </Card>
                    );
                  })}
                </Box>
              </Grid>
            </Grid>
          </Box>
        )}

      </Box>{/* /tab content */}

      {/* 🐸 EVOLUTION CELEBRATION */}
      <Dialog
        open={!!evolvedTo}
        onClose={() => setEvolvedTo(null)}
        slotProps={{ paper: { sx: { bgcolor: '#070f19', border: `2px solid ${evolvedTo?.color || 'var(--palette-primary-main)'}`, borderRadius: 4, maxWidth: 460, overflow: 'hidden', p: 4, textAlign: 'center' } } }}
      >
        {evolvedTo && (
          <Box sx={{ position: 'relative' }}>
            {/* Rotating light rays */}
            <Box sx={{
              position: 'absolute', top: -140, left: -140, right: -140, bottom: -140,
              backgroundImage: `conic-gradient(from 0deg, ${evolvedTo.color}00 0deg, ${evolvedTo.color}44 18deg, ${evolvedTo.color}00 36deg, ${evolvedTo.color}00 72deg, ${evolvedTo.color}44 90deg, ${evolvedTo.color}00 108deg, ${evolvedTo.color}00 144deg, ${evolvedTo.color}44 162deg, ${evolvedTo.color}00 180deg, ${evolvedTo.color}00 216deg, ${evolvedTo.color}44 234deg, ${evolvedTo.color}00 252deg, ${evolvedTo.color}00 288deg, ${evolvedTo.color}44 306deg, ${evolvedTo.color}00 324deg)`,
              animation: 'rotateBurst 12s linear infinite',
              zIndex: 0,
              pointerEvents: 'none',
            }} />

            <Typography variant="overline" sx={{ color: 'text.secondary', letterSpacing: 2, zIndex: 1, position: 'relative' }}>
              EVOLUTION
            </Typography>
            <Typography variant="h4" sx={{ fontWeight: 900, color: evolvedTo.color, mb: 2, zIndex: 1, position: 'relative', textShadow: `0 0 24px ${evolvedTo.color}88` }}>
              進化成功！🎉
            </Typography>

            <Box sx={{ zIndex: 1, position: 'relative' }}>
              <PepeEvolutionHero level={level} size={260} evolving />
            </Box>

            <Typography variant="h5" sx={{ fontWeight: 900, color: evolvedTo.color, mt: 1, zIndex: 1, position: 'relative' }}>
              {evolvedTo.emoji} {evolvedTo.label}
            </Typography>
            <Typography variant="subtitle2" sx={{ color: '#ffb300', mb: 1.5, zIndex: 1, position: 'relative' }}>
              進化 Lv.{evolvedTo.stage} · {evolvedTo.title}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ px: 1, mb: 3.5, lineHeight: 1.6, zIndex: 1, position: 'relative' }}>
              {evolvedTo.desc}
            </Typography>

            <Button
              variant="contained"
              fullWidth
              onClick={() => setEvolvedTo(null)}
              sx={{ bgcolor: evolvedTo.color, color: '#000', fontWeight: 'bold', zIndex: 1, position: 'relative', '&:hover': { bgcolor: evolvedTo.color, filter: 'brightness(1.15)' } }}
            >
              太強了 🐸
            </Button>
          </Box>
        )}
      </Dialog>

      {/* 🎰 DRAW RESULT POPUP CELEBRATION */}
      <Dialog
        open={!!drawResult}
        onClose={() => setDrawResult(null)}
        slotProps={{ paper: { sx: { bgcolor: '#070f19', border: `2px solid ${drawResult ? getRarityColor(drawResult.rarity) : 'var(--palette-primary-main)'}`, borderRadius: 4, maxWidth: 450, overflow: 'hidden', p: 4, textAlign: 'center' } } }}
      >
        {drawResult && (
          <Box sx={{ position: 'relative' }}>
            {/* lightburst rays background */}
            <Box sx={{
              position: 'absolute', top: -100, left: -100, right: -100, bottom: -100,
              backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.15) 0%, transparent 60%)',
              animation: 'rotateBurst 20s linear infinite',
              zIndex: 0,
              pointerEvents: 'none'
            }} />

            <Typography variant="h5" sx={{ fontWeight: '900', color: '#ffb300', mb: 1, zIndex: 1, position: 'relative' }}>
              恭喜獲得！🎉
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ zIndex: 1, position: 'relative' }}>
              您已成功破殼孵化出全新佩佩蛙稀有造型！
            </Typography>

            <Box sx={{ width: 220, height: 220, mx: 'auto', my: 3, border: `4px solid ${getRarityColor(drawResult.rarity)}`, boxShadow: `0 0 35px ${getRarityColor(drawResult.rarity)}`, borderRadius: 3, overflow: 'hidden', position: 'relative', zIndex: 1 }}>
              <img src={drawResult.image} alt={drawResult.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            </Box>

            <Typography variant="h6" sx={{ fontWeight: '900', color: getRarityColor(drawResult.rarity), zIndex: 1, position: 'relative' }}>
              {drawResult.emoji} {drawResult.name}
            </Typography>
            
            <Box sx={{ my: 1.5, zIndex: 1, position: 'relative' }}>
              <Box sx={{ px: 2, py: 0.5, bgcolor: `${getRarityColor(drawResult.rarity)}20`, color: getRarityColor(drawResult.rarity), border: `1px solid ${getRarityColor(drawResult.rarity)}`, borderRadius: 1.5, fontSize: '0.8rem', fontWeight: 'bold', display: 'inline-block' }}>
                稀有度: {drawResult.rarity}
              </Box>
            </Box>

            <Typography variant="body2" color="text.secondary" sx={{ px: 2, mb: 4, lineHeight: 1.5, zIndex: 1, position: 'relative' }}>
              解鎖了 {evoStage.label} 階段的專屬造型。立即穿戴，左側的主角就會換成牠。
            </Typography>

            <Stack direction="row" spacing={2} sx={{ zIndex: 1, position: 'relative' }}>
              <Button
                variant="contained"
                fullWidth
                onClick={() => {
                  equipSkin(drawResult.id);
                  setDrawResult(null);
                }}
                sx={{ bgcolor: 'var(--palette-primary-main)', color: '#000', fontWeight: 'bold', '&:hover': { bgcolor: '#94d862' } }}
              >
                👕 立即穿戴造型
              </Button>
              <Button
                variant="outlined"
                color="inherit"
                fullWidth
                onClick={() => setDrawResult(null)}
                sx={{ fontWeight: 'bold' }}
              >
                收進衣櫃
              </Button>
            </Stack>
          </Box>
        )}
      </Dialog>
     </Box>
    </Container>
  );
}
