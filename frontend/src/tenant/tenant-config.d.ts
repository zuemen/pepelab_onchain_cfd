// `@tenant-config` 是建置期 alias（vite.config.ts / vitest.config.ts），指向
// src/tenant/tenants/<VITE_TENANT>.json。型別刻意是 unknown：內容一律經過
// parseTenant() 驗證才能用，不讓任何程式碼跳過驗證直接讀 JSON。
declare module '@tenant-config' {
  const value: unknown;
  export default value;
}
