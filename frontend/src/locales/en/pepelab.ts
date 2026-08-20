import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/pepelab.ts`。
 */
export const pepelab: Catalog['pepelab'] = {
  /** 藥水商店的三瓶藥水。 */
  potion: {
    green: { name: 'Pepe Green Juice', desc: "Makes your Pepe's eyes glow — +50 XP!" },
    gold: { name: 'Golden Elixir', desc: 'Unlocks a luxurious gold accessory — +150 XP!' },
    moon: { name: 'Moon Potion', desc: 'Grants a moon-rocket backpack — an instant +500 XP!' },
  },

  toast: {
    insufficientPepe: 'Not enough PEPE. Check in or trade-mine on the Rewards page to get more.',
    txCancelled: 'The on-chain transaction was cancelled or failed — no PEPE was deducted.',
    mountLocked: "This mount unlocks at Pepe level Lv.{level} — you're currently Lv.{current}.",
    gachaInsufficientPepe: 'Not enough PEPE — one draw costs {cost} PEPE.',
    stageInProgress: 'Skins for the {stage} stage are still in the works — stay tuned.',
    stageComplete: "You've collected every {stage}-stage skin. Evolving unlocks a new batch.",
    skinInsufficientPepe: 'Not enough PEPE — this skin costs {price} PEPE.',
    skinPurchased: 'Purchased and unlocked "{name}"',
  },

  buySkinDialog: {
    title: 'Buy Skin',
    message:
      'Buy "{name}" for {price} PEPE? The PEPE will be sent to a burn address — this cannot be undone.',
    confirmLabel: 'Buy · {price} PEPE',
  },

  unequipDialog: {
    title: 'Remove Skin',
    message:
      'Take off your current skin and go back to your default evolution look? Unlocked skins stay in your closet — you can wear them again anytime.',
    confirmLabel: 'Remove Skin',
  },

  header: {
    title: 'Pepe GameFi & MemeFi Lab 🧪',
    subtitle: 'DeFi · SocialFi · GameFi · MemeFi, all in one growth hub',
    balance: '💰 Balance: {amount} PEPE',
  },

  roadmap: {
    heading: '🐸 Pepe Evolution Tree · Current',
    nextStage: '⚡ Level up {levels} more (Lv.{level}) to evolve into {label} {emoji}',
    maxStage: '🏆 Evolved to the final form — Lord 🌌',
    tileReached: 'Lv.{stage}',
    tileLocked: 'Requires Lv.{level}',
    tileTooltip: 'Lv.{stage} {label} — {desc}',
  },

  tab: {
    potions: '🧪 Potions',
    mounts: '🐋 Mounts',
    skins: '🎰 Skins & Gacha',
    achievements: '🏅 Achievements',
    quests: '📋 Quests',
  },

  potionsTab: {
    xpLabel: '+{xp} XP',
    buy: '🛒 Buy & Use ({cost} PEPE)',
  },

  mountsTab: {
    currentMount: 'Current Mount',
    evolutionForm: 'Evolution Form',
    unlockedCount: 'Mounts Unlocked',
    allUnlocked: '🎉 Congrats! All four mounts unlocked — the Celestial Whale is waiting for you.',

    riding: 'Riding',
    locked: 'Locked',
    unknownName: '??? (unlocks at Lv.{level})',
    unknownDesc: "This mount's true form is revealed once you reach the required level.",
    unlockedBadge: 'Unlocked',
    lockedHint: 'Requires reaching Lv.{level}',

    ctaRiding: 'Riding',
    ctaMount: 'Mount Up',
    ctaLocked: 'Lv.{level}',
  },

  gacha: {
    boxTitle: '{emoji} {stage} Mystery Skin Box',
    inProgress: '{stage}-stage skins are still in the works — stay tuned 🚧',
    drawing: 'Hatching...',
    inProgressButton: '🚧 Skins In Progress',
    drawButton: '🎰 Lucky Skin Draw (500 PEPE)',
    rarityCommon: '🟢 Common: 50%',
    rarityRare: '🔵 Rare: 30%',
    rarityEpic: '🟣 Epic: 15%',
    rarityLegendary: '🔴 Legendary: 5%',

    /** 造型卡片上的稀有度徽章。key 對應 pepeSkinsData.ts 的 rarity 型別（英文，不譯）。 */
    rarityLabel: {
      Common: 'Common',
      Rare: 'Rare',
      Epic: 'Epic',
      Legendary: 'Legendary',
    },

    wallTitle: '🎨 {stage} Skin Wall ({unlocked}/{total})',
    wallHint:
      'Only shows skins for your current evolution stage. Click an unlocked one to wear it — your character on the left updates instantly. Locked ones can be bought directly with PEPE.',
    unequip: 'Remove Skin',
  },

  achievementsTab: {
    unlocked: 'Unlocked',
    locked: 'Locked',
  },

  questsTab: {
    done: '✓ Done',
    checkedIn: '🔥 {days}-day check-in streak — come back tomorrow.',
    notCheckedIn: "🐸 You haven't checked in today — claim your daily PEPE on the Rewards page.",
    goToRewards: 'Go to Rewards 🎁',
  },

  evolveDialog: {
    label: 'EVOLUTION',
    title: 'Evolved! 🎉',
    stageLine: 'Evolution Lv.{stage} · {title}',
    cta: "Let's go 🐸",
  },

  drawDialog: {
    title: 'You Got One! 🎉',
    subtitle: "You've successfully hatched a brand-new rare Pepe skin!",
    rarity: 'Rarity: {rarity}',
    unlockedHint:
      'Unlocked a skin exclusive to the {stage} stage. Wear it now and your character on the left will change instantly.',
    equipNow: '👕 Wear It Now',
    keepInCloset: 'Keep in Closet',
  },

  /** #36：三段句中夾了 `<strong>` 的說明，各自拆成標記前後的片段。 */
  markup: {
    currentMountBefore: ' You have reached the rank of ',
    currentMountStrongPrefix: 'Lv. ',
    currentMountStrongMid: ' · Evolution Lv.',
    currentMountAfter: '.',

    nextUnlockBefore: 'Next mount to unlock: ',
    nextUnlockMid: ' — only ',
    nextUnlockAfter: ' levels to go! (requires Lv.',
    nextUnlockTail: ')',

    gachaCostBefore: 'Spend ',
    gachaCostMid1: ' for a random draw from the ',
    gachaCostMid2: '-exclusive pool of ',
    gachaCostAfter: ' skins. Evolving to the next stage swaps in a whole new batch.',
  },
};
