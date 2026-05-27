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

import { Iconify } from 'src/components/iconify';

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
  defaultTab?: 'potions' | 'wardrobe';
}

export default function PepeGameFiModal({ open, onClose, defaultTab = 'potions' }: PepeGameFiModalProps) {
  const [tabValue, setTabValue] = useState<'potions' | 'wardrobe'>('potions');

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

  // Load from storage
  useEffect(() => {
    try {
      const savedBal = localStorage.getItem('pepefi:gamefi:balance');
      const savedXp  = localStorage.getItem('pepefi:gamefi:xp');
      const savedLvl = localStorage.getItem('pepefi:gamefi:level');
      const savedClo = localStorage.getItem('pepefi:gamefi:active_clothes');

      if (savedBal) setPepeBal(Number(savedBal));
      if (savedXp)  setXp(Number(savedXp));
      if (savedLvl) setLevel(Number(savedLvl));
      if (savedClo) setActiveClothes(savedClo);
    } catch (e) { /* fallback to defaults */ }
  }, [open]);

  // Save to storage
  const saveState = (newBal: number, newXp: number, newLvl: number, newClo: string) => {
    localStorage.setItem('pepefi:gamefi:balance', newBal.toString());
    localStorage.setItem('pepefi:gamefi:xp', newXp.toString());
    localStorage.setItem('pepefi:gamefi:level', newLvl.toString());
    localStorage.setItem('pepefi:gamefi:active_clothes', newClo);

    setPepeBal(newBal);
    setXp(newXp);
    setLevel(newLvl);
    setActiveClothes(newClo);

    // Dispatch global event so header avatar or layouts can react to level-ups
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
    // XP algorithm: each level takes Level * 100 XP
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
    saveState(pepeBal, xp, level, clothId);
  };

  // Find active outfit emoji for avatar box
  const activeOutfit = CLOTHES.find(c => c.id === activeClothes) || CLOTHES[0];

  // Calculate next unlock
  const nextUnlock = CLOTHES.find(c => level < c.levelRequired);
  const levelsToNext = nextUnlock ? nextUnlock.levelRequired - level : 0;

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md" slotProps={{ paper: { sx: { bgcolor: '#0b1625', border: '1px solid rgba(124,193,74,0.3)', borderRadius: 3 } } }}>
      <Box sx={{ p: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Avatar src="/avatars/pepe-01.png" sx={{ border: '2px solid #7cc14a', boxShadow: '0 0 10px rgba(124,193,74,0.5)' }} />
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
        <Tab value="potions" label="🧪 魔法藥水商店 (Potion Shop)" />
        <Tab value="wardrobe" label="👕 尊貴更衣室 (Pepe Wardrobe)" />
      </Tabs>

      <DialogContent sx={{ minHeight: 400, py: 3 }}>
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
                    {activeClothes !== 'none' && (
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

                    <Avatar src="/avatars/pepe-01.png" sx={{ width: 130, height: 130, border: '4px solid #0b1625', boxShadow: '0 0 25px rgba(124,193,74,0.4)', mx: 'auto' }} />
                    <Box sx={{ position: 'absolute', bottom: -10, right: 10, bgcolor: '#ffb300', color: '#000', px: 1.5, py: 0.5, borderRadius: 1.5, fontSize: '0.85rem', fontWeight: '900', border: '2px solid #0b1625', boxShadow: '0 4px 10px rgba(0,0,0,0.5)' }}>
                      {activeOutfit.emoji} 等級 {level}
                    </Box>
                  </Box>
                </Grid>

                {/* Status description */}
                <Grid size={{ xs: 12, sm: 8 }}>
                  <Typography variant="h5" sx={{ fontWeight: 900, color: '#7cc14a', mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    {activeOutfit.emoji} {activeOutfit.name.split(' ')[0]}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5, lineHeight: 1.6 }}>
                    {activeOutfit.desc} 目前您已達到了 <strong>Lv. {level} {getTitleByLevel(level).split(' ')[0]}</strong> 的尊貴段位。
                  </Typography>
                  <Stack direction="row" spacing={1.5}>
                    <Box sx={{ bgcolor: 'rgba(255,255,255,0.04)', px: 2.5, py: 1, borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.06)', minWidth: 120 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>目前穿戴</Typography>
                      <Typography variant="subtitle2" sx={{ fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: 0.5 }}>
                        {activeOutfit.emoji} {activeOutfit.name.split(' ')[0]}
                      </Typography>
                    </Box>
                    <Box sx={{ bgcolor: 'rgba(255,255,255,0.04)', px: 2.5, py: 1, borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.06)', minWidth: 120 }}>
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>聲譽 Title</Typography>
                      <Typography variant="subtitle2" sx={{ fontWeight: 'bold', color: '#ffb300' }}>
                        {getTitleByLevel(level).split(' ')[0]}
                      </Typography>
                    </Box>
                  </Stack>

                  {/* Progress message with a clean gamified design */}
                  <Box sx={{ mt: 2, p: 1.5, bgcolor: 'rgba(0,0,0,0.2)', borderRadius: 1.5, border: '1px solid rgba(255,255,255,0.05)', display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Box sx={{ bgcolor: nextUnlock ? 'rgba(255,179,0,0.1)' : 'rgba(124,193,74,0.1)', color: nextUnlock ? '#ffb300' : '#7cc14a', width: 26, height: 26, borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '0.85rem', flexShrink: 0 }}>
                      {nextUnlock ? '⚡' : '🏆'}
                    </Box>
                    <Typography variant="caption" sx={{ color: nextUnlock ? 'text.secondary' : '#7cc14a', fontWeight: 'bold' }}>
                      {nextUnlock ? (
                        <>
                          距離解鎖下一件酷炫裝備 <strong>{nextUnlock.emoji} {nextUnlock.name.split(' ')[0]}</strong> 還差 <strong style={{ color: '#ffb300' }}>{levelsToNext}</strong> 級！(需要達 Lv.{nextUnlock.levelRequired})
                        </>
                      ) : (
                        '🎉 恭喜！您已解鎖所有終極神裝，傲視群雄！'
                      )}
                    </Typography>
                  </Box>
                </Grid>
              </Grid>
            </Card>

            <Box sx={{ mb: 3, display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Box sx={{ bgcolor: 'rgba(124,193,74,0.1)', p: 1, borderRadius: '50%', color: '#7cc14a', display: 'flex' }}>
                <Iconify icon="solar:palette-bold" sx={{ fontSize: 22 }} />
              </Box>
              <Box>
                <Typography variant="subtitle1" sx={{ fontWeight: '900', color: 'text.primary' }}>
                  穿戴您解鎖的華麗衣裝！
                </Typography>
                <Typography variant="caption" color="text.secondary">
                  隨著等級提升解鎖更酷炫的配飾與尊貴徽章，換裝後頭像旁將會獲得專屬標識！
                </Typography>
              </Box>
            </Box>

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
                      {/* Equipped/Locked Badge */}
                      {isEquipped && (
                        <Box sx={{
                          position: 'absolute',
                          top: 0,
                          right: 0,
                          bgcolor: '#7cc14a',
                          color: '#000',
                          px: 1.5,
                          py: 0.25,
                          borderRadius: '0 0 0 8px',
                          fontSize: '0.72rem',
                          fontWeight: 'bold',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.5
                        }}>
                          <Iconify icon="solar:check-circle-bold" sx={{ fontSize: 13 }} />
                          已穿戴
                        </Box>
                      )}
                      {!isUnlocked && (
                        <Box sx={{
                          position: 'absolute',
                          top: 0,
                          right: 0,
                          bgcolor: 'rgba(255,255,255,0.08)',
                          color: 'text.secondary',
                          px: 1.5,
                          py: 0.25,
                          borderRadius: '0 0 0 8px',
                          fontSize: '0.72rem',
                          fontWeight: 'bold',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 0.5
                        }}>
                          <Iconify icon="solar:shield-keyhole-bold-duotone" sx={{ fontSize: 13 }} />
                          未解鎖
                        </Box>
                      )}

                      <Stack direction="row" spacing={2.5} alignItems="center">
                        <Box sx={{
                          fontSize: 38,
                          filter: isUnlocked ? 'none' : 'grayscale(1) opacity(0.3)',
                          bgcolor: isEquipped ? 'rgba(124,193,74,0.1)' : 'rgba(255,255,255,0.04)',
                          p: 1.5,
                          borderRadius: 2,
                          border: '1px solid',
                          borderColor: isEquipped ? '#7cc14a' : 'rgba(255,255,255,0.08)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 60,
                          height: 60
                        }}>
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
                                <Iconify icon="solar:verified-check-bold" sx={{ fontSize: 12 }} />
                                已解鎖
                              </>
                            ) : (
                              <>
                                <Iconify icon="solar:clock-circle-bold" sx={{ fontSize: 12 }} />
                                需要達 Lv.{c.levelRequired} 級
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
      </DialogContent>

      <Box sx={{ p: 2, display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <Button variant="outlined" color="inherit" onClick={onClose} sx={{ fontWeight: 'bold' }}>
          關閉 Lab 視窗
        </Button>
      </Box>
    </Dialog>
  );
}
