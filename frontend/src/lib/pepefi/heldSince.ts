// 「你已持有 N 天」的起點（#134 殘項）：這一段**連續持有**是從哪一塊開始的。
//
// 資料來源是代幣本身的 Transfer 事件（mint 是 from=0x0 的 Transfer，贖回是 to=0x0），
// 所以錢包之間轉進來的持有也算得到——只看金庫的 Minted/Redeemed 會漏掉。
//
// 作法：從某一塊的餘額往回倒推。每遇到一筆轉入就把餘額減回去、轉出就加回去；倒推到
// 餘額歸零的那一筆轉入，就是這一段持有的開始。中途賣光再買回來，起點是買回來那一筆，
// 不是最早那一次——持有天數講的是「現在手上這些」拿了多久。
//
// 三種結果都要分開，因為畫面只在第一種時顯示：
//   found        ：找到了，精確到塊。
//   before       ：掃過的範圍裡沒有歸零——持有早於掃描起點。**不**顯示（不猜）。
//   inconsistent ：倒推出負餘額＝事件缺漏或餘額與事件對不上。**不**顯示。

export interface TransferLike {
  blockNumber: number;
  /** 同一塊內的順序（log index）。 */
  index: number;
  from: string;
  to: string;
  value: bigint;
}

export type StreakStart =
  | { kind: 'found'; blockNumber: number }
  | { kind: 'before' }
  | { kind: 'inconsistent' };

/**
 * @param balance   `atBlock` 那一塊結束時的餘額（呼叫端以同一個 blockTag 讀 balanceOf）。
 * @param user      持有人位址（大小寫不拘）。
 * @param transfers 掃描範圍 (from, atBlock] 內所有 from 或 to 是 user 的 Transfer，順序不拘。
 */
export function streakStart(balance: bigint, user: string, transfers: readonly TransferLike[]): StreakStart {
  if (balance <= 0n) return { kind: 'inconsistent' };
  const me = user.toLowerCase();
  const desc = [...transfers].sort((a, b) => b.blockNumber - a.blockNumber || b.index - a.index);

  let bal = balance;
  for (const tr of desc) {
    const incoming = tr.to.toLowerCase() === me;
    const outgoing = tr.from.toLowerCase() === me;
    if (incoming && outgoing) continue; // 自己轉給自己：餘額不變
    if (incoming) bal -= tr.value;
    else if (outgoing) bal += tr.value;
    else continue; // 呼叫端的 filter 不該給這種，保險起見忽略
    if (bal < 0n) return { kind: 'inconsistent' };
    // 這筆轉入之前餘額是 0 → 現在這段持有就是從這一筆開始。
    if (incoming && bal === 0n) return { kind: 'found', blockNumber: tr.blockNumber };
  }
  return { kind: 'before' };
}
