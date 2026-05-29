import { useState, useEffect, useCallback } from 'react'

import Box       from '@mui/material/Box'
import Stack     from '@mui/material/Stack'
import Avatar    from '@mui/material/Avatar'
import Button    from '@mui/material/Button'
import Dialog    from '@mui/material/Dialog'
import Typography from '@mui/material/Typography'
import DialogContent from '@mui/material/DialogContent'

import { LOOTBOX_PRICE } from 'src/lib/pepefi/items'
import { PEPE_SKINS, PepeSkin } from 'src/components/pepefi/pepeSkinsData'

const RARITY_COLOR: Record<string, string> = {
  Common:    '#7cc14a',
  Rare:      '#00b0ff',
  Epic:      '#b200ff',
  Legendary: '#ff3d00',
}

interface Props {
  pepeBalance: bigint | null
  onBurn: (amount: number) => Promise<void>
  address?: string | null
}

export function LootBoxButton({ pepeBalance, onBurn, address }: Props) {
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<PepeSkin | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  
  // Custom Skins Gachapon state
  const [unlockedSkins, setUnlockedSkins] = useState<string[]>(['none'])
  const [latestSkin, setLatestSkin] = useState<PepeSkin | null>(null)

  // Load unlocked skins from localStorage on mount and when open changes
  useEffect(() => {
    try {
      const savedUnl = localStorage.getItem('pepefi:gamefi:unlocked_skins')
      const savedAsk = localStorage.getItem('pepefi:gamefi:active_skin')
      
      if (savedUnl) {
        setUnlockedSkins(JSON.parse(savedUnl))
      }
      
      // If active skin is one of our custom skins, make it the latest shown skin
      if (savedAsk && savedAsk.startsWith('/skins/')) {
        const found = PEPE_SKINS.find(s => s.imagePath === savedAsk)
        if (found) setLatestSkin(found)
      }
    } catch (e) { /* fallback */ }
  }, [])

  const pepeNum = pepeBalance !== null ? Number(pepeBalance) / 1e18 : null
  const canAfford = pepeNum !== null && pepeNum >= LOOTBOX_PRICE

  const handleOpen = useCallback(async () => {
    if (loading || !canAfford) return
    setLoading(true)
    try {
      // 1. Burn PEPE tokens on-chain
      await onBurn(LOOTBOX_PRICE)
      
      // 2. Load latest unlocked skins state
      const savedUnl = localStorage.getItem('pepefi:gamefi:unlocked_skins')
      const currentUnlocked: string[] = savedUnl ? JSON.parse(savedUnl) : ['none']

      // Find locked skins (excluding 'none')
      const lockedSkins = PEPE_SKINS.filter(s => !currentUnlocked.includes(s.id))
      
      let chosenSkin: PepeSkin
      if (lockedSkins.length === 0) {
        // All skins unlocked, draw a random one from the list
        chosenSkin = PEPE_SKINS[Math.floor(Math.random() * PEPE_SKINS.length)]
      } else {
        // Weighted Rarity selection (Legendary: 5%, Epic: 15%, Rare: 30%, Common: 50%)
        const rand = Math.floor(Math.random() * 100)
        let selectedRarity: 'Common' | 'Rare' | 'Epic' | 'Legendary' = 'Common'
        if (rand < 5) selectedRarity = 'Legendary'
        else if (rand < 20) selectedRarity = 'Epic'
        else if (rand < 50) selectedRarity = 'Rare'

        let candidates = lockedSkins.filter(s => s.rarity === selectedRarity)
        if (candidates.length === 0) {
          candidates = lockedSkins
        }
        chosenSkin = candidates[Math.floor(Math.random() * candidates.length)]
      }

      // 3. Save new unlocked skins to storage
      const newUnlocked = currentUnlocked.includes(chosenSkin.id)
        ? currentUnlocked
        : [...currentUnlocked, chosenSkin.id]
      
      localStorage.setItem('pepefi:gamefi:unlocked_skins', JSON.stringify(newUnlocked))
      setUnlockedSkins(newUnlocked)
      
      // 4. Set result & open congratulations dialog
      setResult(chosenSkin)
      setLatestSkin(chosenSkin)
      setDialogOpen(true)
    } catch (e) {
      console.error('Failed to draw chest:', e)
    } finally {
      setLoading(false)
    }
  }, [loading, canAfford, onBurn, unlockedSkins])

  const equipSkin = (skinPath: string) => {
    localStorage.setItem('pepefi:gamefi:active_skin', skinPath)
    localStorage.setItem('pepefi:gamefi:active_clothes', 'custom_skin')
    
    // Save to standard user avatar store so all PepeAvatars sync instantly
    const userAddress = address || 'mock_user'
    try {
      localStorage.setItem(`pepeAvatar_${userAddress.toLowerCase()}`, skinPath)
    } catch (e) { /* fallback */ }

    // Dispatch global event
    window.dispatchEvent(new CustomEvent('pepefi:gamefi-updated'))
    alert('造型更換成功！已應用至全站頭像 ✓')
  }

  const getRarityColor = (rarity: string) => RARITY_COLOR[rarity] || '#7cc14a'

  return (
    <>
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
          0% { box-shadow: 0 0 10px rgba(156,39,176,0.3); }
          100% { box-shadow: 0 0 25px rgba(156,39,176,0.7); }
        }
        @keyframes bounceIn {
          0% { transform: scale(0.3); opacity: 0; }
          50% { transform: scale(1.05); opacity: 0.8; }
          70% { transform: scale(0.9); opacity: 0.9; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}} />

      <Box sx={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 3,
        mt: 1.5,
        p: 2,
        bgcolor: 'rgba(0,0,0,0.15)',
        borderRadius: 2.5,
        border: '1px solid rgba(156, 39, 176, 0.15)',
        width: '100%',
        minHeight: 180
      }}>
        {/* Left Side: Mystery Chest / 🎁 */}
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
          <Box
            className={loading ? 'egg-shaking' : ''}
            sx={{
              fontSize: 56,
              filter: canAfford ? 'none' : 'grayscale(1) opacity(0.4)',
              transition: 'transform 0.2s',
              cursor: canAfford ? 'pointer' : 'not-allowed',
              animation: loading ? 'shakeEgg 0.4s infinite' : 'pulseGlow 2s infinite alternate',
              borderRadius: '50%',
              p: 0.5,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              '&:hover': canAfford ? { transform: 'scale(1.08) rotate(-5deg)' } : {},
            }}
            onClick={handleOpen}
          >
            🎁
          </Box>
          <Button
            variant="contained"
            disabled={loading || !canAfford}
            sx={{
              bgcolor: '#9c27b0',
              color: '#fff',
              fontWeight: 900,
              px: 2,
              py: 0.75,
              textTransform: 'none',
              fontSize: '0.85rem',
              '&:hover': { bgcolor: '#7b1fa2' },
              '&:disabled': { opacity: 0.4 }
            }}
            onClick={handleOpen}
          >
            {loading ? '開箱中…' : `開寶箱 (${LOOTBOX_PRICE.toLocaleString()} PEPE)`}
          </Button>
          {!canAfford && (
            <Typography variant="caption" color="text.secondary">
              需要 {LOOTBOX_PRICE.toLocaleString()} PEPE
            </Typography>
          )}
        </Box>

        {/* Right Side: Drawn Custom Skin Preview (顯示在旁邊) */}
        {latestSkin ? (
          <Box sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            p: 1.5,
            border: `2px solid ${getRarityColor(latestSkin.rarity)}`,
            borderRadius: 2,
            bgcolor: 'rgba(255,255,255,0.02)',
            boxShadow: `0 0 15px ${getRarityColor(latestSkin.rarity)}25`,
            width: 120,
            animation: 'bounceIn 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)'
          }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', fontWeight: 'bold', mb: 0.75, fontSize: '0.68rem' }}>
              🎁 抽中造型
            </Typography>
            <Avatar
              src={latestSkin.imagePath}
              sx={{
                width: 60,
                height: 60,
                border: `2px solid ${getRarityColor(latestSkin.rarity)}`,
                boxShadow: `0 0 10px ${getRarityColor(latestSkin.rarity)}40`
              }}
            />
            <Typography
              variant="caption"
              sx={{
                fontWeight: '900',
                mt: 0.75,
                color: getRarityColor(latestSkin.rarity),
                textOverflow: 'ellipsis',
                overflow: 'hidden',
                whiteSpace: 'nowrap',
                width: '100%',
                textAlign: 'center',
                fontSize: '0.72rem'
              }}
              title={latestSkin.name}
            >
              {latestSkin.name}
            </Typography>
            <Button
              size="small"
              variant="contained"
              onClick={() => equipSkin(latestSkin.imagePath)}
              sx={{
                mt: 1,
                fontSize: '0.62rem',
                py: 0.25,
                px: 1,
                minWidth: 0,
                width: '100%',
                bgcolor: '#7cc14a',
                color: '#000',
                fontWeight: '900',
                '&:hover': { bgcolor: '#94d862' }
              }}
            >
              穿戴此造型
            </Button>
          </Box>
        ) : (
          <Box sx={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            p: 2,
            border: '1px dashed rgba(255, 255, 255, 0.08)',
            borderRadius: 2,
            width: 120,
            height: 140,
            textAlign: 'center'
          }}>
            <Typography variant="caption" color="text.disabled" sx={{ fontSize: '0.68rem', lineHeight: 1.4 }}>
              🎁<br/>開啟寶箱後<br/>造型將在此顯示
            </Typography>
          </Box>
        )}
      </Box>

      {/* Result dialog */}
      <Dialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        PaperProps={{
          sx: {
            bgcolor: '#070f19',
            border: `2px solid ${result ? getRarityColor(result.rarity) : '#7cc14a'}`,
            borderRadius: 3.5,
            textAlign: 'center',
            maxWidth: 380,
            p: 3,
            overflow: 'hidden'
          }
        }}
      >
        <DialogContent sx={{ py: 2, position: 'relative' }}>
          {/* rotating background burst */}
          <Box sx={{
            position: 'absolute', top: -80, left: -80, right: -80, bottom: -80,
            backgroundImage: 'radial-gradient(circle, rgba(255,255,255,0.08) 0%, transparent 60%)',
            animation: 'shakeEgg 20s linear infinite',
            zIndex: 0,
            pointerEvents: 'none'
          }} />

          <Typography variant="h4" sx={{ fontWeight: '900', color: '#ffb300', mb: 1, position: 'relative', zIndex: 1 }}>
            恭喜獲得！🎉
          </Typography>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 3, position: 'relative', zIndex: 1 }}>
            您已成功開啟寶箱，孵化出全新佩佩蛙造型！
          </Typography>

          {result && (
            <Box sx={{ position: 'relative', zIndex: 1 }}>
              <Box sx={{
                width: 160,
                height: 160,
                mx: 'auto',
                mb: 2,
                border: `3px solid ${getRarityColor(result.rarity)}`,
                boxShadow: `0 0 20px ${getRarityColor(result.rarity)}`,
                borderRadius: 2,
                overflow: 'hidden'
              }}>
                <img src={result.imagePath} alt={result.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              </Box>

              <Typography fontWeight={900} fontSize={18} sx={{ color: getRarityColor(result.rarity) }}>
                {result.emoji} {result.name}
              </Typography>
              
              <Box sx={{ my: 1 }}>
                <Box sx={{ px: 1.5, py: 0.25, bgcolor: `${getRarityColor(result.rarity)}20`, color: getRarityColor(result.rarity), border: `1px solid ${getRarityColor(result.rarity)}30`, borderRadius: 1, fontSize: '0.7rem', fontWeight: 'bold', display: 'inline-block' }}>
                  稀有度: {result.rarity}
                </Box>
              </Box>

              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1, mb: 3, lineHeight: 1.5 }}>
                {result.desc}
              </Typography>
              
              <Stack direction="row" spacing={1.5}>
                <Button
                  variant="contained"
                  fullWidth
                  onClick={() => {
                    equipSkin(result.imagePath)
                    setDialogOpen(false)
                  }}
                  sx={{ bgcolor: '#7cc14a', color: '#000', fontWeight: '900', '&:hover': { bgcolor: '#94d862' } }}
                >
                  👕 立即穿戴造型
                </Button>
                <Button
                  variant="outlined"
                  color="inherit"
                  fullWidth
                  onClick={() => setDialogOpen(false)}
                  sx={{ fontWeight: 'bold' }}
                >
                  關閉
                </Button>
              </Stack>
            </Box>
          )}
        </DialogContent>
      </Dialog>
    </>
  )
}
