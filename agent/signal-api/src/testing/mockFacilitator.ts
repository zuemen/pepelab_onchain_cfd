// 本機假 x402 facilitator（v1 與 v2 共用）。只給離線測試與 examples 用，**不連網、不送交易、不付款**；
// 不會被打包進 Vercel bundle（vercel-entry 不 import 它）。
//
// 它不是橡皮圖章：/verify 會**真的**驗 EIP-3009 TransferWithAuthorization 的 EIP-712 簽章
// （ethers.verifyTypedData）、收款地址、金額、有效期與 nonce 是否用過——所以用它跑通的測試能證明
// 「client 簽出來的東西，一個照規格檢查的 facilitator 會接受」。差別只在 /settle：真的 facilitator
// 會送一筆鏈上交易，這裡只把 nonce 記成已使用、回一個由 nonce 推導的假 tx hash。
//
// 線路格式（v1 的 x402 0.5.3 useFacilitator 與 v2 的 @x402/core 2.28 HTTPFacilitatorClient 相同）：
//   POST /verify、/settle  body = { x402Version, paymentPayload, paymentRequirements }
//   GET  /supported        → { kinds, extensions, signers }
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ethers } from "ethers";

const TWA_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

const CHAIN_IDS: Record<string, number> = {
  "base-sepolia": 84532,
  "eip155:84532": 84532,
};

export type MockFacilitatorMode =
  | "ok"
  /** /verify 回 HTTP 429（非結構化）。 */
  | "verify_http429"
  /** /verify 回 HTTP 503（空 body）。 */
  | "verify_http503"
  /** /verify 回 200 + isValid:false、invalidReason=rate_limit_exceeded（CDP 的限流形狀）。 */
  | "verify_invalid_rate_limit"
  /** /settle 回 HTTP 503。 */
  | "settle_http503"
  /** /settle 回 HTTP 429。 */
  | "settle_http429"
  /** /settle 回 200 + success:false（facilitator 明確拒絕）。 */
  | "settle_rejected"
  /** /supported 回 HTTP 503。 */
  | "supported_http503";

export interface MockFacilitatorCall {
  path: string;
  x402Version?: number;
  body?: any;
}

export interface MockFacilitator {
  url: string;
  mode: MockFacilitatorMode;
  /** 每一次呼叫（依序）。 */
  calls: MockFacilitatorCall[];
  count(path: "/verify" | "/settle" | "/supported"): number;
  /** 已「結算」的 nonce（付款人小寫:nonce 小寫）。 */
  settledNonces: Set<string>;
  reset(): void;
  close(): Promise<void>;
}

interface Checked {
  ok: boolean;
  reason?: string;
  payer?: string;
  nonceKey?: string;
  network?: string;
}

/** 照 exact／EIP-3009 的規則檢查一筆付款（v1、v2 兩種形狀）。 */
function check(body: any, settledNonces: Set<string>): Checked {
  const version = body?.x402Version;
  const payload = body?.paymentPayload;
  const req = body?.paymentRequirements;
  if (version !== 1 && version !== 2) return { ok: false, reason: "invalid_x402_version" };
  if (payload?.x402Version !== version) return { ok: false, reason: "invalid_x402_version" };
  const scheme = version === 1 ? payload?.scheme : payload?.accepted?.scheme;
  const network = version === 1 ? payload?.network : payload?.accepted?.network;
  if (scheme !== "exact" || req?.scheme !== "exact") return { ok: false, reason: "unsupported_scheme" };
  if (network !== req?.network) return { ok: false, reason: "invalid_network" };
  const chainId = CHAIN_IDS[String(network)];
  if (!chainId) return { ok: false, reason: "invalid_network" };
  // v1 的網路名稱只能配 v1、CAIP-2 只能配 v2。
  if ((version === 1) !== !String(network).includes(":")) return { ok: false, reason: "invalid_network" };
  if (req?.extra?.assetTransferMethod && req.extra.assetTransferMethod !== "eip3009") {
    return { ok: false, reason: "unsupported_asset_transfer_method" };
  }

  const auth = payload?.payload?.authorization;
  const signature = payload?.payload?.signature;
  if (!auth || typeof signature !== "string") return { ok: false, reason: "invalid_payload" };
  const amount = version === 1 ? req?.maxAmountRequired : req?.amount;
  const name = req?.extra?.name;
  const ver = req?.extra?.version;
  if (typeof name !== "string" || typeof ver !== "string") return { ok: false, reason: "missing_eip712_domain" };

  let signer: string;
  try {
    signer = ethers.verifyTypedData(
      { name, version: ver, chainId, verifyingContract: req.asset },
      TWA_TYPES,
      {
        from: auth.from,
        to: auth.to,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce,
      },
      signature,
    );
  } catch {
    return { ok: false, reason: "invalid_exact_evm_payload_signature" };
  }
  const payer = ethers.getAddress(auth.from);
  if (signer !== payer) return { ok: false, reason: "invalid_exact_evm_payload_signature", payer };
  if (ethers.getAddress(auth.to) !== ethers.getAddress(req.payTo)) {
    return { ok: false, reason: "invalid_exact_evm_payload_recipient_mismatch", payer };
  }
  if (BigInt(auth.value) !== BigInt(amount)) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_value", payer };
  }
  const now = Math.floor(Date.now() / 1000);
  // 與真的 facilitator 相同：只檢查下界（now+6）與 validAfter，不檢查 validBefore 上界（KNOWN_LIMITATIONS §15）。
  if (BigInt(auth.validBefore) < BigInt(now + 6)) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_before", payer };
  }
  if (BigInt(auth.validAfter) > BigInt(now)) {
    return { ok: false, reason: "invalid_exact_evm_payload_authorization_valid_after", payer };
  }
  const nonceKey = `${payer.toLowerCase()}:${String(auth.nonce).toLowerCase()}`;
  if (settledNonces.has(nonceKey)) return { ok: false, reason: "authorization_nonce_already_used", payer, nonceKey };
  return { ok: true, payer, nonceKey, network: String(network) };
}

