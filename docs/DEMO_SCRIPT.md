# Demo Script — On-Chain CFD Copy Trading PoC

## ⚡ One-command end-to-end（P3-3，最快路徑）

整個鏈上故事一行跑完，不需 anvil / 前端 / 錢包，**deterministic 並印出每步關鍵數字**：

```bash
cd contracts && forge script script/DemoE2E.s.sol:DemoE2E -vv
```

依序展示：① 上架 RWA 標的 XAU（KYC + 2x 槓桿上限 N3）→ ② 未 KYC 開倉被擋、KYC 後成功（G2）
→ ③ LP 注入做市金庫（N1）→ ④ 使用者委派有界 agent session（Phase 2）→ ⑤ agent **經 session 自主下單**
→ ⑥ mark vs index 價（OI 失衡溢價 G6）→ ⑦ 交易費推升金庫 share price＝LP 收益（N1）
→ ⑧ 崩盤清算：**保險金庫優先兜底、再 ADL 對獲利方減倉**（N2）。

要在本機鏈上產生真實 tx hash，改跑：
```bash
anvil   # terminal 1
cd contracts && forge script script/DemoE2E.s.sol:DemoE2E --broadcast --rpc-url http://localhost:8545
```

**x402「付費讀訊號 → 決策」那段**是鏈下 agent 棧，見 `agent/README.md`：
`npm run signal-api` + `npm run demo-agent`（本腳本涵蓋 agent 下單最終落地的鏈上半邊）。

前端互動式 demo 走訪見下方「五分鐘展示腳本」。

---

## 5-Minute Walkthrough · 五分鐘展示腳本

> **Prerequisites 前置條件**
> - Anvil running: `anvil` (terminal 1)
> - Deploy + Seed: `bash deploy-anvil.sh && bash seed-anvil.sh` (terminal 2)
> - Frontend: `cd frontend && npm run dev` (terminal 3)
> - MetaMask: import **two** Anvil accounts
>   - Account A (Trader / oracle owner): `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80`
>   - Account B (Follower): `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d`
> - MetaMask network: Anvil Local (chainId 31337, RPC http://localhost:8545)
>
> **Note:** `seed-anvil.sh` pre-creates **Demo Alpha** (Account A) and **Demo Beta** (Account B) with strategies already published — you can skip Steps 1–4 and jump straight to Step 2 to experience copy-trading immediately.

---

## Step 1 — Trader registers & publishes strategy (1 min)

**Switch to Account A in MetaMask**

1. Open `http://localhost:5173` → Click **Connect Wallet**
2. Nav → **Trader**
3. **A. Register Trader**
   - Enter name: `AlphaTrader`
   - Click **Register** → confirm tx → toast ✓

4. **B. Publish Strategy** — click "+ Add Asset" three times:

| Asset | Direction | Leverage | Weight |
|-------|-----------|----------|--------|
| sBTC  | Long ↑    | 2×       | 50     |
| sETH  | Short ↓   | 1×       | 30     |
| sAAPL | Long ↑    | 1×       | 20     |

   - Progress bar shows **100.00%** (green)
   - Click **Publish Strategy** → confirm → toast ✓

5. **C. Strategy History** — expand `v0` to verify allocations

---

## Step 2 — Follower copies the strategy (1.5 min)

**Switch to Account B in MetaMask**

6. Reconnect wallet (Header → Disconnect → Connect Wallet → select Account B)
7. Nav → **Exchange**
8. **Faucet** → Click **Get 1 000 mUSDC** → wait for tx ✓
9. Nav → **Marketplace**
   - See `AlphaTrader` in the table
   - Click **Copy** → taken to `/copy/<trader-address>`

10. On **CopyPage**:
    - Verify strategy badges: `↑ sBTC 50% 2×`, `↓ sETH 30% 1×`, `↑ sAAPL 20% 1×`
    - Total margin: `1000` mUSDC (default)
    - Preview shows margin split: BTC 500, ETH 300, AAPL 200
    - **Step 1**: Click **Approve mUSDC** → confirm → `✓ Approved`
    - **Step 2**: Click **Follow Trader** → confirm → redirected to **Portfolio**

---

## Step 3 — View portfolio (30 sec)

11. **Portfolio** page loads automatically:
    - **A. Copy Positions**: 1 active record, `AlphaTrader`, initial = 1 000 mUSDC
    - **B. Open Positions**: 3 rows (sBTC long, sETH short, sAAPL long)
      - All PnL = ±0 (just opened at current oracle prices)
    - **D. Performance chart**: flat line (Initial ≈ Current)

---

## Step 4 — Admin updates oracle prices (1 min)

**Switch back to Account A** (oracle owner)

12. Nav → **Admin** (append `/admin/oracle` manually or add to nav)
13. Update prices to simulate market movement:

| Asset | New Price | Change |
|-------|-----------|--------|
| sBTC  | 55000     | +10%   |
| sETH  | 2700      | −10%   |
| sAAPL | 210       | +5%    |

    - For each row: type new price → **Update Price** → confirm → ✓

---

## Step 5 — Observe PnL change (30 sec)

**Switch back to Account B**

14. Nav → **Portfolio** → Click **↺ Refresh**
15. **B. Open Positions** PnL column:
    - sBTC LONG: **+green** (+10% price × 2× lev × 500 margin = **+100 USDC**)
    - sETH SHORT: **+green** (price fell 10% × 1× lev × 300 margin = **+30 USDC**)
    - sAAPL LONG: **+green** (+5% × 1× × 200 = **+10 USDC**)
    - **Total unrealized PnL ≈ +140 USDC** (+14% on 1 000 USDC)
16. **D. Performance chart**: line rises above initial reference (yellow dashed)

---

## Step 6 — Unfollow & close all positions (30 sec)

17. **A. Copy Positions** → Click **Unfollow** next to AlphaTrader
    - Confirms tx → `unfollowAndCloseAll` closes all 3 positions
    - PnL realized, margin + profit returned to freeMargin
18. **C. Free Margin** shows ≈ **1 140 mUSDC** (initial 1 000 + 140 profit)
    - Click **Withdraw** to retrieve funds

---

## Key Talking Points 核心說明要點

| Topic | Detail |
|-------|--------|
| 合成衍生品 | 無實際資產，以 USDC 保證金模擬 CFD 損益 |
| 跟單機制 | 一鍵複製交易者策略，按配置比例自動開倉 |
| 價格預言機 | MockOracle，生產版可接 Chainlink / Pyth |
| 槓桿 | 1× / 2× / 5×，最大 5× |
| 策略版本 | 每次發布產生新版本，跟單鎖定當時版本 |
| 平倉 | Unfollow 一鍵關閉所有跟單倉位 |
| Gas | Anvil 免費；Sepolia 需少量 test ETH |

---

## Sepolia Demo (if deployed)

Replace step 1–6 with Sepolia network in MetaMask.

```bash
bash deploy-sepolia.sh   # deploys + writes addresses.ts SEPOLIA block
bash seed-sepolia.sh     # creates Demo Alpha trader on Sepolia
git push                 # Vercel redeploys automatically
```

All contract addresses are written to `frontend/src/contracts/addresses.ts` by the deploy script.

---

*Research prototype · NCCU Finance Management Department Capstone 2026*
