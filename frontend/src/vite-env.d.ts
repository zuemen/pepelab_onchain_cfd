/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 這個 build 要出貨的語言（`zh-TW` 或 `en`），沒設就用租戶設定的 defaultLocale（default 租戶是 `zh-TW`）。
   * 認不出來的值同樣退回租戶的 defaultLocale 並留一行 warn，見 src/locales/catalogs.ts。
   */
  readonly VITE_LOCALE?: string;
  /**
   * 白標租戶 id（`src/tenant/tenants/<id>.json`），沒設就是 `default`。
   * 認不出來的值會讓 build 失敗，不會退回預設，見 src/tenant/schema.ts。
   */
  readonly VITE_TENANT?: string;
  /**
   * 商業版功能旗標，見 src/lib/pepefi/featureFlags.ts 與 .env.example。
   * 只能在租戶授權範圍內打開（src/tenant/flags.ts）。
   */
  readonly VITE_SHOW_LEVERAGE?: string;
  readonly VITE_SHOW_PERPETUALS?: string;
  readonly VITE_FEATURE_GAMEFI?: string;
  readonly VITE_FEATURE_PEPE_REWARDS?: string;
  readonly VITE_FEATURE_COPY_TRADING?: string;
  readonly VITE_ENABLE_MOCK_WALLET?: string;
  /** SessionCredentialAnchor 位址（覆寫 src/contracts/sessionCredentialAnchor.ts 的表；只套用在 VITE_SESSION_ANCHOR_CHAIN_ID 那條鏈）。 */
  readonly VITE_SESSION_ANCHOR_ADDRESS?: string;
  /** VITE_SESSION_ANCHOR_ADDRESS 套用的 chainId（預設 31337＝本機 anvil）。 */
  readonly VITE_SESSION_ANCHOR_CHAIN_ID?: string;
  /** 驗證端讀取的狀態清單目錄（`<base>/<issuer>.json`，同 agent 的 VC_STATUS_URL）；撤銷前讀目前的清單、撤銷後確認已發佈。 */
  readonly VITE_VC_STATUS_URL?: string;
  /** 撤銷 v3 委託憑證時，把簽好的 ADR-016 狀態清單 POST 到這裡；沒設就下載交給營運方。 */
  readonly VITE_VC_STATUS_PUBLISH_URL?: string;
}

/**
 * build 時由 vite.config.ts 注入（src/lib/pepefi/buildMeta.ts）：commit 短 SHA 與 build 時間。
 * vitest 不注入，讀之前一律先 `typeof __BUILD_INFO__ === 'undefined'`（src/lib/pepefi/buildInfo.ts）。
 */
declare const __BUILD_INFO__: { sha: string | null; builtAt: string } | undefined;

// Note: `window.ethereum` is declared once in src/hooks/useWallet.ts via
// `declare global`, using ethers' own Eip1193Provider type. Do not redeclare it
// here — a second, weaker declaration conflicts with it (TS2717) and makes the
// event handlers optional, which breaks useWallet's listener wiring.
