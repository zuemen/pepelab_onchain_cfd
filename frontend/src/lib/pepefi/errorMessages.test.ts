import { describe, it, expect } from 'vitest'

import { prettyError } from './errorMessages'

/** ethers v6 在 ABI 認得 custom error 時的形狀。 */
const revertLike = (name: string) => ({
  code: 'CALL_EXCEPTION',
  shortMessage: 'execution reverted',
  message: 'execution reverted',
  revert: { name },
})

describe('prettyError · 解碼後的 custom error 名稱', () => {
  it('PepeAMM 的 oracle 護欄有專屬說明，不會落到通用 fallback', () => {
    const stale = prettyError(revertLike('StaleOraclePrice'))
    expect(stale).toContain('預言機')
    expect(stale).not.toContain('無法辨識')

    const band = prettyError(revertLike('PriceOutOfBand'))
    expect(band).toContain('池價')
    expect(band).not.toContain('無法辨識')
  })

  it('恆定乘積池的流動性/輸入/輸出錯誤各自有可行動的說法', () => {
    expect(prettyError(revertLike('InsufficientLiquidity'))).toContain('流動性')
    expect(prettyError(revertLike('InsufficientInput'))).toContain('太小')
    expect(prettyError(revertLike('InsufficientOutput'))).toContain('滑點')
  })

  it('合約錢包被水龍頭擋下時，說的是「改用 EOA」而不是「冷卻中」', () => {
    const msg = prettyError(revertLike('FaucetCallerMustBeEOA'))
    expect(msg).toContain('EOA')
    expect(msg).not.toContain('cooldown')
  })

  it('EOA 限制和 24h 冷卻是兩個不同的訊息', () => {
    expect(prettyError(revertLike('FaucetCallerMustBeEOA')))
      .not.toBe(prettyError(revertLike('FaucetCooldown')))
  })

  it('mint 的 NotMinter 會把使用者導向 faucet', () => {
    expect(prettyError(revertLike('NotMinter'))).toContain('faucet')
  })

  it('ESG 最短持有期', () => {
    expect(prettyError(revertLike('HoldTooShort'))).toContain('持有')
    expect(prettyError(revertLike('PositionNotOpen'))).toContain('平倉')
  })

  it('tier 獎勵的排序要求', () => {
    expect(prettyError(revertLike('PositionIdsNotSorted'))).toContain('遞增')
  })

  it('質押獎勵預算不足', () => {
    expect(prettyError(revertLike('RewardExceedsBudget'))).toContain('預算')
  })

  it('agent 不是原開倉者', () => {
    expect(prettyError(revertLike('NotPositionAgent'))).toContain('agent')
  })

  it('KYC 審核制的新錯誤', () => {
    expect(prettyError(revertLike('NoSubmission'))).toContain('申請')
    expect(prettyError(revertLike('NotVerifier'))).toContain('審核')
  })

  it('預言機 adapter 的 fail-closed 錯誤', () => {
    expect(prettyError(revertLike('PriceIsStale'))).toContain('過期')
    expect(prettyError(revertLike('NoLiveSource'))).toContain('來源')
    expect(prettyError(revertLike('SingleSourceNotAllowed'))).toContain('單一來源')
    expect(prettyError(revertLike('PriceDeviationTooHigh'))).toContain('偏離')
  })
})

describe('prettyError · 既有行為沒有被新增的鍵蓋掉', () => {
  it('ERC20InsufficientBalance 仍然勝過泛用的 InsufficientBalance', () => {
    expect(prettyError({ message: 'ERC20InsufficientBalance(...)' })).toContain('餘額不足')
  })

  it('TierAlreadyClaimed 仍然勝過泛用的 AlreadyClaimed', () => {
    expect(prettyError(revertLike('TierAlreadyClaimed'))).toContain('等級')
  })

  it('StalePrice（PerpetualExchange）和 StaleOraclePrice（AMM）不會互相誤判', () => {
    expect(prettyError(revertLike('StalePrice'))).toContain('keeper')
    expect(prettyError(revertLike('StaleOraclePrice'))).toContain('兌換')
  })

  it('使用者取消交易', () => {
    expect(prettyError({ code: 'ACTION_REJECTED' })).toBe('你拒絕了交易')
  })

  it('認不出來的錯誤仍然給一句可行動的話，不外洩 RPC 內部欄位', () => {
    const msg = prettyError({ message: 'could not coalesce error (payload={"id":1})' })
    expect(msg).not.toContain('payload')
    expect(msg).toContain('重試')
  })
})

describe('prettyError · JSON-RPC 巢狀 data 也能取到 selector', () => {
  it('從 error.data 取得 selector', () => {
    expect(prettyError({ message: 'reverted', error: { data: '0xe450d38c' } }))
      .toContain('餘額不足')
  })

  it('從 info.error.data 取得 selector', () => {
    expect(prettyError({ message: 'reverted', info: { error: { data: '0xe450d38c' } } }))
      .toContain('餘額不足')
  })
})

describe('RWA／休市閘門的 revert data（公開節點只回 data、沒有錯誤名稱）', () => {
  it('NotKycVerified 與 AssetNotActive 以 selector 對應到可讀訊息', () => {
    const kyc = { data: '0xbb7233680000000000000000000000001111111111111111111111111111111111111111', message: 'execution reverted' }
    expect(prettyError(kyc)).toContain('KYC')
    const closed = {
      info: { error: { data: '0x4f402872eed17252f75eebef59a2839f0991464677fec970326e35128ddaf7f3acfb72200000000000000000000000000000000000000000000000000000000000000001' } },
      message: 'execution reverted',
    }
    expect(prettyError(closed)).toContain('休市')
  })
})

describe('CopyTracker 自動同步（ADR-024）的 revert', () => {
  it('每一種同步會被擋的原因各有可行動的說法', () => {
    expect(prettyError(revertLike('AlreadySynced'))).toContain('最新版')
    expect(prettyError(revertLike('InsufficientSyncGas'))).toContain('油箱')
    expect(prettyError(revertLike('SyncCooldown'))).toContain('冷卻')
    expect(prettyError(revertLike('AutoSyncDisabled'))).toContain('只有本人')
    expect(prettyError(revertLike('InvalidSyncConfig'))).toContain('1–5×')
    expect(prettyError(revertLike('PositionStillOpen'))).toContain('維持原狀')
    expect(prettyError(revertLike('StrategyVersionMismatch'))).toContain('新版')
  })

  it('只剩訊息字串時，關鍵字掃描不會先撞上較早的 Insufficient* 規則', () => {
    const e = { message: 'execution reverted: InsufficientSyncGas(400000000000000, 0)' }
    expect(prettyError(e)).toContain('油箱')
  })

  it('跟單附帶的 ETH 不夠付開倉執行費：講執行費，不叫使用者「存入油箱」', () => {
    const named = prettyError(revertLike('InsufficientExecutionFee'))
    expect(named).toContain('執行費')
    expect(named).not.toContain('油箱')
    const e = { message: 'execution reverted: InsufficientExecutionFee(300000000000000, 100000000000000)' }
    expect(prettyError(e)).toBe(named)
  })

  it('油箱提領到無效的收款地址', () => {
    expect(prettyError(revertLike('InvalidRecipient'))).toContain('收款地址')
  })
})
