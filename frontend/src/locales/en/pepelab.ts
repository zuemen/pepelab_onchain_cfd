import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/pepelab.ts`。搬移階段逐字複製原文。
 */
export const pepelab: Catalog['pepelab'] = {
  /** 藥水商店的三瓶藥水。 */
  potion: {
    green: { name: 'Pepe Green Juice (綠色蛙汁)', desc: '讓你的 Pepe 眼睛發光，經驗值 +50 XP！' },
    gold: { name: 'Golden Elixir (黃金仙露)', desc: '解鎖奢華黃金配飾，經驗值 +150 XP！' },
    moon: { name: 'Moon Potion (登月藥水)', desc: '獲得登月火箭背包，直接獲得 +500 XP！' },
  },

  toast: {
    insufficientPepe: 'PEPE 餘額不足。可到 Rewards 頁面簽到或交易挖礦取得更多。',
    txCancelled: '鏈上交易已取消或扣款失敗，未扣除任何 PEPE。',
    mountLocked: '此坐騎需 Pepe 等級 Lv.{level} 解鎖，目前 Lv.{current}。',
    gachaInsufficientPepe: 'PEPE 餘額不足，抽取一次需要 {cost} PEPE。',
    stageInProgress: '{stage} 階段的造型還在製作中，敬請期待。',
    stageComplete: '已集齊 {stage} 階段的所有造型，進化後會解鎖新的一批。',
    skinInsufficientPepe: 'PEPE 餘額不足，此造型需要 {price} PEPE。',
    skinPurchased: '已購買並解鎖「{name}」',
  },

  buySkinDialog: {
    title: '購買造型',
    message: '以 {price} PEPE 購買「{name}」？PEPE 將轉入銷毀地址，無法復原。',
    confirmLabel: '購買 · {price} PEPE',
  },

  unequipDialog: {
    title: '取消造型',
    message: '脫下目前造型，變回原本的進化外觀？已解鎖的造型會保留，隨時可再穿戴。',
    confirmLabel: '脫下造型',
  },

  header: {
    title: 'Pepe GameFi & MemeFi Lab 🧪',
    subtitle: 'DeFi · SocialFi · GameFi · MemeFi 一體化升級中心',
    balance: '💰 餘額: {amount} PEPE',
  },

  roadmap: {
    heading: '🐸 佩佩蛙進化樹 (Evolution) · 目前',
    nextStage: '⚡ 再升 {levels} 級 (Lv.{level}) 即可進化為 {label} {emoji}',
    maxStage: '🏆 已進化至最終形態 蛙神 🌌',
    tileReached: 'Lv.{stage}',
    tileLocked: '需 Lv.{level}',
    tileTooltip: 'Lv.{stage} {label} — {desc}',
  },

  tab: {
    potions: '🧪 魔法藥水 (Potions)',
    mounts: '🐋 尊貴坐騎 (Mounts)',
    skins: '🎰 造型盲盒與商城 (Skins & Gacha)',
    achievements: '🏅 成就 (Achievements)',
    quests: '📋 每日任務 (Quests)',
  },

  potionsTab: {
    xpLabel: '+{xp} XP 經驗值',
    buy: '🛒 購買並使用 ({cost} PEPE)',
  },

  mountsTab: {
    currentMount: '目前坐騎',
    evolutionForm: '進化型態',
    unlockedCount: '已解鎖坐騎',
    allUnlocked: '🎉 恭喜！四隻坐騎全數解鎖，黃金天鯨已在等你。',

    riding: '騎乘中',
    locked: '未解鎖',
    unknownName: '??? (需 Lv.{level} 解鎖)',
    unknownDesc: '達到指定等級後才會揭曉這隻坐騎的真面目。',
    unlockedBadge: '已解鎖',
    lockedHint: '需要達 Lv.{level} 級',

    ctaRiding: '騎乘中',
    ctaMount: '騎上去',
    ctaLocked: 'Lv.{level}',
  },

  gacha: {
    boxTitle: '{emoji} {stage}造型盲盒',
    inProgress: '{stage} 階段的造型還在製作中，敬請期待 🚧',
    drawing: '正在破殼孵化中...',
    inProgressButton: '🚧 造型製作中',
    drawButton: '🎰 幸運抽造型 (500 PEPE)',
    rarityCommon: '🟢 Common: 50%',
    rarityRare: '🔵 Rare: 30%',
    rarityEpic: '🟣 Epic: 15%',
    rarityLegendary: '🔴 Legendary: 5%',

    wallTitle: '🎨 {stage}造型牆 ({unlocked}/{total})',
    wallHint:
      '只會顯示目前進化階段的造型。點擊已解鎖的即可穿戴，左側主角會立刻換成該造型；未解鎖的可直接花 PEPE 買下。',
    unequip: '脫下造型',
  },

  achievementsTab: {
    unlocked: '已解鎖',
    locked: '未解鎖',
  },

  questsTab: {
    done: '✓ 完成',
    checkedIn: '🔥 已連續簽到 {days} 天，明天再來。',
    notCheckedIn: '🐸 今天還沒簽到，到 Rewards 頁面領取每日 PEPE。',
    goToRewards: '前往 Rewards 🎁',
  },

  evolveDialog: {
    label: 'EVOLUTION',
    title: '進化成功！🎉',
    stageLine: '進化 Lv.{stage} · {title}',
    cta: '太強了 🐸',
  },

  drawDialog: {
    title: '恭喜獲得！🎉',
    subtitle: '您已成功破殼孵化出全新佩佩蛙稀有造型！',
    rarity: '稀有度: {rarity}',
    unlockedHint: '解鎖了 {stage} 階段的專屬造型。立即穿戴，左側的主角就會換成牠。',
    equipNow: '👕 立即穿戴造型',
    keepInCloset: '收進衣櫃',
  },

  /** #36：三段句中夾了 `<strong>` 的說明，各自拆成標記前後的片段。 */
  markup: {
    currentMountBefore: ' 目前您已達到了 ',
    currentMountStrongPrefix: 'Lv. ',
    currentMountStrongMid: ' · 進化型態 Lv.',
    currentMountAfter: ' 的尊貴段位。',

    nextUnlockBefore: '距離解鎖下一隻坐騎 ',
    nextUnlockMid: ' 還差 ',
    nextUnlockAfter: ' 級！(需要達 Lv.',
    nextUnlockTail: ')',

    gachaCostBefore: '花費 ',
    gachaCostMid1: ' 從 ',
    gachaCostMid2: ' 專屬的 ',
    gachaCostAfter: ' 款造型中隨機抽取。 進化到下一階段後，會換上一整批全新造型。',
  },
};
