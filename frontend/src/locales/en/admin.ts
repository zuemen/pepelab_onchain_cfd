import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/admin.ts`。搬移階段逐字複製原文。
 */
export const admin: Catalog['admin'] = {
  oracle: {
    connectWallet: 'Connect wallet to access Oracle Admin.',
    title: 'Oracle Price Admin',
    subtitle: 'Only the oracle owner wallet can update prices.',
    viewOn: 'View on {explorer} ↗',

    ownerReadFailed: 'Failed to read oracle owner:',
    /** 讀 owner 失敗但錯誤物件不是 Error 時的後備說明。 */
    ownerReadFallback: 'Failed to read owner',
    checkingOwner: 'Checking owner permissions…',
    readOnly: 'Read-only mode: connected wallet is not the oracle owner. Updates will revert.',
    ownerLabel: 'Owner:',
    youLabel: 'You:',
    ownerVerified: 'Owner verified ✓',

    noteLabel: 'Note:',
    noteBody:
      'MockOracle price changes immediately affect all open position PnL. In production, oracle prices would come from trusted off-chain data feeds (e.g. Chainlink).',

    notOwner: 'Connected wallet is not the oracle owner',
    priceUpdated: 'Price updated ✓',
    fundingSettled: 'Funding settled ✓',

    funding: {
      title: 'Funding Settlement',
      description:
        'Settle per-asset funding (every {interval}). Anyone can call on-chain; UI restricts to owner.',
      autoSettle: 'Auto-Settle',

      column: {
        asset: 'Asset',
        rate: 'Rate (bps)',
        longOi: 'Long OI',
        shortOi: 'Short OI',
        imbalance: 'Imbalance',
        lastSettled: 'Last Settled',
        nextIn: 'Next In',
      },

      longsPay: '(L pay)',
      shortsPay: '(S pay)',
      never: 'Never',
      ready: 'Ready',
      settleNow: 'Settle Now',

      /** 下次可結算的倒數。三種區間各自是完整的一句話。 */
      countdownNow: 'Now',
      countdownMinutes: '~{n}m',
      countdownSeconds: '~{n}s',
    },

    comparison: {
      title: 'Oracle 來源比較',
      refresh: '↺ Refresh',

      /**
       * 夾住 `<code>immutable</code>` 的前後兩段。那個 code 元素帶 `mx: 0.5`，
       * 間距來自 CSS 而不是空白字元——攤平成單一字串就得無中生有兩個空格。
       */
      engineNoteBefore:
        '交易引擎目前使用 MockOracle（由 keeper 從真實市場抓價寫入）。 Chainlink / Pyth adapter 已部署並可即時查詢（如下表）， 但尚未接入交易引擎 —— PerpetualExchange 的 oracle 位址是',
      engineNoteAfter: '且無 setter，切換來源需重新部署，故整合列為下一階段。',

      wrongNetwork:
        'Chainlink / Pyth adapter 僅部署於 Base Sepolia（chainId 84532）。 請切換網路以查看三來源即時比較；本網路僅顯示 MockOracle 價格。',

      column: {
        asset: '資產',
        mock: 'MockOracle（引擎使用）',
        chainlink: 'Chainlink',
        pyth: 'Pyth',
      },

      dashNote:
        '「—」表示該 adapter 這一刻拿不到可信報價，有兩種原因：(1) 未提供此資產的 feed （多為股票／ETF，Chainlink 與 Pyth 測試網僅涵蓋主流加密資產）；(2) 報價已過期或不完整—— adapter 現在採 fail-closed，staleThreshold（預設 1 小時）內沒更新、round 不完整、 或 Pyth 信賴區間過寬時會直接 revert，不會再回傳舊價。所以同一列從有數字變成「—」 代表該來源劣化了，不是 feed 被移除。',
    },

    prices: {
      title: 'Asset Prices (8-decimal)',
      refresh: '↺ Refresh',
      lastUpdated: 'Last updated: {when}',
      updating: 'Updating…',
      update: 'Update Price',
    },

    raw: {
      title: 'Raw 8-decimal prices (for cast commands)',
    },
  },

  treasury: {
    connectWallet: 'Connect wallet to access Treasury Admin.',
    viewOnEtherscan: 'View on Etherscan ↗',

    /** 權限閘門。「還在讀鏈上 treasury」和「確定不是你」要說不同的話。 */
    checkingAuth: '確認權限中…',
    checkingAuthBody: '正在讀取鏈上的 feeRouter.platformTreasury()。讀不到就不放行。',
    notAuthorized: 'Not authorized',
    notAuthorizedBody: 'This page is restricted to the wallet set as feeRouter.platformTreasury().',
    treasuryFallbackLabel: 'Treasury（後備顯示值）:',
    treasuryOnChainLabel: 'Treasury（鏈上）:',

    title: 'Treasury Admin',
    subtitle: 'Cash out accumulated platform fees → ETH',

    stat: {
      pendingFees: 'Pending Platform Fees',
      walletMusdc: 'Wallet mUSDC Balance',
      walletEth: 'Wallet ETH Balance',
      routerEth: 'Router ETH Reserve',
    },

    claim: {
      title: 'Claim Platform Fees from FeeRouter',
      treasury: 'Treasury: {address}',
      pending: 'Pending platform fees',
      claiming: 'Claiming…',
      cta: 'Claim Platform Fees',
      note: 'This transfers all accumulated platform-share fees (20% of each copy / performance fee) to your wallet.',
      done: 'Platform fees claimed ✓',
    },

    swap: {
      title: 'Convert mUSDC → ETH via SwapRouter',
      placeholder: 'mUSDC amount',
      max: 'Max',
      estimate: '≈ {eth} ETH (rate: 1 ETH = 3000 mUSDC)',
      routerInsufficient:
        'Router only has {amount} ETH available. Fund it using the Treasury Tools below before swapping.',
      approving: 'Approving…',
      approve: '① Approve mUSDC',
      approved: 'USDT approved ✓',
      swapping: 'Swapping…',
      swap: '② Swap to ETH',
      done: 'Swapped {amount} mUSDC → {eth} ETH ✓',
    },

    tools: {
      title: 'Treasury Tools',
      fundRouter: 'Fund SwapRouter with ETH',
      fundRouterDesc:
        'The router needs an ETH reserve to fulfill mUSDC→ETH swaps from users and admin.',
      currentReserve: 'Current reserve:',
      placeholder: 'ETH amount (e.g. 1)',
      funding: 'Funding…',
      cta: 'Fund Router',
      done: 'Funded router with {amount} ETH ✓',
    },

    incentives: {
      title: '🎁 PepeLab Incentives Pool Refill (獎勵池充值)',
      description:
        '跟單獎勵、每日簽到、等級晉級與交易挖礦均由 PEPE 代幣激勵。為防止用戶領取時發生 revert InsufficientPool 錯誤，請確保此激勵合約中有足夠的 PEPE 儲備。',
      walletBalance: '我的錢包 PEPE 餘額',
      poolBalance: '激勵合約 PEPE 儲備',
      placeholder: '注資 PEPE 數量 (例如 100000)',
      funding: '注資中…',
      cta: '確認注資',
      done: 'Successfully funded Incentives Pool with {amount} PEPE ✓',
    },

    history: {
      title: 'Recent Cash Out History',
      refresh: '↺ Refresh',
      emptyTitle: 'No cash out history yet',
      emptyDescription: 'Fee claims and mUSDC→ETH swaps will appear here.',
      claimed: 'Claimed',
      swapped: 'Swapped',
      claimAmount: '{amount} mUSDC',
      swapAmount: '{usdcIn} mUSDC → {eth} ETH',
    },

    info: {
      revenueModelLabel: 'Revenue model:',
      revenueModelBody:
        'Each copy-trade or performance fee is split 70% trader / 20% platform / 10% insurance vault. Platform fees accumulate in FeeRouter until this admin claims them.',
      swapNote:
        "After claiming mUSDC, use the swap above to convert to ETH at the mock rate (1 ETH = 3000 mUSDC). In production, you'd use a real DEX.",
    },
  },

  agent: {
    connectWallet: 'Connect wallet to view the agent monitor.',
    title: '📊 Agent Risk Monitor',
    live: 'LIVE',
    subtitle: '監控 AI agent 經濟：委派 session 的限額使用、x402 收入分潤、預言機健康度。唯讀。',

    disclosure:
      '償付後盾揭露：ADL（自動減倉）與組合保證金已實作、由旗標控管，本測試網部署 目前預設關閉（線上跑逐倉清算 + 保險金庫 bailout）。極端行情下，在 ADL 啟用前協議 作為對手方仍有償付風險——本頁數據不代表線上償付無虞。詳見 docs/RISK_NOTES.md。',

    kpi: {
      chain: 'Chain',
      activeSessions: 'Active sessions',
      staleFeeds: 'Stale feeds',
      vaultAssets: 'Vault assets (USDC)',
      vaultPrice: 'Vault px (USDC/pIV)',
      x402Fees: 'x402 fees (USD)',
    },

    sessions: {
      title: 'Delegated Sessions',
      refresh: '↺ Refresh',
      wrongNetwork:
        '請切換到 Base Sepolia（chainId 84532）以檢視 agent sessions。目前網路：{chain}。',
      notConnected: '未連線',
      empty: '尚無 session。',

      column: {
        id: '#',
        user: 'User',
        agent: 'Agent',
        budgetUse: 'Budget use',
        maxLeverage: 'Max lev',
        expiry: 'Expiry',
        status: 'Status',
      },

      status: {
        revoked: 'Revoked',
        expired: 'Expired',
        highUse: 'High use',
        expiring: 'Expiring',
        active: 'Active',
      },
    },

    verification: {
      title: 'Agent Verification (ERC-8126)',
      description:
        '「這個 agent 可不可信？」— ETV / SCV / WAV / WV 四項檢查 + 統一 0–100 風險分數（越低越安全），verifier 簽章。',
      inputLabel: 'agent 地址或 did:pkh',
      inputPlaceholder: '0x… 或 did:pkh:eip155:84532:0x…',
      enterQuery: '請輸入 agent 地址或 did:pkh',
      verifying: '驗證中…',
      verify: 'Verify',
      failed:
        '無法取得驗證（{error}）。請確認 signal-api URL，並見 docs/AGENT_ECONOMY_STANDARDS.md。',
      fetchFailed: 'fetch failed',

      riskChip: '風險 {score}/100 · {tier}',
      checkChip: '{type} {score}',
      checkNotApplicable: 'N/A',
      checkTooltip: '{name}: {details}',
      identity: 'subject: {subject} · verifier: {verifier}',
    },

    revenue: {
      title: 'x402 Revenue (70/20/10)',
      urlLabel: 'signal-api URL',
      fetch: 'Fetch',
      failed: '無法連到 signal-api（{error}）。請先 npm run signal-api。',
      callsTotal: 'Calls / Total',
      traderShare: 'Trader 70%',
      platformShare: 'Platform 20%',
      vaultShare: 'Vault 10%',
      topBeneficiaries: 'Top beneficiaries (70% share)',
      loading: 'Loading…',
    },

    oracle: {
      title: 'Oracle Health',
      column: {
        asset: 'Asset',
        price: 'Price',
        funding: 'Funding',
        feed: 'Feed',
      },
      stale: 'Stale',
      fresh: 'Fresh',
    },

    sessionManager: 'AgentSessionManager: {address}',
  },
};
