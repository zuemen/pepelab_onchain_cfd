const ERROR_MAP: Record<string, string> = {
  // Selectors (0x + 4-byte hex)
  '0xbb90b0d9': '需要先批准 mUSDC 給 Swap Router，請點擊 Approve',
  // Keyword matches (case-insensitive)
  'FaucetCooldown':           'Faucet 24h 內只能領一次，請等待 cooldown',
  'NoStrategyPublished':      '此 trader 尚未發布策略',
  'TradingFeeExceedsMargin':  '跟單金額太小，trading fee 超過 margin，請增加金額',
  'InsufficientFreeMargin':   '保證金不足，請先 deposit 更多 mUSDC',
  'MarginTooLow':             '保證金低於最低門檻（10 mUSDC）',
  'InvalidLeverage':          '槓桿必須是 1x / 2x / 5x',
  'NotPositionOwner':         '只有 position 持有者能操作',
  'PositionAlreadyClosed':    '此 position 已平倉',
  'NotCopyTracker':           '此 function 只有 CopyTracker 能呼叫',
  'CopyTrackerNotSet':        'CopyTracker 尚未設定，請聯絡管理員',
  'Insufficient execution fee': '需要 0.001 ETH 作為執行費，請補充 ETH',
  'AlreadyRegistered':        '你已經是 trader，不需要重新註冊',
  'NotRegistered':            '請先註冊為 trader',
  'EmptyAllocations':         '策略不能為空，至少要有一個 allocation',
  'InvalidWeightSum':         '權重總和必須等於 100%',
  'ZeroWeight':               '權重不能為 0',
  'CooldownNotElapsed':       'Unstake 冷凍期還沒結束',
  'NoUnstakeRequest':         '沒有 pending unstake 請求',
  'InsufficientStake':        '質押額度不足',
  'AlreadyMined':             '此倉位已申領過交易挖礦獎勵，請勿重複申領',
  'AlreadyCheckedIn':         '您今天已經簽到過囉，明天再來吧！',
  'TierAlreadyClaimed':       '此等級的晉升獎勵已申領過囉！',
  'CopyAlreadyClaimed':       '此跟單關係的獎勵已申領過囉！',
  'NotFollowing':             '您目前尚未開始跟單此交易員！',
  'InvalidTier':              '無效的等級參數！',
  'InsufficientPool':         '激勵合約的 PEPE 資金池餘額不足，請聯絡管理員充值！',
  'TierThresholdNotMet':      '您的累計交易量（Notional Volume）未達到此等級的要求！',
  'user rejected':            '你拒絕了交易',
  'User rejected':            '你拒絕了交易',
  'ACTION_REJECTED':          '你拒絕了交易',
  'insufficient funds':       'ETH 不夠付 gas 費',
  'execution reverted':       '交易執行失敗',
  'nonce too low':            'Nonce 太低，請重試',
}

export function prettyError(err: unknown, context?: 'mining' | 'tier' | 'copy' | 'checkin'): string {
  if (!err) return '未知錯誤'

  const e = err as {
    data?: string
    message?: string
    reason?: string
    shortMessage?: string
    code?: string
  }

  // 1. custom error selector
  const data = e.data
  if (typeof data === 'string' && data.startsWith('0x') && data.length >= 10) {
    const sel = data.slice(0, 10).toLowerCase()
    if (ERROR_MAP[sel]) return ERROR_MAP[sel]
  }

  // 2. keyword scan across all message fields
  const msg = e.shortMessage ?? e.reason ?? e.message ?? e.code ?? String(err)
  const msgLower = msg.toLowerCase()
  
  for (const [keyword, friendly] of Object.entries(ERROR_MAP)) {
    if (msgLower.includes(keyword.toLowerCase())) return friendly
  }

  // 3. Fallback for generic reverts using context
  if (msgLower.includes('missing revert data') || msgLower.includes('execution reverted') || msgLower.includes('3: execution reverted')) {
    if (context === 'copy') {
      return '領取跟單獎勵失敗 (Reverted)。請確認：1. 您已開始跟單此交易員；2. 您尚未領取過此關係的獎勵；3. 激勵合約已充值足夠的 PEPE 資金池。';
    }
    if (context === 'tier') {
      return '等級晉級獎勵領取失敗 (Reverted)。請確認：1. 您的累計交易量已達標該等級門檻；2. 您尚未領取過此等級獎勵；3. 激勵合約已充值足夠的 PEPE 資金池。';
    }
    if (context === 'mining') {
      return '交易挖礦獎勵領取失敗 (Reverted)。請確認：1. 您是此倉位的持有者；2. 該倉位尚未領取過挖礦獎勵；3. 激勵合約已充值足夠的 PEPE 資金池。';
    }
    if (context === 'checkin') {
      return '每日簽到失敗 (Reverted)。請確認：1. 您今天尚未簽到過；2. 激勵合約的 PEPE 資金池已充值足夠資金。';
    }
    return '交易執行失敗 (Reverted)。請確認：1. 激勵合約已充值足夠的 PEPE 資金池；2. 您的地址符合領取條件（例如：已開始複製該交易員、已達標交易量門檻、或今日尚未簽到）。';
  }

  return msg.slice(0, 120)
}
