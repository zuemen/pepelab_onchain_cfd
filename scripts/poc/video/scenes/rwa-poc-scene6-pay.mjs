// 補拍第 6 景（代理人入金後）：只錄 x402 這一段，之後插回成片。流程見 docs/tenants/rwa-poc/POC_SCRIPT.md「補拍流程」。
//
//   node record.mjs --scenes scenes/rwa-poc-scene6-pay.mjs --base http://localhost:4173 --no-sign
//   node postprocess.mjs --main out/<完整版>.json --replace-scene 6=out/<這次>.json
import { scene6Paid } from './scene6-x402.mjs';

export default { name: 'rwa-poc-scene6-pay', role: 'agent', lead: 3000, steps: scene6Paid };
