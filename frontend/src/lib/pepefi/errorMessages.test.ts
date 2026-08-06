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
