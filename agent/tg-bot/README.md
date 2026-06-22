# PepeLab — Telegram 交易 agent

在 Telegram 用自然語言下單，bot 憑授權 VC 在 session 限額內上鏈開倉（Base Sepolia）。

1. **填 `agent/.env`**（複製 `agent/.env.example`）：`TELEGRAM_BOT_TOKEN`（BotFather）、`AGENT_PRIVATE_KEY`（你的 agent session key）、`TELEGRAM_ALLOWED_CHAT`（你的 chat id）、`DEMO_SESSION_ID`、`SESSION_MANAGER_ADDRESS`、`BASE_SEPOLIA_RPC_URL`。
2. **存授權 VC**：在前端 `/sessions` 對該 session「Issue VC」→ 把 JSON 存成 `agent/tg-bot/vc.json`（`AGENT_AUTH_VC_PATH` 預設指向它；已 gitignore）。
3. **啟動**：`cd agent && npx tsx tg-bot/index.ts`，然後在 Telegram 對 bot 打「**做多 sBTC 3x 保證金 50**」。

> session #0 已過期，改用 **#6**（到期 2027）；在 `.env` 設 `DEMO_SESSION_ID=6`（已是預設）即可。

指令：`/help` 說明、`/pos` 查 session 限額。下單超過 session 的單筆/總額/槓桿上限會被合約 revert，bot 會回傳原因。私鑰與 VC 只放本機，**勿入庫、勿外流**。
