import React, { useState, useEffect } from 'react';

import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Grid from '@mui/material/Grid';
import Card from '@mui/material/Card';
import Stack from '@mui/material/Stack';
import Dialog from '@mui/material/Dialog';
import Button from '@mui/material/Button';
import Avatar from '@mui/material/Avatar';
import Typography from '@mui/material/Typography';
import IconButton from '@mui/material/IconButton';
import LinearProgress from '@mui/material/LinearProgress';
import DialogContent from '@mui/material/DialogContent';

import { useWalletContext } from 'src/contexts/wallet-context';
import { Iconify } from 'src/components/iconify';
import { PEPE_SKINS, PepeSkin } from 'src/components/pepefi/pepeSkinsData';

// ── Types & Assets ─────────────────────────────────────────────────────────────

const POTIONS = [
  { id: 'green', name: 'Pepe Green Juice (綠色蛙汁)', desc: '讓你的 Pepe 眼睛發光，經驗值 +50 XP！', cost: 100, xp: 50, color: '#4caf50', emoji: '🧪' },
  { id: 'gold', name: 'Golden Elixir (黃金仙露)', desc: '解鎖奢華黃金配飾，經驗值 +150 XP！', cost: 300, xp: 150, color: '#ffd700', emoji: '🍶' },
  { id: 'moon', name: 'Moon Potion (登月藥水)', desc: '獲得登月火箭背包，直接獲得 +500 XP！', cost: 800, xp: 500, color: '#2196f3', emoji: '🚀' },
];

const CLOTHES = [
  { id: 'none', name: 'Original Look (經典皮衣)', cost: 0, levelRequired: 1, emoji: '🐸', desc: '原汁原味的佩佩蛙經典造型。' },
  { id: 'suit', name: 'Merchant Suit (交易員西裝)', cost: 200, levelRequired: 5, emoji: '👔', desc: '穿上極具專業感的明星交易員西服。' },
  { id: 'cape', name: 'Royal Cape (黃金蛙皇披風)', cost: 500, levelRequired: 15, emoji: '👑', desc: '披上金光璀璨的皇家王者金披風。' },
  { id: 'astronaut', name: 'Astronaut Suit (登月太空衣)', cost: 1000, levelRequired: 30, emoji: '👨‍🚀', desc: '配備最硬核的火箭噴射登月太空服飾。' },
];

// ── Helper Title ──────────────────────────────────────────────────────────────

const getTitleByLevel = (lvl: number) => {
  if (lvl >= 30) return 'Supreme DeFi Space Lord 🌌';
  if (lvl >= 15) return 'Gold Emperor Pepe 👑';
  if (lvl >= 8)  return 'Elite Chad Trader 💼';
  return 'Starter Green Frog 🐸';
};

interface PepeGameFiModalProps {
  open: boolean;
  onClose: () => void;
  defaultTab?: 'potions' | 'wardrobe' | 'skins';
}

