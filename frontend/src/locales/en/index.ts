import type { Catalog } from '../zh-TW';

import { esg } from './esg';
import { kyc } from './kyc';
import { nav } from './nav';
import { copy } from './copy';
import { x402 } from './x402';
import { pepe } from './pepe';
import { meta } from './meta';
import { stake } from './stake';
import { vault } from './vault';
import { whale } from './whale';
import { admin } from './admin';
import { common } from './common';
import { tokens } from './tokens';
import { errors } from './errors';
import { pepelab } from './pepelab';
import { landing } from './landing';
import { rewards } from './rewards';
import { sessions } from './sessions';
import { exchange } from './exchange';
import { terminal } from './terminal';
import { portfolio } from './portfolio';
import { freshness } from './freshness';
import { marketplace } from './marketplace';
import { pepeStageSkins } from './pepeStageSkins';

// ----------------------------------------------------------------------

/**
 * 英文的顯示字串 catalog。
 *
 * 型別標註（而不是 `satisfies`）是刻意的：標註會讓「少一個 key」和「多一個 key」兩種
 * 錯誤都在 `tsc` 就爆掉，而 build 已經是 `tsc && vite build`，所以一次 build 就同時
 * 驗證兩種語言，不管當下在建哪一個。
 */
const en: Catalog = {
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
  landing,
  common,
  kyc,
  stake,
  pepelab,
  copy,
  marketplace,
};

export default en;
