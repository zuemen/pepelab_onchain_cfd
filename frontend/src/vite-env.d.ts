/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * 這個 build 要出貨的語言（`zh-TW` 或 `en`），沒設就是 `zh-TW`。
   * 認不出來的值會退回預設並留一行 warn，見 src/locales/catalogs.ts。
   */
  readonly VITE_LOCALE?: string;
  /** 商業版功能旗標，見 src/lib/pepefi/featureFlags.ts 與 .env.example。 */
  readonly VITE_FEATURE_GAMEFI?: string;
  readonly VITE_FEATURE_PEPE_REWARDS?: string;
  readonly VITE_FEATURE_COPY_TRADING?: string;
  readonly VITE_ENABLE_MOCK_WALLET?: string;
}

// Note: `window.ethereum` is declared once in src/hooks/useWallet.ts via
// `declare global`, using ethers' own Eip1193Provider type. Do not redeclare it
// here — a second, weaker declaration conflicts with it (TS2717) and makes the
// event handlers optional, which breaks useWallet's listener wiring.
