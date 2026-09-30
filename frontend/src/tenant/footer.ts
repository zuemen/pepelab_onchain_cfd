// 白標租戶頁尾的連結清單（客服與法律連結）。純資料轉換，元件在
// src/components/pepefi/TenantFooter.tsx。
//
// default 租戶沒有任何客服或法律連結 → 清單為空 → 頁尾不渲染，畫面與改版前相同。

import type { TenantConfig, TenantLocale } from './schema';

// ----------------------------------------------------------------------

export interface FooterLink {
  kind: 'support' | 'legal';
  label: string;
  href: string;
}

export function tenantFooterLinks(
  config: Pick<TenantConfig, 'support' | 'legal'>,
  lang: TenantLocale,
  supportLabel: string
): FooterLink[] {
  const links: FooterLink[] = [];
  // href 都已經過 schema 驗證：support.url / legal.href 只收 https，email 不含角括號與空白。
  if (config.support.url)
    links.push({ kind: 'support', label: supportLabel, href: config.support.url });
  if (config.support.email) {
    links.push({
      kind: 'support',
      label: config.support.email,
      href: `mailto:${config.support.email}`,
    });
  }
  for (const l of config.legal.links)
    links.push({ kind: 'legal', label: l.label[lang], href: l.href });
  return links;
}
