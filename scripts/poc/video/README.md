# PoC 錄影工具（Playwright）

用 Playwright 開 chromium、注入一個 EIP-1193 錢包，依劇本一步步操作前端並錄成影片。
每一步畫面上方會有繁中字幕列；交易送出後字幕列第二行顯示 tx hash 與 BaseScan 連結。

## 檔案

| 檔案 | 用途 |
|---|---|
| `wallet.mjs` | 注入 `window.ethereum`，簽名／送交易交給 Node 端 ethers Wallet |
| `overlay.mjs` | 字幕列（DOM overlay，換頁後自動重畫） |
| `helpers.mjs` | 劇本小工具：`clickAndWaitTx`、`typeInto`、`waitForText`、`smoothScroll` |
| `record.mjs` | 主程式：讀劇本、錄影、寫 JSON 紀錄、ffmpeg 轉 mp4 |
| `scenes/rwa-poc.mjs` | 正式劇本骨架（首頁 → 連錢包 → /rwa → /oracle → /solvency；交易步驟見檔內 TODO） |
| `scenes/smoke.mjs` | 自檢劇本：地址顯示、personal_sign 還原、交易攔截、角色切換、字幕列 |

## 安裝（一次）

```bash
cd scripts/poc/video
npm install                     # 獨立的 package.json，不碰 frontend（yarn）
npx playwright install chromium
```

ffmpeg 是選配：有的話（`which ffmpeg`）自動把 webm 轉成 mp4，沒有就只留 webm（`brew install ffmpeg`）。

## 執行

```bash
# 終端機 1：前端
cd frontend && yarn dev          # http://localhost:5173

# 終端機 2：錄影
cd scripts/poc/video
node record.mjs                              # 預設 scenes/rwa-poc.mjs、角色 investor、唯讀
node record.mjs --scenes scenes/smoke.mjs    # 自檢
```

參數：

| 參數 | 預設 | 說明 |
|---|---|---|
| `--scenes` | `scenes/rwa-poc.mjs` | 劇本檔 |
| `--base` | `http://localhost:5173`（或 `POC_BASE_URL`） | 前端網址 |
| `--role` | 劇本的 `role` 或 `investor` | 起始角色（investor / issuer / agent / admin …） |
| `--size` | `1920x1080` | 視窗與影片解析度（例如 `1600x900`） |
| `--slowmo` | `400` | Playwright 每個動作之間的延遲（ms） |
| `--allow-tx` | 關（或 `POC_ALLOW_TX=1`） | **開啟才會真的廣播交易**；沒開時 `eth_sendTransaction` 一律以 4001 拒絕 |
| `--headed` | 關 | 顯示瀏覽器視窗 |
| `--rpc` | `https://sepolia.base.org`（或 `POC_RPC_URL`） | 唯讀 RPC |

除錯：`POC_DEBUG=1` 會印出 RPC 失敗的 method 與訊息。

## 產出

全部在 `scripts/poc/video/out/`（已在 `.gitignore`）：

- `<劇本>-<時間>.webm`、`.mp4`：影片
- `<劇本>-<時間>.json`：每步 `{step, caption, role, txHash, url, timestamp}`，有交易的步驟另有 `txHashes`、`explorer`
- `<劇本>-<時間>-fail-step<N>.png`：某步失敗時的截圖（影片仍會存檔）

## 寫劇本

```js
import { clickAndWaitTx } from '../helpers.mjs';

export default {
  name: 'my-scene',
  role: 'issuer',
  steps: [
    { caption: '開啟 RWA 頁', run: (ctx) => ctx.goto('/rwa') },
    {
      caption: '發行人鑄造代幣',
      run: async (ctx) => {
        await clickAndWaitTx(ctx, 'role=button[name="鑄造"]'); // 等 tx 送出 → 字幕顯示 hash → 等上鏈
      },
      hold: 4000,
    },
    { caption: '切到投資人', run: (ctx) => ctx.switchRole('investor') }, // 對頁面發 accountsChanged
  ],
};
```

每步可設 `lead`（字幕出現後先停多久，預設 1200ms）、`hold`（做完停多久，預設 2000ms）、`note`（字幕第二行）。

## 錢包注入怎麼運作

- `page.addInitScript` 在每個頁面載入前放一個 `window.ethereum`（`isMetaMask: true`，也發 EIP-6963 announce）。
- 頁面的每個 `request()` 都經 `page.exposeFunction` 交給 Node：
  - `eth_requestAccounts` / `eth_accounts` → 目前角色地址
  - `eth_chainId` → `0x14a34`；`wallet_switchEthereumChain` 只接受 84532
  - 唯讀方法（`eth_call`、`eth_getBalance`、`eth_blockNumber`、`eth_getLogs`…白名單）→ 原樣轉發到 RPC，
    revert data 原封交回頁面；限制同時 4 個請求並對 429 退避重試（公開節點對並發很敏感）
  - `personal_sign`、`eth_signTypedData_v4`、`eth_sendTransaction` → Node 端 ethers Wallet 簽
  - 其他（含 `eth_sendRawTransaction`）一律拒絕
- `ctx.switchRole(name)` 換成另一把 keystore，並在頁面觸發 `accountsChanged`。

## 私鑰安全

- keystore：`~/.foundry/keystores/pepelab-rwa-<name>`，密碼檔：`~/.foundry/pepelab-rwa-<name>.password`。
  用 `Wallet.fromEncryptedJson(keystore, password.trim())` 在 Node 行程裡解開。
- **私鑰只存在 Node 行程記憶體**裡的 ethers Wallet 物件：不 console.log、不寫檔、不傳進頁面。
  頁面（以及錄影畫面）只看得到地址、簽名結果與 tx hash。
- 解鎖失敗時錯誤訊息只帶角色名稱，不轉印原始例外，避免 keystore 片段出現在 log。
- 傳回頁面的錯誤只有 `{code, message, data}`，不含 stack。
- 預設唯讀：不加 `--allow-tx` 時任何交易都會被攔下，適合排練與自檢。
- 錄影產出（影片、JSON）只含公開資訊，但仍放在 `.gitignore` 的 `out/` 底下，要分享請自行挑選。
