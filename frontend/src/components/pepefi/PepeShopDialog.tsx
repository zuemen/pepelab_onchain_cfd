import type { ShopItem } from 'src/lib/pepefi/items'

import { useState, useCallback } from 'react'

import Box          from '@mui/material/Box'
import Chip         from '@mui/material/Chip'
import Dialog       from '@mui/material/Dialog'
import Button       from '@mui/material/Button'
import Tooltip      from '@mui/material/Tooltip'
import Divider      from '@mui/material/Divider'
import Typography   from '@mui/material/Typography'
import DialogTitle  from '@mui/material/DialogTitle'
import DialogContent from '@mui/material/DialogContent'

import { ITEMS }                        from 'src/lib/pepefi/items'
import { addToInventory, getInventory, equipItem, getEquipped } from 'src/lib/pepefi/inventory'

type Category = 'all' | 'hat' | 'bg' | 'accessory' | 'frame'

const RARITY_COLOR: Record<string, string> = {
  common:    '#9e9e9e',
  rare:      '#2196f3',
  epic:      '#9c27b0',
  legendary: '#ff9800',
}

interface Props {
  open:    boolean
  onClose: () => void
  pepeBalance: bigint | null
  onBuy: (item: ShopItem, price: number) => Promise<void>
}

export function PepeShopDialog({ open, onClose, pepeBalance, onBuy }: Props) {
  const [tab, setTab]       = useState<Category>('all')
  const [buying, setBuying] = useState<string | null>(null)
  const [inv, setInv]       = useState<string[]>(() => getInventory())
  const [eq, setEq]         = useState<Record<string, string>>(() => getEquipped())

  const filtered = tab === 'all' ? ITEMS : ITEMS.filter(i => i.category === tab)

  const handleBuy = useCallback(async (item: ShopItem) => {
    if (buying) return
    setBuying(item.id)
    try {
      await onBuy(item, item.price)
      addToInventory(item.id)
      setInv(getInventory())
    } catch {
      /* tx rejected or failed — ignore */
    } finally {
      setBuying(null)
    }
  }, [buying, onBuy])

  const handleEquip = useCallback((item: ShopItem) => {
    equipItem(item)
    setEq(getEquipped())
  }, [])

  const pepeNum = pepeBalance !== null ? Number(pepeBalance) / 1e18 : null

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth
      PaperProps={{ sx: { bgcolor: '#0e1420', border: '1px solid #7cc14a44', borderRadius: 3 } }}>
      <DialogTitle sx={{ color: '#7cc14a', fontWeight: 900, fontSize: 22, pb: 0 }}>
        🛒 Pepe Shop
        {pepeNum !== null && (
          <Typography component="span" variant="body2" sx={{ ml: 2, color: 'text.secondary' }}>
            餘額：{pepeNum.toLocaleString(undefined, { maximumFractionDigits: 0 })} PEPE
          </Typography>
        )}
      </DialogTitle>

      <DialogContent sx={{ pt: 1 }}>
        {/* Category tabs */}
        <Box sx={{ display: 'flex', gap: 1, mb: 2, flexWrap: 'wrap' }}>
          {(['all', 'hat', 'bg', 'accessory', 'frame'] as Category[]).map(c => (
            <Chip key={c} label={c === 'all' ? '全部' : c === 'hat' ? '帽子' : c === 'bg' ? '背景' : c === 'accessory' ? '配件' : '邊框'}
              onClick={() => setTab(c)}
              sx={{
                fontWeight: 700,
                bgcolor: tab === c ? '#7cc14a' : 'transparent',
                color:   tab === c ? '#0e1420' : '#7cc14a',
                border:  '1px solid #7cc14a55',
                cursor:  'pointer',
              }} />
          ))}
        </Box>

        <Divider sx={{ borderColor: '#7cc14a22', mb: 2 }} />

        {/* Item grid */}
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 2 }}>
          {filtered.map(item => {
            const owned    = inv.includes(item.id)
            const equipped = eq[item.category] === item.id
            const isBuying = buying === item.id
            return (
              <Box key={item.id} sx={{
                bgcolor: '#161f2e',
                border:  `2px solid ${equipped ? '#7cc14a' : RARITY_COLOR[item.rarity] + '55'}`,
                borderRadius: 2,
                p: 1.5,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 0.5,
                position: 'relative',
                transition: 'border-color 0.2s',
                '&:hover': { borderColor: RARITY_COLOR[item.rarity] },
              }}>
                {equipped && (
                  <Chip label="裝備中" size="small"
                    sx={{ position: 'absolute', top: 6, right: 6, bgcolor: '#7cc14a', color: '#0e1420', fontWeight: 700, fontSize: 10, height: 18, px: 0.5 }} />
                )}
                <Typography fontSize={36}>{item.emoji}</Typography>
                <Typography fontWeight={800} fontSize={13} textAlign="center">{item.name}</Typography>
                <Tooltip title={item.desc}>
                  <Typography variant="caption" color="text.secondary" textAlign="center" noWrap sx={{ maxWidth: '100%' }}>
                    {item.desc}
                  </Typography>
                </Tooltip>
                <Chip label={item.rarity} size="small"
                  sx={{ bgcolor: RARITY_COLOR[item.rarity] + '33', color: RARITY_COLOR[item.rarity], fontWeight: 700, fontSize: 10, mt: 0.5 }} />
                <Typography fontWeight={900} fontSize={13} sx={{ color: '#7cc14a', mt: 0.5 }}>
                  {item.price.toLocaleString()} PEPE
                </Typography>

                {owned ? (
                  <Button size="small" variant={equipped ? 'outlined' : 'contained'} fullWidth
                    sx={{ mt: 0.5, fontSize: 11, py: 0.4, bgcolor: equipped ? 'transparent' : '#7cc14a', color: equipped ? '#7cc14a' : '#0e1420', borderColor: '#7cc14a' }}
                    onClick={() => equipped ? undefined : handleEquip(item)}>
                    {equipped ? '已裝備' : '裝備'}
                  </Button>
                ) : (
                  <Button size="small" variant="contained" fullWidth disabled={isBuying || pepeNum === null || pepeNum < item.price}
                    sx={{ mt: 0.5, fontSize: 11, py: 0.4, bgcolor: '#7cc14a', color: '#0e1420', '&:disabled': { opacity: 0.4 } }}
                    onClick={() => handleBuy(item)}>
                    {isBuying ? '購買中…' : '購買'}
                  </Button>
                )}
              </Box>
            )
          })}
        </Box>
      </DialogContent>
    </Dialog>
  )
}
