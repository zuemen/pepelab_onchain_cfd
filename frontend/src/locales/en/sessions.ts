import type { Catalog } from '../zh-TW';

/**
 * 見 `../zh-TW/sessions.ts`。
 */
export const sessions: Catalog['sessions'] = {
  title: '🤖 AI Agent Allowances',
  viewOn: 'View on {explorer} ↗',

  prereq: {
    title: 'Three things to prepare before the AI agent can invest for you',
    margin: 'Switch to Expert mode and deposit USDC into your investing account in the advanced investing tools. An AI agent allowance never touches the USDC in your wallet.',
    eth: 'The AI agent address needs a little ETH for network fees and the execution fee on each purchase.',
    kyc: 'To invest in stocks or bonds, your wallet must complete KYC first.',
  },
  ssi: {
    detailsToggle: 'For developers: technical details',
    title: 'The SSI triangle: your wallet is the root of trust',
    flow: 'Flow: connect wallet → set limits and create a session → issue an authorization VC → export the agent config → from then on, just say what you want to invest in, in one sentence.',
  },

  wrongNetwork: {
    title: 'Switch to Base Sepolia (chainId 84532)',
    unknownChain: 'Unknown network',
  },

  create: {
    title: 'Create AI agent allowance',
    agentAddress: 'AI agent address',
    agentPlaceholder: '0x… or click Generate agent key on the right',
    generateKey: 'Generate agent key',
    maxPerTrade: 'Max / trade (USDC)',
    totalBudget: 'Total budget (USDC)',
    maxLeverage: 'Max price-move multiplier',
    validFor: 'Valid for (hours)',
    creating: 'Creating…',
    cta: 'Create AI agent allowance',
    done: 'AI agent allowance created ✓',
    allowedAssets: 'Allowed assets',
    allowedAssetsHint: 'The AI agent can buy only these assets; the list is kept on-chain. Pick at least one.',
    noAssetSelected: 'Select at least one allowed asset.',
    invalidAgent: 'That agent address is not valid. Paste a 0x address, or generate an agent key.',
    invalidAmounts: 'The per-trade cap and total budget must both be above 0.',
    perTradeOverBudget: 'The per-trade cap cannot exceed the total budget.',
    invalidLeverage: 'The max price-move multiplier must be a whole number from 1 to 5.',
    invalidHours: 'Hours must be above 0.',
  },

  /** 瀏覽器裡產生的一次性 burner 金鑰。 */
  key: {
    title: '🔑 Your agent-only key (burner)',
    clear: 'Clear',
    addressChip: 'Address (authorized on-chain)',
    privateKeyChip: 'Private key (kept local only)',
    /** 私鑰被遮住時，圓點後面接的那一段字。 */
    hiddenSuffix: ' (hidden)',
    reveal: 'Reveal',
    hide: 'Hide',
    copy: 'Copy',
    copyAddressLabel: 'Agent address',
    copyPrivateKeyLabel: 'Agent private key',
    generated: 'Agent-only key generated (this browser only — save it now)',
  },

  list: {
    title: 'My AI agent allowances',
    refresh: '↺ Refresh',
    loading: 'Loading…',
    empty: 'No AI agent allowances yet. Create one to authorize an AI agent.',

    column: {
      id: '#',
      agent: 'Agent',
      spent: 'Spent / Budget',
      maxPerTrade: 'Max/trade',
      leverage: 'Multiplier',
      expiry: 'Expiry',
      status: 'Status',
      credential: 'Credential',
    },

    status: {
      revoked: 'Revoked',
      expired: 'Expired',
      active: 'Active',
    },

    issued: 'Issued ✓',
    export: 'Export ⤓',
    issueVc: 'Issue VC',
    signing: 'Signing…',
    issueVcHint: 'Sign the authorization VC with MetaMask',
    issueVcNeedsWallet: 'Requires a connected wallet to sign (not supported in guest mode)',
    revoke: 'Revoke',
    revoked: 'AI agent allowance revoked ✓',
    credentialIssued: 'Credential issued ✓',
    needsRealWallet: "Connect a wallet to sign the VC (guest mode doesn't support signing)",
    vcExpires: 'VC expires {date}',
    vcExpired: 'VC expired — re-issue',
    vcValidity: 'VC validity (days)',
    vcValidityHint: 'New credentials expire after this many days, never later than the AI agent allowance expiry (default {days}).',
  },

  /** 匯出對話框。 */
  export: {
    title: '🔌 Connect your AI agent — allowance #{id}',
    close: 'Close',
    closeAria: 'close',
    intro:
      'Paste both of the following into your local agent client. From then on, just say what you want to invest in — the AI agent will place orders on your behalf within the allowance, using the VC:',

    mcpTitle: 'MCP config (Claude Desktop / Code)',
    vcTitle: 'Authorization VC (for order verification)',
    copy: 'Copy',
    download: 'Download .json',
    copyMcpLabel: 'MCP config',
    copyVcLabel: 'Authorization VC',

    /** 匯出的 MCP 設定裡，私鑰欄位的預設佔位提示。 */
    privateKeyPlaceholder:
      '0x...   # Paste the agent private key you just generated/saved (keep it local, do not share)',
  },

  copied: '{label} copied ✓',
  copyFailed: 'Copy failed (browser clipboard permission)',

  /** See `../zh-TW/sessions.ts`. */
  delegation: {
    open: 'Delegation VC v3',
    title: 'Delegation credential v3 (W3C VC 2.0)',
    intro:
      "Sign this AI agent allowance's limits, asset allow-list and x402 spending caps into a verifiable credential that shows who authorized this agent and for what (Know Your Agent). Deployments with an anchor program can also anchor it on chain; the current deployment can only issue credentials and does not yet run on-chain anchoring or paid-API checks.",
    agentDid: 'Agent DID (holder)',
    issuerDid: 'Issuer DID (you)',
    sessionTerms: 'AI agent allowance limits (match the chain field by field)',
    assetsAll: 'Any asset',
    assetsCount: '{n} assets',
    x402Title: 'x402 spending caps',
    perPeriod: 'Cap per period (USDC)',
    periodHours: 'Period (hours)',
    total: 'Total cap (USDC)',
    endpoints: 'Allowed paid endpoints',
    validityDays: 'Credential validity (days)',
    issue: 'Issue v3 with wallet',
    signing: 'Signing…',
    anchor: 'Anchor on chain',
    anchoring: 'Anchoring…',
    anchored: 'Anchored',
    notAnchored: 'Not anchored',
    superseded: 'Superseded by a newer credential',
    anchorNotDeployed: 'SessionCredentialAnchor is not deployed on this chain: you can issue, but not anchor (paid APIs that require an anchor will refuse).',
    statusTitle: 'Status',
    statusActive: 'Active',
    statusRevoked: 'Revoked (status list)',
    statusExpired: 'Expired',
    statusSessionRevoked: 'On-chain AI agent allowance revoked',
    credentialHash: 'Credential hash (anchored value)',
    spendTitle: 'x402 spend (accumulated per credential by signal-api)',
    spendTotal: 'Total {spent} / {cap} USDC',
    spendPeriod: 'This period {spent} / {cap} USDC',
    spendUnavailable: 'signal-api has KYA disabled, or there is no spend yet.',
    showJson: 'View credential JSON',
    hideJson: 'Hide JSON',
    download: 'Download credential .json',
    revoke: 'Revoke this credential',
    revokeUnavailable: 'This site has no credential status list configured, so the published list cannot be read. Before revoking, import the list that is currently published (.json) below, or confirm that none was ever published (first revocation). The newly signed list will be downloaded; give it to verifiers. To stop the authorization right away, revoke the AI agent allowance: it takes effect on-chain immediately.',
    revokeCredentialInPanel: 'AI agent allowance revoked: it takes effect on-chain right away. Its delegation credential is not revoked yet. In the list, press "Delegation VC v3" for this allowance, then in the dialog import the current status list (or confirm this is the first revocation) and press Revoke. The signed list will be downloaded; give it to verifiers.',
    revokeListSkipped: 'AI agent allowance revoked: it takes effect on-chain right away. The credential status list was not signed this time, which does not affect revoking the allowance. To finish revoking the credential, use Revoke again in the delegation credential panel for this allowance (you can import the current list there).',
    revoking: 'Revoking…',
    revokedDownloaded: 'Revocation list signed (sequence {seq}) but not confirmed published (downloaded); hand it to the operator (npm run vc-status install), then press Confirm published. Until then the credential is still valid.',
    revokedPublished: 'Revocation list signed (sequence {seq}) and confirmed in the status directory.',
    revokeBaseUnavailable:
      "Could not read the currently published status list ({reason}), so nothing was signed: a revocation list must build on the published one, or verifiers reject it and the revocation does not take effect. Set VITE_VC_STATUS_URL, or import the current list and try again.",
    statusRevokePending: 'Revocation pending (sequence {seq}, not in effect yet)',
    revokedDownloadedNoStatus: 'Revocation list signed (sequence {seq}) and downloaded; give it to verifiers. This site has no credential status list configured, so it cannot confirm here whether verifiers have adopted it.',
    revokePendingNoteNoStatus: 'The revocation list is signed and downloaded, but this site has no credential status list configured, so it cannot confirm whether verifiers have adopted it; until they switch to the new list, this credential may still be accepted. To stop the authorization right away, revoke the AI agent allowance: it takes effect on-chain immediately.',
    revokePendingNote: 'The revocation list is signed but not confirmed published: until verifiers see it, this credential is still valid. To stop paid APIs right away, unanchor it first.',
    revokeAgain: 'Sign the revocation list again',
    confirmPublished: 'Confirm published',
    confirmingPublished: 'Checking…',
    revocationConfirmed: 'Revocation confirmed in the status directory; the credential is no longer valid.',
    revocationNotYetPublished: 'The status directory does not carry this revocation yet; the credential is still valid.',
    importHint: 'The published status list cannot be read (set VITE_VC_STATUS_URL, and the status host must allow CORS from this site). Import the one currently published (.json) and the revocation builds on it; if nothing was ever published, confirm that explicitly to sign sequence 1.',
    confirmNoList: 'Nothing has been published yet (first revocation)',
    confirmNoListPrompt:
      'The published status list could not be read ({reason}). Confirm this issuer has never published a status list? The revocation will be signed as sequence 1. If a list is in fact published, verifiers will reject this one and the revocation will not take effect — import the current list instead if unsure.',
    importList: 'Import current status list',
    importedList: 'Imported sequence {seq}',
    importFailed: 'Import failed: {reason}',
    unanchor: 'Unanchor',
    unanchoring: 'Unanchoring…',
    unanchoredToast: 'Unanchored: paid APIs that require the anchor now refuse this credential',
    anchorProblem: {
      anchor_no_code: 'The configured anchor address has no on-chain program on this chain; nothing was sent.',
      anchor_wrong_manager: 'The anchor program is bound to a different session manager than this credential; nothing was sent.',
      anchor_unreadable: 'Could not read the anchor program; nothing was sent.',
    },
    revokeWithSession: "Also revoke this AI agent allowance's v3 delegation credential? Your wallet will sign a status list once more.",
    issuedToast: 'v3 delegation credential issued',
    anchoredToast: 'Credential anchored on chain',
    close: 'Close',
    formError: {
      bad_usdc: 'Invalid USDC amount (at most 6 decimals)',
      bad_period: 'The period must be more than 0 hours',
      period_over_total: 'The per-period cap cannot exceed the total cap',
      no_endpoints: 'Allow at least one paid endpoint',
      session_expired: 'The AI agent allowance has expired; cannot issue',
    },
  },

  sessionManager: 'AgentSessionManager: {address}',

  /** 交易正在跑的時候按鈕上的字。 */
  working: '…',

  /** #36：十段句中夾標記的說明，各自拆成標記前後的片段。 */
  markup: {
    introBefore:
      'Let an AI agent invest for you, only within limits you set: per-order amount, total budget, allowed assets and an end date. It never gets your main wallet\'s private key, and you can revoke access at any time.',
    introTech: 'Each agent has a ',
    introMid: ' identity, and the authorization can be credentialed as a ',
    introAfter:
      ' that is checked before an order.',

    roleIssuerBefore: '🖊️ ',
    roleIssuerBold: 'Issuer=you',
    roleIssuerAfter: ': sign the authorization VC with MetaMask (the private key never leaves the wallet)',
    roleHolderBefore: '🤖 ',
    roleHolderBold: 'Holder=agent',
    roleHolderAfter: ': holds the VC + session key to place orders on your behalf',
    roleVerifierBefore: '✅ ',
    roleVerifierBold: 'Verifier=MCP/on-chain program',
    roleVerifierAfter: ': verifies the signature before the order + cross-checks the on-chain AI agent allowance',

    wrongNetBefore: 'AI agent allowances are deployed on ',
    wrongNetMid: '. You are currently connected to',
    wrongNetAfter: ' — please switch to Base Sepolia in MetaMask and reload this page.',

    keyNoteBold1: 'The AI agent uses a separate key, not your main wallet',
    keyNoteMid1: ': ',
    keyNoteBold2: 'Address',
    keyNoteMid2: ' → used to authorize the AI agent allowance below; ',
    keyNoteBold3: 'Private key',
    keyNoteAfter:
      " → goes into the agent's MCP config, plus a little ETH for gas. If you don't have one yet, click \"Generate agent key\" to create a new burner in the browser.",

    burnerWarnBefore:
      'This is a separate burner key, bound only by the AI agent allowance you set below. Save it to your local agent config — ',
    burnerWarnBold: "don't fund it like your main wallet",
    burnerWarnAfter: '. This page shows it only once, and it is never uploaded or written to a server.',

    step1Before: 'Paste the ',
    step1Bold: 'MCP config',
    step1Mid1: " into Claude Desktop/Code's ",
    step1Mid2: ', and replace ',
    step1After: " with your local agent's session key. Also clone the repo, install its dependencies, and replace /path/to/… in the config with your local path.",
    step2Before: 'Save the ',
    step2Bold: 'authorization VC',
    step2Mid1: ' as a file; when the agent places an order, point ',
    step2Mid2: ' at it (or the MCP ',
    step2Mid3: "'s ",
    step2After: ').',
    step3:
      'Once that\'s done, just tell the AI agent: "Buy BTC with 200 USDC" — no need to give an account or address.',

    addrKeyBold1: 'Address',
    addrKeyMid1: ' (',
    addrKeyMid2: ') = the agent authorized on-chain, held in the session / VC; ',
    addrKeyBold2: 'Private key',
    addrKeyAfter: ' = the value for this address, kept only in your local agent config as ',
    addrKeyTail: '. The two are the public and secret sides of the same key.',

    includeKeyBefore: 'Fill the agent private key I just generated into ',
    includeKeyAfter: ' (contains the real key — use only on your own machine)',
    includeKeyRiskTitle: 'The private key is not embedded by default',
    includeKeyRisk:
      'The exported config contains only a placeholder by default. If you tick the box, the JSON below will contain this agent’s private key in plain text: anyone who gets the file (or sees your screen, clipboard or a cloud-synced folder) can place orders under your authorization within the AI agent allowance and its expiry. Use it only on your own machine; never paste it into chat, tickets or version control. If it leaks, revoke the allowance immediately.',
    includeKeyOnWarning: 'This config now contains a plain-text private key. Store it carefully after copying or downloading, and delete it when done.',

    placeholderAfter:
      ' is a placeholder — paste in the agent private key you saved (the one generated on this page with "Generate agent key"; you can check the box to auto-fill it).',

    finalWarnBefore: 'The agent private key stays only in your local agent config — ',
    finalWarnBold1: 'do not leak it',
    finalWarnMid1:
      ". The private key exists only in your browser's memory (never written to a server or database); the default exported ",
    finalWarnMid2: ' is a placeholder string — only when you ',
    finalWarnBold2: 'explicitly check "Fill in private key"',
    finalWarnAfter:
      ' will it contain the real key — in that case, do not paste this JSON anywhere public or share it with anyone.',
  },
};
