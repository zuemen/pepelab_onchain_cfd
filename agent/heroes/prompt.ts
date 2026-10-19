// 終端機提問：公開鏈回放的確認字句與金鑰檔密碼。
// 整個行程共用一個讀取器：stdin 是管線時（fork 演練把答案 pipe 進來），先到的幾行要排隊，
// 不能因為還沒有人問就丟掉。終端機上密碼不回顯。
import { createInterface, type Interface } from "node:readline";

let rl: Interface | null = null;
const queued: string[] = [];
const waiting: ((line: string | null) => void)[] = [];
let ended = false;
let muted = false;

function reader(): Interface {
  if (rl) return rl;
  const tty = Boolean(process.stdin.isTTY);
  rl = createInterface({ input: process.stdin, output: process.stdout, terminal: tty });
  // 不回顯：readline 每打一個字都會重寫這一行，muted 時整個吞掉。
  const out = rl as unknown as { _writeToOutput: (s: string) => void };
  const write = out._writeToOutput.bind(rl);
  out._writeToOutput = (s: string) => {
    if (!muted) write(s);
  };
  rl.on("line", (line) => {
    const next = waiting.shift();
    if (next) next(line);
    else queued.push(line);
  });
  rl.on("close", () => {
    ended = true;
    for (const w of waiting.splice(0)) w(null);
  });
  return rl;
}

/** 印出問題、讀一行。stdin 已結束（沒有答案）時回 null。 */
export async function ask(question: string, { hidden = false } = {}): Promise<string | null> {
  reader();
  process.stdout.write(question);
  if (queued.length) {
    if (hidden) process.stdout.write("\n");
    return queued.shift()!;
  }
  if (ended) return null;
  muted = hidden && Boolean(process.stdin.isTTY);
  try {
    return await new Promise<string | null>((resolve) => waiting.push(resolve));
  } finally {
    if (muted) process.stdout.write("\n");
    muted = false;
  }
}

/** 不再提問時關掉，否則 stdin 讓行程掛著。 */
export function closePrompts(): void {
  rl?.close();
  rl = null;
}
