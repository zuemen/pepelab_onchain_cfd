// `@tenant-deployment` 是建置期 alias（vite.config.ts / vitest.config.ts），指向
// src/contracts/deployments/<VITE_TENANT>.json。型別刻意是 unknown：內容一律經過
// parseTenantDeployment() 驗證才能用。
declare module '@tenant-deployment' {
  const value: unknown;
  export default value;
}