export async function startMockFacilitator(): Promise<MockFacilitator> {
  const settledNonces = new Set<string>();
  const calls: MockFacilitatorCall[] = [];
  const state = { mode: "ok" as MockFacilitatorMode };

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0]!;
    const json = (status: number, body: unknown) =>
      res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));

    if (req.method === "GET" && path === "/supported") {
      calls.push({ path });
      if (state.mode === "supported_http503") return void res.writeHead(503).end();
      return void json(200, {
        kinds: [
          { x402Version: 2, scheme: "exact", network: "eip155:84532" },
          { x402Version: 1, scheme: "exact", network: "base-sepolia" },
        ],
        extensions: [],
        signers: { "eip155:*": ["0x" + "fa".repeat(20)] },
      });
    }
    if (req.method !== "POST" || (path !== "/verify" && path !== "/settle")) {
      return void res.writeHead(404).end();
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    let body: any;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return void res.writeHead(400).end();
    }
    calls.push({ path, x402Version: body?.x402Version, body });

    if (path === "/verify") {
      if (state.mode === "verify_http429") return void json(429, { error: "rate_limit_exceeded" });
      if (state.mode === "verify_http503") return void res.writeHead(503).end();
      const r = check(body, settledNonces);
      if (state.mode === "verify_invalid_rate_limit") {
        return void json(200, { isValid: false, invalidReason: "rate_limit_exceeded", payer: r.payer });
      }
      return void json(200, r.ok ? { isValid: true, payer: r.payer } : { isValid: false, invalidReason: r.reason, payer: r.payer });
    }

    // /settle
    if (state.mode === "settle_http503") return void res.writeHead(503).end();
    if (state.mode === "settle_http429") return void json(429, { error: "rate_limit_exceeded" });
    const r = check(body, settledNonces);
    const network = body?.paymentRequirements?.network;
    if (!r.ok || state.mode === "settle_rejected") {
      return void json(200, {
        success: false,
        errorReason: r.ok ? "insufficient_funds" : r.reason,
        payer: r.payer,
        transaction: "",
        network,
      });
    }
    settledNonces.add(r.nonceKey!);
    return void json(200, {
      success: true,
      payer: r.payer,
      // 假 tx hash：由 nonce 推導，同一張授權永遠對應同一個 hash。
      transaction: ethers.keccak256(ethers.toUtf8Bytes(`mock-settle:${r.nonceKey}`)),
      network,
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    get mode() {
      return state.mode;
    },
    set mode(m: MockFacilitatorMode) {
      state.mode = m;
    },
    calls,
    count: (p) => calls.filter((c) => c.path === p).length,
    settledNonces,
    reset() {
      calls.length = 0;
      settledNonces.clear();
      state.mode = "ok";
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
