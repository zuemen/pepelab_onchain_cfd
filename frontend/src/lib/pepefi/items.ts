export interface ShopItem {
  id:       string
  name:     string
  desc:     string
  price:    number   // PEPE
  category: 'hat' | 'bg' | 'accessory' | 'frame'
  emoji:    string
  rarity:   'common' | 'rare' | 'epic' | 'legendary'
}

export const ITEMS: ShopItem[] = [
  { id: 'hat_top',     name: '紳士帽',      desc: '經典的紳士禮帽',         price:  100, category: 'hat',       emoji: '🎩', rarity: 'common'    },
  { id: 'hat_crown',   name: '王冠',        desc: 'Pepe 王者之冠',          price:  500, category: 'hat',       emoji: '👑', rarity: 'epic'      },
  { id: 'hat_cap',     name: '棒球帽',      desc: '休閒街頭風',              price:   80, category: 'hat',       emoji: '🧢', rarity: 'common'    },
  { id: 'hat_wizard',  name: '巫師帽',      desc: '鏈上魔法師必備',          price:  300, category: 'hat',       emoji: '🧙', rarity: 'rare'      },
  { id: 'bg_moon',     name: '月球背景',    desc: '直奔月球',                price:  200, category: 'bg',        emoji: '🌙', rarity: 'rare'      },
  { id: 'bg_laser',    name: '雷射眼背景',  desc: '純鏈上能量',              price:  150, category: 'bg',        emoji: '⚡', rarity: 'common'    },
  { id: 'bg_rainbow',  name: '彩虹背景',    desc: '彩虹掛前無迷路',          price:  120, category: 'bg',        emoji: '🌈', rarity: 'common'    },
  { id: 'bg_galaxy',   name: '星系背景',    desc: '宇宙級 Degen',            price:  800, category: 'bg',        emoji: '🌌', rarity: 'legendary' },
  { id: 'acc_pipe',    name: '菸斗',        desc: '老紳士的象徵',             price:   60, category: 'accessory', emoji: '🪈', rarity: 'common'    },
  { id: 'acc_monocle', name: '單眼鏡',      desc: '精英交易者必備',           price:  250, category: 'accessory', emoji: '🧐', rarity: 'rare'      },
  { id: 'acc_dumbbell', name: '啞鈴',       desc: 'Gains only, no pain',    price:   90, category: 'accessory', emoji: '🏋️', rarity: 'common'    },
  { id: 'acc_diamond', name: '鑽石手',      desc: 'Diamond hands forever',  price: 1000, category: 'accessory', emoji: '💎', rarity: 'legendary' },
  { id: 'frame_gold',  name: '金框',        desc: '黃金邊框加持',             price:  400, category: 'frame',     emoji: '🟡', rarity: 'epic'      },
  { id: 'frame_neon',  name: '霓虹框',      desc: 'Web3 夜店風',             price:  350, category: 'frame',     emoji: '🟢', rarity: 'rare'      },
  { id: 'frame_fire',  name: '火焰框',      desc: '燃燒吧，Degen',           price:  600, category: 'frame',     emoji: '🔥', rarity: 'epic'      },
  { id: 'frame_pepe',  name: 'Pepe 神框',   desc: '傳說級稀有框',            price: 2000, category: 'frame',     emoji: '🐸', rarity: 'legendary' },
]

export const LOOTBOX_PRICE = 500   // PEPE
export const BURN_ADDRESS  = '0x000000000000000000000000000000000000dEaD' as const

// Loot box weighted pool: legendary 5%, epic 15%, rare 30%, common 50%
export const LOOTBOX_POOL = [
  ...ITEMS.filter(i => i.rarity === 'common').flatMap(i => Array(50).fill(i.id)),
  ...ITEMS.filter(i => i.rarity === 'rare').flatMap(i => Array(30).fill(i.id)),
  ...ITEMS.filter(i => i.rarity === 'epic').flatMap(i => Array(15).fill(i.id)),
  ...ITEMS.filter(i => i.rarity === 'legendary').flatMap(i => Array(5).fill(i.id)),
] as string[]
