// x402 收入「真上鏈結算」：把付費訊號的費用透過 FeeRouter.routeExternalRevenue
// 真的走 70/20/10 分潤（70% 歸該 trader）。
//
// 啟用方式：在 .env 設 FEE_SETTLEMENT_PRIVATE_KEY（一個在 Base Sepolia 上、
// 持有 mUSDC + 少量 ETH 的測試金鑰）。未設則停用，僅保留鏈下帳務（/revenue）。
import { ethers } from "ethers";
import { loadEnv, makeProvider, ADDRESSES, resolveSettlementToken } from "@pepelab/shared";

loadEnv();

const FEE_ROUTER_ABI = [
  "function routeExternalRevenue(address trader, uint256 fee)",
  "function usdc() view returns (address)",
];
const USDC_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function mint(address to, uint256 amount)", // MockUSDC only (TESTNET); real USDC reverts → skipped
];

const PK = process.env.FEE_SETTLEMENT_PRIVATE_KEY?.trim();

// A0: settlement currency is configurable so x402 revenue can settle in the
// SAME token the agent paid (official Base Sepolia USDC, 6-dec) via a dedicated
// FeeRouter, while the perp engine keeps MockUSDC.
//
// 稽核（四·Medium）：這裡以前的預設值是 `ADDRESSES.MockUSDC`，而 app.ts 的預設值是
// 官方 USDC —— 兩個不同的預設值意味著 `_assertCurrencyMatch` 比對的根本不是對外
// 宣告的那個 token，永遠抓不到誤配。現在兩邊都走 shared 的 `resolveSettlementToken()`。
const SETTLEMENT_TOKEN = resolveSettlementToken();
const SETTLEMENT_ROUTER =
  process.env.X402_FEE_ROUTER?.trim() || ADDRESSES.FeeRouter;
/** 只有這一顆是可以自助鑄幣的測試代幣；其它 token 一律不嘗試 mint。 */
const MINTABLE_MOCK_USDC = ADDRESSES.MockUSDC;

let wallet: ethers.Wallet | null = null;
let feeRouter: ethers.Contract | null = null;
let usdc: ethers.Contract | null = null;

if (PK && PK.startsWith("0x") && PK.length === 66) {
  const provider = makeProvider();
  wallet = new ethers.Wallet(PK, provider);
  feeRouter = new ethers.Contract(SETTLEMENT_ROUTER, FEE_ROUTER_ABI, wallet);
  usdc = new ethers.Contract(SETTLEMENT_TOKEN, USDC_ABI, wallet);
}

export function isSettlementEnabled(): boolean {
  return wallet !== null;
}

export interface SettlementResult {
  status: "settled" | "failed";
  tx?: string;
  error?: string;
}

// 序列化所有結算：fire-and-forget 的並發呼叫共用同一個 EOA，若同時送會撞 nonce。
// 用 promise chain 確保一次只送一筆。
//
// ⚠ 誠實邊界（稽核 四·Medium）：這個 queue 是**程序內**的。Vercel 會同時跑多個
// 實例，每個實例各有一條 queue，卻共用同一把 FEE_SETTLEMENT_PRIVATE_KEY —— 跨實例
// 的並發仍然會撞 nonce（症狀：`replacement transaction underpriced` / `nonce too low`，
// 結算失敗但付費者已拿到資料，故只影響分潤紀錄不影響商品交付）。真正的修法是把結算
// 移出請求路徑（佇列 + 單一 worker）或每個實例用不同的簽章金鑰；在那之前，
// `settleError` 會如實回傳給呼叫端，不會被吞掉。
let queue: Promise<unknown> = Promise.resolve();

/**
 * 把一筆費用（USD）上鏈分潤給 trader。會自動確保 mUSDC 餘額與對 FeeRouter 的
 * 授權（不足才送交易）。多筆呼叫會自動排隊（避免 nonce 衝突）。回傳結果含 tx hash。
 */
export function settleRevenue(trader: string, feeUsd: number): Promise<SettlementResult> {
  const run = queue.then(() => _settle(trader, feeUsd));
  // 讓 queue 不論成敗都接續下去
  queue = run.catch(() => undefined);
  return run;
}

