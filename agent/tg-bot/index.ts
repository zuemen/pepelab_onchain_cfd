import fs from "node:fs";
import TelegramBot from "node-telegram-bot-api";
import { openPositionForSession, getSession } from "@pepelab/shared";

const TOKEN = req("TELEGRAM_BOT_TOKEN");
const ALLOWED = (process.env.TELEGRAM_ALLOWED_CHAT ?? "").trim();
const SESSION_ID = Number(process.env.DEMO_SESSION_ID ?? "6"); // #0 已過期，改用 #6（到 2027）
const VC = loadVc(process.env.AGENT_AUTH_VC_PATH);

function req(k: string): string { const v = process.env[k]?.trim(); if (!v) throw new Error(`缺少環境變數 ${k}`); return v; }
function loadVc(p?: string) { if (!p) return undefined; try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { console.error(`讀取 VC 失敗(${p})：${(e as Error).message}`); return undefined; } }

const ASSETS: Record<string, string> = {
  btc:"sBTC",sbtc:"sBTC",eth:"sETH",seth:"sETH",aapl:"sAAPL",saapl:"sAAPL",tsla:"sTSLA",stsla:"sTSLA",
  nvda:"sNVDA",snvda:"sNVDA",msft:"sMSFT",smsft:"sMSFT",googl:"sGOOGL",goog:"sGOOGL",sgoogl:"sGOOGL",
  gold:"sGOLD",sgold:"sGOLD",bond:"sBOND",sbond:"sBOND",icln:"sICLN",sicln:"sICLN",esgu:"sESGU",sesgu:"sESGU",
};

function parseIntent(text: string) {
  const t = text.toLowerCase();
  let isLong: boolean | undefined;
  if (/(做多|看多|\blong\b|buy|買多|多單)/.test(t)) isLong = true;
  else if (/(做空|看空|\bshort\b|sell|放空|空單)/.test(t)) isLong = false;
  else if (/(^|\s)多(\s|$)/.test(t)) isLong = true;
  else if (/(^|\s)空(\s|$)/.test(t)) isLong = false;
  let symbol: string | undefined;
  for (const w of t.split(/[^a-z]+/)) if (ASSETS[w]) { symbol = ASSETS[w]; break; }
  const lev = t.match(/(\d+(?:\.\d+)?)\s*(?:x|倍)/) ?? t.match(/槓桿\s*(\d+(?:\.\d+)?)/);
  const leverage = lev ? Number(lev[1]) : undefined;
  const mg = t.match(/(?:保證金|margin)\s*(\d+(?:\.\d+)?)/) ?? t.match(/(\d+(?:\.\d+)?)\s*(?:usdt|usdc|u\b)/);
  const marginUsdc = mg ? Number(mg[1]) : undefined;
  return { isLong, symbol, leverage, marginUsdc };
}

const bot = new TelegramBot(TOKEN, { polling: true });
const HELP = "PepeLab 交易 agent。自然語言下單，例如：\n• 做多 sBTC 3x 保證金 50\n• 做空 sETH 槓桿2 保證金 40\n指令：/pos 查 session ・ /help 說明\n限額：單筆/總額/槓桿受 session 約束，超過會被合約 revert。";

bot.on("message", async (msg) => {
  const chatId = String(msg.chat.id);
  if (ALLOWED && chatId !== ALLOWED) return;
  const text = (msg.text ?? "").trim(); if (!text) return;
  if (text === "/start" || text === "/help") return void bot.sendMessage(chatId, HELP);
  if (text === "/pos" || text === "/status" || text === "/session") {
    const r: any = await getSession(SESSION_ID);
    return void bot.sendMessage(chatId, "```\n" + JSON.stringify(r, null, 2) + "\n```", { parse_mode: "Markdown" });
  }
  const { isLong, symbol, leverage, marginUsdc } = parseIntent(text);
  const miss: string[] = [];
  if (isLong === undefined) miss.push("方向(做多/做空)");
  if (!symbol) miss.push("資產(如 sBTC)");
  if (!leverage) miss.push("槓桿(如 3x)");
  if (!marginUsdc) miss.push("保證金(如 保證金 50)");
  if (miss.length) return void bot.sendMessage(chatId, `沒讀懂：缺 ${miss.join("、")}。範例：做多 sBTC 3x 保證金 50`);
  await bot.sendMessage(chatId, `收到 → ${isLong ? "做多" : "做空"} ${symbol}　${leverage}x　保證金 ${marginUsdc} USDT\n上鏈中…⏳`);
  try {
    const res: any = await openPositionForSession({ sessionId: SESSION_ID, symbol: symbol!, isLong: isLong!, marginUsdc: marginUsdc!, leverage: leverage!, authVc: VC });
    if (!res?.ok) return void bot.sendMessage(chatId, `❌ 被拒絕：${res?.error ?? "未知錯誤"}`);
    const hash = res.txHash ?? res.hash ?? res.tx;
    bot.sendMessage(chatId, `✅ 已開倉\nposition #${res.positionId ?? "?"}\n${hash ? `https://sepolia.basescan.org/tx/${hash}` : "(無 tx hash)"}`);
  } catch (e) { bot.sendMessage(chatId, `❌ 失敗：${(e as Error).message}`); }
});

console.log(`PepeLab TG agent 上線。session #${SESSION_ID}，VC ${VC ? "已載入" : "未載入"}。`);
