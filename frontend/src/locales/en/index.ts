import type { Catalog } from '../zh-TW';

import { nav } from './nav';
import { meta } from './meta';
import { portfolio } from './portfolio';
import { errors } from './errors';
import { freshness } from './freshness';

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
  errors,
  freshness,
  portfolio,
};

export default en;
