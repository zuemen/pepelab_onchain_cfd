# PepeLab — Telegram 交易 agent

在 Telegram 用自然語言下單，bot 憑授權 VC 在 session 限額內上鏈開倉（Base Sepolia）。

1. **填 `agent/.env`**（複製 `agent/.env.example`）：`TELEGRAM_BOT_TOKEN`（BotFather）、`AGENT_PRIVATE_KEY`（你的 agent session key）、`TELEGRAM_ALLOWED_CHAT`（你的 chat id）、`TELEGRAM_ALLOWED_USERS`（你的 user id，= message.from.id；必填）、`DEMO_SESSION_ID`、`SESSION_MANAGER_ADDRESS`、`BASE_SEPOLIA_RPC_URL`。
2. **存授權 VC**：在前端 `/sessions` 對該 session「Issue VC」→ 把 JSON 存成 `agent/tg-bot/vc.json`（`AGENT_AUTH_VC_PATH` 預設指向它；已 gitignore）。
3. **初始化 VC 撤銷狀態目錄（只做一次）**：`cd agent && npm run vc-status:init`。沒做這一步，bot 啟動時會印
   `::error::[vc-status] …`，**所有下單都會被拒**，chat 會請管理者執行這個指令。只在持久儲存上跑一次，不要放進容器啟動腳本
   （每次啟動都 init 會讓撤銷形同關閉）。見 `docs/ADR-016-vc-credential-status.md` §4.6。
4. **啟動**：`cd agent && npx tsx tg-bot/index.ts`，然後在 Telegram 對 bot 打「**做多 sBTC 3x 保證金 50**」。

> session id 是每個 manager 各自獨立的。現行 AgentSessionManager `0x4875966ACA052A38d80ddD2aaE80995A98EAd2AF`（綁現行 exchange `0xbF3074C98e17d88B4127899C98C81AE94c9fC979`；來源 `contracts/broadcast/Redeploy130Hardened.s.sol/84532/run-latest.json`）還沒有任何 session（2026-10-21 鏈上讀 `nextSessionId` = 0，先用 `create-session.sh` 建一個）。#344 cutover 前的 `0xdF9C…d14B`（綁 #129 的 exchange `0x827e…124D`）、更早的 `0x4E7cC1B7…` 與 `0x5Ebcc64C…`上的 session id 在這裡無效。新建 session 用根目錄 `create-session.sh`。

指令：`/help` 說明、`/pos` 查 session 限額。每筆下單 bot 會先回 6 位數確認碼，**60 秒內**回 `/confirm <碼>` 才會上鏈；每人每 10 分鐘最多 5 筆（`TG_RATE_MAX` / `TG_RATE_WINDOW_MS`）。下單超過 session 的單筆/總額/槓桿上限會被合約 revert，bot 會回傳原因。私鑰與 VC 只放本機，**勿入庫、勿外流**。

使用者若在前端對簽發者做了「全部撤銷」，撤銷後約 5–10 分鐘內重簽的 VC 也會被涵蓋，bot 會在拒單訊息裡提醒；請等這段時間過後再重簽。
