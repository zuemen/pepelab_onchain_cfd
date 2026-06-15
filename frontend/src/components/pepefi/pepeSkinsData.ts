export interface PepeSkin {
  id: string;
  name: string;
  rarity: 'Common' | 'Rare' | 'Epic' | 'Legendary';
  price: number;
  imagePath: string;
  desc: string;
  emoji: string;
}

export const PEPE_SKINS: PepeSkin[] = [
  {
    id: 'skin-01',
    name: '星際太空探索蛙',
    rarity: 'Legendary',
    price: 5000,
    imagePath: '/skins/01_a_digital_illustration_of_pepe_the_frog_depicts_hi.png',
    desc: '穿梭在星際與DeFi虛無之中的高階佩佩探索者，手持雷射光劍，誓將PepeLab推向宇宙深處！',
    emoji: '🚀'
  },
  {
    id: 'skin-02',
    name: '特級廚神青蛙大師',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/02_自信廚師青蛙大師.png',
    desc: '熱愛烹飪美味牛排與嫩葉的佩佩，隨時為大家準備最豐盛的DeFi滿漢全席！',
    emoji: '🍳'
  },
  {
    id: 'skin-03',
    name: '暗影忍者蛙戰士',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/03_忍者蛙戰士.png',
    desc: '潛伏在影子裡的致命忍者，動作快如閃電，能在萬軍叢中毫無痕跡地完成閃兌。',
    emoji: '🥷'
  },
  {
    id: 'skin-04',
    name: '金光閃閃時尚蛙王',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/04_金光閃閃的時尚蛙王.png',
    desc: '戴著金光閃閃大項鍊與復古墨鏡的嘻哈佩佩，無論走到哪裡都是舞台上最矚目的焦點。',
    emoji: '💎'
  },
  {
    id: 'skin-05',
    name: '狂野海盜青蛙船長',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/05_自信的海盜青蛙隊長.png',
    desc: '統領DeFi無盡海域的海盜船長，手持黃金彎刀，憑藉無人能及的直覺航向財富之島。',
    emoji: '🏴‍☠️'
  },
  {
    id: 'skin-06',
    name: '魔法君王尊貴蛙皇',
    rarity: 'Legendary',
    price: 5000,
    imagePath: '/skins/06_王者蛙王的魔法肖像.png',
    desc: '端坐在神聖寶座之上，掌控著古老綠色自然魔力，受萬民景仰的終極蛙中至尊。',
    emoji: '👑'
  },
  {
    id: 'skin-07',
    name: '星際太空蛙戰士',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/07_太空蛙戰士.png',
    desc: '穿戴厚重高科技太空戰甲的佩佩，配備背部噴射包，準備踏上降臨月球的登月之旅！',
    emoji: '👨‍🚀'
  },
  {
    id: 'skin-08',
    name: '賽博龐克機械青蛙',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/08_未來城市中的機械青蛙.png',
    desc: '未來霓虹都市下的機械改造蛙，擁有光纖神經與超強運算大腦，以秒級速度分析市場。',
    emoji: '🤖'
  },
  {
    id: 'skin-09',
    name: '寫實派商務精英蛙',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/09_a_digital_illustration_in_a_semi_realistic_detail.png',
    desc: '身穿筆挺高檔西裝、散發商務精英氣息的成熟佩佩，是穩健投資與高勝率的代名詞。',
    emoji: '💼'
  },
  {
    id: 'skin-10',
    name: '聖殿十字青蛙騎士',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/10_勇敢的青蛙騎士.png',
    desc: '手持十字巨劍與神聖鐵盾的勇敢騎士，誓死守護DeFi聖殿的資產安全與和平。',
    emoji: '🛡️'
  },
  {
    id: 'skin-11',
    name: '傳奇青蛙拳擊冠軍',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/11_自信的青蛙拳擊手.png',
    desc: '綁著繃帶、戴著紅色拳套的擂台王者，能在一瞬間對市場的空頭勢力打出致命一擊！',
    emoji: '🥊'
  },
  {
    id: 'skin-12',
    name: '酷炫霓虹派對 DJ 蛙',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/12_酷炫dj蛙的霓虹派對風格.png',
    desc: '在巨型霓虹電音派對上打碟的潮流DJ，它的節奏掌控力就跟交易滑點一樣精準完美。',
    emoji: '🎧'
  },
  {
    id: 'skin-13',
    name: '狂戰士維京青蛙',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/13_青蛙維京戰士.png',
    desc: '手執巨大雙板斧、戴著牛角鋼盔的北方維京戰士，咆哮著在巨浪中開疆闢土。',
    emoji: '🪓'
  },
  {
    id: 'skin-14',
    name: '榮耀赤鎧青蛙武士',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/14_榮耀武士青蛙.png',
    desc: '身披大紅色精緻甲冑的日本榮耀武士蛙，長刀出鞘如雷霆萬鈞，講求武士道的絕對專注。',
    emoji: '⚔️'
  },
  {
    id: 'skin-15',
    name: '威嚴精英蛙領袖',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/15_精英蛙領袖.png',
    desc: '胸前掛滿功勳徽章的嚴肅軍事領袖，擅長從宏觀視野進行無懈可擊的戰略佈局。',
    emoji: '🎖️'
  },
  {
    id: 'skin-16',
    name: '秘術青蛙大巫師',
    rarity: 'Legendary',
    price: 5000,
    imagePath: '/skins/16_魔法青蛙巫師.png',
    desc: '手握冰藍魔光法杖、吟唱奇幻魔咒的大巫師，掌握著憑空變出巨大流動性的奧秘魔法。',
    emoji: '🔮'
  },
  {
    id: 'skin-17',
    name: '科技特工佩佩蛙',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/17_a_detailed_digital_illustration_features_pepe_the.png',
    desc: '身著戰術特工背心、配戴紅外線夜視鏡的特種佩佩，擅長在黑暗中進行高難度滲透任務。',
    emoji: '🕶️'
  },
  {
    id: 'skin-18',
    name: '深邃幽谷綠林游俠',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/18_a_high_detail_digital_illustration_character_por.png',
    desc: '在深山綠林幽谷中隱居的優雅射手，百步穿楊，其箭矢代表著精準的目標追蹤。',
    emoji: '🏹'
  },
  {
    id: 'skin-19',
    name: '極客骇客未來蛙',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/19_未來黑客青蛙風格.png',
    desc: '戴著發光炫彩護目鏡、在虛擬世界主機中穿梭的駭客蛙，代碼編織出它的一切王國。',
    emoji: '💻'
  },
  {
    id: 'skin-20',
    name: '潮流迷幻動漫蛙',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/20_a_digital_illustration_in_a_detailed_and_vibrant_c.png',
    desc: '具有鮮豔大膽色彩與街頭迷彩風格的動漫卡通佩佩蛙，充滿年輕張力與無窮活力。',
    emoji: '🎨'
  },
  {
    id: 'skin-21',
    name: '奇幻森林小勇者',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/21_a_digital_illustration_in_detailed_cartoon_and_fan.png',
    desc: '背著小行囊、手持木劍的奇幻青蛙小勇者，隨時準備踏上賺取巨額利潤的奇異冒險。',
    emoji: '🎒'
  },
  {
    id: 'skin-22',
    name: '超頻機甲神兵佩佩',
    rarity: 'Legendary',
    price: 5000,
    imagePath: '/skins/22_a_digital_illustration_features_pepe_the_frog_as_a.png',
    desc: '完全融入巨型外骨骼動力機甲的佩佩，輸出功率爆表，是重裝火力的代名詞！',
    emoji: '🦾'
  },
  {
    id: 'skin-23',
    name: '華麗盛裝慶典蛙皇',
    rarity: 'Epic',
    price: 3000,
    imagePath: '/skins/23_a_digital_illustration_in_a_character_splash_art_s.png',
    desc: '身穿奢華紅色刺繡長禮袍出席神聖慶典的蛙皇，象徵著權利與最純粹的黃金時代。',
    emoji: '✨'
  },
  {
    id: 'skin-24',
    name: '古典精靈森林射手',
    rarity: 'Rare',
    price: 2000,
    imagePath: '/skins/24_a_stylized_high_detail_fantasy_character_illustra.png',
    desc: '沐浴在陽光微粒中的古典妖精青蛙射手，與自然精靈神力完美共鳴，心境明鏡止水。',
    emoji: '🍃'
  },
  {
    id: 'skin-25',
    name: '經典手繪手稿佩佩',
    rarity: 'Common',
    price: 1000,
    imagePath: '/skins/25_a_2d_digital_illustration_showcases_pepe_the_frog.png',
    desc: '以質樸的2D漫畫手繪黑線與水彩風格呈現的初始佩佩，讓人重溫最真摯的情懷。',
    emoji: '📝'
  }
];
