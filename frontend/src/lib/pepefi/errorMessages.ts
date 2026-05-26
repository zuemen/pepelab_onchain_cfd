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
  'user rejected':            '你拒絕了交易',
  'User rejected':            '你拒絕了交易',
  'ACTION_REJECTED':          '你拒絕了交易',
  'insufficient funds':       'ETH 不夠付 gas 費',
  'execution reverted':       '交易執行失敗',
  'nonce too low':            'Nonce 太低，請重試',
}

export function prettyError(err: unknown): string {
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
  for (const [keyword, friendly] of Object.entries(ERROR_MAP)) {
    if (msg.includes(keyword)) return friendly
  }

  return msg.slice(0, 120)
}
