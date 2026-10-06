import type { Catalog } from '../zh-TW';

import { esg } from './esg';
import { kyc } from './kyc';
import { nav } from './nav';
import { copy } from './copy';
import { x402 } from './x402';
import { pepe } from './pepe';
import { meta } from './meta';
import { adopt } from './adopt';
import { stake } from './stake';
import { vault } from './vault';
import { whale } from './whale';
import { admin } from './admin';
import { common } from './common';
import { legacy } from './legacy';
import { tokens } from './tokens';
import { errors } from './errors';
import { status } from './status';
import { history } from './history';
import { pepelab } from './pepelab';
import { landing } from './landing';
import { rewards } from './rewards';
import { sessions } from './sessions';
import { exchange } from './exchange';
import { terminal } from './terminal';
import { portfolio } from './portfolio';
import { freshness } from './freshness';
import { investorVc } from './investorVc';
import { marketplace } from './marketplace';
import { traderProfile } from './traderProfile';
import { pepeStageSkins } from './pepeStageSkins';
import { traderDashboard } from './traderDashboard';

// ----------------------------------------------------------------------

/**
 * 英文的顯示字串 catalog。
 *
 * 型別標註（而不是 `satisfies`）是刻意的：標註會讓「少一個 key」和「多一個 key」兩種
 * 錯誤都在 `tsc` 就爆掉，而 build 已經是 `tsc && vite build`，所以一次 build 就同時
 * 驗證兩種語言，不管當下在建哪一個。
 *
 * 翻譯這裡任何一個檔案前，先查 `frontend/CONTEXT.md` 的「Trading vocabulary, Chinese
 * to English」表——保證金、開倉／平倉、強制平倉、資金費率、質押／罰沒等常見詞已經
 * 各自釘死一個英文譯法，不要在這裡重新發明第二種說法。
 */
const en: Catalog = {
  meta,
  nav,
  admin,
  errors,
  freshness,
  status,
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
  landing,
  common,
  kyc,
  stake,
  pepelab,
  copy,
  marketplace,
  adopt,
  history,
  traderProfile,
  traderDashboard,
  legacy,
  investorVc,
};

export default en;
