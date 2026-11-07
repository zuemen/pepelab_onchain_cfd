/**
 * 新手引導：標語、三大支柱、跟單流程圖、簡單／專家模式導覽。
 * 給不懂區塊鏈的人看：第一層只講「做什麼、按哪裡」，細節收在展開按鈕裡。
 */
export const guide = {
  slogan: 'Trading with trust, intelligence, and sustainability.',
  sloganZh: '用信任、智慧與永續來交易。',

  more: '看詳細說明',
  less: '收合說明',
  hide: '收起引導',
  show: '顯示新手引導',

  pillars: {
    trust: {
      title: '信任 Trust',
      short: '私鑰在你手上，保證金記在你的地址、只能提回你自己；每筆交易都在鏈上，誰都能查。',
      detail:
        'PepeFi 不保管你的私鑰，合約也沒有讓平台直接提走使用者資金的函式。跟單開出的部位在你名下，交易者的每一筆部位與每一版策略都記在鏈上，不能事後刪除。目前是測試網原型：營運方仍有調整參數、暫停與升級的權限，由單一金鑰管理、鏈上可查；移交時間鎖的腳本已備，尚未執行。合成資產非足額抵押，風險揭露在「儲備與償付能力」頁。',
    },
    intelligence: {
      title: '智慧 Intelligence',
      short: '授權 AI 在你設的額度內下單，它拿不到你的主錢包私鑰；也能跟著你挑的交易者自動調整。',
      detail:
        '你替 AI agent 開一把有限額的 session key：單筆金額、總預算、槓桿上限與到期日都寫在鏈上，你隨時可以撤銷。AI 需要資料時，用 x402 自己付一筆小錢買，不用幫它辦帳號。',
    },
    sustainability: {
      title: '永續 Sustainability',
      short: '碳排放直接算進手續費：越高碳的資產，費率越高。',
      detail:
        '每檔資產都有附出處的碳強度分級，分級決定手續費，不是只貼一個綠色標籤。平台手續費的一部分會買入模擬碳權並當場銷毀，每筆都查得到。這裡是測試網，碳權是模擬的，不對應真實減碳。',
    },
  },

  marketplace: {
    traders: '跟單交易者',
    allocations: '現成配置',
    simNote: '測試網展示：清單裡多數交易者與配置發布者是程式模擬的帳戶，不是真人，績效也不是真實投資結果。',
  },

  copyFlow: {
    heading: '跟單怎麼用？五步驟',
    sub: '不用懂區塊鏈，照著做就好。這裡全部用測試幣，不花真錢。',
    steps: [
      { title: '連接錢包', text: '錢包就是你的帳號，不用註冊。', to: '/portfolio' },
      { title: '領測試幣', text: '到「入金與兌換」免費領 USDC。', to: '/exchange' },
      { title: '挑交易者', text: '在「交易市集」看每個人的鏈上績效。', to: '/marketplace' },
      { title: '按下跟單', text: '決定要投多少，錢包確認一次。', to: '/marketplace' },
      { title: '自動跟上', text: '對方改策略，你的部位跟著調整。', to: '/portfolio' },
    ],
    detail: [
      '跟單開出的部位在你自己名下，只有你能取消，交易者碰不到你的資金。',
      '你可以設定多久同步一次、槓桿上限，或把自動同步關掉改成手動。',
      '跟單要付 0.3% 跟單費；跟單部位平倉獲利時，收 10% 績效費。交易者要先質押才能發布策略，害跟隨者虧太多可能被罰沒。',
    ],
  },

  mode: {
    simpleTitle: '簡單模式：先從這四步開始',
    expertTitle: '專家模式：還可以做這些',
    switchHint: '右上角可以切換簡單與專家模式。',
    simple: [
      { title: '領測試幣', text: '免費領 USDC，付交易用。', to: '/exchange' },
      { title: '買一點資產', text: '用 USDC 買股、債、金、幣。', to: '/tokens' },
      { title: '跟一位交易者', text: '看鏈上績效，挑一位跟單。', to: '/marketplace' },
      { title: '回來看成果', text: '配置、損益都在投資組合。', to: '/portfolio' },
    ],
    expert: [
      { title: '專業終端', text: '自己開多或開空，設定槓桿。', to: '/terminal' },
      { title: 'AI Agent 委任', text: '設好額度，讓 AI 代你下單。', to: '/sessions' },
      { title: '成為交易者', text: '質押 USDC，發布策略賺分潤。', to: '/stake' },
      { title: 'x402 付費訊號', text: '看 AI 怎麼自己付費買資料。', to: '/x402' },
      { title: '保險金庫', text: '存入 USDC，分手續費也擔風險。', to: '/vault' },
      { title: '鏈上透明', text: '自己核對儲備、價格與紀錄。', to: '/solvency' },
    ],
  },
};
