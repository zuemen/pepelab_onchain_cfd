// 從 runtime bytecode 探測函式 selector 的純函式。
//
// 獨立成一個檔，是因為 /legacy（legacyExchange）與 /exchange（ammPoolView）都要用它，而
// legacyExchange 會連帶載入 locales、ethers、tenant——為了一個純函式不值得。這個檔案
// 不 import 任何東西。

/**
 * 從 runtime bytecode 撈出所有 PUSH4 的運算元（Solidity dispatcher 用 PUSH4 比對 selector）。
 * 跳過其他 PUSHn 的資料區，否則資料裡剛好出現 0x63 會被誤當成 PUSH4。
 *
 * 這是「可能存在」的上界：PUSH4 也可能是一般常數。頁面只把它當成「不在就不呼叫」的閘門，
 * 真正能不能成功仍以 eth_call 預檢為準。
 *
 * 已知限制：selector 以 0x00 開頭時，solc 可能用 PUSH3（甚至更短的 PUSHn）推入去掉前導零的
 * 值，這裡只認 PUSH4，會漏掉那種 selector，結果是把合約誤判成 unsupported（偏保守的那一邊，
 * 不會誤送交易）。頁面需要的 selector 沒有一個以 0x00 開頭，有測試釘住這一點；之後若新增
 * 需要探測的函式，要先確認它的 selector。
 */
export function scanPush4Selectors(bytecode: string): Set<string> {
  const hex = bytecode.startsWith('0x') ? bytecode.slice(2) : bytecode;
  const out = new Set<string>();
  const n = Math.floor(hex.length / 2);
  for (let i = 0; i < n; i += 1) {
    const op = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (op === 0x63 && i + 4 < n) {
      out.add(`0x${hex.slice((i + 1) * 2, (i + 5) * 2).toLowerCase()}`);
    }
    if (op >= 0x60 && op <= 0x7f) i += op - 0x5f;
  }
  return out;
}
