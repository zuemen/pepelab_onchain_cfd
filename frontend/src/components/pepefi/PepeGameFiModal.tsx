import React, { useState, useEffect } from 'react';

import Tab from '@mui/material/Tab';
import Box from '@mui/material/Box';
import Tabs from '@mui/material/Tabs';
import Grid from '@mui/material/Grid';
import Card from '@mui/material/Card';
import Alert from '@mui/material/Alert';
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

interface PepeAvatarOption {
  id: string;
  name: string;
  url: string;
  rarity: 'Common' | 'Rare' | 'Epic' | 'Legendary';
  unlocked: boolean;
}

const DEFAULT_AVATARS: PepeAvatarOption[] = [
  { id: '1', name: 'Original Pepe', url: '/avatars/pepe-01.png', rarity: 'Common', unlocked: true },
  { id: '2', name: 'Eth Pepe', url: '/assets/images/pepefi/pepe_eth.jpg', rarity: 'Common', unlocked: true },
  { id: '3', name: 'Trader Pepe', url: '/avatars/pepe-01.png', rarity: 'Common', unlocked: true },
  { id: '4', name: 'Gold Pepe', url: '/avatars/pepe-01.png', rarity: 'Rare', unlocked: true },
  { id: '5', name: 'Rocket Pepe', url: '/avatars/pepe-01.png', rarity: 'Rare', unlocked: true },
  { id: '6', name: 'Wizard Frog', url: '/avatars/pepe-01.png', rarity: 'Rare', unlocked: true },
];

const POTIONS = [
  { id: 'green', name: 'Pepe Green Juice (綠色蛙汁)', desc: '讓你的 Pepe 眼睛發光，經驗值 +50 XP！', cost: 100, xp: 50, color: '#4caf50', emoji: '🧪' },
  { id: 'gold', name: 'Golden Elixir (黃金仙露)', desc: '解鎖奢華黃金配飾，經驗值 +150 XP！', cost: 300, xp: 150, color: '#ffd700', emoji: '🍶' },
  { id: 'moon', name: 'Moon Potion (登月藥水)', desc: '獲得登月火箭背包，直接獲得 +500 XP！', cost: 800, xp: 500, color: '#2196f3', emoji: '🚀' },
];

const CLOTHES = [
  { id: 'none', name: 'Original Look (經典皮膚)', cost: 0, levelRequired: 1, emoji: '🐸' },
  { id: 'suit', name: 'Merchant Suit (明星交易員西裝)', cost: 200, levelRequired: 5, emoji: '👔' },
  { id: 'cape', name: 'Royal Cape (黃金國王披風)', cost: 500, levelRequired: 15, emoji: '👑' },
  { id: 'astronaut', name: 'Astronaut Suit (登月太空衣)', cost: 1000, levelRequired: 30, emoji: '👨‍🚀' },
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
  defaultTab?: 'breed' | 'potions' | 'wardrobe';
}

