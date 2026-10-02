// 嚴格 JSON 讀取：與 JSON.parse 相同的文法，另外**偵測重複的鍵**。
//
// 為什麼需要：JSON.parse（以及 Vite 的 JSON import）遇到重複的鍵時「最後一個為準」，
// 不報錯。審查 diff 的人看到的往往是第一個值——在部署登記或租戶設定裡，這就是一個
// 「審查時看到 A、上線時用 B」的位址。這支模組讓 CI 在這種檔案上直接紅燈。
//
// 零依賴。只回報問題，不嘗試修復；文法錯誤時丟出與 JSON.parse 相近的錯誤。

/**
 * @param {string} text
 * @returns {{ value: unknown, duplicates: string[] }}  duplicates 是「路徑: 鍵」清單
 */
export function parseJsonStrict(text) {
  let i = 0;
  const duplicates = [];
  const src = text.replace(/^﻿/, "");

  const fail = (msg) => {
    throw new SyntaxError(`${msg} at position ${i}`);
  };
  const ws = () => {
    while (i < src.length && (src[i] === " " || src[i] === "\t" || src[i] === "\n" || src[i] === "\r")) i += 1;
  };
  const expect = (ch) => {
    if (src[i] !== ch) fail(`Expected '${ch}'`);
    i += 1;
  };

  const string = () => {
    expect('"');
    let out = "";
    for (;;) {
      if (i >= src.length) fail("Unterminated string");
      const ch = src[i];
      if (ch === '"') {
        i += 1;
        return out;
      }
      if (ch === "\\") {
        const esc = src[i + 1];
        const map = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (esc in map) {
          out += map[esc];
          i += 2;
        } else if (esc === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 2, i + 6))) {
          out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
          i += 6;
        } else {
          fail("Bad escape");
        }
        continue;
      }
      if (ch < " ") fail("Control character in string");
      out += ch;
      i += 1;
    }
  };

  const number = () => {
    const m = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(src.slice(i));
    if (!m) fail("Bad number");
    i += m[0].length;
    return Number(m[0]);
  };

  const value = (path) => {
    ws();
    const ch = src[i];
    if (ch === "{") return object(path);
    if (ch === "[") return array(path);
    if (ch === '"') return string();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return number();
    for (const [word, v] of [["true", true], ["false", false], ["null", null]]) {
      if (src.startsWith(word, i)) {
        i += word.length;
        return v;
      }
    }
    return fail("Unexpected token");
  };

  const object = (path) => {
    expect("{");
    // 一律 defineProperty（與 JSON.parse 相同）：鍵名是 `__proto__` 也只是一般欄位，不會改到原型。
    const out = {};
    const seen = new Set();
    ws();
    if (src[i] === "}") {
      i += 1;
      return out;
    }
    for (;;) {
      ws();
      const key = string();
      if (seen.has(key)) duplicates.push(`${path || "(root)"}: ${key}`);
      seen.add(key);
      ws();
      expect(":");
      Object.defineProperty(out, key, {
        value: value(path ? `${path}.${key}` : key),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      ws();
      if (src[i] === ",") {
        i += 1;
        continue;
      }
      expect("}");
      return out;
    }
  };

  const array = (path) => {
    expect("[");
    const out = [];
    ws();
    if (src[i] === "]") {
      i += 1;
      return out;
    }
    for (;;) {
      out.push(value(`${path}[${out.length}]`));
      ws();
      if (src[i] === ",") {
        i += 1;
        continue;
      }
      expect("]");
      return out;
    }
  };

  const result = value("");
  ws();
  if (i !== src.length) fail("Unexpected data after JSON");
  return { value: result, duplicates };
}
