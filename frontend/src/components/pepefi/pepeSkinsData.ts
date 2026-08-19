import { t } from 'src/locales';

export interface PepeSkin {
  id: string;
  name: string;
  rarity: 'Common' | 'Rare' | 'Epic' | 'Legendary';
  price: number;
  imagePath: string;
  desc: string;
  emoji: string;
}

/** id 以外全是資料；`name` / `desc` 是顯示字串，住在 catalog。 */
type SkinData = Omit<PepeSkin, 'name' | 'desc'> & { id: keyof typeof t.pepe.skin };

const SKINS: SkinData[] = [
  {
    id: 'skin-01',
    rarity: 'Legendary',
    price: 5000,
    imagePath: '/skins/01_a_digital_illustration_of_pepe_the_frog_depicts_hi.png',
    emoji: '🚀',
  },
  {
    id: 'skin-02',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/02_自信廚師青蛙大師.png',
    emoji: '🍳',
  },
  {
    id: 'skin-03',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/03_忍者蛙戰士.png',
    emoji: '🥷',
  },
  {
    id: 'skin-04',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/04_金光閃閃的時尚蛙王.png',
    emoji: '💎',
  },
  {
    id: 'skin-05',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/05_自信的海盜青蛙隊長.png',
    emoji: '🏴‍☠️',
  },
  {
    id: 'skin-06',
    rarity: 'Legendary',
    price: 5000,
    imagePath: '/skins/06_王者蛙王的魔法肖像.png',
    emoji: '👑',
  },
  {
    id: 'skin-07',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/07_太空蛙戰士.png',
    emoji: '👨‍🚀',
  },
  {
    id: 'skin-08',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/08_未來城市中的機械青蛙.png',
    emoji: '🤖',
  },
  {
    id: 'skin-09',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/09_a_digital_illustration_in_a_semi_realistic_detail.png',
    emoji: '💼',
  },
  {
    id: 'skin-10',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/10_勇敢的青蛙騎士.png',
    emoji: '🛡️',
  },
  {
    id: 'skin-11',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/11_自信的青蛙拳擊手.png',
    emoji: '🥊',
  },
  {
    id: 'skin-12',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/12_酷炫dj蛙的霓虹派對風格.png',
    emoji: '🎧',
  },
  {
    id: 'skin-13',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/13_青蛙維京戰士.png',
    emoji: '🪓',
  },
  {
    id: 'skin-14',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/14_榮耀武士青蛙.png',
    emoji: '⚔️',
  },
  {
    id: 'skin-15',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/15_精英蛙領袖.png',
    emoji: '🎖️',
  },
  {
    id: 'skin-16',
    rarity: 'Legendary',
    price: 5000,
    imagePath: '/skins/16_魔法青蛙巫師.png',
    emoji: '🔮',
  },
  {
    id: 'skin-17',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/17_a_detailed_digital_illustration_features_pepe_the.png',
    emoji: '🕶️',
  },
  {
    id: 'skin-18',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/18_a_high_detail_digital_illustration_character_por.png',
    emoji: '🏹',
  },
  {
    id: 'skin-19',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/19_未來黑客青蛙風格.png',
    emoji: '💻',
  },
  {
    id: 'skin-20',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/20_a_digital_illustration_in_a_detailed_and_vibrant_c.png',
    emoji: '🎨',
  },
  {
    id: 'skin-21',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/21_a_digital_illustration_in_detailed_cartoon_and_fan.png',
    emoji: '🎒',
  },
  {
    id: 'skin-22',
    rarity: 'Legendary',
    price: 5000,
    imagePath: '/skins/22_a_digital_illustration_features_pepe_the_frog_as_a.png',
    emoji: '🦾',
  },
  {
    id: 'skin-23',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/23_a_digital_illustration_in_a_character_splash_art_s.png',
    emoji: '✨',
  },
  {
    id: 'skin-24',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/24_a_stylized_high_detail_fantasy_character_illustra.png',
    emoji: '🍃',
  },
  {
    id: 'skin-25',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/25_a_2d_digital_illustration_showcases_pepe_the_frog.png',
    emoji: '📝',
  },
];

export const PEPE_SKINS: PepeSkin[] = SKINS.map((s) => ({
  ...s,
  name: t.pepe.skin[s.id].name,
  desc: t.pepe.skin[s.id].desc,
}));
