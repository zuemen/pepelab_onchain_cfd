/**
 * 給 `locales.test.ts` 的 ratchet 用的掃描器。只在測試裡被 import，不會進 bundle。
 *
 * 它找的是「註解以外的中文字」。這個定義有意識地不完整：靜態掃描分不出一個英文字串
 * 是顯示文字還是 class name / 事件名 / 合約錯誤代號，所以英文的漏搬只能靠 review。
 * 但語言規則一旦落實（顯示文字全部中文），「已遷移目錄裡不該有註解外的中文」就會是
 * 完整的不變式——那時這個掃描器才真正把整個問題關起來。
 */

// 刻意寫成 escape 而不是字面的字元區間：ratchet 之後會擴到全樹，掃描器掃到自己身上時
// 不該把自己的常數當成一條漏搬的顯示字串。
const HAN = /[\u4e00-\u9fff]/g;

export type InlineDisplayString = { line: number; text: string };

/** 一段文字裡的中文字數。 */
export function countHan(text: string): number {
  return text.match(HAN)?.length ?? 0;
}

/**
 * 把註解剝掉之後，還帶著中文的行。
 *
 * 已知限制：`//` 一律當成行註解的開頭，所以字串裡的 `https://` 之後的內容會被誤剝。
 * 這只會造成**少報**，不會造成誤報，對 ratchet 而言是安全的那一邊。
 */
export function findInlineDisplayStrings(source: string): InlineDisplayString[] {
  const hits: InlineDisplayString[] = [];
  let inBlockComment = false;

  source.split('\n').forEach((line, index) => {
    let code = '';
    let rest = line;

    while (rest.length > 0) {
      if (inBlockComment) {
        const end = rest.indexOf('*/');
        if (end === -1) {
          break;
        }
        rest = rest.slice(end + 2);
        inBlockComment = false;
        continue;
      }

      const lineComment = rest.indexOf('//');
      const blockStart = rest.indexOf('/*');

      if (blockStart !== -1 && (lineComment === -1 || blockStart < lineComment)) {
        code += rest.slice(0, blockStart);
        rest = rest.slice(blockStart + 2);
        inBlockComment = true;
        continue;
      }

      if (lineComment !== -1) {
        code += rest.slice(0, lineComment);
        break;
      }

      code += rest;
      break;
    }

    // console 是給開發者的輸出，不是顯示字串。
    if (code.includes('console.')) {
      return;
    }

    if (countHan(code) > 0) {
      hits.push({ line: index + 1, text: line });
    }
  });

  return hits;
}