export default function PepeGameFiModal({ open, onClose, defaultTab = 'breed' }: PepeGameFiModalProps) {
  const [tabValue, setTabValue] = useState<'breed' | 'potions' | 'wardrobe'>('breed');

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
  const [avatars, setAvatars] = useState<PepeAvatarOption[]>(DEFAULT_AVATARS);

  // Load from storage
  useEffect(() => {
    try {
      const savedBal = localStorage.getItem('pepefi:gamefi:balance');
      const savedXp  = localStorage.getItem('pepefi:gamefi:xp');
      const savedLvl = localStorage.getItem('pepefi:gamefi:level');
      const savedClo = localStorage.getItem('pepefi:gamefi:active_clothes');
      const savedAvs = localStorage.getItem('pepefi:gamefi:avatars');

      if (savedBal) setPepeBal(Number(savedBal));
      if (savedXp)  setXp(Number(savedXp));
      if (savedLvl) setLevel(Number(savedLvl));
      if (savedClo) setActiveClothes(savedClo);
      if (savedAvs) setAvatars(JSON.parse(savedAvs));
    } catch (e) { /* fallback to defaults */ }
  }, [open]);

  // Save to storage
  const saveState = (newBal: number, newXp: number, newLvl: number, newClo: string, newAvs?: PepeAvatarOption[]) => {
    localStorage.setItem('pepefi:gamefi:balance', newBal.toString());
    localStorage.setItem('pepefi:gamefi:xp', newXp.toString());
    localStorage.setItem('pepefi:gamefi:level', newLvl.toString());
    localStorage.setItem('pepefi:gamefi:active_clothes', newClo);
    if (newAvs) localStorage.setItem('pepefi:gamefi:avatars', JSON.stringify(newAvs));

    setPepeBal(newBal);
    setXp(newXp);
    setLevel(newLvl);
    setActiveClothes(newClo);
    if (newAvs) setAvatars(newAvs);

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

  // ── Breeding Logic ───────────────────────────────────────────────────────────
  const [parent1, setParent1] = useState<string | null>(null);
  const [parent2, setParent2] = useState<string | null>(null);
  const [isBreeding, setIsBreeding] = useState(false);
  const [hatchedPepe, setHatchedPepe] = useState<PepeAvatarOption | null>(null);

  const handleBreed = () => {
    if (!parent1 || !parent2) return;
    if (parent1 === parent2) {
      alert('請選擇兩個不同的 Pepe 進行繁育！');
      return;
    }
    if (pepeBal < 200) {
      alert('繁育需要消耗 200 PEPE！');
      return;
    }

    setIsBreeding(true);
    setHatchedPepe(null);

    setTimeout(() => {
      setIsBreeding(false);
      // Hatch custom Pepe!
      const p1 = avatars.find(a => a.id === parent1);
      const p2 = avatars.find(a => a.id === parent2);
      const randomNames = ['Cyber Overlord Pepe 🦾', 'Gold Emperor Pepe 👑', 'Ether Cosmic Frog 🌌', 'Diamond Chad Pepe 💎'];
      const randomUrls  = [
        '/assets/images/pepefi/pepe_eth.jpg',
        '/avatars/pepe-01.png',
      ];
      const name = randomNames[Math.floor(Math.random() * randomNames.length)];
      const url  = randomUrls[Math.floor(Math.random() * randomUrls.length)];
      const newPepe: PepeAvatarOption = {
        id: (avatars.length + 1).toString(),
        name,
        url,
        rarity: 'Legendary',
        unlocked: true,
      };

      const nextAvs = [...avatars, newPepe];
      saveState(pepeBal - 200, xp, level, activeClothes, nextAvs);
      setHatchedPepe(newPepe);
      setParent1(null);
      setParent2(null);
    }, 2500); // 2.5s incubating animation
  };

  // ── Wardrobe Logic ───────────────────────────────────────────────────────────

  const equipClothes = (clothId: string, levelReq: number) => {
    if (level < levelReq) {
      alert(`此服裝需要 Pepe 等級達 Lv.${levelReq} 才能解鎖！`);
      return;
    }
    saveState(pepeBal, xp, level, clothId);
  };

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
              DeFi · SocialFi · GameFi · MemeFi 一體化娛樂中心
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
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>等級 Title</Typography>
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
            💰 我的代幣: {pepeBal.toLocaleString()} PEPE
          </Typography>
        </Box>
      </Box>

      <Tabs value={tabValue} onChange={(_, nv) => setTabValue(nv)} centered indicatorColor="custom" sx={{ borderBottom: '1px solid rgba(255,255,255,0.06)', '& .MuiTab-root': { color: 'text.secondary', fontWeight: 'bold', fontSize: '1rem', '&.Mui-selected': { color: '#7cc14a' } } }}>
        <Tab value="breed" label="🧬 佩佩繁育孵化室 (Breeding Lab)" />
        <Tab value="potions" label="🧪 魔法藥水商店 (Potion Shop)" />
        <Tab value="wardrobe" label="👕 衣櫥與尊貴衣裝 (Wardrobe)" />
      </Tabs>

      <DialogContent sx={{ minHeight: 400, py: 3 }}>
        {/* A. BREEDING TAB */}
        {tabValue === 'breed' && (
          <Box sx={{ textAlign: 'center' }}>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 2 }}>
              🧬 融合兩隻佩佩蛙，孵化出更高等級、更炫酷的傳奇 Pepe！
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 3 }}>
              每次繁育需消耗 200 PEPE 代幣。新一代 Pepe 將解鎖獨一無二的超稀有屬性！
            </Typography>

            {isBreeding ? (
              <Box sx={{ py: 6 }}>
                <Box
                  component="span"
                  sx={{
                    display: 'inline-block',
                    fontSize: 80,
                    animation: 'shake 0.5s ease-in-out infinite',
                    '@keyframes shake': {
                      '0%, 100%': { transform: 'rotate(-8deg) scale(1)' },
                      '50%': { transform: 'rotate(8deg) scale(1.1)' }
                    }
                  }}
                >
                  🥚
                </Box>
                <Typography variant="h6" sx={{ mt: 3, fontWeight: 'bold', color: '#ffd23d' }}>
                  孵化進行中...
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  兩隻基因重組，傳奇生命正在誕生...
                </Typography>
              </Box>
            ) : hatchedPepe ? (
              <Card sx={{ p: 4, maxWidth: 400, mx: 'auto', bgcolor: 'rgba(255,210,61,0.08)', border: '2px dashed #ffd23d', textAlign: 'center' }}>
                <Box sx={{ fontSize: 60, mb: 1 }}>✨🐣✨</Box>
                <Typography variant="h5" sx={{ fontWeight: 900, color: '#ffd23d', mb: 2 }}>
                  恭喜孵化成功！🎉
                </Typography>
                <Avatar src={hatchedPepe.url} sx={{ width: 120, height: 120, mx: 'auto', border: '4px solid #ffd23d', boxShadow: '0 0 20px rgba(255,210,61,0.5)', mb: 2 }} />
                <Typography variant="subtitle1" sx={{ fontWeight: 'bold' }}>
                  {hatchedPepe.name}
                </Typography>
                <Typography variant="caption" sx={{ color: '#ffd23d', bgcolor: 'rgba(255,210,61,0.2)', px: 1.5, py: 0.5, borderRadius: 1, display: 'inline-block', mt: 1, fontWeight: 'bold' }}>
                  等級: {hatchedPepe.rarity}
                </Typography>
                <Button variant="outlined" color="warning" fullWidth sx={{ mt: 3 }} onClick={() => setHatchedPepe(null)}>
                  太棒了，繼續！
                </Button>
              </Card>
            ) : (
              <Grid container spacing={3} alignItems="center" justifyContent="center">
                {/* Parent 1 */}
                <Grid size={{ xs: 12, sm: 5 }}>
                  <Card sx={{ p: 3, border: '1px solid', borderColor: parent1 ? '#7cc14a' : 'rgba(255,255,255,0.08)', bgcolor: 'rgba(255,255,255,0.02)' }}>
                    <Typography variant="subtitle2" sx={{ mb: 2, color: parent1 ? '#7cc14a' : 'text.primary' }}>
                      {parent1 ? '✓ 父本 Pepe 已選擇' : '選擇父本 Pepe 🧬'}
                    </Typography>
                    <Grid container spacing={1}>
                      {avatars.map(av => (
                        <Grid size={{ xs: 4 }} key={av.id}>
                          <IconButton onClick={() => setParent1(av.id)} sx={{ border: parent1 === av.id ? '2px solid #7cc14a' : '2px solid transparent', p: 0.5 }}>
                            <Avatar src={av.url} />
                          </IconButton>
                        </Grid>
                      ))}
                    </Grid>
                  </Card>
                </Grid>

                <Grid size={{ xs: 12, sm: 2 }}>
                  <Typography variant="h3" sx={{ color: 'rgba(255,255,255,0.3)' }}>+</Typography>
                </Grid>

                {/* Parent 2 */}
                <Grid size={{ xs: 12, sm: 5 }}>
                  <Card sx={{ p: 3, border: '1px solid', borderColor: parent2 ? '#7cc14a' : 'rgba(255,255,255,0.08)', bgcolor: 'rgba(255,255,255,0.02)' }}>
                    <Typography variant="subtitle2" sx={{ mb: 2, color: parent2 ? '#7cc14a' : 'text.primary' }}>
                      {parent2 ? '✓ 母本 Pepe 已選擇' : '選擇母本 Pepe 🧬'}
                    </Typography>
                    <Grid container spacing={1}>
                      {avatars.map(av => (
                        <Grid size={{ xs: 4 }} key={av.id}>
                          <IconButton onClick={() => setParent2(av.id)} sx={{ border: parent2 === av.id ? '2px solid #7cc14a' : '2px solid transparent', p: 0.5 }}>
                            <Avatar src={av.url} />
                          </IconButton>
                        </Grid>
                      ))}
                    </Grid>
                  </Card>
                </Grid>

                <Grid size={{ xs: 12 }}>
                  <Button variant="contained" size="large" disabled={!parent1 || !parent2 || parent1 === parent2} onClick={handleBreed} sx={{ bgcolor: '#7cc14a', color: '#fff', fontWeight: 'bold', py: 1.5, px: 6, fontSize: '1.1rem', '&:hover': { bgcolor: '#5a9e2f' } }}>
                    🔥 開始繁育孵化 (花費 200 PEPE)
                  </Button>
                </Grid>
              </Grid>
            )}
          </Box>
        )}

        {/* B. POTION SHOP TAB */}
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

        {/* C. WARDROBE TAB */}
        {tabValue === 'wardrobe' && (
          <Box>
            <Typography variant="subtitle1" sx={{ fontWeight: 'bold', mb: 3, textAlign: 'center' }}>
              👕 穿戴您解鎖的華麗衣裝！隨著等級提升解鎖更酷炫的配飾：
            </Typography>
            <Grid container spacing={3}>
              {CLOTHES.map(c => {
                const isUnlocked = level >= c.levelRequired;
                const isEquipped = activeClothes === c.id;
                return (
                  <Grid size={{ xs: 12, sm: 6 }} key={c.id}>
                    <Card sx={{ p: 3, border: '1px solid', borderColor: isEquipped ? '#7cc14a' : 'rgba(255,255,255,0.08)', bgcolor: 'rgba(255,255,255,0.02)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <Stack direction="row" spacing={2} alignItems="center">
                        <Box sx={{ fontSize: 36 }}>{c.emoji}</Box>
                        <Box>
                          <Typography variant="subtitle2" sx={{ fontWeight: 'bold' }}>{c.name}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {isUnlocked ? '✓ 已經解鎖' : `需要達到等級 Lv.${c.levelRequired} 才能穿著`}
                          </Typography>
                        </Box>
                      </Stack>
                      <Button size="small" variant={isEquipped ? 'contained' : 'outlined'} disabled={!isUnlocked} onClick={() => equipClothes(c.id, c.levelRequired)} sx={{ bgcolor: isEquipped ? '#7cc14a' : 'transparent', color: isEquipped ? '#fff' : '#7cc14a', borderColor: '#7cc14a' }}>
                        {isEquipped ? '已穿戴' : isUnlocked ? '更換服裝' : `Lv.${c.levelRequired} 解鎖`}
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
        <Button variant="outlined" color="inherit" onClick={onClose}>
          關閉
        </Button>
      </Box>
    </Dialog>
  );
}
