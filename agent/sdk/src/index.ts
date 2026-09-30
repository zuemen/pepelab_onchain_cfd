// @pepelab/sdk —— 給機構客戶整合 PepeFi 用的 TypeScript SDK。
//
//   read        唯讀 client（viem；同一區塊一致讀取）
//   write       交易建構（只回 {to,data,value,request}，不簽不送；平倉永不受限）
//   signalApi   signal-api 型別化 client（逾時、只對冪等 GET 重試、x402 由呼叫端注入）
//   vc          Agent 授權 VC v2（EIP-712）建構與驗證（拒絕 v1）
//
// SDK 不持有、不讀取任何私鑰。
export * from "./addresses.ts";
export * from "./format.ts";
export * from "./abis.ts";
export * from "./read.ts";
export * from "./write.ts";
export * from "./errors.ts";
export * from "./signalApiTypes.ts";
export * from "./signalApi.ts";
export * from "./vc.ts";
