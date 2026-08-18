import { esg } from './esg';
import { nav } from './nav';
import { x402 } from './x402';
import { pepe } from './pepe';
import { meta } from './meta';
import { vault } from './vault';
import { whale } from './whale';
import { admin } from './admin';
import { tokens } from './tokens';
import { errors } from './errors';
import { rewards } from './rewards';
import { sessions } from './sessions';
import { exchange } from './exchange';
import { terminal } from './terminal';
import { portfolio } from './portfolio';
import { freshness } from './freshness';
import { pepeStageSkins } from './pepeStageSkins';

// ----------------------------------------------------------------------

/**
 * 繁體中文的顯示字串 catalog。這一份是**形狀的來源**：`en` 用它推導出來的型別做標註，
 * 所以少一個 key 或多一個 key 都會編譯失敗。
 *
 * ⚠️ 不要加 `as const`。加了之後每個值的型別會變成這裡的中文字面值，`en` 填英文就會
 * 被判定型別不符，而錯誤訊息完全指不到真正的原因。
 */
const zhTW = {
  meta,
  nav,
  admin,
  errors,
  freshness,
  portfolio,
  exchange,
  terminal,
  pepe,
  pepeStageSkins,
  x402,
  whale,
  rewards,
  esg,
  vault,
  sessions,
  tokens,
};

export type Catalog = typeof zhTW;

export default zhTW;