export default function PepeGameFiModal({ open, onClose, defaultTab = 'potions' }: PepeGameFiModalProps) {
  const [tabValue, setTabValue] = useState<'potions' | 'wardrobe' | 'skins'>('potions');
  const wallet = useWalletContext();
  const userAddress = wallet.address || 'mock_user';

  useEffect(() => {
    if (open) {
      setTabValue(defaultTab);
    }
  }, [open, defaultTab]);

  // ── Persistent state in localStorage ─────────────────────────────────────────
  const [pepeBal, setPepeBal] = useState<number>(5000);
  const [xp, setXp] = useState<number>(0);
  const [level, setLevel] = useState<number>(1);
  const [activeClothes, setActiveClothes] = useState<string>('none');
  
  // Custom Skins and Avatars
  const [unlockedSkins, setUnlockedSkins] = useState<string[]>(['none']);
  const [activeSkin, setActiveSkin] = useState<string>('/avatars/pepe-01.png');

  // Gachapon state
  const [isDrawing, setIsDrawing] = useState<boolean>(false);
  const [drawResult, setDrawResult] = useState<PepeSkin | null>(null);

  // Load from storage
  useEffect(() => {
    try {
      const savedBal = localStorage.getItem('pepefi:gamefi:balance');
      const savedXp  = localStorage.getItem('pepefi:gamefi:xp');
      const savedLvl = localStorage.getItem('pepefi:gamefi:level');
      const savedClo = localStorage.getItem('pepefi:gamefi:active_clothes');
      
      const savedUnl = localStorage.getItem('pepefi:gamefi:unlocked_skins');
      const savedAsk = localStorage.getItem('pepefi:gamefi:active_skin');

      if (savedBal) setPepeBal(Number(savedBal));
      if (savedXp)  setXp(Number(savedXp));
      if (savedLvl) setLevel(Number(savedLvl));
      if (savedClo) setActiveClothes(savedClo);

      if (savedUnl) {
        setUnlockedSkins(JSON.parse(savedUnl));
      } else {
        setUnlockedSkins(['none']);
      }
      if (savedAsk) setActiveSkin(savedAsk);
    } catch (e) { /* fallback to defaults */ }
  }, [open]);

  // Save to storage
  const saveState = (newBal: number, newXp: number, newLvl: number, newClo: string, newUnl?: string[], newAsk?: string) => {
    localStorage.setItem('pepefi:gamefi:balance', newBal.toString());
    localStorage.setItem('pepefi:gamefi:xp', newXp.toString());
    localStorage.setItem('pepefi:gamefi:level', newLvl.toString());
    localStorage.setItem('pepefi:gamefi:active_clothes', newClo);

    const finalUnl = newUnl || unlockedSkins;
    const finalAsk = newAsk !== undefined ? newAsk : activeSkin;

    localStorage.setItem('pepefi:gamefi:unlocked_skins', JSON.stringify(finalUnl));
    localStorage.setItem('pepefi:gamefi:active_skin', finalAsk);

    setPepeBal(newBal);
    setXp(newXp);
    setLevel(newLvl);
    setActiveClothes(newClo);
    setUnlockedSkins(finalUnl);
    setActiveSkin(finalAsk);

    // Save to the standard user avatar store so all PepeAvatars sync instantly
    try {
      localStorage.setItem(`pepeAvatar_${userAddress.toLowerCase()}`, finalAsk);
    } catch (e) { /* fallback */ }

    // Dispatch global event so header avatar or layouts can react to level-ups/skin-swaps
    window.dispatchEvent(new CustomEvent('pepefi:gamefi-updated'));
  };


  // ── Potion Shop Logic ────────────────────────────────────────────────────────

  const buyPotion = (id: string, cost: number, xpBonus: number) => {
    if (pepeBal < cost) {
      alert('您的 PEPE 代幣餘額不足！請到 Rewards 🎁 頁面簽到或做交易挖礦領取更多。');
      return;
    }
    const nextBal = pepeBal - cost;
    const nextXp  = xp + xpBonus;
    let nextLvl = level;
    let tempXp  = nextXp;
    while (tempXp >= nextLvl * 100) {
      tempXp -= nextLvl * 100;
      nextLvl += 1;
    }
    saveState(nextBal, tempXp, nextLvl, activeClothes);
  };

  // ── Wardrobe Logic ───────────────────────────────────────────────────────────

  const equipClothes = (clothId: string, levelReq: number) => {
    if (level < levelReq) {
      alert(`此服裝需要 Pepe 等級達 Lv.${levelReq} 才能解鎖！`);
      return;
    }
    saveState(pepeBal, xp, level, clothId, unlockedSkins, '/avatars/pepe-01.png');
  };

  // Find active outfit emoji for avatar box
  const activeOutfit = CLOTHES.find(c => c.id === activeClothes) || CLOTHES[0];

  // Calculate next unlock
  const nextUnlock = CLOTHES.find(c => level < c.levelRequired);
  const levelsToNext = nextUnlock ? nextUnlock.levelRequired - level : 0;

  // ── Gachapon & Skin Shop Logic ───────────────────────────────────────────────

  const drawGachapon = () => {
    if (isDrawing) return;
    const COST = 500;
    if (pepeBal < COST) {
      alert('您的 PEPE 代幣餘額不足！抽取一次盲盒需要 500 PEPE。');
      return;
    }

    // Filter locked custom skins (excluding 'none')
    const lockedSkins = PEPE_SKINS.filter(s => !unlockedSkins.includes(s.id));
    if (lockedSkins.length === 0) {
      alert('恭喜您！您已經集齊了所有 25 款奢華佩佩蛙造型！無須再抽盲盒。');
      return;
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
      // Fallback if no locked skins in selected rarity
      if (candidates.length === 0) {
        candidates = lockedSkins;
      }

      // Draw a random skin from candidates
      const chosenSkin = candidates[Math.floor(Math.random() * candidates.length)];
      
      const newUnlocked = [...unlockedSkins, chosenSkin.id];
      saveState(pepeBal - COST, xp, level, activeClothes, newUnlocked, activeSkin);

      setDrawResult(chosenSkin);
      setIsDrawing(false);
    }, 2500);
  };

  const buySkinDirect = (skin: PepeSkin) => {
    if (unlockedSkins.includes(skin.id)) return;
    if (pepeBal < skin.price) {
      alert(`您的 PEPE 代幣餘額不足！購買此造型需要 ${skin.price} PEPE。`);
      return;
    }

    if (window.confirm(`您確定要以 ${skin.price} PEPE 購買此造型「${skin.name}」嗎？`)) {
      const newUnlocked = [...unlockedSkins, skin.id];
      saveState(pepeBal - skin.price, xp, level, activeClothes, newUnlocked, activeSkin);
      alert(`恭喜！成功購買並解鎖「${skin.name}」！🎉`);
    }
  };

  const equipSkin = (skinPath: string) => {
    // Save skin image to activeSkin state
    saveState(pepeBal, xp, level, 'custom_skin', unlockedSkins, skinPath);
  };

  const getRarityColor = (rarity: string) => {
    switch (rarity) {
      case 'Legendary': return '#ff3d00';
      case 'Epic': return '#b200ff';
      case 'Rare': return '#00b0ff';
      default: return '#7cc14a';
    }
  };

  const currentActiveSkinObject = PEPE_SKINS.find(s => s.imagePath === activeSkin);
  const displayAvatar = activeSkin && activeSkin !== 'none' ? activeSkin : '/avatars/pepe-01.png';

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" slotProps={{ paper: { sx: { bgcolor: '#0b1625', border: '1px solid rgba(124,193,74,0.3)', borderRadius: 3 } } }}>
      
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

      <Box sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Avatar src={displayAvatar} sx={{ border: '2px solid #7cc14a', boxShadow: '0 0 10px rgba(124,193,74,0.5)', width: 42, height: 42 }} />
          <Box>
            <Typography variant="h6" sx={{ fontWeight: 900, color: '#7cc14a' }}>
              Pepe GameFi & MemeFi Lab 🧪
            </Typography>
            <Typography variant="caption" sx={{ color: 'text.secondary' }}>
              DeFi · SocialFi · GameFi · MemeFi 一體化升級中心
            </Typography>
          </Box>
        </Stack>
        <IconButton onClick={onClose} sx={{ color: 'text.secondary' }}>
          <Iconify icon="mingcute:close-line" />
        </IconButton>
      </Box>

      {/* Stats bar */}
      <Box sx={{ px: 3, py: 2, bgcolor: 'rgba(255,255,255,0.02)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
        <Stack direction="row" spacing={3}>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>等級稱號 Title</Typography>
            <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#ffb300' }}>
              {getTitleByLevel(level)}
            </Typography>
          </Box>
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>Pepe等級</Typography>
            <Typography variant="body2" sx={{ fontWeight: 'bold', color: '#7cc14a' }}>
              Lv. {level}
            </Typography>
          </Box>
          <Box sx={{ width: 120 }}>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>經驗值 XP</span>
              <span>{xp}/{level * 100}</span>
            </Typography>
            <LinearProgress variant="determinate" value={Math.min(100, (xp / (level * 100)) * 100)} sx={{ height: 6, borderRadius: 3, mt: 0.5, bgcolor: 'rgba(255,255,255,0.08)', '& .MuiLinearProgress-bar': { bgcolor: '#7cc14a' } }} />
          </Box>
        </Stack>

        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, bgcolor: 'rgba(124,193,74,0.12)', border: '1px solid rgba(124,193,74,0.3)', px: 2, py: 0.75, borderRadius: 2 }}>
          <Typography variant="subtitle2" sx={{ color: '#7cc14a', fontWeight: 'bold' }}>
            💰 餘額: {pepeBal.toLocaleString()} PEPE
          </Typography>
        </Box>
      </Box>

      <Tabs value={tabValue} onChange={(_, nv) => setTabValue(nv)} centered indicatorColor="custom" sx={{ borderBottom: '1px solid rgba(255,255,255,0.06)', '& .MuiTab-root': { color: 'text.secondary', fontWeight: 'bold', fontSize: '1.05rem', '&.Mui-selected': { color: '#7cc14a' } } }}>
        <Tab value="potions" label="🧪 魔法藥水 (Potions)" />
        <Tab value="wardrobe" label="👕 尊貴衣裝 (Wardrobe)" />
        <Tab value="skins" label="🎰 造型盲盒與商城 (Skins & Gacha)" />
      </Tabs>

      <DialogContent sx={{ minHeight: 450, py: 3 }}>
        
        {/* A. POTION SHOP TAB */}
        {tabValue === 'potions' && (
          <Grid container spacing={3}>
            {POTIONS.map(potion => (
              <Grid size={{ xs: 12, md: 4 }} key={potion.id}>
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
                    <Button variant="contained" fullWidth onClick={() => buyPotion(potion.id, potion.cost, potion.xp)} sx={{ bgcolor: 'rgba(124,193,74,0.15)', border: '1px solid', borderColor: '#7cc14a', color: '#7cc14a', fontWeight: 'bold', '&:hover': { bgcolor: '#7cc14a', color: '#fff' } }}>
                      🛒 購買並使用 ({potion.cost} PEPE)
                    </Button>
                  </Box>
                </Card>
              </Grid>
            ))}
          </Grid>
        )}

        {/* B. WARDROBE TAB */}
        {tabValue === 'wardrobe' && (
          <Box>
            {/* Top Interactive Character Showcase Card */}
            <Card sx={{
              p: 3,
              mb: 4,
              position: 'relative',
              overflow: 'hidden',
              background: 'linear-gradient(135deg, rgba(124,193,74,0.12) 0%, rgba(255,210,61,0.06) 100%)',
              border: '1px solid rgba(124,193,74,0.3)',
              borderRadius: 2.5,
              boxShadow: '0 8px 32px rgba(124,193,74,0.1)'
            }}>
              <Grid container spacing={3} alignItems="center">
                {/* Character preview */}
                <Grid size={{ xs: 12, sm: 4 }} sx={{ textAlign: 'center' }}>
                  <Box sx={{ position: 'relative', display: 'inline-block' }}>
                    {/* Glowing Outer Ring */}
                    <Box sx={{
                      position: 'absolute', top: -5, left: -5, right: -5, bottom: -5,
                      borderRadius: '50%',
                      border: '3px solid transparent',
                      borderTopColor: '#7cc14a',
                      borderBottomColor: '#ffd700',
                      animation: 'spin 6s linear infinite',
                      '@keyframes spin': {
                        '0%': { transform: 'rotate(0deg)' },
                        '100%': { transform: 'rotate(360deg)' }
                      }
                    }} />

                    {/* Dynamic Floating Accessory */}
                    {activeClothes !== 'none' && activeClothes !== 'custom_skin' && (
                      <Box sx={{
                        position: 'absolute',
                        top: -15,
                        left: -15,
                        fontSize: '2.5rem',
                        filter: 'drop-shadow(0 0 10px rgba(124,193,74,0.7))',
                        animation: 'floatAcc 2.5s infinite ease-in-out',
                        '@keyframes floatAcc': {
                          '0%, 100%': { transform: 'translateY(0) rotate(0deg)' },
                          '50%': { transform: 'translateY(-12px) rotate(12deg)' }
                        }
                      }}>
                        {activeClothes === 'suit' && '💼'}
                        {activeClothes === 'cape' && '👑'}
                        {activeClothes === 'astronaut' && '🚀'}
                      </Box>
                    )}

                    <Avatar src={displayAvatar} sx={{ width: 130, height: 130, border: '4px solid #0b1625', boxShadow: '0 0 25px rgba(124,193,74,0.4)', mx: 'auto' }} />
                    <Box sx={{ position: 'absolute', bottom: -10, right: 10, bgcolor: '#ffb300', color: '#000', px: 1.5, py: 0.5, borderRadius: 1.5, fontSize: '0.85rem', fontWeight: '900', border: '2px solid #0b1625', boxShadow: '0 4px 10px rgba(0,0,0,0.5)' }}>
                      {activeClothes === 'custom_skin' && currentActiveSkinObject ? currentActiveSkinObject.emoji : activeOutfit.emoji} 等級 {level}
                    </Box>
                  </Box>
                </Grid>

                {/* Status description */}
                <Grid size={{ xs: 12, sm: 8 }}>
                  <Typography variant="h5" sx={{ fontWeight: 900, color: '#7cc14a', mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    {activeClothes === 'custom_skin' && currentActiveSkinObject ? (
                      <>
                        {currentActiveSkinObject.emoji} {currentActiveSkinObject.name}
                      </>
                    ) : (
                      <>
                        {activeOutfit.emoji} {activeOutfit.name.split(' ')[0]}
                      </>
                    )}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5, lineHeight: 1.6 }}>
                    {activeClothes === 'custom_skin' && currentActiveSkinObject ? currentActiveSkinObject.desc : activeOutfit.desc} 目前您已達到了 <strong>Lv. {level} {getTitleByLevel(level).split(' ')[0]}</strong> 的尊貴段位。
                  </Typography>
                  <Stack direction="row" spacing={1.5}>
                    <Box sx={{ bgcolor: 'rgba(255,255,255,0.04)', px: 2.5, py: 1, borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.06)', minWidth: 120 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>目前穿戴</Typography>
                      <Typography variant="subtitle2" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        {activeClothes === 'custom_skin' && currentActiveSkinObject ? (
                          <>
                            {currentActiveSkinObject.emoji} {currentActiveSkinObject.name.substring(0, 5)}...
                          </>
                        ) : (
                          <>
                            {activeOutfit.emoji} {activeOutfit.name.split(' ')[0]}
                          </>
                        )}
                      </Typography>
                    </Box>
                    <Box sx={{ bgcolor: 'rgba(255,255,255,0.04)', px: 2.5, py: 1, borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.06)', minWidth: 120 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>聲譽 Title</Typography>
                      <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: '#ffb300' }}>
                        {getTitleByLevel(level).split(' ')[0]}
                      </Typography>
                    </Box>
                  </Stack>

                  {/* Progress message */}
                  <Box sx={{ mt: 2, p: 1.5, bgcolor: 'rgba(0,0,0,0.2)', borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Box sx={{ bgcolor: nextUnlock ? 'rgba(255,179,0,0.1)' : 'rgba(124,193,74,0.1)', color: nextUnlock ? '#ffb300' : '#7cc14a', width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', flexShrink: 0 }}>
                      {nextUnlock ? '⚡' : '🏆'}
                    </Box>
                    <Typography variant="caption" sx={{ color: nextUnlock ? 'text.secondary' : '#7cc14a', fontWeight: 'bold' }}>
                      {nextUnlock ? (
                        <>
                          距離解鎖下一件等級裝備 <strong>{nextUnlock.emoji} {nextUnlock.name.split(' ')[0]}</strong> 還差 <strong style={{ color: '#ffb300' }}>{levelsToNext}</strong> 級！(需要達 Lv.{nextUnlock.levelRequired})
                        </>
                      ) : (
                        '🎉 恭喜！您已解鎖所有終極神裝！去 🎰 造型商城 抽取您專屬的傳奇佩佩吧！'
                      )}
                    </Typography>
                  </Box>
                </Grid>
              </Grid>
            </Card>

            <Grid container spacing={3}>
              {CLOTHES.map(c => {
                const isUnlocked = level >= c.levelRequired;
                const isEquipped = activeClothes === c.id;
                return (
                  <Grid size={{ xs: 12, sm: 6 }} key={c.id}>
                    <Card sx={{
                      p: 3,
                      position: 'relative',
                      border: '1px solid',
                      borderColor: isEquipped ? '#7cc14a' : 'rgba(255,255,255,0.08)',
                      bgcolor: isEquipped ? 'rgba(124,193,74,0.04)' : 'rgba(255,255,255,0.02)',
                      boxShadow: isEquipped ? '0 0 25px rgba(124,193,74,0.15)' : 'none',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'space-between',
                      transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
                      '&:hover': {
                        borderColor: isUnlocked ? '#7cc14a' : 'rgba(255,255,255,0.08)',
                        boxShadow: isUnlocked ? '0 8px 30px rgba(124,193,74,0.2)' : 'none',
                        transform: isUnlocked ? 'translateY(-4px)' : 'none',
                      }
                    }}>
                      {isEquipped && (
                        <Box sx={{ position: 'absolute', top: 0, right: 0, bgcolor: '#7cc14a', color: '#000', px: 1.5, py: 0.25, borderRadius: '0 0 0 8px', fontSize: '0.72rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Iconify icon="solar:check-circle-bold" sx={{ fontSize: 13 }} /> 已穿戴
                        </Box>
                      )}
                      {!isUnlocked && (
                        <Box sx={{ position: 'absolute', top: 0, right: 0, bgcolor: 'rgba(255,255,255,0.08)', color: 'text.secondary', px: 1.5, py: 0.25, borderRadius: '0 0 0 8px', fontSize: '0.72rem', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                          <Iconify icon="solar:shield-keyhole-bold-duotone" sx={{ fontSize: 13 }} /> 未解鎖
                        </Box>
                      )}

                      <Stack direction="row" spacing={2.5} alignItems="center">
                        <Box sx={{ fontSize: 38, filter: isUnlocked ? 'none' : 'grayscale(1) opacity(0.3)', bgcolor: isEquipped ? 'rgba(124,193,74,0.1)' : 'rgba(255,255,255,0.04)', p: 1.5, borderRadius: 2, border: '1px solid', borderColor: isEquipped ? '#7cc14a' : 'rgba(255,255,255,0.08)', display: 'flex', alignItems: 'center', justifyContent: 'center', width: 60, height: 60 }}>
                          {c.emoji}
                        </Box>
                        <Box>
                          <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: isUnlocked ? 'text.primary' : 'text.disabled' }}>
                            {c.name}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, maxWidth: 200, lineHeight: 1.4 }}>
                            {c.desc}
                          </Typography>
                          <Typography variant="caption" sx={{ color: isUnlocked ? '#7cc14a' : '#ffb300', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
                            {isUnlocked ? (
                              <>
                                <Iconify icon="solar:verified-check-bold" sx={{ fontSize: 12 }} /> 已解鎖
                              </>
                            ) : (
                              <>
                                <Iconify icon="solar:clock-circle-bold" sx={{ fontSize: 12 }} /> 需要達 Lv.{c.levelRequired} 級
                              </>
                            )}
                          </Typography>
                        </Box>
                      </Stack>

                      <Button
                        size="small"
                        variant={isEquipped ? 'contained' : 'outlined'}
                        disabled={!isUnlocked}
                        onClick={() => equipClothes(c.id, c.levelRequired)}
                        sx={{
                          bgcolor: isEquipped ? '#7cc14a' : 'transparent',
                          color: isEquipped ? '#fff' : '#7cc14a',
                          borderColor: '#7cc14a',
                          fontWeight: 'bold',
                          py: 0.75,
                          px: 2,
                          borderRadius: 1.5,
                          textTransform: 'none',
                          '&:hover': {
                            bgcolor: isEquipped ? '#5a9e2f' : 'rgba(124,193,74,0.08)',
                            borderColor: '#7cc14a'
                          }
                        }}
                      >
                        {isEquipped ? '已穿戴' : isUnlocked ? '換上這件' : `Lv.${c.levelRequired}`}
                      </Button>
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
                      background: 'radial-gradient(circle, #ffe082 10%, #7cc14a 70%)',
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
                    DeFi 佩佩蛙進化盲盒
                  </Typography>
                  <Typography variant="caption" color="text.secondary" sx={{ mt: 1, mb: 3, textAlign: 'center', maxWidth: 260, zIndex: 1 }}>
                    花費 <strong>500 PEPE</strong> 隨機抽取 25 款隱藏版傳奇造型！擁有高機率獲得稀有、史詩與傳奇造型。
                  </Typography>

                  <Button
                    variant="contained"
                    size="large"
                    disabled={isDrawing}
                    onClick={drawGachapon}
                    sx={{
                      bgcolor: '#7cc14a',
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
                    {isDrawing ? '正在破殼孵化中...' : '🎰 幸運抽造型 (500 PEPE)'}
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
                      🎨 造型更衣展示牆 ({unlockedSkins.length - 1}/25)
                    </Typography>
                    <Typography variant="caption" color="text.secondary">
                      點擊已解鎖造型即可穿戴，滑鼠懸停於未解鎖造型可花費代幣直接進行解鎖！
                    </Typography>
                  </Box>
                  <Button
                    size="small"
                    variant="outlined"
                    color="success"
                    onClick={() => {
                      if (window.confirm('確定要切換回預設經典頭像嗎？')) {
                        equipSkin('/avatars/pepe-01.png');
                      }
                    }}
                    sx={{ textTransform: 'none', fontWeight: 'bold' }}
                  >
                    重置為經典頭像
                  </Button>
                </Box>

                <Box sx={{ maxHeight: 380, overflowY: 'auto', pr: 1, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 2 }}>
                  {PEPE_SKINS.map(skin => {
                    const isUnlocked = unlockedSkins.includes(skin.id);
                    const isEquipped = activeSkin === skin.imagePath;
                    const rColor = getRarityColor(skin.rarity);

                    return (
                      <Card
                        key={skin.id}
                        onClick={() => isUnlocked ? equipSkin(skin.imagePath) : buySkinDirect(skin)}
                        sx={{
                          p: 1.5,
                          cursor: 'pointer',
                          position: 'relative',
                          bgcolor: isEquipped ? 'rgba(124,193,74,0.06)' : 'rgba(255,255,255,0.01)',
                          border: '1px solid',
                          borderColor: isEquipped ? '#7cc14a' : 'rgba(255,255,255,0.06)',
                          textAlign: 'center',
                          borderRadius: 2,
                          transition: 'all 0.3s',
                          '&:hover': {
                            transform: 'translateY(-4px)',
                            borderColor: isUnlocked ? '#7cc14a' : rColor,
                            boxShadow: `0 4px 20px ${isUnlocked ? 'rgba(124,193,74,0.2)' : 'rgba(255,255,255,0.08)'}`
                          }
                        }}
                      >
                        {/* Status overlays */}
                        {isEquipped && (
                          <Box sx={{ position: 'absolute', top: 4, right: 4, bgcolor: '#7cc14a', color: '#000', borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.7rem' }}>
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
                            src={skin.imagePath}
                            alt={skin.name}
                            style={{
                              position: 'absolute',
                              top: 0, left: 0, width: '100%', height: '100%',
                              objectFit: 'cover',
                              filter: isUnlocked ? 'none' : 'grayscale(1) opacity(0.4)',
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

      </DialogContent>

      <Box sx={{ p: 2, display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <Button variant="outlined" color="inherit" onClick={onClose} sx={{ fontWeight: 'bold' }}>
          關閉 Lab 視窗
        </Button>
      </Box>

      {/* 🎰 DRAW RESULT POPUP CELEBRATION */}
      <Dialog
        open={!!drawResult}
        onClose={() => setDrawResult(null)}
        slotProps={{ paper: { sx: { bgcolor: '#070f19', border: `2px solid ${drawResult ? getRarityColor(drawResult.rarity) : '#7cc14a'}`, borderRadius: 4, maxWidth: 450, overflow: 'hidden', p: 4, textAlign: 'center' } } }}
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
              <img src={drawResult.imagePath} alt={drawResult.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
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
              {drawResult.desc}
            </Typography>

            <Stack direction="row" spacing={2} sx={{ zIndex: 1, position: 'relative' }}>
              <Button
                variant="contained"
                fullWidth
                onClick={() => {
                  equipSkin(drawResult.imagePath);
                  setDrawResult(null);
                }}
                sx={{ bgcolor: '#7cc14a', color: '#000', fontWeight: 'bold', '&:hover': { bgcolor: '#94d862' } }}
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
    </Dialog>
  );
}
