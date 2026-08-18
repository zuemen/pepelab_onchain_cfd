import type { Catalog } from '../zh-TW';

import { nav } from './nav';
import { x402 } from './x402';
import { pepe } from './pepe';
import { meta } from './meta';
import { whale } from './whale';
import { admin } from './admin';
import { errors } from './errors';
import { rewards } from './rewards';
import { exchange } from './exchange';
import { terminal } from './terminal';
import { portfolio } from './portfolio';
import { freshness } from './freshness';
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
};

export default en;
