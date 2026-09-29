// 副作用模組：一 import 就把 agent/.env 載入 process.env。
//
// 用法：在進入點的**第一個** import 寫 `import "@pepelab/shared/autoload-env";`。
// ESM 依 import 順序求值，這樣 .env 會在 `@pepelab/shared` 其他模組求值之前載入——
// 例如 addresses.ts 在 import 當下就讀 AGENT_CHAIN_ID。以前各進入點是 import 完
// shared 才呼叫 loadEnv()，那些 import 時期就讀的 env 永遠拿不到 .env 的值。
//
// 刻意只依賴 ./env.ts（它只 import dotenv 與 node 內建模組），不經過 index.ts。
import { loadEnv } from "./env.ts";

loadEnv();
