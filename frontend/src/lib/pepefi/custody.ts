// 「你的資產在哪裡」：這一段在哪個模式、哪個旗標下顯示哪些句子。
//
// 內容只陳述能從合約驗證的事實，並同時列出營運方保有的權限（ADR-023）。兩種模式各一份
// 文字：Simple 那份不能出現交易桌的字（adoptVocabulary.test.ts 守門），Expert 那份用
// 保證金、跟單、清算這些原本的字。跟單旗標關閉的租戶，Expert 不提跟單——首頁不介紹
// 一個看不到的功能（copyWording.test.ts 守門）。

import type { Mode } from 'src/contexts/mode-context';
import type { Catalog } from 'src/locales/zh-TW';

export interface CustodyContent {
  heading: string;
  intro: string;
  facts: string[];
  operatorHeading: string;
  operator: string[];
  whyHeading: string;
  why: string;
  /** 與 eToro 這類平台的差別。null = 這個組合下不顯示。 */
  difference: { heading: string; items: string[] } | null;
}

/** Expert 那一句講跟單部位歸屬的 key；跟單旗標關閉時拿掉。型別綁著 catalog，改名會編譯失敗。 */
const COPY_FACT: keyof Catalog['custody']['expert']['facts'] = 'copy';

export function custodyContent(mode: Mode, copyTrading: boolean, catalog: Catalog['custody']): CustodyContent {
  if (mode === 'simple') {
    const s = catalog.simple;
    return {
      heading: catalog.heading,
      intro: s.intro,
      facts: Object.values(s.facts),
      operatorHeading: s.operatorHeading,
      operator: Object.values(s.operator),
      whyHeading: s.whyHeading,
      why: s.why,
      difference: { heading: s.differenceHeading, items: Object.values(s.difference) },
    };
  }

  const e = catalog.expert;
  return {
    heading: catalog.heading,
    intro: e.intro,
    facts: Object.entries(e.facts)
      .filter(([key]) => copyTrading || key !== COPY_FACT)
      .map(([, text]) => text),
    operatorHeading: e.operatorHeading,
    operator: Object.values(e.operator),
    whyHeading: e.whyHeading,
    why: e.why,
    difference: copyTrading ? { heading: e.differenceHeading, items: Object.values(e.difference) } : null,
  };
}
