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
}

// Note: `window.ethereum` is declared once in src/hooks/useWallet.ts via
// `declare global`, using ethers' own Eip1193Provider type. Do not redeclare it
// here — a second, weaker declaration conflicts with it (TS2717) and makes the
// event handlers optional, which breaks useWallet's listener wiring.
