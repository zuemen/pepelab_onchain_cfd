import type { ShopItem } from 'src/lib/pepefi/items'

import { useState, useCallback } from 'react'

import Box       from '@mui/material/Box'
import Button    from '@mui/material/Button'
import Dialog    from '@mui/material/Dialog'
import Typography from '@mui/material/Typography'
import DialogContent from '@mui/material/DialogContent'

import { LOOTBOX_PRICE } from 'src/lib/pepefi/items'
import { rollLootbox }   from 'src/lib/pepefi/inventory'

const RARITY_COLOR: Record<string, string> = {
  common:    '#9e9e9e',
  rare:      '#2196f3',
  epic:      '#9c27b0',
  legendary: '#ff9800',
}

interface Props {
  pepeBalance: bigint | null
  onBurn: (amount: number) => Promise<void>
}

export function LootBoxButton({ pepeBalance, onBurn }: Props) {
  const [loading, setLoading]   = useState(false)
  const [result, setResult]     = useState<ShopItem | null>(null)
  const [dialogOpen, setDialog] = useState(false)

  const pepeNum = pepeBalance !== null ? Number(pepeBalance) / 1e18 : null
  const canAfford = pepeNum !== null && pepeNum >= LOOTBOX_PRICE

  const handleOpen = useCallback(async () => {
    if (loading || !canAfford) return
    setLoading(true)
    try {
      await onBurn(LOOTBOX_PRICE)
      const item = rollLootbox()
      setResult(item)
      setDialog(true)
    } catch {
      /* tx rejected */
    } finally {
      setLoading(false)
    }
  }, [loading, canAfford, onBurn])

  return (
    <>
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
        <Box sx={{
          fontSize: 56,
          filter: canAfford ? 'none' : 'grayscale(1) opacity(0.4)',
          transition: 'transform 0.2s',
          cursor: canAfford ? 'pointer' : 'not-allowed',
          '&:hover': canAfford ? { transform: 'scale(1.08) rotate(-5deg)' } : {},
        }} onClick={handleOpen}>
          🎁
        </Box>
        <Button variant="contained" disabled={loading || !canAfford}
          sx={{ bgcolor: '#9c27b0', color: '#fff', fontWeight: 900, '&:hover': { bgcolor: '#7b1fa2' }, '&:disabled': { opacity: 0.4 } }}
          onClick={handleOpen}>
          {loading ? '開箱中…' : `開寶箱 (${LOOTBOX_PRICE.toLocaleString()} PEPE)`}
        </Button>
        {!canAfford && (
          <Typography variant="caption" color="text.secondary">
            需要 {LOOTBOX_PRICE.toLocaleString()} PEPE
          </Typography>
        )}
      </Box>

      {/* Result dialog */}
      <Dialog open={dialogOpen} onClose={() => setDialog(false)}
        PaperProps={{ sx: { bgcolor: '#0e1420', border: '2px solid', borderColor: result ? RARITY_COLOR[result.rarity] : '#7cc14a', borderRadius: 3, textAlign: 'center', minWidth: 280 } }}>
        <DialogContent sx={{ py: 4 }}>
          <Typography variant="h4" sx={{ mb: 1 }}>恭喜！</Typography>
          {result && (
            <>
              <Typography fontSize={72}>{result.emoji}</Typography>
              <Typography fontWeight={900} fontSize={20} sx={{ mt: 1 }}>{result.name}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>{result.desc}</Typography>
              <Typography fontWeight={800} sx={{ color: RARITY_COLOR[result.rarity], mt: 1, textTransform: 'uppercase', letterSpacing: 2 }}>
                {result.rarity}
              </Typography>
            </>
          )}
          <Button variant="contained" sx={{ mt: 3, bgcolor: '#7cc14a', color: '#0e1420', fontWeight: 900 }}
            onClick={() => setDialog(false)}>
            太棒了！
          </Button>
        </DialogContent>
      </Dialog>
    </>
  )
}