// 一次性檢查：結算 token 必須 == FeeRouter 綁定的 usdc()，否則會 approve A、
// router 卻 pull/分潤 B → routeExternalRevenue 在金庫 depositFromProtocol 處 revert。
// 把「靜默失敗」變成明確錯誤（最常見的 .env 誤配：X402_FEE_ROUTER 留空回退到
// MockUSDC router，但 X402_SETTLEMENT_TOKEN 是官方 USDC）。
let currencyChecked = false;
async function _assertCurrencyMatch(): Promise<string | null> {
  if (currencyChecked) return null;
  try {
    const routerUsdc = (await feeRouter!.usdc()) as string;
    if (routerUsdc.toLowerCase() !== SETTLEMENT_TOKEN.toLowerCase()) {
      return (
        `結算幣別不符：X402_SETTLEMENT_TOKEN=${SETTLEMENT_TOKEN} 但 ` +
        `X402_FEE_ROUTER.usdc()=${routerUsdc}。請先用 DeployX402Router.s.sol 部署官方 USDC ` +
        `的 FeeRouter 並把位址填進 X402_FEE_ROUTER（見 .env.example）。`
      );
    }
    currencyChecked = true;
    return null;
  } catch (err) {
    return `無法讀取 FeeRouter.usdc()（位址錯誤？）：${(err as Error).message}`;
  }
}

// 註：x402 付款由 facilitator 結算到 payTo；本函式另以結算錢包餘額透過 FeeRouter
// 補上對應金額的 70/20/10「鏈上分潤紀錄」。即分潤金額對得上、但非與該筆 x402
// 付款原子綁定（demo 帳務）。正式可改為直接從 payTo 收款後原子路由。
async function _settle(trader: string, feeUsd: number): Promise<SettlementResult> {
  if (!wallet || !feeRouter || !usdc) {
    return { status: "failed", error: "settlement disabled" };
  }
  const mismatch = await _assertCurrencyMatch();
  if (mismatch) return { status: "failed", error: mismatch };
  try {
    // 依結算 token 的實際小數位換算（官方 USDC=6, MockUSDC=18）。
    const decimals = Number(await usdc.decimals());
    const atomic = ethers.parseUnits(feeUsd.toString(), decimals);
    const me = wallet.address;

    // 確保餘額。只有已知的 MockUSDC 才嘗試自助鑄幣 —— 舊版對**任意** token 都無條件
    // 先試 `mint()`（稽核 四·Low）：對真 USDC 那是一筆注定 revert 的交易（估 gas 就
    // 會失敗、浪費 RPC 來回），對某個剛好有 `mint(address,uint256)` 的第三方合約則是
    // 一個沒人預期會被觸發的寫呼叫。官方 USDC 只能用既有餘額（來自 x402 付款）。
    const bal = (await usdc.balanceOf(me)) as bigint;
    if (bal < atomic) {
      const mintable =
        SETTLEMENT_TOKEN.toLowerCase() === MINTABLE_MOCK_USDC.toLowerCase();
      if (!mintable) {
        return {
          status: "failed",
          error:
            `結算 token 餘額不足（${SETTLEMENT_TOKEN}，非可鑄幣的 MockUSDC）。` +
            `treasury 需先收到 x402 付款的 USDC。`,
        };
      }
      try {
        const mintTx = await usdc.mint(me, atomic * 1000n);
        await mintTx.wait();
      } catch (e) {
        return {
          status: "failed",
          error: `MockUSDC 鑄幣失敗：${(e as Error).message}`,
        };
      }
    }

    // 確保授權
    const allowance = (await usdc.allowance(me, SETTLEMENT_ROUTER)) as bigint;
    if (allowance < atomic) {
      const apTx = await usdc.approve(SETTLEMENT_ROUTER, ethers.MaxUint256);
      await apTx.wait();
    }

    const tx = await feeRouter.routeExternalRevenue(trader, atomic);
    await tx.wait();
    return { status: "settled", tx: tx.hash };
  } catch (err) {
    return { status: "failed", error: (err as Error).message };
  }
}
