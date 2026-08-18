/**
 * Exchange 頁。
 *
 * 這一頁是全站最大的下單路徑，也是搬移最麻煩的一頁：條件字串、插值、句中夾標記
 * 三種都有。分批搬，這一批是**交易訊息**——toast 與全域 loading 覆蓋層的字。
 */
export const exchange = {
  connectWallet: 'Connect wallet to access the exchange.',

  side: {
    long: 'Long',
    short: 'Short',
  },

  /** 送出交易前後對使用者說的話。 */
  tx: {
    enterValidAmount: 'Enter a valid amount',
    enterValidMargin: 'Enter a valid margin',
    insufficientMargin: '保證金不足，請先在 Margin Account 區塊 Approve & Deposit',

    /**
     * 兌換池的 oracle 過期。這句話在按下去之前就要說——合約會 revert
     * StaleOraclePrice，等使用者付完 gas 才知道是最糟的順序。
     */
    ammStale:
      '兌換池的參考預言機報價已過期，合約會拒絕兌換（StaleOraclePrice）。請等 keeper 更新價格後再試。',

    approving: 'Approving {token}…',
    swappedEthForToken: 'Swapped {amount} ETH for ~{received} {token} ✓',
    swappedTokenForEth: 'Swapped {amount} {token} for ~{received} ETH ✓',

    faucetStable: '已領取測試 {token} ✓ — 可在右側 Margin Account「Approve & Deposit」作為保證金',
    faucetAltStable: '已領取測試 {alt} ✓ — 可持有與兌換；保證金請用 {token}',
    faucetPepe: '已領取測試 PEPE ✓',

    deposited: 'Deposited {amount} {token} ✓',
    withdrew: 'Withdrew {amount} {token} ✓',

    positionOpened: '{side} {asset} opened ✓',
    positionClosed: 'Position closed ✓',
    esgClaimed: '🌱 ESG 獎勵領取成功！',
  },

  /** 全域交易覆蓋層上的字，依當下進行中的動作切換。 */
  loading: {
    fallback: 'Processing transaction...',
    swapEthToToken: 'Swapping ETH to {token}…',
    swapTokenToEth: 'Swapping {token} to ETH…',
    faucetStable: 'Claiming test {token}…',
    faucetPepe: 'Claiming test PEPE…',
    deposit: 'Depositing Margin...',
    withdraw: 'Withdrawing Margin...',
    open: 'Opening Position...',
    close: 'Closing Position...',
  },
};
