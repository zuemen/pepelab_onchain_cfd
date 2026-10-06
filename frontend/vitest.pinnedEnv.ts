// 單元測試固定的環境變數（vitest.config.ts 的 test.env 用；src/testEnvPinning.test.ts 斷言內容）。
//
// 為什麼要固定：單元測試斷言的是 default 租戶（＝正式站）的行為。這些變數在**模組載入時**
// 就被讀進常數（租戶、語系、功能旗標、signal-api 網址），shell 或 .env.local 裡殘留一個
// VITE_LOCALE=en、VITE_FEATURE_GAMEFI=1，整批斷言就會因為「跑測試的環境」而失敗或變質。
// 全部固定為 ''——每個讀取端都把空字串當成「未設定」，結果等於正式站的預設值。
//
// 用明確白名單而不是掃描：新增一個 env 時要有人決定它會不會影響斷言。
// src/testEnvPinning.test.ts 會掃 src 讀到的所有 VITE_*，任何一個既不在這裡、也不在
// NOT_PINNED（附理由）裡，測試就失敗。

/** 固定為 '' 的變數。 */
export const PINNED_ENV = [
  // 租戶：vitest.config.ts 的 @tenant-config alias 固定指向 default.json，兩者必須一致。
  'VITE_TENANT',
  // 語系：src/locales/index.ts 在載入時選 catalog；測試斷言的是 zh-TW（default 租戶預設）。
  'VITE_LOCALE',
  // 功能旗標：src/lib/pepefi/featureFlags.ts 在載入時解析。
  'VITE_SHOW_LEVERAGE',
  'VITE_SHOW_PERPETUALS',
  'VITE_FEATURE_GAMEFI',
  'VITE_FEATURE_PEPE_REWARDS',
  'VITE_FEATURE_COPY_TRADING',
  'VITE_ENABLE_MOCK_WALLET',
  // signal-api 網址：signalApi.ts／candles.ts／benchmarks.ts 在載入時決定打哪個端點。
  'VITE_SIGNAL_API_URL',
  // 靜態資產前綴：global-config.ts 的 CONFIG.assetsDir，會進圖片網址。
  'VITE_ASSETS_DIR',
  // v3 委託憑證（docs/SSI_AGENT_DELEGATION.md）：錨定合約位址覆寫、撤銷清單發佈端點。
  'VITE_SESSION_ANCHOR_ADDRESS',
  'VITE_SESSION_ANCHOR_CHAIN_ID',
  'VITE_VC_STATUS_PUBLISH_URL',
  'VITE_VC_STATUS_URL',
] as const;

/**
 * src 有讀、但刻意**不**固定的變數與理由。範本的第三方登入設定只在 authRoutes 的範本登入頁
 * 用到，沒有任何單元測試碰得到；固定它們不會多保護什麼。
 */
export const NOT_PINNED: Readonly<Record<string, string>> = {
  VITE_SERVER_URL: '範本 JWT 登入的 axios baseURL，單元測試不發網路請求',
  VITE_AUTH: '範本登入方式選擇，只在 authRoutes 用到',
  VITE_AUTH0_CLIENT_ID: '範本第三方登入設定',
  VITE_AUTH0_DOMAIN: '範本第三方登入設定',
  VITE_AUTH0_CALLBACK_URL: '範本第三方登入設定',
  VITE_AWS_AMPLIFY_REGION: '範本第三方登入設定',
  VITE_AWS_AMPLIFY_USER_POOL_ID: '範本第三方登入設定',
  VITE_AWS_AMPLIFY_USER_POOL_WEB_CLIENT_ID: '範本第三方登入設定',
  VITE_FIREBASE_API_KEY: '範本第三方登入設定',
  VITE_FIREBASE_APPID: '範本第三方登入設定',
  VITE_FIREBASE_AUTH_DOMAIN: '範本第三方登入設定',
  VITE_FIREBASE_MEASUREMENT_ID: '範本第三方登入設定',
  VITE_FIREBASE_MESSAGING_SENDER_ID: '範本第三方登入設定',
  VITE_FIREBASE_PROJECT_ID: '範本第三方登入設定',
  VITE_FIREBASE_STORAGE_BUCKET: '範本第三方登入設定',
  VITE_SUPABASE_ANON_KEY: '範本第三方登入設定',
  VITE_SUPABASE_URL: '範本第三方登入設定',
  VITE_VC_KYC_REGISTRY:
    'VC 准入登錄位址（docs/SSI_RWA_ACCESS.md）；只在 vcKycRegistry.ts 的函式內讀取，單元測試以參數注入位址，不讀 env',
};

export const pinnedEnv = (): Record<string, string> =>
  Object.fromEntries(PINNED_ENV.map((name) => [name, '']));
